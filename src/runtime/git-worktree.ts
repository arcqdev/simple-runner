import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import { emit as emitLogEvent } from "../logging/log.js";

const GIT_ENV = {
  GIT_AUTHOR_EMAIL: "noreply@github.com",
  GIT_AUTHOR_NAME: "simple-runner",
  GIT_COMMITTER_EMAIL: "noreply@github.com",
  GIT_COMMITTER_NAME: "simple-runner",
};

const GIT_TIMEOUT_MS = 60_000;
const WORKTREE_BRANCH_PREFIX = "simple-runner-";
const STALE_WORKTREE_AGE_MS = 6 * 60 * 60 * 1000;

function emitRuntimeLog(event: string, fields: Record<string, unknown>): void {
  try {
    emitLogEvent(event, fields);
  } catch {}
}

export type WorktreeHandle = {
  branchName: string;
  worktreeDir: string;
};

export type MergeResult = {
  conflict: boolean;
  error: string;
  hadChanges: boolean;
  success: boolean;
};

function runGit(
  cwd: string,
  args: string[],
  options: {
    allowFailure?: boolean;
  } = {},
): { ok: boolean; output: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const output = `${stdout}\n${stderr}`.trim();
  const ok = (result.status ?? 1) === 0;
  if (!ok && !options.allowFailure) {
    throw new Error(output || `git ${args.join(" ")} failed`);
  }
  return { ok, output };
}

