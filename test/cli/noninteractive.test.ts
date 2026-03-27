import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/main.js";
import { setPromptAdapter } from "../../src/cli/prompts.js";
import * as models from "../../src/config/models.js";
import { resetDotEnvForTests } from "../../src/config/dotenv.js";
import { projectConfigPath } from "../../src/config/project-config.js";
import { clearUserConfigCache } from "../../src/config/user-config.js";
import { getRunById, runsRoot } from "../../src/logging/runs.js";
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
  const project = path.join(
    os.tmpdir(),
    `kodo-ts-noninteractive-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(project, { recursive: true });
  return project;
}

function makeHomeDir(): string {
  const homeDir = path.join(
    os.tmpdir(),
    `kodo-home-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(homeDir, { recursive: true });
  return homeDir;
}

afterEach(() => {
  clearUserConfigCache();
  resetDotEnvForTests();
  setPromptAdapter(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("runCli noninteractive runtime resolution", () => {
  beforeEach(() => {
    vi.stubEnv("KODO_ENABLE_SESSION_RUNTIME", "0");
    vi.stubEnv("PATH", "");
  });

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
    expect(io.stdout()).toContain("Run ID:");
    expect(io.stdout()).toContain("Log file:");
    expect(io.stdout()).toContain("Run completed.");

    expect(JSON.parse(readFileSync(projectConfigPath(project), "utf8"))).toMatchObject({
      team: "full",
      orchestrator: "api",
      orchestratorModel: "gpt-5.4",
      maxExchanges: 30,
      maxCycles: 5,
      autoCommit: true,
    });
    const runId = io.stdout().match(/Run ID: (\S+)/u)?.[1];
    expect(runId).toBeTruthy();
    expect(runId ? existsSync(path.join(runsRoot(homeDir), runId, "goal.md")) : false).toBe(true);
    expect(runId ? existsSync(path.join(runsRoot(homeDir), runId, "goal-plan.json")) : false).toBe(
      true,
    );
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
    writeFileSync(path.join(binDir, "gemini"), "");
    vi.stubEnv("PATH", binDir);
    const project = makeProjectDir();
    const io = captureOutput();

    expect(runCli(["--goal", "Ship it", "--project", project])).toBe(0);
    expect(io.stdout()).toContain("Orchestrator: gemini-cli (gemini-3-flash)");
    io.restore();
  });

  it("uses user config to disable auto-commit unless the flag overrides it", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    mkdirSync(path.join(homeDir, ".kodo"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".kodo", "config.json"),
      `${JSON.stringify({ auto_commit: false })}\n`,
    );
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const project = makeProjectDir();
    const io = captureOutput();

    expect(runCli(["--goal", "Ship it", "--project", project])).toBe(0);
    expect(io.stdout()).toContain("Auto-commit: disabled");
    io.restore();
  });

  it("loads provider credentials from a cwd .env file at startup", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    for (const key of API_KEY_ENV_VARS.filter((value) => value !== "OPENAI_API_KEY")) {
      vi.stubEnv(key, "");
    }
    const previousOpenAi = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const cwd = makeProjectDir();
    writeFileSync(path.join(cwd, ".env"), "OPENAI_API_KEY=from-dotenv\n", "utf8");
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const project = makeProjectDir();
    const io = captureOutput();

    expect(runCli(["--goal", "Ship it", "--project", project])).toBe(0);
    expect(io.stdout()).toContain("Orchestrator: api (gpt-5.4)");

    cwdSpy.mockRestore();
    if (previousOpenAi === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAi;
    }
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

  it("treats a direct API model selection as the API orchestrator when credentials exist", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    const project = makeProjectDir();
    const io = captureOutput();

    expect(runCli(["--goal", "Ship it", "--project", project, "--orchestrator", "gemini-flash"])).toBe(0);
    expect(io.stdout()).toContain("Orchestrator: api (gemini-flash)");
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
        orchestrator: "gemini-cli",
        orchestratorModel: "gemini-3-flash",
        maxExchanges: 18,
        maxCycles: 2,
        autoCommit: false,
      })}\n`,
    );
    setPromptAdapter(scriptedPrompts([true, "Refine the CLI prompts", "Skip"]));
    const io = captureOutput();

    expect(runCli(["--project", project])).toBe(0);
    expect(io.stdout()).toContain("Previous config found:");
    expect(io.stdout()).toContain("Team: quick");
    expect(io.stdout()).toContain("Mode: default");
    expect(io.stdout()).toContain("Orchestrator: gemini-cli (gemini-3-flash)");
    expect(io.stdout()).toContain("Auto-commit: disabled");
    expect(io.stdout()).toContain("Run completed.");
    io.restore();
  });

  it("uses the built-in ACP team when a supported ACP runtime is available", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    for (const key of API_KEY_ENV_VARS) {
      vi.stubEnv(key, "");
    }
    const binDir = path.join(homeDir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, "gemini"), "");
    vi.stubEnv("PATH", binDir);
    const project = makeProjectDir();
    const io = captureOutput();

    expect(runCli(["--goal", "Ship it", "--project", project])).toBe(0);
    expect(io.stdout()).toContain("Team: full");
    expect(io.stdout()).toContain("Orchestrator: gemini-cli (gemini-3-flash)");
    io.restore();
  });

  it("uses a project team override before user teams with the same name", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    mkdirSync(path.join(homeDir, ".kodo", "teams"), { recursive: true });
    writeFileSync(
      path.join(homeDir, ".kodo", "teams", "full.json"),
      `${JSON.stringify({
        description: "user full",
        agents: {
          worker_fast: {
          backend: "gemini-cli",
            description: "user team agent",
            model: "gemini-3-flash",
          },
        },
      })}\n`,
    );

    const project = makeProjectDir();
    mkdirSync(path.join(project, ".kodo"), { recursive: true });
    writeFileSync(
      path.join(project, ".kodo", "team.json"),
      `${JSON.stringify({
        description: "project full",
        agents: {
          tester: {
            backend: "gemini-cli",
            description: "project team agent",
            model: "gemini-3-flash",
          },
        },
      })}\n`,
    );
    const io = captureOutput();

    expect(runCli(["--goal", "Ship it", "--project", project])).toBe(0);
    const runId = io.stdout().match(/Run ID: (\S+)/u)?.[1];
    const teamPath = runId ? path.join(runsRoot(homeDir), runId, "team.json") : "";
    expect(JSON.parse(readFileSync(teamPath, "utf8"))).toMatchObject({
      description: "project full",
      agents: {
        tester: {
          description: "project team agent",
        },
      },
    });
    io.restore();
  }, 10000);

  it("migrates a legacy last-config file when reusing it", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const project = makeProjectDir();
    mkdirSync(path.join(project, ".kodo"), { recursive: true });
    writeFileSync(
      path.join(project, ".kodo", "last-config.json"),
      `${JSON.stringify({
        mode: "full",
        orchestrator: "gemini-cli",
        orchestratorModel: "gemini-3-flash",
        maxExchanges: 30,
        maxCycles: 5,
      })}\n`,
    );
    setPromptAdapter(scriptedPrompts([true, "Ship the migration", "Skip"]));
    const io = captureOutput();

    expect(runCli(["--project", project])).toBe(0);
    expect(JSON.parse(readFileSync(projectConfigPath(project), "utf8"))).toMatchObject({
      team: "full",
      orchestrator: "gemini-cli",
      orchestratorModel: "gemini-3-flash",
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
    setPromptAdapter(
      scriptedPrompts([
        "quick — No verifiers — orchestrator is the quality gate",
        "api",
        "gpt-5.4",
        "12",
        "3",
        "high",
        "Audit the API surface",
        "Skip",
      ]),
    );
    const io = captureOutput();

    expect(runCli(["--project", project])).toBe(0);
    expect(io.stdout()).toContain("Team: quick");
    expect(io.stdout()).toContain("Budget: 12 exchanges/cycle, 3 cycles");
    expect(io.stdout()).toContain("Run completed.");
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

  it("accepts multiline interactive goals", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const project = makeProjectDir();
    mkdirSync(path.join(project, ".kodo"), { recursive: true });
    writeFileSync(
      projectConfigPath(project),
      `${JSON.stringify({
        team: "full",
        orchestrator: "api",
        orchestratorModel: "gpt-5.4",
        maxExchanges: 30,
        maxCycles: 5,
        autoCommit: true,
      })}\n`,
    );
    setPromptAdapter(scriptedPrompts([true, "Line one\n\nLine three", "Skip"]));
    const io = captureOutput();

    expect(runCli(["--project", project])).toBe(0);
    expect(io.stdout()).toContain("Goal: Line one Line three");
    io.restore();
  });

  it("creates a completed run that is discoverable by run id", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const project = makeProjectDir();
    const io = captureOutput();

    expect(runCli(["--goal", "Ship the CLI", "--project", project])).toBe(0);
    const runId = io.stdout().match(/Run ID: (\S+)/u)?.[1];
    expect(runId).toBeTruthy();

    const run = runId ? getRunById(runId, homeDir) : null;
    expect(run).not.toBeNull();
    expect(run?.goal).toBe("Ship the CLI");
    expect(run?.projectDir).toBe(project);
    expect(run?.orchestrator).toBe("api");
    expect(run?.finished).toBe(true);
    io.restore();
  });

  it("reuses project goal.md for interactive runs", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const project = makeProjectDir();
    writeFileSync(path.join(project, "goal.md"), "Refactor the auth flow\n");
    setPromptAdapter(
      scriptedPrompts([
        "full — built-in team",
        "api",
        "gpt-5.4",
        "30",
        "5",
        "standard",
        true,
        "Skip",
      ]),
    );
    const io = captureOutput();

    expect(runCli(["--project", project])).toBe(0);
    const runId = io.stdout().match(/Run ID: (\S+)/u)?.[1];
    expect(runId).toBeTruthy();
    const goalFile = runId ? path.join(runsRoot(homeDir), runId, "goal.md") : "";
    expect(goalFile ? readFileSync(goalFile, "utf8") : "").toContain("Refactor the auth flow");
    io.restore();
  });

  it("shows the audited goal preview copy before reusing goal.md", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const project = makeProjectDir();
    writeFileSync(path.join(project, "goal.md"), "Refactor the auth flow\n");
    setPromptAdapter(
      scriptedPrompts([
        "full — built-in team",
        "api",
        "gpt-5.4",
        "30",
        "5",
        "standard",
        true,
        "Skip",
      ]),
    );
    const io = captureOutput();

    expect(runCli(["--project", project])).toBe(0);
    expect(io.stdout()).toContain(`Found existing goal in ${path.join(project, "goal.md")}:`);
    expect(io.stdout()).toContain("Use this goal? [Y/n]");
    io.restore();
  });

  it("offers stored intake plans for interactive runs", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const project = makeProjectDir();
    mkdirSync(path.join(project, ".kodo", "intake"), { recursive: true });
    writeFileSync(path.join(project, "goal.md"), "Refactor the auth flow\n");
    writeFileSync(path.join(project, ".kodo", "intake", "goal.md"), "Refactor the auth flow\n");
    writeFileSync(
      path.join(project, ".kodo", "intake", "goal-plan.json"),
      `${JSON.stringify({
        context: "Auth flow context",
        stages: [
          {
            index: 1,
            name: "Inspect",
            description: "Inspect auth flow",
            acceptance_criteria: "Current auth flow is mapped",
          },
          {
            index: 2,
            name: "Refactor",
            description: "Refactor auth flow",
            acceptance_criteria: "Auth flow is updated",
          },
        ],
      })}\n`,
    );
    writeFileSync(
      projectConfigPath(project),
      `${JSON.stringify({
        team: "full",
        orchestrator: "api",
        orchestratorModel: "gpt-5.4",
        maxExchanges: 30,
        maxCycles: 5,
        autoCommit: true,
      })}\n`,
    );
    setPromptAdapter(scriptedPrompts([true, true, true]));
    const io = captureOutput();

    expect(runCli(["--project", project])).toBe(0);
    expect(io.stdout()).toContain("Found existing goal plan (2 stages):");
    expect(io.stdout()).toContain("Use this goal plan? [Y/n]");
    expect(io.stdout()).toContain("Reusing stored intake plan (2 stages).");
    io.restore();
  });

  it("auto-refines non-interactive goals into goal-refined.md", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const project = makeProjectDir();
    const io = captureOutput();

    expect(
      runCli(["--goal", "Ship the auth refresh flow", "--auto-refine", "--project", project]),
    ).toBe(0);
    const runId = io.stdout().match(/Run ID: (\S+)/u)?.[1];
    const refinedPath = runId ? path.join(runsRoot(homeDir), runId, "goal-refined.md") : "";
    const refined = refinedPath ? readFileSync(refinedPath, "utf8") : "";
    expect(refined).toContain("# Pre-implementation analysis");
    expect(refined).toContain("Constraints:");
    expect(io.stdout()).toContain("Auto-refine: surfaced implicit constraints");
    io.restore();
  });

  it("skip-intake leaves non-interactive runs without a generated plan", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const project = makeProjectDir();
    const io = captureOutput();

    expect(runCli(["--goal", "Ship the CLI", "--skip-intake", "--project", project])).toBe(0);
    const runId = io.stdout().match(/Run ID: (\S+)/u)?.[1];
    const planPath = runId ? path.join(runsRoot(homeDir), runId, "goal-plan.json") : "";
    expect(planPath ? existsSync(planPath) : false).toBe(false);
    expect(io.stdout()).toContain("Skipping intake; using the goal as provided.");
    io.restore();
  });

  it("reuses stored intake plans for repeated non-interactive goals", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const project = makeProjectDir();

    const firstIo = captureOutput();
    expect(runCli(["--goal", "Ship the CLI", "--project", project])).toBe(0);
    firstIo.restore();

    const secondIo = captureOutput();
    expect(runCli(["--goal", "Ship the CLI", "--project", project])).toBe(0);
    expect(secondIo.stdout()).toContain("Using existing goal plan");
    secondIo.restore();
  });

  it("keeps JSON output on stdout and sends launch progress to stderr", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const project = makeProjectDir();
    const io = captureOutput();

    expect(runCli(["--goal", "Ship the CLI", "--project", project, "--json"])).toBe(0);
    expect(() => JSON.parse(io.stdout())).not.toThrow();
    expect(io.stderr()).toContain("Running intake (non-interactive)");
    io.restore();
  });

  it("offers detected Ollama models during interactive orchestrator selection", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    for (const key of API_KEY_ENV_VARS) {
      vi.stubEnv(key, "");
    }
    vi.spyOn(models, "listOllamaModels").mockReturnValue(["qwen2.5-coder:14b"]);
    const project = makeProjectDir();
    setPromptAdapter(
      scriptedPrompts([
        "quick — No verifiers — orchestrator is the quality gate",
        "api",
        "ollama:qwen2.5-coder:14b",
        "12",
        "3",
        "standard",
        "Ship it locally",
        "Skip",
      ]),
    );
    const io = captureOutput();

    expect(runCli(["--project", project])).toBe(0);
    expect(JSON.parse(readFileSync(projectConfigPath(project), "utf8"))).toMatchObject({
      orchestrator: "api",
      orchestratorModel: "ollama:qwen2.5-coder:14b",
    });
    io.restore();
  });

  it("writes a test report for test mode runs", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const project = makeProjectDir();
    const target = path.join(project, "src");
    mkdirSync(target, { recursive: true });
    const io = captureOutput();

    expect(runCli(["--test", "--project", project, "--target", "src"])).toBe(0);
    const reportPath = io.stdout().match(/Report path: (.+)/u)?.[1];
    expect(reportPath).toBeTruthy();
    expect(reportPath ? readFileSync(reportPath, "utf8") : "").toContain("# Test Report");
    io.restore();
  });

  it("resumes an incomplete run and marks it complete", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    const project = makeProjectDir();
    const io = captureOutput();

    expect(runCli(["--goal", "Ship resume support", "--project", project])).toBe(0);
    const runId = io.stdout().match(/Run ID: (\S+)/u)?.[1];
    expect(runId).toBeTruthy();
    const runRoot = runId ? path.join(runsRoot(homeDir), runId) : "";
    const logPath = runRoot ? path.join(runRoot, "log.jsonl") : "";

    const trimmed = readFileSync(logPath, "utf8")
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0)
      .filter((line) => !line.includes('"event":"run_end"'))
      .join("\n");
    writeFileSync(logPath, `${trimmed}\n`, "utf8");
    io.restore();

    const resumeIo = captureOutput();
    expect(runCli(["--resume", runId ?? "", "--project", project])).toBe(0);
    expect(resumeIo.stdout()).toContain("Run completed.");
    expect(getRunById(runId ?? "", homeDir)?.finished).toBe(true);
    resumeIo.restore();
  });
});
