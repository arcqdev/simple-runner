import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { packRunArchive } from "../../src/logging/archive.js";

function makeTempDir(): string {
  const directory = path.join(
    os.tmpdir(),
    `kodo-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(directory, { recursive: true });
  return directory;
}

describe("packRunArchive", () => {
  it("scrubs common secret patterns from archived log files", () => {
    const runDir = makeTempDir();
    writeFileSync(
      path.join(runDir, "log.jsonl"),
      [
        '{"event":"note","message":"safe marker stays visible"}',
        '{"event":"agent","message":"card 4111111111111111 should not survive"}',
        '{"event":"agent","message":"OPENAI_API_KEY=sk-test-1234567890 SECRET_KEY=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"}',
      ].join("\n") + "\n",
      "utf8",
    );

    const archive = packRunArchive(runDir);
    expect(archive).not.toBeNull();

    const extractDir = makeTempDir();
    const extractedLog = path.join(extractDir, "log.jsonl");
    spawnSync("tar", ["-xzf", archive?.path ?? "", "-C", extractDir], { stdio: "ignore" });
    const payload = readFileSync(extractedLog, "utf8");

    expect(payload).toContain("safe marker stays visible");
    expect(payload).not.toContain("4111111111111111");
    expect(payload).not.toContain("OPENAI_API_KEY=sk-test-1234567890");
    expect(payload).not.toContain("SECRET_KEY=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
    expect(payload).toContain("[secret-redacted]");
    expect(archive?.stats.redactions).toBeGreaterThanOrEqual(2);
    expect(archive?.stats.filesChanged).toBe(1);
  });
});
