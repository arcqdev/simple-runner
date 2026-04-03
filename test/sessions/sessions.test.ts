import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

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
  process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH ?? ""}`;
}

function writeExecutable(filePath: string, content: string): void {
  writeFileSync(filePath, content, "utf8");
  chmodSync(filePath, 0o755);
}

function installFakeGemini(binDir: string): void {
  const script = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("gemini 1.0.0");
  process.exit(0);
}
if (!args.includes("--acp")) {
  process.exit(1);
}
const { createInterface } = require("node:readline");
const rl = createInterface({ input: process.stdin });
const mode = process.env.FAKE_GEMINI_MODE || "success";
const stateDir = process.env.FAKE_AGENT_STATE_DIR || process.cwd();
fs.mkdirSync(stateDir, { recursive: true });
const requestLog = path.join(stateDir, "gemini-acp-requests.jsonl");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const appendRequest = (message) => fs.appendFileSync(requestLog, JSON.stringify(message) + "\\n", "utf8");

rl.on("line", (line) => {
  const message = JSON.parse(line);
  appendRequest(message);

  if (message.method === "initialize") {
    send({
      id: message.id,
      jsonrpc: "2.0",
      result: {
        agentCapabilities: {
          promptCapabilities: {
            image: false,
          },
        },
        protocolVersion: 1,
      },
    });
    return;
  }

  if (message.method === "session/new") {
    send({
      id: message.id,
      jsonrpc: "2.0",
      result: { sessionId: "gemini-session-1" },
    });
    return;
  }

  if (message.method === "session/load") {
    const resumed = message.params?.sessionId || "unknown";
    send({
      id: message.id,
      jsonrpc: "2.0",
      result: { sessionId: resumed },
    });
    return;
  }

  if (message.method === "session/prompt") {
    send({ id: message.id, jsonrpc: "2.0", result: { stopReason: "completed" } });
    const prompt = message.params?.prompt?.[0]?.text || "";
    const resumed = fs.readFileSync(requestLog, "utf8").includes('"method":"session/load"');
    send({
      jsonrpc: "2.0",
      method: resumed ? "session.resumed" : "session.created",
      params: {
        backend: "gemini",
        locator: { conversationId: "gemini-session-1" },
        model: "gemini-3-flash",
      },
    });

    if (mode === "timeout") {
      send({ jsonrpc: "2.0", method: "message.delta", params: { delta: "waiting" } });
      return;
    }
    if (mode === "protocol") {
      send({ jsonrpc: "2.0", method: "session.created", params: { backend: "gemini" } });
      return;
    }
    if (mode === "auth") {
      send({
        jsonrpc: "2.0",
        method: "error",
        params: {
          error: {
            code: "permission_denied",
            message: "401 unauthorized: missing Gemini API key",
            statusCode: 401,
          },
        },
      });
      return;
    }
    if (mode === "rate") {
      send({
        jsonrpc: "2.0",
        method: "error",
        params: {
          error: {
            code: "resource_exhausted",
            message: "quota exceeded for current project",
            statusCode: 429,
            retryable: true,
          },
        },
      });
      return;
    }
    if (mode === "empty") {
      send({
        jsonrpc: "2.0",
        method: "usage",
        params: { inputTokens: 2, outputTokens: 1, costUsd: 0.002 },
      });
      send({
        jsonrpc: "2.0",
        method: "result",
        params: {
          locator: {
            conversationId: "gemini-session-1",
            providerThreadId: "provider-thread-1",
            serverSessionId: "server-session-1",
          },
          stopReason: "completed",
          text: "",
          usage: { inputTokens: 2, outputTokens: 1, costUsd: 0.002 },
        },
      });
      return;
    }

    send({ jsonrpc: "2.0", method: "message.delta", params: { delta: "working " } });
    send({
      jsonrpc: "2.0",
      method: "usage",
      params: { inputTokens: 3, outputTokens: 2, costUsd: 0.003 },
    });
    send({
      jsonrpc: "2.0",
      method: "result",
      params: {
        locator: {
          conversationId: "gemini-session-1",
          providerThreadId: "provider-thread-1",
          serverSessionId: "server-session-1",
        },
        stopReason: "completed",
        text: prompt.includes("continue") ? "GOAL_DONE: Gemini resumed" : "GOAL_DONE: Gemini completed",
        usage: { inputTokens: 3, outputTokens: 2, costUsd: 0.003 },
      },
    });
    return;
  }

  if (message.method === "shutdown") {
    send({ id: message.id, jsonrpc: "2.0", result: {} });
    process.exit(0);
  }
});
`;
  writeExecutable(path.join(binDir, "gemini"), script);
}

