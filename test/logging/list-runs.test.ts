import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { findIncompleteRuns, listRuns } from "../../src/logging/runs.js";

function makeHomeDir(): string {
  const homeDir = path.join(
    os.tmpdir(),
    `kodo-log-home-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(homeDir, { recursive: true });
  return homeDir;
}

function writeEvents(
  homeDir: string,
  runId: string,
  fileName: "log.jsonl" | "run.jsonl",
  events: Array<Record<string, unknown>>,
): void {
  const runDir = path.join(homeDir, ".kodo", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    runDir + `/${fileName}`,
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
}

function writeRuntimeState(homeDir: string, runId: string, state: Record<string, unknown>): void {
  const runDir = path.join(homeDir, ".kodo", "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "runtime-state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listRuns", () => {
  it("returns an empty list for an empty run store", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);

    expect(listRuns()).toEqual([]);
  });

  it("returns newest runs first and filters by project", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const projectA = path.join(homeDir, "alpha");
    const projectB = path.join(homeDir, "beta");
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });

    writeEvents(homeDir, "20250101_100000", "log.jsonl", [
      {
        event: "run_start",
        goal: "older",
        orchestrator: "api",
        model: "m",
        project_dir: projectA,
        max_exchanges: 30,
        max_cycles: 5,
        team: [],
      },
      { event: "cli_args", team: "full" },
      { event: "cycle_end", summary: "ok" },
    ]);
    writeEvents(homeDir, "20250102_100000", "log.jsonl", [
      {
        event: "run_start",
        goal: "newer",
        orchestrator: "api",
        model: "m",
        project_dir: projectB,
        max_exchanges: 30,
        max_cycles: 5,
        team: [],
      },
      { event: "cli_args", team: "full" },
      { event: "cycle_end", summary: "ok" },
    ]);

    const allRuns = listRuns();
    expect(allRuns.map((run) => run.goal)).toEqual(["newer", "older"]);

    const filtered = listRuns(projectA);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.goal).toBe("older");
  });

  it("skips corrupt logs and still discovers legacy run.jsonl files", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const project = path.join(homeDir, "project");
    mkdirSync(project, { recursive: true });

    writeEvents(homeDir, "good_run", "log.jsonl", [
      {
        event: "run_start",
        goal: "works",
        orchestrator: "api",
        model: "m",
        project_dir: project,
        max_exchanges: 30,
        max_cycles: 5,
        team: [],
      },
      { event: "cli_args", team: "full" },
      { event: "cycle_end", summary: "ok" },
    ]);

    writeEvents(homeDir, "legacy_run", "run.jsonl", [
      {
        event: "run_start",
        goal: "legacy",
        orchestrator: "api",
        model: "m",
        project_dir: project,
        max_exchanges: 30,
        max_cycles: 5,
        team: [],
      },
      { event: "cli_args", team: "quick" },
      { event: "cycle_end", summary: "ok" },
    ]);

    const badDir = path.join(homeDir, ".kodo", "runs", "bad_run");
    mkdirSync(badDir, { recursive: true });
    writeFileSync(path.join(badDir, "log.jsonl"), "not json at all\n", "utf8");

    const runs = listRuns();
    expect(runs.map((run) => run.runId)).toEqual(["legacy_run", "good_run"]);
    expect(runs.find((run) => run.runId === "legacy_run")?.goal).toBe("legacy");
  });

  it("includes failed-before-start runs reconstructed from cli_args", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const project = path.join(homeDir, "project");
    mkdirSync(project, { recursive: true });

    writeEvents(homeDir, "cli_only", "log.jsonl", [
      {
        event: "cli_args",
        goal_text: "preflight failed",
        orchestrator: "codex",
        orchestrator_model: "gpt-5.4",
        project_dir: project,
        max_exchanges: 20,
        max_cycles: 4,
        team: "full",
      },
    ]);

    const runs = listRuns(project);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.goal).toBe("preflight failed");
    expect(runs[0]?.finished).toBe(false);
  });

  it("finds incomplete runs only within the requested project", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const mine = path.join(homeDir, "mine");
    const theirs = path.join(homeDir, "theirs");
    mkdirSync(mine, { recursive: true });
    mkdirSync(theirs, { recursive: true });

    writeEvents(homeDir, "their_run", "log.jsonl", [
      {
        event: "run_start",
        goal: "their goal",
        orchestrator: "api",
        model: "m",
        project_dir: theirs,
        max_exchanges: 30,
        max_cycles: 5,
        team: [],
      },
      { event: "cli_args", team: "full" },
      { event: "cycle_end", summary: "ok" },
    ]);
    writeEvents(homeDir, "my_run", "log.jsonl", [
      {
        event: "run_start",
        goal: "my goal",
        orchestrator: "api",
        model: "m",
        project_dir: mine,
        max_exchanges: 30,
        max_cycles: 5,
        team: [],
      },
      { event: "cli_args", team: "full" },
      { event: "cycle_end", summary: "ok" },
    ]);

    const runs = findIncompleteRuns(mine);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.goal).toBe("my goal");
  });

  it("hydrates richer resume state from runtime-state.json when present", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const project = path.join(homeDir, "project");
    mkdirSync(project, { recursive: true });

    writeEvents(homeDir, "resume_rich", "log.jsonl", [
      {
        event: "run_start",
        goal: "resume me",
        orchestrator: "codex",
        model: "gpt-5.4",
        project_dir: project,
        max_exchanges: 30,
        max_cycles: 5,
        team: [],
      },
      { event: "cli_args", team: "full" },
      { event: "cycle_end", summary: "cycle one" },
    ]);
    writeRuntimeState(homeDir, "resume_rich", {
      agentStats: {
        worker_fast: {
          calls: 2,
          conversationLogs: ["conversations/worker_fast_001.jsonl.gz"],
          costBucket: "cursor_subscription",
          elapsedS: 1.5,
          errors: 0,
          inputTokens: 12,
          outputTokens: 7,
        },
      },
      pendingExchanges: [{ agentName: "worker_fast", scope: "single" }],
      parallelStageState: {
        "2": { agentName: "worker_fast", stageIndex: 2, sessionId: "saved-thread" },
      },
    });

    const run = listRuns(project)[0];
    expect(run?.pendingExchanges).toHaveLength(1);
    expect(run?.parallelStageState["2"]?.sessionId).toBe("saved-thread");
    expect(run?.agentStats.worker_fast?.calls).toBe(2);
    expect(run?.conversationArtifacts).toEqual(["conversations/worker_fast_001.jsonl.gz"]);
    expect(run?.inputTokens).toBe(12);
    expect(run?.outputTokens).toBe(7);
    expect(run?.totalAgentCalls).toBe(2);
  });
});
