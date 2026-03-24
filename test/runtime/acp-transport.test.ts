import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ACP_PROTOCOL_VERSION } from "../../src/runtime/acp-contract.js";
import { collectAcpQueryOutcome, normalizeAcpEvent, rawEnvelope } from "../../src/runtime/acp-normalization.js";
import { StdioAcpTransport } from "../../src/runtime/acp-transport.js";

const TEMP_DIRS: string[] = [];

function makeTempDir(prefix: string): string {
  const directory = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(directory, { recursive: true });
  TEMP_DIRS.push(directory);
  return directory;
}

function writeServer(script: string): string {
  const directory = makeTempDir("acp-server");
  const filePath = path.join(directory, "server.mjs");
  writeFileSync(filePath, script, "utf8");
  chmodSync(filePath, 0o755);
  return filePath;
}

afterEach(() => {
  TEMP_DIRS.splice(0).forEach((directory) => {
    try {
      rmSync(directory, { force: true, recursive: true });
    } catch {}
  });
});

describe("stdio acp transport", () => {
  it("initializes, handles a request, and yields streamed notifications", async () => {
    const serverPath = writeServer(`#!/usr/bin/env node
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      id: message.id,
      jsonrpc: "2.0",
      result: {
        capabilities: {
          initialize: true,
          prompt: true,
          protocolVersion: "0.1",
          resume: true,
          serverName: "fake-acp",
          sessionLifecycle: true,
          serverVersion: "1.0.0",
          streaming: true,
          usage: true,
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session.created",
      params: {
        backend: "gemini",
        locator: { conversationId: "conv-1" },
        model: "gemini-3-flash",
      },
    });
    return;
  }

  if (message.method === "prompt") {
    send({ id: message.id, jsonrpc: "2.0", result: { accepted: true } });
    send({ jsonrpc: "2.0", method: "message.delta", params: { delta: "hello " } });
    send({ jsonrpc: "2.0", method: "result", params: { locator: { conversationId: "conv-1" }, stopReason: "completed", text: "hello world", usage: { inputTokens: 3, outputTokens: 5 } } });
    return;
  }

  if (message.method === "shutdown") {
    send({ id: message.id, jsonrpc: "2.0", result: {} });
    process.exit(0);
  }
});
`);

    const transport = new StdioAcpTransport({
      args: [serverPath],
      command: process.execPath,
      kind: "stdio",
      shutdownTimeoutMs: 1_000,
      startupTimeoutMs: 1_000,
    });

    const init = await transport.initialize({
      clientName: "kodo-test",
      clientVersion: "1.0.0",
      requestedCapabilities: {
        initialize: true,
        prompt: true,
        resume: true,
        sessionLifecycle: true,
        streaming: true,
        usage: true,
      },
    });

    expect(init.capabilities.protocolVersion).toBe(ACP_PROTOCOL_VERSION);

    const created = await transport.nextEnvelope();
    expect(created).toMatchObject({
      kind: "notification",
      message: {
        method: "session.created",
      },
    });

    const promptResponse = await transport.request("prompt", { cwd: process.cwd(), maxTurns: 1, prompt: "hi" });
    expect(promptResponse).toEqual({ accepted: true });

    const delta = await transport.nextEnvelope();
    const result = await transport.nextEnvelope();
    expect(delta).toMatchObject({
      kind: "notification",
      message: { method: "message.delta" },
    });
    expect(result).toMatchObject({
      kind: "notification",
      message: { method: "result" },
    });

    await transport.close();
  });

  it("surfaces request timeouts in structured form", async () => {
    const serverPath = writeServer(`#!/usr/bin/env node
import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", () => {});
`);

    const transport = new StdioAcpTransport({
      args: [serverPath],
      command: process.execPath,
      kind: "stdio",
      startupTimeoutMs: 50,
    });

    await expect(
      transport.request("initialize", {
        clientName: "kodo-test",
      }),
    ).rejects.toMatchObject({
      code: "timeout",
    });

    await expect(transport.close()).rejects.toMatchObject({
      code: "transport_shutdown_failed",
    });
  });
});

