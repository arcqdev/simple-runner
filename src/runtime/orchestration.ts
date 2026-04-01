import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";

import type { MainFlags } from "../cli/types.js";
import type { ResolvedGoal, ResolvedRuntimeParams } from "../cli/runtime.js";
import {
  buildRuntimeTeamConfig,
  type TeamAgentConfig,
  type TeamConfig,
  getTeamByName,
  loadTeamConfigFile,
  TEAM_BACKEND_MAP,
} from "../config/team-config.js";
import { resolveApiModel } from "../config/models.js";
import { emit as emitLogEvent, type RunDir } from "../logging/log.js";
import { availableBackends, commandOnPath } from "./backends.js";
import {
  cleanupStaleWorktrees,
  commitWorktreeChanges,
  createWorktree,
  deleteWorktreeBranch,
  mergeWorktreeBranch,
  removeWorktree,
  removeWorktreeKeepBranch,
  type WorktreeHandle,
} from "./git-worktree.js";
import {
  createSessionForOrchestrator,
  createSessionForTeamAgent,
  querySessionsInParallel,
  type Session,
  type SessionQueryResult,
} from "./sessions.js";
import { AsyncSummarizer } from "./summarizer.js";
import { readRunStatus, writeRunStatus } from "./run-status.js";

// Orchestration currently persists one opaque sessionId per agent and assumes
// synchronous prompt/response queries. The ACP contract in
// src/runtime/acp-contract.ts expands that into transport capabilities,
// streaming events, and resumable conversation locators that later specs
// should adapt back into this runtime state.
type VerificationGroups = {
  browserTesterNames: string[];
  reviewerNames: string[];
  testerNames: string[];
};

type RuntimeState = {
  agentSessionIds: Record<string, string>;
  agentStats: Record<string, AgentRunStats>;
  completedCycles: number;
  completedStages: number[];
  currentStageCycles: number;
  finished: boolean;
  lastSummary: string;
  parallelStageState: Record<string, PendingExchangeState>;
  pendingExchanges: PendingExchangeState[];
  stageSummaries: string[];
};

type AgentRunStats = {
  calls: number;
  conversationLogs: string[];
  costBucket: string;
  elapsedS: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
};

type PendingExchangeState = {
  acceptanceCriteria?: string;
  agentName: string;
  browserTesting?: boolean;
  cycleIndex: number;
  directiveTerminal?: ParsedDirective["terminal"];
  goalText?: string;
  priorSummary: string;
  projectDir?: string;
  responseIsError?: boolean;
  responseText?: string;
  scope: "parallel" | "single";
  sessionId: string | null;
  stageIndex?: number;
  summary?: string;
  verificationMode?: VerificationMode;
};

type GoalStage = {
  acceptance_criteria?: string;
  browser_testing?: boolean;
  description: string;
  index: number;
  name: string;
  parallel_group?: number | null;
  persist_changes?: boolean;
  verification?: VerificationMode;
};

type GoalPlan = {
  context: string;
  stages: GoalStage[];
};

type RuntimeAgent = {
  config: TeamAgentConfig;
  name: string;
  session: Session;
};

type AgentCollection = {
  allAgents: RuntimeAgent[];
  browserReviewerAgents: RuntimeAgent[];
  standardReviewerAgents: RuntimeAgent[];
  reviewerAgents: RuntimeAgent[];
  workerAgents: RuntimeAgent[];
};

type ParsedDirective = {
  explicit: boolean;
  summary: string;
  terminal: "end_cycle" | "goal_done" | "raise_issue";
};

type DoneSignal = ParsedDirective & {
  source: "implicit" | "json" | "marker";
};

type QuickCheck = {
  description: string;
  error_message: string;
  path: string;
};

type VerificationMode = "full" | "skip" | QuickCheck[];

type VerificationState = {
  doneAttempt: number;
};

type WorkerCycleOutcome = {
  directive: ParsedDirective;
  response: SessionQueryResult;
  summary: string;
};

type AdvisorDecision =
  | {
      action: "done";
      reasoning: string;
      summary: string;
    }
  | {
      action: "run_group";
      group: GoalStage[];
      reasoning: string;
    };

type FollowUpStageSpec = {
  acceptanceCriteria?: string;
  description: string;
  key: string;
  name: string;
  requiresMissingPath?: string;
};

type JsonRequest = {
  body?: string;
  headers?: Record<string, string>;
  method: string;
  timeoutMs?: number;
  url: string;
};

type JsonResponse = {
  ok: boolean;
  status: number;
  text: string;
};

type ApiAdvisorDeps = {
  env?: NodeJS.ProcessEnv;
  requestJson?: (request: JsonRequest, env: NodeJS.ProcessEnv) => JsonResponse;
};

type PiAdvisorDeps = {
  env?: NodeJS.ProcessEnv;
  runPi?: (
    prompt: string,
    model: string,
    env: NodeJS.ProcessEnv,
  ) => { exitCode: number; stderr: string; stdout: string; toolOutput: string | null };
};

type StageAdvisor = {
  assess: (
    goal: string,
    completedSummaries: string[],
    completedStages: number[],
    projectDir: string,
  ) => AdvisorDecision;
};

type ParallelStageRuntime = {
  cyclesUsed: number;
  finished: boolean;
  goalText: string;
  persistReady: boolean;
  priorSummary: string;
  sessionId: string | null;
  stage: GoalStage;
  summary: string;
  worker: RuntimeAgent;
};

export type OrchestrationArtifacts = {
  reportPath: string | null;
  reportTitle: string | null;
};

export type OrchestrationResult = {
  cyclesCompleted: number;
  finished: boolean;
  message: string;
  summary: string;
};

type GitResult = {
  committed: boolean;
  message?: string;
  skippedReason?: string;
};

export type RuntimeOrchestrator =
  | ApiRuntimeOrchestrator
  | ClaudeCodeRuntimeOrchestrator
  | CodexCliRuntimeOrchestrator
  | CursorCliRuntimeOrchestrator
  | GeminiCliRuntimeOrchestrator
  | PiRuntimeOrchestrator
  | OpencodeRuntimeOrchestrator;

const GIT_AUTHOR_ENV = {
  GIT_AUTHOR_EMAIL: "noreply@github.com",
  GIT_AUTHOR_NAME: "simple-runner",
  GIT_COMMITTER_EMAIL: "noreply@github.com",
  GIT_COMMITTER_NAME: "simple-runner",
};

