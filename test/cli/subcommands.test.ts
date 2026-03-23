import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/main.js";
import { setPromptAdapter } from "../../src/cli/prompts.js";
import { scriptedPrompts } from "../helpers/prompts.js";
import { captureOutput } from "../helpers/stdout.js";

afterEach(() => {
  vi.restoreAllMocks();
  setPromptAdapter(null);
});

function makeHomeDir(): string {
  const homeDir = path.join(os.tmpdir(), `kodo-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(homeDir, { recursive: true });
  return homeDir;
}

describe("runCli subcommands", () => {
  it("shows the teams help text", () => {
    const io = captureOutput();

    expect(runCli(["teams", "--help"])).toBe(0);
    expect(io.stdout()).toContain("Usage: kodo teams");
    io.restore();
  });

  it("treats singular command aliases as subcommands", () => {
    const io = captureOutput();

    expect(runCli(["run"])).toBe(0);
    expect(io.stdout()).toContain("Run listing is not implemented yet");
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

    const saved = JSON.parse(readFileSync(savedPath, "utf8")) as { agents: Record<string, { backend: string }> };
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
      scriptedPrompts([
        "Edit team settings",
        "Quick but edited",
        "",
        "Save & exit",
      ]),
    );
    const io = captureOutput();

    expect(runCli(["teams", "edit", "quick"])).toBe(0);
    const savedPath = path.join(homeDir, ".kodo", "teams", "quick.json");
    expect(existsSync(savedPath)).toBe(true);
    expect(readFileSync(savedPath, "utf8")).toContain("Quick but edited");
    expect(io.stdout()).toContain("Copying built-in team 'quick'");
    io.restore();
  });
});
