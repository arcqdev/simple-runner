import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { loadDotEnv } from "../config/dotenv.js";
import {
  buildRuntimeTeamConfig,
  generateAutoTeam,
  getTeamByName,
  saveTeamConfig,
  type TeamConfig,
} from "../config/team-config.js";
import { CliError, EXIT_ERROR } from "../core/errors.js";
import { emit as emitLogEvent, init as initLog, RunDir } from "../logging/log.js";
import { VERSION } from "../core/version.js";
import { findIncompleteRuns, getRunById, runsRoot } from "../logging/runs.js";
import { executePendingRun, resumeRun } from "../runtime/engine.js";
import { availableBackends } from "../runtime/backends.js";
import { parseMainArgs, isHandledAsSubcommand } from "./params.js";
import { getPromptAdapter } from "./prompts.js";
import {
  buildImproveFallbackPlan,
  buildTestFallbackPlan,
  collectPriorNeedsDecision,
  collectPriorTestWork,
  extractFixableFindings,
  extractSection,
  formatImproveGoal,
  formatTestGoal,
  parseTestReportSummary,
  type SpecializedGoalPlan,
} from "./specialized.js";
import {
  findProjectGoalFile,
  offerInteractiveIntake,
  previewExistingGoal,
  runIntakeAuto,
  runIntakeNoninteractive,
} from "./intake.js";
import {
  loadOrResolveRuntimeParams,
  resolveGoal,
  type ResolvedGoal,
  type ResolvedRuntimeParams,
} from "./runtime.js";
import { handleSubcommand } from "./subcommands.js";
import type { ParsedMain } from "./types.js";
import { emitJson, printLines, setProgressOutput, writeStderr } from "./ui.js";

const HELP_TEXT = [
  "usage: simple-runner [-h] [--version] [--resume [RUN_ID]] [--goal GOAL | --goal-file GOAL_FILE | --improve | --test | --fix-from RUN_ID]",
  "            [--focus FOCUS] [--target TARGET] [--team TEAM] [--exchanges EXCHANGES] [--cycles CYCLES]",
  "            [--orchestrator ORCHESTRATOR] [--skip-intake] [--auto-refine] [--json] [--yes]",
  "            [--effort {low,standard,high,max}] [--no-auto-commit] [--debug] [--project PROJECT]",
  "",
  "simple-runner - autonomous multi-agent coding",
  "",
  "options:",
  "  -h, --help            show this help message and exit",
  "  --version             show program's version number and exit",
  "  --resume [RUN_ID]     Resume an interrupted run. No value = latest incomplete run.",
  "  --goal GOAL           Goal text (inline). Enables non-interactive mode.",
  "  --goal-file GOAL_FILE",
  "                        Path to a file containing the goal text. Enables non-interactive mode.",
  "  --improve             Code review: simplification, usability, architecture.",
  "  --test                Find bugs through realistic interaction and workflows.",
  "  --fix-from RUN_ID     Fix findings from a previous test or improve run.",
  "  --focus FOCUS         Short guidance on what to focus on during --improve or --test.",
  "  --target TARGET       File or directory to target for --test (repeatable).",
  "  --team TEAM           Team preset.",
  "  --exchanges EXCHANGES",
  "                        Max exchanges per cycle.",
  "  --cycles CYCLES       Max cycles.",
  "  --orchestrator ORCHESTRATOR, --orchestrator-model ORCHESTRATOR",
  "                        Orchestrator model.",
  "  --skip-intake         Skip intake interview, use goal as-is",
  "  --auto-refine         Auto-refine goal before implementation.",
  "  --json                Output structured JSON to stdout. Implies --yes.",
  "  --yes, -y             Skip all confirmation prompts.",
  "  --effort {low,standard,high,max}",
  "                        Effort level.",
  "  --no-auto-commit      Disable auto-commit after completed stages/goals.",
  "  --debug               Run with fully mocked backends.",
  "  --project PROJECT     Project directory (default: current directory).",
  "",
  "subcommands:",
  "  simple-runner test      Find bugs through realistic testing",
  "  simple-runner improve   Code review: simplification, usability, architecture",
  "  simple-runner runs      List all known runs",
  "  simple-runner logs      Open log viewer in browser",
  "  simple-runner issue     Report a bug (opens GitHub with run context)",
  "  simple-runner backends  List available backends and API keys",
  "  simple-runner teams     List, add, or edit team configurations",
  "  simple-runner update    Update simple-runner to the latest version",
];

