import fs from "node:fs";
import path from "node:path";

import { CliError } from "../core/errors.js";
import type { GoalMode, MainFlags, ParsedMain } from "./types.js";

const EFFORT_VALUES = new Set(["low", "standard", "high", "max"]);
const SINGULAR_SUBCOMMANDS = new Set(["run", "backend", "team", "log", "issue", "help"]);
const PLURAL_SUBCOMMANDS = new Set(["runs", "backends", "teams", "logs", "issues", "update"]);
const MAIN_ALIAS_COMMANDS = new Set(["test", "improve"]);
const KNOWN_TOP_LEVEL = new Set([
  ...SINGULAR_SUBCOMMANDS,
  ...PLURAL_SUBCOMMANDS,
  ...MAIN_ALIAS_COMMANDS,
]);

function parseIntegerFlag(flag: string, value: string | undefined): number {
  if (value === undefined) {
    throw new CliError(`argument ${flag}: expected one argument`);
  }
  if (!/^-?\d+$/.test(value)) {
    throw new CliError(`argument ${flag}: invalid int value: '${value}'`);
  }
  return Number.parseInt(value, 10);
}

function parseResumeValue(next: string | undefined): { value: string; consumed: number } {
  if (next === undefined || next.startsWith("-")) {
    return { value: "__latest__", consumed: 0 };
  }
  return { value: next, consumed: 1 };
}

function setExclusiveGoalMode(current: GoalMode | null, next: GoalMode): GoalMode {
  if (current !== null) {
    throw new CliError(
      "argument conflict: --goal, --goal-file, --improve, --test, and --fix-from are mutually exclusive",
    );
  }
  return next;
}

function validateProject(project: string): string {
  const resolved = path.resolve(project);
  if (!fs.existsSync(resolved)) {
    throw new CliError(`--project path does not exist: ${resolved}`);
  }
  if (!fs.statSync(resolved).isDirectory()) {
    throw new CliError(`--project path is not a directory: ${resolved}`);
  }
  return resolved;
}

function validateTargets(project: string, targets: string[]): void {
  for (const target of targets) {
    const resolved = path.resolve(project, target);
    if (!fs.existsSync(resolved)) {
      throw new CliError(`--target path does not exist: ${target} (resolved: ${resolved})`);
    }
  }
}

function buildDefaultFlags(): MainFlags {
  return {
    autoRefine: false,
    cycles: null,
    debug: false,
    effort: null,
    exchanges: null,
    fixFrom: null,
    focus: null,
    goal: null,
    goalFile: null,
    help: false,
    improve: false,
    json: false,
    noAutoCommit: false,
    orchestrator: null,
    project: ".",
    resume: null,
    skipIntake: false,
    target: [],
    team: null,
    test: false,
    version: false,
    yes: false,
  };
}

export function isTopLevelSubcommand(value: string | undefined): boolean {
  return value !== undefined && KNOWN_TOP_LEVEL.has(value);
}

export function isHandledAsSubcommand(
  value: string | undefined,
): value is
  | "run"
  | "runs"
  | "log"
  | "logs"
  | "issue"
  | "issues"
  | "backend"
  | "backends"
  | "team"
  | "teams"
  | "update"
  | "help" {
  return value !== undefined && (SINGULAR_SUBCOMMANDS.has(value) || PLURAL_SUBCOMMANDS.has(value));
}

