import { readFileSync } from "node:fs";
import os from "node:os";

import {
  availableModelChoices,
  checkApiKey,
  defaultApiModel,
  impliedOrchestratorFromModel,
  normalizeOllamaModel,
} from "../config/models.js";
import { getTeamByName, listAvailableTeams } from "../config/team-config.js";
import { loadProjectConfig, saveProjectConfig } from "../config/project-config.js";
import { getUserDefault } from "../config/user-config.js";
import { CliError } from "../core/errors.js";
import { availableBackends } from "../runtime/backends.js";
import { getPromptAdapter } from "./prompts.js";
import { printLines, writeStdout } from "./ui.js";
import type { MainFlags } from "./types.js";

export const DEFAULT_MAX_EXCHANGES = 30;
export const DEFAULT_MAX_CYCLES = 5;

export type ResolvedRuntimeParams = {
  autoCommit: boolean;
  maxCycles: number;
  maxExchanges: number;
  orchestrator: string;
  orchestratorModel: string;
  team: string;
  effort?: "low" | "standard" | "high" | "max";
};

export type ResolvedGoal = {
  goalText: string | null;
  source: "goal" | "goal-file" | "improve" | "test" | "fix-from" | "interactive";
};

type SavedRuntimeParams = Partial<ResolvedRuntimeParams> & Record<string, unknown>;

const CLI_ORCHESTRATORS = new Set([
  "pi",
  "claude-code",
  "gemini-cli",
  "opencode",
  "codex",
  "cursor",
  "kimi-code",
]);

function parseOrchestratorFlag(value: string | null): {
  backend: string | null;
  model: string | null;
} {
  if (value === null) {
    return { backend: null, model: null };
  }

  const separator = value.indexOf(":");
  if (separator !== -1) {
    const prefix = value.slice(0, separator);
    const rest = value.slice(separator + 1);
    if (CLI_ORCHESTRATORS.has(prefix)) {
      return { backend: prefix, model: rest };
    }
  }

  return { backend: null, model: value };
}

function hasAnyApiKey(env = process.env): boolean {
  return availableModelChoices(env).length > 0;
}

function genericApiKeyError(orchestrator: string, model: string | null): string | null {
  if (
    orchestrator === "pi" ||
    orchestrator !== "api" ||
    model === null ||
    isOllamaLike(model) ||
    hasAnyApiKey()
  ) {
    return null;
  }
  return "API orchestrator selected but no provider API key was found in the environment.";
}

function validateOrchestratorCredentials(orchestrator: string, model: string): string | null {
  if (orchestrator === "pi") {
    return null;
  }

  return genericApiKeyError(orchestrator, model) ?? checkApiKey(orchestrator, model);
}

function preferredOrchestrator(): string {
  return "pi";
}

function availablePreferredOrchestrators(): string[] {
  const backends = availableBackends();
  const choices = ["pi"];
  if (backends.opencode) {
    choices.push("opencode");
  }
  if (backends.claude) {
    choices.push("claude-code");
  }
  if (backends.codex) {
    choices.push("codex");
  }
  return choices;
}

function defaultCliModel(orchestrator: string): string {
  switch (orchestrator) {
    case "pi":
      return "gemini-2.5-flash";
    case "claude-code":
      return "opus";
    case "cursor":
      return "composer-1.5";
    case "kimi-code":
      return "kimi-k2.5";
    case "codex":
      return "gpt-5.4";
    case "gemini-cli":
      return "gemini-3-flash";
    case "opencode":
      return "gemini-2.5-flash";
    default:
      return defaultApiModel();
  }
}

function promptInteger(message: string, defaultValue: number): number {
  const prompt = getPromptAdapter();
  const raw = prompt.text(message, String(defaultValue));
  if (raw === null) {
    throw new CliError("Cancelled.");
  }
  const trimmed = raw.trim();
  if (!/^-?\d+$/u.test(trimmed)) {
    throw new CliError(`${message} must be an integer.`);
  }
  const value = Number.parseInt(trimmed, 10);
  if (value <= 0) {
    throw new CliError(`${message} must be a positive integer.`);
  }
  return value;
}

