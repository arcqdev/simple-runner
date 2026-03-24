import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";
import os from "node:os";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { emit as emitLogEvent, saveConversation } from "../logging/log.js";
import type { JsonObject } from "./json.js";

export type SessionBackend = "gemini-cli" | "opencode";
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

type HelperQueryOutput = SessionQueryResult & {
  rawMessages?: unknown[] | null;
  sessionId?: string | null;
  usageRaw?: JsonObject | null;
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

function buildWorkerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return env;
}

function isTimeoutError(error: Error | null): boolean {
  const candidate = error as NodeJS.ErrnoException | null;
  return candidate?.code === "ETIMEDOUT";
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
  result: {
    error: Error | null;
    exitCode: number;
    signal: NodeJS.Signals | null;
    stderr: string;
    stdout: string;
    timedOut: boolean;
  },
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

class AcpSession implements Session {
  readonly backend: SessionBackend;
  readonly costBucket: string;
  readonly model: string;
  readonly #acpBackend: "gemini" | "opencode";
  readonly #systemPrompt: string | null;
  readonly #timeoutS: number;
  #sessionId: string | null;
  #stats = emptyStats();
  #systemPromptSent = false;

  constructor(backend: SessionBackend, model: string, options: SessionOptions = {}) {
    this.backend = backend;
    this.costBucket = backend === "opencode" ? "gemini_api" : "gemini_api";
    this.model = model;
    this.#acpBackend = options.acpBackend ?? (backend === "opencode" ? "opencode" : "gemini");
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
    acpBackend: "gemini" | "opencode";
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
      acpBackend: this.#acpBackend,
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

  applyQueryResult(helperResult: HelperQueryOutput, options: SessionQueryOptions): SessionQueryResult {
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
      session_id: this.#sessionId,
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
    return new AcpSession(this.backend, this.model, {
      acpBackend: this.#acpBackend,
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
      session_id: this.#sessionId,
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
      session_id: this.#sessionId,
      project_dir: options.projectDir,
    });

    const helperResult = runQueryHelper({
      ...helperPayload,
      prompt,
      systemPrompt: this.#systemPrompt,
    });

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

  if (!requests.every((request) => request.session instanceof AcpSession)) {
    return requests.map((request) => request.session.query(request.prompt, request.options));
  }

  const tempDir = mkdtempSync(path.join(os.tmpdir(), "kodo-parallel-"));
  try {
    const helperRequests = requests.map((request) => {
      const session = request.session as AcpSession;
      const payload = session.helperPayload(request.prompt, request.options, request.resumeSessionId);
      return { payload, request, session };
    });

    for (const { payload, request, session } of helperRequests) {
      emitLogEvent("session_query_start", {
        agent: request.options.agentName,
        session: session.backend,
        model: session.model,
        prompt: payload.prompt,
        session_id: payload.resumeSessionId,
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
    case "gemini-cli":
      return "gemini-cli";
    case "opencode":
      return "opencode";
    default:
      return null;
  }
}

export function backendForTeamAgent(backend: TeamSessionBackend): SessionBackend | null {
  switch (backend) {
    case "gemini-cli":
      return "gemini-cli";
    case "opencode":
      return "opencode";
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
  return backend === null ? null : new AcpSession(backend, model, options);
}

export function createSessionForTeamAgent(
  backend: TeamSessionBackend,
  model: string,
  options: SessionOptions = {},
): Session | null {
  const sessionBackend = backendForTeamAgent(backend);
  return sessionBackend === null
    ? null
    : new AcpSession(sessionBackend, model, {
        ...options,
        acpBackend: backend === "opencode" ? "opencode" : options.acpBackend,
      });
}
