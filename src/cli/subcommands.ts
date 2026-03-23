import os from "node:os";
import path from "node:path";

import {
  AGENT_DEFAULTS,
  describeTeamStatus,
  generateAutoTeam,
  getTeamByName,
  listAvailableTeams,
  saveTeamConfig,
  teamsDir,
  type TeamAgentConfig,
  type TeamBackend,
  type TeamConfig,
} from "../config/team-config.js";
import { CliError } from "../core/errors.js";
import { availableBackends } from "../runtime/backends.js";
import { listRuns, truncateWord, type RunState } from "../logging/runs.js";
import { getPromptAdapter } from "./prompts.js";
import type { TopLevelSubcommand } from "./types.js";
import { printLines, writeStderr } from "./ui.js";

const TEAM_HELP = [
  "Usage: kodo teams [add <name> | edit <name> | auto [mode]]",
  "",
  "  (no args)   List all available teams",
  "  add <name>  Create a new team configuration",
  "  edit <name> Edit an existing team configuration",
  "  auto        Generate teams adapted to installed backends",
];

function placeholderSummary(command: string, detail: string, args: string[]): void {
  const lines = [`${detail}`, "", `Command: ${command}`];
  if (args.length > 0) {
    lines.push(`Args: ${args.join(" ")}`);
  }
  printLines(lines);
}

function printTeamHelp(): void {
  printLines(TEAM_HELP);
}

function parseLogsArgs(args: string[]): { logfile: string | null; port: number } {
  let logfile: string | null = null;
  let port = 8080;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--port") {
      const raw = args[index + 1];
      if (raw === undefined || !/^-?\d+$/u.test(raw)) {
        throw new CliError("argument --port: expected integer value");
      }
      port = Number.parseInt(raw, 10);
      index += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      printLines([
        "Usage: kodo logs [logfile] [--port PORT]",
        "",
        "Open or inspect run logs for the local viewer.",
      ]);
      return { logfile: "", port };
    }
    if (token.startsWith("-")) {
      throw new CliError(`unrecognized arguments: ${token}`);
    }
    if (logfile !== null) {
      throw new CliError(`unrecognized arguments: ${token}`);
    }
    logfile = token;
  }

  return { logfile, port };
}

function parseIssueArgs(args: string[]): { noOpen: boolean; project: string; runId: string | null } {
  let noOpen = false;
  let project = ".";
  let runId: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--help" || token === "-h") {
      printLines([
        "Usage: kodo issue [run_id] [--project PROJECT] [--no-open]",
        "",
        "Create a GitHub issue URL for a selected run.",
      ]);
      return { noOpen: true, project, runId: "" };
    }
    if (token === "--no-open") {
      noOpen = true;
      continue;
    }
    if (token === "--project") {
      const value = args[index + 1];
      if (value === undefined) {
        throw new CliError("argument --project: expected one argument");
      }
      project = value;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      throw new CliError(`unrecognized arguments: ${token}`);
    }
    if (runId !== null) {
      throw new CliError(`unrecognized arguments: ${token}`);
    }
    runId = token;
  }

  return { noOpen, project, runId };
}

function formatRunStatus(run: RunState): string {
  return run.finished ? "done" : `cycle ${run.completedCycles}/${run.maxCycles}`;
}

function pickRun(runs: RunState[], prompt = "Select run:"): RunState | null {
  if (runs.length === 0) {
    return null;
  }
  if (runs.length === 1) {
    return runs[0];
  }

  const choices = runs.map((run) => `${run.runId}  ${formatRunStatus(run)}  ${truncateWord(run.goal.replace(/\s+/gu, " "), 50)}`);
  const selected = getPromptAdapter().select(prompt, choices, choices[0]);
  if (selected === null) {
    return null;
  }

  const selectedId = selected.split(/\s+/u, 1)[0];
  return runs.find((run) => run.runId === selectedId) ?? null;
}

function listTeams(homeDir = os.homedir()): void {
  const teams = listAvailableTeams(homeDir);
  if (teams.length === 0) {
    printLines(["No teams found."]);
    return;
  }

  let hasMissing = false;
  for (const team of teams) {
    printLines([team.name]);
    if (team.config.description) {
      printLines([`  ${team.config.description}`]);
    }
    if (team.source !== "built-in") {
      printLines([`  ${team.path}`]);
    }
    const status = describeTeamStatus(team.config);
    hasMissing ||= status.hasMissing;
    printLines(status.lines);
    printLines([""]);
  }

  if (hasMissing) {
    printLines(["Hint: Run 'kodo teams auto' to generate teams adapted to your installed backends.", ""]);
  }
}

