import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isTraceUploadEnabled,
  readTraceUploadPayload,
  uploadTrace,
} from "../../src/logging/trace-upload.js";

function makeTempDir(): string {
  const directory = path.join(
    os.tmpdir(),
    `simple-runner-trace-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(directory, { recursive: true });
  return directory;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("trace upload", () => {
  it("honors the trace upload environment gate", () => {
    vi.stubEnv("SIMPLE_RUNNER_TRACE_UPLOAD", "0");
    expect(isTraceUploadEnabled()).toBe(false);

    vi.stubEnv("SIMPLE_RUNNER_TRACE_UPLOAD", "1");
    expect(isTraceUploadEnabled()).toBe(true);
  });

  it("uploads a scrubbed trace archive and writes indexed metadata", () => {
    const runDir = makeTempDir();
    mkdirSync(path.join(runDir, "conversations"), { recursive: true });
    writeFileSync(
      path.join(runDir, "log.jsonl"),
      '{"event":"agent","message":"OPENAI_API_KEY=sk-test-1234567890 email jane@example.com"}\n',
      "utf8",
    );
    writeFileSync(
      path.join(runDir, "conversations", "worker_fast_001.jsonl.gz"),
      "Call me at 555-222-3333",
      "utf8",
    );
    writeFileSync(path.join(runDir, "goal.md"), "Ship it safely\n", "utf8");
    writeFileSync(path.join(runDir, "config.json"), "{}\n", "utf8");
    writeFileSync(path.join(runDir, "team.json"), '{"agents":{}}\n', "utf8");

    vi.stubEnv("SIMPLE_RUNNER_TRACE_UPLOAD", "1");
    vi.stubEnv("SIMPLE_RUNNER_TRACE_GCS_BUCKET", "bucket-under-test");
    vi.stubEnv("SIMPLE_RUNNER_TRACE_GCP_PROJECT", "project-under-test");

    const requests: Array<{ args: string[]; body: Buffer | string }> = [];
    const result = uploadTrace(
      {
        agentCount: 2,
        elapsedS: 12.34,
        finished: true,
        goal: "Ship it safely",
        model: "gpt-5.4",
        orchestrator: "codex",
        projectDir: "/tmp/project",
        runDir,
        runError: null,
        runId: "20260323_010203",
        totalCostUsd: 0,
        totalCycles: 3,
        totalExchanges: 3,
      },
      {
        getAccessToken: () => "token-123",
        getHostname: () => "host-1",
        getUsername: () => "eddie",
        now: () => new Date("2026-03-23T01:02:03.000Z"),
        runCommand: (command, args) => {
          expect(command).toBe("curl");
          const bodyArg = args[args.indexOf("--data-binary") + 1] ?? "";
          requests.push({
            args,
            body: bodyArg.startsWith("@") ? readTraceUploadPayload(bodyArg) : bodyArg,
          });
          return { status: 0, stderr: "", stdout: "" };
        },
      },
    );

    expect(result).toMatchObject({
      attempted: true,
      metadataPath:
        "projects/project-under-test/databases/(default)/documents/traces/20260323_010203",
      traceGcsPath: "gs://bucket-under-test/traces/20260323_010203/trace.tar.gz",
      uploaded: true,
    });
    expect(requests).toHaveLength(2);

    const archiveFile = path.join(makeTempDir(), "trace.tar.gz");
    writeFileSync(archiveFile, requests[0]?.body as Buffer);
    const extractDir = makeTempDir();
    spawnSync("tar", ["-xzf", archiveFile, "-C", extractDir], { stdio: "ignore" });
    const logPayload = readFileSync(path.join(extractDir, "log.jsonl"), "utf8");
    const conversationPayload = readFileSync(
      path.join(extractDir, "conversations", "worker_fast_001.jsonl.gz"),
      "utf8",
    );
    expect(logPayload).not.toContain("sk-test-1234567890");
    expect(logPayload).not.toContain("jane@example.com");
    expect(logPayload).toContain("[secret-redacted]");
    expect(logPayload).toContain("[pii-redacted]");
    expect(conversationPayload).not.toContain("555-222-3333");

    const metadata = JSON.parse(String(requests[1]?.body)) as {
      fields: Record<string, Record<string, unknown>>;
    };
    expect(metadata.fields.run_id?.stringValue).toBe("20260323_010203");
    expect(metadata.fields.trace_gcs_path?.stringValue).toBe(
      "gs://bucket-under-test/traces/20260323_010203/trace.tar.gz",
    );
    expect(metadata.fields.goal?.stringValue).toBe("Ship it safely");
    expect(metadata.fields.user?.stringValue).toBe("eddie");
  });

  it("returns a no-op result when the run has no archiveable files", () => {
    const runDir = makeTempDir();

    vi.stubEnv("SIMPLE_RUNNER_TRACE_UPLOAD", "1");

    const result = uploadTrace(
      {
        agentCount: 0,
        elapsedS: null,
        finished: false,
        goal: "Empty run",
        model: "gpt-5.4",
        orchestrator: "codex",
        projectDir: "/tmp/project",
        runDir,
        runError: null,
        runId: "20260323_empty",
        totalCostUsd: 0,
        totalCycles: 0,
        totalExchanges: 0,
      },
      {
        getAccessToken: () => "token-123",
        runCommand: () => {
          throw new Error("should not try to upload an empty archive");
        },
      },
    );

    expect(result).toEqual({
      attempted: true,
      reason: "no trace archive entries found",
      uploaded: false,
    });
  });

  it("surfaces upload command failures", () => {
    const runDir = makeTempDir();
    writeFileSync(path.join(runDir, "log.jsonl"), '{"event":"run_start"}\n', "utf8");

    vi.stubEnv("SIMPLE_RUNNER_TRACE_UPLOAD", "1");

    const result = uploadTrace(
      {
        agentCount: 1,
        elapsedS: 1,
        finished: false,
        goal: "Broken upload",
        model: "gpt-5.4",
        orchestrator: "codex",
        projectDir: "/tmp/project",
        runDir,
        runError: null,
        runId: "20260323_broken",
        totalCostUsd: 0,
        totalCycles: 1,
        totalExchanges: 1,
      },
      {
        getAccessToken: () => "token-123",
        runCommand: () => ({
          status: 22,
          stderr: "curl upload failed",
          stdout: "",
        }),
      },
    );

    expect(result).toEqual({
      attempted: true,
      reason: "curl upload failed",
      uploaded: false,
    });
  });
});
