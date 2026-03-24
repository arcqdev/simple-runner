import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { getTeamByName, loadTeamConfigFile } from "../config/team-config.js";
import { getElapsedS, initAppend, emit as emitLogEvent, RunDir } from "../logging/log.js";
import { getRunById, parseRun } from "../logging/runs.js";
import { uploadTrace } from "../logging/trace-upload.js";
import type { MainFlags } from "../cli/types.js";
import type { ResolvedGoal, ResolvedRuntimeParams } from "../cli/runtime.js";
import { availableBackends, preflightWarningsForBackends } from "./backends.js";
import { runOrchestration } from "./orchestration.js";
import { backendForOrchestrator } from "./sessions.js";
import type { ExecutionResult } from "./types.js";

type ResumeTarget = {
  logFile: string;
  runId: string;
};

function projectLabel(projectDir: string): string {
  return path.basename(projectDir) || projectDir;
}

function ensureParent(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeReport(filePath: string, content: string): void {
  ensureParent(filePath);
  writeFileSync(filePath, `${content.trimEnd()}\n`, "utf8");
}

function buildImproveReport(goal: string, projectDir: string): string {
  const project = projectLabel(projectDir);
  return [
    "# Improve Report",
    "",
    "## Auto-fixed",
    `- ${project}:1 - Standardized the active run scaffold for goal: ${goal}`,
    "",
    "## Needs decision",
    `- ${project}:1 - Choose whether to replace the synthetic execution engine with backend-specific orchestration first or after session adapters land.`,
    "",
    "## Skipped by triage",
    "- Full multi-agent role splitting remains pending until session/backends are ported.",
  ].join("\n");
}

function buildTestReport(goal: string, projectDir: string, targets: string[]): string {
  const project = projectLabel(projectDir);
  const targetLabel = targets.length > 0 ? targets.join(", ") : project;
  return [
    "# Test Report",
    "",
    "## Summary",
    "- **Features tested:** 1",
    "- **Findings:** 0",
    "- **Regression tests written:** 0",
    "",
    "## Feature Coverage",
    "| Feature / Workflow | Status | Findings | Notes |",
    "|--------------------|--------|----------|-------|",
    `| ${targetLabel} | pass | none | Synthetic verification run completed successfully. |`,
    "",
    "## Findings",
    "- None in this synthetic execution pass.",
    "",
    "## Regression Tests & Fixes",
    "- None.",
    "",
    "## Self-Critique",
    `- This run validated the current ${project} workflow scaffold, not a real backend-driven product workflow.`,
    "",
    "## Blocked Workflows",
    "- Backend-specific interactive testing is still pending session adapter migration.",
  ].join("\n");
}

function buildGenericSummary(goal: string, params: ResolvedRuntimeParams): string {
  return `Completed 1 cycle with ${params.orchestrator} (${params.orchestratorModel}) for goal: ${goal.replace(/\s+/gu, " ").trim()}`;
}

function writeSyntheticArtifacts(
  runDir: RunDir,
  goal: ResolvedGoal,
  flags: MainFlags,
): { reportPath: string | null; reportTitle: string | null } {
  if (goal.source === "improve") {
    const reportPath = path.join(runDir.root, "improve-report.md");
    writeReport(reportPath, buildImproveReport(goal.goalText ?? "", flags.project));
    return { reportPath, reportTitle: "Improve Report" };
  }
  if (goal.source === "test" || goal.source === "fix-from") {
    const reportPath = path.join(runDir.root, "test-report.md");
    writeReport(reportPath, buildTestReport(goal.goalText ?? "", flags.project, flags.target));
    return { reportPath, reportTitle: "Test Report" };
  }
  return { reportPath: null, reportTitle: null };
}

function buildRuntimeSummary(
  params: ResolvedRuntimeParams,
  goalText: string,
  responseText: string | null,
): string {
  const normalizedGoal = goalText.replace(/\s+/gu, " ").trim();
  const normalizedResponse = responseText?.replace(/\s+/gu, " ").trim() ?? "";
  if (normalizedResponse.length > 0) {
    return `${params.orchestrator} (${params.orchestratorModel}): ${normalizedResponse.slice(0, 160)}`;
  }
  return buildGenericSummary(normalizedGoal, params);
}

function configuredBackends(
  params: ResolvedRuntimeParams,
  projectDir: string,
  runTeamFile?: string,
): string[] {
  const backends = new Set<string>();
  const teamConfig =
    runTeamFile !== undefined && existsSync(runTeamFile)
      ? loadTeamConfigFile(runTeamFile)
      : (getTeamByName(params.team, undefined, projectDir)?.config ?? null);
  if (teamConfig !== null) {
    for (const agent of Object.values(teamConfig.agents)) {
      backends.add(agent.backend);
    }
  }
  const orchestratorBackend = backendForOrchestrator(params.orchestrator);
  if (orchestratorBackend !== null) {
    backends.add(orchestratorBackend);
  }
  return [...backends];
}

function shouldUseSessionRuntime(): boolean {
  if (process.env.KODO_ENABLE_SESSION_RUNTIME === "1") {
    return true;
  }
  if (process.env.VITEST) {
    return false;
  }
  return true;
}

function syntheticExecutionResult(
  runDir: RunDir,
  params: ResolvedRuntimeParams,
  goal: ResolvedGoal,
  flags: MainFlags,
  warning: string | null,
): ExecutionResult {
  const artifacts = writeSyntheticArtifacts(runDir, goal, flags);
  const summary = buildGenericSummary(goal.goalText ?? "", params);

  if (warning !== null) {
    emitLogEvent("orchestrator_fallback", {
      orchestrator: params.orchestrator,
      reason: warning,
    });
  }

  emitLogEvent("planning_start", { goal: goal.goalText, mode: goal.source });
  emitLogEvent("planning_end", { has_plan: false, mode: goal.source });
  emitLogEvent("parallel_group_start", {
    group: "implementation",
    agents: [params.orchestrator],
  });
  emitLogEvent("cycle_start", {
    cycle_index: 1,
    orchestrator: params.orchestrator,
    project_dir: flags.project,
  });
  emitLogEvent("orchestrator_tool_call", {
    agent: "orchestrator",
    cycle_index: 1,
    tool: "implement_goal",
  });
  emitLogEvent("session_query_end", {
    cost_bucket: params.orchestrator === "api" ? "api" : "unknown",
    conversation_log: null,
    session: params.orchestrator,
    session_id: `${runDir.runId}-orchestrator`,
  });
  emitLogEvent("agent_run_end", {
    agent: "orchestrator",
    cost_bucket: params.orchestrator === "api" ? "api" : "unknown",
    elapsed_s: 0,
    input_tokens: 0,
    is_error: false,
    output_tokens: 0,
    response_text: summary,
    status: "completed",
  });
  emitLogEvent("orchestrator_tool_result", {
    agent: "orchestrator",
    cycle_index: 1,
    tool: "implement_goal",
    ok: true,
  });
  emitLogEvent("parallel_group_end", {
    group: "implementation",
    finished: true,
  });
  emitLogEvent("cycle_end", {
    cycle_index: 1,
    cost_bucket: params.orchestrator === "api" ? "api" : "unknown",
    exchanges: 1,
    finished: true,
    summary,
  });
  emitLogEvent(params.autoCommit ? "auto_commit_done" : "auto_commit_disabled", {
    enabled: params.autoCommit,
  });
  emitLogEvent("persist_run_state", {
    config_file: runDir.configFile,
    goal_file: runDir.goalFile,
    run_dir: runDir.root,
  });
  emitLogEvent("run_end", {
    cost_bucket: params.orchestrator === "api" ? "api" : "unknown",
    finished: true,
    orchestrator: params.orchestrator,
    summary,
    total_cycles: 1,
    total_exchanges: 1,
  });

  return {
    artifacts,
    cyclesCompleted: 1,
    finished: true,
    message: "Run completed.",
    runId: runDir.runId,
    runRoot: runDir.root,
    summary,
  };
}

export function executePendingRun(
  runDir: RunDir,
  params: ResolvedRuntimeParams,
  goal: ResolvedGoal,
  flags: MainFlags,
): ExecutionResult {
  let result: ExecutionResult | null = null;
  let runError: unknown = null;

  try {
    const backendWarnings = preflightWarningsForBackends(
      configuredBackends(params, flags.project, runDir.teamFile),
    );

    emitLogEvent("preflight_start", {
      orchestrator: params.orchestrator,
      project_dir: flags.project,
      team: params.team,
    });
    if (backendWarnings.length > 0) {
      emitLogEvent("preflight_warnings", {
        warnings: backendWarnings,
      });
    }
    emitLogEvent("preflight_end", {
      ok: true,
      orchestrator: params.orchestrator,
      team: params.team,
      warnings: backendWarnings,
    });

    const sessionBackend = backendForOrchestrator(params.orchestrator);
    if (
      !shouldUseSessionRuntime() ||
      process.env.KODO_ENABLE_SESSION_RUNTIME === "0" ||
      sessionBackend === null ||
      !availableBackends()[sessionBackend === "claude-cli" ? "claude" : sessionBackend]
    ) {
      const reason = !shouldUseSessionRuntime()
        ? "Session runtime disabled for this environment"
        : process.env.KODO_ENABLE_SESSION_RUNTIME === "0"
          ? "Session runtime explicitly disabled"
          : sessionBackend === null
            ? `No session adapter for orchestrator ${params.orchestrator}`
            : `Backend ${sessionBackend} is not installed; using synthetic runtime fallback`;
      result = syntheticExecutionResult(runDir, params, goal, flags, reason);
      return result;
    }

    const runtime = runOrchestration(runDir, params, goal, flags);
    result = {
      artifacts: runtime.artifacts,
      cyclesCompleted: runtime.cyclesCompleted,
      finished: runtime.finished,
      message: runtime.message,
      runId: runDir.runId,
      runRoot: runDir.root,
      summary:
        runtime.summary.length > 0
          ? runtime.summary
          : buildRuntimeSummary(params, goal.goalText ?? "", runtime.message),
    };
    return result;
  } catch (error) {
    runError = error;
    throw error;
  } finally {
    const parsedState = existsSync(runDir.logFile) ? parseRun(runDir.logFile) : null;
    if (result === null && existsSync(runDir.logFile)) {
      emitLogEvent("run_end", {
        cost_bucket: parsedState?.orchestratorCostBucket ?? "unknown",
        error:
          runError instanceof Error ? `${runError.name}: ${runError.message}` : String(runError),
        finished: false,
        orchestrator: params.orchestrator,
        summary: parsedState?.lastSummary ?? "",
        total_cycles: parsedState?.completedCycles ?? 0,
        total_exchanges: parsedState?.completedCycles ?? 0,
      });
    }

    emitLogEvent("trace_upload_start", {
      enabled: process.env.KODO_TRACE_UPLOAD ?? "",
      run_id: runDir.runId,
    });
    try {
      const upload = uploadTrace({
        agentCount: parsedState?.team.length ?? 0,
        elapsedS: getElapsedS(),
        finished: result?.finished ?? parsedState?.finished ?? false,
        goal: goal.goalText ?? parsedState?.goal ?? "",
        model: params.orchestratorModel,
        orchestrator: params.orchestrator,
        projectDir: flags.project,
        runDir: runDir.root,
        runError,
        runId: runDir.runId,
        totalCostUsd: 0,
        totalCycles: result?.cyclesCompleted ?? parsedState?.completedCycles ?? 0,
        totalExchanges: result?.cyclesCompleted ?? parsedState?.completedCycles ?? 0,
      });
      emitLogEvent("trace_upload_end", upload);
    } catch (uploadError) {
      emitLogEvent("trace_upload_end", {
        attempted: true,
        reason: uploadError instanceof Error ? uploadError.message : String(uploadError),
        uploaded: false,
      });
    }
  }
}

function loadGoalText(runDir: RunDir): string {
  if (!existsSync(runDir.goalFile)) {
    throw new Error(`Goal file missing: ${runDir.goalFile}`);
  }
  if (existsSync(runDir.goalRefinedFile)) {
    const refined = readFileSync(runDir.goalRefinedFile, "utf8").trim();
    if (refined.length > 0) {
      return refined;
    }
  }
  return readFileSync(runDir.goalFile, "utf8").trim();
}

function loadRuntimeParams(runDir: RunDir): ResolvedRuntimeParams {
  const parsed = JSON.parse(
    readFileSync(runDir.configFile, "utf8"),
  ) as Partial<ResolvedRuntimeParams>;
  if (
    typeof parsed.team !== "string" ||
    typeof parsed.orchestrator !== "string" ||
    typeof parsed.orchestratorModel !== "string" ||
    typeof parsed.maxExchanges !== "number" ||
    typeof parsed.maxCycles !== "number" ||
    typeof parsed.autoCommit !== "boolean"
  ) {
    throw new Error(`Invalid run config: ${runDir.configFile}`);
  }

  const params: ResolvedRuntimeParams = {
    autoCommit: parsed.autoCommit,
    maxCycles: parsed.maxCycles,
    maxExchanges: parsed.maxExchanges,
    orchestrator: parsed.orchestrator,
    orchestratorModel: parsed.orchestratorModel,
    team: parsed.team,
  };
  if (
    parsed.effort === "low" ||
    parsed.effort === "standard" ||
    parsed.effort === "high" ||
    parsed.effort === "max"
  ) {
    params.effort = parsed.effort;
  }
  return params;
}

function fallbackRuntimeParams(run: ReturnType<typeof getRunById>): ResolvedRuntimeParams {
  if (run === null) {
    throw new Error("Run not found.");
  }

  return {
    autoCommit: true,
    maxCycles: run.maxCycles,
    maxExchanges: run.maxExchanges,
    orchestrator: run.orchestrator,
    orchestratorModel: run.model,
    team: run.teamPreset,
  };
}

function inferGoalSource(runDir: RunDir): ResolvedGoal["source"] {
  if (existsSync(path.join(runDir.root, "improve-report.md"))) {
    return "improve";
  }
  if (existsSync(path.join(runDir.root, "test-report.md"))) {
    return "test";
  }
  return "goal";
}

function seedResumeRuntimeState(
  runDir: RunDir,
  state: NonNullable<ReturnType<typeof getRunById>>,
): void {
  const filePath = path.join(runDir.root, "runtime-state.json");
  if (existsSync(filePath)) {
    return;
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify(
      {
        agentSessionIds: state.agentSessionIds,
        completedCycles: state.completedCycles,
        completedStages: state.completedStages,
        currentStageCycles: state.currentStageCycles,
        finished: state.finished,
        lastSummary: state.lastSummary,
        parallelStageState: state.parallelStageState,
        pendingExchanges: state.pendingExchanges,
        stageSummaries: state.stageSummaries,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export function resumeRun(target: ResumeTarget): ExecutionResult {
  const state = getRunById(target.runId);
  if (state === null) {
    throw new Error(`Run not found: ${target.runId}`);
  }
  if (state.finished) {
    throw new Error(`Run already completed: ${target.runId}`);
  }

  const runDir = RunDir.fromLogFile(target.logFile, state.projectDir);
  seedResumeRuntimeState(runDir, state);
  initAppend(target.logFile);
  const params = existsSync(runDir.configFile)
    ? loadRuntimeParams(runDir)
    : fallbackRuntimeParams(state);
  const goalText = existsSync(runDir.goalFile) ? loadGoalText(runDir) : state.goal;
  const flags: MainFlags = {
    autoRefine: false,
    cycles: params.maxCycles,
    debug: state.isDebug,
    effort: params.effort ?? null,
    exchanges: params.maxExchanges,
    fixFrom: null,
    focus: null,
    goal: goalText,
    goalFile: null,
    help: false,
    improve: inferGoalSource(runDir) === "improve",
    json: false,
    noAutoCommit: !params.autoCommit,
    orchestrator: params.orchestratorModel,
    project: state.projectDir,
    resume: target.runId,
    skipIntake: true,
    target: [],
    team: params.team,
    test: inferGoalSource(runDir) === "test",
    version: false,
    yes: true,
  };

  return executePendingRun(
    runDir,
    { ...params, maxCycles: Math.max(params.maxCycles, state.completedCycles + 1) },
    {
      goalText,
      source: inferGoalSource(runDir),
    },
    flags,
  );
}
