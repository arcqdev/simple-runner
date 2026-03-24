import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { emit as emitLogEvent, saveConversation } from "../logging/log.js";
import type { JsonObject } from "./json.js";

// Current subprocess adapters are the legacy runtime surface. ACP migration
// work should use src/runtime/acp-contract.ts as the source of truth for
// transport/session semantics and treat the types in this file as the
// compatibility layer that must eventually be implemented on top of ACP.
export type SessionBackend = "claude-cli" | "codex" | "cursor" | "gemini-cli";
export type TeamSessionBackend =
  | "claude"
  | "claude-cli"
  | "codex"
  | "cursor"
  | "gemini-cli"
  | "opencode";

export type SessionQueryResult = {
  acpBackend?: "gemini" | "opencode" | null;
  conversationLog?: string | null;
  costBucket?: string;
  elapsedS: number;
  errorCode?: string | null;
  errorDetails?: JsonObject | null;
  inputTokens?: number | null;
  isError: boolean;
  outputTokens?: number | null;
  provider?: string | null;
  providerEnvVars?: string[] | null;
  providerThreadId?: string | null;
  serverSessionId?: string | null;
  text: string;
  usageRaw?: JsonObject | null;
};

export type SessionStats = {
  queries: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
};

export type SessionQueryOptions = {
  agentName?: string;
  maxTurns: number;
  projectDir: string;
  queryIndex?: number;
};

export type SessionOptions = {
  acpBackend?: "gemini" | "opencode";
  resumeSessionId?: string | null;
  systemPrompt?: string | null;
  timeoutS?: number;
};

export type ParallelSessionRequest = {
  options: SessionQueryOptions;
  prompt: string;
  resumeSessionId?: string | null;
  session: Session;
};

export interface Session {
  readonly backend: SessionBackend;
  readonly costBucket: string;
  readonly model: string;
  readonly sessionId: string | null;
  readonly stats: SessionStats;
  clone(): Session;
  close(): void;
  query(prompt: string, options: SessionQueryOptions): SessionQueryResult;
  reset(): void;
  terminate(): void;
}

type SpawnResult = {
  elapsedS: number;
  error: Error | null;
  exitCode: number;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
};

type ParsedQueryOutput = {
  acpBackend?: "gemini" | "opencode" | null;
  errorCode?: string | null;
  errorDetails?: JsonObject | null;
  inputTokens?: number;
  isError?: boolean;
  outputTokens?: number;
  provider?: string | null;
  providerEnvVars?: string[] | null;
  providerThreadId?: string | null;
  rawMessages?: unknown[] | null;
  resultText: string;
  serverSessionId?: string | null;
  sessionId?: string | null;
  usageRaw?: JsonObject | null;
};

type HelperQueryOutput = SessionQueryResult & {
  rawMessages?: unknown[] | null;
  sessionId?: string | null;
  usageRaw?: JsonObject | null;
};

type AdapterDefinition = {
  buildCommand(args: {
    model: string;
    prompt: string;
    projectDir: string;
    maxTurns: number;
    sessionId: string | null;
  }): { args: string[]; command: string };
  costBucket: string;
  parseOutput(result: SpawnResult): ParsedQueryOutput;
  sessionIdField: "session_id" | "chat_id";
};

const DEFAULT_TIMEOUT_S = 7200;
const MAX_BUFFER_BYTES = 50 * 1024 * 1024;

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

const SUBSCRIPTION_PATTERNS = new RegExp(
  [
    "subscription",
    "billing",
    "payment",
    "quota exceeded",
    "rate.?limit",
    "usage.?limit",
    "plan.?limit",
    "account.?(suspended|disabled|deactivated)",
    "429\\b",
    "too many requests",
    "connection refused",
    "503\\b",
    "service unavailable",
  ].join("|"),
  "i",
);

const BINARY_PATTERNS = new RegExp(
  [
    "command not found",
    "no such file",
    "not found",
    "not installed",
    "permission denied",
    "cannot execute",
    "exec format error",
  ].join("|"),
  "i",
);

