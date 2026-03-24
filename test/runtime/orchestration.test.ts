import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RunDir, init } from "../../src/logging/log.js";
import { runOrchestration } from "../../src/runtime/orchestration.js";
import type { ResolvedGoal, ResolvedRuntimeParams } from "../../src/cli/runtime.js";

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_STATE_DIR = process.env.FAKE_AGENT_STATE_DIR;

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

if (prompt.includes("Current Stage (1/2)")) {
  fs.writeFileSync(path.join(projectDir, "stage-1.txt"), "done\\n", "utf8");
  console.log(JSON.stringify({ type: "agent_message", message: "GOAL_DONE: stage 1 finished" }));
  process.exit(0);
}

if (prompt.includes("Current Stage (2/2)")) {
  fs.writeFileSync(path.join(projectDir, "stage-2.txt"), "done\\n", "utf8");
  console.log(JSON.stringify({ type: "agent_message", message: "GOAL_DONE: stage 2 finished" }));
  process.exit(0);
}

fs.writeFileSync(path.join(projectDir, "worker-output.txt"), "attempt " + count + "\\n", "utf8");
console.log(JSON.stringify({ type: "agent_message", message: "GOAL_DONE: worker attempt " + count }));
`;
  writeExecutable(path.join(binDir, "codex"), script);
}

function installFakeClaude(binDir: string): void {
  const script = `#!${process.execPath}
console.log(JSON.stringify({ type: "assistant", message: "ALL CHECKS PASS" }));
`;
  writeExecutable(path.join(binDir, "claude"), script);
}

function projectFlags(projectDir: string): {
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
    orchestrator: "codex:gpt-5.4",
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

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.FAKE_AGENT_STATE_DIR;
  } else {
    process.env.FAKE_AGENT_STATE_DIR = ORIGINAL_STATE_DIR;
  }
});

describe("runtime orchestration", () => {
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

    const params: ResolvedRuntimeParams = {
      autoCommit: false,
      maxCycles: 4,
      maxExchanges: 3,
      orchestrator: "codex",
      orchestratorModel: "gpt-5.4",
      team: "full",
    };
    const goal: ResolvedGoal = { goalText: "Implement the feature", source: "goal" };

    const result = runOrchestration(runDir, params, goal, projectFlags(projectDir));

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

    const params: ResolvedRuntimeParams = {
      autoCommit: true,
      maxCycles: 4,
      maxExchanges: 3,
      orchestrator: "codex",
      orchestratorModel: "gpt-5.4",
      team: "full",
    };
    const goal: ResolvedGoal = { goalText: "Ship the staged work", source: "goal" };

    const result = runOrchestration(runDir, params, goal, projectFlags(projectDir));

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
});