function selectBackend(defaultValue?: TeamBackend): TeamBackend | null {
  const prompt = getPromptAdapter();
  const choices: TeamBackend[] = ["claude", "claude-cli", "cursor", "codex", "gemini-cli"];
  const value = prompt.select("Backend", choices, defaultValue ?? choices[0]);
  if (value === null) {
    return null;
  }
  if (!choices.includes(value as TeamBackend)) {
    throw new CliError(`Unknown backend: ${value}`);
  }
  return value as TeamBackend;
}

function promptInteger(message: string, defaultValue: number | undefined): number | null {
  const prompt = getPromptAdapter();
  const raw = prompt.text(message, defaultValue === undefined ? "" : String(defaultValue));
  if (raw === null) {
    return null;
  }
  if (raw.trim() === "") {
    return defaultValue ?? null;
  }
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new CliError(`${message} must be an integer.`);
  }
  return Number.parseInt(raw.trim(), 10);
}

function promptAgentFields(defaults?: TeamAgentConfig): TeamAgentConfig | null {
  const prompt = getPromptAdapter();
  const backend = selectBackend(defaults?.backend);
  if (backend === null) {
    return null;
  }

  const modelSuggestions: Record<TeamBackend, string[]> = {
    claude: ["sonnet", "opus"],
    "claude-cli": ["sonnet", "opus"],
    codex: ["gpt-5.4", "gpt-5.3-codex", "o3"],
    cursor: ["composer-1.5"],
    "gemini-cli": ["gemini-2.5-flash", "gemini-3-flash", "gemini-3-pro"],
  };

  const modelChoice = prompt.select("Model", [...modelSuggestions[backend], "(custom)"], defaults?.model);
  if (modelChoice === null) {
    return null;
  }
  const model =
    modelChoice === "(custom)"
      ? prompt.text("Model name", defaults?.model ?? "")
      : modelChoice;
  if (model === null) {
    return null;
  }

  const description = prompt.text("Description", defaults?.description ?? AGENT_DEFAULTS.description);
  if (description === null) {
    return null;
  }
  const systemPrompt = prompt.text("System prompt (empty to skip)", defaults?.system_prompt ?? "");
  if (systemPrompt === null) {
    return null;
  }
  const maxTurns = promptInteger("Max turns", defaults?.max_turns ?? AGENT_DEFAULTS.max_turns);
  if (maxTurns === null) {
    return null;
  }
  const timeout = prompt.text(
    "Timeout in seconds (empty for none)",
    defaults?.timeout_s === undefined ? "" : String(defaults.timeout_s),
  );
  if (timeout === null) {
    return null;
  }

  const result: TeamAgentConfig = {
    backend,
    model: model.trim(),
    description,
    max_turns: maxTurns,
  };

  if (systemPrompt.trim()) {
    result.system_prompt = systemPrompt;
  }
  if (timeout.trim()) {
    if (!/^-?\d+$/.test(timeout.trim())) {
      throw new CliError("Timeout in seconds must be an integer.");
    }
    result.timeout_s = Number.parseInt(timeout.trim(), 10);
  }
  if (backend === "claude" || backend === "claude-cli") {
    const fallback = prompt.text("Fallback model (empty to skip)", defaults?.fallback_model ?? "");
    if (fallback === null) {
      return null;
    }
    if (fallback.trim()) {
      result.fallback_model = fallback.trim();
    }
  }

  const chrome = prompt.confirm("Enable Chrome/browser access?", defaults?.chrome ?? false);
  if (chrome === null) {
    return null;
  }
  if (chrome) {
    result.chrome = true;
  }

  return result;
}

function ensureAtLeastOneAgent(agents: Record<string, TeamAgentConfig>): void {
  if (Object.keys(agents).length === 0) {
    throw new CliError("A team needs at least one agent.");
  }
}

function promptVerifiers(agentKeys: string[], defaults?: Record<string, string[]>): Record<string, string[]> | null {
  const prompt = getPromptAdapter();
  if (agentKeys.length <= 1) {
    return {
      testers: [],
      browser_testers: [],
      reviewers: [],
    };
  }

  const testers = prompt.multiselect("Select testers (non-browser)", agentKeys, defaults?.testers ?? []);
  if (testers === null) {
    return null;
  }
  const browserTesters = prompt.multiselect("Select browser testers", agentKeys, defaults?.browser_testers ?? []);
  if (browserTesters === null) {
    return null;
  }
  const reviewers = prompt.multiselect("Select reviewers (architects)", agentKeys, defaults?.reviewers ?? []);
  if (reviewers === null) {
    return null;
  }

  return {
    testers,
    browser_testers: browserTesters,
    reviewers,
  };
}

