import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import os from "node:os";

const RUN_ARCHIVE_NAME = "run.tar.gz";

export type ArchiveStats = {
  filesChanged: number;
  redactions: number;
};

export type ArchiveResult = {
  path: string;
  stats: ArchiveStats;
};

function gatherArchiveEntries(runDir: string): string[] {
  const candidates = [
    "log.jsonl",
    "run.jsonl",
    "goal.md",
    "goal-refined.md",
    "goal-plan.json",
    "config.json",
    "team.json",
    "test-report.md",
    "improve-report.md",
  ];
  const entries = candidates.filter((name) => existsSync(path.join(runDir, name)));

  const conversationsDir = path.join(runDir, "conversations");
  if (existsSync(conversationsDir)) {
    entries.push("conversations");
  }

  for (const entry of readdirSync(runDir)) {
    if (!entry.endsWith(".md") || entries.includes(entry)) {
      continue;
    }
    entries.push(entry);
  }

  return entries;
}

export function packRunArchive(runDir: string): ArchiveResult | null {
  const entries = gatherArchiveEntries(runDir);
  if (entries.length === 0) {
    return null;
  }

  const archivePath = path.join(runDir, RUN_ARCHIVE_NAME);
  const stagingDir = mkdtempSync(path.join(os.tmpdir(), "kodo-archive-"));
  const stats: ArchiveStats = {
    filesChanged: 0,
    redactions: 0,
  };

  try {
    for (const entry of entries) {
      stageEntry(runDir, stagingDir, entry, stats);
    }

    const result = spawnSync("tar", ["-czf", archivePath, ...entries], {
      cwd: stagingDir,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      const fallback = Object.fromEntries(
        entries.map((entry) => {
          const fullPath = path.join(stagingDir, entry);
          const entryStats = statSync(fullPath);
          if (entryStats.isDirectory()) {
            return [entry, { type: "directory" }];
          }
          return [entry, { type: "file", content: readFileSync(fullPath, "utf8") }];
        }),
      );
      writeFileSync(archivePath, gzipSync(JSON.stringify(fallback, null, 2)));
    }
  } finally {
    rmSync(stagingDir, { force: true, recursive: true });
  }

  return { path: archivePath, stats };
}

function stageEntry(
  sourceRoot: string,
  stagingRoot: string,
  relativePath: string,
  stats: ArchiveStats,
): void {
  const sourcePath = path.join(sourceRoot, relativePath);
  const destinationPath = path.join(stagingRoot, relativePath);
  const entryStats = statSync(sourcePath);

  if (entryStats.isDirectory()) {
    mkdirSync(destinationPath, { recursive: true });
    for (const child of readdirSync(sourcePath)) {
      stageEntry(sourceRoot, stagingRoot, path.join(relativePath, child), stats);
    }
    return;
  }

  mkdirSync(path.dirname(destinationPath), { recursive: true });
  const original = readFileSync(sourcePath);
  const asText = maybeReadText(original);
  if (asText === null) {
    cpSync(sourcePath, destinationPath);
    return;
  }

  const scrubbed = scrubArchiveText(asText);
  if (scrubbed.redactions > 0) {
    stats.filesChanged += 1;
    stats.redactions += scrubbed.redactions;
  }
  writeFileSync(destinationPath, scrubbed.text, "utf8");
}

function maybeReadText(payload: Buffer): string | null {
  if (payload.includes(0)) {
    return null;
  }
  return payload.toString("utf8");
}

function scrubArchiveText(text: string): { redactions: number; text: string } {
  let redactions = 0;
  let current = text;

  const replacements: Array<[RegExp, string]> = [
    [/\b(?:\d[ -]*?){13,19}\b/gu, "[secret-redacted]"],
    [/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)=([^\s"'`]+)/gu, "$1=[secret-redacted]"],
    [/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[secret-redacted]"],
  ];

  for (const [pattern, replacement] of replacements) {
    current = current.replaceAll(pattern, () => {
      redactions += 1;
      return replacement;
    });
  }

  return { redactions, text: current };
}
