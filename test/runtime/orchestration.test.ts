import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RunDir, init } from "../../src/logging/log.js";
import {
  ApiRuntimeOrchestrator,
  buildRuntimeOrchestrator,
  ClaudeCodeRuntimeOrchestrator,
  CodexCliRuntimeOrchestrator,
  CursorCliRuntimeOrchestrator,
  GeminiCliRuntimeOrchestrator,
  parseDoneDirective,
  runOrchestration,
  verificationPassed,
} from "../../src/runtime/orchestration.js";
import type { ResolvedGoal, ResolvedRuntimeParams } from "../../src/cli/runtime.js";
import { executePendingRun } from "../../src/runtime/engine.js";

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_STATE_DIR = process.env.FAKE_AGENT_STATE_DIR;
const ORIGINAL_CLAUDE_NUDGE = process.env.FAKE_CLAUDE_NUDGE;
const ORIGINAL_TESTER_MODE = process.env.FAKE_TESTER_MODE;
const ORIGINAL_BROWSER_MODE = process.env.FAKE_BROWSER_MODE;
const ORIGINAL_PARALLEL_RESUME_LOG = process.env.FAKE_PARALLEL_RESUME_LOG;
const ORIGINAL_TRACE_UPLOAD = process.env.KODO_TRACE_UPLOAD;
const ORIGINAL_TRACE_UPLOAD_TOKEN = process.env.KODO_TRACE_UPLOAD_ACCESS_TOKEN;
const ORIGINAL_ENABLE_SESSION_RUNTIME = process.env.KODO_ENABLE_SESSION_RUNTIME;
const ORIGINAL_FAKE_CURL_LOG = process.env.FAKE_CURL_LOG;
const ORIGINAL_SUMMARIZER_BACKEND = process.env.KODO_SUMMARIZER_BACKEND;

function makeTempDir(prefix: string): string {
  const directory = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(directory, { recursive: true });
  return directory;
}

function writeExecutable(filePath: string, content: string): void {
  writeFileSync(filePath, content, "utf8");
  chmodSync(filePath, 0o755);
}

function installFakeCodex(binDir: string): void {
  const script = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function readCounter(file) {
  try {
    return Number(fs.readFileSync(file, "utf8")) || 0;
  } catch {
    return 0;
  }
}

function writeCounter(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(value), "utf8");
}

function promptFromArgs(args) {
  if (args[0] !== "exec") return "";
  if (args[1] === "resume") return args[3] || "";
  return args[1] || "";
}

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex 1.2.3");
  process.exit(0);
}

const prompt = promptFromArgs(args);
const resumeIndex = args.indexOf("resume");
const resumed = resumeIndex === -1 ? null : args[resumeIndex + 1];
const cdIndex = args.indexOf("--cd");
const projectDir = cdIndex === -1 ? process.cwd() : args[cdIndex + 1];
const stateDir = process.env.FAKE_AGENT_STATE_DIR || projectDir;
const verifierFile = path.join(stateDir, "verifier-count.txt");
const workerFile = path.join(stateDir, "worker-count.txt");
const startFile = path.join(stateDir, "parallel-start.txt");

console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }));
console.log(JSON.stringify({ type: "token_count", input_tokens: 5, output_tokens: 7 }));

if (prompt.includes("Verify the repository state honestly.")) {
  if (prompt.includes("browser verifier")) {
    const browserMode = process.env.FAKE_BROWSER_MODE || "fail";
    const message = browserMode === "pass" ? "ALL CHECKS PASS. Browser verified." : "Found browser regressions.";
    console.log(JSON.stringify({ type: "agent_message", message }));
    process.exit(0);
  }

  if (!prompt.includes("implementation verifier")) {
    console.log(JSON.stringify({ type: "agent_message", message: "ALL CHECKS PASS. Fresh-worker verification passed." }));
    process.exit(0);
  }

  if (process.env.FAKE_TESTER_MODE === "always-pass") {
    console.log(JSON.stringify({ type: "agent_message", message: "ALL CHECKS PASS. Verified." }));
    process.exit(0);
  }

  if (process.env.FAKE_TESTER_MODE === "always-fail") {
    console.log(JSON.stringify({ type: "agent_message", message: "Found regressions. NOT ALL CHECKS PASS." }));
    process.exit(0);
  }

  const count = readCounter(verifierFile) + 1;
  writeCounter(verifierFile, count);
  const message = count === 1 ? "Found regressions. NOT ALL CHECKS PASS." : "ALL CHECKS PASS. Verified.";
  console.log(JSON.stringify({ type: "agent_message", message }));
  process.exit(0);
}

const count = readCounter(workerFile) + 1;
writeCounter(workerFile, count);

if (prompt.includes("Stage One")) {
  fs.writeFileSync(path.join(projectDir, "stage-1.txt"), "done\\n", "utf8");
  console.log(JSON.stringify({ type: "agent_message", message: "GOAL_DONE: stage 1 finished" }));
  process.exit(0);
}

if (prompt.includes("Stage Two")) {
  fs.writeFileSync(path.join(projectDir, "stage-2.txt"), "done\\n", "utf8");
  console.log(JSON.stringify({ type: "agent_message", message: "GOAL_DONE: stage 2 finished" }));
  process.exit(0);
}

if (prompt.includes("Current Stage (1/1): Discover Follow-up")) {
  fs.writeFileSync(path.join(projectDir, "discover.txt"), "done\\n", "utf8");
  console.log(JSON.stringify({ type: "agent_message", message: "GOAL_DONE: discovered follow-up\\nFOLLOW_UP_STAGE_IF_MISSING: finalize.txt || Finalize Follow-up || Create finalize.txt in the repo. || finalize.txt exists" }));
  process.exit(0);
}

if (prompt.includes("Current Stage (2/2): Finalize Follow-up")) {
  fs.writeFileSync(path.join(projectDir, "finalize.txt"), "done\\n", "utf8");
  console.log(JSON.stringify({ type: "agent_message", message: "GOAL_DONE: follow-up finished" }));
  process.exit(0);
}

if (prompt.includes("Current Stage (1/3): Early Finish")) {
  fs.writeFileSync(path.join(projectDir, "early.txt"), "done\\n", "utf8");
  console.log(JSON.stringify({ type: "agent_message", message: "GOAL_DONE: stage finished\\nADVISOR_DONE: goal complete after early finish" }));
  process.exit(0);
}

if (prompt.includes("Current Stage (2/3): Should Skip") || prompt.includes("Current Stage (3/3): Also Skip")) {
  fs.writeFileSync(path.join(projectDir, "should-not-exist.txt"), "done\\n", "utf8");
  console.log(JSON.stringify({ type: "agent_message", message: "GOAL_DONE: should not run" }));
  process.exit(0);
}