function printHelp(): void {
  printLines(HELP_TEXT);
}

function printVersion(): void {
  printLines([`simple-runner ${VERSION}`]);
}

function printBanner(projectDir: string): void {
  printLines([
    "",
    `  simple-runner v${VERSION} - autonomous multi-agent coding`,
    "",
    `  Project: ${projectDir}`,
  ]);
}

function normalizeGoalText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new CliError("Goal text is empty.");
  }
  return trimmed;
}

function readInteractiveGoal(): string {
  const prompt = getPromptAdapter();
  const guided = prompt.multiline?.("What's your goal? (Empty line to finish, paste-friendly)");
  if (guided === null) {
    throw new CliError("Cancelled.");
  }
  if (guided !== undefined) {
    return normalizeGoalText(guided);
  }

  const fallback = prompt.text("Goal");
  if (fallback === null) {
    throw new CliError("Cancelled.");
  }
  return normalizeGoalText(fallback);
}

function resolveInteractiveGoal(projectDir: string): ResolvedGoal {
  const prompt = getPromptAdapter();
  const projectGoalFile = findProjectGoalFile(projectDir);
  if (projectGoalFile !== null) {
    const content = previewExistingGoal(projectGoalFile);
    if (content !== null) {
      const useExisting = prompt.confirm("Use this goal?", true);
      if (useExisting === null) {
        throw new CliError("Cancelled.");
      }
      if (useExisting) {
        return { goalText: content, source: "interactive" };
      }
    }
  }

  return { goalText: readInteractiveGoal(), source: "interactive" };
}

function printNextSteps(runDir: RunDir, goal: ResolvedGoal): void {
  const lines = ["", `  View run: simple-runner-viewer ${runDir.logFile}`];
  if (goal.source === "improve" && existsSync(path.join(runDir.root, "improve-report.md"))) {
    lines.push(`  Improve report: ${path.join(runDir.root, "improve-report.md")}`);
  }
  if (
    (goal.source === "test" || goal.source === "fix-from") &&
    existsSync(path.join(runDir.root, "test-report.md"))
  ) {
    lines.push(`  Test report: ${path.join(runDir.root, "test-report.md")}`);
  }
  if (goal.source === "improve" || goal.source === "test" || goal.source === "fix-from") {
    lines.push(`  Fix follow-ups: simple-runner --fix-from ${runDir.runId}`);
  }
  printLines(lines);
}

function resolveFixFromGoal(parsed: ParsedMain): ResolvedGoal {
  const runId = parsed.flags.fixFrom;
  if (runId === null) {
    throw new CliError("Internal error: missing --fix-from run id.");
  }

  const runRoot = path.join(runsRoot(), runId);
  for (const reportName of ["test-report.md", "improve-report.md"]) {
    const reportPath = path.join(runRoot, reportName);
    if (!existsSync(reportPath)) {
      continue;
    }
    const content = readFileSync(reportPath, "utf8");
    const findings = extractFixableFindings(content);
    if (findings.length === 0) {
      continue;
    }
    return {
      goalText: normalizeGoalText(
        [
          `Fix these findings from a previous simple-runner run (${runId}):`,
          "",
          findings.join("\n"),
          "",
          "For each finding, write a regression test that fails, then fix the code so the test passes.",
        ].join("\n"),
      ),
      source: "fix-from",
    };
  }

  throw new CliError(`No test or improve report with fixable findings found in run ${runId}`);
}