export function parseMainArgs(argv: string[]): ParsedMain {
  const flags = buildDefaultFlags();
  let goalMode: GoalMode | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--help":
      case "-h":
        flags.help = true;
        break;
      case "--version":
      case "-v":
        flags.version = true;
        break;
      case "--json":
        flags.json = true;
        break;
      case "--yes":
      case "-y":
        flags.yes = true;
        break;
      case "--skip-intake":
        flags.skipIntake = true;
        break;
      case "--auto-refine":
        flags.autoRefine = true;
        break;
      case "--debug":
        flags.debug = true;
        break;
      case "--no-auto-commit":
        flags.noAutoCommit = true;
        break;
      case "--improve":
        goalMode = setExclusiveGoalMode(goalMode, "improve");
        flags.improve = true;
        break;
      case "--test":
        goalMode = setExclusiveGoalMode(goalMode, "test");
        flags.test = true;
        break;
      case "--resume": {
        const parsed = parseResumeValue(argv[index + 1]);
        flags.resume = parsed.value;
        index += parsed.consumed;
        break;
      }
      case "--goal":
        goalMode = setExclusiveGoalMode(goalMode, "goal");
        flags.goal = argv[index + 1] ?? null;
        if (flags.goal === null) {
          throw new CliError("argument --goal: expected one argument");
        }
        index += 1;
        break;
      case "--goal-file":
        goalMode = setExclusiveGoalMode(goalMode, "goal-file");
        flags.goalFile = argv[index + 1] ?? null;
        if (flags.goalFile === null) {
          throw new CliError("argument --goal-file: expected one argument");
        }
        index += 1;
        break;
      case "--fix-from":
        goalMode = setExclusiveGoalMode(goalMode, "fix-from");
        flags.fixFrom = argv[index + 1] ?? null;
        if (flags.fixFrom === null) {
          throw new CliError("argument --fix-from: expected one argument");
        }
        index += 1;
        break;
      case "--focus":
        flags.focus = argv[index + 1] ?? null;
        if (flags.focus === null) {
          throw new CliError("argument --focus: expected one argument");
        }
        index += 1;
        break;
      case "--team":
        flags.team = argv[index + 1] ?? null;
        if (flags.team === null) {
          throw new CliError("argument --team: expected one argument");
        }
        index += 1;
        break;
      case "--project":
        flags.project = argv[index + 1] ?? ".";
        if (argv[index + 1] === undefined) {
          throw new CliError("argument --project: expected one argument");
        }
        index += 1;
        break;
      case "--orchestrator":
      case "--orchestrator-model":
        flags.orchestrator = argv[index + 1] ?? null;
        if (flags.orchestrator === null) {
          throw new CliError(`argument ${token}: expected one argument`);
        }
        index += 1;
        break;
      case "--exchanges":
        flags.exchanges = parseIntegerFlag(token, argv[index + 1]);
        index += 1;
        break;
      case "--cycles":
        flags.cycles = parseIntegerFlag(token, argv[index + 1]);
        index += 1;
        break;
      case "--effort": {
        const effort = argv[index + 1];
        if (effort === undefined) {
          throw new CliError("argument --effort: expected one argument");
        }
        if (!EFFORT_VALUES.has(effort)) {
          throw new CliError(`argument --effort: invalid choice: '${effort}'`);
        }
        flags.effort = effort as MainFlags["effort"];
        index += 1;
        break;
      }
      case "--target": {
        const target = argv[index + 1];
        if (target === undefined) {
          throw new CliError("argument --target: expected one argument");
        }
        flags.target.push(target);
        index += 1;
        break;
      }
      default:
        if (token.startsWith("-")) {
          throw new CliError(`unrecognized arguments: ${token}`);
        }
        throw new CliError(`unrecognized arguments: ${token}`);
    }
  }

  flags.project = validateProject(flags.project);

  if (flags.goal !== null && flags.goal.trim().length === 0) {
    throw new CliError("--goal must not be empty or whitespace-only.");
  }
  if (flags.resume === "") {
    throw new CliError(
      "--resume must not be an empty string. Omit the value to resume the latest run.",
    );
  }
  if (flags.focus !== null && flags.focus.trim().length === 0) {
    throw new CliError("--focus must not be empty or whitespace-only.");
  }
  if (flags.exchanges !== null && flags.exchanges <= 0) {
    throw new CliError("--exchanges must be a positive integer.");
  }
  if (flags.exchanges !== null && flags.exchanges > 1000) {
    throw new CliError("--exchanges must not exceed 1000.");
  }
  if (flags.cycles !== null && flags.cycles <= 0) {
    throw new CliError("--cycles must be a positive integer.");
  }
  if (flags.cycles !== null && flags.cycles > 100) {
    throw new CliError("--cycles must not exceed 100.");
  }
  if (flags.focus && !flags.improve && !flags.test) {
    throw new CliError("--focus can only be used with --improve or --test.");
  }
  if (flags.target.length > 0 && !flags.test) {
    throw new CliError("--target can only be used with --test.");
  }
  if (
    (flags.skipIntake || flags.autoRefine) &&
    !flags.goal &&
    !flags.goalFile &&
    !flags.improve &&
    !flags.test &&
    !flags.fixFrom
  ) {
    throw new CliError(
      "--skip-intake and --auto-refine require --goal, --goal-file, --improve, or --test.",
    );
  }

  validateTargets(flags.project, flags.target);

  if (flags.json || flags.autoRefine) {
    flags.yes = true;
  }
  if (flags.improve) {
    flags.skipIntake = true;
    flags.yes = true;
    flags.team ??= "full";
  }
  if (flags.test) {
    flags.skipIntake = true;
    flags.yes = true;
    flags.team ??= "test";
  }
  if (flags.fixFrom) {
    flags.skipIntake = true;
    flags.yes = true;
    flags.team ??= "full";
  }
  if (flags.debug) {
    flags.skipIntake = true;
  }

  const nonInteractive =
    flags.goal !== null ||
    flags.goalFile !== null ||
    flags.improve ||
    flags.test ||
    flags.fixFrom !== null;
  if (nonInteractive && flags.resume !== null) {
    throw new CliError(
      "--resume cannot be used with --goal/--goal-file/--improve/--test/--fix-from",
    );
  }

  return {
    command:
      flags.resume !== null
        ? "resume"
        : flags.improve
          ? "improve"
          : flags.test
            ? "test"
            : "default",
    flags,
  };
}
