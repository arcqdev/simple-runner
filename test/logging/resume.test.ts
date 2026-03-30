import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { findIncompleteRuns, getRunById } from "../../src/logging/runs.js";
import { resumeRun } from "../../src/runtime/engine.js";

function makeTempDir(label: string): string {
  const directory = path.join(
    os.tmpdir(),
    `simple-runner-resume-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(directory, { recursive: true });
  return directory;
}

function writeJsonl(filePath: string, events: Array<Record<string, unknown>>): void {
  writeFileSync(filePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resume logging flow", () => {
  it("finds an interrupted run and completes it through resumeRun", () => {
    const homeDir = makeTempDir("home");
    const runsDir = path.join(homeDir, ".simple-runner", "runs");
    const runId = "interrupted_run";
    const runDir = path.join(runsDir, runId);
    const projectDir = makeTempDir("project");
    const logFile = path.join(runDir, "log.jsonl");

    mkdirSync(runDir, { recursive: true });
    writeJsonl(logFile, [
      {
        event: "run_init",
        project_dir: projectDir,
        version: "0.4.261",
      },
      {
        event: "cli_args",
        goal_text: "Resume parity test",
        max_cycles: 5,
        max_exchanges: 20,
        orchestrator: "gemini-cli",
        orchestrator_model: "gemini-3-flash",
        project_dir: projectDir,
        team: "quick",
      },
      {
        event: "run_start",
        goal: "Resume parity test",
        max_cycles: 5,
        max_exchanges: 20,
        model: "gemini-3-flash",
        orchestrator: "gemini-cli",
        project_dir: projectDir,
        resumed: false,
      },
      {
        event: "cycle_end",
        finished: false,
        summary: "Cycle 1 interrupted before completion",
      },
    ]);
    writeFileSync(path.join(runDir, "goal.md"), "Resume parity test\n", "utf8");
    writeFileSync(
      path.join(runDir, "team.json"),
      `${JSON.stringify(
        {
          agents: {
            worker_fast: { backend: "codex", model: "gpt-5.4", max_turns: 3 },
          },
          verifiers: { testers: [], browser_testers: [], reviewers: [] },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    writeFileSync(
      path.join(runDir, "config.json"),
      `${JSON.stringify(
        {
          autoCommit: true,
          maxCycles: 5,
          maxExchanges: 20,
          orchestrator: "gemini-cli",
          orchestratorModel: "gemini-3-flash",
          team: "quick",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    vi.stubEnv("SIMPLE_RUNNER_RUNS_DIR", runsDir);
    vi.stubEnv("SIMPLE_RUNNER_ENABLE_SESSION_RUNTIME", "0");

    const incomplete = findIncompleteRuns(projectDir, homeDir);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]?.runId).toBe(runId);
    expect(incomplete[0]?.lastSummary).toContain("interrupted");

    const result = resumeRun({ logFile, runId });
    expect(result.finished).toBe(true);

    const resumed = getRunById(runId, homeDir);
    expect(resumed?.finished).toBe(true);
    expect(resumed?.completedCycles).toBe(2);
    expect(readFileSync(logFile, "utf8")).toContain('"event":"run_resumed"');
    expect(readFileSync(logFile, "utf8")).toContain('"event":"run_end"');
    expect(readFileSync(path.join(runDir, "runtime-state.json"), "utf8")).toContain(
      '"completedCycles": 1',
    );
  }, 20000);
});
