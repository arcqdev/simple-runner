import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ensureDirectory, isSubPath, resolveExistingPath, safeJoin } from "../../src/runtime/fs.js";

function makeTempDir(): string {
  const directory = path.join(
    os.tmpdir(),
    `simple-runner-runtime-fs-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(directory, { recursive: true });
  return directory;
}

describe("runtime fs helpers", () => {
  it("resolves existing files and directories with kind checks", () => {
    const root = makeTempDir();
    const filePath = path.join(root, "goal.md");
    writeFileSync(filePath, "ship it\n", "utf8");

    expect(resolveExistingPath(root, "directory")).toBe(root);
    expect(resolveExistingPath(filePath, "file")).toBe(filePath);
    expect(() => resolveExistingPath(filePath, "directory")).toThrow(/Expected a directory/);
  });

  it("creates directories and blocks traversal outside the root", () => {
    const root = makeTempDir();
    const nested = ensureDirectory(path.join(root, "artifacts", "reports"));

    expect(nested).toBe(path.join(root, "artifacts", "reports"));
    expect(isSubPath(root, nested)).toBe(true);
    expect(safeJoin(root, "artifacts", "reports", "test-report.md")).toBe(
      path.join(root, "artifacts", "reports", "test-report.md"),
    );
    expect(() => safeJoin(root, "..", "escape.txt")).toThrow(/Path escapes root/);
  });
});