function installFakeOpencode(binDir: string): void {
  const script = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { createInterface } = require("node:readline");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("opencode 0.1.0");
  process.exit(0);
}
if (args[0] !== "acp") {
  process.exit(1);
}
const stateDir = process.env.FAKE_AGENT_STATE_DIR || process.cwd();
fs.mkdirSync(stateDir, { recursive: true });
const requestLog = path.join(stateDir, "opencode-acp-requests.jsonl");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(requestLog, JSON.stringify(message) + "\\n", "utf8");
  const mode = process.env.FAKE_OPENCODE_MODE || "success";
  if (message.method === "initialize") {
    send({
      id: message.id,
      jsonrpc: "2.0",
      result: {
        agentCapabilities: {
          promptCapabilities: {
            image: false,
          },
        },
        protocolVersion: 1,
      },
    });
    return;
  }
  if (message.method === "session/new") {
    send({ id: message.id, jsonrpc: "2.0", result: { sessionId: "thread-9" } });
    return;
  }
  if (message.method === "session/load") {
    send({ id: message.id, jsonrpc: "2.0", result: { sessionId: message.params.sessionId } });
    return;
  }
  if (message.method === "session/prompt") {
    send({ id: message.id, jsonrpc: "2.0", result: { stopReason: "completed" } });
    if (mode === "auth") {
      send({
        jsonrpc: "2.0",
        method: "run.failed",
        params: {
          error: {
            code: "permission_denied",
            message: "403 forbidden from Gemini provider",
            statusCode: 403,
          },
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "thread.created",
      params: {
        id: "thread-9",
        model: "gemini-2.5-flash",
      },
    });
    send({
      jsonrpc: "2.0",
      method: "run.completed",
      params: {
        output: "GOAL_DONE: OpenCode completed",
        status: "completed",
        thread: {
          id: "thread-9",
          providerThreadId: "provider-3",
          serverSessionId: "server-opencode-3",
        },
        usage: {
          completion_tokens: 6,
          costUsd: 0.004,
          prompt_tokens: 4,
        },
      },
    });
    return;
  }
  if (message.method === "shutdown") {
    send({ id: message.id, jsonrpc: "2.0", result: {} });
    process.exit(0);
  }
});
`;
  writeExecutable(path.join(binDir, "opencode"), script);
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.FAKE_GEMINI_MODE;
  delete process.env.FAKE_OPENCODE_MODE;
  delete process.env.SIMPLE_RUNNER_ENABLE_SESSION_RUNTIME;
  delete process.env.FAKE_AGENT_STATE_DIR;
  process.env.PATH = ORIGINAL_PATH;
});

describe("ACP sessions", () => {
  it("injects resume ids through ACP session/load for Gemini and OpenCode", () => {
    const binDir = makeTempDir("simple-runner-bin");
    installFakeGemini(binDir);
    installFakeOpencode(binDir);
    useOnlyPath(binDir);

    const projectDir = makeTempDir("simple-runner-project");
    init(RunDir.create(projectDir, "resume_ids"));
    process.env.FAKE_AGENT_STATE_DIR = projectDir;

    const gemini = createSessionForOrchestrator("gemini-cli", "gemini-3-flash", {
      resumeSessionId: "gemini-session-1",
    });
    gemini?.query("ship it", { maxTurns: 1, projectDir });
    const geminiRequests = readFileSync(path.join(projectDir, "gemini-acp-requests.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(geminiRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "session/load",
          params: expect.objectContaining({
            sessionId: "gemini-session-1",
          }),
        }),
      ]),
    );

    const opencode = createSessionForOrchestrator("opencode", "gemini-2.5-flash", {
      resumeSessionId: "thread-9",
    });
    opencode?.query("ship it", { maxTurns: 1, projectDir });
    const opencodeRequests = readFileSync(
      path.join(projectDir, "opencode-acp-requests.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(opencodeRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "session/load",
          params: expect.objectContaining({
            sessionId: "thread-9",
          }),
        }),
      ]),
    );
  });

  it("runs gemini-cli sessions through ACP, preserves resume state, and saves conversations", () => {
    const binDir = makeTempDir("simple-runner-bin");
    installFakeGemini(binDir);
    useOnlyPath(binDir);

    const projectDir = makeTempDir("simple-runner-project");
    const runDir = RunDir.create(projectDir, "gemini_acp_test");
    init(runDir);

    const session = createSessionForOrchestrator("gemini-cli", "gemini-3-flash");
    const first = session?.query("ship it", {
      agentName: "worker_fast",
      maxTurns: 2,
      projectDir,
      queryIndex: 1,
    });
    const second = session?.query("continue", {
      agentName: "worker_fast",
      maxTurns: 2,
      projectDir,
      queryIndex: 2,
    });

    expect(first?.isError).toBe(false);
    expect(first?.text).toContain("Gemini completed");
    expect(first?.inputTokens).toBe(3);
    expect(first?.outputTokens).toBe(2);
    expect(first?.usageRaw).toEqual({ costUsd: 0.003, inputTokens: 3, outputTokens: 2 });
    expect(first?.provider).toBe("gemini");
    expect(first?.providerThreadId).toBe("provider-thread-1");
    expect(first?.serverSessionId).toBe("server-session-1");
    expect(session?.sessionId).toBe("gemini-session-1");

    expect(second?.isError).toBe(false);
    expect(second?.text).toContain("Gemini resumed");
    expect(second?.conversationLog).toBe("conversations/worker_fast_002.jsonl.gz");

    const conversationFile = path.join(runDir.root, first?.conversationLog ?? "");
    expect(existsSync(conversationFile)).toBe(true);
    expect(gunzipSync(readFileSync(conversationFile)).toString("utf8")).toContain(
      '"method":"session.created"',
    );
    const log = readFileSync(runDir.logFile, "utf8");
    expect(log).toContain('"acp_backend":"gemini"');
    expect(log).toContain('"provider":"gemini"');
    expect(log).toContain('"provider_thread_id":"provider-thread-1"');
    expect(log).toContain('"server_session_id":"server-session-1"');
    expect(log).toContain('"usage_raw":{"inputTokens":3,"outputTokens":2,"costUsd":0.003}');
  });

  it("returns structured timeout and protocol failures for gemini ACP", () => {
    const binDir = makeTempDir("simple-runner-bin");
    installFakeGemini(binDir);
    useOnlyPath(binDir);

    const projectDir = makeTempDir("simple-runner-project");
    process.env.FAKE_GEMINI_MODE = "timeout";
    const timeoutSession = createSessionForOrchestrator("gemini-cli", "gemini-3-flash", {
      timeoutS: 1,
    });
    const timedOut = timeoutSession?.query("ship it", {
      maxTurns: 1,
      projectDir,
    });
    expect(timedOut?.isError).toBe(true);
    expect(timedOut?.text).toContain("timed out");

    process.env.FAKE_GEMINI_MODE = "protocol";
    const protocolSession = createSessionForOrchestrator("gemini-cli", "gemini-3-flash");
    const protocolError = protocolSession?.query("ship it", {
      maxTurns: 1,
      projectDir,
    });
    expect(protocolError?.isError).toBe(true);
    expect(protocolError?.text).toContain("ACP protocol error");
  });

  it("classifies Gemini ACP auth and rate-limit failures with provider hints", () => {
    const binDir = makeTempDir("simple-runner-bin");
    installFakeGemini(binDir);
    useOnlyPath(binDir);

    const projectDir = makeTempDir("simple-runner-project");
    process.env.FAKE_GEMINI_MODE = "auth";
    const authSession = createSessionForOrchestrator("gemini-cli", "gemini-3-flash");
    const authError = authSession?.query("ship it", {
      maxTurns: 1,
      projectDir,
    });
    expect(authError?.isError).toBe(true);
    expect(authError?.errorCode).toBe("unauthorized");
    expect(authError?.text).toContain("GEMINI_API_KEY");

    process.env.FAKE_GEMINI_MODE = "rate";
    const rateSession = createSessionForOrchestrator("gemini-cli", "gemini-3-flash");
    const rateError = rateSession?.query("ship it", {
      maxTurns: 1,
      projectDir,
    });
    expect(rateError?.isError).toBe(true);
    expect(rateError?.errorCode).toBe("rate_limited");
    expect(rateError?.text).toContain("Quota or rate limit");
  });

  it("handles empty terminal text from gemini ACP without forcing an error", () => {
    const binDir = makeTempDir("simple-runner-bin");
    installFakeGemini(binDir);
    useOnlyPath(binDir);
    process.env.FAKE_GEMINI_MODE = "empty";

    const projectDir = makeTempDir("simple-runner-project");
    const session = createSessionForOrchestrator("gemini-cli", "gemini-3-flash");
    const result = session?.query("ship it", {
      maxTurns: 1,
      projectDir,
    });

    expect(result?.isError).toBe(false);
    expect(result?.text).toBe("");
    expect(result?.inputTokens).toBe(2);
    expect(result?.outputTokens).toBe(1);
  });

  it("runs opencode sessions as a first-class ACP runtime choice", () => {
    const binDir = makeTempDir("simple-runner-bin");
    installFakeOpencode(binDir);
    useOnlyPath(binDir);

    const projectDir = makeTempDir("simple-runner-project");
    process.env.FAKE_AGENT_STATE_DIR = projectDir;
    const session = createSessionForOrchestrator("opencode", "gemini-2.5-flash");
    const result = session?.query("ship it", {
      maxTurns: 1,
      projectDir,
    });

    expect(result?.isError).toBe(false);
    expect(result?.text).toContain("OpenCode completed");
    expect(result?.inputTokens).toBe(4);
    expect(result?.outputTokens).toBe(6);
    expect(result?.provider).toBe("gemini");
    expect(result?.providerThreadId).toBe("provider-3");
    expect(result?.serverSessionId).toBe("server-opencode-3");
    expect(session?.sessionId).toBe("thread-9");

    const opencodeRequests = readFileSync(path.join(projectDir, "opencode-acp-requests.jsonl"), "utf8");
    expect(opencodeRequests).toContain('"method":"session/new"');
  });

  it("reports OpenCode ACP auth failures against Gemini credentials clearly", () => {
    const binDir = makeTempDir("simple-runner-bin");
    installFakeOpencode(binDir);
    useOnlyPath(binDir);
    process.env.FAKE_OPENCODE_MODE = "auth";

    const projectDir = makeTempDir("simple-runner-project");
    const session = createSessionForOrchestrator("opencode", "gemini-2.5-flash");
    const result = session?.query("ship it", {
      maxTurns: 1,
      projectDir,
    });

    expect(result?.isError).toBe(true);
    expect(result?.errorCode).toBe("unauthorized");
    expect(result?.text).toContain("opencode (Gemini provider)");
    expect(result?.text).toContain("GEMINI_API_KEY");
  });
});

describe("runtime integration", () => {
  it("runs the CLI through the ACP session layer when gemini-cli is available", () => {
    const binDir = makeTempDir("simple-runner-bin");
    installFakeGemini(binDir);
    useOnlyPath(binDir);
    process.env.SIMPLE_RUNNER_ENABLE_SESSION_RUNTIME = "1";

    const projectDir = makeTempDir("simple-runner-project");
    mkdirSync(path.join(projectDir, ".simple-runner"), { recursive: true });
    writeFileSync(
      path.join(projectDir, ".simple-runner", "team.json"),
      `${JSON.stringify(
        {
          agents: {
            worker_fast: { backend: "gemini-cli", model: "gemini-3-flash", max_turns: 3 },
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
        "gemini-cli:gemini-3-flash",
      ]),
    ).toBe(0);
    expect(io.stdout()).toContain("Orchestrator: gemini-cli (gemini-3-flash)");
    expect(io.stdout()).toContain("Summary:");

    const logFile = io.stdout().match(/Log file: (.+)/u)?.[1];
    expect(logFile).toBeTruthy();
    const log = logFile ? readFileSync(logFile, "utf8") : "";
    expect(log).toContain('"event":"session_query_start"');
    expect(log).toContain('"event":"session_query_end"');
    expect(log).toContain('"session_id":"gemini-session-1"');

    io.restore();
  }, 15000);

  it("runs the CLI through the ACP session layer when opencode is selected", () => {
    const homeDir = makeTempDir("simple-runner-home");
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const binDir = makeTempDir("simple-runner-bin");
    installFakeOpencode(binDir);
    useOnlyPath(binDir);
    process.env.SIMPLE_RUNNER_ENABLE_SESSION_RUNTIME = "1";

    const projectDir = makeTempDir("simple-runner-project");
    mkdirSync(path.join(projectDir, ".simple-runner"), { recursive: true });
    writeFileSync(
      path.join(projectDir, ".simple-runner", "team.json"),
      `${JSON.stringify(
        {
          agents: {
            worker_fast: { backend: "opencode", model: "gemini-2.5-flash", max_turns: 3 },
          },
          verifiers: { testers: [], browser_testers: [], reviewers: [] },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    process.env.FAKE_AGENT_STATE_DIR = projectDir;
    const io = captureOutput();

    expect(
      runCli([
        "--goal",
        "Ship it",
        "--project",
        projectDir,
        "--yes",
        "--orchestrator",
        "opencode:gemini-2.5-flash",
      ]),
    ).toBe(0);

    const logFile = io.stdout().match(/Log file: (.+)/u)?.[1];
    expect(logFile).toBeTruthy();
    const log = logFile ? readFileSync(logFile, "utf8") : "";
    expect(log).toContain('"event":"session_query_start"');
    expect(log).toContain('"event":"session_query_end"');
    expect(log).toContain('"acp_backend":"opencode"');
    expect(log).toContain('"provider":"gemini"');
    expect(log).toContain('"session_id":"thread-9"');

    io.restore();
  }, 15000);

  it("resumes an interrupted Gemini ACP run through CLI resume semantics", () => {
    const homeDir = makeTempDir("simple-runner-home");
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const binDir = makeTempDir("simple-runner-bin");
    installFakeGemini(binDir);
    useOnlyPath(binDir);
    process.env.SIMPLE_RUNNER_ENABLE_SESSION_RUNTIME = "1";

    const projectDir = makeTempDir("simple-runner-project");
    process.env.FAKE_AGENT_STATE_DIR = projectDir;
    const runId = "gemini_resume";
    const runRoot = path.join(homeDir, ".simple-runner", "runs", runId);
    mkdirSync(runRoot, { recursive: true });
    writeFileSync(
      path.join(runRoot, "log.jsonl"),
      [
        {
          event: "run_init",
          project_dir: projectDir,
          version: "0.4.261",
        },
        {
          event: "cli_args",
          goal_text: "Resume Gemini ACP run",
          max_cycles: 5,
          max_exchanges: 20,
          orchestrator: "gemini-cli",
          orchestrator_model: "gemini-3-flash",
          project_dir: projectDir,
          team: "quick",
        },
        {
          event: "run_start",
          goal: "Resume Gemini ACP run",
          max_cycles: 5,
          max_exchanges: 20,
          model: "gemini-3-flash",
          orchestrator: "gemini-cli",
          project_dir: projectDir,
          resumed: false,
          team: ["worker_fast"],
        },
        {
          event: "cycle_end",
          finished: false,
          summary: "Cycle 1 interrupted before completion",
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
      "utf8",
    );
    writeFileSync(path.join(runRoot, "goal.md"), "Resume Gemini ACP run\n", "utf8");
    writeFileSync(
      path.join(runRoot, "team.json"),
      `${JSON.stringify(
        {
          agents: {
            worker_fast: { backend: "gemini-cli", model: "gemini-3-flash", max_turns: 3 },
          },
          verifiers: { testers: [], browser_testers: [], reviewers: [] },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    writeFileSync(
      path.join(runRoot, "config.json"),
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
    writeFileSync(
      path.join(runRoot, "runtime-state.json"),
      `${JSON.stringify(
        {
          agentSessionIds: {
            worker_fast: "gemini-session-1",
          },
          completedCycles: 1,
          completedStages: [],
          currentStageCycles: 0,
          finished: false,
          lastSummary: "Cycle 1 interrupted before completion",
          parallelStageState: {},
          pendingExchanges: [],
          stageSummaries: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const io = captureOutput();
    expect(runCli(["--resume", runId, "--project", projectDir, "--yes"])).toBe(0);

    const requests = readFileSync(path.join(projectDir, "gemini-acp-requests.jsonl"), "utf8");
    expect(requests).toContain('"method":"session/load"');
    const resumedLog = readFileSync(path.join(runRoot, "log.jsonl"), "utf8");
    expect(resumedLog).toContain('"event":"run_resumed"');
    expect(resumedLog).toContain('"acp_backend":"gemini"');
    expect(resumedLog).toContain('"session_id":"gemini-session-1"');
    expect(resumedLog).toContain('"event":"run_end"');

    io.restore();
  }, 20000);
});
