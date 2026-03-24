import { readFileSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import process from "node:process";

const ACP_PROTOCOL_VERSION = "0.1";
const DEFAULT_TIMEOUT_S = 7200;
const MAX_BUFFER_BYTES = 50 * 1024 * 1024;
const EVENT_TIMEOUT_MS = 30_000;
const STARTUP_TIMEOUT_MS = 5_000;

function toRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function stringField(value, key) {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function booleanField(value, key) {
  const candidate = value?.[key];
  return typeof candidate === "boolean" ? candidate : null;
}

function numberField(value, key) {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
}

function parseJsonLines(text) {
  return text
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return toRecord(parsed) === null ? [] : [parsed];
      } catch {
        return [];
      }
    });
}

function parseTextBlocks(content) {
  if (!Array.isArray(content)) {
    return null;
  }

  const joined = content
    .flatMap((item) => {
      const record = toRecord(item);
      const text = stringField(record, "text") ?? stringField(record, "content");
      return text === null ? [] : [text];
    })
    .join("");

  return joined.length > 0 ? joined : null;
}

function parseClaudeCliOutput(result) {
  const messages = parseJsonLines(result.stdout);
  let resultText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let sessionId = null;
  const errorMessages = [];

  for (const message of messages) {
    sessionId ??= stringField(message, "session_id") ?? stringField(message, "sessionId");
    const messageType = stringField(message, "type") ?? "";

    if (messageType === "result") {
      resultText =
        stringField(message, "result") ??
        stringField(message, "response") ??
        stringField(message, "message") ??
        resultText;
      const usage = toRecord(message.usage);
      inputTokens += numberField(usage, "input_tokens") || numberField(usage, "prompt_tokens");
      outputTokens +=
        numberField(usage, "output_tokens") || numberField(usage, "completion_tokens");
      continue;
    }

    if (messageType === "assistant" || messageType === "assistant_message") {
      const embedded = toRecord(message.message);
      resultText =
        stringField(message, "message") ??
        stringField(embedded, "message") ??
        parseTextBlocks(embedded?.content) ??
        resultText;
      const usage = toRecord(message.usage);
      inputTokens += numberField(usage, "input_tokens") || numberField(usage, "prompt_tokens");
      outputTokens +=
        numberField(usage, "output_tokens") || numberField(usage, "completion_tokens");
      continue;
    }

    if (messageType === "error") {
      const errorText = stringField(message, "message") ?? stringField(message, "error");
      if (errorText !== null) {
        errorMessages.push(errorText);
      }
    }
  }

  if (resultText.length === 0 && errorMessages.length > 0) {
    resultText = errorMessages.at(-1) ?? "";
  }

  return {
    inputTokens,
    isError: errorMessages.length > 0 && resultText.length === 0,
    outputTokens,
    rawMessages: messages,
    resultText,
    sessionId,
  };
}

function parseCodexOutput(result) {
  const messages = parseJsonLines(result.stdout);
  let resultText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let sessionId = null;
  const errorMessages = [];

  for (const message of messages) {
    const inner = toRecord(message.msg);
    const messageType = stringField(message, "type") ?? stringField(inner, "type") ?? "";

    if (messageType === "thread.started") {
      sessionId =
        stringField(message, "thread_id") ?? stringField(message, "session_id") ?? sessionId;
      continue;
    }
    if (messageType === "agent_message") {
      resultText = stringField(inner, "message") ?? stringField(message, "message") ?? resultText;
      continue;
    }
    if (messageType === "token_count") {
      inputTokens += numberField(inner, "input_tokens") || numberField(message, "input_tokens");
      outputTokens += numberField(inner, "output_tokens") || numberField(message, "output_tokens");
      continue;
    }
    if (messageType === "turn.completed") {
      const usage = toRecord(message.usage);
      inputTokens += numberField(usage, "input_tokens");
      outputTokens += numberField(usage, "output_tokens");
      continue;
    }
    if (messageType === "item.completed") {
      const item = toRecord(message.item);
      if (stringField(item, "type") === "agent_message") {
        resultText = stringField(item, "text") ?? resultText;
      } else if (stringField(item, "role") === "assistant") {
        resultText = parseTextBlocks(item?.content) ?? resultText;
      }
      continue;
    }
    if (messageType === "error") {
      const text =
        stringField(inner, "message") ??
        stringField(inner, "error") ??
        stringField(message, "message") ??
        stringField(message, "error");
      if (text !== null) {
        errorMessages.push(text);
      }
      continue;
    }
    if (messageType === "background_event") {
      const text = stringField(inner, "message") ?? stringField(message, "message");
      if (text !== null && /(error|status 4)/iu.test(text)) {
        errorMessages.push(text);
      }
    }
  }

  if (resultText.length === 0 && errorMessages.length > 0) {
    resultText = errorMessages.at(-1) ?? "";
  }

  return {
    inputTokens,
    isError: errorMessages.length > 0 && resultText.length > 0,
    outputTokens,
    rawMessages: messages,
    resultText,
    sessionId,
  };
}

