import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { VERSION } from "../core/version.js";
import { createTraceArchivePayload, type ArchiveStats } from "./archive.js";

const DEFAULT_GCP_PROJECT = "covenance-469421";
const DEFAULT_GCS_BUCKET = "kodo-bench";

export type TraceUploadOptions = {
  agentCount: number;
  elapsedS: number | null;
  finished: boolean;
  goal: string;
  model: string;
  orchestrator: string;
  projectDir: string;
  runDir: string;
  runError: unknown;
  runId: string;
  totalCostUsd: number;
  totalCycles: number;
  totalExchanges: number;
};

type CommandResult = {
  error?: Error;
  status: number | null;
  stderr: string;
  stdout: string;
};

export type TraceUploadResult =
  | {
      attempted: false;
      reason: string;
      uploaded: false;
    }
  | {
      attempted: true;
      archiveStats: ArchiveStats;
      metadataPath: string;
      traceGcsPath: string;
      traceSizeBytes: number;
      uploaded: true;
    }
  | {
      attempted: true;
      reason: string;
      uploaded: false;
    };

type TraceUploadDependencies = {
  getAccessToken?: () => string | null;
  getHostname?: () => string;
  getUsername?: () => string;
  now?: () => Date;
  runCommand?: (command: string, args: string[]) => CommandResult;
};

function envEnabled(name: string): boolean {
  return ["1", "true", "yes"].includes((process.env[name] ?? "").trim().toLowerCase());
}

export function isTraceUploadEnabled(): boolean {
  return envEnabled("KODO_TRACE_UPLOAD");
}

function defaultRunCommand(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    error: result.error,
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

function commandSucceeded(result: CommandResult): boolean {
  return result.error === undefined && result.status === 0;
}

function defaultAccessTokenProvider(
  runCommand: (command: string, args: string[]) => CommandResult,
): string | null {
  const direct =
    process.env.KODO_TRACE_UPLOAD_ACCESS_TOKEN ?? process.env.GOOGLE_OAUTH_ACCESS_TOKEN;
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }

  for (const args of [
    ["auth", "application-default", "print-access-token"],
    ["auth", "print-access-token"],
  ]) {
    const result = runCommand("gcloud", args);
    if (commandSucceeded(result)) {
      const token = result.stdout.trim();
      if (token.length > 0) {
        return token;
      }
    }
  }

  return null;
}

function gcpProject(): string {
  return process.env.KODO_TRACE_GCP_PROJECT?.trim() || DEFAULT_GCP_PROJECT;
}

function gcsBucket(): string {
  return process.env.KODO_TRACE_GCS_BUCKET?.trim() || DEFAULT_GCS_BUCKET;
}

function firestoreValue(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    return { nullValue: null };
  }
  if (typeof value === "boolean") {
    return { booleanValue: value };
  }
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return { integerValue: String(value) };
    }
    return { doubleValue: value };
  }
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((entry) => firestoreValue(entry)) } };
  }
  if (typeof value === "object") {
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, firestoreValue(entry)]),
        ),
      },
    };
  }
  return { stringValue: JSON.stringify(value) ?? Object.prototype.toString.call(value) };
}

function firestoreDocument(fields: Record<string, unknown>): string {
  return JSON.stringify({
    fields: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, firestoreValue(value)]),
    ),
  });
}

function trimError(error: unknown): string | null {
  if (error === null || error === undefined) {
    return null;
  }
  const value =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : (JSON.stringify(error) ?? Object.prototype.toString.call(error));
  return value.slice(0, 500);
}

export function uploadTrace(
  options: TraceUploadOptions,
  dependencies: TraceUploadDependencies = {},
): TraceUploadResult {
  if (!isTraceUploadEnabled()) {
    return { attempted: false, reason: "trace upload disabled", uploaded: false };
  }

  const archive = createTraceArchivePayload(options.runDir);
  if (archive === null) {
    return { attempted: true, reason: "no trace archive entries found", uploaded: false };
  }

  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const accessToken = dependencies.getAccessToken?.() ?? defaultAccessTokenProvider(runCommand);
  if (accessToken === null) {
    return { attempted: true, reason: "no GCP access token available", uploaded: false };
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "kodo-trace-upload-"));
  const payloadPath = path.join(tempDir, "trace.tar.gz");
  const firestorePath = path.join(tempDir, "trace-metadata.json");
  const bucket = gcsBucket();
  const project = gcpProject();
  const traceObject = `traces/${options.runId}/trace.tar.gz`;
  const traceGcsPath = `gs://${bucket}/${traceObject}`;
  const metadataPath = `projects/${project}/databases/(default)/documents/traces/${options.runId}`;

  try {
    writeFileSync(payloadPath, archive.payload);

    const uploadResult = runCommand("curl", [
      "--silent",
      "--show-error",
      "--fail",
      "-X",
      "POST",
      "-H",
      `Authorization: Bearer ${accessToken}`,
      "-H",
      "Content-Type: application/gzip",
      "--data-binary",
      `@${payloadPath}`,
      `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(traceObject)}`,
    ]);
    if (!commandSucceeded(uploadResult)) {
      return {
        attempted: true,
        reason: (uploadResult.stderr || uploadResult.stdout || "trace upload failed").trim(),
        uploaded: false,
      };
    }

    const now = dependencies.now?.() ?? new Date();
    const metadata = {
      agent_count: options.agentCount,
      elapsed_s: options.elapsedS === null ? null : Number(options.elapsedS.toFixed(1)),
      finished: options.finished,
      goal: options.goal.slice(0, 2000),
      host: dependencies.getHostname?.() ?? os.hostname(),
      kodo_version: VERSION,
      model: options.model,
      orchestrator: options.orchestrator,
      outcome:
        options.runError !== null && options.runError !== undefined
          ? "error"
          : options.finished
            ? "completed"
            : "partial",
      platform: `${process.platform} ${process.arch}`,
      project_dir: options.projectDir,
      run_id: options.runId,
      timestamp: now.toISOString(),
      total_cost_usd: Number(options.totalCostUsd.toFixed(4)),
      total_cycles: options.totalCycles,
      total_exchanges: options.totalExchanges,
      trace_gcs_path: traceGcsPath,
      trace_size_bytes: archive.payload.length,
      user: dependencies.getUsername?.() ?? os.userInfo().username,
      ...(trimError(options.runError) === null ? {} : { error: trimError(options.runError) }),
    };
    writeFileSync(firestorePath, firestoreDocument(metadata), "utf8");

    const firestoreResult = runCommand("curl", [
      "--silent",
      "--show-error",
      "--fail",
      "-X",
      "PATCH",
      "-H",
      `Authorization: Bearer ${accessToken}`,
      "-H",
      "Content-Type: application/json",
      "--data-binary",
      `@${firestorePath}`,
      `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(project)}/databases/(default)/documents/traces/${encodeURIComponent(options.runId)}`,
    ]);
    if (!commandSucceeded(firestoreResult)) {
      return {
        attempted: true,
        reason: (
          firestoreResult.stderr ||
          firestoreResult.stdout ||
          "trace metadata write failed"
        ).trim(),
        uploaded: false,
      };
    }

    return {
      attempted: true,
      archiveStats: archive.stats,
      metadataPath,
      traceGcsPath,
      traceSizeBytes: archive.payload.length,
      uploaded: true,
    };
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

export function readTraceUploadPayload(archiveArg: string): Buffer {
  return readFileSync(archiveArg.replace(/^@/u, ""));
}