function selectNumeric(message: string, presets: number[], defaultValue: number): number {
  const prompt = getPromptAdapter();
  const presetStrings = presets.map(String);
  const defaultChoice = presetStrings.includes(String(defaultValue))
    ? String(defaultValue)
    : (presetStrings[0] ?? String(defaultValue));
  const choice = prompt.select(message, [...presetStrings, "Custom..."], defaultChoice);
  if (choice === null) {
    throw new CliError("Cancelled.");
  }
  if (choice !== "Custom...") {
    return Number.parseInt(choice, 10);
  }
  return promptInteger("  Enter value", defaultValue);
}

function selectTeam(defaultValue: string, projectDir: string): string {
  const prompt = getPromptAdapter();
  const teams = listAvailableTeams();
  const choices = teams.map(
    (team) =>
      `${team.name} — ${team.config.description ?? (team.source === "user" ? "user team" : "built-in team")}`,
  );
  const defaultChoice =
    choices.find((choice) => choice.startsWith(`${defaultValue} —`)) ?? choices[0];
  const selected = prompt.select("Team", choices, defaultChoice);
  if (selected === null) {
    throw new CliError("Cancelled.");
  }
  const teamName = selected.split(" — ")[0]?.trim();
  if (teamName === undefined || teamName.length === 0) {
    throw new CliError(`Unknown team: ${selected}`);
  }
  if (getTeamByName(teamName, os.homedir(), projectDir) === null) {
    throw new CliError(`Unknown team: ${teamName}`);
  }
  return teamName;
}

function selectOrchestrator(): { orchestrator: string; orchestratorModel: string } {
  const prompt = getPromptAdapter();
  const choices = availablePreferredOrchestrators().map((orchestrator) => {
    switch (orchestrator) {
      case "pi":
        return "pi (base orchestrator via pi)";
      case "opencode":
        return "opencode (ACP runtime, Gemini provider)";
      case "claude-code":
        return "claude-code (Claude subscription)";
      case "codex":
        return "codex (Codex subscription)";
      default:
        return orchestrator;
    }
  });

  if (choices.length === 0) {
    throw new CliError(
      "No backends available. Install a supported CLI backend or set a provider API key before running interactive setup.",
    );
  }

  const defaultOrchestrator =
    choices.find((choice) => choice.startsWith(preferredOrchestrator())) ?? choices[0];
  const selected = prompt.select("Orchestrator:", choices, defaultOrchestrator);
  if (selected === null) {
    throw new CliError("Cancelled.");
  }
  const orchestrator = selected.split(" (")[0] ?? selected;
  const defaultModel = defaultCliModel(orchestrator);

  let modelChoices: string[];
  switch (orchestrator) {
    case "pi": {
      modelChoices = [
        "gemini-2.5-flash",
        "gemini-3-flash",
        "anthropic/claude-sonnet-4",
        "openai/gpt-5",
        "(custom)",
      ];
      break;
    }
    case "claude-code":
      modelChoices = ["opus", "sonnet", "(custom)"];
      break;
    case "gemini-cli":
      modelChoices = ["gemini-3-flash", "gemini-3-pro", "gemini-2.5-flash", "(custom)"];
      break;
    case "opencode":
      modelChoices = ["gemini-2.5-flash", "gemini-3-flash", "gemini-3-pro", "(custom)"];
      break;
    case "codex":
      modelChoices = ["gpt-5.4", "gpt-5.3-codex", "o3", "(custom)"];
      break;
    case "cursor":
      modelChoices = ["composer-1.5", "sonnet-4-thinking", "gpt-5", "(custom)"];
      break;
    default:
      modelChoices = [defaultModel, "(custom)"];
      break;
  }

  const defaultChoice =
    modelChoices.find(
      (choice) => choice.startsWith(`${defaultModel} —`) || choice === defaultModel,
    ) ??
    modelChoices[0] ??
    defaultModel;
  const selectedModel = prompt.select("Orchestrator model:", modelChoices, defaultChoice);
  if (selectedModel === null) {
    throw new CliError("Cancelled.");
  }

  let orchestratorModel: string;
  if (selectedModel === "(custom)") {
    const custom = prompt.text("  Model name (provider:model or alias)", defaultModel);
    if (custom === null) {
      throw new CliError("Cancelled.");
    }
    if (custom.trim().length === 0) {
      throw new CliError("Model name must not be empty.");
    }
    orchestratorModel = custom.trim();
  } else {
    orchestratorModel = selectedModel.includes(" — ")
      ? (selectedModel.split(" — ")[0] ?? selectedModel).trim()
      : selectedModel;
  }

  if (isOllamaLike(orchestratorModel)) {
    orchestratorModel = normalizeOllamaModel(orchestratorModel);
  }
  const keyError = validateOrchestratorCredentials(orchestrator, orchestratorModel);
  if (keyError !== null) {
    throw new CliError(`${keyError}\nSet the key in your environment or .env file and try again.`);
  }
  return { orchestrator, orchestratorModel };
}

