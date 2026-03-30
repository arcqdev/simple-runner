import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { runCli } from "../src/cli.js";
import { findIncompleteRuns, getRunById } from "../src/logging/runs.js";
import { createMockInterruptedRun } from "./create-mock-interrupted-run.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function makeTempDir(label: string): string {
  return path.join(
    os.tmpdir(),
    `simple-runner-resume-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

function verifyResumedRun(runId: string): void {
  const resumed = getRunById(runId);
  assert(resumed !== null, `Expected resumed run ${runId} to exist`);
  assert(resumed.finished, `Expected resumed run ${runId} to be marked finished`);
  assert(
    resumed.lastSummary.includes("Completed 1 cycle") ||
      resumed.lastSummary.includes("Run completed"),
    `Expected resumed run ${runId} to have a completion summary, got: ${resumed.lastSummary}`,
  );
  const log = readFileSync(resumed.logFile, "utf8");
  assert(log.includes('"event":"run_resumed"'), `Expected ${runId} log to include run_resumed`);
  assert(log.includes('"event":"run_end"'), `Expected ${runId} log to include run_end`);
}

function main(): void {
  const tempRoot = makeTempDir("root");
  const runsDir = path.join(tempRoot, "runs");
  const projectDir = path.join(tempRoot, "project");
  const previousRunsDir = process.env.SIMPLE_RUNNER_RUNS_DIR;
  const previousSessionRuntime = process.env.SIMPLE_RUNNER_ENABLE_SESSION_RUNTIME;

  process.env.SIMPLE_RUNNER_RUNS_DIR = runsDir;
  process.env.SIMPLE_RUNNER_ENABLE_SESSION_RUNTIME = "0";

  try {
    const latestFixture = createMockInterruptedRun({
      projectDir,
      runId: "interrupted_latest",
      runsDir,
    });
    const incomplete = findIncompleteRuns(projectDir);
    assert(
      incomplete.some((run) => run.runId === latestFixture.runId),
      "Expected mock interrupted run to be discoverable",
    );

    const latestExit = runCli(["--resume", "--yes", "--project", projectDir]);
    assert(latestExit === 0, `Expected latest resume flow to exit 0, got ${latestExit}`);
    verifyResumedRun(latestFixture.runId);

    const explicitFixture = createMockInterruptedRun({
      projectDir,
      runId: "interrupted_by_id",
      runsDir,
    });
    const byIdExit = runCli(["--resume", explicitFixture.runId, "--yes", "--project", projectDir]);
    assert(byIdExit === 0, `Expected explicit resume flow to exit 0, got ${byIdExit}`);
    verifyResumedRun(explicitFixture.runId);

    process.stdout.write("Resume verification: OK\n");
  } finally {
    rmSync(tempRoot, { force: true, recursive: true });
    if (previousRunsDir === undefined) {
      delete process.env.SIMPLE_RUNNER_RUNS_DIR;
    } else {
      process.env.SIMPLE_RUNNER_RUNS_DIR = previousRunsDir;
    }
    if (previousSessionRuntime === undefined) {
      delete process.env.SIMPLE_RUNNER_ENABLE_SESSION_RUNTIME;
    } else {
      process.env.SIMPLE_RUNNER_ENABLE_SESSION_RUNTIME = previousSessionRuntime;
    }
  }
}

main();
