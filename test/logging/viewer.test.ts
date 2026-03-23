import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { openViewer } from "../../src/viewer.js";
import { writeRunFixture } from "../helpers/runs.js";

function makeTempDir(): string {
  const directory = path.join(os.tmpdir(), `kodo-viewer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(directory, { recursive: true });
  return directory;
}

describe("viewer", () => {
  it("renders a local html viewer for valid JSONL events", () => {
    const directory = makeTempDir();
    const logFile = path.join(directory, "log.jsonl");
    writeFileSync(
      logFile,
      [
        JSON.stringify({ ts: "2026-03-23T00:00:00Z", t: 0, event: "run_start", goal: "Ship it" }),
        "not-json",
        JSON.stringify({ ts: "2026-03-23T00:00:01Z", t: 1, event: "cycle_end", summary: "done" }),
      ].join("\n") + "\n",
      "utf8",
    );

    const url = openViewer(logFile, { openBrowser: false });
    expect(url.startsWith("file://")).toBe(true);

    const htmlPath = new URL(url).pathname;
    expect(existsSync(htmlPath)).toBe(true);
    const html = readFileSync(htmlPath, "utf8");
    expect(html).toContain("kodo log viewer");
    expect(html).toContain("run_start");
    expect(html).toContain("cycle_end");
    expect(html).not.toContain("not-json");
  });

  it("skips browser launching in test environments", () => {
    const directory = makeTempDir();
    const logFile = path.join(directory, "log.jsonl");
    writeFileSync(logFile, `${JSON.stringify({ ts: "2026-03-23T00:00:00Z", t: 0, event: "run_start" })}\n`, "utf8");
    vi.stubEnv("VITEST", "true");

    expect(() => openViewer(logFile)).not.toThrow();
  });

  it("renders a run index when no log file is provided", () => {
    const homeDir = makeTempDir();
    vi.spyOn(os, "homedir").mockReturnValue(homeDir);
    writeRunFixture(homeDir, {
      runId: "20260323_010203",
      goal: "Investigate the auth regression",
      projectDir: path.join(homeDir, "project"),
    });

    const url = openViewer(null, { openBrowser: false });
    expect(url.startsWith("file://")).toBe(true);

    const htmlPath = new URL(url).pathname;
    const html = readFileSync(htmlPath, "utf8");
    expect(html).toContain("known run");
    expect(html).toContain("20260323_010203");
    expect(html).toContain("Investigate the auth regression");
  });
});
