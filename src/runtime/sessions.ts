import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import process from "node:process";

import { emit as emitLogEvent } from "../logging/log.js";
import type { JsonObject } from "./json.js";

export type SessionBackend = "claude-cli" | "codex" | "cursor" | "gemini-cli";

export type SessionQueryResult = {
  elapsedS: number;
  inputTokens?: number | null;
  isError: boolean;
  outputTokens?: number | null;
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
  maxTurns: number;
  projectDir: string;
};

export type SessionOptions = {
  resumeSessionId?: string | null;
  systemPrompt?: string | null;
  timeoutS?: number;
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
  inputTokens?: number;
  outputTokens?: number;
  rawMessages?: unknown[] | null;
  resultText: string;
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

function signalLabel(signal: NodeJS.Signals | null): string | null {
  return signal === null ? null : signal;
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
  #sessionId: string | null;
  #stats = emptyStats();
  #systemPromptSent = false;

  constructor(backend: SessionBackend, model: string, options: SessionOptions = {}) {
    this.backend = backend;
    this.costBucket = ADAPTERS[backend].costBucket;
    this.model = model;
    this.#definition = ADAPTERS[backend];
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

  clone(): Session {
    return new SubprocessSession(this.backend, this.model, {
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
    const finalPrompt =
      this.#systemPrompt !== null && !this.#systemPromptSent
        ? `${this.#systemPrompt}\n\n${prompt}`
        : prompt;
    this.#systemPromptSent = true;

    emitLogEvent("session_query_start", {
      session: this.backend,
      model: this.model,
      prompt: finalPrompt,
      [this.#definition.sessionIdField]: this.#sessionId,
      project_dir: options.projectDir,
    });

    const command = this.#definition.buildCommand({
      maxTurns: options.maxTurns,
      model: this.model,
      projectDir: options.projectDir,
      prompt: finalPrompt,
      sessionId: this.#sessionId,
    });

    const result = spawnCommand(command.command, command.args, {
      cwd: this.backend === "codex" ? undefined : options.projectDir,
      timeoutS: this.#timeoutS,
    });
    const parsed = this.#definition.parseOutput(result);
    if (parsed.sessionId !== undefined && parsed.sessionId !== null) {
      this.#sessionId = parsed.sessionId;
    }

    this.#stats.queries += 1;
    this.#stats.totalInputTokens += parsed.inputTokens ?? 0;
    this.#stats.totalOutputTokens += parsed.outputTokens ?? 0;

    if (result.timedOut) {
      emitLogEvent("session_timeout", {
        session: this.backend,
        timeout_s: this.#timeoutS,
      });
    }

    let isError =
      result.timedOut || result.error !== null || result.exitCode !== 0 || result.signal !== null;
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
      text = classifySessionError(result, this.backend, this.#timeoutS) ?? result.stderr.trim();
    }

    emitLogEvent("session_query_end", {
      session: this.backend,
      model: this.model,
      elapsed_s: result.elapsedS,
      is_error: isError,
      [this.#definition.sessionIdField]: this.#sessionId,
      input_tokens: parsed.inputTokens,
      output_tokens: parsed.outputTokens,
      response_text: text || result.stderr.trim() || result.stdout.trim(),
      returncode: result.exitCode,
      signal: signalLabel(result.signal),
    });

    if (isError) {
      emitLogEvent("session_query_error", {
        session: this.backend,
        model: this.model,
        error: text || result.stderr.trim() || result.stdout.trim(),
      });
    }

    return {
      elapsedS: result.elapsedS,
      inputTokens: parsed.inputTokens ?? null,
      isError,
      outputTokens: parsed.outputTokens ?? null,
      text: text.trim(),
      usageRaw: parsed.usageRaw ?? null,
    };
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

export function createSessionForOrchestrator(
  orchestrator: string,
  model: string,
  options: SessionOptions = {},
): Session | null {
  const backend = backendForOrchestrator(orchestrator);
  return backend === null ? null : new SubprocessSession(backend, model, options);
}
