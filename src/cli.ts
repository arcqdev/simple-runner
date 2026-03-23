import process from "node:process";
import { pathToFileURL } from "node:url";

import { VERSION } from "./version.js";

type CommandName = "run" | "resume" | "test" | "improve";

type ParsedArgs = {
  command: CommandName | null;
  rest: string[];
  flags: {
    help: boolean;
    version: boolean;
    json: boolean;
  };
};

const HELP_TEXT = `kodo - TypeScript CLI runner

Usage:
  kodo [command] [options]

Commands:
  run       Start a new run
  resume    Resume a prior run
  test      Placeholder for the Python test workflow migration
  improve   Placeholder for the Python improve workflow migration

Options:
  -h, --help     Show help
  -v, --version  Show version
  --json         Emit JSON for machine-readable responses
`;

function parseArgs(argv: string[]): ParsedArgs {
  const [first, ...rest] = argv;
  const command = isCommand(first) ? first : null;
  const args = command === null ? argv : rest;

  return {
    command,
    rest: args.filter((arg) => !isKnownFlag(arg)),
    flags: {
      help: args.includes("--help") || args.includes("-h"),
      version: args.includes("--version") || args.includes("-v"),
      json: args.includes("--json"),
    },
  };
}

function isCommand(value: string | undefined): value is CommandName {
  return value === "run" || value === "resume" || value === "test" || value === "improve";
}

function isKnownFlag(value: string): boolean {
  return value === "--help" || value === "-h" || value === "--version" || value === "-v" || value === "--json";
}

function printHelp(): void {
  process.stdout.write(`${HELP_TEXT}\n`);
}

function emitJson(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function printCommandPlaceholder(command: CommandName, rest: string[], json: boolean): number {
  const payload = {
    status: "ok",
    command,
    args: rest,
    message: `Scaffolded TypeScript entrypoint for '${command}'.`,
  };

  if (json) {
    emitJson(payload);
    return 0;
  }

  process.stdout.write(`${payload.message}\n`);
  if (rest.length > 0) {
    process.stdout.write(`Args: ${rest.join(" ")}\n`);
  }
  return 0;
}

export function runCli(argv = process.argv.slice(2)): number {
  const parsed = parseArgs(argv);

  if (parsed.flags.version) {
    process.stdout.write(`kodo ${VERSION}\n`);
    return 0;
  }

  if (parsed.flags.help || parsed.command === null) {
    if (parsed.flags.json) {
      emitJson({
        status: "ok",
        version: VERSION,
        commands: ["run", "resume", "test", "improve"],
      });
      return 0;
    }
    printHelp();
    return 0;
  }

  return printCommandPlaceholder(parsed.command, parsed.rest, parsed.flags.json);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli();
}
