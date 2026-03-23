import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/main.js";
import { init, RunDir } from "../../src/logging/log.js";
import { createSessionForOrchestrator } from "../../src/runtime/sessions.js";
import { captureOutput } from "../helpers/stdout.js";

const ORIGINAL_PATH = process.env.PATH;

function makeTempDir(prefix: string): string {
  const directory = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(directory, { recursive: true });
  return directory;
}

function useOnlyPath(binDir: string): void {
  process.env.PATH = binDir;
}

function writeExecutable(filePath: string, content: string): void {
  writeFileSync(filePath, content, "utf8");
  chmodSync(filePath, 0o755);
}

function installFakeCodex(binDir: string): void {
  const script = `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex 1.2.3");
  process.exit(0);
}
if (process.env.FAKE_CODEX_MODE === "timeout") {
  setTimeout(() => {}, 5000);
  return;
}
if (process.env.FAKE_CODEX_MODE === "malformed") {
  console.log("not-json");
  console.log('{"truncated"');
  console.error("plain stderr fallback");
  process.exit(0);
}
if (process.env.FAKE_CODEX_MODE === "auth") {
  console.error("Authentication failed: login expired");
  process.exit(1);
}
if (process.env.FAKE_CODEX_MODE === "signal") {
  process.kill(process.pid, "SIGTERM");
  return;
}
if (process.env.FAKE_CODEX_MODE === "background-error") {
  console.log(JSON.stringify({ type: "background_event", message: "status 401 unauthorized" }));
  process.exit(0);
}
const resumeIndex = args.indexOf("resume");
const resumed = resumeIndex !== -1 ? args[resumeIndex + 1] : null;
console.log(JSON.stringify({ type: "thread.started", thread_id: resumed ?? "thread-1" }));
console.log(JSON.stringify({ type: "token_count", input_tokens: 7, output_tokens: 11 }));
console.log(JSON.stringify({ type: "agent_message", message: resumed ? "GOAL_DONE: Resumed " + resumed : "GOAL_DONE: Completed task" }));
`;
  writeExecutable(path.join(binDir, "codex"), script);
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.FAKE_CODEX_MODE;
  delete process.env.KODO_ENABLE_SESSION_RUNTIME;
  process.env.PATH = ORIGINAL_PATH;
});

