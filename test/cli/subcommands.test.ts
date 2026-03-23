import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../../src/cli/main.js";
import { captureOutput } from "../helpers/stdout.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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
});