function buildModeGoal(
  parsed: ParsedMain,
  runDir: RunDir,
): {
  goal: ResolvedGoal;
  notices: string[];
  plan: SpecializedGoalPlan | null;
} {
  if (parsed.flags.improve) {
    const reportPath = path.join(runDir.root, "improve-report.md");
    const prior = collectPriorNeedsDecision(runDir);
    const notices = [
      ...(prior.length > 0 ? ["Carrying forward prior 'Needs decision' items."] : []),
      ...(parsed.flags.focus === null ? [] : [`Focus: ${parsed.flags.focus}`]),
      ...(parsed.flags.debug ? ["Debug mode; using default improve plan."] : []),
    ];
    return {
      goal: {
        goalText: normalizeGoalText(formatImproveGoal(reportPath, parsed.flags.focus)),
        source: "improve",
      },
      notices,
      plan: buildImproveFallbackPlan(reportPath, prior, parsed.flags.focus),
    };
  }

  if (parsed.flags.test) {
    const reportPath = path.join(runDir.root, "test-report.md");
    const prior = collectPriorTestWork(runDir);
    const notices = [
      ...(prior.length > 0 ? ["Carrying forward context from prior test runs."] : []),
      ...(parsed.flags.focus === null ? [] : [`Focus: ${parsed.flags.focus}`]),
      ...(parsed.flags.target.length === 0 ? [] : [`Targets: ${parsed.flags.target.join(", ")}`]),
      ...(parsed.flags.debug ? ["Debug mode; using default test plan."] : []),
    ];
    return {
      goal: {
        goalText: normalizeGoalText(
          formatTestGoal(reportPath, parsed.flags.focus, parsed.flags.target),
        ),
        source: "test",
      },
      notices,
      plan: buildTestFallbackPlan(reportPath, {
        focus: parsed.flags.focus,
        priorTestWork: prior,
        targets: parsed.flags.target,
      }),
    };
  }

  if (parsed.flags.fixFrom !== null) {
    return { goal: resolveFixFromGoal(parsed), notices: [], plan: null };
  }

  const goal = resolveGoal(parsed.flags);
  if (goal.goalText !== null) {
    const normalizedGoal = normalizeGoalText(goal.goalText);
    if (parsed.flags.autoRefine) {
      const refined = runIntakeAuto(runDir, normalizedGoal);
      return {
        goal: { ...goal, goalText: normalizeGoalText(refined.refinedGoal) },
        notices: refined.notices,
        plan: null,
      };
    }
    if (!parsed.flags.skipIntake) {
      const intake = runIntakeNoninteractive(runDir, normalizedGoal);
      return {
        goal: {
          ...goal,
          goalText: normalizedGoal,
        },
        notices: intake.notices,
        plan: intake.plan,
      };
    }
    return {
      goal: { ...goal, goalText: normalizedGoal },
      notices: ["Skipping intake; using the goal as provided."],
      plan: null,
    };
  }

  const interactiveGoal = resolveInteractiveGoal(parsed.flags.project);
  const normalizedGoal = normalizeGoalText(interactiveGoal.goalText ?? "");
  if (parsed.flags.skipIntake) {
    return {
      goal: { ...interactiveGoal, goalText: normalizedGoal },
      notices: ["Skipping intake; using the goal as provided."],
      plan: null,
    };
  }
  if (parsed.flags.autoRefine) {
    const refined = runIntakeAuto(runDir, normalizedGoal);
    return {
      goal: { ...interactiveGoal, goalText: normalizeGoalText(refined.refinedGoal) },
      notices: refined.notices,
      plan: null,
    };
  }

  const intake = offerInteractiveIntake(runDir, normalizedGoal);
  return {
    goal: {
      ...interactiveGoal,
      goalText:
        intake.plan !== null
          ? normalizedGoal
          : normalizeGoalText(intake.refinedGoal ?? normalizedGoal),
    },
    notices: intake.notices,
    plan: intake.plan,
  };
}

function teamAgentNames(teamName: string, projectDir: string): string[] {
  const team = getTeamByName(teamName, undefined, projectDir);
  return team === null ? [] : Object.keys(team.config.agents);
}

