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

function installFakeCodex(binDir: string): void {
  const script = `#!${process.execPath}
const args = process.argv.slice(2);
function promptFromArgs(argv) {
  if (argv[0] !== "exec") return "";
  if (argv[1] === "resume") return argv[3] || "";
  return argv[1] || "";
}
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
const stateDir = process.env.FAKE_AGENT_STATE_DIR || process.cwd();
require("node:fs").mkdirSync(stateDir, { recursive: true });
require("node:fs").writeFileSync(require("node:path").join(stateDir, "codex-argv.json"), JSON.stringify(args), "utf8");
const resumeIndex = args.indexOf("resume");
const resumed = resumeIndex !== -1 ? args[resumeIndex + 1] : null;
console.log(JSON.stringify({ type: "thread.started", thread_id: resumed ?? "thread-1" }));
console.log(JSON.stringify({ type: "token_count", input_tokens: 7, output_tokens: 11 }));
const prompt = promptFromArgs(args);
if (prompt.includes("Verify the repository state honestly.")) {
  console.log(JSON.stringify({ type: "agent_message", message: "ALL CHECKS PASS. Fresh-worker verification passed." }));
} else {
  console.log(JSON.stringify({ type: "agent_message", message: resumed ? "GOAL_DONE: Resumed " + resumed : "GOAL_DONE: Completed task" }));
}
`;
  writeExecutable(path.join(binDir, "codex"), script);
}

