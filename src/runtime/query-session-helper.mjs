import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import process from "node:process";

const ACP_PROTOCOL_VERSION = "0.1";
const DEFAULT_TIMEOUT_S = 7200;
const EVENT_TIMEOUT_MS = 30_000;
const STARTUP_TIMEOUT_MS = 5_000;
const ACP_PROVIDER_ENV_VARS = ["GEMINI_API_KEY", "GOOGLE_API_KEY"];
const STABLE_ACP_CODES = new Set([
  "transport_start_failed",
  "transport_shutdown_failed",
  "initialize_failed",
  "capability_mismatch",
  "session_create_failed",
  "session_resume_failed",
  "prompt_rejected",
  "prompt_failed",
  "stream_protocol_error",
  "timeout",
  "unauthorized",
  "rate_limited",
  "service_unavailable",
  "unsupported",
]);
const AUTH_PATTERNS = new RegExp(
  [
    "unauthori[sz]ed",
    "authentication failed",
    "invalid.{0,20}(api.?key|token|credential)",
    "401\\b",
    "403\\b",
    "forbidden",
    "access denied",
    "not authenticated",
  ].join("|"),
  "i",
);
const RATE_LIMIT_PATTERNS = new RegExp(
  ["quota exceeded", "rate.?limit", "usage.?limit", "plan.?limit", "429\\b", "too many requests"].join(
    "|",
  ),
  "i",
);
const SERVICE_PATTERNS = new RegExp(
  ["503\\b", "service unavailable", "connection refused", "temporar", "overloaded", "unavailable"].join(
    "|",
  ),
  "i",
);

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

function stringifyUnknown(value) {
  if (typeof value === "string") {
    return value;
  }
  if (value == null) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function buildWorkerEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return env;
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

function parseLocatorFromSessionId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(sessionId);
    return parseLocator(parsed) ?? { conversationId: sessionId };
  } catch {
    return { conversationId: sessionId };
  }
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
    numberField(record, "totalTokens") || numberField(record, "total_tokens") || inputTokens + outputTokens;
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

  const statusCode =
    numberField(record, "statusCode") || numberField(record, "status_code") || undefined;
  const combined = [
    stringField(record, "code"),
    stringField(record, "message"),
    stringifyUnknown(record.details),
    stringifyUnknown(record.data),
  ]
    .filter(Boolean)
    .join("\n");
  let code = stringField(record, "code") ?? fallbackCode;

  if (!STABLE_ACP_CODES.has(code)) {
    if (statusCode === 401 || statusCode === 403 || AUTH_PATTERNS.test(combined)) {
      code = "unauthorized";
    } else if (statusCode === 429 || RATE_LIMIT_PATTERNS.test(combined)) {
      code = "rate_limited";
    } else if (
      statusCode === 502 ||
      statusCode === 503 ||
      statusCode === 504 ||
      SERVICE_PATTERNS.test(combined)
    ) {
      code = "service_unavailable";
    } else {
      code = fallbackCode;
    }
  }

  return {
    code,
    details: record,
    message: stringField(record, "message") ?? fallbackMessage,
    retryable: booleanField(record, "retryable") ?? false,
    statusCode,
  };
}

function acpProfiles(payload) {
  const selected = payload.acpBackend ?? (payload.backend === "opencode" ? "opencode" : "gemini");
  return {
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
    provider: "gemini",
    providerEnvVars: ACP_PROVIDER_ENV_VARS,
    selected,
  };
}

