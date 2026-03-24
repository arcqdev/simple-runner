import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import { emit, getLogFile, init, initAppend, RunDir, saveConversation } from "../../src/logging/log.js";
import { parseRun } from "../../src/logging/runs.js";

function makeTempDir(): string {
  const directory = path.join(
    os.tmpdir(),
    `kodo-log-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(directory, { recursive: true });
  return directory;
}

function writeEvents(logFile: string, events: Array<Record<string, unknown>>): void {
  writeFileSync(
    logFile,
    `${events.map((event) => JSON.stringify({ ts: "2025-01-01T00:00:00Z", t: 0, ...event })).join("\n")}\n`,
    "utf8",
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logging primitives", () => {
  it("creates a log file on init and appends emitted events", () => {
    const tempDir = makeTempDir();
    const runDir = RunDir.create(tempDir, "test_run");

    const logFile = init(runDir);
    expect(existsSync(logFile)).toBe(true);
    emit("my_event", { foo: "bar", count: 42 });

    const lines = readFileSync(getLogFile(), "utf8").trim().split("\n");
    const record = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
    expect(record.event).toBe("my_event");
    expect(record.foo).toBe("bar");
    expect(record.count).toBe(42);
    expect(record.ts).toBeTypeOf("string");
    expect(record.t).toBeTypeOf("number");
  });

  it("serializes non-JSON-safe values", () => {
    const tempDir = makeTempDir();
    init(RunDir.create(tempDir, "serial_test"));
    emit("edge", { callback: (value: unknown) => value, filePath: path.join(tempDir, "x") });

    const lines = readFileSync(getLogFile(), "utf8").trim().split("\n");
    const record = JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown>;
    expect(record.event).toBe("edge");
    expect(String(record.callback)).toContain("value");
    expect(record.filePath).toBe(path.join(tempDir, "x"));
  });

  it("persists conversation artifacts into the active run directory", () => {
    const tempDir = makeTempDir();
    const runDir = RunDir.create(tempDir, "conversation_test");
    init(runDir);

    const relativePath = saveConversation("worker_fast", 1, [
      { type: "thread.started", thread_id: "thread-1" },
      { type: "agent_message", message: "GOAL_DONE: completed" },
    ]);

    expect(relativePath).toBe("conversations/worker_fast_001.jsonl.gz");
    const fullPath = path.join(runDir.root, relativePath ?? "");
    expect(existsSync(fullPath)).toBe(true);
    expect(gunzipSync(readFileSync(fullPath)).toString("utf8")).toContain('"thread_id":"thread-1"');
  });

  it("appends run_resumed when resuming a valid log", () => {
    const tempDir = makeTempDir();
    const logFile = path.join(tempDir, "resume", "log.jsonl");
    mkdirSync(path.dirname(logFile), { recursive: true });
    writeEvents(logFile, [
      {
        event: "run_start",
        goal: "g",
        orchestrator: "api",
        model: "m",
        project_dir: tempDir,
        max_exchanges: 10,
        max_cycles: 5,
        team: [],
      },
      { event: "cli_args", team: "full" },
      { event: "cycle_end", summary: "partial" },
    ]);

    expect(initAppend(logFile)).toBe(logFile);
    const content = readFileSync(logFile, "utf8");
    expect(content).toContain('"event":"run_resumed"');
  });

  it("rejects missing or invalid logs for initAppend", () => {
    const tempDir = makeTempDir();
    const missing = path.join(tempDir, "missing.jsonl");
    expect(() => initAppend(missing)).toThrow(/does not exist/);

    const invalid = path.join(tempDir, "invalid.jsonl");
    writeEvents(invalid, [{ event: "cycle_end", summary: "orphan" }]);
    expect(() => initAppend(invalid)).toThrow(/missing run_start or cli_args/);
  });
});

describe("parseRun", () => {
  it("parses incomplete and finished runs", () => {
    const tempDir = makeTempDir();
    const incomplete = path.join(tempDir, "incomplete.jsonl");
    writeEvents(incomplete, [
      {
        event: "run_start",
        goal: "build it",
        orchestrator: "api",
        model: "opus",
        project_dir: "/proj",
        max_exchanges: 20,
        max_cycles: 5,
        team: ["worker"],
      },
      { event: "cli_args", team: "full" },
      { event: "cycle_end", summary: "did stuff", finished: false },
    ]);
    const incompleteState = parseRun(incomplete);
    expect(incompleteState).not.toBeNull();
    expect(incompleteState?.goal).toBe("build it");
    expect(incompleteState?.completedCycles).toBe(1);
    expect(incompleteState?.lastSummary).toBe("did stuff");
    expect(incompleteState?.finished).toBe(false);
    expect(incompleteState?.maxExchanges).toBe(20);
    expect(incompleteState?.team).toEqual(["worker"]);

    const finished = path.join(tempDir, "finished.jsonl");
    writeEvents(finished, [
      {
        event: "run_start",
        goal: "g",
        orchestrator: "api",
        model: "opus",
        project_dir: "/p",
        max_exchanges: 30,
        max_cycles: 5,
        team: [],
      },
      { event: "cli_args", team: "full" },
      { event: "cycle_end", summary: "all done", finished: true },
      { event: "run_end" },
    ]);
    expect(parseRun(finished)?.finished).toBe(true);
  });

  it("requires both run_start and cli_args, while tolerating corrupt lines", () => {
    const tempDir = makeTempDir();
    const missingStart = path.join(tempDir, "missing-start.jsonl");
    writeEvents(missingStart, [{ event: "cycle_end", summary: "orphan" }]);
    expect(parseRun(missingStart)).toBeNull();

    const corrupt = path.join(tempDir, "corrupt.jsonl");
    writeFileSync(
      corrupt,
      [
        JSON.stringify({
          ts: "t",
          t: 0,
          event: "run_start",
          goal: "g",
          orchestrator: "api",
          model: "m",
          project_dir: "/p",
          max_exchanges: 30,
          max_cycles: 5,
          team: [],
        }),
        JSON.stringify({ ts: "t", t: 0, event: "cli_args", team: "full" }),
        "this is not json",
        '{"truncated',
        JSON.stringify({ ts: "t", t: 0, event: "cycle_end", summary: "ok" }),
      ].join("\n") + "\n",
      "utf8",
    );
    expect(parseRun(corrupt)?.completedCycles).toBe(1);
    expect(parseRun(corrupt)?.lastSummary).toBe("ok");
  });

  it("reconstructs failed-before-start runs from cli_args", () => {
    const tempDir = makeTempDir();
    const logFile = path.join(tempDir, "cli-only.jsonl");
    writeEvents(logFile, [
      {
        event: "cli_args",
        goal_text: "recover me",
        orchestrator: "codex",
        orchestrator_model: "gpt-5.4",
        project_dir: tempDir,
        max_exchanges: 18,
        max_cycles: 4,
        team: "full",
      },
    ]);

    const state = parseRun(logFile);
    expect(state).not.toBeNull();
    expect(state?.goal).toBe("recover me");
    expect(state?.orchestrator).toBe("codex");
    expect(state?.model).toBe("gpt-5.4");
    expect(state?.finished).toBe(false);
  });

  it("tracks stage completion and agent session ids", () => {
    const tempDir = makeTempDir();
    const logFile = path.join(tempDir, "staged.jsonl");
    writeEvents(logFile, [
      {
        event: "run_start",
        goal: "staged goal",
        orchestrator: "api",
        model: "m",
        project_dir: tempDir,
        max_exchanges: 30,
        max_cycles: 5,
        team: ["worker_fast", "worker_smart"],
        has_stages: true,
        num_stages: 3,
      },
      { event: "cli_args", team: "quick" },
      { event: "stage_start", stage_index: 1 },
      { event: "cycle_end", summary: "stage 1 done" },
      { event: "stage_end", stage_index: 1, finished: true, summary: "s1 summary" },
      { event: "stage_start", stage_index: 2 },
      {
        event: "session_query_end",
        session: "claude",
        session_id: "ses-abc",
        conversation_log: "conversations/worker_smart_001.jsonl.gz",
      },
      {
        event: "agent_run_end",
        agent: "worker_smart",
        cost_bucket: "claude_subscription",
        elapsed_s: 1.25,
        input_tokens: 21,
        output_tokens: 13,
      },
      {
        event: "session_query_end",
        session: "cursor",
        chat_id: "chat-xyz",
        conversation_log: "conversations/worker_fast_001.jsonl.gz",
      },
      {
        event: "agent_run_end",
        agent: "worker_fast",
        cost_bucket: "cursor_subscription",
        elapsed_s: 0.75,
        input_tokens: 8,
        is_error: true,
        output_tokens: 5,
      },
      { event: "cycle_end" },
      { event: "stage_end", stage_index: 2, finished: false, summary: "should not count" },
    ]);

    const state = parseRun(logFile);
    expect(state).not.toBeNull();
    expect(state?.hasStages).toBe(true);
    expect(state?.completedStages).toEqual([1]);
    expect(state?.stageSummaries).toEqual(["s1 summary"]);
    expect(state?.currentStageCycles).toBe(0);
    expect(state?.completedCycles).toBe(2);
    expect(state?.agentSessionIds).toEqual({
      worker_fast: "chat-xyz",
      worker_smart: "ses-abc",
    });
    expect(state?.agentStats.worker_smart).toEqual({
      calls: 1,
      conversationLogs: ["conversations/worker_smart_001.jsonl.gz"],
      costBucket: "claude_subscription",
      elapsedS: 1.25,
      errors: 0,
      inputTokens: 21,
      outputTokens: 13,
    });
    expect(state?.agentStats.worker_fast).toEqual({
      calls: 1,
      conversationLogs: ["conversations/worker_fast_001.jsonl.gz"],
      costBucket: "cursor_subscription",
      elapsedS: 0.75,
      errors: 1,
      inputTokens: 8,
      outputTokens: 5,
    });
    expect(state?.conversationArtifacts).toEqual([
      "conversations/worker_smart_001.jsonl.gz",
      "conversations/worker_fast_001.jsonl.gz",
    ]);
    expect(state?.inputTokens).toBe(29);
    expect(state?.outputTokens).toBe(18);
    expect(state?.errorCount).toBe(1);
    expect(state?.totalAgentCalls).toBe(2);
    expect(state?.totalElapsedS).toBe(2);
    expect(state?.teamPreset).toBe("quick");
  });

  it("tracks active stage cycle counts until the stage ends", () => {
    const tempDir = makeTempDir();
    const logFile = path.join(tempDir, "active-stage.jsonl");
    writeEvents(logFile, [
      { event: "cli_args", team: "quick", goal_text: "ship it", project_dir: tempDir },
      {
        event: "run_start",
        goal: "ship it",
        orchestrator: "api",
        model: "m",
        project_dir: tempDir,
        max_exchanges: 30,
        max_cycles: 5,
        team: [],
        has_stages: true,
      },
      { event: "stage_start", stage_index: 2 },
      { event: "cycle_end", summary: "part 1" },
      { event: "cycle_end", summary: "part 2" },
    ]);

    const state = parseRun(logFile);
    expect(state?.currentStageCycles).toBe(2);
    expect(state?.completedStages).toEqual([]);
  });
});
