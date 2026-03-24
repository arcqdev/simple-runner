import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/main.js";
import { setPromptAdapter } from "../../src/cli/prompts.js";
import { scriptedPrompts } from "../helpers/prompts.js";
import { makeRunsHome, writeRunFixture } from "../helpers/runs.js";
import { captureOutput } from "../helpers/stdout.js";

afterEach(() => {
  vi.restoreAllMocks();
  setPromptAdapter(null);
});

function makeHomeDir(): string {
  const homeDir = path.join(
    os.tmpdir(),
    `kodo-home-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(homeDir, { recursive: true });
  return homeDir;
}

function writeExecutable(filePath: string, content: string): void {
  writeFileSync(filePath, content, "utf8");
  chmodSync(filePath, 0o755);
}

describe("runCli subcommands", () => {
  it("shows the teams help text", () => {
    const io = captureOutput();

    expect(runCli(["teams", "--help"])).toBe(0);
    expect(io.stdout()).toContain("Usage: kodo teams");
    io.restore();
  });

  it("treats singular command aliases as subcommands", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const io = captureOutput();

    expect(runCli(["run"])).toBe(0);
    expect(io.stdout()).toContain("No runs found.");
    io.restore();
  });

  it("reports an invalid teams subcommand as an error", () => {
    const io = captureOutput();

    expect(runCli(["teams", "explode"])).toBe(1);
    expect(io.stderr()).toContain("Unknown teams subcommand");
    io.restore();
  });

  it("lists built-in teams and shows missing backend hints", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    vi.stubEnv("PATH", "");
    const io = captureOutput();

    expect(runCli(["teams"])).toBe(0);
    expect(io.stdout()).toContain("full");
    expect(io.stdout()).toContain("quick");
    expect(io.stdout()).toContain("Hint: Run 'kodo teams auto'");
    io.restore();
  });

  it("auto-generates a user team from available backends", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const binDir = path.join(homeDir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, "codex"), "");
    vi.stubEnv("PATH", binDir);

    const io = captureOutput();
    expect(runCli(["teams", "auto", "quick"])).toBe(0);
    const savedPath = path.join(homeDir, ".kodo", "teams", "quick.json");
    expect(existsSync(savedPath)).toBe(true);
    expect(io.stdout()).toContain("Generated team 'quick'");
    expect(io.stdout()).toContain("Use with: kodo --team quick");

    const saved = JSON.parse(readFileSync(savedPath, "utf8")) as {
      agents: Record<string, { backend: string }>;
    };
    expect(Object.values(saved.agents).every((agent) => agent.backend === "codex")).toBe(true);
    io.restore();
  });

  it("adds a team through the prompt adapter", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    setPromptAdapter(
      scriptedPrompts([
        "Custom team",
        "",
        "worker_fast",
        "codex",
        "gpt-5.4",
        "Fast worker",
        "",
        "12",
        "",
        false,
        "",
        [],
        [],
        [],
      ]),
    );
    const io = captureOutput();

    expect(runCli(["teams", "add", "custom"])).toBe(0);
    const savedPath = path.join(homeDir, ".kodo", "teams", "custom.json");
    expect(JSON.parse(readFileSync(savedPath, "utf8"))).toMatchObject({
      description: "Custom team",
      agents: {
        worker_fast: {
          backend: "codex",
          model: "gpt-5.4",
          max_turns: 12,
        },
      },
    });
    expect(io.stdout()).toContain("Saved to");
    io.restore();
  });

  it("edits a built-in team and saves a user copy", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    setPromptAdapter(
      scriptedPrompts(["Edit team settings", "Quick but edited", "", "Save & exit"]),
    );
    const io = captureOutput();

    expect(runCli(["teams", "edit", "quick"])).toBe(0);
    const savedPath = path.join(homeDir, ".kodo", "teams", "quick.json");
    expect(existsSync(savedPath)).toBe(true);
    expect(readFileSync(savedPath, "utf8")).toContain("Quick but edited");
    expect(io.stdout()).toContain("Copying built-in team 'quick'");
    io.restore();
  });

  it("lists runs in a table and filters by project", () => {
    const homeDir = makeRunsHome();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const projectA = path.join(homeDir, "project-a");
    const projectB = path.join(homeDir, "project-b");
    writeRunFixture(homeDir, {
      runId: "20260322_120000",
      projectDir: projectA,
      completedCycles: 1,
      goal: "Fix auth flow regression",
    });
    writeRunFixture(homeDir, {
      runId: "20260322_110000",
      projectDir: projectB,
      finished: true,
      goal: "Polish docs",
    });
    const io = captureOutput();

    expect(runCli(["runs", projectA])).toBe(0);
    expect(io.stdout()).toContain("RUN ID");
    expect(io.stdout()).toContain("20260322_120000");
    expect(io.stdout()).not.toContain("20260322_110000");
    io.restore();
  });

  it("resolves logs from a selected run", () => {
    const homeDir = makeRunsHome();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    writeRunFixture(homeDir, { runId: "20260322_120000", goal: "Inspect my logs" });
    const io = captureOutput();

    expect(runCli(["logs"])).toBe(0);
    expect(io.stdout()).toContain("Log viewer: file://");
    expect(io.stdout()).toContain("Log file:");
    expect(io.stdout()).toContain("20260322_120000/log.jsonl");
    io.restore();
  });

  it("lists backend availability", () => {
    const homeDir = makeHomeDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const binDir = path.join(homeDir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, "codex"), "");
    vi.stubEnv("PATH", binDir);
    const io = captureOutput();

    expect(runCli(["backends"])).toBe(0);
    expect(io.stdout()).toContain("CLI backends (agents):");
    expect(io.stdout()).toContain("codex");
    expect(io.stdout()).toContain("API keys:");
    io.restore();
  });

  it("fails update when uv is unavailable", () => {
    vi.stubEnv("PATH", "");
    const io = captureOutput();

    expect(runCli(["update"])).toBe(1);
    expect(io.stderr()).toContain("uv is required for updating");
    io.restore();
  });

  it("prints follow-up guidance when uv upgrade fails", () => {
    const homeDir = makeHomeDir();
    const binDir = path.join(homeDir, "bin");
    mkdirSync(binDir, { recursive: true });
    writeExecutable(
      path.join(binDir, "uv"),
      `#!${process.execPath}\nprocess.stderr.write("uv explode\\n"); process.exit(2);\n`,
    );
    vi.stubEnv("PATH", binDir);
    const io = captureOutput();

    expect(runCli(["update"])).toBe(2);
    expect(io.stderr()).toContain("Update failed.");
    expect(io.stderr()).toContain("uv tool upgrade kodo --reinstall");
    io.restore();
  }, 10000);

  it("builds an issue URL from a selected run", () => {
    const homeDir = makeRunsHome();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    const project = path.join(homeDir, "project");
    writeRunFixture(homeDir, {
      runId: "20260322_120000",
      projectDir: project,
      completedCycles: 1,
      goal: "Investigate flaky auth test",
    });
    setPromptAdapter(scriptedPrompts([""]));
    const io = captureOutput();

    expect(runCli(["issue", "--project", project, "--no-open"])).toBe(0);
    expect(io.stdout()).toContain("To report this bug:");
    expect(io.stdout()).toContain("Archive:");
    expect(io.stdout()).toContain("Scrubbed:");
    expect(io.stdout()).toContain("Issue URL:");
    expect(io.stdout()).toContain("Bug%20report%3A%20run%2020260322_120000");
    io.restore();
  });

  it("fails issue creation when the project path is invalid", () => {
    const io = captureOutput();

    expect(runCli(["issue", "--project", path.join(makeHomeDir(), "missing"), "--no-open"])).toBe(
      1,
    );
    expect(io.stderr()).toContain("Project path does not exist or is not a directory");
    io.restore();
  });
});