if (prompt.includes("Current Stage (2/4): Parallel A") || prompt.includes("Current Stage (3/4): Parallel B")) {
  const label = prompt.includes("Parallel A") ? "parallel-a" : "parallel-b";
  const startedAt = Date.now();
  fs.appendFileSync(startFile, label + ":" + startedAt + "\\n", "utf8");
  if (process.env.FAKE_PARALLEL_RESUME_LOG && resumed) {
    fs.appendFileSync(process.env.FAKE_PARALLEL_RESUME_LOG, label + ":" + resumed + "\\n", "utf8");
  }
  spawnSync(process.execPath, ["-e", "setTimeout(() => process.exit(0), 350)"]);
  fs.writeFileSync(path.join(projectDir, label + ".txt"), "done\\n", "utf8");
  console.log(JSON.stringify({ type: "agent_message", message: "GOAL_DONE: " + label + " finished" }));
  process.exit(0);
}

if (prompt.includes("Current Stage (4/4): Final Sequential")) {
  fs.writeFileSync(path.join(projectDir, "final-sequential.txt"), "done\\n", "utf8");
  console.log(JSON.stringify({ type: "agent_message", message: "GOAL_DONE: final sequential finished" }));
  process.exit(0);
}

if (prompt.includes("Summarizer fallback goal")) {
  fs.writeFileSync(path.join(projectDir, "worker-summary.txt"), "done\\n", "utf8");
  console.log(JSON.stringify({ type: "agent_message", message: "Updated worker-summary.txt\\nAdded coverage for summarizer fallback\\nMore detail follows." }));
  process.exit(0);
}

fs.writeFileSync(path.join(projectDir, "worker-output.txt"), "attempt " + count + "\\n", "utf8");
console.log(JSON.stringify({ type: "agent_message", message: "GOAL_DONE: worker attempt " + count }));
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

const prompt = args.at(-1) || "";
const projectDir = process.cwd();
const stateDir = process.env.FAKE_AGENT_STATE_DIR || projectDir;
const countFile = path.join(stateDir, "claude-count.txt");
let count = 0;
try {
  count = Number(fs.readFileSync(countFile, "utf8")) || 0;
} catch {}

if (prompt.includes("Verify the repository state honestly.")) {
  console.log(JSON.stringify({ type: "assistant", message: "ALL CHECKS PASS" }));
  process.exit(0);
}

count += 1;
fs.mkdirSync(path.dirname(countFile), { recursive: true });
fs.writeFileSync(countFile, String(count), "utf8");

if (process.env.FAKE_CLAUDE_NUDGE === "1" && count === 1) {
  console.log(JSON.stringify({ type: "assistant", message: "Still working." }));
  process.exit(0);
}

fs.writeFileSync(path.join(projectDir, "claude-output.txt"), "done\\n", "utf8");
console.log(JSON.stringify({ type: "assistant", message: "GOAL_DONE: claude worker finished" }));
`;
  writeExecutable(path.join(binDir, "claude"), script);
}

function installFakeCurl(binDir: string): void {
  const script = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");

const logFile = process.env.FAKE_CURL_LOG;
if (logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, JSON.stringify(process.argv.slice(2)) + "\\n", "utf8");
}
process.exit(0);
`;
  writeExecutable(path.join(binDir, "curl"), script);
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

const workspaceIndex = args.indexOf("--workspace");
const projectDir = workspaceIndex === -1 ? process.cwd() : args[workspaceIndex + 1];
const prompt = args.at(-1) || "";

if (prompt.includes("Verify the repository state honestly.")) {
  console.log(JSON.stringify({ type: "result", result: "ALL CHECKS PASS", chatId: "cursor-chat" }));
  process.exit(0);
}