describe("acp normalization", () => {
  it("normalizes gemini events into stable runtime events", () => {
    const normalized = normalizeAcpEvent(
      "gemini",
      rawEnvelope("tool.result", {
        isError: false,
        output: { ok: true },
        toolName: "read_file",
      }),
    );

    expect(normalized).toEqual({
      ok: true,
      value: {
        event: {
          isError: false,
          output: { ok: true },
          toolName: "read_file",
          type: "tool.result",
        },
        raw: {
          jsonrpc: "2.0",
          method: "tool.result",
          params: {
            isError: false,
            output: { ok: true },
            toolName: "read_file",
          },
        },
      },
    });
  });

  it("normalizes opencode event shapes without leaking backend-specific structure", () => {
    const normalized = normalizeAcpEvent(
      "opencode",
      rawEnvelope("run.completed", {
        output: "done",
        status: "completed",
        thread: {
          id: "thread-9",
          providerThreadId: "provider-3",
        },
        usage: {
          completion_tokens: 6,
          prompt_tokens: 4,
        },
      }),
    );

    expect(normalized).toMatchObject({
      ok: true,
      value: {
        event: {
          result: {
            locator: {
              conversationId: "thread-9",
              providerThreadId: "provider-3",
            },
            stopReason: "completed",
            text: "done",
            usage: {
              inputTokens: 4,
              outputTokens: 6,
            },
          },
          type: "result",
        },
      },
    });
  });

  it("returns structured errors for malformed events", () => {
    const normalized = normalizeAcpEvent(
      "gemini",
      rawEnvelope("session.created", {
        backend: "gemini",
      }),
    );

    expect(normalized).toMatchObject({
      error: {
        code: "stream_protocol_error",
      },
      ok: false,
    });
  });

  it("infers stable auth and rate-limit codes from provider-shaped ACP errors", () => {
    const auth = normalizeAcpEvent(
      "gemini",
      rawEnvelope("error", {
        error: {
          code: "permission_denied",
          message: "401 unauthorized: missing API key",
          statusCode: 401,
        },
      }),
    );
    const rate = normalizeAcpEvent(
      "opencode",
      rawEnvelope("run.failed", {
        error: {
          code: "resource_exhausted",
          message: "quota exceeded for current project",
          statusCode: 429,
          retryable: true,
        },
      }),
    );

    expect(auth).toMatchObject({
      ok: true,
      value: {
        event: {
          error: {
            code: "unauthorized",
          },
          type: "error",
        },
      },
    });
    expect(rate).toMatchObject({
      ok: true,
      value: {
        event: {
          error: {
            code: "rate_limited",
            retryable: true,
          },
          type: "error",
        },
      },
    });
  });

  it("collects terminal success from streamed notifications", async () => {
    const envelopes = [
      {
        kind: "notification" as const,
        message: rawEnvelope("session.created", {
          backend: "gemini",
          locator: { conversationId: "conv-7" },
          model: "gemini-3-flash",
        }),
      },
      {
        kind: "notification" as const,
        message: rawEnvelope("usage", {
          inputTokens: 8,
          outputTokens: 13,
        }),
      },
      {
        kind: "notification" as const,
        message: rawEnvelope("result", {
          locator: { conversationId: "conv-7" },
          stopReason: "completed",
          text: "final answer",
        }),
      },
    ];
    const transport = {
      async nextEnvelope() {
        return envelopes.shift() ?? null;
      },
    } as unknown as StdioAcpTransport;

    const outcome = await collectAcpQueryOutcome({
      backend: "gemini",
      eventTimeoutMs: 1_000,
      transport,
    });

    expect(outcome).toMatchObject({
      ok: true,
      result: {
        locator: { conversationId: "conv-7" },
        stopReason: "completed",
        text: "final answer",
      },
      usage: {
        inputTokens: 8,
        outputTokens: 13,
      },
    });
  });

  it("collects terminal failure events", async () => {
    const envelopes = [
      {
        kind: "notification" as const,
        message: rawEnvelope("run.failed", {
          error: {
            code: "rate_limited",
            message: "Too many requests",
            retryable: true,
          },
        }),
      },
    ];
    const transport = {
      async nextEnvelope() {
        return envelopes.shift() ?? null;
      },
    } as unknown as StdioAcpTransport;

    const outcome = await collectAcpQueryOutcome({
      backend: "opencode",
      eventTimeoutMs: 1_000,
      transport,
    });

    expect(outcome).toMatchObject({
      error: {
        code: "rate_limited",
        message: "Too many requests",
        retryable: true,
      },
      ok: false,
    });
  });

  it("returns a timeout outcome when no terminal event arrives", async () => {
    let calls = 0;
    const transport = {
      async nextEnvelope() {
        calls += 1;
        if (calls === 1) {
          return {
            kind: "notification" as const,
            message: rawEnvelope("message.delta", {
              delta: "still working",
            }),
          };
        }
        throw {
          code: "timeout",
          details: { timeoutMs: 50 },
          message: "ACP event stream timed out after 50ms.",
          retryable: true,
        };
      },
    } as unknown as StdioAcpTransport;

    const outcome = await collectAcpQueryOutcome({
      backend: "gemini",
      eventTimeoutMs: 50,
      transport,
    });

    expect(outcome).toMatchObject({
      error: {
        code: "timeout",
      },
      ok: false,
    });
  });
});