function parseCursorOutput(result) {
  const messages = parseJsonLines(result.stdout);
  let resultText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let sessionId = null;

  for (const message of messages) {
    if (stringField(message, "type") === "result") {
      const raw = message.result;
      resultText = raw == null ? resultText : typeof raw === "string" ? raw : JSON.stringify(raw);
    }

    const usage = toRecord(message.usage) ?? message;
    if ("input_tokens" in usage) {
      inputTokens += numberField(usage, "input_tokens");
      outputTokens += numberField(usage, "output_tokens");
    } else if (stringField(message, "type") === "token_count") {
      const inner = toRecord(message.data) ?? message;
      inputTokens += numberField(inner, "input_tokens");
      outputTokens += numberField(inner, "output_tokens");
    }

    sessionId =
      stringField(message, "chatId") ??
      stringField(message, "chat_id") ??
      stringField(message, "session_id") ??
      sessionId;
  }

  return {
    inputTokens,
    outputTokens,
    rawMessages: messages,
    resultText,
    sessionId,
  };
}

const LEGACY_ADAPTERS = {
  "claude-cli": {
    buildCommand({ model, prompt, maxTurns, sessionId }) {
      const args = [
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
        "--permission-mode",
        "bypassPermissions",
        "--disallowedTools",
        "AskUserQuestion",
        "--model",
        model,
        "--max-turns",
        String(maxTurns),
      ];
      if (sessionId !== null) {
        args.push("--resume", sessionId);
      }
      args.push(prompt);
      return { args, command: "claude", cwd: undefined };
    },
    parseOutput: parseClaudeCliOutput,
  },
  codex: {
    buildCommand({ model, prompt, projectDir, sessionId }) {
      const args = ["exec"];
      if (sessionId !== null) {
        args.push("resume", sessionId, prompt);
      } else {
        args.push(prompt);
      }
      args.push(
        "--full-auto",
        "--json",
        "--cd",
        projectDir,
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "-m",
        model,
      );
      return { args, command: "codex", cwd: undefined };
    },
    parseOutput: parseCodexOutput,
  },
  cursor: {
    buildCommand({ model, prompt, projectDir, sessionId }) {
      const args = [
        "-p",
        "-f",
        "--output-format",
        "stream-json",
        "--model",
        model,
        "--workspace",
        projectDir,
      ];
      if (sessionId !== null) {
        args.push("--resume", sessionId);
      }
      args.push(prompt);
      return { args, command: "cursor-agent", cwd: projectDir };
    },
    parseOutput: parseCursorOutput,
  },
};

function classifyLegacySessionError(result, backend, timeoutS) {
  if (result.error?.code === "ETIMEDOUT") {
    return `${backend}: Process timed out after ${timeoutS}s.`;
  }
  if (result.signal) {
    return `${backend}: Process killed by signal ${result.signal}.`;
  }
  return result.stderr.trim() || result.stdout.trim() || `${backend}: process failed`;
}

function buildWorkerEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

