import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";

import { parseRun } from "./runs.js";

export class RunDir {
  readonly root: string;
  readonly logFile: string;

  private constructor(root: string) {
    this.root = root;
    this.logFile = path.join(root, "log.jsonl");
  }

  static create(parentDir: string, runId: string): RunDir {
    const root = path.join(parentDir, runId);
    mkdirSync(root, { recursive: true });
    return new RunDir(root);
  }
}

let activeLogFile: string | null = null;
let startTime = 0;

function serialize(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value ?? null;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "function") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof URL) {
    return value.toString();
  }
  if (typeof value === "object" && "toJSON" in value && typeof value.toJSON === "function") {
    return serialize(value.toJSON());
  }
  if (Array.isArray(value)) {
    return value.map((item) => serialize(item));
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, serialize(entry)]));
  }
  return JSON.stringify(value);
}

function appendEvent(event: string, fields: Record<string, unknown>): void {
  if (activeLogFile === null) {
    throw new Error("Log file has not been initialized.");
  }

  const record = {
    ts: new Date().toISOString(),
    t: Number(((Date.now() - startTime) / 1000).toFixed(3)),
    event,
    ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, serialize(value)])),
  };
  appendFileSync(activeLogFile, `${JSON.stringify(record)}\n`, "utf8");
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

export function getLogFile(): string {
  if (activeLogFile === null) {
    throw new Error("Log file has not been initialized.");
  }
  return activeLogFile;
}

class FileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileNotFoundError";
  }
}
