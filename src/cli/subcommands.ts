import { CliError } from "../core/errors.js";
import type { TopLevelSubcommand } from "./types.js";
import { printLines } from "./ui.js";

const TEAM_HELP = [
  "Usage: kodo teams [add <name> | edit <name> | auto [mode]]",
  "",
  "  (no args)   List all available teams",
  "  add <name>  Create a new team configuration",
  "  edit <name> Edit an existing team configuration",
  "  auto        Generate teams adapted to installed backends",
];

function placeholderSummary(command: string, detail: string, args: string[]): void {
  const lines = [`${detail}`, "", `Command: ${command}`];
  if (args.length > 0) {
    lines.push(`Args: ${args.join(" ")}`);
  }
  printLines(lines);
}

export function handleSubcommand(command: TopLevelSubcommand, args: string[]): number {
  switch (command) {
    case "run":
    case "runs":
      placeholderSummary(command, "Run listing is not implemented yet in the TypeScript port.", args);
      return 0;
    case "log":
    case "logs":
      placeholderSummary(command, "Log viewer support is not implemented yet in the TypeScript port.", args);
      return 0;
    case "issue":
    case "issues":
      placeholderSummary(command, "Issue reporting is not implemented yet in the TypeScript port.", args);
      return 0;
    case "backend":
    case "backends":
      placeholderSummary(command, "Backend inspection is not implemented yet in the TypeScript port.", args);
      return 0;
    case "update":
      placeholderSummary(command, "Self-update is not implemented yet in the TypeScript port.", args);
      return 0;
    case "help":
      return -1;
    case "team":
    case "teams": {
      if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
        printLines(TEAM_HELP);
        return 0;
      }

      const [subcommand, maybeName] = args;
      if ((subcommand === "add" || subcommand === "edit") && !maybeName) {
        throw new CliError(`Usage: kodo teams ${subcommand} <name>`);
      }
      if (subcommand !== "add" && subcommand !== "edit" && subcommand !== "auto") {
        throw new CliError(
          `Unknown teams subcommand: ${subcommand}\nUsage: kodo teams [add <name> | edit <name> | auto [mode]]`,
        );
      }

      placeholderSummary(
        `teams ${args.join(" ")}`,
        "Team management is not implemented yet in the TypeScript port.",
        args,
      );
      return 0;
    }
  }
}