const SIGNAL = "(?:ALL CHECKS PASS|MINOR ISSUES FIXED)";
const RE_FENCED_CODE = /```.*?```/gsu;
const RE_INLINE_CODE = /`[^`]+`/gu;
const RE_SINGLE_QUOTED = new RegExp(`'[^']*${SIGNAL}[^']*'`, "gu");
const RE_DOUBLE_QUOTED = new RegExp(`"[^"]*${SIGNAL}[^"]*"`, "gu");
const RE_SIGNAL = new RegExp(SIGNAL, "u");
const RE_SIGNAL_AUTHORITATIVE = new RegExp(
  String.raw`(?:^|(?<=\.)|(?<=!)|(?<=\?)|(?<=\u3002))\s*(?:[*_]{1,3})?${SIGNAL}(?::|\b)`,
  "mu",
);

function fallbackWorkerBackend(orchestrator: string): TeamAgentConfig["backend"] {
  switch (orchestrator) {
    case "opencode":
      return "opencode";
    case "codex":
      return "codex";
    case "cursor":
      return "cursor";
    case "gemini-cli":
      return "gemini-cli";
    default:
      return "claude";
  }
}

function orchestratorCostBucket(orchestrator: string): string {
  switch (orchestrator) {
    case "api":
      return "api";
    case "claude-code":
      return "claude_subscription";
    case "codex":
      return "codex_subscription";
    case "cursor":
      return "cursor_subscription";
    case "gemini-cli":
      return "gemini_api";
    case "opencode":
      return "gemini_api";
    default:
      return "unknown";
  }
}

function chooseWorkerForGoal(
  workerAgents: RuntimeAgent[],
  cycleIndex: number,
  goalText: string,
  acceptCriteria?: string,
): RuntimeAgent {
  const combined = `${goalText}\n${acceptCriteria ?? ""}`.toLowerCase();
  const frontendSignals = [
    "expo",
    "ui",
    "layout",
    "screen",
    "component",
    "components/ui",
    "style",
    "visual",
    "frontend",
  ];
  const backendSignals = [
    "backend",
    "api",
    "hono",
    "drizzle",
    "repository",
    "db",
    "database",
    "contract",
    "server",
    "worker",
  ];
  const hasSignal = (signals: string[]): boolean => signals.some((signal) => combined.includes(signal));
  const frontendWorker = workerAgents.find((agent) => agent.name === "frontend_worker");
  const backendWorker = workerAgents.find((agent) => agent.name === "backend_worker");

  if (frontendWorker !== undefined && hasSignal(frontendSignals)) {
    return frontendWorker;
  }

  if (backendWorker !== undefined && hasSignal(backendSignals)) {
    return backendWorker;
  }

  return workerAgents[(cycleIndex - 1) % workerAgents.length] ?? workerAgents[0]!;
}

function runtimeStatePath(runDir: RunDir): string {
  return path.join(runDir.root, "runtime-state.json");
}

function defaultState(): RuntimeState {
  return {
    agentSessionIds: {},
    agentStats: {},
    completedCycles: 0,
    completedStages: [],
    currentStageCycles: 0,
    finished: false,
    lastSummary: "",
    parallelStageState: {},
    pendingExchanges: [],
    stageSummaries: [],
  };
}

function loadRuntimeState(runDir: RunDir): RuntimeState {
  const filePath = runtimeStatePath(runDir);
  if (!existsSync(filePath)) {
    return defaultState();
  }
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Partial<RuntimeState>;
    return {
      agentSessionIds: parsed.agentSessionIds ?? {},
      agentStats:
        typeof parsed.agentStats === "object" &&
        parsed.agentStats !== null &&
        !Array.isArray(parsed.agentStats)
          ? (parsed.agentStats as Record<string, AgentRunStats>)
          : {},
      completedCycles: parsed.completedCycles ?? 0,
      completedStages: parsed.completedStages ?? [],
      currentStageCycles: parsed.currentStageCycles ?? 0,
      finished: parsed.finished ?? false,
      lastSummary: parsed.lastSummary ?? "",
      parallelStageState:
        typeof parsed.parallelStageState === "object" &&
        parsed.parallelStageState !== null &&
        !Array.isArray(parsed.parallelStageState)
          ? (parsed.parallelStageState as Record<string, PendingExchangeState>)
          : {},
      pendingExchanges: Array.isArray(parsed.pendingExchanges)
        ? parsed.pendingExchanges.filter(
            (value): value is PendingExchangeState =>
              typeof value === "object" && value !== null && !Array.isArray(value),
          )
        : [],
      stageSummaries: parsed.stageSummaries ?? [],
    };
  } catch {
    return defaultState();
  }
}

function emptyAgentRunStats(costBucket = ""): AgentRunStats {
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

function updateAgentStats(
  state: RuntimeState,
  agentName: string,
  response: SessionQueryResult,
  session: Session,
): void {
  const stats = state.agentStats[agentName] ?? emptyAgentRunStats(session.costBucket);
  stats.calls += 1;
  stats.elapsedS += response.elapsedS;
  stats.errors += response.isError ? 1 : 0;
  stats.inputTokens += response.inputTokens ?? 0;
  stats.outputTokens += response.outputTokens ?? 0;
  if (response.conversationLog) {
    stats.conversationLogs.push(response.conversationLog);
  }
  if (session.costBucket.length > 0) {
    stats.costBucket = session.costBucket;
  }
  state.agentStats[agentName] = stats;
}

function persistRuntimeState(runDir: RunDir, state: RuntimeState): void {
  const filePath = runtimeStatePath(runDir);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  emitLogEvent("persist_run_state", {
    config_file: runDir.configFile,
    goal_file: runDir.goalFile,
    run_dir: runDir.root,
    state_file: filePath,
  });
}

function persistPendingExchange(
  runDir: RunDir,
  state: RuntimeState,
  exchange: PendingExchangeState,
): void {
  if (exchange.scope === "parallel" && exchange.stageIndex !== undefined) {
    state.parallelStageState[String(exchange.stageIndex)] = exchange;
  }
  const existingIndex = state.pendingExchanges.findIndex(
    (candidate) =>
      candidate.scope === exchange.scope &&
      candidate.agentName === exchange.agentName &&
      candidate.stageIndex === exchange.stageIndex,
  );
  if (existingIndex === -1) {
    state.pendingExchanges.push(exchange);
  } else {
    state.pendingExchanges[existingIndex] = exchange;
  }
  persistRuntimeState(runDir, state);
}

function clearPendingExchange(
  runDir: RunDir,
  state: RuntimeState,
  scope: PendingExchangeState["scope"],
  agentName: string,
  stageIndex?: number,
): void {
  state.pendingExchanges = state.pendingExchanges.filter(
    (candidate) =>
      !(
        candidate.scope === scope &&
        candidate.agentName === agentName &&
        candidate.stageIndex === stageIndex
      ),
  );
  if (scope === "parallel" && stageIndex !== undefined) {
    delete state.parallelStageState[String(stageIndex)];
  }
  persistRuntimeState(runDir, state);
}

function pendingExchangeForSingle(
  state: RuntimeState,
  cycleIndex: number,
  goalText: string,
): PendingExchangeState | null {
  return (
    state.pendingExchanges.find(
      (candidate) =>
        candidate.scope === "single" &&
        candidate.cycleIndex === cycleIndex &&
        candidate.goalText === goalText,
    ) ?? null
  );
}

function pendingExchangeOutcome(exchange: PendingExchangeState): WorkerCycleOutcome | null {
  if (exchange.responseText === undefined) {
    return null;
  }
  const response: SessionQueryResult = {
    elapsedS: 0,
    isError: exchange.responseIsError === true,
    text: exchange.responseText,
  };
  return {
    directive: {
      explicit: true,
      summary: exchange.summary ?? cycleSummary(exchange.responseText),
      terminal: exchange.directiveTerminal ?? "end_cycle",
    },
    response,
    summary: exchange.summary ?? cycleSummary(exchange.responseText),
  };
}

function expectedArtifacts(runDir: RunDir, goal: ResolvedGoal): OrchestrationArtifacts {
  if (goal.source === "improve") {
    return {
      reportPath: path.join(runDir.root, "improve-report.md"),
      reportTitle: "Improve Report",
    };
  }
  if (goal.source === "test" || goal.source === "fix-from") {
    return {
      reportPath: path.join(runDir.root, "test-report.md"),
      reportTitle: "Test Report",
    };
  }
  return { reportPath: null, reportTitle: null };
}

function loadGoalPlan(runDir: RunDir): GoalPlan | null {
  if (!existsSync(runDir.goalPlanFile)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(runDir.goalPlanFile, "utf8")) as Partial<GoalPlan>;
    if (
      typeof parsed.context !== "string" ||
      !Array.isArray(parsed.stages) ||
      !parsed.stages.every(
        (stage) =>
          typeof stage === "object" &&
          stage !== null &&
          typeof (stage as GoalStage).index === "number" &&
          typeof (stage as GoalStage).name === "string" &&
          typeof (stage as GoalStage).description === "string",
      )
    ) {
      return null;
    }
    return parsed as GoalPlan;
  } catch {
    return null;
  }
}

function executionGroups(stages: GoalStage[]): GoalStage[][] {
  const groups: GoalStage[][] = [];
  const active = new Map<number, GoalStage[]>();

  for (const stage of stages) {
    if (stage.parallel_group == null) {
      groups.push([stage]);
      continue;
    }
    const existing = active.get(stage.parallel_group);
    if (existing !== undefined) {
      existing.push(stage);
      continue;
    }
    const bucket = [stage];
    active.set(stage.parallel_group, bucket);
    groups.push(bucket);
  }

  return groups;
}

function sanitizePathCandidate(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes("\0") || path.isAbsolute(trimmed)) {
    return null;
  }
  const normalized = path.normalize(trimmed);
  if (normalized.startsWith("..")) {
    return null;
  }
  return normalized;
}

function parseFollowUpSpec(summary: string): FollowUpStageSpec | null {
  const lines = summary.split(/\r?\n/gu);
  for (const line of lines) {
    const trimmed = line.trim();
    const missingMarker = "FOLLOW_UP_STAGE_IF_MISSING:";
    const followUpMarker = "FOLLOW_UP_STAGE:";
    const missingIndex = trimmed.indexOf(missingMarker);
    if (missingIndex !== -1) {
      const raw = trimmed.slice(missingIndex + missingMarker.length).trim();
      const parts = raw.split("||").map((part) => part.trim());
      if (parts.length >= 4) {
        const requiresMissingPath = sanitizePathCandidate(parts[0] ?? "");
        const name = parts[1] ?? "";
        const description = parts[2] ?? "";
        const acceptanceCriteria = parts[3] ?? "";
        if (requiresMissingPath !== null && name.length > 0 && description.length > 0) {
          return {
            acceptanceCriteria,
            description,
            key: `missing:${requiresMissingPath}:${name.toLowerCase()}`,
            name,
            requiresMissingPath,
          };
        }
      }
    }
    const followUpIndex = trimmed.indexOf(followUpMarker);
    if (followUpIndex !== -1) {
      const raw = trimmed.slice(followUpIndex + followUpMarker.length).trim();
      const parts = raw.split("||").map((part) => part.trim());
      if (parts.length >= 2) {
        return {
          acceptanceCriteria: parts[2] ?? "",
          description: parts[1] ?? "",
          key: `follow-up:${(parts[0] ?? "").toLowerCase()}:${(parts[1] ?? "").toLowerCase()}`,
          name: parts[0] ?? "",
        };
      }
    }
  }
  return null;
}

function probeGeminiApiKey(env: NodeJS.ProcessEnv): string | null {
  const geminiKey = env.GEMINI_API_KEY?.trim();
  if (geminiKey) {
    return geminiKey;
  }
  const googleKey = env.GOOGLE_API_KEY?.trim();
  return googleKey && googleKey.length > 0 ? googleKey : null;
}

function defaultRequestJson(request: JsonRequest, env: NodeJS.ProcessEnv): JsonResponse {
  const script = `
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    try {
      const response = await fetch(payload.url, {
        method: payload.method,
        headers: payload.headers,
        body: payload.body,
        signal: AbortSignal.timeout(payload.timeoutMs ?? 30000),
      });
      const text = await response.text();
      process.stdout.write(JSON.stringify({ ok: response.ok, status: response.status, text }));
    } catch (error) {
      process.stderr.write(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exit(1);
    }
  `;

  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    env: { ...env },
    input: JSON.stringify(request),
    timeout: request.timeoutMs ?? 30000,
  });

  if (child.status !== 0) {
    throw new Error((child.stderr || child.stdout || "request failed").trim());
  }

  return JSON.parse(child.stdout.trim()) as JsonResponse;
}

function normalizeStageIndexes(value: unknown): number[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is number => typeof entry === "number" && Number.isInteger(entry))
        .map((entry) => entry)
    : [];
}

function candidateGroupsForAdvisor(
  plan: GoalPlan,
  completedSummaries: string[],
  completedStages: number[],
  projectDir: string,
  seenFollowUps: Set<string>,
  followUpQueue: FollowUpStageSpec[],
  nextDynamicIndex: { current: number },
): GoalStage[][] {
  const pendingBaseGroups = executionGroups(
    plan.stages.filter((stage) => !completedStages.includes(stage.index)),
  );

  for (const summary of completedSummaries) {
    const followUp = parseFollowUpSpec(summary);
    if (followUp === null || seenFollowUps.has(followUp.key)) {
      continue;
    }
    if (followUp.requiresMissingPath !== undefined) {
      const filePath = path.join(projectDir, followUp.requiresMissingPath);
      if (existsSync(filePath)) {
        seenFollowUps.add(followUp.key);
        continue;
      }
    }
    seenFollowUps.add(followUp.key);
    followUpQueue.push(followUp);
  }

  const nextFollowUp = followUpQueue[0];
  if (nextFollowUp !== undefined) {
    const stage: GoalStage = {
      acceptance_criteria: nextFollowUp.acceptanceCriteria,
      description: nextFollowUp.description,
      index: nextDynamicIndex.current,
      name: nextFollowUp.name,
    };
    return [...pendingBaseGroups, [stage]];
  }

  return pendingBaseGroups;
}

function buildApiAdvisorPrompt(
  goal: string,
  completedSummaries: string[],
  candidateGroups: GoalStage[][],
): string {
  const lines = [
    "You are the orchestration controller for a coding run.",
    "You have exactly one tool: implement_goal.",
    "Call implement_goal with the stageIndexes for exactly one candidate group to run next.",
    "If the goal is already complete and no more work should run, reply with plain text starting with ADVISOR_DONE: followed by a short summary.",
    "Do not invent stage indexes. Only use the provided candidate groups.",
    "",
    `Goal: ${goal}`,
    "",
    "Completed stage summaries:",
    completedSummaries.length === 0 ? "- none" : completedSummaries.map((summary, index) => `- ${index + 1}: ${summary}`).join("\n"),
    "",
    "Candidate groups:",
    ...candidateGroups.map((group, index) => {
      const stages = group
        .map(
          (stage) =>
            `stage ${stage.index}: ${stage.name}${stage.acceptance_criteria ? ` [acceptance: ${stage.acceptance_criteria}]` : ""}`,
        )
        .join(" | ");
      return `- group ${index + 1}: ${stages}`;
    }),
  ];

  return lines.join("\n");
}

function repoRootFromRuntime(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

function resolvePiInvocation():
  | {
      args: string[];
      command: string;
    }
  | null {
  if (commandOnPath("pi")) {
    return { args: [], command: "pi" };
  }

  const piMonoRoot = path.join(repoRootFromRuntime(), "pi-mono");
  const tsxPath = path.join(piMonoRoot, "node_modules", ".bin", "tsx");
  const cliPath = path.join(piMonoRoot, "packages", "coding-agent", "src", "cli.ts");

  if (existsSync(tsxPath) && existsSync(cliPath)) {
    return { args: [cliPath], command: tsxPath };
  }

  return null;
}

function writePiImplementGoalExtension(tempDir: string): string {
  const filePath = path.join(tempDir, "simple-runner-pi-implement-goal.mjs");
  writeFileSync(
    filePath,
    [
      'import { writeFileSync } from "node:fs";',
      'import { Type } from "@mariozechner/pi-ai";',
      "",
      "export default function (pi) {",
      "  pi.registerTool({",
      '    name: "implement_goal",',
      '    label: "Implement Goal",',
      '    description: "Select the next candidate stage group to execute.",',
      "    parameters: Type.Object({",
      '      reasoning: Type.Optional(Type.String({ description: "Why this group should run next" })),',
      '      stageIndexes: Type.Array(Type.Number({ description: "Stage index" }), { description: "Stage indexes for the selected group" }),',
      "    }),",
      "    async execute(_toolCallId, params) {",
      '      const outputPath = process.env.SIMPLE_RUNNER_PI_TOOL_OUTPUT_PATH;',
      '      if (typeof outputPath === "string" && outputPath.length > 0) {',
      '        writeFileSync(outputPath, `${JSON.stringify(params, null, 2)}\\n`, "utf8");',
      "      }",
      "      return {",
      '        content: [{ type: "text", text: `Selected stages: ${JSON.stringify(params.stageIndexes ?? [])}` }],',
      "        details: params,",
      "      };",
      "    },",
      "  });",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  return filePath;
}

function runPiAdvisorPrompt(
  prompt: string,
  model: string,
  env: NodeJS.ProcessEnv,
): { exitCode: number; stderr: string; stdout: string; toolOutput: string | null } {
  const invocation = resolvePiInvocation();

  if (invocation === null) {
    return {
      exitCode: 1,
      stderr: "pi orchestrator unavailable: install pi or keep ../pi-mono checked out with dependencies",
      stdout: "",
      toolOutput: null,
    };
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "simple-runner-pi-"));

  try {
    const outputPath = path.join(tempDir, "implement-goal.json");
    const extensionPath = writePiImplementGoalExtension(tempDir);
    const result = spawnSync(
      invocation.command,
      [
        ...invocation.args,
        "--print",
        "--no-session",
        "--no-tools",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-extensions",
        "--extension",
        extensionPath,
        "--model",
        model,
        prompt,
      ],
      {
        cwd: repoRootFromRuntime(),
        encoding: "utf8",
        env: {
          ...env,
          SIMPLE_RUNNER_PI_TOOL_OUTPUT_PATH: outputPath,
        },
      },
    );

    const toolOutput = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : null;

    return {
      exitCode: result.status ?? 1,
      stderr: result.stderr ?? "",
      stdout: result.stdout ?? "",
      toolOutput,
    };
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

export class ApiToolStageAdvisor implements StageAdvisor {
  readonly #basePlan: GoalPlan;
  readonly #deps: Required<ApiAdvisorDeps>;
  readonly #model: string;
  readonly #followUpQueue: FollowUpStageSpec[] = [];
  readonly #seenFollowUps = new Set<string>();
  #nextDynamicIndex: number;

  constructor(plan: GoalPlan, model: string, deps: ApiAdvisorDeps = {}) {
    this.#basePlan = plan;
    this.#model = model;
    this.#nextDynamicIndex = plan.stages.length + 1;
    this.#deps = {
      env: deps.env ?? process.env,
      requestJson: deps.requestJson ?? defaultRequestJson,
    };
  }

  assess(
    goal: string,
    completedSummaries: string[],
    completedStages: number[],
    projectDir: string,
  ): AdvisorDecision {
    emitLogEvent("advisor_assess_start", {
      completed_stages: completedStages.length,
      planned_stages: this.#basePlan.stages.length,
    });

    const latestSummary = completedSummaries.at(-1)?.trim() ?? "";
    if (/^ADVISOR_DONE:/imu.test(latestSummary)) {
      const summary = latestSummary.replace(/^ADVISOR_DONE:\s*/imu, "").trim() || goal;
      emitLogEvent("advisor_assess_end", {
        action: "done",
        reasoning: "Completed summaries indicate the goal is already complete.",
      });
      return {
        action: "done",
        reasoning: "Completed summaries indicate the goal is already complete.",
        summary,
      };
    }

    const nextDynamicIndex = { current: this.#nextDynamicIndex };
    const candidateGroups = candidateGroupsForAdvisor(
      this.#basePlan,
      completedSummaries,
      completedStages,
      projectDir,
      this.#seenFollowUps,
      this.#followUpQueue,
      nextDynamicIndex,
    );

    if (candidateGroups.length === 0) {
      emitLogEvent("advisor_assess_end", {
        action: "done",
        reasoning: "No remaining planned stages or discovered follow-up work.",
      });
      return {
        action: "done",
        reasoning: "No remaining planned stages or discovered follow-up work.",
        summary: latestSummary || `Completed adaptive execution for: ${goal}`,
      };
    }

    const resolved = resolveApiModel(this.#model);
    const apiKey =
      resolved?.providerName === "Google" ? probeGeminiApiKey(this.#deps.env) : null;

    if (resolved === null || resolved.providerName !== "Google" || apiKey === null) {
      const group = candidateGroups[0] ?? [];
      emitLogEvent("advisor_assess_end", {
        action: "run_group",
        reasoning: "API advisor unavailable; using the next candidate group.",
        stages: group.map((stage) => stage.index),
      });
      return {
        action: "run_group",
        group,
        reasoning: "API advisor unavailable; using the next candidate group.",
      };
    }

    try {
      const response = this.#deps.requestJson(
        {
          body: JSON.stringify({
            contents: [{ parts: [{ text: buildApiAdvisorPrompt(goal, completedSummaries, candidateGroups) }] }],
            generationConfig: { temperature: 0 },
            tools: [
              {
                functionDeclarations: [
                  {
                    description: "Select the next candidate stage group to execute.",
                    name: "implement_goal",
                    parameters: {
                      properties: {
                        reasoning: { type: "STRING" },
                        stageIndexes: {
                          items: { type: "INTEGER" },
                          type: "ARRAY",
                        },
                      },
                      required: ["stageIndexes"],
                      type: "OBJECT",
                    },
                  },
                ],
              },
            ],
          }),
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          method: "POST",
          timeoutMs: 30000,
          url: `https://generativelanguage.googleapis.com/v1beta/models/${resolved.fullModelId}:generateContent`,
        },
        this.#deps.env,
      );

      if (!response.ok) {
        throw new Error(`gemini api advisor returned HTTP ${response.status}`);
      }

      const payload = JSON.parse(response.text) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{
              functionCall?: {
                args?: Record<string, unknown>;
                name?: unknown;
              };
              text?: unknown;
            }>;
          };
        }>;
      };

      const parts = payload.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        const text = typeof part.text === "string" ? part.text.trim() : "";
        if (text.startsWith("ADVISOR_DONE:")) {
          const summary = text.replace(/^ADVISOR_DONE:\s*/u, "").trim() || goal;
          emitLogEvent("advisor_assess_end", {
            action: "done",
            reasoning: "API advisor marked the goal complete.",
          });
          return {
            action: "done",
            reasoning: "API advisor marked the goal complete.",
            summary,
          };
        }

        const call = part.functionCall;
        if (call?.name !== "implement_goal") {
          continue;
        }
        const stageIndexes = normalizeStageIndexes(call.args?.stageIndexes);
        const selected =
          candidateGroups.find((group) => {
            const indexes = group.map((stage) => stage.index);
            return (
              indexes.length === stageIndexes.length &&
              indexes.every((index) => stageIndexes.includes(index))
            );
          }) ?? null;

        if (selected !== null) {
          const queuedFollowUp = this.#followUpQueue[0];
          if (
            queuedFollowUp !== undefined &&
            selected.length === 1 &&
            selected[0]?.index === this.#nextDynamicIndex
          ) {
            this.#followUpQueue.shift();
            this.#nextDynamicIndex += 1;
          }
          emitLogEvent("advisor_assess_end", {
            action: "run_group",
            reasoning: "API advisor selected the next stage group.",
            stages: selected.map((stage) => stage.index),
          });
          return {
            action: "run_group",
            group: selected,
            reasoning: "API advisor selected the next stage group.",
          };
        }
      }
    } catch (error) {
      emitLogEvent("orchestrator_fallback", {
        orchestrator: "api",
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    const group = candidateGroups[0] ?? [];
    if (
      this.#followUpQueue[0] !== undefined &&
      group.length === 1 &&
      group[0]?.index === this.#nextDynamicIndex
    ) {
      this.#followUpQueue.shift();
      this.#nextDynamicIndex += 1;
    }
    emitLogEvent("advisor_assess_end", {
      action: "run_group",
      reasoning: "API advisor fallback selected the next candidate group.",
      stages: group.map((stage) => stage.index),
    });
    return {
      action: "run_group",
      group,
      reasoning: "API advisor fallback selected the next candidate group.",
    };
  }
}

export class PiToolStageAdvisor implements StageAdvisor {
  readonly #basePlan: GoalPlan;
  readonly #deps: Required<PiAdvisorDeps>;
  readonly #followUpQueue: FollowUpStageSpec[] = [];
  readonly #model: string;
  readonly #seenFollowUps = new Set<string>();
  #nextDynamicIndex: number;

  constructor(plan: GoalPlan, model: string, deps: PiAdvisorDeps = {}) {
    this.#basePlan = plan;
    this.#model = model;
    this.#nextDynamicIndex = plan.stages.length + 1;
    this.#deps = {
      env: deps.env ?? process.env,
      runPi: deps.runPi ?? runPiAdvisorPrompt,
    };
  }

  assess(
    goal: string,
    completedSummaries: string[],
    completedStages: number[],
    projectDir: string,
  ): AdvisorDecision {
    emitLogEvent("advisor_assess_start", {
      completed_stages: completedStages.length,
      planned_stages: this.#basePlan.stages.length,
    });

    const latestSummary = completedSummaries.at(-1)?.trim() ?? "";
    if (/^ADVISOR_DONE:/imu.test(latestSummary)) {
      const summary = latestSummary.replace(/^ADVISOR_DONE:\s*/imu, "").trim() || goal;
      emitLogEvent("advisor_assess_end", {
        action: "done",
        reasoning: "Completed summaries indicate the goal is already complete.",
      });
      return {
        action: "done",
        reasoning: "Completed summaries indicate the goal is already complete.",
        summary,
      };
    }

    const nextDynamicIndex = { current: this.#nextDynamicIndex };
    const candidateGroups = candidateGroupsForAdvisor(
      this.#basePlan,
      completedSummaries,
      completedStages,
      projectDir,
      this.#seenFollowUps,
      this.#followUpQueue,
      nextDynamicIndex,
    );

    if (candidateGroups.length === 0) {
      emitLogEvent("advisor_assess_end", {
        action: "done",
        reasoning: "No remaining planned stages or discovered follow-up work.",
      });
      return {
        action: "done",
        reasoning: "No remaining planned stages or discovered follow-up work.",
        summary: latestSummary || `Completed adaptive execution for: ${goal}`,
      };
    }

    try {
      const result = this.#deps.runPi(
        buildApiAdvisorPrompt(goal, completedSummaries, candidateGroups),
        this.#model,
        this.#deps.env,
      );

      if (result.exitCode === 0) {
        const text = result.stdout.trim();
        if (text.startsWith("ADVISOR_DONE:")) {
          const summary = text.replace(/^ADVISOR_DONE:\s*/u, "").trim() || goal;
          emitLogEvent("advisor_assess_end", {
            action: "done",
            reasoning: "PI advisor marked the goal complete.",
          });
          return {
            action: "done",
            reasoning: "PI advisor marked the goal complete.",
            summary,
          };
        }

        if (result.toolOutput !== null) {
          const parsed = JSON.parse(result.toolOutput) as { stageIndexes?: unknown };
          const stageIndexes = normalizeStageIndexes(parsed.stageIndexes);
          const selected =
            candidateGroups.find((group) => {
              const indexes = group.map((stage) => stage.index);
              return (
                indexes.length === stageIndexes.length &&
                indexes.every((index) => stageIndexes.includes(index))
              );
            }) ?? null;

          if (selected !== null) {
            const queuedFollowUp = this.#followUpQueue[0];
            if (
              queuedFollowUp !== undefined &&
              selected.length === 1 &&
              selected[0]?.index === this.#nextDynamicIndex
            ) {
              this.#followUpQueue.shift();
              this.#nextDynamicIndex += 1;
            }
            emitLogEvent("advisor_assess_end", {
              action: "run_group",
              reasoning: "PI advisor selected the next stage group.",
              stages: selected.map((stage) => stage.index),
            });
            return {
              action: "run_group",
              group: selected,
              reasoning: "PI advisor selected the next stage group.",
            };
          }
        }
      } else {
        throw new Error(result.stderr.trim() || result.stdout.trim() || "pi advisor failed");
      }
    } catch (error) {
      emitLogEvent("orchestrator_fallback", {
        orchestrator: "pi",
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    const group = candidateGroups[0] ?? [];
    if (
      this.#followUpQueue[0] !== undefined &&
      group.length === 1 &&
      group[0]?.index === this.#nextDynamicIndex
    ) {
      this.#followUpQueue.shift();
      this.#nextDynamicIndex += 1;
    }
    emitLogEvent("advisor_assess_end", {
      action: "run_group",
      reasoning: "PI advisor fallback selected the next candidate group.",
      stages: group.map((stage) => stage.index),
    });
    return {
      action: "run_group",
      group,
      reasoning: "PI advisor fallback selected the next candidate group.",
    };
  }
}

class LocalAdaptiveStageAdvisor {
  readonly #basePlan: GoalPlan;
  readonly #followUpQueue: FollowUpStageSpec[] = [];
  readonly #seenFollowUps = new Set<string>();
  #nextDynamicIndex: number;

  constructor(plan: GoalPlan) {
    this.#basePlan = plan;
    this.#nextDynamicIndex = plan.stages.length + 1;
  }

  assess(
    goal: string,
    completedSummaries: string[],
    completedStages: number[],
    projectDir: string,
  ): AdvisorDecision {
    emitLogEvent("advisor_assess_start", {
      completed_stages: completedStages.length,
      planned_stages: this.#basePlan.stages.length,
    });

    const pendingBaseGroups = executionGroups(
      this.#basePlan.stages.filter((stage) => !completedStages.includes(stage.index)),
    );
    const latestSummary = completedSummaries.at(-1)?.trim() ?? "";
    const advisorDone =
      /^ADVISOR_DONE:/imu.test(latestSummary) ||
      /\b(goal complete|fully complete|nothing remaining)\b/iu.test(latestSummary);

    if (advisorDone) {
      const summary =
        latestSummary.replace(/^ADVISOR_DONE:\s*/imu, "").trim() ||
        `Adaptive execution concluded goal complete: ${goal}`;
      emitLogEvent("advisor_assess_end", {
        action: "done",
        reasoning: "Completed summaries indicate the goal is already complete.",
      });
      return {
        action: "done",
        reasoning: "Completed summaries indicate the goal is already complete.",
        summary,
      };
    }

    if (pendingBaseGroups.length > 0) {
      emitLogEvent("advisor_assess_end", {
        action: "run_group",
        reasoning: "Continue with the next planned stage group.",
        stages: pendingBaseGroups[0].map((stage) => stage.index),
      });
      return {
        action: "run_group",
        group: pendingBaseGroups[0] ?? [],
        reasoning: "Continue with the next planned stage group.",
      };
    }

    for (const summary of completedSummaries) {
      const followUp = parseFollowUpSpec(summary);
      if (followUp === null || this.#seenFollowUps.has(followUp.key)) {
        continue;
      }
      if (followUp.requiresMissingPath !== undefined) {
        const filePath = path.join(projectDir, followUp.requiresMissingPath);
        if (existsSync(filePath)) {
          this.#seenFollowUps.add(followUp.key);
          continue;
        }
      }
      this.#seenFollowUps.add(followUp.key);
      this.#followUpQueue.push(followUp);
    }

    const nextFollowUp = this.#followUpQueue.shift();
    if (nextFollowUp !== undefined) {
      const stage: GoalStage = {
        acceptance_criteria: nextFollowUp.acceptanceCriteria,
        description: nextFollowUp.description,
        index: this.#nextDynamicIndex,
        name: nextFollowUp.name,
      };
      this.#nextDynamicIndex += 1;
      emitLogEvent("advisor_assess_end", {
        action: "run_group",
        reasoning: "Create a follow-up stage discovered during execution.",
        stage_name: stage.name,
      });
      return {
        action: "run_group",
        group: [stage],
        reasoning: "Create a follow-up stage discovered during execution.",
      };
    }

    emitLogEvent("advisor_assess_end", {
      action: "done",
      reasoning: "No remaining planned stages or discovered follow-up work.",
    });
    return {
      action: "done",
      reasoning: "No remaining planned stages or discovered follow-up work.",
      summary: latestSummary || `Completed adaptive execution for: ${goal}`,
    };
  }
}

function composeStageGoal(plan: GoalPlan, stage: GoalStage, completedSummaries: string[]): string {
  const parts = [`# Project Context\n${plan.context}`];
  if (completedSummaries.length > 0) {
    parts.push("# Completed Stages");
    for (const [index, summary] of completedSummaries.entries()) {
      parts.push(`## Stage ${index + 1}\n${summary}`);
    }
  }
  parts.push(
    `# Current Stage (${stage.index}/${plan.stages.length}): ${stage.name}\n${stage.description}`,
  );
  if (stage.acceptance_criteria) {
    parts.push(`## Acceptance Criteria\n${stage.acceptance_criteria}`);
  }
  return parts.join("\n\n");
}

function normalizeTerminal(value: string): ParsedDirective["terminal"] | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/gu, "_");
  if (normalized === "goal_done" || normalized === "done" || normalized === "complete") {
    return "goal_done";
  }
  if (normalized === "end_cycle" || normalized === "continue") {
    return "end_cycle";
  }
  if (normalized === "raise_issue" || normalized === "issue" || normalized === "fail") {
    return "raise_issue";
  }
  return null;
}

function recordField(
  value: Record<string, unknown> | null,
  keys: string[],
): string | boolean | Record<string, unknown> | null {
  if (value === null) {
    return null;
  }
  for (const key of keys) {
    if (!(key in value)) {
      continue;
    }
    const candidate = value[key];
    if (
      typeof candidate === "string" ||
      typeof candidate === "boolean" ||
      (typeof candidate === "object" && candidate !== null && !Array.isArray(candidate))
    ) {
      return candidate as string | boolean | Record<string, unknown>;
    }
  }
  return null;
}

function parseJsonDoneSignal(text: string): DoneSignal | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const root =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    const doneRootValue = recordField(root, ["done_signal", "doneSignal", "done"]);
    const doneRoot =
      typeof doneRootValue === "object" && doneRootValue !== null
        ? (doneRootValue as Record<string, unknown>)
        : root;
    if (doneRoot === null) {
      return null;
    }

    const terminalField = recordField(doneRoot, ["terminal", "status", "type"]);
    const summaryField = recordField(doneRoot, ["summary", "message", "result"]);
    const successField = recordField(doneRoot, ["success"]);
    const terminal =
      typeof terminalField === "string"
        ? normalizeTerminal(terminalField)
        : typeof successField === "boolean"
          ? successField
            ? "goal_done"
            : "raise_issue"
          : null;
    if (terminal === null) {
      return null;
    }

    const summary =
      typeof summaryField === "string" && summaryField.trim().length > 0
        ? summaryField.trim()
        : trimmed;
    return {
      explicit: true,
      source: "json",
      summary,
      terminal,
    };
  } catch {
    return null;
  }
}