function addTeam(name: string, homeDir = os.homedir()): void {
  const existing = getTeamByName(name, homeDir);
  if (existing?.source === "user") {
    throw new CliError(`Team '${name}' already exists at ${existing.path}\nUse 'kodo teams edit ${name}' to modify it.`);
  }

  const prompt = getPromptAdapter();
  printLines([`Creating team: ${name}`, ""]);
  const description = prompt.text("Team description", "") ?? (() => { throw new CliError("Cancelled."); })();
  const orchestratorPrompt = prompt.text("Orchestrator prompt (empty for default)", "") ?? (() => { throw new CliError("Cancelled."); })();

  const agents: Record<string, TeamAgentConfig> = {};
  while (true) {
    printLines([`--- Add agent (${Object.keys(agents).length} so far) ---`]);
    const agentKey = prompt.text("Agent key name (empty to finish)", "");
    if (agentKey === null) {
      throw new CliError("Cancelled.");
    }
    if (agentKey.trim() === "") {
      if (Object.keys(agents).length === 0) {
        writeStderr("A team needs at least one agent.\n");
        continue;
      }
      break;
    }
    if (agentKey.trim() in agents) {
      writeStderr(`Agent '${agentKey.trim()}' already exists.\n`);
      continue;
    }
    const agent = promptAgentFields();
    if (agent === null) {
      throw new CliError("Cancelled.");
    }
    agents[agentKey.trim()] = agent;
  }

  const verifiers = promptVerifiers(Object.keys(agents));
  if (verifiers === null) {
    throw new CliError("Cancelled.");
  }

  const config: TeamConfig = {
    name,
    description,
    verifiers,
    agents,
  };
  if (orchestratorPrompt.trim()) {
    config.orchestrator_prompt = orchestratorPrompt;
  }

  const savedPath = saveTeamConfig(name, config, homeDir);
  printLines([`Saved to ${savedPath}`]);
}

function editTeam(name: string, homeDir = os.homedir()): void {
  const team = getTeamByName(name, homeDir);
  if (team === null) {
    const available = listAvailableTeams(homeDir).map((item) => `  ${item.name} (${item.source})`).join("\n");
    throw new CliError(`Team '${name}' not found.\nAvailable teams:\n${available}`);
  }

  if (team.source === "built-in") {
    printLines([`Copying built-in team '${name}' to user directory for editing.`]);
  }

  const prompt = getPromptAdapter();
  const config: TeamConfig = JSON.parse(JSON.stringify(team.config)) as TeamConfig;
  const agents = config.agents;
  let verifiers = config.verifiers ?? { testers: [], browser_testers: [], reviewers: [] };

  while (true) {
    printLines([
      "",
      `Team: ${name}`,
      `  Description: ${config.description ?? ""}`,
      `  Orchestrator prompt: ${config.orchestrator_prompt ? `${config.orchestrator_prompt.slice(0, 80)}...` : "(default)"}`,
      `  Agents (${Object.keys(agents).length}):`,
      ...Object.entries(agents).map(([agentKey, agent]) => `    ${agentKey}: ${agent.backend} / ${agent.model ?? "?"}`),
      "",
    ]);

    const action = prompt.select("Action", ["Add agent", "Edit agent", "Remove agent", "Edit team settings", "Edit verifiers", "Save & exit"], "Save & exit");
    if (action === null) {
      throw new CliError("Cancelled.");
    }

    if (action === "Add agent") {
      const agentKey = prompt.text("Agent key name", "");
      if (agentKey === null) {
        throw new CliError("Cancelled.");
      }
      if (!agentKey.trim()) {
        continue;
      }
      if (agentKey.trim() in agents) {
        writeStderr(`Agent '${agentKey.trim()}' already exists.\n`);
        continue;
      }
      const agent = promptAgentFields();
      if (agent === null) {
        throw new CliError("Cancelled.");
      }
      agents[agentKey.trim()] = agent;
    } else if (action === "Edit agent") {
      ensureAtLeastOneAgent(agents);
      const agentKey = prompt.select("Which agent?", Object.keys(agents), Object.keys(agents)[0]);
      if (agentKey === null) {
        throw new CliError("Cancelled.");
      }
      if (!(agentKey in agents)) {
        throw new CliError(`Unknown agent: ${agentKey}`);
      }
      const edited = promptAgentFields(agents[agentKey]);
      if (edited === null) {
        throw new CliError("Cancelled.");
      }
      agents[agentKey] = edited;
    } else if (action === "Remove agent") {
      ensureAtLeastOneAgent(agents);
      const agentKey = prompt.select("Remove which agent?", Object.keys(agents), Object.keys(agents)[0]);
      if (agentKey === null) {
        throw new CliError("Cancelled.");
      }
      delete agents[agentKey];
      if (Object.keys(agents).length === 0) {
        writeStderr("A team needs at least one agent.\n");
      }
    } else if (action === "Edit team settings") {
      const description = prompt.text("Team description", config.description ?? "");
      if (description === null) {
        throw new CliError("Cancelled.");
      }
      const orchestratorPrompt = prompt.text("Orchestrator prompt (empty for default)", config.orchestrator_prompt ?? "");
      if (orchestratorPrompt === null) {
        throw new CliError("Cancelled.");
      }
      config.description = description;
      if (orchestratorPrompt.trim()) {
        config.orchestrator_prompt = orchestratorPrompt;
      } else {
        delete config.orchestrator_prompt;
      }
    } else if (action === "Edit verifiers") {
      const nextVerifiers = promptVerifiers(Object.keys(agents), verifiers);
      if (nextVerifiers === null) {
        throw new CliError("Cancelled.");
      }
      verifiers = nextVerifiers;
    } else if (action === "Save & exit") {
      ensureAtLeastOneAgent(agents);
      config.verifiers = Object.fromEntries(
        Object.entries(verifiers).map(([role, keys]) => [role, keys.filter((key) => key in agents)]),
      );
      const savedPath = saveTeamConfig(name, config, homeDir);
      printLines([`Saved to ${savedPath}`]);
      return;
    }
  }
}

