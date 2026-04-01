import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { gzipSync } from "node:zlib";

import { stringifyJson, toJsonObject } from "../runtime/json.js";
import { parseRun } from "./runs.js";

export class RunDir {
  readonly projectDir: string;
  readonly runId: string;
  readonly root: string;
  readonly logFile: string;
  readonly goalFile: string;
  readonly goalRefinedFile: string;
  readonly goalPlanFile: string;
  readonly configFile: string;
  readonly teamFile: string;
  readonly conversationsDir: string;

  private constructor(projectDir: string, runId: string, root: string) {
    this.projectDir = projectDir;
    this.runId = runId;
    this.root = root;
    this.logFile = path.join(root, "log.jsonl");
    this.goalFile = path.join(root, "goal.md");
    this.goalRefinedFile = path.join(root, "goal-refined.md");
    this.goalPlanFile = path.join(root, "goal-plan.json");
    this.configFile = path.join(root, "config.json");
    this.teamFile = path.join(root, "team.json");
    this.conversationsDir = path.join(root, "conversations");
  }

  static create(projectDir: string, runId = timestampRunId()): RunDir {
    const root = path.join(runsRoot(), runId);
    mkdirSync(root, { recursive: true });
    return new RunDir(projectDir, runId, root);
  }

  static fromLogFile(logFile: string, projectDir: string): RunDir {
    const runId = path.basename(path.dirname(logFile));
    const root = path.dirname(logFile);
    return new RunDir(projectDir, runId, root);
  }
}

let activeLogFile: string | null = null;
let startTime = 0;

function runsRoot(homeDir = os.homedir()): string {
  const override = process.env.SIMPLE_RUNNER_RUNS_DIR;
  const root = override ? path.resolve(override) : path.join(homeDir, ".simple-runner", "runs");
  mkdirSync(root, { recursive: true });
  return root;
}

function timestampRunId(now = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  const hour = String(now.getUTCHours()).padStart(2, "0");
  const minute = String(now.getUTCMinutes()).padStart(2, "0");
  const second = String(now.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}_${hour}${minute}${second}`;
}

function appendEvent(event: string, fields: Record<string, unknown>): void {
  if (activeLogFile === null) {
    throw new Error("Log file has not been initialized.");
  }

  const record = {
    ts: new Date().toISOString(),
    t: Number(((Date.now() - startTime) / 1000).toFixed(3)),
    event,
    ...toJsonObject(fields),
  };
  appendFileSync(activeLogFile, `${stringifyJson(record)}\n`, "utf8");
}

export function init(runDir: RunDir): string {
  mkdirSync(runDir.root, { recursive: true });
  writeFileSync(runDir.logFile, "", "utf8");
  activeLogFile = runDir.logFile;
  startTime = Date.now();
  appendEvent("run_init", {});
  return runDir.logFile;
}

export function initAppend(logFile: string): string {
  if (!existsSync(logFile)) {
    throw new FileNotFoundError(`Log file does not exist: ${logFile}`);
  }
  const parsed = parseRun(logFile);
  if (parsed === null) {
    throw new Error(`Cannot resume log file missing run_start or cli_args: ${logFile}`);
  }

  activeLogFile = logFile;
  startTime = Date.now();
  appendEvent("run_resumed", {});
  return logFile;
}

export function emit(event: string, fields: Record<string, unknown> = {}): void {
  appendEvent(event, fields);
}

function sanitizeConversationLabel(value: string): string {
  return value.replaceAll(/[^A-Za-z0-9._-]+/gu, "_").replaceAll(/^_+|_+$/gu, "") || "agent";
}

export function saveConversation(
  agentName: string,
  queryIndex: number,
  messages: unknown[],
): string | null {
  if (activeLogFile === null || messages.length === 0) {
    return null;
  }

  try {
    const runRoot = path.dirname(activeLogFile);
    const conversationsDir = path.join(runRoot, "conversations");
    mkdirSync(conversationsDir, { recursive: true });
    const fileName = `${sanitizeConversationLabel(agentName)}_${String(queryIndex).padStart(3, "0")}.jsonl.gz`;
    const payload = messages.map((message) => stringifyJson(message)).join("\n");
    writeFileSync(path.join(conversationsDir, fileName), gzipSync(Buffer.from(payload, "utf8")));
    return `conversations/${fileName}`;
  } catch {
    return null;
  }
}

export function liveConversationPath(agentName: string, queryIndex: number): string | null {
  if (activeLogFile === null) {
    return null;
  }

  const runRoot = path.dirname(activeLogFile);
  const conversationsDir = path.join(runRoot, "conversations");
  mkdirSync(conversationsDir, { recursive: true });
  const fileName = `${sanitizeConversationLabel(agentName)}_${String(queryIndex).padStart(3, "0")}.live.jsonl`;
  return path.join(conversationsDir, fileName);
}

export function getLogFile(): string {
  if (activeLogFile === null) {
    throw new Error("Log file has not been initialized.");
  }
  return activeLogFile;
}

export function getElapsedS(): number | null {
  if (activeLogFile === null || startTime === 0) {
    return null;
  }
  return Number(((Date.now() - startTime) / 1000).toFixed(3));
}

class FileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileNotFoundError";
  }
}