export function parseDoneDirective(text: string): DoneSignal {
  const trimmed = text.trim();
  const jsonSignal = parseJsonDoneSignal(trimmed);
  if (jsonSignal !== null) {
    return jsonSignal;
  }
  const lines = trimmed.split(/\r?\n/gu).map((line) => line.trim());
  for (const line of lines) {
    if (line.startsWith("GOAL_DONE:")) {
      const summary = trimmed.replace(/^GOAL_DONE:\s*/u, "").trim();
      return {
        explicit: true,
        source: "marker",
        summary: summary.length > 0 ? summary : trimmed,
        terminal: "goal_done",
      };
    }
    if (line.startsWith("END_CYCLE:")) {
      const summary = trimmed.replace(/^END_CYCLE:\s*/u, "").trim();
      return {
        explicit: true,
        source: "marker",
        summary: summary.length > 0 ? summary : trimmed,
        terminal: "end_cycle",
      };
    }
    if (line.startsWith("RAISE_ISSUE:")) {
      const summary = trimmed.replace(/^RAISE_ISSUE:\s*/u, "").trim();
      return {
        explicit: true,
        source: "marker",
        summary: summary.length > 0 ? summary : trimmed,
        terminal: "raise_issue",
      };
    }
  }
  return {
    explicit: false,
    source: "implicit",
    summary: trimmed,
    terminal: "end_cycle",
  };
}