function autoTeam(modeName: string, homeDir = os.homedir()): void {
  const { config, skipped } = generateAutoTeam(modeName, homeDir);

  printLines([`Generated team '${modeName}' for your setup:`, ""]);
  for (const [agentKey, agentConfig] of Object.entries(config.agents)) {
    printLines([`  ${agentKey.padEnd(20)}  ${agentConfig.backend.padEnd(12)}  ${agentConfig.model ?? ""}`]);
  }
  if (skipped.length > 0) {
    printLines(["", `  Skipped (backend missing): ${skipped.map((item) => `${item.agent} (${item.backend})`).join(", ")}`]);
  }
  printLines([""]);

  const destination = `${teamsDir(homeDir)}/${modeName}.json`;
  const existing = getTeamByName(modeName, homeDir);
  if (existing?.source === "user") {
    const confirmed = getPromptAdapter().confirm(`Team '${modeName}' already exists at ${destination}. Overwrite?`, false);
    if (!confirmed) {
      writeStderr("Cancelled.\n");
      return;
    }
  }

  saveTeamConfig(modeName, config, homeDir);
  printLines([`Saved to ${destination}`, "", `Use with: kodo --team ${modeName}`]);
}

function listRunsSubcommand(args: string[], homeDir = os.homedir()): void {
  if (args.includes("--help") || args.includes("-h")) {
    printLines([
      "Usage: kodo runs [project_dir]",
      "",
      "List all known runs, optionally filtered to a project directory.",
    ]);
    return;
  }
  if (args.length > 1) {
    throw new CliError(`unrecognized arguments: ${args.slice(1).join(" ")}`);
  }

  const projectDir = args[0] ? path.resolve(args[0]) : undefined;
  const runs = listRuns(projectDir, homeDir);
  if (runs.length === 0) {
    printLines(["No runs found."]);
    return;
  }

  const idWidth = Math.max(...runs.map((run) => run.runId.length));
  const projectWidth = Math.max(...runs.map((run) => run.projectDir.length));
  const header = `  ${"RUN ID".padEnd(idWidth)}  ${"STATUS".padEnd(10)}  ${"PROJECT".padEnd(projectWidth)}  GOAL`;
  printLines([header, `  ${"-".repeat(header.length - 2)}`]);
  for (const run of runs) {
    printLines([
      `  ${run.runId.padEnd(idWidth)}  ${formatRunStatus(run).padEnd(10)}  ${run.projectDir.padEnd(projectWidth)}  ${truncateWord(run.goal.replace(/\s+/gu, " "), 60)}`,
    ]);
  }
}