function emptyStats(): SessionStats {
  return {
    queries: 0,
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(value: Record<string, unknown> | null, key: string): string | null {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function numberField(value: Record<string, unknown> | null, key: string): number {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
}

function parseJsonLines(text: string): Record<string, unknown>[] {
  return text
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        const record = toRecord(parsed);
        return record === null ? [] : [record];
      } catch {
        return [];
      }
    });
}

function stringifyUnknown(value: unknown): string {
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

function isTimeoutError(error: Error | null): boolean {
  const candidate = error as NodeJS.ErrnoException | null;
  return candidate?.code === "ETIMEDOUT";
}

function buildWorkerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

function spawnCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutS: number },
): SpawnResult {
  const startedAt = Date.now();
  const result: SpawnSyncReturns<string> = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: buildWorkerEnv(),
    killSignal: "SIGKILL",
    maxBuffer: MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutS * 1000,
  });

  return {
    elapsedS: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
    error: result.error ?? null,
    exitCode: typeof result.status === "number" ? result.status : -1,
    signal: result.signal ?? null,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
    timedOut: isTimeoutError(result.error ?? null),
  };
}

function queryHelperPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "query-session-helper.mjs");
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function writeTempJson(dir: string, fileName: string, data: unknown): string {
  const filePath = path.join(dir, fileName);
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return filePath;
}

function runQueryHelper(payload: {
  acpBackend?: "gemini" | "opencode";
  backend: SessionBackend;
  maxTurns: number;
  model: string;
  projectDir: string;
  prompt: string;
  resumeSessionId: string | null;
  systemPrompt?: string | null;
  timeoutS?: number;
}): HelperQueryOutput {
  const startedAt = Date.now();
  const helper = spawnSync(process.execPath, [queryHelperPath(), "/dev/stdin", "/dev/stdout"], {
    encoding: "utf8",
    env: buildWorkerEnv(),
    input: `${JSON.stringify(payload)}\n`,
    killSignal: "SIGKILL",
    maxBuffer: MAX_BUFFER_BYTES,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: (payload.timeoutS ?? DEFAULT_TIMEOUT_S) * 1000 + 5_000,
  });

  const elapsedS = Number(((Date.now() - startedAt) / 1000).toFixed(3));
  if (isTimeoutError(helper.error ?? null)) {
    return {
      elapsedS,
      inputTokens: null,
      isError: true,
      outputTokens: null,
      text: `${payload.backend}: Process timed out after ${payload.timeoutS ?? DEFAULT_TIMEOUT_S}s. Hint: increase session_timeout_s in TeamConfig.`,
      usageRaw: null,
    };
  }

  const stdout = helper.stdout?.trim() ?? "";
  if ((helper.status ?? 0) !== 0 || helper.signal !== null || helper.error !== undefined) {
    return {
      elapsedS,
      inputTokens: null,
      isError: true,
      outputTokens: null,
      text: helper.stderr.trim() || stdout || `${payload.backend}: session helper failed`,
      usageRaw: null,
    };
  }

  try {
    const parsed = JSON.parse(stdout) as HelperQueryOutput;
    return {
      ...parsed,
      elapsedS: parsed.elapsedS ?? elapsedS,
    };
  } catch {
    return {
      elapsedS,
      inputTokens: null,
      isError: true,
      outputTokens: null,
      text:
        helper.stderr.trim() ||
        stdout ||
        `${payload.backend}: session helper returned malformed JSON`,
      usageRaw: null,
    };
  }
}

export function classifySessionError(
  result: Pick<SpawnResult, "error" | "exitCode" | "signal" | "stderr" | "stdout" | "timedOut">,
  backend: string,
  timeoutS: number,
): string | null {
  if (result.timedOut) {
    return `${backend}: Process timed out after ${timeoutS}s. Hint: increase session_timeout_s in TeamConfig.`;
  }

  const combined = `${result.stderr}\n${result.stdout}`;

  if (AUTH_PATTERNS.test(combined)) {
    return `${backend}: Authentication failed — check your API key or login status.`;
  }
  if (SUBSCRIPTION_PATTERNS.test(combined)) {
    return `${backend}: Subscription/billing issue — check your account status.`;
  }
  if (BINARY_PATTERNS.test(combined)) {
    return `${backend}: Binary not working — reinstall or check PATH.`;
  }
  if (result.signal !== null) {
    return `${backend}: Process killed by signal ${result.signal}.`;
  }
  if (result.error !== null) {
    return `${backend}: ${result.error.message}`;
  }
  return null;
}

