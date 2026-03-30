import { spawnSync } from "node:child_process";
import process from "node:process";

import { listOllamaModels } from "../config/models.js";
import { emit as emitLogEvent } from "../logging/log.js";

const GEMINI_SUMMARIZER_MODEL = "gemini-2.5-flash-lite";
const OLLAMA_GENERATE_URL = "http://localhost:11434/api/generate";
const REQUEST_TIMEOUT_MS = 30_000;

type SummarizerBackend =
  | { kind: "gemini"; param: string }
  | { kind: "ollama"; param: string }
  | { kind: "truncate"; param: null };

type SummaryJob = {
  agentName: string;
  report: string;
  task: string;
};

type JsonRequest = {
  body?: string;
  headers?: Record<string, string>;
  method: string;
  timeoutMs?: number;
  url: string;
};

type JsonResponse = {
  ok: boolean;
  status: number;
  text: string;
};

type SummarizerDeps = {
  env?: NodeJS.ProcessEnv;
  listLocalModels?: (env: NodeJS.ProcessEnv) => string[];
  requestJson?: (request: JsonRequest, env: NodeJS.ProcessEnv) => JsonResponse;
};

function safeEmit(event: string, fields: Record<string, unknown>): void {
  try {
    emitLogEvent(event, fields);
  } catch {
    // Unit tests may exercise the summarizer without an initialized run log.
  }
}

function summarizerPrompt(task: string, report: string): string {
  return [
    "Summarize in 1 sentence what was accomplished. Be specific (mention file names, features, decisions). No preamble.",
    "",
    `Task: ${task.slice(0, 200)}`,
    `Result: ${report.slice(0, 2000)}`,
  ].join("\n");
}

