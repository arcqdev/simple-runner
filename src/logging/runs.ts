import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { safeJoin } from "../runtime/fs.js";

export type RunState = {
  agentStats: Record<string, AgentStats>;
  agentSessionIds: Record<string, string>;
  completedCycles: number;
  completedStages: number[];
  conversationArtifacts: string[];
  currentStageCycles: number;
  errorCount: number;
  finished: boolean;
  goal: string;
  hasStages: boolean;
  inputTokens: number;
  isDebug: boolean;
  lastSummary: string;
  logFile: string;
  maxExchanges: number;
  maxCycles: number;
  model: string;
  orchestratorCostBucket: string;
  orchestrator: string;
  outputTokens: number;
  pendingExchanges: Array<Record<string, unknown>>;
  parallelStageState: Record<string, Record<string, unknown>>;
  projectDir: string;
  runId: string;
  stageSummaries: string[];
  team: string[];
  teamPreset: string;
  totalAgentCalls: number;
  totalElapsedS: number;
};

type RunEvent = Record<string, unknown>;
type AgentStats = {
  calls: number;
  conversationLogs: string[];
  costBucket: string;
  elapsedS: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
};

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

function stringField(event: RunEvent | null, key: string): string | null {
  if (event === null) {
    return null;
  }
  const value = event[key];
  return typeof value === "string" ? value : null;
}

function numberField(event: RunEvent | null, key: string): number | null {
  if (event === null) {
    return null;
  }
  const value = event[key];
  return typeof value === "number" ? value : null;
}

