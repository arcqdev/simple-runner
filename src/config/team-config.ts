import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import fullTeam from "../defaults/team-full.json";
import quickTeam from "../defaults/team-quick.json";
import testTeam from "../defaults/team-test.json";
import { type BackendKey, availableBackends, isBackendKey, smartModelForBackend, type TeamBackend } from "../runtime/backends.js";

export type TeamAgentConfig = {
  backend: TeamBackend;
  model?: string;
  description?: string;
  max_turns?: number;
  timeout_s?: number;
  chrome?: boolean;
  system_prompt?: string;
  fallback_model?: string;
  session_timeout_s?: number;
};

export type { TeamBackend };

export type TeamConfig = {
  name?: string;
  description?: string;
  orchestrator_prompt?: string;
  verifiers?: Record<string, string[]>;
  agents: Record<string, TeamAgentConfig>;
};

export type TeamListing = {
  name: string;
  source: "built-in" | "project" | "user";
  config: TeamConfig;
  path: string;
};

export const TEAM_BACKEND_MAP: Record<TeamBackend, BackendKey | ""> = {
  claude: "claude",
  "claude-cli": "claude",
  codex: "codex",
  cursor: "cursor",
  "gemini-cli": "gemini-cli",
};

const BUILTIN_TEAMS: Record<string, TeamConfig> = {
  full: fullTeam as TeamConfig,
  quick: quickTeam as TeamConfig,
  test: testTeam as TeamConfig,
};

export const AGENT_DEFAULTS = {
  chrome: false,
  description: "",
  fallback_model: undefined,
  max_turns: 15,
  session_timeout_s: 7200,
  system_prompt: undefined,
  timeout_s: undefined,
} as const;

export function teamsDir(homeDir = os.homedir()): string {
  const result = path.join(homeDir, ".kodo", "teams");
  mkdirSync(result, { recursive: true });
  return result;
}

export function projectTeamConfigPath(projectDir: string): string {
  return path.join(projectDir, ".kodo", "team.json");
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validateTeamConfigShape(config: unknown, sourcePath: string): TeamConfig {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`Team config must be a JSON object in ${sourcePath}`);
  }

  const typed = config as { agents?: unknown };
  if (typeof typed.agents !== "object" || typed.agents === null || Array.isArray(typed.agents)) {
    throw new Error(`Team config must have an 'agents' object in ${sourcePath}`);
  }

  return config as TeamConfig;
}

export function loadTeamConfigFile(filePath: string): TeamConfig {
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return validateTeamConfigShape(parsed, filePath);
}