function resolveTeamConfigForLaunch(
  teamName: string,
  projectDir: string,
  options: { allowPrompt: boolean; autoApprove: boolean; jsonMode: boolean },
): TeamConfig {
  const listing = getTeamByName(teamName, undefined, projectDir);
  if (listing === null) {
    throw new CliError(`Unknown team: ${teamName}`);
  }

  try {
    return buildRuntimeTeamConfig(listing.config, listing.path).config;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("No agents available after checking backends")) {
      throw new CliError(`Invalid team config: ${message}`);
    }
    if (!Object.values(availableBackends()).some(Boolean)) {
      return listing.config;
    }

    const repair = (): TeamConfig => {
      const generated = generateAutoTeam(teamName);
      const savedPath = saveTeamConfig(teamName, generated.config);
      const resolved = buildRuntimeTeamConfig(generated.config, savedPath).config;
      const note = `Recovered team '${teamName}' by generating a runnable config at ${savedPath}.`;
      if (options.jsonMode) {
        writeStderr(`${note}\n`);
      } else {
        printLines(["", `  ${note}`]);
      }
      return resolved;
    };

    if (options.autoApprove) {
      return repair();
    }

    if (options.allowPrompt) {
      writeStderr(
        `Team '${teamName}' could not be built: ${message}\nThis usually means the configured worker backends are unavailable.\n`,
      );
      const confirmed = getPromptAdapter().confirm(
        "Run 'simple-runner teams auto' and retry with a generated working team?",
        true,
      );
      if (confirmed === null) {
        throw new CliError("Cancelled.");
      }
      if (confirmed) {
        return repair();
      }
    }

    throw new CliError(`Team '${teamName}' could not be built: ${message}`);
  }
}

