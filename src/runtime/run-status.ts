import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type RunStatusOptions = {
  cycleNum?: number;
  maxCycles?: number;
  stageLabel?: string;
};

function formatTime(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  if (minutes < 60) {
    return `${minutes}m${String(remainder).padStart(2, "0")}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function writeRunStatus(
  projectDir: string,
  goal: string,
  options: RunStatusOptions = {},
): string {
  const lines = ["# Run Status", "", "## Goal", goal.slice(0, 500), "", "## Progress"];

  if (options.stageLabel) {
    lines.push(`- Stage: ${options.stageLabel}`);
  }
  if (options.cycleNum !== undefined && options.maxCycles !== undefined) {
    lines.push(`- Cycle: ${options.cycleNum}/${options.maxCycles}`);
  }
  lines.push(`- Updated: ${formatTime(0)}`);

  const statusFile = path.join(projectDir, ".kodo", "run-status.md");
  mkdirSync(path.dirname(statusFile), { recursive: true });
  const content = `${lines.join("\n")}\n`;
  writeFileSync(statusFile, content, "utf8");
  return content;
}

export function readRunStatus(projectDir: string): string {
  const statusFile = path.join(projectDir, ".kodo", "run-status.md");
  try {
    return readFileSync(statusFile, "utf8");
  } catch {
    return "";
  }
}
