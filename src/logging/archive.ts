import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";

const RUN_ARCHIVE_NAME = "run.tar.gz";

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

export function packRunArchive(runDir: string): string | null {
  const entries = gatherArchiveEntries(runDir);
  if (entries.length === 0) {
    return null;
  }

  const archivePath = path.join(runDir, RUN_ARCHIVE_NAME);
  const result = spawnSync("tar", ["-czf", archivePath, ...entries], {
    cwd: runDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const fallback = Object.fromEntries(
      entries.map((entry) => {
        const fullPath = path.join(runDir, entry);
        const stats = statSync(fullPath);
        if (stats.isDirectory()) {
          return [entry, { type: "directory" }];
        }
        return [entry, { type: "file", content: readFileSync(fullPath, "utf8") }];
      }),
    );
    writeFileSync(archivePath, gzipSync(JSON.stringify(fallback, null, 2)));
  }

  return archivePath;
}