function buildWorkerPrompt(
  goal: string,
  projectDir: string,
  priorSummary: string,
  agent: RuntimeAgent,
  cycleIndex: number,
): string {
  const previous = priorSummary.length > 0 ? `\n\n# Previous Cycle Summary\n${priorSummary}` : "";
  const runStatus = readRunStatus(projectDir);
  const status = runStatus.length > 0 ? `\n\n${runStatus}` : "";
  return [
    `You are ${agent.name}.`,
    agent.config.description?.trim() || "Execute a concrete coding step in the repository.",
    "",
    `Cycle ${cycleIndex}. Work in the repository at ${projectDir}.`,
    "",
    "# Goal",
    goal,
    previous,
    status,
    "",
    "Rules:",
    "- Make concrete progress in the codebase.",
    "- If the goal is fully complete, include a line exactly like: GOAL_DONE: <short summary>",
    "- If you made useful progress but more work remains, include: END_CYCLE: <short summary>",
    "- If you are blocked and the run should stop, include: RAISE_ISSUE: <short summary>",
  ].join("\n");
}

function buildVerificationPrompt(
  goal: string,
  summary: string,
  acceptanceCriteria?: string,
  effort: ResolvedRuntimeParams["effort"] = "standard",
): string {
  const effortSupplement =
    effort === "high"
      ? ["", "Effort level is HIGH. Be thorough: verify each criterion with real evidence."]
      : effort === "max"
        ? [
            "",
            "Effort level is MAX. Challenge assumptions aggressively and demand strong evidence before accepting completion.",
          ]
        : [];

  return [
    "The orchestrator claims the following goal is complete:",
    "",
    "# Goal",
    goal,
    "",
    "# Orchestrator's summary",
    summary,
    "",
    "Verify the repository state honestly.",
    ...(acceptanceCriteria
      ? [
          "Check every acceptance criterion with concrete evidence from the repository or runtime behavior.",
          "For each criterion, determine PASS or FAIL before giving the final verdict.",
          "",
          "## Acceptance Criteria",
          acceptanceCriteria,
          "",
          "Do NOT say ALL CHECKS PASS unless every criterion passes.",
        ]
      : ["If the work is acceptable, include ALL CHECKS PASS."]),
    "If there are issues, explain them clearly and do not include the pass signal.",
    ...effortSupplement,
  ].join("\n");
}