function parseClaudeCliOutput(result: SpawnResult): ParsedQueryOutput {
  const messages = parseJsonLines(result.stdout);
  let resultText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let sessionId: string | null = null;
  const errorMessages: string[] = [];

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

function parseTextBlocks(content: unknown): string | null {
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

function parseCodexOutput(result: SpawnResult): ParsedQueryOutput {
  const messages = parseJsonLines(result.stdout);
  let resultText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let sessionId: string | null = null;
  const errorMessages: string[] = [];

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

function parseCursorOutput(result: SpawnResult): ParsedQueryOutput {
  const messages = parseJsonLines(result.stdout);
  let resultText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let sessionId: string | null = null;

  for (const message of messages) {
    if (stringField(message, "type") === "result") {
      const raw = message.result;
      resultText = raw == null ? resultText : stringifyUnknown(raw);
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

function parseGeminiOutput(result: SpawnResult): ParsedQueryOutput {
  const trimmed = result.stdout.trim();
  if (trimmed.length === 0) {
    return { resultText: "" };
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const record = toRecord(parsed);
    if (record === null) {
      return { resultText: trimmed };
    }

    const stats = toRecord(record.stats);
    const models = toRecord(stats?.models);
    let inputTokens = 0;
    let outputTokens = 0;

    if (models !== null) {
      for (const modelStats of Object.values(models)) {
        const tokens = toRecord(toRecord(modelStats)?.tokens);
        inputTokens += numberField(tokens, "prompt");
        outputTokens += numberField(tokens, "candidates");
      }
    }

    const response = stringifyUnknown(record.response);
    const error = toRecord(record.error);
    const toolStats = toRecord(stats?.tools);
    const totalCalls = numberField(toolStats, "totalCalls");
    const resultText =
      response.length > 0
        ? response
        : error !== null
          ? (stringField(error, "message") ?? stringifyUnknown(record.error))
          : outputTokens > 0 && totalCalls > 0
            ? `[completed ${totalCalls} tool call(s), no text response]`
            : outputTokens > 0
              ? "[completed, no text response]"
              : "";

    return {
      inputTokens,
      outputTokens,
      rawMessages: [record],
      resultText,
      sessionId: inputTokens + outputTokens > 0 ? "last" : null,
      usageRaw: stats as JsonObject | null,
    };
  } catch {
    return { resultText: trimmed };
  }
}

const ADAPTERS: Record<SessionBackend, AdapterDefinition> = {
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
      return { command: "claude", args };
    },
    costBucket: "claude_subscription",
    parseOutput: parseClaudeCliOutput,
    sessionIdField: "session_id",
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
      return { command: "codex", args };
    },
    costBucket: "codex_subscription",
    parseOutput: parseCodexOutput,
    sessionIdField: "session_id",
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
      return { command: "cursor-agent", args };
    },
    costBucket: "cursor_subscription",
    parseOutput: parseCursorOutput,
    sessionIdField: "chat_id",
  },
  "gemini-cli": {
    buildCommand({ model, prompt, sessionId }) {
      const args = ["-p", prompt, "-y", "--output-format", "json", "-m", model];
      if (sessionId !== null) {
        args.push("--resume");
      }
      return { command: "gemini", args };
    },
    costBucket: "gemini_api",
    parseOutput: parseGeminiOutput,
    sessionIdField: "session_id",
  },
};

class SubprocessSession implements Session {
  readonly backend: SessionBackend;
  readonly costBucket: string;
  readonly model: string;
  readonly #definition: AdapterDefinition;
  readonly #timeoutS: number;
  readonly #systemPrompt: string | null;
  readonly #acpBackend: "gemini" | "opencode" | null;
  #sessionId: string | null;
  #stats = emptyStats();
  #systemPromptSent = false;

  constructor(backend: SessionBackend, model: string, options: SessionOptions = {}) {
    this.backend = backend;
    this.costBucket = ADAPTERS[backend].costBucket;
    this.model = model;
    this.#definition = ADAPTERS[backend];
    this.#acpBackend = options.acpBackend ?? null;
    this.#sessionId = options.resumeSessionId ?? null;
    this.#systemPrompt = options.systemPrompt ?? null;
    this.#timeoutS = options.timeoutS ?? DEFAULT_TIMEOUT_S;
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  get stats(): SessionStats {
    return { ...this.#stats };
  }

  helperPayload(
    prompt: string,
    options: SessionQueryOptions,
    resumeSessionIdOverride?: string | null,
  ): {
    acpBackend?: "gemini" | "opencode";
    backend: SessionBackend;
    maxTurns: number;
    model: string;
    projectDir: string;
    prompt: string;
    resumeSessionId: string | null;
    systemPrompt?: string | null;
    timeoutS?: number;
  } {
    const finalPrompt =
      this.#systemPrompt !== null && !this.#systemPromptSent
        ? `${this.#systemPrompt}\n\n${prompt}`
        : prompt;
    this.#systemPromptSent = true;

    return {
      acpBackend: this.#acpBackend ?? undefined,
      backend: this.backend,
      maxTurns: options.maxTurns,
      model: this.model,
      projectDir: options.projectDir,
      prompt: finalPrompt,
      resumeSessionId: resumeSessionIdOverride ?? this.#sessionId,
      systemPrompt: null,
      timeoutS: this.#timeoutS,
    };
  }

  applyQueryResult(
    helperResult: HelperQueryOutput,
    options: SessionQueryOptions,
  ): SessionQueryResult {
    if (helperResult.text.includes("timed out")) {
      emitLogEvent("session_timeout", {
        session: this.backend,
        timeout_s: this.#timeoutS,
      });
    }

    if (helperResult.sessionId !== undefined && helperResult.sessionId !== null) {
      this.#sessionId = helperResult.sessionId;
    }

    this.#stats.queries += 1;
    this.#stats.totalInputTokens += helperResult.inputTokens ?? 0;
    this.#stats.totalOutputTokens += helperResult.outputTokens ?? 0;

    const conversationLog =
      Array.isArray(helperResult.rawMessages) &&
      helperResult.rawMessages.length > 0 &&
      typeof options.agentName === "string" &&
      typeof options.queryIndex === "number"
        ? saveConversation(options.agentName, options.queryIndex, helperResult.rawMessages)
        : null;

    emitLogEvent("session_query_end", {
      agent: options.agentName,
      acp_backend: helperResult.acpBackend ?? this.#acpBackend,
      conversation_log: conversationLog,
      cost_bucket: this.costBucket,
      elapsed_s: helperResult.elapsedS,
      error_code: helperResult.errorCode ?? null,
      error_details: helperResult.errorDetails ?? null,
      is_error: helperResult.isError,
      model: this.model,
      provider: helperResult.provider ?? null,
      provider_env_vars: helperResult.providerEnvVars ?? null,
      provider_thread_id: helperResult.providerThreadId ?? null,
      [this.#definition.sessionIdField]: this.#sessionId,
      server_session_id: helperResult.serverSessionId ?? null,
      session: this.backend,
      input_tokens: helperResult.inputTokens,
      output_tokens: helperResult.outputTokens,
      response_text: helperResult.text,
      returncode: helperResult.isError ? 1 : 0,
      signal: null,
      usage_raw: helperResult.usageRaw ?? null,
    });

    if (helperResult.isError) {
      emitLogEvent("session_query_error", {
        acp_backend: helperResult.acpBackend ?? this.#acpBackend,
        error_code: helperResult.errorCode ?? null,
        error_details: helperResult.errorDetails ?? null,
        model: this.model,
        error: helperResult.text,
        provider: helperResult.provider ?? null,
        provider_env_vars: helperResult.providerEnvVars ?? null,
        session: this.backend,
      });
    }

    return {
      acpBackend: helperResult.acpBackend ?? this.#acpBackend,
      conversationLog,
      costBucket: this.costBucket,
      elapsedS: helperResult.elapsedS,
      errorCode: helperResult.errorCode ?? null,
      errorDetails: helperResult.errorDetails ?? null,
      inputTokens: helperResult.inputTokens ?? null,
      isError: helperResult.isError,
      outputTokens: helperResult.outputTokens ?? null,
      provider: helperResult.provider ?? null,
      providerEnvVars: helperResult.providerEnvVars ?? null,
      providerThreadId: helperResult.providerThreadId ?? null,
      serverSessionId: helperResult.serverSessionId ?? null,
      text: helperResult.text.trim(),
      usageRaw: helperResult.usageRaw ?? null,
    };
  }

  clone(): Session {
    return new SubprocessSession(this.backend, this.model, {
      acpBackend: this.#acpBackend ?? undefined,
      systemPrompt: this.#systemPrompt,
      timeoutS: this.#timeoutS,
    });
  }

  terminate(): void {}

  close(): void {}

  reset(): void {
    emitLogEvent("session_reset", {
      session: this.backend,
      model: this.model,
      [this.#definition.sessionIdField]: this.#sessionId,
      queries_before: this.#stats.queries,
    });
    this.#sessionId = null;
    this.#systemPromptSent = false;
    this.#stats = emptyStats();
  }

  query(prompt: string, options: SessionQueryOptions): SessionQueryResult {
    const helperPayload = this.helperPayload(prompt, options);

    emitLogEvent("session_query_start", {
      agent: options.agentName,
      session: this.backend,
      model: this.model,
      prompt: helperPayload.prompt,
      [this.#definition.sessionIdField]: this.#sessionId,
      project_dir: options.projectDir,
    });

    const helperResult =
      this.backend === "gemini-cli"
        ? runQueryHelper({
            ...helperPayload,
            prompt,
            systemPrompt: this.#systemPrompt,
          })
        : (() => {
            const command = this.#definition.buildCommand({
              maxTurns: helperPayload.maxTurns,
              model: helperPayload.model,
              projectDir: helperPayload.projectDir,
              prompt: helperPayload.prompt,
              sessionId: this.#sessionId,
            });

            const result = spawnCommand(command.command, command.args, {
              cwd: this.backend === "codex" ? undefined : options.projectDir,
              timeoutS: this.#timeoutS,
            });
            const parsed = this.#definition.parseOutput(result);
            let isError =
              result.timedOut ||
              result.error !== null ||
              result.exitCode !== 0 ||
              result.signal !== null ||
              parsed.isError === true;
            let text = parsed.resultText;

            if (!isError && text.length === 0 && result.stderr.trim().length > 0) {
              text = result.stderr.trim();
            }

            if (isError && text.length === 0) {
              text =
                classifySessionError(result, this.backend, this.#timeoutS) ??
                result.stderr.trim() ??
                result.stdout.trim();
            }

            if (
              !isError &&
              this.backend === "codex" &&
              text.length === 0 &&
              result.stderr.trim().length > 0
            ) {
              isError = true;
              text =
                classifySessionError(result, this.backend, this.#timeoutS) ?? result.stderr.trim();
            }

            if (result.timedOut) {
              emitLogEvent("session_timeout", {
                session: this.backend,
                timeout_s: this.#timeoutS,
              });
            }

            return {
              elapsedS: result.elapsedS,
              inputTokens: parsed.inputTokens ?? null,
              isError,
              outputTokens: parsed.outputTokens ?? null,
              rawMessages: parsed.rawMessages ?? null,
              sessionId: parsed.sessionId ?? this.#sessionId,
              text,
              usageRaw: parsed.usageRaw ?? null,
            } satisfies HelperQueryOutput;
          })();

    return this.applyQueryResult(helperResult, options);
  }

  queryWithResumeOverride(
    prompt: string,
    options: SessionQueryOptions,
    resumeSessionIdOverride?: string | null,
  ): SessionQueryResult {
    if (resumeSessionIdOverride !== undefined) {
      this.#sessionId = resumeSessionIdOverride;
    }
    return this.query(prompt, options);
  }
}

export function querySessionsInParallel(requests: ParallelSessionRequest[]): SessionQueryResult[] {
  if (requests.length === 0) {
    return [];
  }

  if (!requests.every((request) => request.session instanceof SubprocessSession)) {
    return requests.map((request) => request.session.query(request.prompt, request.options));
  }

  if (
    requests.some(
      (request) =>
        request.session instanceof SubprocessSession && request.session.backend === "gemini-cli",
    )
  ) {
    return requests.map((request) =>
      (request.session as SubprocessSession).queryWithResumeOverride(
        request.prompt,
        request.options,
        request.resumeSessionId,
      ),
    );
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "kodo-parallel-"));
  try {
    const helperRequests = requests.map((request) => {
      const session = request.session as SubprocessSession;
      const payload = session.helperPayload(
        request.prompt,
        request.options,
        request.resumeSessionId,
      );
      return { payload, request, session };
    });

    for (const { payload, request, session } of helperRequests) {
      emitLogEvent("session_query_start", {
        agent: request.options.agentName,
        session: session.backend,
        model: session.model,
        prompt: payload.prompt,
        [ADAPTERS[session.backend].sessionIdField]: payload.resumeSessionId,
        project_dir: request.options.projectDir,
      });
    }

    const outputPaths = helperRequests.map(({ payload }, index) => {
      const payloadPath = writeTempJson(tempDir, `payload-${index}.json`, payload);
      const outputPath = path.join(tempDir, `result-${index}.json`);
      return { outputPath, payloadPath };
    });

    const helperPath = queryHelperPath();
    const command = outputPaths
      .map(
        ({ payloadPath, outputPath }) =>
          `${shellEscape(process.execPath)} ${shellEscape(helperPath)} ${shellEscape(payloadPath)} ${shellEscape(outputPath)}`,
      )
      .map((entry) => `(${entry}) &`)
      .join("\n")
      .concat("\nwait\n");

    const result = spawnSync(process.env.SHELL || "/bin/sh", ["-lc", command], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if ((result.status ?? 1) !== 0) {
      throw new Error((result.stderr || result.stdout || "parallel helper failed").trim());
    }

    return helperRequests.map(({ request, session }, index) => {
      const helperResult = JSON.parse(
        readFileSync(outputPaths[index]!.outputPath, "utf8"),
      ) as HelperQueryOutput;
      return session.applyQueryResult(helperResult, request.options);
    });
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

export function backendForOrchestrator(orchestrator: string): SessionBackend | null {
  switch (orchestrator) {
    case "claude-code":
      return "claude-cli";
    case "codex":
      return "codex";
    case "cursor":
      return "cursor";
    case "gemini-cli":
      return "gemini-cli";
    default:
      return null;
  }
}

export function backendForTeamAgent(backend: TeamSessionBackend): SessionBackend | null {
  switch (backend) {
    case "claude":
    case "claude-cli":
      return "claude-cli";
    case "codex":
      return "codex";
    case "cursor":
      return "cursor";
    case "gemini-cli":
    case "opencode":
      return "gemini-cli";
    default:
      return null;
  }
}

export function createSessionForOrchestrator(
  orchestrator: string,
  model: string,
  options: SessionOptions = {},
): Session | null {
  const backend = backendForOrchestrator(orchestrator);
  return backend === null ? null : new SubprocessSession(backend, model, options);
}

export function createSessionForTeamAgent(
  backend: TeamSessionBackend,
  model: string,
  options: SessionOptions = {},
): Session | null {
  const sessionBackend = backendForTeamAgent(backend);
  return sessionBackend === null
    ? null
    : new SubprocessSession(sessionBackend, model, {
        ...options,
        acpBackend: backend === "opencode" ? "opencode" : options.acpBackend,
      });
}