describe("session adapters", () => {
  it("supports message exchange, session ids, and reset for codex", () => {
    const binDir = makeTempDir("kodo-bin");
    installFakeCodex(binDir);
    useOnlyPath(binDir);

    const projectDir = makeTempDir("kodo-project");
    const runDir = RunDir.create(projectDir, "session_test");
    init(runDir);

    const session = createSessionForOrchestrator("codex", "gpt-5.4");
    expect(session).not.toBeNull();

    const first = session?.query("ship it", {
      maxTurns: 3,
      projectDir,
    });
    expect(first?.isError).toBe(false);
    expect(first?.text).toContain("Completed task");
    expect(first?.inputTokens).toBe(7);
    expect(first?.outputTokens).toBe(11);
    expect(session?.sessionId).toBe("thread-1");

    const second = session?.query("continue", {
      maxTurns: 3,
      projectDir,
    });
    expect(second?.isError).toBe(false);
    expect(second?.text).toContain("Resumed thread-1");

    session?.reset();
    expect(session?.sessionId).toBeNull();

    const log = readFileSync(runDir.logFile, "utf8");
    expect(log).toContain('"event":"session_query_start"');
    expect(log).toContain('"event":"session_query_end"');
    expect(log).toContain('"event":"session_reset"');
    expect(log).toContain('"session_id":"thread-1"');
  });

  it("classifies timeouts and logs session_timeout", () => {
    const binDir = makeTempDir("kodo-bin");
    installFakeCodex(binDir);
    useOnlyPath(binDir);
    process.env.FAKE_CODEX_MODE = "timeout";

    const projectDir = makeTempDir("kodo-project");
    const runDir = RunDir.create(projectDir, "timeout_test");
    init(runDir);

    const session = createSessionForOrchestrator("codex", "gpt-5.4", {
      timeoutS: 1,
    });
    const result = session?.query("hang", {
      maxTurns: 1,
      projectDir,
    });

    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("timed out");

    const log = readFileSync(runDir.logFile, "utf8");
    expect(log).toContain('"event":"session_timeout"');
    expect(log).toContain('"event":"session_query_error"');
  });

  it("falls back to stderr when subprocess output is malformed", () => {
    const binDir = makeTempDir("kodo-bin");
    installFakeCodex(binDir);
    useOnlyPath(binDir);
    process.env.FAKE_CODEX_MODE = "malformed";

    const projectDir = makeTempDir("kodo-project");
    const session = createSessionForOrchestrator("codex", "gpt-5.4");
    const result = session?.query("ship it", {
      maxTurns: 1,
      projectDir,
    });

    expect(result?.isError).toBe(false);
    expect(result?.text).toBe("plain stderr fallback");
  });

  it("classifies authentication failures from subprocess stderr", () => {
    const binDir = makeTempDir("kodo-bin");
    installFakeCodex(binDir);
    useOnlyPath(binDir);
    process.env.FAKE_CODEX_MODE = "auth";

    const projectDir = makeTempDir("kodo-project");
    const session = createSessionForOrchestrator("codex", "gpt-5.4");
    const result = session?.query("ship it", {
      maxTurns: 1,
      projectDir,
    });

    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("Authentication failed");
  });

  it("treats structured background errors as failures", () => {
    const binDir = makeTempDir("kodo-bin");
    installFakeCodex(binDir);
    useOnlyPath(binDir);
    process.env.FAKE_CODEX_MODE = "background-error";

    const projectDir = makeTempDir("kodo-project");
    const session = createSessionForOrchestrator("codex", "gpt-5.4");
    const result = session?.query("ship it", {
      maxTurns: 1,
      projectDir,
    });

    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("unauthorized");
  });

  it("surfaces signal termination clearly", () => {
    const binDir = makeTempDir("kodo-bin");
    installFakeCodex(binDir);
    useOnlyPath(binDir);
    process.env.FAKE_CODEX_MODE = "signal";

    const projectDir = makeTempDir("kodo-project");
    const session = createSessionForOrchestrator("codex", "gpt-5.4");
    const result = session?.query("ship it", {
      maxTurns: 1,
      projectDir,
    });

    expect(result?.isError).toBe(true);
    expect(result?.text).toContain("SIGTERM");
  });
});

describe("runtime integration", () => {
  it("runs the CLI through the session layer when codex is available", () => {
    const binDir = makeTempDir("kodo-bin");
    installFakeCodex(binDir);
    useOnlyPath(binDir);
    process.env.KODO_ENABLE_SESSION_RUNTIME = "1";

    const projectDir = makeTempDir("kodo-project");
    mkdirSync(path.join(projectDir, ".kodo"), { recursive: true });
    writeFileSync(
      path.join(projectDir, ".kodo", "team.json"),
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
    const io = captureOutput();

    expect(
      runCli([
        "--goal",
        "Ship it",
        "--project",
        projectDir,
        "--yes",
        "--orchestrator",
        "codex:gpt-5.4",
      ]),
    ).toBe(0);
    expect(io.stdout()).toContain("Run completed.");
    expect(io.stdout()).toContain("Orchestrator: codex (gpt-5.4)");
    expect(io.stdout()).toContain("Completed task");

    const logFile = io.stdout().match(/Log file: (.+)/u)?.[1];
    expect(logFile).toBeTruthy();
    const log = logFile ? readFileSync(logFile, "utf8") : "";
    expect(log).toContain('"event":"session_query_start"');
    expect(log).toContain('"event":"session_query_end"');
    expect(log).toContain('"session_id":"thread-1"');

    io.restore();
  });
});
