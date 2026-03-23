import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { getTeamByName } from "../config/team-config.js";
import { CliError, EXIT_ERROR } from "../core/errors.js";
import { emit as emitLogEvent, init as initLog, RunDir } from "../logging/log.js";
import { VERSION } from "../core/version.js";
import { findIncompleteRuns, getRunById, runsRoot } from "../logging/runs.js";
import { parseMainArgs, isHandledAsSubcommand } from "./params.js";
import { getPromptAdapter } from "./prompts.js";
import { loadOrResolveRuntimeParams, resolveGoal, type ResolvedGoal, type ResolvedRuntimeParams } from "./runtime.js";
import { handleSubcommand } from "./subcommands.js";
import type { ParsedMain } from "./types.js";
import { emitJson, printLines, writeStderr } from "./ui.js";

const HELP_TEXT = [
  "usage: kodo [-h] [--version] [--resume [RUN_ID]] [--goal GOAL | --goal-file GOAL_FILE | --improve | --test | --fix-from RUN_ID]",
  "            [--focus FOCUS] [--target TARGET] [--team TEAM] [--exchanges EXCHANGES] [--cycles CYCLES]",
  "            [--orchestrator ORCHESTRATOR] [--skip-intake] [--auto-refine] [--json] [--yes]",
  "            [--effort {low,standard,high,max}] [--no-auto-commit] [--debug] [--project PROJECT]",
  "",
  "kodo - autonomous multi-agent coding",
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
  "  kodo test      Find bugs through realistic testing",
  "  kodo improve   Code review: simplification, usability, architecture",
  "  kodo runs      List all known runs",
  "  kodo logs      Open log viewer in browser",
  "  kodo issue     Report a bug (opens GitHub with run context)",
  "  kodo backends  List available backends and API keys",
  "  kodo teams     List, add, or edit team configurations",
  "  kodo update    Update kodo to the latest version",
];

function printHelp(): void {
  printLines(HELP_TEXT);
}

function printVersion(): void {
  printLines([`kodo ${VERSION}`]);
}

function normalizeGoalText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new CliError("Goal text is empty.");
  }
  return trimmed;
}

function extractSection(report: string, heading: string): string {
  const lines = report.split(/\r?\n/gu);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) {
    return "";
  }

  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith("## ")) {
      break;
    }
    body.push(lines[index]);
  }
  return body.join("\n").trim();
}

function extractFindingsFromReport(report: string): string[] {
  const sections = ["Critical Findings", "Integration & Workflow Findings", "Usability Gaps", "Needs decision"];
  return sections.flatMap((section) =>
    extractSection(report, section)
      .split(/\r?\n/gu)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- ")),
  );
}

