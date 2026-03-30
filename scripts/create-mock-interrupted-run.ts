import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { runsRoot } from "../src/logging/runs.js";

export type MockInterruptedRun = {
  goalFile: string;
  logFile: string;
  projectDir: string;
  runDir: string;
  runId: string;
};

type CreateMockInterruptedRunOptions = {
  goalText?: string;
  projectDir?: string;
  runId?: string;
  runsDir?: string;
};

function writeJsonl(filePath: string, events: Array<Record<string, unknown>>): void {
  writeFileSync(filePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

export function createMockInterruptedRun(
  options: CreateMockInterruptedRunOptions = {},
): MockInterruptedRun {
  const runId =
    options.runId ?? process.env.SIMPLE_RUNNER_RESUME_TEST_RUN_ID ?? "interrupted_run";
  const projectDir = path.resolve(
    options.projectDir ??
      process.env.SIMPLE_RUNNER_RESUME_TEST_PROJECT_DIR ??
      path.join(os.tmpdir(), "simple-runner-resume-test"),
  );
  const runDir = path.join(options.runsDir ?? runsRoot(), runId);
  const goalText =
    options.goalText ??
    "Build a simple REST API for todo items.\n\nRequirements:\n- CRUD operations for todos\n- In-memory storage\n- Basic tests\n";

  mkdirSync(projectDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });

  const logFile = path.join(runDir, "log.jsonl");
  const goalFile = path.join(runDir, "goal.md");
  const configFile = path.join(runDir, "config.json");

  writeJsonl(logFile, [
    {
      event: "run_init",
      project_dir: projectDir,
      ts: "2026-03-23T01:00:00Z",
      version: "0.4.261",
    },
    {
      event: "cli_args",
      goal_text: "Build a simple REST API for todo items",
      max_cycles: 5,
      max_exchanges: 30,
      orchestrator: "codex",
      orchestrator_model: "gpt-5.4",
      project_dir: projectDir,
      team: "quick",
      ts: "2026-03-23T01:00:01Z",
    },
    {
      event: "run_start",
      goal: "Build a simple REST API for todo items",
      has_stages: false,
      max_cycles: 5,
      max_exchanges: 30,
      model: "gpt-5.4",
      orchestrator: "codex",
      project_dir: projectDir,
      resumed: false,
      team: ["worker_fast"],
      ts: "2026-03-23T01:00:02Z",
    },
    {
      event: "cycle_end",
      finished: false,
      summary: "Started implementation and left the run incomplete.",
      ts: "2026-03-23T01:05:00Z",
    },
  ]);
  writeFileSync(goalFile, goalText, "utf8");
  writeFileSync(
    configFile,
    `${JSON.stringify(
      {
        autoCommit: true,
        maxCycles: 5,
        maxExchanges: 30,
        orchestrator: "codex",
        orchestratorModel: "gpt-5.4",
        team: "quick",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return { goalFile, logFile, projectDir, runDir, runId };
}

function main(): void {
  const fixture = createMockInterruptedRun();
  process.stdout.write(`Created mock interrupted run at ${fixture.runDir}\n`);
  process.stdout.write(`  Log:  ${fixture.logFile}\n`);
  process.stdout.write(`  Goal: ${fixture.goalFile}\n`);
  process.stdout.write(`  Project: ${fixture.projectDir}\n`);
  process.stdout.write("\n");
  process.stdout.write("To verify resume:\n");
  process.stdout.write(`  simple-runner --resume --yes --project ${fixture.projectDir}\n`);
  process.stdout.write("\n");
  process.stdout.write("Or resume by run ID:\n");
  process.stdout.write(
    `  simple-runner --resume ${fixture.runId} --yes --project ${fixture.projectDir}\n`,
  );
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  main();
}