function isOllamaLike(model: string): boolean {
  return model === "ollama-local" || model.startsWith("ollama:") || model.startsWith("ollama/");
}

function isSavedRuntimeParams(value: SavedRuntimeParams | null): value is ResolvedRuntimeParams {
  return (
    value !== null &&
    typeof value.team === "string" &&
    typeof value.orchestrator === "string" &&
    typeof value.orchestratorModel === "string" &&
    typeof value.maxExchanges === "number" &&
    typeof value.maxCycles === "number"
  );
}

function maybeReuseSavedParams(projectDir: string): ResolvedRuntimeParams | null {
  const prompt = getPromptAdapter();
  const loaded = loadProjectConfig(projectDir) as SavedRuntimeParams | null;
  if (!isSavedRuntimeParams(loaded)) {
    return null;
  }

  const team = getTeamByName(loaded.team, os.homedir(), projectDir);
  if (team === null) {
    return null;
  }

  printLines([
    "",
    "  Previous config found:",
    `    Team:         ${team.name} — ${team.config.description ?? (team.source === "user" ? "user team" : "built-in team")}`,
    `    Orchestrator: ${loaded.orchestrator} (${loaded.orchestratorModel})`,
    `    Exchanges:    ${loaded.maxExchanges}/cycle, ${loaded.maxCycles} cycles`,
  ]);

  const reuse = prompt.confirm("Reuse this config?", true);
  if (reuse === null) {
    throw new CliError("Cancelled.");
  }
  if (!reuse) {
    return null;
  }

  const params: ResolvedRuntimeParams = {
    autoCommit: typeof loaded.autoCommit === "boolean" ? loaded.autoCommit : true,
    maxCycles: loaded.maxCycles,
    maxExchanges: loaded.maxExchanges,
    orchestrator: loaded.orchestrator,
    orchestratorModel: loaded.orchestratorModel,
    team: loaded.team,
  };
  if (
    loaded.effort === "low" ||
    loaded.effort === "standard" ||
    loaded.effort === "high" ||
    loaded.effort === "max"
  ) {
    params.effort = loaded.effort;
  }

  saveProjectConfig(projectDir, params);
  return params;
}

function selectInteractiveRuntimeParams(projectDir: string): ResolvedRuntimeParams {
  const prompt = getPromptAdapter();
  writeStdout("\n--- Configuration ---\n\n");

  const backends = availableBackends();
  const backendSummary = [
    "PI: bundled",
    `OpenCode: ${backends.opencode ? "yes" : "not found"}`,
    `Claude Code: ${backends.claude ? "yes" : "not found"}`,
    `Codex: ${backends.codex ? "yes" : "not found"}`,
  ];
  writeStdout(`  Backends: ${backendSummary.join(" | ")}\n\n`);

  const defaultTeam = "full";
  const team = selectTeam(defaultTeam, projectDir);
  const { orchestrator, orchestratorModel } = selectOrchestrator();
  writeStdout("\n  An exchange = one orchestrator turn: think, delegate to agent, read result.\n");
  const maxExchanges = selectNumeric(
    "Max exchanges per cycle:",
    [20, 30, 50],
    DEFAULT_MAX_EXCHANGES,
  );
  writeStdout("\n  A cycle = one full orchestrator session. If it doesn't finish,\n");
  writeStdout("  a new cycle starts with a summary of prior progress.\n");
  const maxCycles = selectNumeric("Max cycles:", [1, 3, 5, 10], DEFAULT_MAX_CYCLES);
  const autoCommit = getUserDefault("auto_commit", true, os.homedir());
  const effortChoice = prompt.select("Effort", ["standard", "low", "high", "max"], "standard");
  if (effortChoice === null) {
    throw new CliError("Cancelled.");
  }

  const params: ResolvedRuntimeParams = {
    autoCommit,
    maxCycles,
    maxExchanges,
    orchestrator,
    orchestratorModel,
    team,
  };
  if (effortChoice !== "standard") {
    params.effort = effortChoice as ResolvedRuntimeParams["effort"];
  }

  saveProjectConfig(projectDir, params);
  return params;
}