function resolveInteractiveGoal(projectDir: string): ResolvedGoal {
  const prompt = getPromptAdapter();
  const projectGoalFile = path.join(projectDir, "goal.md");
  if (existsSync(projectGoalFile)) {
    try {
      const content = normalizeGoalText(readFileSync(projectGoalFile, "utf8"));
      const useExisting = prompt.confirm(`Use existing goal from ${projectGoalFile}?`, true);
      if (useExisting === null) {
        throw new CliError("Cancelled.");
      }
      if (useExisting) {
        return { goalText: content, source: "interactive" };
      }
    } catch (error) {
      if (error instanceof CliError) {
        throw error;
      }
    }
  }

  const goalText = prompt.text("Goal");
  if (goalText === null) {
    throw new CliError("Cancelled.");
  }
  return { goalText: normalizeGoalText(goalText), source: "interactive" };
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
    const findings = extractFindingsFromReport(content);
    if (findings.length === 0) {
      continue;
    }
    return {
      goalText: normalizeGoalText(
        [
          `Fix these findings from a previous kodo run (${runId}):`,
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

function buildModeGoal(parsed: ParsedMain, runDir: RunDir): ResolvedGoal {
  if (parsed.flags.improve) {
    const reportPath = path.join(runDir.root, "improve-report.md");
    const focusLine = parsed.flags.focus ? `\n\nFocus area: ${parsed.flags.focus}` : "";
    return {
      goalText: normalizeGoalText(
        `Review this project for simplification, usability, and architecture improvements. Write the report to ${reportPath}.${focusLine}`,
      ),
      source: "improve",
    };
  }

  if (parsed.flags.test) {
    const reportPath = path.join(runDir.root, "test-report.md");
    const focusLine = parsed.flags.focus ? `\n\nFocus area: ${parsed.flags.focus}` : "";
    const targetLine = parsed.flags.target.length > 0 ? `\n\nTargets: ${parsed.flags.target.join(", ")}` : "";
    return {
      goalText: normalizeGoalText(
        `Test this project through realistic workflows, edge cases, and regressions. Write the report to ${reportPath}.${focusLine}${targetLine}`,
      ),
      source: "test",
    };
  }

  if (parsed.flags.fixFrom !== null) {
    return resolveFixFromGoal(parsed);
  }

  const goal = resolveGoal(parsed.flags);
  if (goal.goalText !== null) {
    return { ...goal, goalText: normalizeGoalText(goal.goalText) };
  }
  return resolveInteractiveGoal(parsed.flags.project);
}

function teamAgentNames(teamName: string): string[] {
  const team = getTeamByName(teamName);
  return team === null ? [] : Object.keys(team.config.agents);
}

function writeRunArtifacts(runDir: RunDir, params: ResolvedRuntimeParams, goal: ResolvedGoal): void {
  writeFileSync(runDir.configFile, `${JSON.stringify(params, null, 2)}\n`, "utf8");
  writeFileSync(runDir.goalFile, `${goal.goalText ?? ""}\n`, "utf8");
  if (goal.source !== "interactive") {
    writeFileSync(runDir.goalRefinedFile, `${goal.goalText ?? ""}\n`, "utf8");
  }

  const team = getTeamByName(params.team);
  if (team !== null) {
    writeFileSync(runDir.teamFile, `${JSON.stringify(team.config, null, 2)}\n`, "utf8");
  }
}

function createPendingRun(parsed: ParsedMain): {
  goal: ResolvedGoal;
  params: ResolvedRuntimeParams;
  runDir: RunDir;
} {
  const params = loadOrResolveRuntimeParams(parsed.flags);
  const runDir = RunDir.create(parsed.flags.project);
  const goal = buildModeGoal(parsed, runDir);
  writeRunArtifacts(runDir, params, goal);
  initLog(runDir);
  emitLogEvent("cli_args", {
    ...params,
    debug: parsed.flags.debug,
    goal_text: goal.goalText,
    has_plan: false,
    project_dir: parsed.flags.project,
  });
  emitLogEvent("run_start", {
    goal: goal.goalText,
    has_stages: false,
    max_cycles: params.maxCycles,
    max_exchanges: params.maxExchanges,
    model: params.orchestratorModel,
    orchestrator: params.orchestrator,
    project_dir: parsed.flags.project,
    team: teamAgentNames(params.team),
  });
  if (parsed.flags.debug) {
    emitLogEvent("debug_run_start");
  }

  return { goal, params, runDir };
}

function summarizeMainInvocation(parsed: ParsedMain): void {
  const { goal, params, runDir } = createPendingRun(parsed);
  const reportPath = parsed.flags.improve
    ? path.join(runDir.root, "improve-report.md")
    : parsed.flags.test
      ? path.join(runDir.root, "test-report.md")
      : null;
  const summary = {
    status: "pending",
    command: parsed.command,
    goal_source: goal.source,
    goal_text: goal.goalText,
    params,
    focus: parsed.flags.focus,
    log_file: runDir.logFile,
    report_path: reportPath,
    run_id: runDir.runId,
    run_root: runDir.root,
    targets: parsed.flags.target,
    message: "Pending run scaffold created.",
  };

  if (parsed.flags.json) {
    emitJson(summary);
    return;
  }

  printLines([
    "Pending run scaffold created.",
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
    ...(reportPath === null ? [] : [`Report path: ${reportPath}`]),
    ...(parsed.flags.focus === null ? [] : [`Focus: ${parsed.flags.focus}`]),
    ...(parsed.flags.target.length === 0 ? [] : [`Targets: ${parsed.flags.target.join(", ")}`]),
    `Goal source: ${goal.source}`,
    ...(goal.goalText === null ? [] : [`Goal: ${goal.goalText.replace(/\s+/gu, " ").trim()}`]),
  ]);
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

    const choices = runs.map((run) => `${run.runId}  ${run.goal.replace(/\s+/gu, " ").slice(0, 50)}`);
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
  const jsonMode = argv.includes("--json");

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

    const rewritten = first === "test" || first === "improve" ? [`--${first}`, ...argv.slice(1)] : argv;
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
      if (parsed.flags.json) {
        emitJson({
          log_file: run.logFile,
          run_id: run.runId,
          status: "pending",
          message: "Resume target resolved.",
        });
      } else {
        printLines([
          "Resume target resolved.",
          "",
          `Run ID: ${run.runId}`,
          `Log file: ${run.logFile}`,
        ]);
      }
      return 0;
    }

    summarizeMainInvocation(parsed);
    return 0;
  } catch (error) {
    return emitError(error, jsonMode);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli();
}