function sanitizeLabel(label: string): string {
  const sanitized = label
    .trim()
    .replaceAll(/[/@:^~?*[\\\s]+/gu, "_")
    .replaceAll(/_+/gu, "_");
  return sanitized.length > 0 ? sanitized : "stage";
}

function stripPycacheFromIndex(repoDir: string): void {
  const cached = runGit(repoDir, ["ls-files", "--cached", "-z", "*/__pycache__/*", "*.pyc"], {
    allowFailure: true,
  });
  const files = cached.output.split("\0").filter((entry) => entry.length > 0);
  if (files.length === 0) {
    return;
  }
  runGit(repoDir, ["rm", "-r", "--cached", "--quiet", "--", ...files], { allowFailure: true });
}

function removeWorktreeDirectoryIfPresent(worktreeDir: string): void {
  if (existsSync(worktreeDir)) {
    rmSync(worktreeDir, { force: true, recursive: true });
  }
}

function cleanupOrphanedBranches(projectDir: string, activeBranches: Set<string>): void {
  const branchList = runGit(projectDir, ["branch", "--list", `${WORKTREE_BRANCH_PREFIX}*`], {
    allowFailure: true,
  });
  if (!branchList.ok) {
    return;
  }

  const orphaned = branchList.output
    .split(/\r?\n/gu)
    .map((line) => line.trim().replace(/^\*\s+/u, ""))
    .filter((branch) => branch.startsWith(WORKTREE_BRANCH_PREFIX) && !activeBranches.has(branch));

  if (orphaned.length === 0) {
    return;
  }

  emitRuntimeLog("cleanup_orphaned_branches_found", { count: orphaned.length });
  for (const branch of orphaned) {
    try {
      runGit(projectDir, ["branch", "-D", branch], { allowFailure: true });
      emitRuntimeLog("cleanup_orphaned_branch_removed", { branch });
    } catch (error) {
      emitRuntimeLog("cleanup_orphaned_branch_failed", {
        branch,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function createWorktree(projectDir: string, label: string): WorktreeHandle {
  const sanitizedLabel = sanitizeLabel(label);
  const branchName = `${WORKTREE_BRANCH_PREFIX}${sanitizedLabel}-${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const worktreeDir = mkdtempSync(
    path.join(os.tmpdir(), `${WORKTREE_BRANCH_PREFIX}${sanitizedLabel}-`),
  );

  removeWorktreeDirectoryIfPresent(worktreeDir);
  try {
    runGit(projectDir, ["worktree", "add", worktreeDir, "-b", branchName, "HEAD"]);
    return { branchName, worktreeDir };
  } catch (error) {
    removeWorktreeDirectoryIfPresent(worktreeDir);
    throw error;
  }
}

export function removeWorktree(projectDir: string, worktreeDir: string, branchName: string): void {
  if (branchName.length === 0) {
    throw new Error("removeWorktree called with empty branchName");
  }

  const removeResult = runGit(projectDir, ["worktree", "remove", worktreeDir, "--force"], {
    allowFailure: true,
  });
  if (!removeResult.ok) {
    removeWorktreeDirectoryIfPresent(worktreeDir);
  }

  runGit(projectDir, ["branch", "-D", branchName], { allowFailure: true });
  removeWorktreeDirectoryIfPresent(worktreeDir);
  runGit(projectDir, ["worktree", "prune"], { allowFailure: true });
}

export function removeWorktreeKeepBranch(projectDir: string, worktreeDir: string): void {
  const removeResult = runGit(projectDir, ["worktree", "remove", worktreeDir, "--force"], {
    allowFailure: true,
  });
  if (!removeResult.ok) {
    removeWorktreeDirectoryIfPresent(worktreeDir);
  }
  runGit(projectDir, ["worktree", "prune"], { allowFailure: true });
}

export function cleanupStaleWorktrees(projectDir: string): void {
  try {
    const listed = runGit(projectDir, ["worktree", "list", "--porcelain"], { allowFailure: true });
    if (!listed.ok) {
      emitRuntimeLog("cleanup_stale_worktrees_list_failed", { error: listed.output });
      return;
    }

    const entries = listed.output.split(/\n\s*\n/gu);
    const activeBranches = new Set<string>();
    const staleEntries: WorktreeHandle[] = [];
    const cutoff = Date.now() - STALE_WORKTREE_AGE_MS;

    for (const entry of entries) {
      const lines = entry.split(/\r?\n/gu).map((line) => line.trim());
      const worktreeLine = lines.find((line) => line.startsWith("worktree "));
      const branchLine = lines.find((line) => line.startsWith("branch refs/heads/"));
      if (worktreeLine === undefined || branchLine === undefined) {
        continue;
      }

      const worktreeDir = worktreeLine.slice("worktree ".length);
      const branchName = branchLine.slice("branch refs/heads/".length);
      if (!branchName.startsWith(WORKTREE_BRANCH_PREFIX)) {
        continue;
      }
      activeBranches.add(branchName);

      const worktreeName = path.basename(worktreeDir);
      if (!worktreeName.includes(WORKTREE_BRANCH_PREFIX) || !existsSync(worktreeDir)) {
        continue;
      }

      try {
        const modified = statSync(worktreeDir).mtimeMs;
        if (modified < cutoff) {
          staleEntries.push({ branchName, worktreeDir });
        }
      } catch {}
    }

    if (staleEntries.length > 0) {
      emitRuntimeLog("cleanup_stale_worktrees_found", { count: staleEntries.length });
    }

    for (const entry of staleEntries) {
      try {
        removeWorktree(projectDir, entry.worktreeDir, entry.branchName);
        emitRuntimeLog("cleanup_stale_worktree_removed", {
          branch: entry.branchName,
          path: entry.worktreeDir,
        });
      } catch (error) {
        emitRuntimeLog("cleanup_stale_worktree_failed", {
          branch: entry.branchName,
          error: error instanceof Error ? error.message : String(error),
          path: entry.worktreeDir,
        });
      }
    }

    cleanupOrphanedBranches(projectDir, activeBranches);
  } catch (error) {
    emitRuntimeLog("cleanup_stale_worktrees_error", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function commitWorktreeChanges(worktreeDir: string, stageName: string): boolean {
  if (!existsSync(worktreeDir)) {
    throw new Error(`commitWorktreeChanges called with non-existent worktree: ${worktreeDir}`);
  }
  if (stageName.length === 0) {
    throw new Error("commitWorktreeChanges called with empty stageName");
  }

  const status = runGit(worktreeDir, ["status", "--porcelain"], { allowFailure: true });
  if (!status.ok || status.output.trim().length === 0) {
    return false;
  }

  runGit(worktreeDir, ["add", "-A"]);
  stripPycacheFromIndex(worktreeDir);
  const commit = runGit(
    worktreeDir,
    ["commit", "-m", `simple-runner: parallel stage '${stageName}' changes`],
    { allowFailure: true },
  );
  return commit.ok;
}

export function mergeWorktreeBranch(
  projectDir: string,
  branchName: string,
  stageName: string,
): MergeResult {
  const preflight = runGit(projectDir, ["status", "--porcelain"], { allowFailure: true });
  if (!preflight.ok) {
    return { conflict: false, error: preflight.output, hadChanges: false, success: false };
  }
  if (preflight.output.trim().length > 0) {
    return {
      conflict: false,
      error: `Stage '${stageName}': refusing to merge because the main repo has uncommitted changes.`,
      hadChanges: false,
      success: false,
    };
  }

  const diffCheck = runGit(projectDir, ["log", `HEAD..${branchName}`, "--oneline"], {
    allowFailure: true,
  });
  if (!diffCheck.ok) {
    return { conflict: false, error: diffCheck.output, hadChanges: false, success: false };
  }
  if (diffCheck.output.trim().length === 0) {
    return { conflict: false, error: "", hadChanges: false, success: true };
  }

  const currentBranch = runGit(projectDir, ["rev-parse", "--abbrev-ref", "HEAD"], {
    allowFailure: true,
  });
  if (!currentBranch.ok) {
    return { conflict: false, error: currentBranch.output, hadChanges: false, success: false };
  }

  const checkoutIncoming = runGit(projectDir, ["checkout", branchName], { allowFailure: true });
  if (!checkoutIncoming.ok) {
    return { conflict: false, error: checkoutIncoming.output, hadChanges: false, success: false };
  }

  stripPycacheFromIndex(projectDir);
  if (
    runGit(projectDir, ["status", "--porcelain"], { allowFailure: true }).output.trim().length > 0
  ) {
    runGit(projectDir, ["commit", "-m", "simple-runner: strip __pycache__ before merge"], {
      allowFailure: true,
    });
  }

  const checkoutCurrent = runGit(projectDir, ["checkout", currentBranch.output.trim()], {
    allowFailure: true,
  });
  if (!checkoutCurrent.ok) {
    return { conflict: false, error: checkoutCurrent.output, hadChanges: false, success: false };
  }

  stripPycacheFromIndex(projectDir);
  if (
    runGit(projectDir, ["status", "--porcelain"], { allowFailure: true }).output.trim().length > 0
  ) {
    runGit(projectDir, ["commit", "-m", "simple-runner: strip __pycache__ from main"], {
      allowFailure: true,
    });
  }

  const merge = runGit(
    projectDir,
    ["merge", branchName, "--no-ff", "-m", `Merge simple-runner parallel stage: ${stageName}`],
    { allowFailure: true },
  );
  if (!merge.ok) {
    const conflict = /\bCONFLICT\b/u.test(merge.output);
    runGit(projectDir, ["merge", "--abort"], { allowFailure: true });
    emitRuntimeLog("persist_merge_failed", {
      branch: branchName,
      conflict,
      error: merge.output.slice(0, 1000),
      stage_name: stageName,
    });
    return { conflict, error: merge.output, hadChanges: true, success: false };
  }

  emitRuntimeLog("persist_merge_ok", { branch: branchName, stage_name: stageName });
  return { conflict: false, error: "", hadChanges: true, success: true };
}

export function deleteWorktreeBranch(projectDir: string, branchName: string): void {
  runGit(projectDir, ["branch", "-D", branchName], { allowFailure: true });
}