export function listAvailableTeams(homeDir = os.homedir()): TeamListing[] {
  const teams = new Map<string, TeamListing>();

  for (const [name, config] of Object.entries(BUILTIN_TEAMS)) {
    teams.set(name, {
      name,
      source: "built-in",
      config: deepClone(config),
      path: `builtin:${name}`,
    });
  }

  const userDir = teamsDir(homeDir);
  for (const entry of readdirSync(userDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    const filePath = path.join(userDir, entry.name);
    try {
      const config = loadTeamConfigFile(filePath);
      teams.set(path.basename(entry.name, ".json"), {
        name: path.basename(entry.name, ".json"),
        source: "user",
        config,
        path: filePath,
      });
    } catch {
      continue;
    }
  }

  return [...teams.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function getTeamByName(name: string, homeDir = os.homedir(), projectDir?: string): TeamListing | null {
  if (projectDir !== undefined) {
    const projectPath = projectTeamConfigPath(projectDir);
    try {
      return {
        name,
        source: "project",
        config: loadTeamConfigFile(projectPath),
        path: projectPath,
      };
    } catch {
      // Fall through to user/built-in lookup when the project override is absent or invalid.
    }
  }

  return listAvailableTeams(homeDir).find((team) => team.name === name) ?? null;
}

export function saveTeamConfig(name: string, config: TeamConfig, homeDir = os.homedir()): string {
  const destination = path.join(teamsDir(homeDir), `${name}.json`);
  writeFileSync(destination, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return destination;
}

export function describeTeamStatus(config: TeamConfig): { hasMissing: boolean; lines: string[] } {
  const backends = availableBackends();
  const lines: string[] = [];
  let hasMissing = false;

  for (const [agentKey, agentConfig] of Object.entries(config.agents)) {
    const backend = agentConfig.backend ?? "?";
    const backendKey = TEAM_BACKEND_MAP[backend as TeamBackend];
    const model = agentConfig.model ?? (backendKey && isBackendKey(backendKey) ? `default (${smartModelForBackend(backendKey)})` : "default");
    const ok = backendKey !== "" && isBackendKey(backendKey) ? backends[backendKey] : false;
    if (!ok) {
      hasMissing = true;
    }
    const status = ok ? "ok" : "missing";
    const description = agentConfig.description?.split("\n")[0]?.trim();
    lines.push(
      `    ${agentKey.padEnd(20)}  ${backend.padEnd(12)}  ${model.padEnd(20)}  [${status}]${description ? `  ${description}` : ""}`,
    );
  }

  return { hasMissing, lines };
}

export function generateAutoTeam(modeName: string, homeDir = os.homedir()): { config: TeamConfig; skipped: Array<{ agent: string; backend: string }> } {
  const listing = getTeamByName(modeName, homeDir);
  if (listing === null) {
    const available = listAvailableTeams(homeDir).map((team) => team.name).join(", ");
    throw new Error(`No template found for mode '${modeName}'.\nAvailable templates: ${available}`);
  }

  const backends = availableBackends();
  if (!Object.values(backends).some(Boolean)) {
    throw new Error(
      "No backends available. Install at least one of:\n  claude, cursor, codex, gemini-cli\nRun 'kodo backends' for install links.",
    );
  }

  const sourceAgents = listing.config.agents;
  const agents: Record<string, TeamAgentConfig> = {};
  const skipped: Array<{ agent: string; backend: string }> = [];

  for (const [agentKey, agentConfig] of Object.entries(sourceAgents)) {
    const backendKey = TEAM_BACKEND_MAP[agentConfig.backend];
    if (backendKey && isBackendKey(backendKey) && backends[backendKey]) {
      agents[agentKey] = deepClone(agentConfig);
    } else {
      skipped.push({ agent: agentKey, backend: agentConfig.backend });
    }
  }

  const fastFallbacks: Array<[TeamBackend, string]> = [
    ["cursor", "composer-1.5"],
    ["codex", "gpt-5.4"],
    ["gemini-cli", "gemini-2.5-flash"],
    ["claude", "sonnet"],
  ];
  const smartFallbacks: Array<[TeamBackend, string]> = [
    ["claude", "opus"],
    ["gemini-cli", "gemini-3-pro"],
    ["cursor", "composer-1.5"],
  ];

  const findFallback = (candidates: Array<[TeamBackend, string]>): [TeamBackend, string] | null =>
    candidates.find(([backend]) => {
      const backendKey = TEAM_BACKEND_MAP[backend];
      return backendKey !== "" && backends[backendKey];
    }) ?? null;

  const maybeFillRole = (role: string, fallbacks: Array<[TeamBackend, string]>): void => {
    if (role in agents || !(role in sourceAgents)) {
      return;
    }
    const fallback = findFallback(fallbacks);
    if (fallback === null) {
      return;
    }
    const [backend, model] = fallback;
    const nextAgent = {
      ...deepClone(sourceAgents[role]),
      backend,
      model,
    } satisfies TeamAgentConfig;
    if (backend !== "claude") {
      delete nextAgent.fallback_model;
    }
    agents[role] = nextAgent;
  };

  maybeFillRole("worker_fast", fastFallbacks);
  maybeFillRole("worker_smart", smartFallbacks);
  maybeFillRole("tester", fastFallbacks);
  maybeFillRole("architect", smartFallbacks);

  if (Object.keys(agents).length === 0) {
    throw new Error("Could not create any agents with available backends.");
  }

  const verifiers = Object.fromEntries(
    Object.entries(listing.config.verifiers ?? {}).map(([role, agentKeys]) => [role, agentKeys.filter((agentKey) => agentKey in agents)]),
  );

  return {
    config: {
      name: modeName,
      description: listing.config.description ?? "",
      orchestrator_prompt: listing.config.orchestrator_prompt,
      verifiers,
      agents,
    },
    skipped,
  };
}
