import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { MainFlags } from "../cli/types.js";
import type { ResolvedGoal, ResolvedRuntimeParams } from "../cli/runtime.js";
import {
  type TeamAgentConfig,
  type TeamConfig,
  getTeamByName,
  TEAM_BACKEND_MAP,
} from "../config/team-config.js";
import { emit as emitLogEvent, type RunDir } from "../logging/log.js";
import { availableBackends } from "./backends.js";
import {
  createSessionForOrchestrator,
  createSessionForTeamAgent,
  type Session,
} from "./sessions.js";
import { readRunStatus, writeRunStatus } from "./run-status.js";

type VerificationGroups = {
  browserTesterNames: string[];
  reviewerNames: string[];
  testerNames: string[];
};

type RuntimeState = {
  agentSessionIds: Record<string, string>;
  completedCycles: number;
  completedStages: number[];
  currentStageCycles: number;
  finished: boolean;
  lastSummary: string;
  stageSummaries: string[];
};

type GoalStage = {
  acceptance_criteria?: string;
  browser_testing?: boolean;
  description: string;
  index: number;
  name: string;
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

const DONE_ACCEPT = /(ALL CHECKS PASS|MINOR ISSUES FIXED)/iu;
const DONE_REJECT = /(NOT ALL CHECKS PASS|NOT MINOR ISSUES FIXED)/iu;
const GIT_AUTHOR_ENV = {
  GIT_AUTHOR_EMAIL: "noreply@github.com",
  GIT_AUTHOR_NAME: "kodo",
  GIT_COMMITTER_EMAIL: "noreply@github.com",
  GIT_COMMITTER_NAME: "kodo",
};

function fallbackWorkerBackend(orchestrator: string): TeamAgentConfig["backend"] {
  switch (orchestrator) {
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

function runtimeStatePath(runDir: RunDir): string {
  return path.join(runDir.root, "runtime-state.json");
}

function defaultState(): RuntimeState {
  return {
    agentSessionIds: {},
    completedCycles: 0,
    completedStages: [],
    currentStageCycles: 0,
    finished: false,
    lastSummary: "",
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
      completedCycles: parsed.completedCycles ?? 0,
      completedStages: parsed.completedStages ?? [],
      currentStageCycles: parsed.currentStageCycles ?? 0,
      finished: parsed.finished ?? false,
      lastSummary: parsed.lastSummary ?? "",
      stageSummaries: parsed.stageSummaries ?? [],
    };
  } catch {
    return defaultState();
  }
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

function composeStageGoal(plan: GoalPlan, stage: GoalStage, completedSummaries: string[]): string {
  const parts = [`# Project Context\n${plan.context}`];
  if (completedSummaries.length > 0) {
    parts.push("# Completed Stages");
    for (const [index, summary] of completedSummaries.entries()) {
      parts.push(`## Stage ${index + 1}\n${summary}`);
    }
  }
  parts.push(`# Current Stage (${stage.index}/${plan.stages.length}): ${stage.name}\n${stage.description}`);
  if (stage.acceptance_criteria) {
    parts.push(`## Acceptance Criteria\n${stage.acceptance_criteria}`);
  }
  return parts.join("\n\n");
}

function parseDoneDirective(text: string): { summary: string; terminal: "end_cycle" | "goal_done" | "raise_issue" } {
  const trimmed = text.trim();
  const lines = trimmed.split(/\r?\n/gu).map((line) => line.trim());
  for (const line of lines) {
    if (line.startsWith("GOAL_DONE:")) {
      return { summary: line.slice("GOAL_DONE:".length).trim() || trimmed, terminal: "goal_done" };
    }
    if (line.startsWith("END_CYCLE:")) {
      return { summary: line.slice("END_CYCLE:".length).trim() || trimmed, terminal: "end_cycle" };
    }
    if (line.startsWith("RAISE_ISSUE:")) {
      return { summary: line.slice("RAISE_ISSUE:".length).trim() || trimmed, terminal: "raise_issue" };
    }
  }
  return { summary: trimmed, terminal: "end_cycle" };
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

function buildVerificationPrompt(goal: string, summary: string, acceptanceCriteria?: string): string {
  return [
    "The implementation agent claims this work is complete.",
    "",
    "# Goal",
    goal,
    "",
    "# Claimed Summary",
    summary,
    ...(acceptanceCriteria ? ["", "# Acceptance Criteria", acceptanceCriteria] : []),
    "",
    "Verify the repository state honestly.",
    "If the work is acceptable, include ALL CHECKS PASS.",
    "If there are issues, explain them clearly and do not include the pass signal.",
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
  return key !== "" && availableBackends()[key];
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
  params: ResolvedRuntimeParams,
  flags: MainFlags,
  state: RuntimeState,
): {
  allAgents: RuntimeAgent[];
  reviewerAgents: RuntimeAgent[];
  workerAgents: RuntimeAgent[];
} {
  const listing = getTeamByName(params.team, undefined, flags.project);
  if (listing === null) {
    throw new Error(`Team not found: ${params.team}`);
  }

  const groups = verificationGroups(listing.config);
  const configuredWorkers = workerNames(listing.config, groups);
  const runtimeAgents = new Map<string, RuntimeAgent>();

  for (const [name, agentConfig] of Object.entries(listing.config.agents)) {
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
        reason: "No available worker backends in selected team; using orchestrator backend as worker",
      });
    }
  }

  const reviewerAgents = [...groups.testerNames, ...groups.browserTesterNames, ...groups.reviewerNames]
    .map((name) => runtimeAgents.get(name))
    .filter((agent): agent is RuntimeAgent => agent !== undefined);

  return {
    allAgents: [...runtimeAgents.values(), ...workerAgents.filter((agent) => !runtimeAgents.has(agent.name))],
    reviewerAgents,
    workerAgents,
  };
}

function verificationPassed(report: string): boolean {
  return DONE_ACCEPT.test(report) && !DONE_REJECT.test(report);
}

function runVerification(
  agents: RuntimeAgent[],
  goal: string,
  summary: string,
  projectDir: string,
  cycleIndex: number,
  acceptanceCriteria?: string,
): string | null {
  const issues: string[] = [];
  if (agents.length === 0) {
    return null;
  }

  emitLogEvent("orchestrator_done_attempt", {
    cycle_index: cycleIndex,
    summary,
  });

  const prompt = buildVerificationPrompt(goal, summary, acceptanceCriteria);
  for (const agent of agents) {
    const response = agent.session.query(prompt, {
      maxTurns: agent.config.max_turns ?? 8,
      projectDir,
    });
    emitLogEvent("done_verification", {
      agent: agent.name,
      report: response.text.slice(0, 5000),
    });
    emitLogEvent("agent_run_end", {
      agent: agent.name,
      status: response.isError ? "failed" : "completed",
    });
    if (response.isError || !verificationPassed(response.text)) {
      issues.push(`**${agent.name} found issues:**\n${response.text.slice(0, 3000)}`);
    }
  }

  return issues.length > 0 ? issues.join("\n\n") : null;
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
    const message = `kodo: ${summary.replace(/\s+/gu, " ").trim().slice(0, 72)}`;
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

function runSingleGoal(
  runDir: RunDir,
  params: ResolvedRuntimeParams,
  goalText: string,
  flags: MainFlags,
  state: RuntimeState,
  acceptCriteria?: string,
  stageLabel?: string,
): OrchestrationResult {
  const { allAgents, reviewerAgents, workerAgents } = collectRuntimeAgents(params, flags, state);
  if (workerAgents.length === 0) {
    closeAgents(allAgents);
    throw new Error("No runnable workers available for the selected team.");
  }

  let priorSummary = state.lastSummary;
  try {
    for (let cycleIndex = state.completedCycles + 1; cycleIndex <= params.maxCycles; cycleIndex += 1) {
      state.currentStageCycles += 1;
      writeRunStatus(flags.project, goalText, {
        cycleNum: state.currentStageCycles,
        maxCycles: params.maxCycles,
        stageLabel,
      });
      emitLogEvent("cycle_start", {
        cycle_index: cycleIndex,
        orchestrator: params.orchestrator,
        project_dir: flags.project,
      });

      const worker = workerAgents[(cycleIndex - 1) % workerAgents.length];
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

      const response = worker.session.query(
        buildWorkerPrompt(goalText, flags.project, priorSummary, worker, cycleIndex),
        {
          maxTurns: worker.config.max_turns ?? params.maxExchanges,
          projectDir: flags.project,
        },
      );
      emitLogEvent("orchestrator_tool_result", {
        agent: worker.name,
        cycle_index: cycleIndex,
        ok: !response.isError,
        tool: "implement_goal",
      });
      emitLogEvent("agent_run_end", {
        agent: worker.name,
        status: response.isError ? "failed" : "completed",
      });

      state.agentSessionIds[worker.name] = worker.session.sessionId ?? state.agentSessionIds[worker.name] ?? "";
      const directive = parseDoneDirective(response.text);
      let finished = false;
      let summary = cycleSummary(directive.summary || response.text);

      if (response.isError) {
        emitLogEvent("orchestrator_response", {
          done_called: false,
          is_error: true,
          orchestrator: params.orchestrator,
          result_text: response.text.slice(0, 2000),
        });
      } else if (directive.terminal === "goal_done") {
        const verificationIssues = runVerification(
          reviewerAgents,
          goalText,
          summary,
          flags.project,
          cycleIndex,
          acceptCriteria,
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
      } else if (directive.terminal === "raise_issue") {
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
        exchanges: 1,
        finished,
        summary,
      });

      state.completedCycles = cycleIndex;
      state.lastSummary = summary;
      priorSummary = summary;
      persistRuntimeState(runDir, state);

      if (finished) {
        maybeAutoCommit(flags.project, params.autoCommit, summary);
        state.finished = true;
        return {
          cyclesCompleted: state.completedCycles,
          finished: true,
          message: directive.terminal === "raise_issue" ? "Run failed." : "Run completed.",
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

function runPlan(
  runDir: RunDir,
  params: ResolvedRuntimeParams,
  goal: ResolvedGoal,
  flags: MainFlags,
  state: RuntimeState,
  plan: GoalPlan,
): OrchestrationResult {
  emitLogEvent("planning_start", { goal: goal.goalText, mode: goal.source });
  emitLogEvent("planning_end", { has_plan: true, mode: goal.source, num_stages: plan.stages.length });

  let summary = state.lastSummary;
  for (const stage of plan.stages) {
    if (state.completedStages.includes(stage.index)) {
      continue;
    }
    emitLogEvent("stage_start", {
      stage_index: stage.index,
      stage_name: stage.name,
      max_cycles: params.maxCycles,
    });
    const stageGoal = composeStageGoal(plan, stage, state.stageSummaries);
    const result = runSingleGoal(
      runDir,
      params,
      stageGoal,
      flags,
      state,
      stage.acceptance_criteria,
      `${stage.index}/${plan.stages.length}: ${stage.name}`,
    );
    summary = result.summary;
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
    persistRuntimeState(runDir, state);
    emitLogEvent("stage_end", {
      cycles_used: state.completedCycles,
      finished: true,
      stage_index: stage.index,
      stage_name: stage.name,
      summary,
    });
  }

  state.finished = true;
  persistRuntimeState(runDir, state);
  return {
    cyclesCompleted: state.completedCycles,
    finished: true,
    message: "Run completed.",
    summary,
  };
}

export function runOrchestration(
  runDir: RunDir,
  params: ResolvedRuntimeParams,
  goal: ResolvedGoal,
  flags: MainFlags,
): OrchestrationResult & { artifacts: OrchestrationArtifacts } {
  const state = loadRuntimeState(runDir);
  const artifacts = expectedArtifacts(runDir, goal);
  const plan = loadGoalPlan(runDir);

  emitLogEvent("run_start", {
    goal: goal.goalText,
    has_stages: plan !== null,
    max_cycles: params.maxCycles,
    max_exchanges: params.maxExchanges,
    model: params.orchestratorModel,
    num_stages: plan?.stages.length ?? 0,
    orchestrator: params.orchestrator,
    project_dir: flags.project,
  });

  const result =
    plan === null
      ? (() => {
          emitLogEvent("planning_start", { goal: goal.goalText, mode: goal.source });
          emitLogEvent("planning_end", { has_plan: false, mode: goal.source });
          return runSingleGoal(runDir, params, goal.goalText ?? "", flags, state);
        })()
      : runPlan(runDir, params, goal, flags, state, plan);

  emitLogEvent("run_end", {
    finished: result.finished,
    orchestrator: params.orchestrator,
    summary: result.summary,
    total_cycles: result.cyclesCompleted,
    total_exchanges: result.cyclesCompleted,
  });

  return {
    ...result,
    artifacts,
  };
}
