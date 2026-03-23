import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/main.js";
import { setPromptAdapter } from "../../src/cli/prompts.js";
import { projectConfigPath } from "../../src/config/project-config.js";
import { clearUserConfigCache } from "../../src/config/user-config.js";
import { scriptedPrompts } from "../helpers/prompts.js";
import { captureOutput } from "../helpers/stdout.js";

const API_KEY_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "DEEPSEEK_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
] as const;

function makeProjectDir(): string {
  const project = path.join(os.tmpdir(), `kodo-ts-noninteractive-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(project, { recursive: true });
  return project;
}

function makeHomeDir(): string {
  const homeDir = path.join(os.tmpdir(), `kodo-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(homeDir, { recursive: true });
  return homeDir;
}

afterEach(() => {
  clearUserConfigCache();
  setPromptAdapter(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("runCli noninteractive runtime resolution", () => {
  it("loads goal text from --goal-file and persists resolved params", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const project = makeProjectDir();
    const goalFile = path.join(project, "goal.md");
    writeFileSync(goalFile, "Build an API server\n");
    const io = captureOutput();

    expect(runCli(["--goal-file", goalFile, "--project", project])).toBe(0);
    expect(io.stdout()).toContain("Goal source: goal-file");
    expect(io.stdout()).toContain("Goal: Build an API server");
    expect(io.stdout()).toContain("Orchestrator: api (gpt-5.4)");

    expect(JSON.parse(readFileSync(projectConfigPath(project), "utf8"))).toMatchObject({
      team: "full",
      orchestrator: "api",
      orchestratorModel: "gpt-5.4",
      maxExchanges: 30,
      maxCycles: 5,
      autoCommit: true,
    });
    io.restore();
  });

  it("prefers a CLI orchestrator when no API keys are available", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    for (const key of API_KEY_ENV_VARS) {
      vi.stubEnv(key, "");
    }
    const binDir = path.join(homeDir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, "codex"), "");
    vi.stubEnv("PATH", binDir);
    const project = makeProjectDir();
    const io = captureOutput();

    expect(runCli(["--goal", "Ship it", "--project", project])).toBe(0);
    expect(io.stdout()).toContain("Orchestrator: codex (gpt-5.4)");
    io.restore();
  });

  it("uses user config to disable auto-commit unless the flag overrides it", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    mkdirSync(path.join(homeDir, ".kodo"), { recursive: true });
    writeFileSync(path.join(homeDir, ".kodo", "config.json"), `${JSON.stringify({ auto_commit: false })}\n`);
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const project = makeProjectDir();
    const io = captureOutput();

    expect(runCli(["--goal", "Ship it", "--project", project])).toBe(0);
    expect(io.stdout()).toContain("Auto-commit: disabled");
    io.restore();
  });

  it("fails when an API-only model is requested without provider credentials", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    for (const key of API_KEY_ENV_VARS) {
      vi.stubEnv(key, "");
    }
    vi.stubEnv("PATH", "");
    const project = makeProjectDir();
    const io = captureOutput();

    expect(runCli(["--goal", "Ship it", "--project", project, "--orchestrator", "opus"])).toBe(1);
    expect(io.stderr()).toContain("API orchestrator selected but no provider API key was found");
    io.restore();
  });

  it("reuses the previous project config for interactive runs", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const project = makeProjectDir();
    mkdirSync(path.join(project, ".kodo"), { recursive: true });
    writeFileSync(
      projectConfigPath(project),
      `${JSON.stringify({
        team: "quick",
        orchestrator: "codex",
        orchestratorModel: "gpt-5.4",
        maxExchanges: 18,
        maxCycles: 2,
        autoCommit: false,
      })}\n`,
    );
    setPromptAdapter(scriptedPrompts([true]));
    const io = captureOutput();

    expect(runCli(["--project", project])).toBe(0);
    expect(io.stdout()).toContain("Previous config found:");
    expect(io.stdout()).toContain("Team: quick");
    expect(io.stdout()).toContain("Mode: default");
    expect(io.stdout()).toContain("Orchestrator: codex (gpt-5.4)");
    expect(io.stdout()).toContain("Auto-commit: disabled");
    io.restore();
  });

  it("migrates a legacy last-config file when reusing it", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const project = makeProjectDir();
    mkdirSync(path.join(project, ".kodo"), { recursive: true });
    writeFileSync(
      path.join(project, ".kodo", "last-config.json"),
      `${JSON.stringify({
        mode: "full",
        orchestrator: "codex",
        orchestratorModel: "gpt-5.4",
        maxExchanges: 30,
        maxCycles: 5,
      })}\n`,
    );
    setPromptAdapter(scriptedPrompts([true]));
    const io = captureOutput();

    expect(runCli(["--project", project])).toBe(0);
    expect(JSON.parse(readFileSync(projectConfigPath(project), "utf8"))).toMatchObject({
      team: "full",
      orchestrator: "codex",
      orchestratorModel: "gpt-5.4",
      maxExchanges: 30,
      maxCycles: 5,
    });
    io.restore();
  });

  it("prompts for runtime params when no project config exists", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const project = makeProjectDir();
    setPromptAdapter(scriptedPrompts(["quick — No verifiers — orchestrator is the quality gate", "api", "gpt-5.4", "12", "3", "high"]));
    const io = captureOutput();

    expect(runCli(["--project", project])).toBe(0);
    expect(io.stdout()).toContain("Team: quick");
    expect(io.stdout()).toContain("Budget: 12 exchanges/cycle, 3 cycles");
    expect(JSON.parse(readFileSync(projectConfigPath(project), "utf8"))).toMatchObject({
      team: "quick",
      orchestrator: "api",
      orchestratorModel: "gpt-5.4",
      maxExchanges: 12,
      maxCycles: 3,
      autoCommit: true,
      effort: "high",
    });
    io.restore();
  });
});