fs.writeFileSync(path.join(projectDir, "cursor-output.txt"), "done\\n", "utf8");
console.log(JSON.stringify({ type: "tool_use", tool: "edit_file" }));
console.log(JSON.stringify({ type: "result", result: "GOAL_DONE: cursor worker finished", chatId: "cursor-chat" }));
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
  const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
  let promptText = "";

  rl.on("line", (line) => {
    const message = JSON.parse(line);
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
      send({ id: message.id, jsonrpc: "2.0", result: { locator: { conversationId: "gemini-thread" } } });
      return;
    }
    if (message.method === "session.resume") {
      if (process.env.FAKE_PARALLEL_RESUME_LOG) {
        fs.appendFileSync(
          process.env.FAKE_PARALLEL_RESUME_LOG,
          (message.params?.locator?.conversationId || "unknown") + "\\n",
          "utf8",
        );
      }
      send({ id: message.id, jsonrpc: "2.0", result: { locator: message.params.locator } });
      return;
    }
    if (message.method === "prompt") {
      promptText = message.params?.prompt || "";
      send({ id: message.id, jsonrpc: "2.0", result: { accepted: true } });
      send({
        jsonrpc: "2.0",
        method: "session.created",
        params: {
          backend: "gemini",
          locator: { conversationId: "gemini-thread" },
          model: "gemini-3-flash",
        },
      });
      if (promptText.includes("Verify the repository state honestly.")) {
        send({
          jsonrpc: "2.0",
          method: "result",
          params: {
            locator: { conversationId: "gemini-thread" },
            stopReason: "completed",
            text: "ALL CHECKS PASS",
            usage: { inputTokens: 10, outputTokens: 4 },
          },
        });
        return;
      }
      if (promptText.includes("Stage One")) {
        fs.writeFileSync(path.join(process.cwd(), "stage-1.txt"), "done\\n", "utf8");
        send({
          jsonrpc: "2.0",
          method: "result",
          params: {
            locator: { conversationId: "gemini-thread" },
            stopReason: "completed",
            text: "GOAL_DONE: stage 1 finished",
            usage: { inputTokens: 10, outputTokens: 4 },
          },
        });
        return;
      }
      if (promptText.includes("Current Stage (2/4): Parallel A") || promptText.includes("Current Stage (3/4): Parallel B")) {
        const label = promptText.includes("Parallel A") ? "parallel-a" : "parallel-b";
        fs.writeFileSync(path.join(process.cwd(), label + ".txt"), "done\\n", "utf8");
        send({
          jsonrpc: "2.0",
          method: "result",
          params: {
            locator: { conversationId: "gemini-thread" },
            stopReason: "completed",
            text: "GOAL_DONE: " + label + " finished",
            usage: { inputTokens: 10, outputTokens: 4 },
          },
        });
        return;
      }
      if (promptText.includes("Current Stage (4/4): Final Sequential")) {
        fs.writeFileSync(path.join(process.cwd(), "final-sequential.txt"), "done\\n", "utf8");
        send({
          jsonrpc: "2.0",
          method: "result",
          params: {
            locator: { conversationId: "gemini-thread" },
            stopReason: "completed",
            text: "GOAL_DONE: final sequential finished",
            usage: { inputTokens: 10, outputTokens: 4 },
          },
        });
        return;
      }
      fs.writeFileSync(path.join(process.cwd(), "gemini-output.txt"), "done\\n", "utf8");
      send({
        jsonrpc: "2.0",
        method: "result",
        params: {
          locator: { conversationId: "gemini-thread" },
          stopReason: "completed",
          text: "GOAL_DONE: gemini worker finished",
          usage: { inputTokens: 10, outputTokens: 4 },
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
  if (message.method === "session.resume") {
    send({ id: message.id, jsonrpc: "2.0", result: { locator: message.params.locator } });
    return;
  }
  if (message.method === "prompt") {
    const promptText = message.params?.prompt || "";
    send({ id: message.id, jsonrpc: "2.0", result: { accepted: true } });
    send({
      jsonrpc: "2.0",
      method: "thread.created",
      params: {
        id: "thread-9",
        model: "gemini-2.5-flash",
      },
    });
    if (promptText.includes("Verify the repository state honestly.")) {
      send({
        jsonrpc: "2.0",
        method: "run.completed",
        params: {
          output: "ALL CHECKS PASS",
          status: "completed",
          thread: {
            id: "thread-9",
            providerThreadId: "provider-3",
          },
          usage: {
            completion_tokens: 6,
            prompt_tokens: 4,
          },
        },
      });
      return;
    }
    fs.writeFileSync(path.join(process.cwd(), "opencode-output.txt"), "done\\n", "utf8");
    send({
      jsonrpc: "2.0",
      method: "run.completed",
      params: {
        output: "GOAL_DONE: OpenCode completed",
        status: "completed",
        thread: {
          id: "thread-9",
          providerThreadId: "provider-3",
        },
        usage: {
          completion_tokens: 6,
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

function projectFlags(
  projectDir: string,
  orchestrator = "codex:gpt-5.4",
): {
  autoRefine: false;
  cycles: number;
  debug: false;
  effort: null;
  exchanges: number;
  fixFrom: null;
  focus: null;
  goal: string;
  goalFile: null;
  help: false;
  improve: false;
  json: false;
  noAutoCommit: boolean;
  orchestrator: string;
  project: string;
  resume: null;
  skipIntake: true;
  target: [];
  team: string;
  test: false;
  version: false;
  yes: true;
} {
  return {
    autoRefine: false,
    cycles: 4,
    debug: false,
    effort: null,
    exchanges: 3,
    fixFrom: null,
    focus: null,
    goal: "Ship it",
    goalFile: null,
    help: false,
    improve: false,
    json: false,
    noAutoCommit: false,
    orchestrator,
    project: projectDir,
    resume: null,
    skipIntake: true,
    target: [],
    team: "full",
    test: false,
    version: false,
    yes: true,
  };
}

function writeProjectTeam(projectDir: string, config: object): void {
  const teamDir = path.join(projectDir, ".kodo");
  mkdirSync(teamDir, { recursive: true });
  writeFileSync(path.join(teamDir, "team.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function uniqueRunId(label: string): string {
  return `${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function initGitRepo(projectDir: string): void {
  spawnSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "test@example.com"], {
    cwd: projectDir,
    stdio: "ignore",
  });
  spawnSync("git", ["config", "user.name", "Test User"], { cwd: projectDir, stdio: "ignore" });
  writeFileSync(path.join(projectDir, "README.md"), "seed\n", "utf8");
  spawnSync("git", ["add", "README.md"], { cwd: projectDir, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "seed"], { cwd: projectDir, stdio: "ignore" });
}

function buildParams(orchestrator: string, orchestratorModel: string): ResolvedRuntimeParams {
  return {
    autoCommit: false,
    maxCycles: 4,
    maxExchanges: 3,
    orchestrator,
    orchestratorModel,
    team: "full",
  };
}

function buildGoal(text: string): ResolvedGoal {
  return { goalText: text, source: "goal" };
}

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.FAKE_AGENT_STATE_DIR;
  } else {
    process.env.FAKE_AGENT_STATE_DIR = ORIGINAL_STATE_DIR;
  }
  if (ORIGINAL_CLAUDE_NUDGE === undefined) {
    delete process.env.FAKE_CLAUDE_NUDGE;
  } else {
    process.env.FAKE_CLAUDE_NUDGE = ORIGINAL_CLAUDE_NUDGE;
  }
  if (ORIGINAL_TESTER_MODE === undefined) {
    delete process.env.FAKE_TESTER_MODE;
  } else {
    process.env.FAKE_TESTER_MODE = ORIGINAL_TESTER_MODE;
  }
  if (ORIGINAL_BROWSER_MODE === undefined) {
    delete process.env.FAKE_BROWSER_MODE;
  } else {
    process.env.FAKE_BROWSER_MODE = ORIGINAL_BROWSER_MODE;
  }
  if (ORIGINAL_PARALLEL_RESUME_LOG === undefined) {
    delete process.env.FAKE_PARALLEL_RESUME_LOG;
  } else {
    process.env.FAKE_PARALLEL_RESUME_LOG = ORIGINAL_PARALLEL_RESUME_LOG;
  }
  if (ORIGINAL_TRACE_UPLOAD === undefined) {
    delete process.env.KODO_TRACE_UPLOAD;
  } else {
    process.env.KODO_TRACE_UPLOAD = ORIGINAL_TRACE_UPLOAD;
  }
  if (ORIGINAL_TRACE_UPLOAD_TOKEN === undefined) {
    delete process.env.KODO_TRACE_UPLOAD_ACCESS_TOKEN;
  } else {
    process.env.KODO_TRACE_UPLOAD_ACCESS_TOKEN = ORIGINAL_TRACE_UPLOAD_TOKEN;
  }
  if (ORIGINAL_ENABLE_SESSION_RUNTIME === undefined) {
    delete process.env.KODO_ENABLE_SESSION_RUNTIME;
  } else {
    process.env.KODO_ENABLE_SESSION_RUNTIME = ORIGINAL_ENABLE_SESSION_RUNTIME;
  }
  if (ORIGINAL_FAKE_CURL_LOG === undefined) {
    delete process.env.FAKE_CURL_LOG;
  } else {
    process.env.FAKE_CURL_LOG = ORIGINAL_FAKE_CURL_LOG;
  }
  if (ORIGINAL_SUMMARIZER_BACKEND === undefined) {
    delete process.env.KODO_SUMMARIZER_BACKEND;
  } else {
    process.env.KODO_SUMMARIZER_BACKEND = ORIGINAL_SUMMARIZER_BACKEND;
  }
});

describe("runtime orchestration", () => {
  it("normalizes structured and marker done signals", () => {
    expect(
      parseDoneDirective('{"done_signal":{"terminal":"goal_done","summary":"json done"}}'),
    ).toEqual({
      explicit: true,
      source: "json",
      summary: "json done",
      terminal: "goal_done",
    });
    expect(parseDoneDirective("END_CYCLE: still working")).toEqual({
      explicit: true,
      source: "marker",
      summary: "still working",
      terminal: "end_cycle",
    });
    expect(parseDoneDirective("plain progress update")).toEqual({
      explicit: false,
      source: "implicit",
      summary: "plain progress update",
      terminal: "end_cycle",
    });
  });

  it("accepts only authoritative verification pass signals", () => {
    expect(verificationPassed("ALL CHECKS PASS")).toBe(true);
    expect(verificationPassed("**ALL CHECKS PASS**")).toBe(true);
    expect(verificationPassed("The agent said 'ALL CHECKS PASS' but tests fail.")).toBe(false);
    expect(verificationPassed("NOT ALL CHECKS PASS - regressions remain.")).toBe(false);
  });

  it("selects backend-specific orchestrator implementations", () => {
    expect(buildRuntimeOrchestrator(buildParams("api", "gpt-5.4"))).toBeInstanceOf(
      ApiRuntimeOrchestrator,
    );
    expect(buildRuntimeOrchestrator(buildParams("claude-code", "opus"))).toBeInstanceOf(
      ClaudeCodeRuntimeOrchestrator,
    );
    expect(buildRuntimeOrchestrator(buildParams("codex", "gpt-5.4"))).toBeInstanceOf(
      CodexCliRuntimeOrchestrator,
    );
    expect(buildRuntimeOrchestrator(buildParams("cursor", "composer-1.5"))).toBeInstanceOf(
      CursorCliRuntimeOrchestrator,
    );
    expect(buildRuntimeOrchestrator(buildParams("gemini-cli", "gemini-3-flash"))).toBeInstanceOf(
      GeminiCliRuntimeOrchestrator,
    );
  });

  it("retries after verification rejection and then completes", () => {
    const binDir = makeTempDir("kodo-bin");
    installFakeCodex(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH ?? ""}`;

    const projectDir = makeTempDir("kodo-project");
    process.env.FAKE_AGENT_STATE_DIR = projectDir;
    writeProjectTeam(projectDir, {
      agents: {
        worker_fast: { backend: "codex", model: "gpt-5.4", max_turns: 3 },
        tester: { backend: "codex", model: "gpt-5.4", max_turns: 2 },
      },
      verifiers: {
        browser_testers: [],
        reviewers: [],
        testers: ["tester"],
      },
    });

    const runDir = RunDir.create(projectDir, uniqueRunId("runtime_retry"));
    init(runDir);

    const result = runOrchestration(
      runDir,
      buildParams("codex", "gpt-5.4"),
      buildGoal("Implement the feature"),
      projectFlags(projectDir),
    );

    expect(result.finished).toBe(true);
    expect(result.cyclesCompleted).toBeGreaterThanOrEqual(2);
    expect(result.summary).toContain("worker attempt");

    const log = readFileSync(runDir.logFile, "utf8");
    expect(log).toContain('"event":"orchestrator_done_rejected"');
    expect(log).toContain('"event":"orchestrator_retry"');
    expect(log).toContain('"event":"orchestrator_done_accepted"');
  }, 15000);

  it("uses the accumulated summarizer output for end-cycle progress summaries", () => {
    const binDir = makeTempDir("kodo-bin");
    installFakeCodex(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH ?? ""}`;
    process.env.KODO_SUMMARIZER_BACKEND = "truncate";

    const projectDir = makeTempDir("summarizer-progress-project");
    process.env.FAKE_AGENT_STATE_DIR = projectDir;
    writeProjectTeam(projectDir, {
      agents: {
        worker_fast: { backend: "codex", model: "gpt-5.4", max_turns: 3 },
      },
      verifiers: { browser_testers: [], reviewers: [], testers: [] },
    });

    const runDir = RunDir.create(projectDir, uniqueRunId("runtime_summary_progress"));
    init(runDir);

    const result = runOrchestration(
      runDir,
      { ...buildParams("codex", "gpt-5.4"), maxCycles: 1 },
      buildGoal("Summarizer fallback goal"),
      projectFlags(projectDir),
    );

    expect(result.finished).toBe(false);
    expect(result.summary).toBe("[worker_fast] Updated worker-summary.txt");

    const log = readFileSync(runDir.logFile, "utf8");
    expect(log).toContain('"event":"cycle_end"');
    expect(log).toContain("[worker_fast] Updated worker-summary.txt");
  });

  it("restores a pending single-goal exchange on resume without re-running the worker prompt", () => {
    const binDir = makeTempDir("kodo-bin");
    installFakeCodex(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH ?? ""}`;

    const projectDir = makeTempDir("resume-pending-project");
    process.env.FAKE_AGENT_STATE_DIR = projectDir;
    writeProjectTeam(projectDir, {
      agents: {
        worker_fast: { backend: "codex", model: "gpt-5.4", max_turns: 3 },
      },
      verifiers: { browser_testers: [], reviewers: [], testers: [] },
    });

    const runDir = RunDir.create(projectDir, uniqueRunId("runtime_resume_pending"));
    init(runDir);
    writeFileSync(
      path.join(runDir.root, "runtime-state.json"),
      `${JSON.stringify(
        {
          agentSessionIds: { worker_fast: "thread-saved" },
          completedCycles: 0,
          completedStages: [],
          currentStageCycles: 1,
          finished: false,
          lastSummary: "",
          parallelStageState: {},
          pendingExchanges: [
            {
              agentName: "worker_fast",
              cycleIndex: 1,
              directiveTerminal: "goal_done",
              goalText: "Resume interrupted work",
              priorSummary: "",
              responseIsError: false,
              responseText: "GOAL_DONE: restored pending exchange",
              scope: "single",
              sessionId: "thread-saved",
              summary: "restored pending exchange",
            },
          ],
          stageSummaries: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = runOrchestration(
      runDir,
      buildParams("codex", "gpt-5.4"),
      buildGoal("Resume interrupted work"),
      projectFlags(projectDir),
    );

    expect(result.finished).toBe(true);
    expect(existsSync(path.join(projectDir, "worker-output.txt"))).toBe(false);
    const persisted = JSON.parse(
      readFileSync(path.join(runDir.root, "runtime-state.json"), "utf8"),
    ) as { pendingExchanges: unknown[] };
    expect(persisted.pendingExchanges).toEqual([]);
  });

  it("supports verification=skip without running verifiers", () => {
    const binDir = makeTempDir("kodo-bin");
    installFakeCodex(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH ?? ""}`;
    process.env.FAKE_TESTER_MODE = "always-fail";

    const projectDir = makeTempDir("skip-project");
    process.env.FAKE_AGENT_STATE_DIR = projectDir;
    writeProjectTeam(projectDir, {
      agents: {
        worker_fast: { backend: "codex", model: "gpt-5.4", max_turns: 3 },
        tester: { backend: "codex", model: "gpt-5.4", max_turns: 2 },
      },
      verifiers: {
        browser_testers: [],
        reviewers: [],
        testers: ["tester"],
      },
    });

    const runDir = RunDir.create(projectDir, uniqueRunId("runtime_skip"));
    init(runDir);
    writeFileSync(
      runDir.goalPlanFile,
      `${JSON.stringify(
        {
          context: "Maintain the simple project.",
          stages: [
            {
              description: "Create the first file.",
              index: 1,
              name: "Stage One",
              verification: "skip",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = runOrchestration(
      runDir,
      buildParams("codex", "gpt-5.4"),
      buildGoal("Skip verification"),
      projectFlags(projectDir),
    );

    expect(result.finished).toBe(true);
    expect(readFileSync(path.join(projectDir, "stage-1.txt"), "utf8")).toContain("done");
    expect(readFileSync(runDir.logFile, "utf8")).not.toContain('"event":"done_verification"');
  });

  it("supports quick-check verification without agent reviewers", () => {
    const binDir = makeTempDir("kodo-bin");
    installFakeCodex(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH ?? ""}`;
    process.env.FAKE_TESTER_MODE = "always-fail";

    const projectDir = makeTempDir("quick-check-project");
    process.env.FAKE_AGENT_STATE_DIR = projectDir;
    writeProjectTeam(projectDir, {
      agents: {
        worker_fast: { backend: "codex", model: "gpt-5.4", max_turns: 3 },
        tester: { backend: "codex", model: "gpt-5.4", max_turns: 2 },
      },
      verifiers: {
        browser_testers: [],
        reviewers: [],
        testers: ["tester"],
      },
    });

    const runDir = RunDir.create(projectDir, uniqueRunId("runtime_quick_check"));
    init(runDir);
    writeFileSync(
      runDir.goalPlanFile,
      `${JSON.stringify(
        {
          context: "Maintain the simple project.",
          stages: [
            {
              description: "Create the first file.",
              index: 1,
              name: "Stage One",
              verification: [
                {
                  description: "Stage output",
                  error_message: "Missing stage output.",
                  path: path.join(projectDir, "stage-1.txt"),
                },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = runOrchestration(
      runDir,
      buildParams("codex", "gpt-5.4"),
      buildGoal("Quick check verification"),
      projectFlags(projectDir),
    );

    expect(result.finished).toBe(true);
    expect(readFileSync(path.join(projectDir, "stage-1.txt"), "utf8")).toContain("done");
    expect(readFileSync(runDir.logFile, "utf8")).not.toContain('"event":"done_verification"');
  });

  it("runs browser verifiers only for browser-testing stages", () => {
    const binDir = makeTempDir("kodo-bin");
    installFakeCodex(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH ?? ""}`;
    process.env.FAKE_TESTER_MODE = "always-pass";
    process.env.FAKE_BROWSER_MODE = "fail";

    const projectDir = makeTempDir("browser-project");
    process.env.FAKE_AGENT_STATE_DIR = projectDir;
    writeProjectTeam(projectDir, {
      agents: {
        worker_fast: { backend: "codex", model: "gpt-5.4", max_turns: 3 },
        tester: { backend: "codex", model: "gpt-5.4", max_turns: 2 },
        tester_browser: { backend: "codex", model: "gpt-5.4", max_turns: 2 },
      },
      verifiers: {
        browser_testers: ["tester_browser"],
        reviewers: [],
        testers: ["tester"],
      },
    });

    const runDir = RunDir.create(projectDir, uniqueRunId("runtime_browser_control"));
    init(runDir);
    writeFileSync(
      runDir.goalPlanFile,
      `${JSON.stringify(
        {
          context: "Maintain the simple project.",
          stages: [
            { description: "Create the first file.", index: 1, name: "Stage One" },
            {
              browser_testing: true,
              description: "Create the second file.",
              index: 2,
              name: "Stage Two",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = runOrchestration(
      runDir,
      buildParams("codex", "gpt-5.4"),
      buildGoal("Browser verifier control"),
      projectFlags(projectDir),
    );

    expect(result.finished).toBe(false);
    expect(readFileSync(path.join(projectDir, "stage-1.txt"), "utf8")).toContain("done");
    const log = readFileSync(runDir.logFile, "utf8");
    expect(log).toContain('"agent":"tester_browser"');
    expect(log).toContain('"event":"orchestrator_done_rejected"');
  });

  it("runs staged plans and auto-commits each completed stage", () => {
    const binDir = makeTempDir("kodo-bin");
    installFakeCodex(binDir);
    installFakeClaude(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH ?? ""}`;

    const projectDir = makeTempDir("kodo-project");
    process.env.FAKE_AGENT_STATE_DIR = projectDir;
    writeProjectTeam(projectDir, {
      agents: {
        worker_fast: { backend: "codex", model: "gpt-5.4", max_turns: 3 },
      },
      verifiers: {
        browser_testers: [],
        reviewers: [],
        testers: [],
      },
    });

    initGitRepo(projectDir);

    const runDir = RunDir.create(projectDir, uniqueRunId("runtime_staged"));
    init(runDir);
    writeFileSync(
      runDir.goalPlanFile,
      `${JSON.stringify(
        {
          context: "Maintain the simple project.",
          stages: [
            { index: 1, name: "Stage One", description: "Create the first file." },
            { index: 2, name: "Stage Two", description: "Create the second file." },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = runOrchestration(
      runDir,
      { ...buildParams("codex", "gpt-5.4"), autoCommit: true },
      buildGoal("Ship the staged work"),
      projectFlags(projectDir),
    );

    expect(result.finished).toBe(true);
    expect(readFileSync(path.join(projectDir, "stage-1.txt"), "utf8")).toContain("done");
    expect(readFileSync(path.join(projectDir, "stage-2.txt"), "utf8")).toContain("done");

    const commitCount = spawnSync("git", ["rev-list", "--count", "HEAD"], {
      cwd: projectDir,
      encoding: "utf8",
    }).stdout.trim();
    expect(Number(commitCount)).toBeGreaterThanOrEqual(3);

    const log = readFileSync(runDir.logFile, "utf8");
    expect(log).toContain('"event":"stage_start"');
    expect(log).toContain('"event":"stage_end"');
    expect(log).toContain('"event":"auto_commit_done"');
  });

  it("adds adaptive follow-up stages discovered during execution", () => {
    const binDir = makeTempDir("kodo-bin");
    installFakeCodex(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH ?? ""}`;

    const projectDir = makeTempDir("adaptive-project");
    process.env.FAKE_AGENT_STATE_DIR = projectDir;
    writeProjectTeam(projectDir, {
      agents: {
        worker_fast: { backend: "codex", model: "gpt-5.4", max_turns: 3 },
      },
      verifiers: { browser_testers: [], reviewers: [], testers: [] },
    });

    const runDir = RunDir.create(projectDir, uniqueRunId("runtime_adaptive_followup"));
    init(runDir);
    writeFileSync(
      runDir.goalPlanFile,
      `${JSON.stringify(
        {
          context: "Maintain the simple project.",
          stages: [
            {
              index: 1,
              name: "Discover Follow-up",
              description: "Inspect the repo and determine any missing finalization work.",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = runOrchestration(
      runDir,
      buildParams("codex", "gpt-5.4"),
      buildGoal("Adaptively finish the work"),
      projectFlags(projectDir),
    );

    expect(result.finished).toBe(true);
    expect(readFileSync(path.join(projectDir, "discover.txt"), "utf8")).toContain("done");
    expect(readFileSync(path.join(projectDir, "finalize.txt"), "utf8")).toContain("done");
    const log = readFileSync(runDir.logFile, "utf8");
    expect(log).toContain('"event":"advisor_assess_start"');
    expect(log).toContain('"event":"advisor_assess_end"');
    expect(log).toContain("Finalize Follow-up");
  });

  it("lets adaptive planning finish early without consuming remaining static stages", () => {
    const binDir = makeTempDir("kodo-bin");
    installFakeCodex(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH ?? ""}`;

    const projectDir = makeTempDir("adaptive-early-project");
    process.env.FAKE_AGENT_STATE_DIR = projectDir;
    writeProjectTeam(projectDir, {
      agents: {
        worker_fast: { backend: "codex", model: "gpt-5.4", max_turns: 3 },
      },
      verifiers: { browser_testers: [], reviewers: [], testers: [] },
    });

    const runDir = RunDir.create(projectDir, uniqueRunId("runtime_adaptive_early"));
    init(runDir);
    writeFileSync(
      runDir.goalPlanFile,
      `${JSON.stringify(
        {
          context: "Maintain the simple project.",
          stages: [
            {
              index: 1,
              name: "Early Finish",
              description: "Complete the goal immediately if possible.",
            },
            {
              index: 2,
              name: "Should Skip",
              description: "This stage should be skipped if the advisor ends the run.",
            },
            { index: 3, name: "Also Skip", description: "This stage should also be skipped." },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = runOrchestration(
      runDir,
      buildParams("codex", "gpt-5.4"),
      buildGoal("Finish early"),
      projectFlags(projectDir),
    );

    expect(result.finished).toBe(true);
    expect(readFileSync(path.join(projectDir, "early.txt"), "utf8")).toContain("done");
    expect(existsSync(path.join(projectDir, "should-not-exist.txt"))).toBe(false);
    const log = readFileSync(runDir.logFile, "utf8");
    expect(log).toContain('"event":"advisor_done"');
  });

  it("runs parallel stage groups concurrently and continues with later sequential stages", () => {
    const binDir = makeTempDir("kodo-bin");
    installFakeCodex(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH ?? ""}`;

    const projectDir = makeTempDir("parallel-project");
    const stateDir = makeTempDir("parallel-state");
    process.env.FAKE_AGENT_STATE_DIR = stateDir;
    initGitRepo(projectDir);
    writeProjectTeam(projectDir, {
      agents: {
        worker_fast: { backend: "codex", model: "gpt-5.4", max_turns: 3 },
        worker_slow: { backend: "codex", model: "gpt-5.4", max_turns: 3 },
      },
      verifiers: { browser_testers: [], reviewers: [], testers: [] },
    });

    const runDir = RunDir.create(projectDir, uniqueRunId("runtime_parallel_group"));
    init(runDir);
    writeFileSync(
      runDir.goalPlanFile,
      `${JSON.stringify(
        {
          context: "Maintain the simple project.",
          stages: [
            { index: 1, name: "Setup", description: "Create the initial setup artifact." },
            {
              index: 2,
              name: "Parallel A",
              description: "Run branch A in parallel.",
              parallel_group: 1,
              persist_changes: true,
            },
            {
              index: 3,
              name: "Parallel B",
              description: "Run branch B in parallel.",
              parallel_group: 1,
              persist_changes: true,
            },
            {
              index: 4,
              name: "Final Sequential",
              description: "Finish with a sequential stage after the parallel group.",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = runOrchestration(
      runDir,
      { ...buildParams("codex", "gpt-5.4"), autoCommit: true },
      buildGoal("Run mixed staged execution"),
      projectFlags(projectDir),
    );

    expect(result.finished).toBe(true);
    expect(readFileSync(path.join(projectDir, "parallel-a.txt"), "utf8")).toContain("done");
    expect(readFileSync(path.join(projectDir, "parallel-b.txt"), "utf8")).toContain("done");
    expect(readFileSync(path.join(projectDir, "final-sequential.txt"), "utf8")).toContain("done");

    const starts = readFileSync(path.join(stateDir, "parallel-start.txt"), "utf8")
      .trim()
      .split("\n")
      .map((line) => Number(line.split(":")[1]));
    expect(starts).toHaveLength(2);
    expect(Math.abs(starts[0]! - starts[1]!)).toBeLessThan(250);

    const log = readFileSync(runDir.logFile, "utf8");
    expect(log).toContain('"event":"parallel_group_start"');
    expect(log).toContain('"event":"parallel_group_end"');
    expect(log).toContain('"event":"persist_stage_merge"');
    expect(log).toContain("Final Sequential");
  }, 12000);

  it("restores saved parallel stage sessions when resuming a staged run", () => {
    const binDir = makeTempDir("kodo-bin");
    installFakeCodex(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH ?? ""}`;

    const projectDir = makeTempDir("parallel-resume-project");
    const stateDir = makeTempDir("parallel-resume-state");
    const resumeLog = path.join(stateDir, "parallel-resumes.txt");
    process.env.FAKE_AGENT_STATE_DIR = stateDir;
    process.env.FAKE_PARALLEL_RESUME_LOG = resumeLog;
    initGitRepo(projectDir);
    writeProjectTeam(projectDir, {
      agents: {
        worker_fast: { backend: "codex", model: "gpt-5.4", max_turns: 3 },
        worker_slow: { backend: "codex", model: "gpt-5.4", max_turns: 3 },
      },
      verifiers: { browser_testers: [], reviewers: [], testers: [] },
    });

    const runDir = RunDir.create(projectDir, uniqueRunId("runtime_parallel_resume"));
    init(runDir);
    writeFileSync(
      runDir.goalPlanFile,
      `${JSON.stringify(
        {
          context: "Maintain the simple project.",
          stages: [
            { index: 1, name: "Setup", description: "Create the initial setup artifact." },
            {
              index: 2,
              name: "Parallel A",
              description: "Run branch A in parallel.",
              parallel_group: 1,
            },
            {
              index: 3,
              name: "Parallel B",
              description: "Run branch B in parallel.",
              parallel_group: 1,
            },
            {
              index: 4,
              name: "Final Sequential",
              description: "Finish with a sequential stage after the parallel group.",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    writeFileSync(
      path.join(runDir.root, "runtime-state.json"),
      `${JSON.stringify(
        {
          agentSessionIds: {},
          completedCycles: 1,
          completedStages: [1],
          currentStageCycles: 0,
          finished: false,
          lastSummary: "S2: partial a | S3: partial b",
          parallelStageState: {
            "2": {
              agentName: "worker_fast",
              cycleIndex: 2,
              priorSummary: "partial a",
              scope: "parallel",
              sessionId: "parallel-a-saved",
              stageIndex: 2,
              summary: "partial a",
            },
            "3": {
              agentName: "worker_slow",
              cycleIndex: 2,
              priorSummary: "partial b",
              scope: "parallel",
              sessionId: "parallel-b-saved",
              stageIndex: 3,
              summary: "partial b",
            },
          },
          pendingExchanges: [
            {
              agentName: "worker_fast",
              cycleIndex: 2,
              priorSummary: "partial a",
              scope: "parallel",
              sessionId: "parallel-a-saved",
              stageIndex: 2,
              summary: "partial a",
            },
            {
              agentName: "worker_slow",
              cycleIndex: 2,
              priorSummary: "partial b",
              scope: "parallel",
              sessionId: "parallel-b-saved",
              stageIndex: 3,
              summary: "partial b",
            },
          ],
          stageSummaries: ["setup done"],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = runOrchestration(
      runDir,
      buildParams("codex", "gpt-5.4"),
      buildGoal("Resume mixed staged execution"),
      projectFlags(projectDir),
    );

    expect(result.finished).toBe(true);
    const resumes = readFileSync(resumeLog, "utf8");
    expect(resumes).toContain("parallel-a:parallel-a-saved");
    expect(resumes).toContain("parallel-b:parallel-b-saved");
  }, 12000);

  it("restores saved ACP parallel stage sessions when resuming a staged run", () => {
    const binDir = makeTempDir("parallel-gemini-bin");
    installFakeGemini(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH ?? ""}`;

    const projectDir = makeTempDir("parallel-gemini-project");
    const stateDir = makeTempDir("parallel-gemini-state");
    const resumeLog = path.join(stateDir, "gemini-parallel-resumes.txt");
    process.env.FAKE_AGENT_STATE_DIR = stateDir;
    process.env.FAKE_PARALLEL_RESUME_LOG = resumeLog;
    initGitRepo(projectDir);
    writeProjectTeam(projectDir, {
      agents: {
        worker_fast: { backend: "gemini-cli", model: "gemini-3-flash", max_turns: 3 },
        worker_slow: { backend: "gemini-cli", model: "gemini-3-flash", max_turns: 3 },
      },
      verifiers: { browser_testers: [], reviewers: [], testers: [] },
    });

    const runDir = RunDir.create(projectDir, uniqueRunId("runtime_parallel_gemini_resume"));
    init(runDir);
    writeFileSync(
      runDir.goalPlanFile,
      `${JSON.stringify(
        {
          context: "Maintain the simple project.",
          stages: [
            { index: 1, name: "Stage One", description: "Create the setup artifact." },
            {
              index: 2,
              name: "Parallel A",
              description: "Run branch A in parallel.",
              parallel_group: 1,
            },
            {
              index: 3,
              name: "Parallel B",
              description: "Run branch B in parallel.",
              parallel_group: 1,
            },
            {
              index: 4,
              name: "Final Sequential",
              description: "Finish with a sequential stage after the parallel group.",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    writeFileSync(
      path.join(runDir.root, "runtime-state.json"),
      `${JSON.stringify(
        {
          agentSessionIds: {},
          completedCycles: 1,
          completedStages: [1],
          currentStageCycles: 0,
          finished: false,
          lastSummary: "S2: partial a | S3: partial b",
          parallelStageState: {
            "2": {
              agentName: "worker_fast",
              cycleIndex: 2,
              priorSummary: "partial a",
              scope: "parallel",
              sessionId: "parallel-a-saved",
              stageIndex: 2,
              summary: "partial a",
            },
            "3": {
              agentName: "worker_slow",
              cycleIndex: 2,
              priorSummary: "partial b",
              scope: "parallel",
              sessionId: "parallel-b-saved",
              stageIndex: 3,
              summary: "partial b",
            },
          },
          pendingExchanges: [
            {
              agentName: "worker_fast",
              cycleIndex: 2,
              priorSummary: "partial a",
              scope: "parallel",
              sessionId: "parallel-a-saved",
              stageIndex: 2,
              summary: "partial a",
            },
            {
              agentName: "worker_slow",
              cycleIndex: 2,
              priorSummary: "partial b",
              scope: "parallel",
              sessionId: "parallel-b-saved",
              stageIndex: 3,
              summary: "partial b",
            },
          ],
          stageSummaries: ["stage 1 done"],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = runOrchestration(
      runDir,
      buildParams("gemini-cli", "gemini-3-flash"),
      buildGoal("Resume mixed staged ACP execution"),
      projectFlags(projectDir, "gemini-cli:gemini-3-flash"),
    );

    expect(result.finished).toBe(true);
    expect(readFileSync(path.join(projectDir, "final-sequential.txt"), "utf8")).toContain("done");

    const resumes = readFileSync(resumeLog, "utf8");
    expect(resumes).toContain("parallel-a-saved");
    expect(resumes).toContain("parallel-b-saved");
  }, 12000);

  it("discards non-persisted parallel worktree changes", () => {
    const binDir = makeTempDir("kodo-bin");
    installFakeCodex(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH ?? ""}`;

    const projectDir = makeTempDir("parallel-discard-project");
    process.env.FAKE_AGENT_STATE_DIR = makeTempDir("parallel-discard-state");
    initGitRepo(projectDir);
    writeProjectTeam(projectDir, {
      agents: {
        worker_fast: { backend: "codex", model: "gpt-5.4", max_turns: 3 },
        worker_slow: { backend: "codex", model: "gpt-5.4", max_turns: 3 },
      },
      verifiers: { browser_testers: [], reviewers: [], testers: [] },
    });

    const runDir = RunDir.create(projectDir, uniqueRunId("runtime_parallel_discard"));
    init(runDir);
    writeFileSync(
      runDir.goalPlanFile,
      `${JSON.stringify(
        {
          context: "Maintain the simple project.",
          stages: [
            {
              index: 1,
              name: "Parallel A",
              description: "Run branch A in parallel.",
              parallel_group: 1,
            },
            {
              index: 2,
              name: "Parallel B",
              description: "Run branch B in parallel.",
              parallel_group: 1,
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const result = runOrchestration(
      runDir,
      buildParams("codex", "gpt-5.4"),
      buildGoal("Run isolated parallel work"),
      projectFlags(projectDir),
    );

    expect(result.finished).toBe(true);
    expect(existsSync(path.join(projectDir, "parallel-a.txt"))).toBe(false);
    expect(existsSync(path.join(projectDir, "parallel-b.txt"))).toBe(false);
  });

  it("runs the api orchestrator with team workers", () => {
    const binDir = makeTempDir("kodo-bin");
    installFakeCodex(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH ?? ""}`;

    const projectDir = makeTempDir("api-project");
    process.env.FAKE_AGENT_STATE_DIR = projectDir;
    writeProjectTeam(projectDir, {
      agents: {
        worker_fast: { backend: "codex", model: "gpt-5.4", max_turns: 3 },
      },
      verifiers: { browser_testers: [], reviewers: [], testers: [] },
    });

    const runDir = RunDir.create(projectDir, uniqueRunId("runtime_api"));
    init(runDir);

    const result = runOrchestration(
      runDir,
      buildParams("api", "gpt-5.4"),
      buildGoal("Implement with API orchestration"),
      projectFlags(projectDir, "api:gpt-5.4"),
    );

    expect(result.finished).toBe(true);
    expect(readFileSync(path.join(projectDir, "worker-output.txt"), "utf8")).toContain("attempt 1");
    const log = readFileSync(runDir.logFile, "utf8");
    expect(log).toContain('"orchestrator":"api"');
    expect(log).toContain('"event":"agent_run_end"');
    expect(log).toContain('"cost_bucket":"codex_subscription"');
    expect(log).toContain('"conversation_log":"conversations/worker_fast_001.jsonl.gz"');
    expect(existsSync(path.join(runDir.root, "conversations", "worker_fast_001.jsonl.gz"))).toBe(
      true,
    );
  });

  it("triggers trace upload during run teardown when enabled", () => {
    const binDir = makeTempDir("trace-upload-bin");
    installFakeCodex(binDir);
    installFakeCurl(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH ?? ""}`;
    process.env.KODO_ENABLE_SESSION_RUNTIME = "1";
    process.env.KODO_TRACE_UPLOAD = "1";
    process.env.KODO_TRACE_UPLOAD_ACCESS_TOKEN = "token-123";

    const curlLog = path.join(makeTempDir("trace-upload-curl"), "curl.log");
    process.env.FAKE_CURL_LOG = curlLog;

    const projectDir = makeTempDir("trace-upload-project");
    process.env.FAKE_AGENT_STATE_DIR = projectDir;
    writeProjectTeam(projectDir, {
      agents: {
        worker_fast: { backend: "codex", model: "gpt-5.4", max_turns: 3 },
      },
      verifiers: { browser_testers: [], reviewers: [], testers: [] },
    });

    const runDir = RunDir.create(projectDir, uniqueRunId("runtime_trace_upload"));
    init(runDir);

    const result = executePendingRun(
      runDir,
      buildParams("codex", "gpt-5.4"),
      buildGoal("Implement with teardown upload"),
      projectFlags(projectDir),
    );

    expect(result.finished).toBe(true);
    const log = readFileSync(runDir.logFile, "utf8");
    expect(log).toContain('"event":"trace_upload_start"');
    expect(log).toContain('"event":"trace_upload_end"');
    expect(log).toContain('"uploaded":true');

    const curlCalls = readFileSync(curlLog, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(curlCalls).toHaveLength(2);
  });

  it("nudges claude-code workers until they emit a done directive", () => {
    const binDir = makeTempDir("claude-bin");
    installFakeClaude(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH ?? ""}`;
    process.env.FAKE_CLAUDE_NUDGE = "1";

    const projectDir = makeTempDir("claude-project");
    process.env.FAKE_AGENT_STATE_DIR = projectDir;
    writeProjectTeam(projectDir, {
      agents: {
        worker_fast: { backend: "claude-cli", model: "opus", max_turns: 3 },
      },
      verifiers: { browser_testers: [], reviewers: [], testers: [] },
    });

    const runDir = RunDir.create(projectDir, uniqueRunId("runtime_claude"));
    init(runDir);

    const result = runOrchestration(
      runDir,
      buildParams("claude-code", "opus"),
      buildGoal("Implement with Claude Code"),
      projectFlags(projectDir, "claude-code:opus"),
    );

    expect(result.finished).toBe(true);
    expect(readFileSync(path.join(projectDir, "claude-output.txt"), "utf8")).toContain("done");
    const log = readFileSync(runDir.logFile, "utf8");
    expect(log).toContain('"event":"orchestrator_nudge"');
    expect(log).toContain('"orchestrator":"claude-code"');
  });

  it("runs the cursor cli orchestrator path", () => {
    const binDir = makeTempDir("cursor-bin");
    installFakeCursor(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH ?? ""}`;

    const projectDir = makeTempDir("cursor-project");
    process.env.FAKE_AGENT_STATE_DIR = projectDir;
    writeProjectTeam(projectDir, {
      agents: {
        worker_fast: { backend: "cursor", model: "composer-1.5", max_turns: 3 },
      },
      verifiers: { browser_testers: [], reviewers: [], testers: [] },
    });

    const runDir = RunDir.create(projectDir, uniqueRunId("runtime_cursor"));
    init(runDir);

    const result = runOrchestration(
      runDir,
      buildParams("cursor", "composer-1.5"),
      buildGoal("Implement with Cursor"),
      projectFlags(projectDir, "cursor:composer-1.5"),
    );

    expect(result.finished).toBe(true);
    expect(readFileSync(path.join(projectDir, "cursor-output.txt"), "utf8")).toContain("done");
    expect(readFileSync(runDir.logFile, "utf8")).toContain('"orchestrator":"cursor"');
  });

  it("runs the gemini cli orchestrator path", () => {
    const binDir = makeTempDir("gemini-bin");
    installFakeGemini(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH ?? ""}`;

    const projectDir = makeTempDir("gemini-project");
    process.env.FAKE_AGENT_STATE_DIR = projectDir;
    writeProjectTeam(projectDir, {
      agents: {
        worker_fast: { backend: "gemini-cli", model: "gemini-3-flash", max_turns: 3 },
      },
      verifiers: { browser_testers: [], reviewers: [], testers: [] },
    });

    const runDir = RunDir.create(projectDir, uniqueRunId("runtime_gemini"));
    init(runDir);

    const result = runOrchestration(
      runDir,
      buildParams("gemini-cli", "gemini-3-flash"),
      buildGoal("Implement with Gemini"),
      projectFlags(projectDir, "gemini-cli:gemini-3-flash"),
    );

    expect(result.finished).toBe(true);
    expect(readFileSync(path.join(projectDir, "gemini-output.txt"), "utf8")).toContain("done");
    expect(readFileSync(runDir.logFile, "utf8")).toContain('"orchestrator":"gemini-cli"');
  });

  it("runs opencode team agents through ACP-backed orchestration sessions", () => {
    const binDir = makeTempDir("opencode-bin");
    installFakeGemini(binDir);
    installFakeOpencode(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH ?? ""}`;

    const projectDir = makeTempDir("opencode-project");
    const stateDir = makeTempDir("opencode-state");
    process.env.FAKE_AGENT_STATE_DIR = stateDir;
    writeProjectTeam(projectDir, {
      agents: {
        worker_fast: { backend: "opencode", model: "gemini-2.5-flash", max_turns: 3 },
      },
      verifiers: { browser_testers: [], reviewers: [], testers: [] },
    });

    const runDir = RunDir.create(projectDir, uniqueRunId("runtime_opencode"));
    init(runDir);

    const result = runOrchestration(
      runDir,
      buildParams("gemini-cli", "gemini-3-flash"),
      buildGoal("Implement with OpenCode"),
      projectFlags(projectDir, "gemini-cli:gemini-3-flash"),
    );

    expect(result.finished).toBe(true);
    expect(readFileSync(path.join(projectDir, "opencode-output.txt"), "utf8")).toContain("done");
    expect(readFileSync(path.join(stateDir, "opencode-acp-requests.jsonl"), "utf8")).toContain(
      '"method":"session.create"',
    );
  });
});
