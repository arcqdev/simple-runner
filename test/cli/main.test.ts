import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/main.js";
import { setPromptAdapter } from "../../src/cli/prompts.js";
import { scriptedPrompts } from "../helpers/prompts.js";
import { makeRunsHome, writeRunFixture } from "../helpers/runs.js";
import { captureOutput } from "../helpers/stdout.js";

function makeProjectDir(): string {
  const project = path.join(os.tmpdir(), `kodo-ts-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(project, { recursive: true });
  return project;
}

afterEach(() => {
  vi.restoreAllMocks();
  setPromptAdapter(null);
});

describe("runCli main shell", () => {
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
    const io = captureOutput();

    expect(runCli(["test", "--project", project])).toBe(0);
    expect(io.stdout()).toContain("Mode: test");
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
    const target = path.join(project, "src");
    mkdirSync(target);
    writeFileSync(path.join(target, "index.ts"), "export {};\n");
    const io = captureOutput();

    expect(runCli(["--test", "--project", project, "--target", "src"])).toBe(0);
    expect(io.stdout()).toContain("Mode: test");
    expect(io.stdout()).toContain(`Project: ${project}`);
    io.restore();
  });

  it("resolves the latest incomplete run for resume", () => {
    const homeDir = makeRunsHome();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const project = path.join(homeDir, "project");
    writeRunFixture(homeDir, { runId: "20260322_120000", projectDir: project, completedCycles: 1, finished: false });
    writeRunFixture(homeDir, { runId: "20260322_110000", projectDir: project, completedCycles: 2, finished: true });
    const io = captureOutput();

    expect(runCli(["--resume", "--project", project])).toBe(0);
    expect(io.stdout()).toContain("Run ID: 20260322_120000");
    io.restore();
  });

  it("prompts when multiple incomplete runs exist for resume", () => {
    const homeDir = makeRunsHome();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const project = path.join(homeDir, "project");
    writeRunFixture(homeDir, { runId: "20260322_120000", projectDir: project, completedCycles: 1, finished: false, goal: "Latest run" });
    writeRunFixture(homeDir, { runId: "20260322_121000", projectDir: project, completedCycles: 0, finished: false, goal: "Chosen run" });
    setPromptAdapter(scriptedPrompts(["20260322_121000  Chosen run"]));
    const io = captureOutput();

    expect(runCli(["--resume", "--project", project])).toBe(0);
    expect(io.stdout()).toContain("Run ID: 20260322_121000");
    io.restore();
  });
});