function installFakeClaude(binDir: string): void {
  const script = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("Claude Code CLI 1.0.0");
  process.exit(0);
}
const stateDir = process.env.FAKE_AGENT_STATE_DIR || process.cwd();
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, "claude-argv.json"), JSON.stringify(args), "utf8");
console.log(JSON.stringify({ type: "system", session_id: args.includes("--resume") ? args[args.indexOf("--resume") + 1] : "claude-session-1" }));
console.log(JSON.stringify({ type: "assistant", message: "GOAL_DONE: Claude completed" }));
`;
  writeExecutable(path.join(binDir, "claude"), script);
}

function installFakeCursor(binDir: string): void {
  const script = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("cursor-agent 1.0.0");
  process.exit(0);
}
const stateDir = process.env.FAKE_AGENT_STATE_DIR || process.cwd();
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, "cursor-argv.json"), JSON.stringify(args), "utf8");
console.log(JSON.stringify({ type: "result", result: "GOAL_DONE: Cursor completed", chatId: args.includes("--resume") ? args[args.indexOf("--resume") + 1] : "cursor-chat-1" }));
`;
  writeExecutable(path.join(binDir, "cursor-agent"), script);
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
if (args[0] === "acp") {
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
          capabilities: {
            initialize: true,
            prompt: true,
            protocolVersion: "0.1",
            resume: true,
            serverName: "fake-gemini-acp",
            sessionLifecycle: true,
            serverVersion: "1.0.0",
            streaming: true,
            usage: true,
          },
        },
      });
      return;
    }

    if (message.method === "session.create") {
      send({
        id: message.id,
        jsonrpc: "2.0",
        result: { locator: { conversationId: "gemini-session-1" } },
      });
      return;
    }

    if (message.method === "session.resume") {
      const resumed = message.params?.locator?.conversationId || "unknown";
      send({
        id: message.id,
        jsonrpc: "2.0",
        result: { locator: { conversationId: resumed } },
      });
      return;
    }

    if (message.method === "prompt") {
      send({ id: message.id, jsonrpc: "2.0", result: { accepted: true } });
      const prompt = message.params?.prompt || "";
      const resumed = fs.readFileSync(requestLog, "utf8").includes('"method":"session.resume"');
      send({
        jsonrpc: "2.0",
        method: resumed ? "session.resumed" : "session.created",
        params: {
          backend: "gemini",
          locator: { conversationId: resumed ? "gemini-session-1" : "gemini-session-1" },
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
  return;
}
const stateDir = process.env.FAKE_AGENT_STATE_DIR || process.cwd();
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, "gemini-argv.json"), JSON.stringify(args), "utf8");
console.log(JSON.stringify({ response: "GOAL_DONE: Gemini completed", stats: { models: { primary: { tokens: { prompt: 3, candidates: 2 } } } } }));
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
        capabilities: {
          initialize: true,
          prompt: true,
          protocolVersion: "0.1",
          resume: true,
          serverName: "fake-opencode-acp",
          sessionLifecycle: true,
          serverVersion: "1.0.0",
          streaming: true,
          usage: true,
        },
      },
    });
    return;
  }
  if (message.method === "session.create") {
    send({ id: message.id, jsonrpc: "2.0", result: { locator: { conversationId: "thread-9" } } });
    return;
  }
  if (message.method === "prompt") {
    send({ id: message.id, jsonrpc: "2.0", result: { accepted: true } });
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
  delete process.env.FAKE_CODEX_MODE;
  delete process.env.FAKE_GEMINI_MODE;
  delete process.env.FAKE_OPENCODE_MODE;
  delete process.env.KODO_GEMINI_ACP_BACKEND;
  delete process.env.KODO_ENABLE_SESSION_RUNTIME;
  delete process.env.FAKE_AGENT_STATE_DIR;
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
      agentName: "worker_fast",
      maxTurns: 3,
      projectDir,
      queryIndex: 1,
    });
    expect(first?.isError).toBe(false);
    expect(first?.text).toContain("Completed task");
    expect(first?.inputTokens).toBe(7);
    expect(first?.outputTokens).toBe(11);
    expect(session?.sessionId).toBe("thread-1");

    const second = session?.query("continue", {
      agentName: "worker_fast",
      maxTurns: 3,
      projectDir,
      queryIndex: 2,
    });
    expect(second?.isError).toBe(false);
    expect(second?.text).toContain("Resumed thread-1");
    expect(first?.conversationLog).toBe("conversations/worker_fast_001.jsonl.gz");
    expect(second?.conversationLog).toBe("conversations/worker_fast_002.jsonl.gz");
    const conversationFile = path.join(runDir.root, first?.conversationLog ?? "");
    expect(existsSync(conversationFile)).toBe(true);
    expect(gunzipSync(readFileSync(conversationFile)).toString("utf8")).toContain(
      '"type":"thread.started"',
    );

    session?.reset();
    expect(session?.sessionId).toBeNull();

    const log = readFileSync(runDir.logFile, "utf8");
    expect(log).toContain('"event":"session_query_start"');
    expect(log).toContain('"event":"session_query_end"');
    expect(log).toContain('"event":"session_reset"');
    expect(log).toContain('"session_id":"thread-1"');
    expect(log).toContain('"conversation_log":"conversations/worker_fast_001.jsonl.gz"');
    expect(log).toContain('"cost_bucket":"codex_subscription"');
  }, 10000);

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

  it("injects resume ids using backend-specific commands", () => {
    const binDir = makeTempDir("kodo-bin");
    installFakeCodex(binDir);
    installFakeClaude(binDir);
    installFakeCursor(binDir);
    installFakeGemini(binDir);
    useOnlyPath(binDir);

    const projectDir = makeTempDir("kodo-project");
    process.env.FAKE_AGENT_STATE_DIR = projectDir;

    const codex = createSessionForOrchestrator("codex", "gpt-5.4", {
      resumeSessionId: "thread-saved",
    });
    codex?.query("ship it", { maxTurns: 1, projectDir });
    expect(JSON.parse(readFileSync(path.join(projectDir, "codex-argv.json"), "utf8"))).toEqual(
      expect.arrayContaining(["exec", "resume", "thread-saved"]),
    );

    const claude = createSessionForOrchestrator("claude-code", "opus", {
      resumeSessionId: "claude-saved",
    });
    claude?.query("ship it", { maxTurns: 1, projectDir });
    expect(JSON.parse(readFileSync(path.join(projectDir, "claude-argv.json"), "utf8"))).toEqual(
      expect.arrayContaining(["--resume", "claude-saved"]),
    );

    const cursor = createSessionForOrchestrator("cursor", "composer", {
      resumeSessionId: "cursor-saved",
    });
    cursor?.query("ship it", { maxTurns: 1, projectDir });
    expect(JSON.parse(readFileSync(path.join(projectDir, "cursor-argv.json"), "utf8"))).toEqual(
      expect.arrayContaining(["--resume", "cursor-saved"]),
    );

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
          method: "session.resume",
          params: expect.objectContaining({
            locator: { conversationId: "gemini-session-1" },
          }),
        }),
      ]),
    );
  });

  it("runs gemini-cli sessions through ACP, preserves resume state, and saves conversations", () => {
    const binDir = makeTempDir("kodo-bin");
    installFakeGemini(binDir);
    useOnlyPath(binDir);

    const projectDir = makeTempDir("kodo-project");
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
    const binDir = makeTempDir("kodo-bin");
    installFakeGemini(binDir);
    useOnlyPath(binDir);

    const projectDir = makeTempDir("kodo-project");
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
    const binDir = makeTempDir("kodo-bin");
    installFakeGemini(binDir);
    useOnlyPath(binDir);

    const projectDir = makeTempDir("kodo-project");
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
    const binDir = makeTempDir("kodo-bin");
    installFakeGemini(binDir);
    useOnlyPath(binDir);
    process.env.FAKE_GEMINI_MODE = "empty";

    const projectDir = makeTempDir("kodo-project");
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

  it("can target the opencode ACP profile while keeping the gemini-cli session interface", () => {
    const binDir = makeTempDir("kodo-bin");
    installFakeGemini(binDir);
    installFakeOpencode(binDir);
    useOnlyPath(binDir);
    process.env.KODO_GEMINI_ACP_BACKEND = "opencode";

    const projectDir = makeTempDir("kodo-project");
    process.env.FAKE_AGENT_STATE_DIR = projectDir;
    const session = createSessionForOrchestrator("gemini-cli", "gemini-2.5-flash");
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
    expect(opencodeRequests).toContain('"method":"session.create"');
  });

  it("reports OpenCode ACP auth failures against Gemini credentials clearly", () => {
    const binDir = makeTempDir("kodo-bin");
    installFakeGemini(binDir);
    installFakeOpencode(binDir);
    useOnlyPath(binDir);
    process.env.KODO_GEMINI_ACP_BACKEND = "opencode";
    process.env.FAKE_OPENCODE_MODE = "auth";

    const projectDir = makeTempDir("kodo-project");
    const session = createSessionForOrchestrator("gemini-cli", "gemini-2.5-flash");
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
    expect(io.stdout()).toContain("Summary:");

    const logFile = io.stdout().match(/Log file: (.+)/u)?.[1];
    expect(logFile).toBeTruthy();
    const log = logFile ? readFileSync(logFile, "utf8") : "";
    expect(log).toContain('"event":"session_query_start"');
    expect(log).toContain('"event":"session_query_end"');
    expect(log).toContain('"session_id":"thread-1"');

    io.restore();
  });
});