function showLogsSubcommand(args: string[], homeDir = os.homedir()): void {
  const parsed = parseLogsArgs(args);
  if (parsed.logfile === "") {
    return;
  }

  if (parsed.logfile !== null) {
    const resolved = path.resolve(parsed.logfile);
    if (!resolved.endsWith(".jsonl")) {
      throw new CliError(`Expected a .jsonl log file: ${resolved}`);
    }
    printLines([
      `Viewer support is not implemented yet in the TypeScript port.`,
      `Log file: ${resolved}`,
      `Requested port: ${parsed.port}`,
    ]);
    return;
  }

  const runs = listRuns(undefined, homeDir);
  if (runs.length === 0) {
    throw new CliError("No runs found. Specify a log file or run kodo first.");
  }

  const selected = pickRun(runs, "Select run for logs:");
  if (selected === null) {
    throw new CliError("Cancelled.");
  }

  printLines([
    `Viewer support is not implemented yet in the TypeScript port.`,
    `Log file: ${selected.logFile}`,
    `Requested port: ${parsed.port}`,
  ]);
}

function listBackendsSubcommand(): void {
  const backends = availableBackends();
  const lines = Object.entries(backends).map(([name, installed]) => `  ${name.padEnd(12)} ${installed ? "installed" : "missing"}`);
  printLines(["Available backends:", ...lines]);
}

function issueSubcommand(args: string[], homeDir = os.homedir()): void {
  const parsed = parseIssueArgs(args);
  if (parsed.runId === "") {
    return;
  }

  const projectDir = path.resolve(parsed.project);
  const selected =
    parsed.runId !== null
      ? getRunById(parsed.runId, homeDir)
      : pickRun(listRuns(projectDir, homeDir), "Select run to report:");

  if (selected === null) {
    throw new CliError(parsed.runId !== null ? `Run not found: ${parsed.runId}` : "No runs found. Specify a run ID or run kodo first.");
  }

  const description = getPromptAdapter().text("Describe what went wrong (leave empty if obvious)", "") ?? "";
  const status = selected.finished ? "done" : `interrupted at cycle ${selected.completedCycles}/${selected.maxCycles}`;
  const body = [
    `**Run:** ${selected.runId}`,
    `**Goal:** ${selected.goal.slice(0, 500)}${selected.goal.length > 500 ? "..." : ""}`,
    `**Status:** ${status}`,
    `**Log file:** ${selected.logFile}`,
    "",
    description.trim(),
  ]
    .filter((line) => line.length > 0)
    .join("\n");

  const url = `https://github.com/ikamensh/kodo/issues/new?title=${encodeURIComponent(`Bug report: run ${selected.runId}`)}&body=${encodeURIComponent(body)}`;

  const lines = ["Issue URL:", url];
  if (!parsed.noOpen) {
    lines.push("", "Open the URL in your browser and attach the run artifacts manually.");
  }
  printLines(lines);
}

export function handleSubcommand(command: TopLevelSubcommand, args: string[]): number {
  switch (command) {
    case "run":
    case "runs":
      listRunsSubcommand(args);
      return 0;
    case "log":
    case "logs":
      showLogsSubcommand(args);
      return 0;
    case "issue":
    case "issues":
      issueSubcommand(args);
      return 0;
    case "backend":
    case "backends":
      listBackendsSubcommand();
      return 0;
    case "update":
      placeholderSummary(command, "Self-update is not implemented yet in the TypeScript port.", args);
      return 0;
    case "help":
      return -1;
    case "team":
    case "teams": {
      if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
        if (args.length === 0) {
          listTeams();
        } else {
          printTeamHelp();
        }
        return 0;
      }

      const [subcommand, maybeName] = args;
      if ((subcommand === "add" || subcommand === "edit") && !maybeName) {
        throw new CliError(`Usage: kodo teams ${subcommand} <name>`);
      }
      if (subcommand !== "add" && subcommand !== "edit" && subcommand !== "auto") {
        throw new CliError(
          `Unknown teams subcommand: ${subcommand}\nUsage: kodo teams [add <name> | edit <name> | auto [mode]]`,
        );
      }

      if (subcommand === "add") {
        addTeam(maybeName);
        return 0;
      }
      if (subcommand === "edit") {
        editTeam(maybeName);
        return 0;
      }
      if (subcommand === "auto") {
        if (maybeName) {
          autoTeam(maybeName);
          return 0;
        }
        for (const team of listAvailableTeams().filter((entry) => entry.source === "built-in")) {
          autoTeam(team.name);
          printLines([""]);
        }
        return 0;
      }

      return 0;
    }
  }
}
