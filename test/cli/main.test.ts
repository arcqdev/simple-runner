import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/main.js";
import { setPromptAdapter } from "../../src/cli/prompts.js";
import { resetDotEnvForTests } from "../../src/config/dotenv.js";
import { scriptedPrompts } from "../helpers/prompts.js";
import { makeRunsHome, writeRunFixture } from "../helpers/runs.js";
import { captureOutput } from "../helpers/stdout.js";

function makeProjectDir(): string {
  const project = path.join(
    os.tmpdir(),
    `kodo-ts-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(project, { recursive: true });
  return project;
}

afterEach(() => {
  resetDotEnvForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setPromptAdapter(null);
});

describe("runCli main shell", () => {
  beforeEach(() => {
    vi.stubEnv("KODO_ENABLE_SESSION_RUNTIME", "0");
    vi.stubEnv("PATH", "");
  });

  it("prints help when no arguments are provided", () => {
    const io = captureOutput();

    expect(runCli([])).toBe(0);

    expect(io.stdout()).toContain("usage: kodo");
    expect(io.stdout()).toContain("subcommands:");
    io.restore();
  });

  it("prints the Python baseline version", () => {
    const io = captureOutput();

    expect(runCli(["--version"])).toBe(0);
    expect(io.stdout()).toBe("kodo 0.4.261\n");
    io.restore();
  });

  it("rewrites the test alias into the main parser", () => {
    const project = makeProjectDir();
    vi.stubEnv("KODO_ENABLE_SESSION_RUNTIME", "0");
    const io = captureOutput();

    expect(runCli(["test", "--project", project])).toBe(0);
    expect(io.stdout()).toContain("Mode: test");
    expect(io.stdout()).toContain("Run completed.");
    io.restore();
  });

  it("returns JSON help when requested", () => {
    const io = captureOutput();

    expect(runCli(["--help", "--json"])).toBe(0);
    expect(JSON.parse(io.stdout())).toEqual({
      status: "ok",
      version: "0.4.261",
      subcommands: ["test", "improve", "runs", "logs", "issue", "backends", "teams", "update"],
    });
    io.restore();
  });

  it("validates the project path before summarizing the command", () => {
    const io = captureOutput();

    expect(runCli(["--goal", "ship it", "--project", "/definitely/missing"])).toBe(1);
    expect(io.stderr()).toContain("--project path does not exist");
    io.restore();
  });

  it("emits JSON errors for validation failures in JSON mode", () => {
    const io = captureOutput();

    expect(runCli(["--json", "--goal", "   "])).toBe(1);
    expect(JSON.parse(io.stdout())).toEqual({
      status: "error",
      error: "--goal must not be empty or whitespace-only.",
    });
    io.restore();
  });

  it("rejects --target without --test", () => {
    const project = makeProjectDir();
    const target = path.join(project, "src");
    mkdirSync(target);
    const io = captureOutput();

    expect(runCli(["--goal", "x", "--project", project, "--target", "src"])).toBe(1);
    expect(io.stderr()).toContain("--target can only be used with --test.");
    io.restore();
  });

  it("accepts a valid --test target and summarizes the invocation", () => {
    const project = makeProjectDir();
    vi.stubEnv("KODO_ENABLE_SESSION_RUNTIME", "0");
    const target = path.join(project, "src");
    mkdirSync(target);
    writeFileSync(path.join(target, "index.ts"), "export {};\n");
    const io = captureOutput();

    expect(runCli(["--test", "--project", project, "--target", "src"])).toBe(0);
    expect(io.stdout()).toContain("Mode: test");
    expect(io.stdout()).toContain(`Project: ${project}`);
    expect(io.stdout()).toContain("Targets: src");
    expect(io.stdout()).toContain("Summary:");
    io.restore();
  });

  it("builds an improve goal that points at the improve report path", () => {
    const project = makeProjectDir();
    const io = captureOutput();

    expect(runCli(["--improve", "--project", project, "--focus", "error handling"])).toBe(0);
    const runDir = io.stdout().match(/Run dir: (.+)/u)?.[1];
    expect(runDir).toBeTruthy();
    const goalPath = runDir ? path.join(runDir, "goal.md") : "";
    const planPath = runDir ? path.join(runDir, "goal-plan.json") : "";
    const goal = goalPath ? readFileSync(goalPath, "utf8") : "";
    expect(goal).toContain("improve-report.md");
    expect(goal).toContain("**Focus area:** error handling");
    expect(planPath ? readFileSync(planPath, "utf8") : "").toContain(
      "Simplification & Dead Weight",
    );
    io.restore();
  });

  it("builds a fix-from goal from findings in a prior report", () => {
    const homeDir = makeRunsHome();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const project = path.join(homeDir, "project");
    mkdirSync(project, { recursive: true });
    const priorRunDir = writeRunFixture(homeDir, {
      runId: "20260322_120000",
      projectDir: project,
      goal: "Prior test run",
    });
    writeFileSync(
      path.join(priorRunDir, "test-report.md"),
      [
        "## Critical Findings",
        "- Login fails when session expires",
        "",
        "## Needs decision",
        "- Decide whether expired sessions redirect or show inline re-auth",
        "",
      ].join("\n"),
      "utf8",
    );
    const io = captureOutput();

    expect(runCli(["--fix-from", "20260322_120000", "--project", project])).toBe(0);
    const runDir = io.stdout().match(/Run dir: (.+)/u)?.[1];
    expect(runDir).toBeTruthy();
    const goalPath = runDir ? path.join(runDir, "goal.md") : "";
    const goal = goalPath ? readFileSync(goalPath, "utf8") : "";
    expect(goal).toContain("Login fails when session expires");
    expect(goal).toContain("Decide whether expired sessions redirect");
    io.restore();
  });

  it("builds a fix-from goal from Python-style test report findings", () => {
    const homeDir = makeRunsHome();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const project = path.join(homeDir, "project");
    mkdirSync(project, { recursive: true });
    const priorRunDir = writeRunFixture(homeDir, {
      runId: "20260322_120500",
      projectDir: project,
      goal: "Prior python test run",
    });
    writeFileSync(
      path.join(priorRunDir, "test-report.md"),
      [
        "# Test Report",
        "",
        "## Findings",
        "- **F1:** CLI crashes on empty config",
        "  - **Workflow:** `kodo test` with missing team config",
        "  - **Severity:** critical",
        "",
      ].join("\n"),
      "utf8",
    );
    const io = captureOutput();

    expect(runCli(["--fix-from", "20260322_120500", "--project", project])).toBe(0);
    const runDir = io.stdout().match(/Run dir: (.+)/u)?.[1];
    const goal = runDir ? readFileSync(path.join(runDir, "goal.md"), "utf8") : "";
    expect(goal).toContain("CLI crashes on empty config");
    expect(goal).toContain("Workflow:");
    io.restore();
  });

  it("emits report content in JSON mode for specialized runs", () => {
    const project = makeProjectDir();
    vi.stubEnv("KODO_ENABLE_SESSION_RUNTIME", "0");
    const io = captureOutput();

    expect(runCli(["--test", "--project", project, "--json"])).toBe(0);
    const payload = JSON.parse(io.stdout()) as Record<string, unknown>;
    expect(payload.status).toBe("completed");
    expect(payload.finished).toBe(true);
    expect(payload.test_report).toBeTypeOf("string");
    expect(payload.stages).toBeInstanceOf(Array);
    io.restore();
  });

  it("resolves the latest incomplete run for resume", () => {
    const homeDir = makeRunsHome();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const project = path.join(homeDir, "project");
    writeRunFixture(homeDir, {
      runId: "20260322_120000",
      projectDir: project,
      completedCycles: 1,
      finished: false,
    });
    writeRunFixture(homeDir, {
      runId: "20260322_110000",
      projectDir: project,
      completedCycles: 2,
      finished: true,
    });
    const io = captureOutput();

    expect(runCli(["--resume", "--project", project])).toBe(0);
    expect(io.stdout()).toContain("Run ID: 20260322_120000");
    expect(io.stdout()).toContain("Run completed.");
    io.restore();
  });

  it("prompts when multiple incomplete runs exist for resume", () => {
    const homeDir = makeRunsHome();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const project = path.join(homeDir, "project");
    writeRunFixture(homeDir, {
      runId: "20260322_120000",
      projectDir: project,
      completedCycles: 1,
      finished: false,
      goal: "Latest run",
    });
    writeRunFixture(homeDir, {
      runId: "20260322_121000",
      projectDir: project,
      completedCycles: 0,
      finished: false,
      goal: "Chosen run",
    });
    setPromptAdapter(scriptedPrompts(["20260322_121000  Chosen run"]));
    const io = captureOutput();

    expect(runCli(["--resume", "--project", project])).toBe(0);
    expect(io.stdout()).toContain("Run ID: 20260322_121000");
    expect(io.stdout()).toContain("Summary:");
    io.restore();
  }, 10000);
});