function requestFailureCode(method) {
  switch (method) {
    case "initialize":
      return "initialize_failed";
    case "session.create":
      return "session_create_failed";
    case "session.resume":
      return "session_resume_failed";
    default:
      return "prompt_failed";
  }
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
      this.failAll(
        parseAcpError(
          {
            code: "transport_start_failed",
            command: this.config.command,
            cwd: this.config.cwd ?? null,
            message: error.message,
          },
          "transport_start_failed",
          error.message,
        ),
      );
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
    rl.on("line", (line) => this.handleLine(line));
    rl.once("close", () => rl.removeAllListeners());
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
    const exitPromise = new Promise((resolve) => child.once("exit", resolve));

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
        pending.reject(parseAcpError(record.error, requestFailureCode(pending.method)));
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

async function collectAcpQueryOutcome(transport, backend, eventTimeoutMs) {
  const events = [];
  let lastUsage = null;
  let locator;

  while (true) {
    let envelope;
    try {
      envelope = await transport.nextEnvelope(eventTimeoutMs);
    } catch (error) {
      return { error, events, locator, ok: false, usage: lastUsage };
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
      return { error: envelope.error, events, locator, ok: false, usage: lastUsage };
    }

    const normalized = normalizeAcpEvent(backend, envelope.message);
    if (!normalized.ok) {
      events.push({ event: { error: normalized.error, type: "error" }, raw: normalized.raw });
      return { error: normalized.error, events, locator, ok: false, usage: lastUsage };
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
      return { error: current.error, events, locator, ok: false, usage: lastUsage };
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

function formatAcpError(error, profileInfo, timeoutS) {
  const backendLabel =
    profileInfo.selected === "opencode" ? "opencode (Gemini provider)" : "gemini";
  const credentialHint = `check ${profileInfo.providerEnvVars.join(" or ")} or your login status.`;
  switch (error?.code) {
    case "timeout":
      return `${backendLabel}: Process timed out after ${timeoutS}s. Hint: increase session_timeout_s in TeamConfig.`;
    case "unauthorized":
      return `${backendLabel}: Authentication failed — ${credentialHint}`;
    case "rate_limited":
      return `${backendLabel}: Quota or rate limit reached — check billing, quota, or retry later.`;
    case "service_unavailable":
      return `${backendLabel}: Service unavailable — try again later.`;
    case "transport_start_failed":
      return `${backendLabel}: ACP transport failed to start. Check that the CLI is installed and on PATH.`;
    case "transport_shutdown_failed":
      return `${backendLabel}: ACP transport exited unexpectedly. ${error.message}`;
    case "session_resume_failed":
      return `${backendLabel}: Failed to resume session. ${error.message}`;
    case "stream_protocol_error":
      return `${backendLabel}: ACP protocol error. ${error.message}`;
    default:
      return `${backendLabel}: ${error?.message ?? "ACP request failed."}`;
  }
}

async function runAcpQuery(payload) {
  const profileInfo = acpProfiles(payload);
  const { profile } = profileInfo;
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
        acpBackend: profileInfo.selected,
        costBucket: profile.costBucket,
        elapsedS,
        errorCode: outcome.error.code ?? null,
        errorDetails: outcome.error.details ?? null,
        inputTokens: outcome.usage?.inputTokens ?? null,
        isError: true,
        outputTokens: outcome.usage?.outputTokens ?? null,
        provider: profileInfo.provider,
        providerEnvVars: profileInfo.providerEnvVars,
        providerThreadId: finalLocator?.providerThreadId ?? null,
        rawMessages,
        serverSessionId: finalLocator?.serverSessionId ?? null,
        sessionId: finalLocator?.conversationId ?? payload.resumeSessionId ?? null,
        text: formatAcpError(outcome.error, profileInfo, timeoutS),
        usageRaw: outcome.usage?.raw ?? null,
      };
    }

    const finalLocator = outcome.result.locator ?? locator;
    return {
      acpBackend: profileInfo.selected,
      costBucket: profile.costBucket,
      elapsedS,
      errorCode: null,
      errorDetails: null,
      inputTokens: outcome.usage?.inputTokens ?? null,
      isError: outcome.result.stopReason === "failed" || outcome.result.stopReason === "timed_out",
      outputTokens: outcome.usage?.outputTokens ?? null,
      provider: profileInfo.provider,
      providerEnvVars: profileInfo.providerEnvVars,
      providerThreadId: finalLocator?.providerThreadId ?? null,
      rawMessages,
      serverSessionId: finalLocator?.serverSessionId ?? null,
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

async function main() {
  const [, , payloadPath, outputPath] = process.argv;
  const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
  const result = await runAcpQuery(payload);
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

await main();
