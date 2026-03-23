import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type RunState = {
  completedCycles: number;
  finished: boolean;
  goal: string;
  isDebug: boolean;
  lastSummary: string;
  logFile: string;
  maxCycles: number;
  model: string;
  orchestrator: string;
  projectDir: string;
  runId: string;
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
  let finished = false;
  let lastSummary = "";
  let isDebug = false;

  for (const event of events) {
    switch (event.event) {
      case "run_start":
        runStart = event;
        break;
      case "cli_args":
        cliArgs = event;
        break;
      case "cycle_end":
        completedCycles += 1;
        lastSummary = typeof event.summary === "string" ? event.summary : lastSummary;
        break;
      case "run_end":
        finished = true;
        break;
      case "debug_run_start":
        isDebug = true;
        break;
      default:
        break;
    }
  }

  if (cliArgs === null) {
    return null;
  }

  const goalSource = runStart ?? cliArgs;
  const goal =
    typeof goalSource.goal === "string"
      ? goalSource.goal
      : typeof cliArgs.goal_text === "string"
        ? cliArgs.goal_text
        : "";

  if (goal.length === 0) {
    return null;
  }

  return {
    completedCycles,
    finished,
    goal,
    isDebug,
    lastSummary,
    logFile,
    maxCycles:
      typeof goalSource.max_cycles === "number"
        ? goalSource.max_cycles
        : typeof cliArgs.max_cycles === "number"
          ? cliArgs.max_cycles
          : 0,
    model:
      typeof goalSource.model === "string"
        ? goalSource.model
        : typeof cliArgs.orchestrator_model === "string"
          ? cliArgs.orchestrator_model
          : "unknown",
    orchestrator:
      typeof goalSource.orchestrator === "string"
        ? goalSource.orchestrator
        : typeof cliArgs.orchestrator === "string"
          ? cliArgs.orchestrator
          : "unknown",
    projectDir:
      typeof goalSource.project_dir === "string"
        ? goalSource.project_dir
        : typeof cliArgs.project_dir === "string"
          ? cliArgs.project_dir
          : "",
    runId: extractRunId(logFile),
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
  const runDir = path.join(runsRoot(homeDir), runId);
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