function emptyAgentStats(costBucket = ""): AgentStats {
  return {
    calls: 0,
    conversationLogs: [],
    costBucket,
    elapsedS: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function inferCostBucketFromName(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized === "api") {
    return "api";
  }
  if (normalized.includes("claude")) {
    return "claude_subscription";
  }
  if (normalized.includes("codex")) {
    return "codex_subscription";
  }
  if (
    normalized.includes("cursor") ||
    normalized.includes("browser") ||
    normalized.includes("tester")
  ) {
    return "cursor_subscription";
  }
  if (normalized.includes("gemini")) {
    return "gemini_api";
  }
  if (normalized.includes("smart") || normalized.includes("architect")) {
    return "claude_subscription";
  }
  if (normalized.includes("fast")) {
    return "cursor_subscription";
  }
  return "unknown";
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
  let currentStageCycles = 0;
  let currentStageIndex: number | null = null;
  let pendingSessionId: string | null = null;
  const agentSessionIds: Record<string, string> = {};
  let pendingExchanges: Array<Record<string, unknown>> = [];
  let parallelStageState: Record<string, Record<string, unknown>> = {};
  const sessionIdsByName: Record<string, string> = {};
  const stageSummaries: string[] = [];
  const agentStats: Record<string, AgentStats> = {};
  const conversationArtifacts = new Set<string>();
  const genericSessionNames = new Set(["claude", "codex", "cursor", "gemini-cli"]);
  let pendingConversationLog: string | null = null;
  let orchestratorCostBucket = "unknown";

  for (const event of events) {
    switch (event.event) {
      case "run_start":
        runStart = event;
        hasStages = event.has_stages === true;
        orchestratorCostBucket =
          stringField(event, "cost_bucket") ??
          inferCostBucketFromName(stringField(event, "orchestrator") ?? "unknown");
        break;
      case "cli_args":
        cliArgs = event;
        break;
      case "stage_start":
        currentStageIndex = numberField(event, "stage_index");
        currentStageCycles = 0;
        break;
      case "cycle_end":
        completedCycles += 1;
        lastSummary = typeof event.summary === "string" ? event.summary : lastSummary;
        if (currentStageIndex !== null) {
          currentStageCycles += 1;
        }
        orchestratorCostBucket = stringField(event, "cost_bucket") ?? orchestratorCostBucket;
        break;
      case "stage_end":
        if (event.finished === true && typeof event.stage_index === "number") {
          completedStages.push(event.stage_index);
          if (typeof event.summary === "string" && event.summary.length > 0) {
            stageSummaries.push(event.summary);
          }
        }
        currentStageIndex = null;
        currentStageCycles = 0;
        break;
      case "run_end":
        finished = event.finished !== false;
        if (typeof event.summary === "string" && event.summary.length > 0) {
          lastSummary = event.summary;
        }
        break;
      case "debug_run_start":
        isDebug = true;
        break;
      case "session_query_end":
        pendingSessionId = stringField(event, "session_id") ?? stringField(event, "chat_id");
        pendingConversationLog = stringField(event, "conversation_log");
        {
          const sessionName = stringField(event, "session");
          if (sessionName !== null && pendingSessionId !== null) {
            sessionIdsByName[sessionName] = pendingSessionId;
            agentSessionIds[sessionName] = pendingSessionId;
          }
        }
        break;
      case "agent_run_end":
        if (typeof event.agent === "string" && event.agent.length > 0) {
          if (pendingSessionId !== null) {
            agentSessionIds[event.agent] = pendingSessionId;
          }
          for (const sessionName of genericSessionNames) {
            const sessionId = sessionIdsByName[sessionName];
            if (sessionId !== undefined) {
              agentSessionIds[event.agent] = sessionId;
              delete sessionIdsByName[sessionName];
              delete agentSessionIds[sessionName];
            }
          }
          const bucket =
            stringField(event, "cost_bucket") ?? inferCostBucketFromName(String(event.agent));
          const stats = agentStats[event.agent] ?? emptyAgentStats(bucket);
          stats.calls += 1;
          stats.elapsedS += numberField(event, "elapsed_s") ?? 0;
          stats.errors += event.is_error === true ? 1 : 0;
          stats.inputTokens += numberField(event, "input_tokens") ?? 0;
          stats.outputTokens += numberField(event, "output_tokens") ?? 0;
          if (bucket.length > 0) {
            stats.costBucket = bucket;
          }
          const conversationLog = stringField(event, "conversation_log") ?? pendingConversationLog;
          if (conversationLog !== null) {
            stats.conversationLogs.push(conversationLog);
            conversationArtifacts.add(conversationLog);
          }
          agentStats[event.agent] = stats;
        }
        pendingSessionId = null;
        pendingConversationLog = null;
        break;
      case "orchestrator_response":
        orchestratorCostBucket = stringField(event, "cost_bucket") ?? orchestratorCostBucket;
        break;
      default:
        break;
    }
  }

  try {
    const runtimeStateFile = path.join(path.dirname(logFile), "runtime-state.json");
    if (existsSync(runtimeStateFile)) {
      const parsed = JSON.parse(readFileSync(runtimeStateFile, "utf8")) as Record<string, unknown>;
      if (Array.isArray(parsed.pendingExchanges)) {
        pendingExchanges = parsed.pendingExchanges.filter(
          (value): value is Record<string, unknown> =>
            typeof value === "object" && value !== null && !Array.isArray(value),
        );
      }
      const rawParallel =
        typeof parsed.parallelStageState === "object" &&
        parsed.parallelStageState !== null &&
        !Array.isArray(parsed.parallelStageState)
          ? (parsed.parallelStageState as Record<string, unknown>)
          : null;
      if (rawParallel !== null) {
        parallelStageState = Object.fromEntries(
          Object.entries(rawParallel).flatMap(([key, value]) =>
            typeof value === "object" && value !== null && !Array.isArray(value)
              ? [[key, value as Record<string, unknown>]]
              : [],
          ),
        );
      }
      if (
        typeof parsed.agentStats === "object" &&
        parsed.agentStats !== null &&
        !Array.isArray(parsed.agentStats)
      ) {
        for (const [agentName, raw] of Object.entries(parsed.agentStats)) {
          if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
            continue;
          }
          const stats = raw as Record<string, unknown>;
          const merged = agentStats[agentName] ?? emptyAgentStats();
          merged.calls = typeof stats.calls === "number" ? stats.calls : merged.calls;
          merged.elapsedS = typeof stats.elapsedS === "number" ? stats.elapsedS : merged.elapsedS;
          merged.errors = typeof stats.errors === "number" ? stats.errors : merged.errors;
          merged.inputTokens =
            typeof stats.inputTokens === "number" ? stats.inputTokens : merged.inputTokens;
          merged.outputTokens =
            typeof stats.outputTokens === "number" ? stats.outputTokens : merged.outputTokens;
          if (typeof stats.costBucket === "string") {
            merged.costBucket = stats.costBucket;
          }
          for (const conversationLog of stringList(stats.conversationLogs)) {
            if (!merged.conversationLogs.includes(conversationLog)) {
              merged.conversationLogs.push(conversationLog);
            }
            conversationArtifacts.add(conversationLog);
          }
          agentStats[agentName] = merged;
        }
      }
    }
  } catch {
    pendingExchanges = [];
    parallelStageState = {};
  }

  if (cliArgs === null) {
    return null;
  }

  const goal = stringField(runStart, "goal") ?? stringField(cliArgs, "goal_text") ?? "";

  if (goal.length === 0) {
    return null;
  }

  const aggregated = Object.values(agentStats).reduce(
    (accumulator, stats) => {
      accumulator.calls += stats.calls;
      accumulator.elapsedS += stats.elapsedS;
      accumulator.errors += stats.errors;
      accumulator.inputTokens += stats.inputTokens;
      accumulator.outputTokens += stats.outputTokens;
      return accumulator;
    },
    { calls: 0, elapsedS: 0, errors: 0, inputTokens: 0, outputTokens: 0 },
  );

  return {
    agentStats,
    agentSessionIds,
    completedCycles,
    completedStages,
    conversationArtifacts: [...conversationArtifacts],
    currentStageCycles,
    errorCount: aggregated.errors,
    finished,
    goal,
    hasStages,
    inputTokens: aggregated.inputTokens,
    isDebug,
    lastSummary,
    logFile,
    maxCycles: numberField(runStart, "max_cycles") ?? numberField(cliArgs, "max_cycles") ?? 0,
    maxExchanges:
      numberField(runStart, "max_exchanges") ?? numberField(cliArgs, "max_exchanges") ?? 0,
    model:
      stringField(runStart, "model") ?? stringField(cliArgs, "orchestrator_model") ?? "unknown",
    orchestratorCostBucket,
    orchestrator:
      stringField(runStart, "orchestrator") ?? stringField(cliArgs, "orchestrator") ?? "unknown",
    outputTokens: aggregated.outputTokens,
    pendingExchanges,
    parallelStageState,
    projectDir: stringField(runStart, "project_dir") ?? stringField(cliArgs, "project_dir") ?? "",
    runId: extractRunId(logFile),
    stageSummaries,
    team: Array.isArray(runStart?.team)
      ? runStart.team.filter((value): value is string => typeof value === "string")
      : [],
    teamPreset: stringField(cliArgs, "team") ?? stringField(cliArgs, "mode") ?? "full",
    totalAgentCalls: aggregated.calls,
    totalElapsedS: Number(aggregated.elapsedS.toFixed(3)),
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
