import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  cleanupStaleWorktrees,
  commitWorktreeChanges,
  createWorktree,
  mergeWorktreeBranch,
  removeWorktree,
  removeWorktreeKeepBranch,
} from "../../src/runtime/git-worktree.js";

function makeTempDir(prefix: string): string {
  const directory = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  rmSync(directory, { force: true, recursive: true });
  mkdirSync(directory, { recursive: true });
  return directory;
}

function runGit(projectDir: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: projectDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  expect(result.status).toBe(0);
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function initGitRepo(projectDir: string): void {
  runGit(projectDir, ["init"]);
  runGit(projectDir, ["config", "user.email", "test@example.com"]);
  runGit(projectDir, ["config", "user.name", "Test User"]);
  writeFileSync(path.join(projectDir, "README.md"), "seed\n", "utf8");
  runGit(projectDir, ["add", "README.md"]);
  runGit(projectDir, ["commit", "-m", "seed"]);
}

describe("git worktree helpers", () => {
  it("creates isolated worktrees and cleans them up with their branches", () => {
    const projectDir = makeTempDir("git-worktree-project");
    initGitRepo(projectDir);

    const worktree = createWorktree(projectDir, "stage/@ 2");
    expect(worktree.branchName).toMatch(/^kodo-stage_2-[0-9a-f]{8}$/u);
    expect(existsSync(worktree.worktreeDir)).toBe(true);

    writeFileSync(path.join(worktree.worktreeDir, "isolated.txt"), "hello\n", "utf8");
    expect(existsSync(path.join(projectDir, "isolated.txt"))).toBe(false);

    removeWorktree(projectDir, worktree.worktreeDir, worktree.branchName);
    expect(existsSync(worktree.worktreeDir)).toBe(false);
    expect(runGit(projectDir, ["branch", "--list", worktree.branchName])).toBe("");
  });

  it("commits pending worktree changes when requested", () => {
    const projectDir = makeTempDir("git-worktree-commit");
    initGitRepo(projectDir);

    const worktree = createWorktree(projectDir, "commit-stage");
    writeFileSync(path.join(worktree.worktreeDir, "feature.txt"), "content\n", "utf8");

    expect(commitWorktreeChanges(worktree.worktreeDir, "Commit Stage")).toBe(true);
    expect(runGit(worktree.worktreeDir, ["log", "-1", "--pretty=%s"])).toContain(
      "kodo: parallel stage 'Commit Stage' changes",
    );

    removeWorktree(projectDir, worktree.worktreeDir, worktree.branchName);
  });

  it("merges persisted worktree branches back into the main branch", () => {
    const projectDir = makeTempDir("git-worktree-merge");
    initGitRepo(projectDir);

    const worktree = createWorktree(projectDir, "merge-stage");
    writeFileSync(path.join(worktree.worktreeDir, "merged.txt"), "merged\n", "utf8");
    runGit(worktree.worktreeDir, ["add", "merged.txt"]);
    runGit(worktree.worktreeDir, ["commit", "-m", "branch change"]);

    removeWorktreeKeepBranch(projectDir, worktree.worktreeDir);
    const mergeResult = mergeWorktreeBranch(projectDir, worktree.branchName, "Merge Stage");

    expect(mergeResult.success).toBe(true);
    expect(mergeResult.hadChanges).toBe(true);
    expect(existsSync(path.join(projectDir, "merged.txt"))).toBe(true);

    runGit(projectDir, ["branch", "-D", worktree.branchName]);
  });

  it("refuses merge-back when the main repo is dirty", () => {
    const projectDir = makeTempDir("git-worktree-dirty");
    initGitRepo(projectDir);

    const worktree = createWorktree(projectDir, "dirty-stage");
    writeFileSync(path.join(worktree.worktreeDir, "merged.txt"), "merged\n", "utf8");
    runGit(worktree.worktreeDir, ["add", "merged.txt"]);
    runGit(worktree.worktreeDir, ["commit", "-m", "branch change"]);
    removeWorktreeKeepBranch(projectDir, worktree.worktreeDir);

    writeFileSync(path.join(projectDir, "README.md"), "dirty\n", "utf8");
    const mergeResult = mergeWorktreeBranch(projectDir, worktree.branchName, "Dirty Stage");

    expect(mergeResult.success).toBe(false);
    expect(mergeResult.hadChanges).toBe(false);
    expect(mergeResult.error).toContain("refusing to merge");

    runGit(projectDir, ["checkout", "--", "."]);
    runGit(projectDir, ["branch", "-D", worktree.branchName]);
  });

  it("cleans up stale worktrees and orphaned branches", () => {
    const projectDir = makeTempDir("git-worktree-stale");
    initGitRepo(projectDir);

    const stale = createWorktree(projectDir, "old-stage");
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000);
    utimesSync(stale.worktreeDir, sevenHoursAgo, sevenHoursAgo);

    const orphan = createWorktree(projectDir, "orphan-stage");
    removeWorktreeKeepBranch(projectDir, orphan.worktreeDir);

    cleanupStaleWorktrees(projectDir);

    expect(existsSync(stale.worktreeDir)).toBe(false);
    expect(runGit(projectDir, ["branch", "--list", stale.branchName])).toBe("");
    expect(runGit(projectDir, ["branch", "--list", orphan.branchName])).toBe("");
  });
});