export function resolveRuntimeParams(flags: MainFlags): ResolvedRuntimeParams {
  const { backend: explicitBackend, model: explicitModel } = parseOrchestratorFlag(
    flags.orchestrator,
  );
  const team =
    flags.team ?? (flags.test ? "test" : flags.improve || flags.fixFrom !== null ? "full" : "full");

  let orchestrator: string;
  let orchestratorModel = explicitModel;

  if (flags.debug) {
    orchestrator = explicitBackend ?? "api";
    orchestratorModel ??= "opus";
  } else {
    if (explicitBackend !== null) {
      orchestrator = explicitBackend;
    } else if (explicitModel !== null) {
      orchestrator = impliedOrchestratorFromModel(explicitModel) ?? "api";
    } else {
      orchestrator = preferredOrchestrator();
    }

    orchestratorModel ??= defaultCliModel(orchestrator);

    if (orchestratorModel !== null && isOllamaLike(orchestratorModel)) {
      orchestratorModel = normalizeOllamaModel(orchestratorModel);
    }
    const keyError = validateOrchestratorCredentials(orchestrator, orchestratorModel);
    if (keyError !== null) {
      throw new CliError(keyError);
    }
  }

  const params: ResolvedRuntimeParams = {
    autoCommit: !flags.noAutoCommit && getUserDefault("auto_commit", true, os.homedir()),
    maxCycles: flags.cycles ?? DEFAULT_MAX_CYCLES,
    maxExchanges: flags.exchanges ?? DEFAULT_MAX_EXCHANGES,
    orchestrator,
    orchestratorModel,
    team,
  };

  if (flags.effort !== null) {
    params.effort = flags.effort;
  }

  return params;
}

export function loadOrResolveRuntimeParams(flags: MainFlags): ResolvedRuntimeParams {
  const hasExplicitRuntimeFlags =
    flags.team !== null ||
    flags.orchestrator !== null ||
    flags.exchanges !== null ||
    flags.cycles !== null ||
    flags.effort !== null ||
    flags.noAutoCommit ||
    flags.debug;
  const nonInteractiveGoal =
    flags.goal !== null ||
    flags.goalFile !== null ||
    flags.improve ||
    flags.test ||
    flags.fixFrom !== null;

  if (hasExplicitRuntimeFlags || nonInteractiveGoal) {
    const params = resolveRuntimeParams(flags);
    saveProjectConfig(flags.project, params);
    return params;
  }

  return maybeReuseSavedParams(flags.project) ?? selectInteractiveRuntimeParams(flags.project);
}

export function resolveGoal(flags: MainFlags): ResolvedGoal {
  if (flags.goal !== null) {
    return { goalText: flags.goal, source: "goal" };
  }

  if (flags.goalFile !== null) {
    try {
      return { goalText: readFileSync(flags.goalFile, "utf8"), source: "goal-file" };
    } catch {
      throw new CliError(`Goal file not found or unreadable: ${flags.goalFile}`);
    }
  }

  if (flags.improve) {
    return {
      goalText: flags.focus ? `Improve the project with focus: ${flags.focus}` : null,
      source: "improve",
    };
  }
  if (flags.test) {
    return {
      goalText: flags.focus
        ? `Test the project with focus: ${flags.focus}`
        : "Test the project through realistic workflows.",
      source: "test",
    };
  }
  if (flags.fixFrom !== null) {
    return { goalText: `Fix findings from run ${flags.fixFrom}`, source: "fix-from" };
  }

  return { goalText: null, source: "interactive" };
}
