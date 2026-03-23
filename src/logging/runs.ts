import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { safeJoin } from "../runtime/fs.js";

export type RunState = {
  agentSessionIds: Record<string, string>;
  completedCycles: number;
  completedStages: number[];
  finished: boolean;
  goal: string;
  hasStages: boolean;
  isDebug: boolean;
  lastSummary: string;
  logFile: string;
  maxExchanges: number;
  maxCycles: number;
  model: string;
  orchestrator: string;
  projectDir: string;
  runId: string;
  stageSummaries: string[];
  team: string[];
  teamPreset: string;
};

type RunEvent = Record<string, unknown>;

export function runsRoot(homeDir = os.homedir()): string {
  const override = process.env.KODO_RUNS_DIR;
  const root = override ? path.resolve(override) : path.join(homeDir, ".kodo", "runs");
  mkdirSync(root, { recursive: true });
  return root;
}

function extractRunId(logFile: string): string {
  return path.basename(path.dirname(logFile));
}

function readJsonLines(filePath: string): RunEvent[] {
  const content = readFileSync(filePath, "utf8");
  return content
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as RunEvent];
      } catch {
        return [];
      }
    });
}

export function parseRun(logFile: string): RunState | null {
  const events = readJsonLines(logFile);
  let runStart: RunEvent | null = null;
  let cliArgs: RunEvent | null = null;
  let completedCycles = 0;
  const completedStages: number[] = [];
  let finished = false;
  let hasStages = false;
  let lastSummary = "";
  let isDebug = false;
  let pendingSessionId: string | null = null;
  const agentSessionIds: Record<string, string> = {};
  const stageSummaries: string[] = [];

  for (const event of events) {
    switch (event.event) {
      case "run_start":
        runStart = event;
        hasStages = event.has_stages === true;
        break;
      case "cli_args":
        cliArgs = event;
        break;
      case "cycle_end":
        completedCycles += 1;
        lastSummary = typeof event.summary === "string" ? event.summary : lastSummary;
        break;
      case "stage_end":
        if (event.finished === true && typeof event.stage_index === "number") {
          completedStages.push(event.stage_index);
          if (typeof event.summary === "string" && event.summary.length > 0) {
            stageSummaries.push(event.summary);
          }
        }
        break;
      case "run_end":
        finished = true;
        break;
      case "debug_run_start":
        isDebug = true;
        break;
      case "session_query_end":
        if (typeof event.session_id === "string") {
          pendingSessionId = event.session_id;
        } else if (typeof event.chat_id === "string") {
          pendingSessionId = event.chat_id;
        } else {
          pendingSessionId = null;
        }
        break;
      case "agent_run_end":
        if (
          pendingSessionId !== null &&
          typeof event.agent === "string" &&
          event.agent.length > 0
        ) {
          agentSessionIds[event.agent] = pendingSessionId;
        }
        pendingSessionId = null;
        break;
      default:
        break;
    }
  }

  if (runStart === null || cliArgs === null) {
    return null;
  }

  const goal = typeof runStart.goal === "string" ? runStart.goal : "";

  if (goal.length === 0) {
    return null;
  }

  return {
    agentSessionIds,
    completedCycles,
    completedStages,
    finished,
    goal,
    hasStages,
    isDebug,
    lastSummary,
    logFile,
    maxCycles:
      typeof runStart.max_cycles === "number"
        ? runStart.max_cycles
        : typeof cliArgs.max_cycles === "number"
          ? cliArgs.max_cycles
          : 0,
    maxExchanges:
      typeof runStart.max_exchanges === "number"
        ? runStart.max_exchanges
        : typeof cliArgs.max_exchanges === "number"
          ? cliArgs.max_exchanges
          : 0,
    model:
      typeof runStart.model === "string"
        ? runStart.model
        : typeof cliArgs.orchestrator_model === "string"
          ? cliArgs.orchestrator_model
          : "unknown",
    orchestrator:
      typeof runStart.orchestrator === "string"
        ? runStart.orchestrator
        : typeof cliArgs.orchestrator === "string"
          ? cliArgs.orchestrator
          : "unknown",
    projectDir:
      typeof runStart.project_dir === "string"
        ? runStart.project_dir
        : typeof cliArgs.project_dir === "string"
          ? cliArgs.project_dir
          : "",
    runId: extractRunId(logFile),
    stageSummaries,
    team: Array.isArray(runStart.team)
      ? runStart.team.filter((value): value is string => typeof value === "string")
      : [],
    teamPreset:
      typeof cliArgs.team === "string"
        ? cliArgs.team
        : typeof cliArgs.mode === "string"
          ? cliArgs.mode
          : "full",
  };
}

function extractProjectDir(logFile: string): string | null {
  try {
    const lines = readFileSync(logFile, "utf8").split(/\r?\n/u).slice(0, 12);
    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      try {
        const event = JSON.parse(line) as RunEvent;
        if (
          (event.event === "run_start" || event.event === "cli_args") &&
          typeof event.project_dir === "string"
        ) {
          return event.project_dir;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }

  return null;
}

export function listRuns(projectDir?: string, homeDir = os.homedir()): RunState[] {
  const root = runsRoot(homeDir);
  const resolvedProject = projectDir ? path.resolve(projectDir) : null;
  const candidates = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, entry.name))
    .sort()
    .reverse()
    .flatMap((directory) => {
      const logFile = path.join(directory, "log.jsonl");
      const legacy = path.join(directory, "run.jsonl");
      if (existsSync(logFile)) {
        return [logFile];
      }
      if (existsSync(legacy)) {
        return [legacy];
      }
      return [];
    });

  const runs: RunState[] = [];
  for (const candidate of candidates) {
    if (resolvedProject !== null) {
      const runProject = extractProjectDir(candidate);
      if (runProject !== null && path.resolve(runProject) !== resolvedProject) {
        continue;
      }
    }

    try {
      const parsed = parseRun(candidate);
      if (parsed === null) {
        continue;
      }
      if (resolvedProject !== null && path.resolve(parsed.projectDir) !== resolvedProject) {
        continue;
      }
      runs.push(parsed);
    } catch {
      continue;
    }
  }

  return runs;
}

export function findIncompleteRuns(projectDir: string, homeDir = os.homedir()): RunState[] {
  return listRuns(projectDir, homeDir).filter((run) => !run.finished);
}

export function getRunById(runId: string, homeDir = os.homedir()): RunState | null {
  let runDir: string;
  try {
    runDir = safeJoin(runsRoot(homeDir), runId);
  } catch {
    return null;
  }
  const logFile = path.join(runDir, "log.jsonl");
  const legacy = path.join(runDir, "run.jsonl");
  const candidate = existsSync(logFile) ? logFile : existsSync(legacy) ? legacy : null;
  if (candidate === null) {
    return null;
  }
  try {
    return parseRun(candidate);
  } catch {
    return null;
  }
}

export function truncateWord(text: string, width: number): string {
  if (text.length <= width) {
    return text;
  }
  const cut = text.slice(0, width).replace(/\s+\S*$/u, "");
  return `${cut.length > 0 ? cut : text.slice(0, width)}...`;
}