function writeRunArtifacts(
  runDir: RunDir,
  params: ResolvedRuntimeParams,
  goal: ResolvedGoal,
  plan: SpecializedGoalPlan | null,
  teamConfig: TeamConfig,
): void {
  writeFileSync(runDir.configFile, `${JSON.stringify(params, null, 2)}\n`, "utf8");
  writeFileSync(runDir.goalFile, `${goal.goalText ?? ""}\n`, "utf8");
  if (goal.source !== "interactive" && !existsSync(runDir.goalRefinedFile)) {
    writeFileSync(runDir.goalRefinedFile, `${goal.goalText ?? ""}\n`, "utf8");
  }
  if (plan !== null) {
    writeFileSync(runDir.goalPlanFile, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  }
  writeFileSync(runDir.teamFile, `${JSON.stringify(teamConfig, null, 2)}\n`, "utf8");
}

function createPendingRun(parsed: ParsedMain): {
  goal: ResolvedGoal;
  notices: string[];
  params: ResolvedRuntimeParams;
  runDir: RunDir;
} {
  const params = loadOrResolveRuntimeParams(parsed.flags);
  const runDir = RunDir.create(parsed.flags.project);
  const { goal, notices, plan } = buildModeGoal(parsed, runDir);
  const nonInteractiveLaunch =
    parsed.flags.goal !== null ||
    parsed.flags.goalFile !== null ||
    parsed.flags.improve ||
    parsed.flags.test ||
    parsed.flags.fixFrom !== null;
  const resolvedTeamConfig = resolveTeamConfigForLaunch(params.team, parsed.flags.project, {
    allowPrompt: !parsed.flags.yes && !parsed.flags.json,
    autoApprove: parsed.flags.yes || parsed.flags.json || nonInteractiveLaunch,
    jsonMode: parsed.flags.json,
  });
  writeRunArtifacts(runDir, params, goal, plan, resolvedTeamConfig);
  initLog(runDir);
  emitLogEvent("cli_args", {
    ...params,
    debug: parsed.flags.debug,
    goal_text: goal.goalText,
    has_plan: plan !== null,
    project_dir: parsed.flags.project,
  });
  emitLogEvent("run_start", {
    goal: goal.goalText,
    has_stages: plan !== null,
    max_cycles: params.maxCycles,
    max_exchanges: params.maxExchanges,
    model: params.orchestratorModel,
    orchestrator: params.orchestrator,
    project_dir: parsed.flags.project,
    team: teamAgentNames(params.team, parsed.flags.project),
  });
  if (parsed.flags.debug) {
    emitLogEvent("debug_run_start");
  }

  return { goal, notices, params, runDir };
}

function summarizeReport(
  runDir: RunDir,
  goal: ResolvedGoal,
  jsonMode: boolean,
): Record<string, unknown> {
  if (goal.source === "improve") {
    const reportPath = path.join(runDir.root, "improve-report.md");
    if (!existsSync(reportPath)) {
      return {};
    }
    const reportContent = readFileSync(reportPath, "utf8");
    const autoFixed = (extractSection(reportContent, "Auto-fixed").match(/^- .+$/gmu) ?? []).length;
    const needsDecision = (extractSection(reportContent, "Needs decision").match(/^- .+$/gmu) ?? [])
      .length;

    if (!jsonMode) {
      printLines([
        "",
        "=".repeat(50),
        `Improve report: ${reportPath}`,
        `  Auto-fixed:     ${autoFixed}`,
        `  Needs decision: ${needsDecision}`,
        ...(needsDecision > 0
          ? ["", "  To fix 'needs decision' items:", `    simple-runner --fix-from ${runDir.runId}`]
          : []),
      ]);
    }

    return {
      improve_report: reportContent,
      improve_report_summary: {
        auto_fixed: autoFixed,
        needs_decision: needsDecision,
      },
    };
  }

  if (goal.source === "test" || goal.source === "fix-from") {
    const reportPath = path.join(runDir.root, "test-report.md");
    if (!existsSync(reportPath)) {
      return {};
    }
    const reportContent = readFileSync(reportPath, "utf8");
    const summary = parseTestReportSummary(reportContent);
    const fixable = (summary.findings_count ?? summary.findings_item_count) - summary.blocked_count;

    if (!jsonMode) {
      printLines([
        "",
        "=".repeat(50),
        `Test report: ${reportPath}`,
        ...((summary.findings_count ?? 0) > 0
          ? [`  Findings:         ${summary.findings_count}`]
          : []),
        ...((summary.regression_tests ?? summary.regression_count) > 0
          ? [`  Regression tests: ${summary.regression_tests ?? summary.regression_count}`]
          : []),
        ...(summary.blocked_count > 0 ? [`  Blocked:          ${summary.blocked_count}`] : []),
        ...summary.blocked_details.map((detail) => `    ${detail}`),
        ...(fixable > 0
          ? ["", "  To fix these findings:", `    simple-runner --fix-from ${runDir.runId}`]
          : []),
      ]);
    }

    return {
      test_report: reportContent,
      test_report_summary: summary,
    };
  }

  return {};
}

function summarizeMainInvocation(parsed: ParsedMain): void {
  const { goal, notices, params, runDir } = createPendingRun(parsed);
  if (!parsed.flags.json) {
    printBanner(parsed.flags.project);
  }
  const result = executePendingRun(runDir, params, goal, parsed.flags);
  const reportSummary = summarizeReport(runDir, goal, parsed.flags.json);
  const stages = existsSync(runDir.goalPlanFile)
    ? (
        (
          JSON.parse(readFileSync(runDir.goalPlanFile, "utf8")) as {
            stages?: SpecializedGoalPlan["stages"];
          }
        ).stages ?? []
      ).map((stage) => ({
        cycles: 0,
        finished: true,
        index: stage.index,
        name: stage.name,
        summary: stage.description,
      }))
    : [];
  const summary = {
    status: result.finished ? "completed" : "partial",
    cost_usd: 0,
    command: parsed.command,
    cycles: result.cyclesCompleted,
    cycles_completed: result.cyclesCompleted,
    exchanges: result.cyclesCompleted,
    finished: result.finished,
    goal_source: goal.source,
    goal_text: goal.goalText,
    params,
    focus: parsed.flags.focus,
    log_file: runDir.logFile,
    report_path: result.artifacts.reportPath,
    run_id: runDir.runId,
    run_root: runDir.root,
    stages,
    summary: result.summary,
    targets: parsed.flags.target,
    message: result.message,
    ...reportSummary,
  };

  if (parsed.flags.json) {
    if (notices.length > 0) {
      printLines(notices.map((notice) => `  ${notice}`));
    }
    printLines([result.message]);
    emitJson(summary);
    return;
  }

  printLines([
    ...notices.map((notice) => `  ${notice}`),
    ...(notices.length > 0 ? [""] : []),
    result.message,
    "",
    `Run ID: ${runDir.runId}`,
    `Run dir: ${runDir.root}`,
    `Log file: ${runDir.logFile}`,
    `Mode: ${parsed.command}`,
    `Project: ${parsed.flags.project}`,
    `Team: ${params.team}`,
    `Orchestrator: ${params.orchestrator} (${params.orchestratorModel})`,
    `Budget: ${params.maxExchanges} exchanges/cycle, ${params.maxCycles} cycles`,
    `Auto-commit: ${params.autoCommit ? "enabled" : "disabled"}`,
    ...(result.artifacts.reportPath === null
      ? []
      : [`Report path: ${result.artifacts.reportPath}`]),
    ...(parsed.flags.focus === null ? [] : [`Focus: ${parsed.flags.focus}`]),
    ...(parsed.flags.target.length === 0 ? [] : [`Targets: ${parsed.flags.target.join(", ")}`]),
    `Goal source: ${goal.source}`,
    ...(goal.goalText === null ? [] : [`Goal: ${goal.goalText.replace(/\s+/gu, " ").trim()}`]),
    `Summary: ${result.summary}`,
  ]);
  printNextSteps(runDir, goal);
}

function resolveResumeRun(parsed: ParsedMain): { logFile: string; runId: string } {
  const project = parsed.flags.project;
  if (parsed.flags.resume === "__latest__") {
    const runs = findIncompleteRuns(project);
    if (runs.length === 0) {
      throw new CliError("No incomplete runs found.");
    }
    if (runs.length === 1 || parsed.flags.yes || parsed.flags.json) {
      return { logFile: runs[0].logFile, runId: runs[0].runId };
    }

    const choices = runs.map(
      (run) => `${run.runId}  ${run.goal.replace(/\s+/gu, " ").slice(0, 50)}`,
    );
    const selected = getPromptAdapter().select("Select run to resume:", choices, choices[0]);
    if (selected === null) {
      throw new CliError("Cancelled.");
    }
    const runId = selected.split(/\s+/u, 1)[0];
    const run = runs.find((candidate) => candidate.runId === runId);
    if (run === undefined) {
      throw new CliError(`Run not found: ${runId}`);
    }
    return { logFile: run.logFile, runId: run.runId };
  }

  const run = getRunById(parsed.flags.resume ?? "");
  if (run === null) {
    throw new CliError(`Run not found: ${parsed.flags.resume}`);
  }
  return { logFile: run.logFile, runId: run.runId };
}

function emitError(error: unknown, jsonMode: boolean): number {
  if (error instanceof CliError) {
    if (jsonMode && error.exposeAsJson) {
      emitJson({ status: "error", error: error.message });
    } else {
      writeStderr(`${error.message}\n`);
    }
    return error.exitCode;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (jsonMode) {
    emitJson({ status: "error", error: message });
  } else {
    writeStderr(`${message}\n`);
  }
  return EXIT_ERROR;
}

export function runCli(argv = process.argv.slice(2)): number {
  loadDotEnv();
  const jsonMode = argv.includes("--json");
  setProgressOutput(jsonMode ? "stderr" : "stdout");

  try {
    if (argv.length === 0) {
      printHelp();
      return 0;
    }

    const first = argv[0];
    if (isHandledAsSubcommand(first)) {
      const result = handleSubcommand(first, argv.slice(1));
      if (result === -1) {
        printHelp();
        return 0;
      }
      return result;
    }

    const rewritten =
      first === "test" || first === "improve" ? [`--${first}`, ...argv.slice(1)] : argv;
    const parsed = parseMainArgs(rewritten);

    if (parsed.flags.version) {
      printVersion();
      return 0;
    }
    if (parsed.flags.help) {
      if (parsed.flags.json) {
        emitJson({
          status: "ok",
          version: VERSION,
          subcommands: ["test", "improve", "runs", "logs", "issue", "backends", "teams", "update"],
        });
      } else {
        printHelp();
      }
      return 0;
    }

    if (parsed.command === "resume") {
      const run = resolveResumeRun(parsed);
      const result = resumeRun(run);
      if (parsed.flags.json) {
        emitJson({
          log_file: run.logFile,
          run_id: run.runId,
          status: result.finished ? "completed" : "partial",
          message: result.message,
          summary: result.summary,
        });
      } else {
        printBanner(parsed.flags.project);
        printLines([
          result.message,
          "",
          `Run ID: ${run.runId}`,
          `Log file: ${run.logFile}`,
          `Summary: ${result.summary}`,
        ]);
        printLines(["", `  View run: simple-runner-viewer ${run.logFile}`]);
      }
      return 0;
    }

    summarizeMainInvocation(parsed);
    return 0;
  } catch (error) {
    return emitError(error, jsonMode);
  } finally {
    setProgressOutput("stdout");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli();
}
