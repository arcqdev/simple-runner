import process from "node:process";
import { pathToFileURL } from "node:url";

import { CliError, EXIT_ERROR } from "../core/errors.js";
import { VERSION } from "../core/version.js";
import { parseMainArgs, isHandledAsSubcommand } from "./params.js";
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

function summarizeMainInvocation(parsed: ParsedMain): void {
  const summary = {
    status: "pending",
    command: parsed.command,
    flags: parsed.flags,
    message: "CLI shell parity is implemented; runtime workflows are still pending the deeper TypeScript port.",
  };

  if (parsed.flags.json) {
    emitJson(summary);
    return;
  }

  printLines([
    "CLI shell parity is implemented; runtime workflows are still pending the deeper TypeScript port.",
    "",
    `Mode: ${parsed.command}`,
    `Project: ${parsed.flags.project}`,
  ]);
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

    summarizeMainInvocation(parsed);
    return 0;
  } catch (error) {
    return emitError(error, jsonMode);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli();
}
