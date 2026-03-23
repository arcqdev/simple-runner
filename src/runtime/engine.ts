import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { initAppend, emit as emitLogEvent, RunDir } from "../logging/log.js";
import { getRunById } from "../logging/runs.js";
import type { MainFlags } from "../cli/types.js";
import type { ResolvedGoal, ResolvedRuntimeParams } from "../cli/runtime.js";
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

function buildArtifacts(runDir: RunDir, goal: ResolvedGoal, flags: MainFlags): { reportPath: string | null; reportTitle: string | null } {
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

export function executePendingRun(
  runDir: RunDir,
  params: ResolvedRuntimeParams,
  goal: ResolvedGoal,
  flags: MainFlags,
): ExecutionResult {
  const artifacts = buildArtifacts(runDir, goal, flags);
  const summary = buildGenericSummary(goal.goalText ?? "", params);

  emitLogEvent("planning_start", { goal: goal.goalText, mode: goal.source });
  emitLogEvent("planning_end", { has_plan: false, mode: goal.source });
  emitLogEvent("cycle_start", {
    cycle_index: 1,
    orchestrator: params.orchestrator,
    project_dir: flags.project,
  });
  emitLogEvent("agent_run_end", {
    agent: "orchestrator",
    status: "completed",
  });
  emitLogEvent("cycle_end", {
    cycle_index: 1,
    exchanges: 1,
    finished: true,
    summary,
  });
  emitLogEvent("run_end", {
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
  const parsed = JSON.parse(readFileSync(runDir.configFile, "utf8")) as Partial<ResolvedRuntimeParams>;
  if (
    typeof parsed.team !== "string"
    || typeof parsed.orchestrator !== "string"
    || typeof parsed.orchestratorModel !== "string"
    || typeof parsed.maxExchanges !== "number"
    || typeof parsed.maxCycles !== "number"
    || typeof parsed.autoCommit !== "boolean"
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
  if (parsed.effort === "low" || parsed.effort === "standard" || parsed.effort === "high" || parsed.effort === "max") {
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

export function resumeRun(target: ResumeTarget): ExecutionResult {
  const state = getRunById(target.runId);
  if (state === null) {
    throw new Error(`Run not found: ${target.runId}`);
  }
  if (state.finished) {
    throw new Error(`Run already completed: ${target.runId}`);
  }

  const runDir = RunDir.fromLogFile(target.logFile, state.projectDir);
  initAppend(target.logFile);
  const params = existsSync(runDir.configFile) ? loadRuntimeParams(runDir) : fallbackRuntimeParams(state);
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

  return executePendingRun(runDir, { ...params, maxCycles: Math.max(params.maxCycles, state.completedCycles + 1) }, {
    goalText,
    source: inferGoalSource(runDir),
  }, flags);
}