function parseLocatorFromSessionId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(sessionId);
    const record = toRecord(parsed);
    const conversationId =
      stringField(record, "conversationId") ??
      stringField(record, "conversation_id") ??
      stringField(record, "id");
    if (conversationId !== null) {
      return {
        conversationId,
        providerThreadId:
          stringField(record, "providerThreadId") ?? stringField(record, "provider_thread_id"),
        serverSessionId:
          stringField(record, "serverSessionId") ?? stringField(record, "server_session_id"),
      };
    }
  } catch {}

  return { conversationId: sessionId };
}

function parseLocator(value) {
  const record = toRecord(value);
  if (record === null) {
    return null;
  }
  const conversationId =
    stringField(record, "conversationId") ??
    stringField(record, "conversation_id") ??
    stringField(record, "id");
  if (conversationId === null) {
    return null;
  }
  return {
    conversationId,
    providerThreadId:
      stringField(record, "providerThreadId") ?? stringField(record, "provider_thread_id"),
    serverSessionId:
      stringField(record, "serverSessionId") ?? stringField(record, "server_session_id"),
  };
}

function parseUsage(value) {
  const record = toRecord(value);
  if (record === null) {
    return null;
  }
  const inputTokens =
    numberField(record, "inputTokens") ||
    numberField(record, "input_tokens") ||
    numberField(record, "prompt") ||
    numberField(record, "prompt_tokens");
  const outputTokens =
    numberField(record, "outputTokens") ||
    numberField(record, "output_tokens") ||
    numberField(record, "completion_tokens") ||
    numberField(record, "candidates");
  const totalTokens =
    numberField(record, "totalTokens") ||
    numberField(record, "total_tokens") ||
    inputTokens + outputTokens;
  const costUsd = numberField(record, "costUsd") || numberField(record, "cost_usd") || null;
  return {
    costUsd,
    inputTokens,
    outputTokens,
    raw: record,
    totalTokens,
  };
}

function parseAcpError(value, fallbackCode = "prompt_failed", fallbackMessage = "ACP request failed.") {
  const record = toRecord(value);
  if (record === null) {
    return {
      code: fallbackCode,
      details: null,
      message: fallbackMessage,
      retryable: false,
      statusCode: undefined,
    };
  }

  return {
    code: stringField(record, "code") ?? fallbackCode,
    details: record,
    message: stringField(record, "message") ?? fallbackMessage,
    retryable: booleanField(record, "retryable") ?? false,
    statusCode: numberField(record, "statusCode") || numberField(record, "status_code") || undefined,
  };
}

function acpProfiles(payload) {
  const selected =
    payload.acpBackend ??
    process.env.KODO_GEMINI_ACP_BACKEND ??
    (process.env.KODO_OPENCODE === "1" ? "opencode" : "gemini");

  return {
    selected,
    profile:
      selected === "opencode"
        ? {
            backend: "opencode",
            command: "opencode",
            args: ["acp", "--provider", "gemini"],
            costBucket: "gemini_api",
          }
        : {
            backend: "gemini",
            command: "gemini",
            args: ["acp"],
            costBucket: "gemini_api",
          },
  };
}

class LineTransport {
  constructor(config) {
    this.config = config;
    this.child = null;
    this.closed = false;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.queue = [];
    this.waiters = [];
  }

  async start() {
    if (this.child !== null) {
      return;
    }

    this.closed = false;
    const child = spawn(this.config.command, this.config.args, {
      cwd: this.config.cwd,
      env: this.config.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.once("error", (error) => {
      const failure = parseAcpError(
        {
          code: "transport_start_failed",
          command: this.config.command,
          cwd: this.config.cwd ?? null,
          message: error.message,
        },
        "transport_start_failed",
        error.message,
      );
      this.failAll(failure);
    });

    child.once("exit", (code, signal) => {
      this.closed = true;
      this.child = null;
      if (code === 0 && signal === null) {
        this.flushWaiters(null);
        return;
      }
      this.failAll(
        parseAcpError(
          {
            code: "transport_shutdown_failed",
            exitCode: code,
            message: "ACP transport exited unexpectedly.",
            signal,
          },
          "transport_shutdown_failed",
          "ACP transport exited unexpectedly.",
        ),
      );
    });

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      this.handleLine(line);
    });
    rl.once("close", () => {
      rl.removeAllListeners();
    });

    void child.stderr.resume();
  }

