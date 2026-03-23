import { readFileSync } from "node:fs";
import os from "node:os";
import process from "node:process";

import { listAvailableTeams } from "../config/team-config.js";
import { loadProjectConfig, saveProjectConfig } from "../config/project-config.js";
import { getUserDefault } from "../config/user-config.js";
import { CliError } from "../core/errors.js";
import { availableBackends } from "../runtime/backends.js";
import { getPromptAdapter } from "./prompts.js";
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

const CLI_ORCHESTRATORS = new Set(["claude-code", "gemini-cli", "codex", "cursor", "kimi-code"]);
const API_KEY_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "DEEPSEEK_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
] as const;

function parseOrchestratorFlag(value: string | null): { backend: string | null; model: string | null } {
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
  return API_KEY_ENV_VARS.some((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function defaultApiModel(env = process.env): string {
  if (typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.trim()) {
    return "opus";
  }
  if (typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.trim()) {
    return "gpt-5.4";
  }
  if (
    (typeof env.GEMINI_API_KEY === "string" && env.GEMINI_API_KEY.trim()) ||
    (typeof env.GOOGLE_API_KEY === "string" && env.GOOGLE_API_KEY.trim())
  ) {
    return "gemini-2.5-flash";
  }
  return "gemini-2.5-flash";
}

function preferredOrchestrator(): string {
  const backends = availableBackends();
  if (backends.claude) {
    return "claude-code";
  }
  if (backends.cursor) {
    return "cursor";
  }
  if (backends.kimi) {
    return "kimi-code";
  }
  if (backends.codex) {
    return "codex";
  }
  if (backends["gemini-cli"]) {
    return "gemini-cli";
  }
  return "api";
}

function defaultCliModel(orchestrator: string): string {
  switch (orchestrator) {
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

function selectTeam(defaultValue: string): string {
  const prompt = getPromptAdapter();
  const teams = listAvailableTeams();
  const choices = teams.map((team) => `${team.name} — ${team.config.description ?? (team.source === "user" ? "user team" : "built-in team")}`);
  const defaultChoice = choices.find((choice) => choice.startsWith(`${defaultValue} —`)) ?? choices[0];
  const selected = prompt.select("Team", choices, defaultChoice);
  if (selected === null) {
    throw new CliError("Cancelled.");
  }
  const teamName = selected.split(" — ")[0]?.trim();
  if (teamName === undefined || teamName.length === 0) {
    throw new CliError(`Unknown team: ${selected}`);
  }
  return teamName;
}

function selectOrchestrator(): { orchestrator: string; orchestratorModel: string } {
  const prompt = getPromptAdapter();
  const backends = availableBackends();
  const hasApi = hasAnyApiKey();
  const choices: string[] = [];

  if (hasApi) {
    choices.push("api");
  }
  if (backends.claude) {
    choices.push("claude-code");
  }
  if (backends["gemini-cli"]) {
    choices.push("gemini-cli");
  }
  if (backends.codex) {
    choices.push("codex");
  }
  if (backends.cursor) {
    choices.push("cursor");
  }
  if (backends.kimi) {
    choices.push("kimi-code");
  }

  if (choices.length === 0) {
    throw new CliError(
      "No backends available. Install a supported CLI backend or set a provider API key before running interactive setup.",
    );
  }

  const defaultOrchestrator = choices.includes("api") ? "api" : preferredOrchestrator();
  const selected = prompt.select("Orchestrator", choices, defaultOrchestrator);
  if (selected === null) {
    throw new CliError("Cancelled.");
  }

  const modelChoices: Record<string, string[]> = {
    api: ["gpt-5.4", "opus", "gemini-2.5-flash", "(custom)"],
    "claude-code": ["opus", "sonnet", "(custom)"],
    "gemini-cli": ["gemini-3-flash", "gemini-3-pro", "gemini-2.5-flash", "(custom)"],
    codex: ["gpt-5.4", "gpt-5.3-codex", "o3", "(custom)"],
    cursor: ["composer-1.5", "sonnet-4-thinking", "gpt-5", "(custom)"],
    "kimi-code": ["kimi-k2.5", "(custom)"],
  };

  const defaultModel = defaultCliModel(selected);
  const modelChoice = prompt.select("Orchestrator model", modelChoices[selected] ?? [defaultModel, "(custom)"], defaultModel);
  if (modelChoice === null) {
    throw new CliError("Cancelled.");
  }
  if (modelChoice !== "(custom)") {
    return { orchestrator: selected, orchestratorModel: modelChoice };
  }

  const custom = prompt.text("Model name", defaultModel);
  if (custom === null) {
    throw new CliError("Cancelled.");
  }
  if (custom.trim().length === 0) {
    throw new CliError("Model name must not be empty.");
  }
  return { orchestrator: selected, orchestratorModel: custom.trim() };
}

function isSavedRuntimeParams(value: SavedRuntimeParams | null): value is ResolvedRuntimeParams {
  return value !== null
    && typeof value.team === "string"
    && typeof value.orchestrator === "string"
    && typeof value.orchestratorModel === "string"
    && typeof value.maxExchanges === "number"
    && typeof value.maxCycles === "number";
}

function maybeReuseSavedParams(projectDir: string): ResolvedRuntimeParams | null {
  const prompt = getPromptAdapter();
  const loaded = loadProjectConfig(projectDir) as SavedRuntimeParams | null;
  if (!isSavedRuntimeParams(loaded)) {
    return null;
  }

  const team = listAvailableTeams().find((entry) => entry.name === loaded.team);
  if (team === undefined) {
    return null;
  }

  const lines = [
    "",
    "  Previous config found:",
    `    Team:         ${team.name} — ${team.config.description ?? (team.source === "user" ? "user team" : "built-in team")}`,
    `    Orchestrator: ${loaded.orchestrator} (${loaded.orchestratorModel})`,
    `    Exchanges:    ${loaded.maxExchanges}/cycle, ${loaded.maxCycles} cycles`,
  ];
  for (const line of lines) {
    process.stdout.write(`${line}\n`);
  }

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
  if (loaded.effort === "low" || loaded.effort === "standard" || loaded.effort === "high" || loaded.effort === "max") {
    params.effort = loaded.effort;
  }

  saveProjectConfig(projectDir, params);
  return params;
}

function selectInteractiveRuntimeParams(projectDir: string): ResolvedRuntimeParams {
  const prompt = getPromptAdapter();
  const defaultTeam = "full";
  const team = selectTeam(defaultTeam);
  const { orchestrator, orchestratorModel } = selectOrchestrator();
  const maxExchanges = promptInteger("Max exchanges per cycle", DEFAULT_MAX_EXCHANGES);
  const maxCycles = promptInteger("Max cycles", DEFAULT_MAX_CYCLES);
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
  const { backend: explicitBackend, model: explicitModel } = parseOrchestratorFlag(flags.orchestrator);
  const team =
    flags.team ??
    (flags.test ? "test" : flags.improve || flags.fixFrom !== null ? "full" : "full");

  let orchestrator: string;
  let orchestratorModel = explicitModel;

  if (flags.debug) {
    orchestrator = explicitBackend ?? "api";
    orchestratorModel ??= "opus";
  } else {
    if (explicitBackend !== null) {
      orchestrator = explicitBackend;
    } else if (explicitModel !== null) {
      orchestrator = "api";
    } else if (hasAnyApiKey()) {
      orchestrator = "api";
    } else {
      orchestrator = preferredOrchestrator();
    }

    orchestratorModel ??= defaultCliModel(orchestrator);

    if (orchestrator === "api" && !hasAnyApiKey()) {
      throw new CliError("API orchestrator selected but no provider API key was found in the environment.");
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
    flags.team !== null
    || flags.orchestrator !== null
    || flags.exchanges !== null
    || flags.cycles !== null
    || flags.effort !== null
    || flags.noAutoCommit
    || flags.debug;
  const nonInteractiveGoal =
    flags.goal !== null || flags.goalFile !== null || flags.improve || flags.test || flags.fixFrom !== null;

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
    return { goalText: flags.focus ? `Improve the project with focus: ${flags.focus}` : null, source: "improve" };
  }
  if (flags.test) {
    return {
      goalText: flags.focus ? `Test the project with focus: ${flags.focus}` : "Test the project through realistic workflows.",
      source: "test",
    };
  }
  if (flags.fixFrom !== null) {
    return { goalText: `Fix findings from run ${flags.fixFrom}`, source: "fix-from" };
  }

  return { goalText: null, source: "interactive" };
}