function verificationGroups(config: TeamConfig): VerificationGroups {
  const verifiers = config.verifiers ?? {};
  return {
    browserTesterNames: verifiers.browser_testers ?? [],
    reviewerNames: verifiers.reviewers ?? [],
    testerNames: verifiers.testers ?? [],
  };
}

function workerNames(config: TeamConfig, groups: VerificationGroups): string[] {
  const excluded = new Set([
    ...groups.browserTesterNames,
    ...groups.reviewerNames,
    ...groups.testerNames,
  ]);
  return Object.keys(config.agents).filter((name) => !excluded.has(name));
}

function sessionBackendAvailable(backend: TeamAgentConfig["backend"]): boolean {
  const key = TEAM_BACKEND_MAP[backend];
  return availableBackends()[key];
}

function makeRuntimeAgent(
  name: string,
  config: TeamAgentConfig,
  sessionId: string | null,
): RuntimeAgent | null {
  if (!sessionBackendAvailable(config.backend)) {
    return null;
  }
  const model = config.model ?? "default";
  const session = createSessionForTeamAgent(config.backend, model, {
    resumeSessionId: sessionId,
    systemPrompt: config.system_prompt,
    timeoutS: config.session_timeout_s ?? config.timeout_s,
  });
  if (session === null) {
    return null;
  }
  return { config, name, session };
}

function collectRuntimeAgents(
  runDir: RunDir,
  params: ResolvedRuntimeParams,
  flags: MainFlags,
  state: RuntimeState,
): AgentCollection {
  const listing = getTeamByName(params.team, undefined, flags.project);
  const config = existsSync(runDir.teamFile)
    ? loadTeamConfigFile(runDir.teamFile)
    : (listing?.config ?? null);
  if (config === null) {
    throw new Error(`Team not found: ${params.team}`);
  }
  const resolvedConfig = buildRuntimeTeamConfig(
    config,
    existsSync(runDir.teamFile) ? runDir.teamFile : listing?.path,
  ).config;

  const groups = verificationGroups(resolvedConfig);
  const configuredWorkers = workerNames(resolvedConfig, groups);
  const runtimeAgents = new Map<string, RuntimeAgent>();

  for (const [name, agentConfig] of Object.entries(resolvedConfig.agents)) {
    const agent = makeRuntimeAgent(name, agentConfig, state.agentSessionIds[name] ?? null);
    if (agent !== null) {
      runtimeAgents.set(name, agent);
      continue;
    }
    emitLogEvent("orchestrator_fallback", {
      agent: name,
      backend: agentConfig.backend,
      reason: "Configured agent backend unavailable; agent skipped",
    });
  }

  const workerAgents = configuredWorkers
    .map((name) => runtimeAgents.get(name))
    .filter((agent): agent is RuntimeAgent => agent !== undefined);

  if (workerAgents.length === 0) {
    const session = createSessionForOrchestrator(params.orchestrator, params.orchestratorModel, {
      resumeSessionId: state.agentSessionIds.orchestrator_worker ?? null,
    });
    if (session !== null) {
      workerAgents.push({
        config: {
          backend: fallbackWorkerBackend(params.orchestrator),
          description: "Fallback worker using the orchestrator backend.",
        },
        name: "orchestrator_worker",
        session,
      });
      emitLogEvent("orchestrator_fallback", {
        orchestrator: params.orchestrator,
        reason:
          "No available worker backends in selected team; using orchestrator backend as worker",
      });
    }
  }

  const standardReviewerAgents = [...groups.testerNames, ...groups.reviewerNames]
    .map((name) => runtimeAgents.get(name))
    .filter((agent): agent is RuntimeAgent => agent !== undefined);
  const browserReviewerAgents = groups.browserTesterNames
    .map((name) => runtimeAgents.get(name))
    .filter((agent): agent is RuntimeAgent => agent !== undefined);
  const reviewerAgents = [...standardReviewerAgents, ...browserReviewerAgents];

  return {
    allAgents: [
      ...runtimeAgents.values(),
      ...workerAgents.filter((agent) => !runtimeAgents.has(agent.name)),
    ],
    browserReviewerAgents,
    reviewerAgents,
    standardReviewerAgents,
    workerAgents,
  };
}

function defaultVerificationState(): VerificationState {
  return { doneAttempt: 0 };
}

export function verificationPassed(report: string): boolean {
  const upper = report.toUpperCase();
  if (upper.includes("NOT ALL CHECKS PASS") || upper.includes("NOT MINOR ISSUES FIXED")) {
    return false;
  }

  let stripped = upper.replace(RE_FENCED_CODE, "");
  stripped = stripped.replace(RE_INLINE_CODE, "");
  stripped = stripped.replace(RE_SINGLE_QUOTED, "");
  stripped = stripped.replace(RE_DOUBLE_QUOTED, "");

  if (!RE_SIGNAL.test(stripped)) {
    return false;
  }

  return RE_SIGNAL_AUTHORITATIVE.test(stripped);
}

function resolveQuickCheckPath(check: QuickCheck, runDir: RunDir): string {
  return check.path.replaceAll("{run_dir}", runDir.root);
}

function runQuickChecks(checks: QuickCheck[], runDir: RunDir): string | null {
  const failures = checks
    .map((check) => ({
      ...check,
      path: resolveQuickCheckPath(check, runDir),
    }))
    .filter((check) => !existsSync(check.path))
    .map((check) => `- ${check.description}: ${check.error_message}`);

  if (failures.length === 0) {
    return null;
  }

  return [
    "Quick-check verification failed:",
    ...failures,
    "",
    "Fix these issues and try calling done again.",
  ].join("\n");
}

function verificationPromptLabel(agentName: string): string {
  return agentName.replaceAll("_", " ").replace(/\b\w/gu, (match) => match.toUpperCase());
}

function fallbackVerifier(
  workerAgents: RuntimeAgent[],
  allAgents: RuntimeAgent[],
): RuntimeAgent | null {
  return (
    workerAgents.find((agent) => agent.name === "worker_smart") ??
    workerAgents.find((agent) => agent.name === "worker") ??
    workerAgents[0] ??
    allAgents[0] ??
    null
  );
}

function runVerification(
  allAgents: RuntimeAgent[],
  standardReviewerAgents: RuntimeAgent[],
  browserReviewerAgents: RuntimeAgent[],
  workerAgents: RuntimeAgent[],
  goal: string,
  summary: string,
  runDir: RunDir,
  projectDir: string,
  cycleIndex: number,
  verificationState: VerificationState,
  options: {
    acceptanceCriteria?: string;
    browserTesting?: boolean;
    effort?: ResolvedRuntimeParams["effort"];
    mode?: VerificationMode;
  } = {},
): string | null {
  const mode = options.mode ?? "full";
  const issues: string[] = [];

  if (mode === "skip") {
    return null;
  }
  if (Array.isArray(mode)) {
    return runQuickChecks(mode, runDir);
  }

  emitLogEvent("orchestrator_done_attempt", {
    cycle_index: cycleIndex,
    summary,
  });

  verificationState.doneAttempt += 1;
  const resetSession = verificationState.doneAttempt === 1;
  const prompt = buildVerificationPrompt(goal, summary, options.acceptanceCriteria, options.effort);
  const agents = [
    ...standardReviewerAgents,
    ...(options.browserTesting ? browserReviewerAgents : []),
  ];

  for (const agent of agents) {
    if (resetSession) {
      agent.session.reset();
    }
    const response = agent.session.query(prompt, {
      agentName: agent.name,
      maxTurns: agent.config.max_turns ?? 8,
      projectDir,
      queryIndex: agent.session.stats.queries + 1,
    });
    emitLogEvent("done_verification", {
      agent: agent.name,
      report: response.text.slice(0, 5000),
    });
    emitLogEvent("agent_run_end", {
      agent: agent.name,
      acp_backend: response.acpBackend ?? null,
      conversation_log: response.conversationLog,
      cost_bucket: agent.session.costBucket,
      elapsed_s: response.elapsedS,
      error_code: response.errorCode ?? null,
      input_tokens: response.inputTokens,
      is_error: response.isError,
      output_tokens: response.outputTokens,
      provider: response.provider ?? null,
      provider_env_vars: response.providerEnvVars ?? null,
      provider_thread_id: response.providerThreadId ?? null,
      response_text: response.text,
      server_session_id: response.serverSessionId ?? null,
      session_queries: agent.session.stats.queries,
      session_tokens: agent.session.stats.totalInputTokens + agent.session.stats.totalOutputTokens,
      status: response.isError ? "failed" : "completed",
      usage_raw: response.usageRaw ?? null,
    });
    if (response.isError || !verificationPassed(response.text)) {
      issues.push(
        `**${verificationPromptLabel(agent.name)} found issues:**\n${response.text.slice(0, 3000)}`,
      );
    }
  }

  if (agents.length === 0) {
    const fallback = fallbackVerifier(workerAgents, allAgents);
    if (fallback !== null) {
      const verifier = fallback.session.clone();
      try {
        const response = verifier.query(prompt, {
          agentName: fallback.name,
          maxTurns: fallback.config.max_turns ?? 8,
          projectDir,
          queryIndex: verifier.stats.queries + 1,
        });
        emitLogEvent("done_verification", {
          agent: fallback.name,
          report: response.text.slice(0, 5000),
        });
        emitLogEvent("agent_run_end", {
          agent: fallback.name,
          acp_backend: response.acpBackend ?? null,
          conversation_log: response.conversationLog,
          cost_bucket: verifier.costBucket,
          elapsed_s: response.elapsedS,
          error_code: response.errorCode ?? null,
          input_tokens: response.inputTokens,
          is_error: response.isError,
          output_tokens: response.outputTokens,
          provider: response.provider ?? null,
          provider_env_vars: response.providerEnvVars ?? null,
          provider_thread_id: response.providerThreadId ?? null,
          response_text: response.text,
          server_session_id: response.serverSessionId ?? null,
          session_queries: verifier.stats.queries,
          session_tokens: verifier.stats.totalInputTokens + verifier.stats.totalOutputTokens,
          status: response.isError ? "failed" : "completed",
          usage_raw: response.usageRaw ?? null,
        });
        if (response.isError || !verificationPassed(response.text)) {
          issues.push(
            `**${fallback.name} (verifier) found issues:**\n${response.text.slice(0, 3000)}`,
          );
        }
      } finally {
        verifier.close();
      }
    }
  }

  return issues.length > 0
    ? [
        `DONE REJECTED (attempt ${verificationState.doneAttempt}) — verification found issues that must be fixed:`,
        "",
        issues.join("\n\n"),
        "",
        "Fix these issues and try calling done again.",
      ].join("\n")
    : null;
}

