import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

import {
  ACP_PROTOCOL_VERSION,
  type AcpInitializeRequest,
  type AcpInitializeResult,
  type AcpRuntimeError,
  type AcpRuntimeErrorCode,
  type AcpTransportConfig,
} from "./acp-contract.js";
import type { JsonObject, JsonValue } from "./json.js";
import { toJsonObject, toJsonValue } from "./json.js";

export type AcpTransportEnvelope =
  | {
      kind: "notification";
      message: JsonObject;
    }
  | {
      kind: "protocol_error";
      error: AcpRuntimeError;
      rawLine: string;
    };

type PendingRequest = {
  method: string;
  reject: (reason: AcpRuntimeError) => void;
  resolve: (value: JsonValue) => void;
  timeout: NodeJS.Timeout;
};

type EnvelopeWaiter = {
  reject: (reason: AcpRuntimeError) => void;
  resolve: (value: AcpTransportEnvelope | null) => void;
  timeout: NodeJS.Timeout | null;
};

const DEFAULT_STARTUP_TIMEOUT_MS = 5_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

function runtimeError(
  code: AcpRuntimeErrorCode,
  message: string,
  options: {
    details?: JsonObject | null;
    retryable?: boolean;
    statusCode?: number;
  } = {},
): AcpRuntimeError {
  return {
    code,
    details: options.details ?? null,
    message,
    retryable: options.retryable ?? false,
    statusCode: options.statusCode,
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: JsonObject | null, key: string): string | null {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function numberField(value: JsonObject | null, key: string): number | null {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function normalizeErrorDetails(value: unknown): JsonObject | null {
  return isJsonObject(value) ? value : null;
}

export class StdioAcpTransport {
  readonly #config: AcpTransportConfig;
  #child: ChildProcessWithoutNullStreams | null = null;
  #closed = false;
  #nextRequestId = 1;
  #pendingRequests = new Map<number, PendingRequest>();
  #queue: AcpTransportEnvelope[] = [];
  #waiters: EnvelopeWaiter[] = [];

  constructor(config: AcpTransportConfig) {
    this.#config = config;
  }

  async start(): Promise<void> {
    if (this.#child !== null) {
      return;
    }

    this.#closed = false;
    const child = spawn(this.#config.command, this.#config.args, {
      cwd: this.#config.cwd,
      env: this.#config.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;

    child.once("error", (error) => {
      const failure = runtimeError("transport_start_failed", error.message, {
        details: toJsonObject({
          args: this.#config.args,
          command: this.#config.command,
          cwd: this.#config.cwd ?? null,
        }),
      });
      this.#failPendingRequests(failure);
      this.#flushWaitersWithError(failure);
    });

    child.once("exit", (code, signal) => {
      this.#closed = true;
      const failure =
        code === 0 && signal === null
          ? null
          : runtimeError("transport_shutdown_failed", "ACP transport exited unexpectedly.", {
              details: toJsonObject({
                exitCode: code,
                signal,
              }),
            });
      if (failure !== null) {
        this.#failPendingRequests(failure);
        this.#flushWaitersWithError(failure);
      } else {
        this.#flushWaitersWithNull();
      }
      this.#child = null;
    });

    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => {
      this.#handleStdoutLine(line);
    });
    stdout.once("close", () => {
      stdout.removeAllListeners();
    });

    void child.stderr.resume();

    await Promise.resolve();
  }

  async initialize(request: Omit<AcpInitializeRequest, "protocolVersion">): Promise<AcpInitializeResult> {
    const result = await this.request(
      "initialize",
      {
        ...request,
        protocolVersion: ACP_PROTOCOL_VERSION,
      },
      {
        timeoutMs: this.#config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      },
    );

    if (!isJsonObject(result) || !isJsonObject(result.capabilities)) {
      throw runtimeError("initialize_failed", "ACP initialize response was malformed.", {
        details: isJsonObject(result) ? result : null,
      });
    }

    return result as AcpInitializeResult;
  }

  async request(
    method: string,
    params?: JsonObject | null,
    options: { timeoutMs?: number } = {},
  ): Promise<JsonValue> {
    await this.start();
    if (this.#child === null || this.#child.stdin.destroyed) {
      throw runtimeError("transport_start_failed", "ACP transport is not available.");
    }

    const id = this.#nextRequestId++;
    const timeoutMs = options.timeoutMs ?? this.#config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

    const payload = JSON.stringify({
      id,
      jsonrpc: "2.0",
      method,
      params: params ?? {},
    });

    const response = new Promise<JsonValue>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pendingRequests.delete(id);
        reject(
          runtimeError("timeout", `ACP request '${method}' timed out after ${timeoutMs}ms.`, {
            details: toJsonObject({ method, timeoutMs }),
            retryable: true,
          }),
        );
      }, timeoutMs);

      this.#pendingRequests.set(id, { method, reject, resolve, timeout });
    });

    this.#child.stdin.write(`${payload}\n`);
    return response;
  }

  async nextEnvelope(options: { timeoutMs?: number } = {}): Promise<AcpTransportEnvelope | null> {
    if (this.#queue.length > 0) {
      return this.#queue.shift() ?? null;
    }
    if (this.#closed && this.#child === null) {
      return null;
    }

    const timeoutMs = options.timeoutMs;

    return new Promise<AcpTransportEnvelope | null>((resolve, reject) => {
      const timeout =
        typeof timeoutMs === "number"
          ? setTimeout(() => {
              this.#waiters = this.#waiters.filter((waiter) => waiter.resolve !== resolve);
              reject(
                runtimeError("timeout", `ACP event stream timed out after ${timeoutMs}ms.`, {
                  details: toJsonObject({ timeoutMs }),
                  retryable: true,
                }),
              );
            }, timeoutMs)
          : null;

      this.#waiters.push({ reject, resolve, timeout });
    });
  }

  async close(): Promise<void> {
    const child = this.#child;
    if (child === null) {
      return;
    }
    const exitPromise = once(child, "exit");
    const shutdownTimeoutMs =
      this.#config.shutdownTimeoutMs ??
      this.#config.startupTimeoutMs ??
      DEFAULT_SHUTDOWN_TIMEOUT_MS;

    let shutdownError: AcpRuntimeError | null = null;

    if (!this.#closed && !child.stdin.destroyed) {
      try {
        await this.request("shutdown", null, {
          timeoutMs: shutdownTimeoutMs,
        });
      } catch (error) {
        const cause =
          error instanceof Error
            ? runtimeError("transport_shutdown_failed", error.message)
            : (error as AcpRuntimeError);
        shutdownError = runtimeError("transport_shutdown_failed", cause.message, {
          details: toJsonObject({
            cause,
          }),
          retryable: cause.retryable,
          statusCode: cause.statusCode,
        });
      }
    }

    child.stdin.end();
    if (!this.#closed) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (!this.#closed) {
          child.kill("SIGKILL");
        }
      }, shutdownTimeoutMs);

      try {
        await exitPromise;
      } finally {
        clearTimeout(timer);
      }
    }

    if (shutdownError !== null) {
      throw shutdownError;
    }
  }

  #handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.#enqueue({
        error: runtimeError("stream_protocol_error", "ACP transport emitted malformed JSON.", {
          details: toJsonObject({ line: trimmed }),
        }),
        kind: "protocol_error",
        rawLine: trimmed,
      });
      return;
    }

    if (!isJsonObject(parsed)) {
      this.#enqueue({
        error: runtimeError("stream_protocol_error", "ACP transport emitted a non-object message.", {
          details: toJsonObject({ value: toJsonValue(parsed) }),
        }),
        kind: "protocol_error",
        rawLine: trimmed,
      });
      return;
    }

    const id = numberField(parsed, "id");
    if (id !== null) {
      const pending = this.#pendingRequests.get(id);
      if (pending === undefined) {
        this.#enqueue({
          error: runtimeError("stream_protocol_error", "ACP transport emitted an unknown response id.", {
            details: toJsonObject({ id, line: trimmed }),
          }),
          kind: "protocol_error",
          rawLine: trimmed,
        });
        return;
      }

      clearTimeout(pending.timeout);
      this.#pendingRequests.delete(id);

      const errorDetails = normalizeErrorDetails(parsed.error);
      if (errorDetails !== null) {
        pending.reject(
          runtimeError(
            "prompt_failed",
            stringField(errorDetails, "message") ??
              `ACP request '${pending.method}' failed without a message.`,
            {
              details: errorDetails,
              retryable: false,
              statusCode: numberField(errorDetails, "code") ?? undefined,
            },
          ),
        );
        return;
      }

      pending.resolve(toJsonValue(parsed.result));
      return;
    }

    const method = stringField(parsed, "method");
    if (method !== null) {
      this.#enqueue({
        kind: "notification",
        message: parsed,
      });
      return;
    }

    this.#enqueue({
      error: runtimeError("stream_protocol_error", "ACP transport emitted an unrecognized message.", {
        details: parsed,
      }),
      kind: "protocol_error",
      rawLine: trimmed,
    });
  }

  #enqueue(envelope: AcpTransportEnvelope): void {
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      if (waiter.timeout !== null) {
        clearTimeout(waiter.timeout);
      }
      waiter.resolve(envelope);
      return;
    }
    this.#queue.push(envelope);
  }

  #failPendingRequests(error: AcpRuntimeError): void {
    for (const [id, pending] of this.#pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.#pendingRequests.delete(id);
    }
  }

  #flushWaitersWithError(error: AcpRuntimeError): void {
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      if (waiter === undefined) {
        break;
      }
      if (waiter.timeout !== null) {
        clearTimeout(waiter.timeout);
      }
      waiter.reject(error);
    }
  }

  #flushWaitersWithNull(): void {
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      if (waiter === undefined) {
        break;
      }
      if (waiter.timeout !== null) {
        clearTimeout(waiter.timeout);
      }
      waiter.resolve(null);
    }
  }
}
