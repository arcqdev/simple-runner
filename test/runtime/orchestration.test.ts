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
  runOrchestration,
} from "../../src/runtime/orchestration.js";
import type { ResolvedGoal, ResolvedRuntimeParams } from "../../src/cli/runtime.js";

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_STATE_DIR = process.env.FAKE_AGENT_STATE_DIR;
const ORIGINAL_CLAUDE_NUDGE = process.env.FAKE_CLAUDE_NUDGE;

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
const cdIndex = args.indexOf("--cd");
const projectDir = cdIndex === -1 ? process.cwd() : args[cdIndex + 1];
const stateDir = process.env.FAKE_AGENT_STATE_DIR || projectDir;
const verifierFile = path.join(stateDir, "verifier-count.txt");
const workerFile = path.join(stateDir, "worker-count.txt");
const startFile = path.join(stateDir, "parallel-start.txt");

console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }));
console.log(JSON.stringify({ type: "token_count", input_tokens: 5, output_tokens: 7 }));

if (prompt.includes("Verify the repository state honestly.")) {
  const count = readCounter(verifierFile) + 1;
  writeCounter(verifierFile, count);
  const message = count === 1 ? "Found regressions. NOT ALL CHECKS PASS." : "ALL CHECKS PASS. Verified.";
  console.log(JSON.stringify({ type: "agent_message", message }));
  process.exit(0);
}

const count = readCounter(workerFile) + 1;
writeCounter(workerFile, count);

if (prompt.includes("Current Stage (1/2): Stage One")) {
  fs.writeFileSync(path.join(projectDir, "stage-1.txt"), "done\\n", "utf8");
  console.log(JSON.stringify({ type: "agent_message", message: "GOAL_DONE: stage 1 finished" }));
  process.exit(0);
}

if (prompt.includes("Current Stage (2/2): Stage Two")) {
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

const promptIndex = args.indexOf("-p");
const prompt = promptIndex === -1 ? "" : (args[promptIndex + 1] || "");

if (prompt.includes("Verify the repository state honestly.")) {
  console.log(JSON.stringify({ response: "ALL CHECKS PASS", stats: { models: { primary: { tokens: { prompt: 10, candidates: 4 } } } } }));
  process.exit(0);
}

fs.writeFileSync(path.join(process.cwd(), "gemini-output.txt"), "done\\n", "utf8");
console.log(JSON.stringify({ response: "GOAL_DONE: gemini worker finished", stats: { models: { primary: { tokens: { prompt: 10, candidates: 4 } } } } }));
`;
  writeExecutable(path.join(binDir, "gemini"), script);
}

function projectFlags(projectDir: string, orchestrator = "codex:gpt-5.4"): {
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
});

describe("runtime orchestration", () => {
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

    spawnSync("git", ["init"], { cwd: projectDir, stdio: "ignore" });
    spawnSync("git", ["config", "user.email", "test@example.com"], {
      cwd: projectDir,
      stdio: "ignore",
    });
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: projectDir, stdio: "ignore" });
    writeFileSync(path.join(projectDir, "README.md"), "seed\n", "utf8");
    spawnSync("git", ["add", "README.md"], { cwd: projectDir, stdio: "ignore" });
    spawnSync("git", ["commit", "-m", "seed"], { cwd: projectDir, stdio: "ignore" });

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
            { index: 1, name: "Discover Follow-up", description: "Inspect the repo and determine any missing finalization work." },
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
            { index: 1, name: "Early Finish", description: "Complete the goal immediately if possible." },
            { index: 2, name: "Should Skip", description: "This stage should be skipped if the advisor ends the run." },
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
    process.env.FAKE_AGENT_STATE_DIR = projectDir;
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
            { index: 2, name: "Parallel A", description: "Run branch A in parallel.", parallel_group: 1 },
            { index: 3, name: "Parallel B", description: "Run branch B in parallel.", parallel_group: 1 },
            { index: 4, name: "Final Sequential", description: "Finish with a sequential stage after the parallel group." },
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
      buildGoal("Run mixed staged execution"),
      projectFlags(projectDir),
    );

    expect(result.finished).toBe(true);
    expect(readFileSync(path.join(projectDir, "parallel-a.txt"), "utf8")).toContain("done");
    expect(readFileSync(path.join(projectDir, "parallel-b.txt"), "utf8")).toContain("done");
    expect(readFileSync(path.join(projectDir, "final-sequential.txt"), "utf8")).toContain("done");

    const starts = readFileSync(path.join(projectDir, "parallel-start.txt"), "utf8")
      .trim()
      .split("\n")
      .map((line) => Number(line.split(":")[1]));
    expect(starts).toHaveLength(2);
    expect(Math.abs(starts[0]! - starts[1]!)).toBeLessThan(250);

    const log = readFileSync(runDir.logFile, "utf8");
    expect(log).toContain('"event":"parallel_group_start"');
    expect(log).toContain('"event":"parallel_group_end"');
    expect(log).toContain("Final Sequential");
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
    expect(readFileSync(runDir.logFile, "utf8")).toContain('"orchestrator":"api"');
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
});
