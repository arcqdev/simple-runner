export type TopLevelSubcommand =
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
  | "help";

export type GoalMode = "goal" | "goal-file" | "improve" | "test" | "fix-from";

export type MainCommand = "default" | "resume" | "test" | "improve";

export type MainFlags = {
  autoRefine: boolean;
  cycles: number | null;
  debug: boolean;
  effort: "low" | "standard" | "high" | "max" | null;
  exchanges: number | null;
  fixFrom: string | null;
  focus: string | null;
  goal: string | null;
  goalFile: string | null;
  help: boolean;
  improve: boolean;
  json: boolean;
  loge: boolean;
  noAutoCommit: boolean;
  orchestrator: string | null;
  project: string;
  resume: string | null;
  skipIntake: boolean;
  target: string[];
  team: string | null;
  test: boolean;
  version: boolean;
  yes: boolean;
};

export type ParsedMain = {
  command: MainCommand;
  flags: MainFlags;
};