  async request(method, params, timeoutMs) {
    await this.start();
    if (this.child === null || this.child.stdin.destroyed) {
      throw parseAcpError(null, "transport_start_failed", "ACP transport is not available.");
    }

    const id = this.nextRequestId++;
    const payload = JSON.stringify({
      id,
      jsonrpc: "2.0",
      method,
      params: params ?? {},
    });

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          parseAcpError(
            {
              code: "timeout",
              message: `ACP request '${method}' timed out after ${timeoutMs}ms.`,
              retryable: true,
              timeoutMs,
            },
            "timeout",
            `ACP request '${method}' timed out after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);

      this.pending.set(id, { method, reject, resolve, timeout });
      this.child.stdin.write(`${payload}\n`);
    });
  }

  async nextEnvelope(timeoutMs) {
    if (this.queue.length > 0) {
      return this.queue.shift() ?? null;
    }
    if (this.closed && this.child === null) {
      return null;
    }

    return await new Promise((resolve, reject) => {
      const timeout =
        typeof timeoutMs === "number"
          ? setTimeout(() => {
              this.waiters = this.waiters.filter((waiter) => waiter.resolve !== resolve);
              reject(
                parseAcpError(
                  {
                    code: "timeout",
                    message: `ACP event stream timed out after ${timeoutMs}ms.`,
                    retryable: true,
                    timeoutMs,
                  },
                  "timeout",
                  `ACP event stream timed out after ${timeoutMs}ms.`,
                ),
              );
            }, timeoutMs)
          : null;

      this.waiters.push({ reject, resolve, timeout });
    });
  }

  async close() {
    if (this.child === null) {
      return;
    }

    const child = this.child;
    const exitPromise = new Promise((resolve) => {
      child.once("exit", resolve);
    });

    if (!this.closed && !child.stdin.destroyed) {
      try {
        await this.request("shutdown", null, STARTUP_TIMEOUT_MS);
      } catch {}
    }

    if (!child.killed) {
      child.kill("SIGTERM");
    }

    await exitPromise;
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.pushEnvelope({
        error: parseAcpError(
          {
            code: "stream_protocol_error",
            message: "ACP transport emitted invalid JSON.",
            rawLine: line,
          },
          "stream_protocol_error",
          "ACP transport emitted invalid JSON.",
        ),
        kind: "protocol_error",
        rawLine: line,
      });
      return;
    }

    const record = toRecord(message);
    if (record === null) {
      this.pushEnvelope({
        error: parseAcpError(
          {
            code: "stream_protocol_error",
            message: "ACP transport emitted a non-object JSON value.",
            rawLine: line,
          },
          "stream_protocol_error",
          "ACP transport emitted a non-object JSON value.",
        ),
        kind: "protocol_error",
        rawLine: line,
      });
      return;
    }

    const id = numberField(record, "id");
    if (id > 0 && this.pending.has(id)) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      clearTimeout(pending.timeout);

      if ("error" in record) {
        pending.reject(
          parseAcpError(
            record.error,
            pending.method === "session.resume" ? "session_resume_failed" : "prompt_failed",
          ),
        );
        return;
      }

      pending.resolve(record.result ?? null);
      return;
    }

    if (typeof record.method === "string") {
      this.pushEnvelope({
        kind: "notification",
        message: record,
      });
    }
  }

  pushEnvelope(envelope) {
    const waiter = this.waiters.shift();
    if (waiter) {
      if (waiter.timeout !== null) {
        clearTimeout(waiter.timeout);
      }
      waiter.resolve(envelope);
      return;
    }
    this.queue.push(envelope);
  }

  flushWaiters(value) {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      if (waiter.timeout !== null) {
        clearTimeout(waiter.timeout);
      }
      waiter.resolve(value);
    }
  }

  failAll(error) {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const item of pending) {
      clearTimeout(item.timeout);
      item.reject(error);
    }
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      if (waiter.timeout !== null) {
        clearTimeout(waiter.timeout);
      }
      waiter.reject(error);
    }
  }
}

function normalizeAcpEvent(backend, envelope) {
  const params = toRecord(envelope?.params) ?? {};
  const method = stringField(envelope, "method") ?? "";

  if (backend === "opencode") {
    switch (method) {
      case "thread.created":
        return normalizeSessionEvent("opencode", params, envelope, "session.created", "model");
      case "thread.resumed":
        return normalizeSessionEvent("opencode", params, envelope, "session.resumed", "model");
      case "assistant.delta": {
        const delta = stringField(params, "delta");
        return delta === null
          ? invalidNormalized(envelope, "OpenCode assistant.delta payload was malformed.")
          : { ok: true, value: { event: { delta, type: "message.delta" }, raw: envelope } };
      }
      case "assistant.completed": {
        const text = stringField(params, "text") ?? stringField(params, "output");
        return text === null
          ? invalidNormalized(envelope, "OpenCode assistant.completed payload was malformed.")
          : { ok: true, value: { event: { text, type: "message.completed" }, raw: envelope } };
      }
      case "tool.started": {
        const toolName = stringField(params, "toolName") ?? stringField(params, "name");
        return toolName === null
          ? invalidNormalized(envelope, "OpenCode tool.started payload was malformed.")
          : {
              ok: true,
              value: {
                event: { input: toRecord(params.input), toolName, type: "tool.call" },
                raw: envelope,
              },
            };
      }
      case "tool.finished": {
        const toolName = stringField(params, "toolName") ?? stringField(params, "name");
        return toolName === null
          ? invalidNormalized(envelope, "OpenCode tool.finished payload was malformed.")
          : {
              ok: true,
              value: {
                event: {
                  isError: booleanField(params, "isError") ?? false,
                  output: toRecord(params.output),
                  toolName,
                  type: "tool.result",
                },
                raw: envelope,
              },
            };
      }
      case "token_count": {
        const usage = parseUsage(params);
        return usage === null
          ? invalidNormalized(envelope, "OpenCode token_count payload was malformed.")
          : { ok: true, value: { event: { type: "usage", usage }, raw: envelope } };
      }
      case "warning":
        return {
          ok: true,
          value: {
            event: {
              code: stringField(params, "code") ?? undefined,
              message: stringField(params, "message") ?? "ACP warning",
              retryable: booleanField(params, "retryable") ?? undefined,
              type: "warning",
            },
            raw: envelope,
          },
        };
      case "run.failed":
        return {
          ok: true,
          value: {
            event: {
              error: parseAcpError(params.error ?? params, "prompt_failed"),
              type: "error",
            },
            raw: envelope,
          },
        };
      case "run.completed": {
        const locator = parseLocator(params.thread ?? params.locator ?? params);
        if (locator === null) {
          return invalidNormalized(envelope, "OpenCode run.completed payload was malformed.");
        }
        return {
          ok: true,
          value: {
            event: {
              result: {
                locator,
                raw: params,
                stopReason: stringField(params, "status") ?? "completed",
                text: stringField(params, "output") ?? stringField(params, "text") ?? "",
                usage: parseUsage(params.usage ?? params),
              },
              type: "result",
            },
            raw: envelope,
          },
        };
      }
      default:
        return {
          ok: true,
          value: {
            event: {
              code: "unsupported_event",
              message: `Ignored ACP event: ${method}`,
              type: "warning",
            },
            raw: envelope,
          },
        };
    }
  }

  switch (method) {
    case "session.created":
      return normalizeSessionEvent("gemini", params, envelope, "session.created", "model");
    case "session.resumed":
      return normalizeSessionEvent("gemini", params, envelope, "session.resumed", "model");
    case "message.delta": {
      const delta = stringField(params, "delta");
      return delta === null
        ? invalidNormalized(envelope, "Gemini message.delta payload was malformed.")
        : { ok: true, value: { event: { delta, type: "message.delta" }, raw: envelope } };
    }
    case "message.completed": {
      const text = stringField(params, "text");
      return text === null
        ? invalidNormalized(envelope, "Gemini message.completed payload was malformed.")
        : { ok: true, value: { event: { text, type: "message.completed" }, raw: envelope } };
    }
    case "tool.call": {
      const toolName = stringField(params, "toolName") ?? stringField(params, "name");
      return toolName === null
        ? invalidNormalized(envelope, "Gemini tool.call payload was malformed.")
        : {
            ok: true,
            value: {
              event: { input: toRecord(params.input), toolName, type: "tool.call" },
              raw: envelope,
            },
          };
    }
    case "tool.result": {
      const toolName = stringField(params, "toolName") ?? stringField(params, "name");
      return toolName === null
        ? invalidNormalized(envelope, "Gemini tool.result payload was malformed.")
        : {
            ok: true,
            value: {
              event: {
                isError: booleanField(params, "isError") ?? false,
                output: toRecord(params.output),
                toolName,
                type: "tool.result",
              },
              raw: envelope,
            },
          };
    }
    case "usage": {
      const usage = parseUsage(params);
      return usage === null
        ? invalidNormalized(envelope, "Gemini usage payload was malformed.")
        : { ok: true, value: { event: { type: "usage", usage }, raw: envelope } };
    }
    case "warning":
      return {
        ok: true,
        value: {
          event: {
            code: stringField(params, "code") ?? undefined,
            message: stringField(params, "message") ?? "ACP warning",
            retryable: booleanField(params, "retryable") ?? undefined,
            type: "warning",
          },
          raw: envelope,
        },
      };
    case "error":
      return {
        ok: true,
        value: {
          event: {
            error: parseAcpError(params.error ?? params, "prompt_failed"),
            type: "error",
          },
          raw: envelope,
        },
      };
    case "result": {
      const locator = parseLocator(params.locator ?? params);
      if (locator === null) {
        return invalidNormalized(envelope, "Gemini result payload was malformed.");
      }
      return {
        ok: true,
        value: {
          event: {
            result: {
              locator,
              raw: params,
              stopReason: stringField(params, "stopReason") ?? stringField(params, "status") ?? "completed",
              text: stringField(params, "text") ?? "",
              usage: parseUsage(params.usage),
            },
            type: "result",
          },
          raw: envelope,
        },
      };
    }
    default:
      return {
        ok: true,
        value: {
          event: {
            code: "unsupported_event",
            message: `Ignored ACP event: ${method}`,
            type: "warning",
          },
          raw: envelope,
        },
      };
    }
  }

function normalizeSessionEvent(expectedBackend, params, raw, type, modelField) {
  const locator = parseLocator(params.locator ?? params.thread ?? params);
  const model = stringField(params, modelField);
  const backend = stringField(params, "backend") ?? expectedBackend;
  if (locator === null || model === null || backend !== expectedBackend) {
    return invalidNormalized(raw, `${expectedBackend} ${type} payload was malformed.`);
  }
  return {
    ok: true,
    value: {
      event: {
        backend,
        locator,
        model,
        type,
      },
      raw,
    },
  };
}

function invalidNormalized(raw, message) {
  return {
    error: parseAcpError(
      {
        code: "stream_protocol_error",
        details: raw,
        message,
      },
      "stream_protocol_error",
      message,
    ),
    ok: false,
    raw,
  };
}

async function collectAcpQueryOutcome(transport, backend, eventTimeoutMs) {
  const events = [];
  let lastUsage = null;
  let locator;

  while (true) {
    let envelope;
    try {
      envelope = await transport.nextEnvelope(eventTimeoutMs);
    } catch (error) {
      return {
        error,
        events,
        locator,
        ok: false,
        usage: lastUsage,
      };
    }

    if (envelope === null) {
      return {
        error: parseAcpError(
          {
            code: "stream_protocol_error",
            message: "ACP stream ended before a terminal result arrived.",
          },
          "stream_protocol_error",
          "ACP stream ended before a terminal result arrived.",
        ),
        events,
        locator,
        ok: false,
        usage: lastUsage,
      };
    }

    if (envelope.kind === "protocol_error") {
      return {
        error: envelope.error,
        events,
        locator,
        ok: false,
        usage: lastUsage,
      };
    }

    const normalized = normalizeAcpEvent(backend, envelope.message);
    if (!normalized.ok) {
      events.push({
        event: { error: normalized.error, type: "error" },
        raw: normalized.raw,
      });
      return {
        error: normalized.error,
        events,
        locator,
        ok: false,
        usage: lastUsage,
      };
    }

    events.push(normalized.value);
    const current = normalized.value.event;

    if (current.type === "usage") {
      lastUsage = current.usage;
      continue;
    }

    if (current.type === "session.created" || current.type === "session.resumed") {
      locator = current.locator;
      continue;
    }

    if (current.type === "error") {
      return {
        error: current.error,
        events,
        locator,
        ok: false,
        usage: lastUsage,
      };
    }

    if (current.type === "result") {
      return {
        events,
        ok: true,
        result: current.result,
        usage: current.result.usage ?? lastUsage,
      };
    }
  }
}

function formatAcpError(error, backendLabel, timeoutS) {
  switch (error?.code) {
    case "timeout":
      return `${backendLabel}: Process timed out after ${timeoutS}s. Hint: increase session_timeout_s in TeamConfig.`;
    case "unauthorized":
      return `${backendLabel}: Authentication failed — check your API key or login status.`;
    case "rate_limited":
      return `${backendLabel}: Subscription/billing issue — check your account status.`;
    case "service_unavailable":
      return `${backendLabel}: Service unavailable — try again later.`;
    case "session_resume_failed":
      return `${backendLabel}: Failed to resume session. ${error.message}`;
    case "stream_protocol_error":
      return `${backendLabel}: ACP protocol error. ${error.message}`;
    default:
      return `${backendLabel}: ${error?.message ?? "ACP request failed."}`;
  }
}

async function runAcpQuery(payload) {
  const { profile } = acpProfiles(payload);
  const transport = new LineTransport({
    args: profile.args,
    command: profile.command,
    cwd: payload.projectDir,
    env: buildWorkerEnv(),
  });
  const startedAt = Date.now();
  const timeoutS = payload.timeoutS ?? DEFAULT_TIMEOUT_S;
  const timeoutMs = timeoutS * 1000;

  try {
    const init = await transport.request(
      "initialize",
      {
        clientName: "kodo-session-helper",
        clientVersion: "1.0.0",
        protocolVersion: ACP_PROTOCOL_VERSION,
        requestedCapabilities: {
          initialize: true,
          prompt: true,
          resume: true,
          sessionLifecycle: true,
          streaming: true,
          usage: true,
        },
      },
      Math.min(timeoutMs, STARTUP_TIMEOUT_MS),
    );
    const capabilities = toRecord(init?.capabilities);
    if (capabilities === null || booleanField(capabilities, "prompt") !== true) {
      throw parseAcpError(
        {
          code: "capability_mismatch",
          message: "ACP initialize response was malformed or missing prompt capability.",
        },
        "capability_mismatch",
        "ACP initialize response was malformed or missing prompt capability.",
      );
    }

    let locator = parseLocator(init?.locator);

    if (payload.resumeSessionId) {
      const resumed = await transport.request(
        "session.resume",
        {
          backend: profile.backend,
          cwd: payload.projectDir,
          locator: parseLocatorFromSessionId(payload.resumeSessionId),
          metadata: toRecord(payload.metadata) ?? undefined,
          model: payload.model,
        },
        Math.min(timeoutMs, STARTUP_TIMEOUT_MS),
      );
      locator = parseLocator(resumed?.locator ?? resumed) ?? locator;
    } else {
      const created = await transport.request(
        "session.create",
        {
          backend: profile.backend,
          cwd: payload.projectDir,
          metadata: toRecord(payload.metadata) ?? undefined,
          model: payload.model,
          systemPrompt: payload.systemPrompt ?? null,
        },
        Math.min(timeoutMs, STARTUP_TIMEOUT_MS),
      );
      locator = parseLocator(created?.locator ?? created) ?? locator;
    }

    const promptResponse = await transport.request(
      "prompt",
      {
        cwd: payload.projectDir,
        maxTurns: payload.maxTurns,
        metadata: toRecord(payload.metadata) ?? undefined,
        prompt: payload.prompt,
      },
      timeoutMs,
    );

    const promptRecord = toRecord(promptResponse);
    if (booleanField(promptRecord, "accepted") === false) {
      throw parseAcpError(
        {
          code: "prompt_rejected",
          message: stringField(promptRecord, "message") ?? "ACP prompt was rejected.",
        },
        "prompt_rejected",
        "ACP prompt was rejected.",
      );
    }

    const outcome = await collectAcpQueryOutcome(
      transport,
      profile.backend,
      Math.min(timeoutMs, EVENT_TIMEOUT_MS),
    );

    const elapsedS = Number(((Date.now() - startedAt) / 1000).toFixed(3));
    const rawMessages = outcome.events
      .map((entry) => entry.raw ?? { event: entry.event })
      .filter((value) => value != null);

    if (!outcome.ok) {
      const finalLocator = outcome.locator ?? locator;
      return {
        conversationLog: null,
        costBucket: profile.costBucket,
        elapsedS,
        inputTokens: outcome.usage?.inputTokens ?? null,
        isError: true,
        outputTokens: outcome.usage?.outputTokens ?? null,
        rawMessages,
        sessionId: finalLocator?.conversationId ?? payload.resumeSessionId ?? null,
        text: formatAcpError(outcome.error, payload.backend, timeoutS),
        usageRaw: outcome.usage?.raw ?? null,
      };
    }

    const finalLocator = outcome.result.locator ?? locator;
    return {
      conversationLog: null,
      costBucket: profile.costBucket,
      elapsedS,
      inputTokens: outcome.usage?.inputTokens ?? null,
      isError: outcome.result.stopReason === "failed" || outcome.result.stopReason === "timed_out",
      outputTokens: outcome.usage?.outputTokens ?? null,
      rawMessages,
      sessionId: finalLocator?.conversationId ?? payload.resumeSessionId ?? null,
      text: outcome.result.text ?? "",
      usageRaw: outcome.usage?.raw ?? null,
    };
  } finally {
    try {
      await transport.close();
    } catch {}
  }
}

function runLegacyQuery(payload) {
  const adapter = LEGACY_ADAPTERS[payload.backend];
  const finalPrompt =
    payload.systemPrompt && payload.systemPrompt.length > 0
      ? `${payload.systemPrompt}\n\n${payload.prompt}`
      : payload.prompt;
  const command = adapter.buildCommand({
    maxTurns: payload.maxTurns,
    model: payload.model,
    projectDir: payload.projectDir,
    prompt: finalPrompt,
    sessionId: payload.resumeSessionId,
  });
  const startedAt = Date.now();
  const result = spawnSync(command.command, command.args, {
    cwd: command.cwd,
    encoding: "utf8",
    env: buildWorkerEnv(),
    killSignal: "SIGKILL",
    maxBuffer: MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: (payload.timeoutS ?? DEFAULT_TIMEOUT_S) * 1000,
  });
  const parsed = adapter.parseOutput({
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  });
  const isError =
    (result.status ?? 1) !== 0 ||
    result.signal !== null ||
    result.error !== undefined ||
    parsed.isError === true;
  const text =
    parsed.resultText?.trim() ||
    (isError
      ? classifyLegacySessionError(result, payload.backend, payload.timeoutS ?? DEFAULT_TIMEOUT_S)
      : "");

  return {
    elapsedS: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
    inputTokens: parsed.inputTokens ?? null,
    isError,
    outputTokens: parsed.outputTokens ?? null,
    rawMessages: parsed.rawMessages ?? [],
    sessionId: parsed.sessionId ?? payload.resumeSessionId ?? null,
    text,
    usageRaw: parsed.usageRaw ?? null,
  };
}

async function main() {
  const [, , payloadPath, outputPath] = process.argv;
  const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
  const result =
    payload.backend === "gemini-cli" ? await runAcpQuery(payload) : runLegacyQuery(payload);

  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

await main();