function runGit(
  projectDir: string,
  args: string[],
  allowFailure = false,
): { ok: boolean; output: string } {
  const result = spawnSync("git", args, {
    cwd: projectDir,
    encoding: "utf8",
    env: { ...process.env, ...GIT_AUTHOR_ENV },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  const ok = (result.status ?? 1) === 0;
  if (!ok && !allowFailure) {
    throw new Error(output || `git ${args.join(" ")} failed`);
  }
  return { ok, output };
}

function maybeAutoCommit(projectDir: string, enabled: boolean, summary: string): GitResult {
  if (!enabled) {
    emitLogEvent("auto_commit_disabled", { enabled: false });
    return { committed: false, skippedReason: "disabled" };
  }

  const insideRepo = runGit(projectDir, ["rev-parse", "--is-inside-work-tree"], true);
  if (!insideRepo.ok) {
    emitLogEvent("auto_commit_skip", {
      reason: "Project is not a git repository",
    });
    return { committed: false, skippedReason: "not_git_repo" };
  }

  const status = runGit(projectDir, ["status", "--porcelain"], true);
  if (!status.ok || status.output.trim().length === 0) {
    emitLogEvent("auto_commit_skip", {
      reason: "No changes to commit",
    });
    return { committed: false, skippedReason: "no_changes" };
  }

  emitLogEvent("auto_commit_start", {
    summary,
  });
  try {
    runGit(projectDir, ["add", "-A"]);
    const message = `simple-runner: ${summary.replace(/\s+/gu, " ").trim().slice(0, 72)}`;
    runGit(projectDir, ["commit", "-m", message]);
    emitLogEvent("auto_commit_done", {
      message,
    });
    return { committed: true, message };
  } catch (error) {
    emitLogEvent("auto_commit_error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { committed: false, skippedReason: "error" };
  }
}

function closeAgents(agents: RuntimeAgent[]): void {
  for (const agent of agents) {
    try {
      agent.session.close();
    } catch (error) {
      emitLogEvent("session_cleanup_warning", {
        agent: agent.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function cycleSummary(text: string): string {
  return text.replace(/\s+/gu, " ").trim().slice(0, 4000);
}

abstract class RuntimeOrchestratorBase {
  readonly kind: string;
  readonly model: string;
  private readonly summarizer: AsyncSummarizer;

  protected constructor(kind: string, model: string) {
    this.kind = kind;
    this.model = model;
    this.summarizer = new AsyncSummarizer();
  }

  run(
    runDir: RunDir,
    params: ResolvedRuntimeParams,
    goal: ResolvedGoal,
    flags: MainFlags,
  ): OrchestrationResult & { artifacts: OrchestrationArtifacts } {
    try {
      const state = loadRuntimeState(runDir);
      const artifacts = expectedArtifacts(runDir, goal);
      const plan = loadGoalPlan(runDir);

      emitLogEvent("run_start", {
        cost_bucket: orchestratorCostBucket(this.kind),
        goal: goal.goalText,
        has_stages: plan !== null,
        max_cycles: params.maxCycles,
        max_exchanges: params.maxExchanges,
        model: this.model,
        num_stages: plan?.stages.length ?? 0,
        orchestrator: this.kind,
        project_dir: flags.project,
        resumed: state.completedCycles > 0 || state.pendingExchanges.length > 0,
        resume_from_cycle:
          state.completedCycles > 0 || state.pendingExchanges.length > 0
            ? state.completedCycles + 1
            : null,
      });

      const result =
        plan === null
          ? (() => {
              emitLogEvent("planning_start", { goal: goal.goalText, mode: goal.source });
              emitLogEvent("planning_end", { has_plan: false, mode: goal.source });
              return this.runSingleGoal(runDir, params, goal.goalText ?? "", flags, state);
            })()
          : this.runPlan(runDir, params, goal, flags, state, plan);

      emitLogEvent("run_end", {
        cost_bucket: orchestratorCostBucket(this.kind),
        finished: result.finished,
        orchestrator: this.kind,
        summary: result.summary,
        total_cycles: result.cyclesCompleted,
        total_exchanges: result.cyclesCompleted,
      });

      return {
        ...result,
        artifacts,
      };
    } finally {
      this.summarizer.shutdown(true);
    }
  }

  protected summarizeWorkerResult(
    agentName: string,
    task: string,
    directive: ParsedDirective,
    response: SessionQueryResult,
  ): string {
    if (!response.isError && response.text.trim().length > 0) {
      this.summarizer.summarize(agentName, task, response.text);
    }

    const accumulated = this.summarizer.getAccumulatedSummary();
    this.summarizer.clear();

    if (directive.explicit) {
      return cycleSummary(directive.summary || accumulated || response.text);
    }
    if (!response.isError && accumulated.length > 0) {
      return cycleSummary(accumulated);
    }
    return cycleSummary(directive.summary || response.text);
  }

  protected runPlan(
    runDir: RunDir,
    params: ResolvedRuntimeParams,
    goal: ResolvedGoal,
    flags: MainFlags,
    state: RuntimeState,
    plan: GoalPlan,
  ): OrchestrationResult {
    emitLogEvent("planning_start", { goal: goal.goalText, mode: goal.source });
    emitLogEvent("planning_end", {
      has_plan: true,
      mode: goal.source,
      num_stages: plan.stages.length,
    });

    let summary = state.lastSummary;
    const advisor = this.createStageAdvisor(plan);

    while (state.completedCycles < params.maxCycles) {
      const decision = advisor.assess(
        goal.goalText ?? "",
        state.stageSummaries,
        state.completedStages,
        flags.project,
      );

      if (decision.action === "done") {
        summary = cycleSummary(decision.summary || summary || (goal.goalText ?? ""));
        emitLogEvent("advisor_done", {
          completed_stages: state.completedStages.length,
          summary,
        });
        state.finished = true;
        state.lastSummary = summary;
        persistRuntimeState(runDir, state);
        return {
          cyclesCompleted: state.completedCycles,
          finished: true,
          message: "Run completed.",
          summary,
        };
      }

      const group = decision.group;
      if (group.length === 0) {
        break;
      }

      const result =
        group.length === 1
          ? this.runSequentialStage(runDir, params, flags, state, plan, group[0]!)
          : this.runParallelStageGroup(runDir, params, flags, state, plan, group);

      summary = result.summary;
      if (!result.finished) {
        return result;
      }
    }

    return {
      cyclesCompleted: state.completedCycles,
      finished: false,
      message: "Run paused after reaching the cycle limit.",
      summary,
    };
  }

  protected createStageAdvisor(plan: GoalPlan): StageAdvisor {
    return new LocalAdaptiveStageAdvisor(plan);
  }

  protected runSequentialStage(
    runDir: RunDir,
    params: ResolvedRuntimeParams,
    flags: MainFlags,
    state: RuntimeState,
    plan: GoalPlan,
    stage: GoalStage,
  ): OrchestrationResult {
    const effectivePlan =
      plan.stages.some((candidate) => candidate.index === stage.index) ||
      stage.index <= plan.stages.length
        ? plan
        : { ...plan, stages: [...plan.stages, stage] };
    emitLogEvent("stage_start", {
      stage_index: stage.index,
      stage_name: stage.name,
      max_cycles: params.maxCycles,
    });
    const stageGoal = composeStageGoal(effectivePlan, stage, state.stageSummaries);
    const result = this.runSingleGoal(
      runDir,
      params,
      stageGoal,
      flags,
      state,
      stage.acceptance_criteria,
      `${stage.index}/${effectivePlan.stages.length}: ${stage.name}`,
      stage.browser_testing,
      stage.verification,
    );
    const summary = result.summary;
    if (!result.finished) {
      emitLogEvent("stage_end", {
        cycles_used: state.currentStageCycles,
        finished: false,
        stage_index: stage.index,
        stage_name: stage.name,
        summary,
      });
      return result;
    }

    state.completedStages.push(stage.index);
    state.currentStageCycles = 0;
    state.stageSummaries.push(summary);
    state.lastSummary = summary;
    persistRuntimeState(runDir, state);
    emitLogEvent("stage_end", {
      cycles_used: state.completedCycles,
      finished: true,
      stage_index: stage.index,
      stage_name: stage.name,
      summary,
    });
    return result;
  }

  protected runParallelStageGroup(
    runDir: RunDir,
    params: ResolvedRuntimeParams,
    flags: MainFlags,
    state: RuntimeState,
    plan: GoalPlan,
    group: GoalStage[],
  ): OrchestrationResult {
    const { allAgents, browserReviewerAgents, standardReviewerAgents, workerAgents } =
      collectRuntimeAgents(runDir, params, flags, state);
    if (workerAgents.length === 0) {
      closeAgents(allAgents);
      throw new Error("No runnable workers available for the selected team.");
    }

    cleanupStaleWorktrees(flags.project);
    const worktrees = new Map<number, WorktreeHandle>();
    let worktreeFailed = false;
    for (const stage of group) {
      try {
        const worktree = createWorktree(flags.project, `stage-${stage.index}`);
        worktrees.set(stage.index, worktree);
      } catch (error) {
        worktreeFailed = true;
        emitLogEvent("worktree_cleanup_error", {
          stage_index: stage.index,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (worktreeFailed) {
      for (const [stageIndex, worktree] of worktrees.entries()) {
        try {
          removeWorktree(flags.project, worktree.worktreeDir, worktree.branchName);
        } catch (error) {
          emitLogEvent("worktree_cleanup_error", {
            stage_index: stageIndex,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      closeAgents(allAgents);
      return this.runParallelGroupSequentialFallback(runDir, params, flags, state, plan, group);
    }

    const sharedSummaries = [...state.stageSummaries];
    const stageRuntimes: ParallelStageRuntime[] = group.map((stage, index) => {
      const restored = state.parallelStageState[String(stage.index)];
      const restoredWorker =
        restored?.agentName !== undefined
          ? workerAgents.find((candidate) => candidate.name === restored.agentName)
          : null;
      return {
        cyclesUsed: 0,
        finished: false,
        goalText: composeStageGoal(plan, stage, sharedSummaries),
        persistReady: false,
        priorSummary: restored?.summary ?? "",
        sessionId: restored?.sessionId ?? null,
        stage,
        summary: "",
        worker: restoredWorker ?? workerAgents[index % workerAgents.length]!,
      };
    });

    emitLogEvent("parallel_group_start", {
      per_stage_cycles: params.maxCycles - state.completedCycles,
      stages: group.map((stage) => stage.index),
    });
    for (const stage of group) {
      emitLogEvent("stage_start", {
        stage_index: stage.index,
        stage_name: stage.name,
        max_cycles: params.maxCycles - state.completedCycles,
      });
    }

    try {
      const maxParallelCycles = Math.max(1, params.maxCycles - state.completedCycles);
      let groupCyclesUsed = 0;
      const verificationState = defaultVerificationState();

      while (
        groupCyclesUsed < maxParallelCycles &&
        stageRuntimes.some((stage) => !stage.finished)
      ) {
        const activeStages = stageRuntimes.filter((stage) => !stage.finished);
        const parallelResults = querySessionsInParallel(
          activeStages.map((stage) => ({
            options: {
              agentName: stage.worker.name,
              maxTurns: stage.worker.config.max_turns ?? params.maxExchanges,
              projectDir: worktrees.get(stage.stage.index)?.worktreeDir ?? flags.project,
              queryIndex: stage.worker.session.stats.queries + 1,
            },
            prompt: buildWorkerPrompt(
              stage.goalText,
              worktrees.get(stage.stage.index)?.worktreeDir ?? flags.project,
              stage.priorSummary,
              stage.worker,
              stage.cyclesUsed + 1,
            ),
            resumeSessionId: stage.sessionId,
            session: stage.worker.session,
          })),
        );

        emitLogEvent("cycle_start", {
          cycle_index: state.completedCycles + groupCyclesUsed + 1,
          orchestrator: this.kind,
          project_dir: flags.project,
          stages: activeStages.map((stage) => stage.stage.index),
        });

        let combinedSummary = "";
        for (const [index, stageRuntime] of activeStages.entries()) {
          persistPendingExchange(runDir, state, {
            acceptanceCriteria: stageRuntime.stage.acceptance_criteria,
            agentName: stageRuntime.worker.name,
            browserTesting: stageRuntime.stage.browser_testing,
            cycleIndex: state.completedCycles + groupCyclesUsed + 1,
            goalText: stageRuntime.goalText,
            priorSummary: stageRuntime.priorSummary,
            projectDir: worktrees.get(stageRuntime.stage.index)?.worktreeDir ?? flags.project,
            scope: "parallel",
            sessionId: stageRuntime.sessionId,
            stageIndex: stageRuntime.stage.index,
            summary: stageRuntime.summary,
            verificationMode: stageRuntime.stage.verification,
          });
          const queryResult = parallelResults[index]!;
          const outcome = this.buildOutcome(queryResult);
          const stageSummary = outcome.summary;

          stageRuntime.cyclesUsed += 1;
          stageRuntime.priorSummary = stageSummary;
          stageRuntime.summary = stageSummary;
          stageRuntime.sessionId = stageRuntime.worker.session.sessionId;
          persistPendingExchange(runDir, state, {
            acceptanceCriteria: stageRuntime.stage.acceptance_criteria,
            agentName: stageRuntime.worker.name,
            browserTesting: stageRuntime.stage.browser_testing,
            cycleIndex: state.completedCycles + groupCyclesUsed + 1,
            directiveTerminal: outcome.directive.terminal,
            goalText: stageRuntime.goalText,
            priorSummary: stageRuntime.priorSummary,
            projectDir: worktrees.get(stageRuntime.stage.index)?.worktreeDir ?? flags.project,
            responseIsError: queryResult.isError,
            responseText: queryResult.text,
            scope: "parallel",
            sessionId: stageRuntime.sessionId,
            stageIndex: stageRuntime.stage.index,
            summary: stageSummary,
            verificationMode: stageRuntime.stage.verification,
          });

          emitLogEvent("agent_run_end", {
            agent: stageRuntime.worker.name,
            acp_backend: queryResult.acpBackend ?? null,
            conversation_log: queryResult.conversationLog,
            cost_bucket: stageRuntime.worker.session.costBucket,
            elapsed_s: queryResult.elapsedS,
            error_code: queryResult.errorCode ?? null,
            input_tokens: queryResult.inputTokens,
            is_error: queryResult.isError,
            output_tokens: queryResult.outputTokens,
            provider: queryResult.provider ?? null,
            provider_env_vars: queryResult.providerEnvVars ?? null,
            provider_thread_id: queryResult.providerThreadId ?? null,
            response_text: queryResult.text,
            server_session_id: queryResult.serverSessionId ?? null,
            session_queries: stageRuntime.worker.session.stats.queries,
            session_tokens:
              stageRuntime.worker.session.stats.totalInputTokens +
              stageRuntime.worker.session.stats.totalOutputTokens,
            status: queryResult.isError ? "failed" : "completed",
            usage_raw: queryResult.usageRaw ?? null,
          });
          updateAgentStats(
            state,
            stageRuntime.worker.name,
            queryResult,
            stageRuntime.worker.session,
          );

          if (outcome.directive.terminal === "goal_done" && !queryResult.isError) {
            const verificationIssues = runVerification(
              allAgents,
              standardReviewerAgents,
              browserReviewerAgents,
              workerAgents,
              stageRuntime.goalText,
              stageSummary,
              runDir,
              worktrees.get(stageRuntime.stage.index)?.worktreeDir ?? flags.project,
              state.completedCycles + groupCyclesUsed + 1,
              verificationState,
              {
                acceptanceCriteria: stageRuntime.stage.acceptance_criteria,
                browserTesting: stageRuntime.stage.browser_testing,
                effort: params.effort,
                mode: stageRuntime.stage.verification,
              },
            );
            if (verificationIssues === null) {
              stageRuntime.finished = true;
              stageRuntime.persistReady = true;
              emitLogEvent("orchestrator_done_accepted", {
                cycle_index: state.completedCycles + groupCyclesUsed + 1,
                stage_index: stageRuntime.stage.index,
                summary: stageSummary,
              });
            } else {
              stageRuntime.summary = verificationIssues;
              stageRuntime.priorSummary = verificationIssues;
              emitLogEvent("orchestrator_done_rejected", {
                cycle_index: state.completedCycles + groupCyclesUsed + 1,
                stage_index: stageRuntime.stage.index,
                summary: verificationIssues,
              });
            }
          } else if (outcome.directive.terminal === "raise_issue" || queryResult.isError) {
            stageRuntime.finished = true;
            emitLogEvent("orchestrator_raise_issue", {
              cycle_index: state.completedCycles + groupCyclesUsed + 1,
              stage_index: stageRuntime.stage.index,
              summary: stageSummary,
            });
          }

          combinedSummary += `${combinedSummary.length > 0 ? " | " : ""}S${stageRuntime.stage.index}: ${stageRuntime.summary}`;
          clearPendingExchange(
            runDir,
            state,
            "parallel",
            stageRuntime.worker.name,
            stageRuntime.stage.index,
          );
        }

        groupCyclesUsed += 1;
        state.completedCycles += 1;
        state.lastSummary = combinedSummary;
        persistRuntimeState(runDir, state);
        emitLogEvent("cycle_end", {
          cycle_index: state.completedCycles,
          cost_bucket: orchestratorCostBucket(this.kind),
          exchanges: activeStages.length,
          finished: stageRuntimes.every((stage) => stage.finished),
          summary: combinedSummary,
        });
      }

      const completedStages = stageRuntimes.filter((stage) => stage.finished);
      for (const stageRuntime of stageRuntimes) {
        const finished = stageRuntime.finished;
        emitLogEvent("stage_end", {
          cycles_used: stageRuntime.cyclesUsed,
          finished,
          stage_index: stageRuntime.stage.index,
          stage_name: stageRuntime.stage.name,
          summary: stageRuntime.summary,
        });
        if (finished) {
          state.completedStages.push(stageRuntime.stage.index);
          state.stageSummaries.push(stageRuntime.summary);
        }
      }

      state.currentStageCycles = 0;
      persistRuntimeState(runDir, state);
      emitLogEvent("parallel_group_end", {
        finished: completedStages.length > 0,
        stages: group.map((stage) => stage.index),
      });

      if (completedStages.length === 0) {
        return {
          cyclesCompleted: state.completedCycles,
          finished: false,
          message: "Run paused after parallel stage group made no completed progress.",
          summary: stageRuntimes.map((stage) => stage.summary).join(" | "),
        };
      }

      const summary = completedStages.map((stage) => stage.summary).join(" | ");
      state.lastSummary = summary;
      return {
        cyclesCompleted: state.completedCycles,
        finished: true,
        message: "Run completed.",
        summary,
      };
    } finally {
      const finishedStageIndexes = new Set(
        stageRuntimes
          .filter((stageRuntime) => stageRuntime.persistReady)
          .map((stageRuntime) => stageRuntime.stage.index),
      );
      const branchesToMerge: Array<{ branchName: string; stageIndex: number; stageName: string }> =
        [];

      for (const stage of group) {
        const worktree = worktrees.get(stage.index);
        if (worktree === undefined) {
          continue;
        }
        if (stage.persist_changes && finishedStageIndexes.has(stage.index)) {
          try {
            commitWorktreeChanges(worktree.worktreeDir, stage.name);
            branchesToMerge.push({
              branchName: worktree.branchName,
              stageIndex: stage.index,
              stageName: stage.name,
            });
          } catch (error) {
            emitLogEvent("worktree_cleanup_error", {
              stage_index: stage.index,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      const keptBranches = new Set(branchesToMerge.map((entry) => entry.branchName));
      for (const stage of group) {
        const worktree = worktrees.get(stage.index);
        if (worktree === undefined) {
          continue;
        }
        try {
          if (keptBranches.has(worktree.branchName)) {
            removeWorktreeKeepBranch(flags.project, worktree.worktreeDir);
          } else {
            removeWorktree(flags.project, worktree.worktreeDir, worktree.branchName);
          }
        } catch (error) {
          emitLogEvent("worktree_cleanup_error", {
            stage_index: stage.index,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      branchesToMerge.sort((left, right) => left.stageIndex - right.stageIndex);
      for (const branch of branchesToMerge) {
        try {
          const mergeResult = mergeWorktreeBranch(
            flags.project,
            branch.branchName,
            branch.stageName,
          );
          emitLogEvent("persist_stage_merge", {
            stage_index: branch.stageIndex,
            success: mergeResult.success,
            had_changes: mergeResult.hadChanges,
            conflict: mergeResult.conflict,
          });
        } catch (error) {
          emitLogEvent("persist_stage_merge", {
            stage_index: branch.stageIndex,
            success: false,
            had_changes: false,
            conflict: false,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          deleteWorktreeBranch(flags.project, branch.branchName);
        }
      }

      closeAgents(allAgents);
    }
  }

  protected runParallelGroupSequentialFallback(
    runDir: RunDir,
    params: ResolvedRuntimeParams,
    flags: MainFlags,
    state: RuntimeState,
    plan: GoalPlan,
    group: GoalStage[],
  ): OrchestrationResult {
    for (const stage of group) {
      const result = this.runSequentialStage(
        runDir,
        { ...params, autoCommit: params.autoCommit && Boolean(stage.persist_changes) },
        flags,
        state,
        plan,
        stage,
      );
      if (!result.finished) {
        return result;
      }
    }

    return {
      cyclesCompleted: state.completedCycles,
      finished: true,
      message: "Run completed.",
      summary: group
        .map((stage) => {
          const summaryIndex = state.completedStages.lastIndexOf(stage.index);
          return summaryIndex === -1 ? "" : (state.stageSummaries[summaryIndex] ?? "");
        })
        .filter((entry) => entry.length > 0)
        .join(" | "),
    };
  }

  protected runSingleGoal(
    runDir: RunDir,
    params: ResolvedRuntimeParams,
    goalText: string,
    flags: MainFlags,
    state: RuntimeState,
    acceptCriteria?: string,
    stageLabel?: string,
    browserTesting?: boolean,
    verificationMode?: VerificationMode,
  ): OrchestrationResult {
    const { allAgents, browserReviewerAgents, standardReviewerAgents, workerAgents } =
      collectRuntimeAgents(runDir, params, flags, state);
    if (workerAgents.length === 0) {
      closeAgents(allAgents);
      throw new Error("No runnable workers available for the selected team.");
    }

    let priorSummary = state.lastSummary;
    try {
      for (
        let cycleIndex = state.completedCycles + 1;
        cycleIndex <= params.maxCycles;
        cycleIndex += 1
      ) {
        const verificationState = defaultVerificationState();
        state.currentStageCycles += 1;
        writeRunStatus(flags.project, goalText, {
          cycleNum: state.currentStageCycles,
          maxCycles: params.maxCycles,
          stageLabel,
        });
        emitLogEvent("cycle_start", {
          cycle_index: cycleIndex,
          orchestrator: this.kind,
          project_dir: flags.project,
        });

        const worker = chooseWorkerForGoal(workerAgents, cycleIndex, goalText, acceptCriteria);
        const restoredPending = pendingExchangeForSingle(state, cycleIndex, goalText);
        const outcome =
          restoredPending !== null
            ? (pendingExchangeOutcome(restoredPending) ??
              this.runWorkerCycle(
                runDir,
                goalText,
                flags.project,
                worker,
                restoredPending.priorSummary,
                cycleIndex,
                params.maxExchanges,
                state,
                acceptCriteria,
                browserTesting,
                verificationMode,
              ))
            : this.runWorkerCycle(
                runDir,
                goalText,
                flags.project,
                worker,
                priorSummary,
                cycleIndex,
                params.maxExchanges,
                state,
                acceptCriteria,
                browserTesting,
                verificationMode,
              );

        let finished = false;
        let summary = outcome.summary;

        if (outcome.response.isError) {
          emitLogEvent("orchestrator_response", {
            done_called: outcome.directive.explicit,
            is_error: true,
            orchestrator: this.kind,
            result_text: outcome.response.text.slice(0, 2000),
          });
        } else if (outcome.directive.terminal === "goal_done") {
          const verificationIssues = runVerification(
            allAgents,
            standardReviewerAgents,
            browserReviewerAgents,
            workerAgents,
            goalText,
            summary,
            runDir,
            flags.project,
            cycleIndex,
            verificationState,
            {
              acceptanceCriteria: acceptCriteria,
              browserTesting,
              effort: params.effort,
              mode: verificationMode,
            },
          );
          if (verificationIssues === null) {
            emitLogEvent("orchestrator_done_accepted", {
              cycle_index: cycleIndex,
              summary,
            });
            finished = true;
          } else {
            summary = verificationIssues;
            emitLogEvent("orchestrator_done_rejected", {
              cycle_index: cycleIndex,
              summary,
            });
            emitLogEvent("orchestrator_retry", {
              cycle_index: cycleIndex,
              reason: "Verification rejected completion",
            });
          }
        } else if (outcome.directive.terminal === "raise_issue") {
          emitLogEvent("orchestrator_raise_issue", {
            cycle_index: cycleIndex,
            summary,
          });
          finished = true;
        } else {
          emitLogEvent("orchestrator_end_cycle", {
            cycle_index: cycleIndex,
            summary,
          });
        }

        emitLogEvent("cycle_end", {
          cycle_index: cycleIndex,
          cost_bucket: orchestratorCostBucket(this.kind),
          exchanges: 1,
          finished,
          summary,
        });

        state.completedCycles = cycleIndex;
        state.lastSummary = summary;
        priorSummary = summary;
        clearPendingExchange(runDir, state, "single", worker.name);
        persistRuntimeState(runDir, state);

        if (finished) {
          maybeAutoCommit(flags.project, params.autoCommit, summary);
          state.finished = true;
          return {
            cyclesCompleted: state.completedCycles,
            finished: true,
            message:
              outcome.directive.terminal === "raise_issue" ? "Run failed." : "Run completed.",
            summary,
          };
        }
      }

      return {
        cyclesCompleted: state.completedCycles,
        finished: false,
        message: "Run paused after reaching the cycle limit.",
        summary: priorSummary,
      };
    } finally {
      closeAgents(allAgents);
    }
  }

  protected runWorkerCycle(
    runDir: RunDir,
    goalText: string,
    projectDir: string,
    worker: RuntimeAgent,
    priorSummary: string,
    cycleIndex: number,
    maxExchanges: number,
    state: RuntimeState,
    acceptanceCriteria?: string,
    browserTesting?: boolean,
    verificationMode?: VerificationMode,
  ): WorkerCycleOutcome {
    const prompt = buildWorkerPrompt(goalText, projectDir, priorSummary, worker, cycleIndex);
    persistPendingExchange(runDir, state, {
      acceptanceCriteria,
      agentName: worker.name,
      browserTesting,
      cycleIndex,
      goalText,
      priorSummary,
      projectDir,
      scope: "single",
      sessionId: worker.session.sessionId,
      verificationMode,
    });
    emitLogEvent("agent_run_start", {
      agent: worker.name,
      model: worker.session.model,
      session: worker.session.backend,
    });
    emitLogEvent("orchestrator_tool_call", {
      agent: worker.name,
      cycle_index: cycleIndex,
      tool: "implement_goal",
    });

    const outcome = this.queryWorker(worker, prompt, projectDir, cycleIndex, maxExchanges);
    outcome.summary = this.summarizeWorkerResult(
      worker.name,
      goalText,
      outcome.directive,
      outcome.response,
    );
    persistPendingExchange(runDir, state, {
      acceptanceCriteria,
      agentName: worker.name,
      browserTesting,
      cycleIndex,
      directiveTerminal: outcome.directive.terminal,
      goalText,
      priorSummary,
      projectDir,
      responseIsError: outcome.response.isError,
      responseText: outcome.response.text,
      scope: "single",
      sessionId: worker.session.sessionId,
      summary: outcome.summary,
      verificationMode,
    });

    emitLogEvent("orchestrator_tool_result", {
      agent: worker.name,
      cycle_index: cycleIndex,
      ok: !outcome.response.isError,
      tool: "implement_goal",
    });
    emitLogEvent("agent_run_end", {
      agent: worker.name,
      acp_backend: outcome.response.acpBackend ?? null,
      conversation_log: outcome.response.conversationLog,
      cost_bucket: worker.session.costBucket,
      elapsed_s: outcome.response.elapsedS,
      error_code: outcome.response.errorCode ?? null,
      input_tokens: outcome.response.inputTokens,
      is_error: outcome.response.isError,
      output_tokens: outcome.response.outputTokens,
      provider: outcome.response.provider ?? null,
      provider_env_vars: outcome.response.providerEnvVars ?? null,
      provider_thread_id: outcome.response.providerThreadId ?? null,
      response_text: outcome.response.text,
      server_session_id: outcome.response.serverSessionId ?? null,
      session_queries: worker.session.stats.queries,
      session_tokens:
        worker.session.stats.totalInputTokens + worker.session.stats.totalOutputTokens,
      status: outcome.response.isError ? "failed" : "completed",
      usage_raw: outcome.response.usageRaw ?? null,
    });
    updateAgentStats(state, worker.name, outcome.response, worker.session);

    const sessionId = worker.session.sessionId;
    if (sessionId !== null) {
      state.agentSessionIds[worker.name] = sessionId;
    }
    return outcome;
  }

  protected queryWorker(
    worker: RuntimeAgent,
    prompt: string,
    projectDir: string,
    cycleIndex: number,
    maxExchanges: number,
  ): WorkerCycleOutcome {
    const response = worker.session.query(prompt, {
      agentName: worker.name,
      maxTurns: worker.config.max_turns ?? maxExchanges,
      projectDir,
      queryIndex: worker.session.stats.queries + 1,
    });
    return this.buildOutcome(response);
  }

  protected buildOutcome(response: SessionQueryResult): WorkerCycleOutcome {
    const directive = parseDoneDirective(response.text);
    return {
      directive,
      response,
      summary: cycleSummary(directive.summary || response.text),
    };
  }
}

abstract class CliRuntimeOrchestratorBase extends RuntimeOrchestratorBase {
  protected constructor(kind: "codex" | "cursor" | "gemini-cli" | "opencode", model: string) {
    super(kind, model);
  }
}

export class PiRuntimeOrchestrator extends RuntimeOrchestratorBase {
  constructor(model: string) {
    super("pi", model);
  }

  protected override createStageAdvisor(plan: GoalPlan): StageAdvisor {
    return new PiToolStageAdvisor(plan, this.model);
  }
}

export class ApiRuntimeOrchestrator extends RuntimeOrchestratorBase {
  constructor(model: string) {
    super("api", model);
  }

  protected override createStageAdvisor(plan: GoalPlan): StageAdvisor {
    return new ApiToolStageAdvisor(plan, this.model);
  }
}

export class ClaudeCodeRuntimeOrchestrator extends RuntimeOrchestratorBase {
  constructor(model: string) {
    super("claude-code", model);
  }

  protected override queryWorker(
    worker: RuntimeAgent,
    prompt: string,
    projectDir: string,
    cycleIndex: number,
    maxExchanges: number,
  ): WorkerCycleOutcome {
    let response = worker.session.query(prompt, {
      agentName: worker.name,
      maxTurns: worker.config.max_turns ?? maxExchanges,
      projectDir,
      queryIndex: worker.session.stats.queries + 1,
    });
    let outcome = this.buildOutcome(response);

    for (let nudge = 1; nudge <= 3; nudge += 1) {
      if (response.isError || outcome.directive.explicit) {
        break;
      }
      emitLogEvent("orchestrator_nudge", {
        cycle_index: cycleIndex,
        orchestrator: this.kind,
        attempt: nudge,
      });
      response = worker.session.query(
        "You must signal completion to end this cycle. Reply with exactly one of GOAL_DONE:, END_CYCLE:, or RAISE_ISSUE: followed by a short summary.",
        {
          agentName: worker.name,
          maxTurns: worker.config.max_turns ?? maxExchanges,
          projectDir,
          queryIndex: worker.session.stats.queries + 1,
        },
      );
      outcome = this.buildOutcome(response);
    }

    return outcome;
  }
}

export class CodexCliRuntimeOrchestrator extends CliRuntimeOrchestratorBase {
  constructor(model: string) {
    super("codex", model);
  }
}

export class CursorCliRuntimeOrchestrator extends CliRuntimeOrchestratorBase {
  constructor(model: string) {
    super("cursor", model);
  }
}

export class GeminiCliRuntimeOrchestrator extends CliRuntimeOrchestratorBase {
  constructor(model: string) {
    super("gemini-cli", model);
  }
}

export class OpencodeRuntimeOrchestrator extends CliRuntimeOrchestratorBase {
  constructor(model: string) {
    super("opencode", model);
  }
}

export function buildRuntimeOrchestrator(params: ResolvedRuntimeParams): RuntimeOrchestrator {
  switch (params.orchestrator) {
    case "pi":
      return new PiRuntimeOrchestrator(params.orchestratorModel);
    case "api":
      return new ApiRuntimeOrchestrator(params.orchestratorModel);
    case "claude-code":
      return new ClaudeCodeRuntimeOrchestrator(params.orchestratorModel);
    case "codex":
      return new CodexCliRuntimeOrchestrator(params.orchestratorModel);
    case "cursor":
      return new CursorCliRuntimeOrchestrator(params.orchestratorModel);
    case "gemini-cli":
      return new GeminiCliRuntimeOrchestrator(params.orchestratorModel);
    case "opencode":
      return new OpencodeRuntimeOrchestrator(params.orchestratorModel);
    default:
      throw new Error(`Unsupported orchestrator: ${params.orchestrator}`);
  }
}

export function runOrchestration(
  runDir: RunDir,
  params: ResolvedRuntimeParams,
  goal: ResolvedGoal,
  flags: MainFlags,
): OrchestrationResult & { artifacts: OrchestrationArtifacts } {
  return buildRuntimeOrchestrator(params).run(runDir, params, goal, flags);
}
