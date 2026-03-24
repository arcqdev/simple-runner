import {
  type AcpBackendKind,
  type AcpConversationLocator,
  type AcpNormalizedEvent,
  type AcpQueryOutcome,
  type AcpRuntimeError,
  type AcpRuntimeErrorCode,
  type AcpStreamEvent,
  type AcpTerminalResult,
  type AcpTerminalStopReason,
  type AcpUsage,
} from "./acp-contract.js";
import type { JsonObject, JsonValue } from "./json.js";
import { toJsonObject } from "./json.js";
import type { AcpTransportEnvelope, StdioAcpTransport } from "./acp-transport.js";

type AcpNormalizerResult =
  | {
      ok: true;
      value: AcpNormalizedEvent;
    }
  | {
      ok: false;
      error: AcpRuntimeError;
      raw?: JsonObject | null;
    };

type EventMapper = (params: JsonObject, raw: JsonObject) => AcpNormalizerResult;

const EVENT_TIMEOUT_MS = 30_000;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): JsonObject | null {
  return isJsonObject(value) ? value : null;
}

function stringField(value: JsonObject | null, key: string): string | null {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function booleanField(value: JsonObject | null, key: string): boolean | null {
  const candidate = value?.[key];
  return typeof candidate === "boolean" ? candidate : null;
}

function numberField(value: JsonObject | null, key: string): number | null {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
}

function jsonObjectField(value: JsonObject | null, key: string): JsonObject | null {
  return asObject(value?.[key]);
}

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

function parseLocator(value: JsonObject | null): AcpConversationLocator | null {
  if (value === null) {
    return null;
  }
  const conversationId =
    stringField(value, "conversationId") ??
    stringField(value, "conversation_id") ??
    stringField(value, "id");
  if (conversationId === null) {
    return null;
  }
  return {
    conversationId,
    providerThreadId:
      stringField(value, "providerThreadId") ?? stringField(value, "provider_thread_id") ?? null,
    serverSessionId:
      stringField(value, "serverSessionId") ?? stringField(value, "server_session_id") ?? null,
  };
}

function parseUsage(value: JsonObject | null): AcpUsage | null {
  if (value === null) {
    return null;
  }

  const inputTokens =
    numberField(value, "inputTokens") ??
    numberField(value, "input_tokens") ??
    numberField(value, "prompt") ??
    numberField(value, "prompt_tokens");
  const outputTokens =
    numberField(value, "outputTokens") ??
    numberField(value, "output_tokens") ??
    numberField(value, "completion_tokens") ??
    numberField(value, "candidates");
  const totalTokens =
    numberField(value, "totalTokens") ??
    numberField(value, "total_tokens") ??
    (inputTokens ?? 0) + (outputTokens ?? 0);
  const costUsd = numberField(value, "costUsd") ?? numberField(value, "cost_usd");

  return {
    costUsd,
    inputTokens,
    outputTokens,
    raw: value,
    totalTokens,
  };
}

function parseStopReason(value: string | null): AcpTerminalStopReason {
  switch (value) {
    case "completed":
    case "cancelled":
    case "failed":
    case "timed_out":
    case "interrupted":
      return value;
    case "timeout":
      return "timed_out";
    case "error":
      return "failed";
    default:
      return "completed";
  }
}

function parseRuntimeError(value: JsonObject | null): AcpRuntimeError {
  if (value === null) {
    return runtimeError("stream_protocol_error", "ACP error payload was missing.");
  }

  const code = stringField(value, "code");
  const stableCode = (
    [
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
    ] as const
  ).includes(code as AcpRuntimeErrorCode)
    ? (code as AcpRuntimeErrorCode)
    : "prompt_failed";

  return {
    code: stableCode,
    details: value,
    message: stringField(value, "message") ?? "ACP request failed.",
    retryable: booleanField(value, "retryable") ?? false,
    statusCode: numberField(value, "statusCode") ?? numberField(value, "status_code") ?? undefined,
  };
}

function parseTerminalResult(value: JsonObject | null): AcpTerminalResult | null {
  if (value === null) {
    return null;
  }

  const locator = parseLocator(jsonObjectField(value, "locator") ?? value);
  if (locator === null) {
    return null;
  }

  return {
    locator,
    raw: value,
    stopReason: parseStopReason(
      stringField(value, "stopReason") ?? stringField(value, "stop_reason") ?? stringField(value, "status"),
    ),
    text:
      stringField(value, "text") ??
      stringField(value, "output") ??
      stringField(jsonObjectField(value, "message"), "text") ??
      "",
    usage: parseUsage(jsonObjectField(value, "usage")),
  };
}

function event(event: AcpStreamEvent, raw: JsonObject): AcpNormalizerResult {
  return {
    ok: true,
    value: {
      event,
      raw,
    },
  };
}

function invalidPayload(raw: JsonObject, message: string): AcpNormalizerResult {
  return {
    error: runtimeError("stream_protocol_error", message, {
      details: raw,
      retryable: false,
    }),
    ok: false,
    raw,
  };
}

function requireLocator(raw: JsonObject, params: JsonObject | null): AcpConversationLocator | null {
  return parseLocator(jsonObjectField(params, "locator") ?? params);
}

function requireToolName(params: JsonObject | null): string | null {
  return (
    stringField(params, "toolName") ??
    stringField(params, "tool_name") ??
    stringField(params, "name") ??
    stringField(jsonObjectField(params, "tool"), "name")
  );
}

function geminiSessionCreated(params: JsonObject, raw: JsonObject): AcpNormalizerResult {
  const locator = requireLocator(raw, params);
  const model = stringField(params, "model");
  const backend = stringField(params, "backend");
  if (locator === null || model === null || (backend !== "gemini" && backend !== "opencode")) {
    return invalidPayload(raw, "Gemini session.created payload was malformed.");
  }
  return event({ backend, locator, model, type: "session.created" }, raw);
}

function geminiSessionResumed(params: JsonObject, raw: JsonObject): AcpNormalizerResult {
  const locator = requireLocator(raw, params);
  const model = stringField(params, "model");
  const backend = stringField(params, "backend");
  if (locator === null || model === null || (backend !== "gemini" && backend !== "opencode")) {
    return invalidPayload(raw, "Gemini session.resumed payload was malformed.");
  }
  return event({ backend, locator, model, type: "session.resumed" }, raw);
}

function geminiMessageDelta(params: JsonObject, raw: JsonObject): AcpNormalizerResult {
  const delta = stringField(params, "delta");
  return delta === null ? invalidPayload(raw, "Gemini message.delta payload was malformed.") : event({ delta, type: "message.delta" }, raw);
}

function geminiMessageCompleted(params: JsonObject, raw: JsonObject): AcpNormalizerResult {
  const text = stringField(params, "text");
  return text === null ? invalidPayload(raw, "Gemini message.completed payload was malformed.") : event({ text, type: "message.completed" }, raw);
}

function geminiToolCall(params: JsonObject, raw: JsonObject): AcpNormalizerResult {
  const toolName = requireToolName(params);
  if (toolName === null) {
    return invalidPayload(raw, "Gemini tool.call payload was malformed.");
  }
  return event({ input: jsonObjectField(params, "input"), toolName, type: "tool.call" }, raw);
}

function geminiToolResult(params: JsonObject, raw: JsonObject): AcpNormalizerResult {
  const toolName = requireToolName(params);
  if (toolName === null) {
    return invalidPayload(raw, "Gemini tool.result payload was malformed.");
  }
  return event(
    {
      isError: booleanField(params, "isError") ?? booleanField(params, "is_error") ?? false,
      output: jsonObjectField(params, "output"),
      toolName,
      type: "tool.result",
    },
    raw,
  );
}

function geminiUsage(params: JsonObject, raw: JsonObject): AcpNormalizerResult {
  const usage = parseUsage(jsonObjectField(params, "usage") ?? params);
  return usage === null ? invalidPayload(raw, "Gemini usage payload was malformed.") : event({ type: "usage", usage }, raw);
}

function geminiWarning(params: JsonObject, raw: JsonObject): AcpNormalizerResult {
  const message = stringField(params, "message");
  return message === null
    ? invalidPayload(raw, "Gemini warning payload was malformed.")
    : event(
        {
          code: stringField(params, "code") ?? undefined,
          message,
          retryable: booleanField(params, "retryable") ?? undefined,
          type: "warning",
        },
        raw,
      );
}

function geminiError(params: JsonObject, raw: JsonObject): AcpNormalizerResult {
  return event({ error: parseRuntimeError(jsonObjectField(params, "error") ?? params), type: "error" }, raw);
}

function geminiResult(params: JsonObject, raw: JsonObject): AcpNormalizerResult {
  const result = parseTerminalResult(jsonObjectField(params, "result") ?? params);
  return result === null ? invalidPayload(raw, "Gemini result payload was malformed.") : event({ result, type: "result" }, raw);
}

function opencodeSessionCreated(params: JsonObject, raw: JsonObject): AcpNormalizerResult {
  const thread = jsonObjectField(params, "thread") ?? params;
  const locator = parseLocator(thread);
  const model = stringField(params, "model");
  if (locator === null || model === null) {
    return invalidPayload(raw, "OpenCode thread.created payload was malformed.");
  }
  return event({ backend: "opencode", locator, model, type: "session.created" }, raw);
}

function opencodeSessionResumed(params: JsonObject, raw: JsonObject): AcpNormalizerResult {
  const thread = jsonObjectField(params, "thread") ?? params;
  const locator = parseLocator(thread);
  const model = stringField(params, "model");
  if (locator === null || model === null) {
    return invalidPayload(raw, "OpenCode thread.resumed payload was malformed.");
  }
  return event({ backend: "opencode", locator, model, type: "session.resumed" }, raw);
}

function opencodeMessageDelta(params: JsonObject, raw: JsonObject): AcpNormalizerResult {
  const delta = stringField(params, "textDelta") ?? stringField(params, "delta");
  return delta === null ? invalidPayload(raw, "OpenCode assistant.delta payload was malformed.") : event({ delta, type: "message.delta" }, raw);
}

function opencodeMessageCompleted(params: JsonObject, raw: JsonObject): AcpNormalizerResult {
  const text = stringField(params, "text") ?? stringField(jsonObjectField(params, "message"), "text");
  return text === null
    ? invalidPayload(raw, "OpenCode assistant.completed payload was malformed.")
    : event({ text, type: "message.completed" }, raw);
}

function opencodeToolCall(params: JsonObject, raw: JsonObject): AcpNormalizerResult {
  const toolName = requireToolName(params);
  if (toolName === null) {
    return invalidPayload(raw, "OpenCode tool.started payload was malformed.");
  }
  return event(
    {
      input: jsonObjectField(jsonObjectField(params, "tool"), "input") ?? jsonObjectField(params, "input"),
      toolName,
      type: "tool.call",
    },
    raw,
  );
}

function opencodeToolResult(params: JsonObject, raw: JsonObject): AcpNormalizerResult {
  const toolName = requireToolName(params);
  if (toolName === null) {
    return invalidPayload(raw, "OpenCode tool.finished payload was malformed.");
  }
  return event(
    {
      isError:
        booleanField(params, "isError") ??
        booleanField(params, "is_error") ??
        stringField(params, "status") === "error",
      output:
        jsonObjectField(params, "result") ??
        jsonObjectField(jsonObjectField(params, "tool"), "output") ??
        jsonObjectField(params, "output"),
      toolName,
      type: "tool.result",
    },
    raw,
  );
}

function opencodeUsage(params: JsonObject, raw: JsonObject): AcpNormalizerResult {
  const usage = parseUsage(params);
  return usage === null ? invalidPayload(raw, "OpenCode token_count payload was malformed.") : event({ type: "usage", usage }, raw);
}

function opencodeWarning(params: JsonObject, raw: JsonObject): AcpNormalizerResult {
  return geminiWarning(jsonObjectField(params, "warning") ?? params, raw);
}

function opencodeFailure(params: JsonObject, raw: JsonObject): AcpNormalizerResult {
  return event({ error: parseRuntimeError(jsonObjectField(params, "error") ?? params), type: "error" }, raw);
}

function opencodeResult(params: JsonObject, raw: JsonObject): AcpNormalizerResult {
  const thread = jsonObjectField(params, "thread") ?? null;
  const locator = parseLocator(thread);
  if (locator === null) {
    return invalidPayload(raw, "OpenCode run.completed payload was malformed.");
  }

  return event(
    {
      result: {
        locator,
        raw: params,
        stopReason: parseStopReason(stringField(params, "stopReason") ?? stringField(params, "status")),
        text:
          stringField(params, "output") ??
          stringField(params, "text") ??
          stringField(jsonObjectField(params, "message"), "text") ??
          "",
        usage: parseUsage(jsonObjectField(params, "usage") ?? params),
      },
      type: "result",
    },
    raw,
  );
}

const GEMINI_EVENT_MAP: Record<string, EventMapper> = {
  "error": geminiError,
  "message.completed": geminiMessageCompleted,
  "message.delta": geminiMessageDelta,
  "result": geminiResult,
  "session.created": geminiSessionCreated,
  "session.resumed": geminiSessionResumed,
  "tool.call": geminiToolCall,
  "tool.result": geminiToolResult,
  "usage": geminiUsage,
  "warning": geminiWarning,
};

const OPENCODE_EVENT_MAP: Record<string, EventMapper> = {
  "assistant.completed": opencodeMessageCompleted,
  "assistant.delta": opencodeMessageDelta,
  "run.completed": opencodeResult,
  "run.failed": opencodeFailure,
  "thread.created": opencodeSessionCreated,
  "thread.resumed": opencodeSessionResumed,
  "token_count": opencodeUsage,
  "tool.finished": opencodeToolResult,
  "tool.started": opencodeToolCall,
  "warning": opencodeWarning,
};

const NORMALIZERS: Record<AcpBackendKind, Record<string, EventMapper>> = {
  gemini: GEMINI_EVENT_MAP,
  opencode: OPENCODE_EVENT_MAP,
};

export function normalizeAcpEvent(
  backend: AcpBackendKind,
  raw: JsonObject,
): AcpNormalizerResult {
  const method = stringField(raw, "method");
  const params = jsonObjectField(raw, "params");
  if (method === null || params === null) {
    return invalidPayload(raw, "ACP notification envelope was malformed.");
  }

  const mapper = NORMALIZERS[backend][method];
  if (mapper === undefined) {
    return invalidPayload(raw, `Unsupported ACP event '${method}' for backend '${backend}'.`);
  }

  return mapper(params, raw);
}

export async function collectAcpQueryOutcome(options: {
  backend: AcpBackendKind;
  eventTimeoutMs?: number;
  transport: StdioAcpTransport;
}): Promise<AcpQueryOutcome> {
  const events: AcpNormalizedEvent[] = [];
  let lastUsage: AcpUsage | null = null;
  let locator: AcpConversationLocator | undefined;

  while (true) {
    let envelope: AcpTransportEnvelope | null;
    try {
      envelope = await options.transport.nextEnvelope({
        timeoutMs: options.eventTimeoutMs ?? EVENT_TIMEOUT_MS,
      });
    } catch (error) {
      const timeoutError = error as AcpRuntimeError;
      return {
        error: timeoutError,
        events,
        locator,
        ok: false,
        usage: lastUsage,
      };
    }

    if (envelope === null) {
      return {
        error: runtimeError("stream_protocol_error", "ACP stream ended before a terminal result arrived."),
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

    const normalized = normalizeAcpEvent(options.backend, envelope.message);
    if (!normalized.ok) {
      if (normalized.raw !== undefined) {
        events.push({
          event: { error: normalized.error, type: "error" },
          raw: normalized.raw,
        });
      }
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

export function rawEnvelope(method: string, params: Record<string, JsonValue>): JsonObject {
  return {
    jsonrpc: "2.0",
    method,
    params: toJsonObject(params),
  };
}