function defaultRequestJson(request: JsonRequest, env: NodeJS.ProcessEnv): JsonResponse {
  const script = `
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    try {
      const response = await fetch(payload.url, {
        method: payload.method,
        headers: payload.headers,
        body: payload.body,
        signal: AbortSignal.timeout(payload.timeoutMs ?? ${REQUEST_TIMEOUT_MS}),
      });
      const text = await response.text();
      process.stdout.write(JSON.stringify({ ok: response.ok, status: response.status, text }));
    } catch (error) {
      process.stderr.write(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exit(1);
    }
  `;

  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    env: { ...env },
    input: JSON.stringify(request),
    timeout: request.timeoutMs ?? REQUEST_TIMEOUT_MS,
  });

  if (child.status !== 0) {
    throw new Error((child.stderr || child.stdout || "request failed").trim());
  }

  try {
    return JSON.parse(child.stdout.trim()) as JsonResponse;
  } catch (error) {
    throw new Error(
      `Invalid summarizer response JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function probeGeminiApiKey(env: NodeJS.ProcessEnv): string | null {
  const geminiKey = env.GEMINI_API_KEY?.trim();
  if (geminiKey) {
    return geminiKey;
  }
  const googleKey = env.GOOGLE_API_KEY?.trim();
  return googleKey && googleKey.length > 0 ? googleKey : null;
}

function overrideBackend(env: NodeJS.ProcessEnv): SummarizerBackend | null {
  const raw = env.SIMPLE_RUNNER_SUMMARIZER_BACKEND?.trim();
  if (!raw) {
    return null;
  }
  if (raw === "truncate") {
    return { kind: "truncate", param: null };
  }
  if (raw.startsWith("ollama:") && raw.length > "ollama:".length) {
    return { kind: "ollama", param: raw.slice("ollama:".length) };
  }
  if (raw === "gemini") {
    const geminiKey = probeGeminiApiKey(env);
    return geminiKey === null
      ? { kind: "truncate", param: null }
      : { kind: "gemini", param: geminiKey };
  }
  return null;
}

function isExpectedSummarizerError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error instanceof SyntaxError || error.name === "AbortError" || error.name === "TypeError")
  );
}

export function summarizeByTruncation(report: string): string {
  for (const rawLine of report.split(/\r?\n/gu)) {
    const line = rawLine.trim();
    if (line.length > 0) {
      return line.slice(0, 120);
    }
  }
  return "";
}

export class AsyncSummarizer {
  private backend: SummarizerBackend | null = null;
  private readonly deps: Required<SummarizerDeps>;
  private closed = false;
  private readonly queue: SummaryJob[] = [];
  private readonly summaries: string[] = [];

  constructor(deps: SummarizerDeps = {}) {
    this.deps = {
      env: deps.env ?? process.env,
      listLocalModels: deps.listLocalModels ?? listOllamaModels,
      requestJson: deps.requestJson ?? defaultRequestJson,
    };
  }

  getBackendForTests(): SummarizerBackend {
    return this.ensureBackend();
  }

  summarize(agentName: string, task: string, report: string): void {
    if (this.closed) {
      return;
    }
    this.queue.push({
      agentName,
      report: report || "",
      task: task || "",
    });
  }

  getAccumulatedSummary(): string {
    this.drain();
    return this.summaries.join("\n");
  }

  clear(): void {
    this.summaries.length = 0;
  }

  shutdown(wait = true): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (wait) {
      this.drain();
      return;
    }
    this.queue.length = 0;
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.runJob(job);
    }
  }

  private ensureBackend(): SummarizerBackend {
    if (this.backend !== null) {
      return this.backend;
    }

    const overridden = overrideBackend(this.deps.env);
    if (overridden !== null) {
      this.backend = overridden;
      safeEmit("summarizer_backend", {
        backend: overridden.kind,
        ...(overridden.param === null ? {} : { model: overridden.param }),
      });
      return this.backend;
    }

    const ollamaModel = this.deps.listLocalModels(this.deps.env)[0];
    if (typeof ollamaModel === "string" && ollamaModel.length > 0) {
      this.backend = { kind: "ollama", param: ollamaModel };
      safeEmit("summarizer_backend", {
        backend: "ollama",
        model: ollamaModel,
      });
      return this.backend;
    }

    const geminiKey = probeGeminiApiKey(this.deps.env);
    if (geminiKey !== null) {
      this.backend = { kind: "gemini", param: geminiKey };
      safeEmit("summarizer_backend", {
        backend: "gemini",
        model: GEMINI_SUMMARIZER_MODEL,
      });
      return this.backend;
    }

    this.backend = { kind: "truncate", param: null };
    safeEmit("summarizer_backend", {
      backend: "truncate",
    });
    return this.backend;
  }

  private runJob(job: SummaryJob): void {
    const backend = this.ensureBackend();

    try {
      const text =
        backend.kind === "ollama"
          ? this.summarizeWithOllama(backend.param, job.task, job.report)
          : backend.kind === "gemini"
            ? this.summarizeWithGemini(backend.param, job.task, job.report)
            : summarizeByTruncation(job.report);

      if (text.length > 0) {
        this.summaries.push(`[${job.agentName}] ${text}`);
      }
    } catch (error) {
      if (!isExpectedSummarizerError(error)) {
        safeEmit("summarizer_error", {
          agent: job.agentName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private summarizeWithOllama(model: string, task: string, report: string): string {
    const response = this.deps.requestJson(
      {
        body: JSON.stringify({
          model,
          prompt: summarizerPrompt(task, report),
          stream: false,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        timeoutMs: REQUEST_TIMEOUT_MS,
        url: OLLAMA_GENERATE_URL,
      },
      this.deps.env,
    );

    if (!response.ok) {
      throw new Error(`ollama summarizer returned HTTP ${response.status}`);
    }

    const payload = JSON.parse(response.text) as { response?: unknown };
    return typeof payload.response === "string" ? payload.response.trim() : "";
  }

  private summarizeWithGemini(apiKey: string, task: string, report: string): string {
    const response = this.deps.requestJson(
      {
        body: JSON.stringify({
          contents: [{ parts: [{ text: summarizerPrompt(task, report) }] }],
        }),
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        method: "POST",
        timeoutMs: REQUEST_TIMEOUT_MS,
        url: `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_SUMMARIZER_MODEL}:generateContent`,
      },
      this.deps.env,
    );

    if (!response.ok) {
      throw new Error(`gemini summarizer returned HTTP ${response.status}`);
    }

    const payload = JSON.parse(response.text) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: unknown;
          }>;
        };
      }>;
    };
    const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
    return typeof text === "string" ? text.trim() : "";
  }
}
