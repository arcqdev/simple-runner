import { afterEach, describe, expect, it } from "vitest";

import { AsyncSummarizer, summarizeByTruncation } from "../../src/runtime/summarizer.js";

const ORIGINAL_GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ORIGINAL_GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

function envWithoutSummaryKeys(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  delete env.KODO_SUMMARIZER_BACKEND;
  return env;
}

afterEach(() => {
  if (ORIGINAL_GEMINI_API_KEY === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = ORIGINAL_GEMINI_API_KEY;
  }
  if (ORIGINAL_GOOGLE_API_KEY === undefined) {
    delete process.env.GOOGLE_API_KEY;
  } else {
    process.env.GOOGLE_API_KEY = ORIGINAL_GOOGLE_API_KEY;
  }
});

describe("async summarizer", () => {
  it("prefers the first local model over gemini and truncation", () => {
    const requests: string[] = [];
    const summarizer = new AsyncSummarizer({
      env: {
        ...envWithoutSummaryKeys(),
        GEMINI_API_KEY: "gem-key",
      },
      listLocalModels: () => ["qwen3:14b"],
      requestJson: (request) => {
        requests.push(request.url);
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({ response: "Implemented src/runtime/summarizer.ts" }),
        };
      },
    });

    expect(summarizer.getBackendForTests()).toEqual({
      kind: "ollama",
      param: "qwen3:14b",
    });

    summarizer.summarize("worker_fast", "Add summarizer", "updated src/runtime/summarizer.ts");
    expect(summarizer.getAccumulatedSummary()).toBe(
      "[worker_fast] Implemented src/runtime/summarizer.ts",
    );
    expect(requests).toEqual(["http://localhost:11434/api/generate"]);
  });

  it("falls back to gemini when no local model is available", () => {
    const requests: Array<{ headers: Record<string, string> | undefined; url: string }> = [];
    const summarizer = new AsyncSummarizer({
      env: {
        ...envWithoutSummaryKeys(),
        GOOGLE_API_KEY: "google-key",
      },
      listLocalModels: () => [],
      requestJson: (request) => {
        requests.push({ headers: request.headers, url: request.url });
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            candidates: [{ content: { parts: [{ text: "Added tests for summary fallback" }] } }],
          }),
        };
      },
    });

    expect(summarizer.getBackendForTests()).toEqual({
      kind: "gemini",
      param: "google-key",
    });

    summarizer.summarize("tester", "Write tests", "added coverage");
    expect(summarizer.getAccumulatedSummary()).toBe("[tester] Added tests for summary fallback");
    expect(requests[0]?.url).toContain(":generateContent");
    expect(requests[0]?.headers?.["x-goog-api-key"]).toBe("google-key");
  });

  it("falls back to truncation when no llm backend is available", () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    const summarizer = new AsyncSummarizer({
      env: envWithoutSummaryKeys(),
      listLocalModels: () => [],
      requestJson: () => {
        throw new Error("should not be called");
      },
    });

    expect(summarizer.getBackendForTests()).toEqual({
      kind: "truncate",
      param: null,
    });

    summarizer.summarize(
      "worker_fast",
      "Implement feature",
      "\n  Added worker-summary.txt\nMore detail that should not be needed\n",
    );
    expect(summarizer.getAccumulatedSummary()).toBe("[worker_fast] Added worker-summary.txt");
  });

  it("honors explicit backend overrides", () => {
    const ollamaRequests: string[] = [];
    const ollamaOverride = new AsyncSummarizer({
      env: {
        ...envWithoutSummaryKeys(),
        GOOGLE_API_KEY: "google-key",
        KODO_SUMMARIZER_BACKEND: "ollama:llama3.3:70b",
      },
      listLocalModels: () => ["qwen3:14b"],
      requestJson: (request) => {
        ollamaRequests.push(request.body ?? "");
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({ response: "Forced ollama override" }),
        };
      },
    });

    expect(ollamaOverride.getBackendForTests()).toEqual({
      kind: "ollama",
      param: "llama3.3:70b",
    });
    ollamaOverride.summarize("worker_fast", "Task", "Completed override");
    expect(ollamaOverride.getAccumulatedSummary()).toBe("[worker_fast] Forced ollama override");
    expect(ollamaRequests[0]).toContain('"model":"llama3.3:70b"');

    const geminiOverride = new AsyncSummarizer({
      env: {
        ...envWithoutSummaryKeys(),
        KODO_SUMMARIZER_BACKEND: "gemini",
      },
      listLocalModels: () => ["qwen3:14b"],
      requestJson: () => {
        throw new Error("should not be called");
      },
    });

    expect(geminiOverride.getBackendForTests()).toEqual({
      kind: "truncate",
      param: null,
    });
  });

  it("accumulates summaries across queued jobs and preserves them until cleared", () => {
    const summarizer = new AsyncSummarizer({
      env: envWithoutSummaryKeys(),
      listLocalModels: () => [],
      requestJson: () => {
        throw new Error("should not be called");
      },
    });

    summarizer.summarize("worker_a", "Task A", "Created a.txt");
    summarizer.summarize("worker_b", "Task B", "Created b.txt");

    expect(summarizer.getAccumulatedSummary()).toBe(
      "[worker_a] Created a.txt\n[worker_b] Created b.txt",
    );
    expect(summarizer.getAccumulatedSummary()).toBe(
      "[worker_a] Created a.txt\n[worker_b] Created b.txt",
    );

    summarizer.clear();
    expect(summarizer.getAccumulatedSummary()).toBe("");
  });

  it("swallows backend failures and keeps draining later jobs", () => {
    let requestCount = 0;
    const summarizer = new AsyncSummarizer({
      env: {
        ...envWithoutSummaryKeys(),
        GEMINI_API_KEY: "gem-key",
      },
      listLocalModels: () => [],
      requestJson: () => {
        requestCount += 1;
        if (requestCount === 1) {
          throw new TypeError("network down");
        }
        return {
          ok: true,
          status: 200,
          text: JSON.stringify({
            candidates: [{ content: { parts: [{ text: "Recovered on second summary" }] } }],
          }),
        };
      },
    });

    summarizer.summarize("worker_a", "Task A", "first");
    summarizer.summarize("worker_b", "Task B", "second");

    expect(summarizer.getAccumulatedSummary()).toBe("[worker_b] Recovered on second summary");
  });

  it("drains or discards pending jobs during shutdown", () => {
    const draining = new AsyncSummarizer({
      env: envWithoutSummaryKeys(),
      listLocalModels: () => [],
      requestJson: () => {
        throw new Error("should not be called");
      },
    });
    draining.summarize("worker_fast", "Task", "Drained summary");
    draining.shutdown(true);
    expect(draining.getAccumulatedSummary()).toBe("[worker_fast] Drained summary");

    const discarding = new AsyncSummarizer({
      env: envWithoutSummaryKeys(),
      listLocalModels: () => [],
      requestJson: () => {
        throw new Error("should not be called");
      },
    });
    discarding.summarize("worker_fast", "Task", "Discard me");
    discarding.shutdown(false);
    expect(discarding.getAccumulatedSummary()).toBe("");
    discarding.summarize("worker_fast", "Task", "Ignored after shutdown");
    expect(discarding.getAccumulatedSummary()).toBe("");
  });

  it("truncates to the first non-empty line", () => {
    expect(summarizeByTruncation("\n\n  first useful line  \nsecond line")).toBe(
      "first useful line",
    );
    expect(summarizeByTruncation("\n\n")).toBe("");
  });
});
