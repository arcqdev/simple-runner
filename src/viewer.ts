import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { listRuns, runsRoot } from "./logging/runs.js";
import { isTraceUploadEnabled } from "./logging/trace-upload.js";
import { safeJoin } from "./runtime/fs.js";

type ViewerOptions = {
  openBrowser?: boolean;
};

type ServeViewerOptions = ViewerOptions & {
  logPath?: string | null;
  onListen?: (url: string) => void;
};

type ViewerServer = {
  close: () => Promise<void>;
  port: number;
  url: string;
};

type ViewerIndexRun = {
  agent_session_details: Record<string, ViewerSessionDetail>;
  agent_stats: ViewerIndexAgentStat[];
  completed_stage_count: number;
  conversation_count: number;
  conversation_logs: string[];
  current_stage_cycles: number;
  has_stages: boolean;
  last_summary: string;
  completed_cycles: number;
  error_count: number;
  finished: boolean;
  goal: string;
  input_tokens: number;
  is_debug: boolean;
  log_file: string;
  max_cycles: number;
  max_exchanges: number;
  model: string;
  orchestrator_bucket_breakdown: ViewerIndexBucketStat[];
  orchestrator_cost_bucket: string;
  orchestrator: string;
  output_tokens: number;
  parallel_stage_count: number;
  pending_exchange_count: number;
  project_dir: string;
  project_name: string;
  run_id: string;
  stage_summaries: string[];
  team_count: number;
  team_preset: string;
  total_agent_calls: number;
  total_elapsed_s: number;
};

type ViewerIndexAgentStat = {
  agent: string;
  calls: number;
  conversation_count: number;
  cost_bucket: string;
  elapsed_s: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
};

type ViewerIndexBucketStat = {
  calls: number;
  conversation_count: number;
  cost_bucket: string;
  elapsed_s: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
};

type ViewerSessionDetail = {
  acp_backend: string | null;
  provider: string | null;
  provider_env_vars: string[];
  provider_thread_id: string | null;
  server_session_id: string | null;
  session_id: string;
};

function cleanupStaleViewerFiles(now = Date.now()): void {
  const tempDir = os.tmpdir();
  const cutoff = now - 60 * 60 * 1000;

  for (const entry of readdirSync(tempDir)) {
    if (!entry.startsWith("simple_runner_viewer_")) {
      continue;
    }

    const entryPath = path.join(tempDir, entry);
    try {
      const modified = statSync(entryPath).mtimeMs;
      if (modified >= cutoff) {
        continue;
      }
      rmSync(entryPath, { force: true, recursive: true });
    } catch {
      continue;
    }
  }
}

function loadEvents(logPath: string): Record<string, unknown>[] {
  return readFileSync(logPath, "utf8")
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return typeof parsed === "object" && parsed !== null
          ? [parsed as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
}

function loadRunLog(runId: string): string {
  let runDir: string;
  try {
    runDir = safeJoin(runsRoot(), runId);
  } catch {
    throw new Error("Invalid run_id");
  }

  const logFile = existsSync(path.join(runDir, "log.jsonl"))
    ? path.join(runDir, "log.jsonl")
    : path.join(runDir, "run.jsonl");

  if (!existsSync(logFile)) {
    throw new Error(`Run not found: ${runId}`);
  }

  return readFileSync(logFile, "utf8");
}

function buildRunIndex(): ViewerIndexRun[] {
  return listRuns().map((run) => ({
    agent_session_details: Object.fromEntries(
      Object.entries(run.agentSessionDetails).map(([agent, detail]) => [
        agent,
        {
          acp_backend: detail.acpBackend,
          provider: detail.provider,
          provider_env_vars: detail.providerEnvVars,
          provider_thread_id: detail.providerThreadId,
          server_session_id: detail.serverSessionId,
          session_id: detail.sessionId,
        },
      ]),
    ),
    agent_stats: Object.entries(run.agentStats)
      .map(([agent, stats]) => ({
        agent,
        calls: stats.calls,
        conversation_count: stats.conversationLogs.length,
        cost_bucket: stats.costBucket,
        elapsed_s: Number(stats.elapsedS.toFixed(3)),
        error_count: stats.errors,
        input_tokens: stats.inputTokens,
        output_tokens: stats.outputTokens,
      }))
      .sort((left, right) => right.calls - left.calls || left.agent.localeCompare(right.agent)),
    completed_stage_count: run.completedStages.length,
    conversation_count: run.conversationArtifacts.length,
    conversation_logs: run.conversationArtifacts,
    current_stage_cycles: run.currentStageCycles,
    has_stages: run.hasStages,
    last_summary: run.lastSummary,
    completed_cycles: run.completedCycles,
    error_count: run.errorCount,
    finished: run.finished,
    goal: run.goal.slice(0, 200),
    input_tokens: run.inputTokens,
    is_debug: run.isDebug,
    log_file: run.logFile,
    max_cycles: run.maxCycles,
    max_exchanges: run.maxExchanges,
    model: run.model,
    orchestrator_bucket_breakdown: Object.values(
      Object.values(run.agentStats).reduce<Record<string, ViewerIndexBucketStat>>(
        (accumulator, stats) => {
          const key = stats.costBucket || "unknown";
          const current = accumulator[key] ?? {
            calls: 0,
            conversation_count: 0,
            cost_bucket: key,
            elapsed_s: 0,
            error_count: 0,
            input_tokens: 0,
            output_tokens: 0,
          };
          current.calls += stats.calls;
          current.conversation_count += stats.conversationLogs.length;
          current.elapsed_s = Number((current.elapsed_s + stats.elapsedS).toFixed(3));
          current.error_count += stats.errors;
          current.input_tokens += stats.inputTokens;
          current.output_tokens += stats.outputTokens;
          accumulator[key] = current;
          return accumulator;
        },
        {},
      ),
    ).sort(
      (left, right) =>
        right.calls - left.calls || left.cost_bucket.localeCompare(right.cost_bucket),
    ),
    orchestrator_cost_bucket: run.orchestratorCostBucket,
    orchestrator: run.orchestrator,
    output_tokens: run.outputTokens,
    parallel_stage_count: Object.keys(run.parallelStageState).length,
    pending_exchange_count: run.pendingExchanges.length,
    project_dir: run.projectDir,
    project_name: path.basename(run.projectDir) || "?",
    run_id: run.runId,
    stage_summaries: run.stageSummaries,
    team_count: run.team.length,
    team_preset: run.teamPreset,
    total_agent_calls: run.totalAgentCalls,
    total_elapsed_s: run.totalElapsedS,
  }));
}

function serializeScriptValue(value: unknown): string {
  return JSON.stringify(value).replace(/</gu, "\\u003c");
}

function buildHtml(logPath: string | null): string {
  const events = logPath === null ? [] : loadEvents(logPath);
  const index = buildRunIndex();
  const title =
    logPath === null
      ? "simple-runner log viewer"
      : `simple-runner log viewer — ${path.basename(logPath)}`;
  const traceUploadEnabled = isTraceUploadEnabled();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4efe8;
      --panel: rgba(255, 250, 244, 0.9);
      --panel-strong: rgba(255, 252, 248, 0.98);
      --border: rgba(83, 57, 41, 0.16);
      --text: #26170e;
      --muted: #725f51;
      --accent: #a64b00;
      --accent-soft: rgba(166, 75, 0, 0.1);
      --good: #0f766e;
      --warn: #b45309;
      --code-bg: #fffaf4;
      --shadow: 0 20px 50px rgba(73, 40, 15, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(255, 200, 87, 0.28), transparent 34%),
        radial-gradient(circle at top right, rgba(239, 68, 68, 0.14), transparent 28%),
        linear-gradient(180deg, #f8f3ed 0%, var(--bg) 100%);
      min-height: 100vh;
    }
    button, input { font: inherit; }
    main {
      max-width: 1200px;
      margin: 0 auto;
      padding: 40px 20px 80px;
    }
    .shell {
      display: grid;
      gap: 20px;
    }
    .panel {
      border: 1px solid var(--border);
      border-radius: 24px;
      background: var(--panel);
      box-shadow: var(--shadow);
      backdrop-filter: blur(12px);
    }
    .hero {
      padding: 24px;
    }
    h1, h2, h3, p {
      margin: 0;
    }
    h1 {
      font-size: clamp(28px, 4vw, 44px);
      line-height: 1;
      letter-spacing: -0.03em;
      margin-bottom: 10px;
    }
    .meta, .subtle {
      color: var(--muted);
      line-height: 1.5;
    }
    .subtle {
      font-size: 14px;
    }
    .toolbar {
      margin-top: 18px;
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }
    .button {
      border: 1px solid rgba(166, 75, 0, 0.22);
      background: white;
      color: var(--text);
      border-radius: 999px;
      padding: 10px 14px;
      cursor: pointer;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
    }
    .hidden {
      display: none !important;
    }
    .picker {
      padding: 20px;
      display: grid;
      gap: 14px;
    }
    .picker-tools {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      justify-content: space-between;
    }
    .filter-row {
      display: flex;
      flex-wrap: wrap;
      gap: 16px;
      color: var(--muted);
      font-size: 14px;
    }
    .filter-row label {
      display: inline-flex;
      gap: 8px;
      align-items: center;
    }
    .run-grid {
      display: grid;
      gap: 14px;
    }
    .run-day {
      display: grid;
      gap: 10px;
    }
    .day-heading {
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .run-card, .timeline-card {
      border: 1px solid var(--border);
      border-radius: 20px;
      background: var(--panel-strong);
      padding: 18px;
    }
    .run-card {
      cursor: pointer;
      display: grid;
      gap: 12px;
    }
    .run-card:hover {
      transform: translateY(-1px);
      box-shadow: 0 10px 30px rgba(73, 40, 15, 0.08);
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px 12px;
      align-items: center;
    }
    .title {
      font-size: 18px;
      font-weight: 700;
      color: var(--accent);
    }
    .status {
      font-size: 12px;
      font-weight: 700;
      padding: 4px 10px;
      border-radius: 999px;
      background: rgba(15, 118, 110, 0.08);
      color: var(--good);
    }
    .status.partial {
      background: rgba(180, 83, 9, 0.09);
      color: var(--warn);
    }
    .goal {
      font-size: 15px;
      line-height: 1.55;
    }
    .kv {
      display: grid;
      gap: 6px;
      font-size: 13px;
      color: var(--muted);
    }
    .metric-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      border: 1px solid rgba(83, 57, 41, 0.14);
      padding: 6px 10px;
      background: rgba(255, 255, 255, 0.92);
      font-size: 12px;
      color: var(--muted);
    }
    .trace-box {
      padding: 14px 16px;
      border: 1px dashed rgba(166, 75, 0, 0.3);
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.56);
    }
    .viewer {
      padding: 20px;
      display: grid;
      gap: 16px;
    }
    .summary-grid {
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    }
    .detail-grid {
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    }
    .summary-box {
      border: 1px solid var(--border);
      border-radius: 18px;
      background: var(--panel-strong);
      padding: 14px 16px;
    }
    .summary-box strong {
      display: block;
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .detail-card {
      border: 1px solid var(--border);
      border-radius: 18px;
      background: var(--panel-strong);
      padding: 16px;
      display: grid;
      gap: 12px;
    }
    .detail-card h3 {
      font-size: 16px;
      margin-bottom: 0;
    }
    .detail-list {
      display: grid;
      gap: 8px;
    }
    .detail-item {
      border: 1px solid rgba(83, 57, 41, 0.08);
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.86);
      padding: 10px 12px;
    }
    .detail-item strong {
      display: block;
      font-size: 13px;
      margin-bottom: 4px;
    }
    .detail-item span {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.5;
    }
    .artifact-list {
      display: grid;
      gap: 8px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
    }
    .artifact-item {
      padding: 10px 12px;
      border-radius: 14px;
      background: var(--code-bg);
      border: 1px solid rgba(83, 57, 41, 0.08);
      overflow-wrap: anywhere;
    }
    .timeline {
      display: grid;
      gap: 14px;
    }
    .timeline-card h3 {
      margin-bottom: 10px;
      font-size: 18px;
    }
    .event-list {
      display: grid;
      gap: 10px;
    }
    .event-item {
      border: 1px solid rgba(83, 57, 41, 0.08);
      border-radius: 14px;
      padding: 12px;
      background: var(--code-bg);
    }
    .event-label {
      font-weight: 700;
      color: var(--accent);
    }
    .stamp {
      color: var(--muted);
      font-size: 12px;
      margin-left: 8px;
    }
    pre {
      margin: 10px 0 0;
      overflow-x: auto;
      padding: 14px;
      border-radius: 14px;
      background: #fff;
      border: 1px solid rgba(83, 57, 41, 0.08);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .drop-zone {
      border: 2px dashed rgba(166, 75, 0, 0.25);
      border-radius: 20px;
      padding: 18px;
      text-align: center;
      color: var(--muted);
      background: rgba(255, 255, 255, 0.5);
    }
    .empty {
      padding: 24px;
      border-radius: 20px;
      border: 1px dashed var(--border);
      color: var(--muted);
      background: rgba(255, 255, 255, 0.45);
      text-align: center;
    }
    @media (max-width: 720px) {
      main {
        padding: 24px 14px 64px;
      }
      .hero, .picker, .viewer {
        padding: 18px;
      }
      .picker-tools {
        align-items: flex-start;
      }
    }
  </style>
</head>
<body>
  <main>
    <div class="shell">
      <section class="panel hero">
        <h1 id="title"></h1>
        <p class="meta" id="meta"></p>
        <div class="toolbar">
          <button class="button hidden" id="back-btn" type="button">Back To Runs</button>
          <label class="button" for="log-input">Open Local JSONL</label>
          <input class="hidden" id="log-input" type="file" accept=".jsonl,.log" />
          <span class="badge" id="trace-badge"></span>
        </div>
      </section>

      <section class="panel picker" id="picker">
        <div class="trace-box hidden" id="trace-box"></div>
        <div class="picker-tools">
          <p class="subtle" id="picker-meta"></p>
          <div class="filter-row" id="filter-row"></div>
        </div>
        <div class="drop-zone" id="drop-zone">Drop a .jsonl file here to inspect it without leaving the browser.</div>
        <div class="run-grid" id="run-grid"></div>
      </section>

      <section class="panel viewer hidden" id="viewer">
        <div class="summary-grid" id="summary-grid"></div>
        <div class="detail-grid">
          <section class="detail-card" id="accounting-card">
            <h3>Accounting Breakdown</h3>
            <div class="detail-list" id="accounting-list"></div>
          </section>
          <section class="detail-card" id="artifacts-card">
            <h3>Artifacts And State</h3>
            <div class="detail-list" id="artifacts-list"></div>
            <div class="artifact-list hidden" id="artifact-files"></div>
          </section>
        </div>
        <div class="timeline" id="timeline"></div>
      </section>
    </div>
  </main>
  <script>
    const EMBEDDED_DATA = ${serializeScriptValue(events)};
    const EMBEDDED_INDEX = ${serializeScriptValue(index)};
    const EMBEDDED_CWD = ${serializeScriptValue(process.cwd())};
    const TRACE_UPLOAD_ENABLED = ${serializeScriptValue(traceUploadEnabled)};
    const INITIAL_LOG_PATH = ${serializeScriptValue(logPath ?? "")};
    const INITIAL_TITLE = ${serializeScriptValue(title)};

    const titleEl = document.getElementById("title");
    const metaEl = document.getElementById("meta");
    const pickerEl = document.getElementById("picker");
    const pickerMetaEl = document.getElementById("picker-meta");
    const filterRowEl = document.getElementById("filter-row");
    const viewerEl = document.getElementById("viewer");
    const backBtnEl = document.getElementById("back-btn");
    const runGridEl = document.getElementById("run-grid");
    const summaryGridEl = document.getElementById("summary-grid");
    const accountingListEl = document.getElementById("accounting-list");
    const artifactsListEl = document.getElementById("artifacts-list");
    const artifactFilesEl = document.getElementById("artifact-files");
    const timelineEl = document.getElementById("timeline");
    const logInputEl = document.getElementById("log-input");
    const traceBadgeEl = document.getElementById("trace-badge");
    const traceBoxEl = document.getElementById("trace-box");
    const dropZoneEl = document.getElementById("drop-zone");
    const RUN_ID_RE = /^(\\d{4})(\\d{2})(\\d{2})_(\\d{2})(\\d{2})(\\d{2})$/u;
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let showAllProjects = false;
    let showDebugRuns = false;
    let currentRunMeta = null;

    function escapeHtml(text) {
      const node = document.createElement("div");
      node.textContent = String(text ?? "");
      return node.innerHTML;
    }

    function formatSeconds(value) {
      return typeof value === "number" ? value.toFixed(3) + "s" : "";
    }

    function formatCount(value, singular, plural = singular + "s") {
      return value + " " + (value === 1 ? singular : plural);
    }

    function formatBucket(bucket) {
      return String(bucket || "unknown").replaceAll("_", " ");
    }

    function formatRunDay(runId) {
      const match = RUN_ID_RE.exec(String(runId || ""));
      if (!match) return "Other";
      return MONTHS[Number.parseInt(match[2], 10) - 1] + " " + Number.parseInt(match[3], 10) + ", " + match[1];
    }

    function formatRunTime(runId) {
      const match = RUN_ID_RE.exec(String(runId || ""));
      if (!match) return String(runId || "?");
      return match[4] + ":" + match[5] + ":" + match[6];
    }

    function latestT(events) {
      return events.reduce((max, record) => typeof record.t === "number" && record.t > max ? record.t : max, 0);
    }

    function buildAgentStatsFromEvents(events) {
      const byAgent = new Map();
      for (const record of events) {
        if (record.event !== "agent_run_end" || typeof record.agent !== "string" || record.agent.length === 0) {
          continue;
        }
        const current = byAgent.get(record.agent) ?? {
          agent: record.agent,
          calls: 0,
          conversation_count: 0,
          cost_bucket: String(record.cost_bucket ?? "unknown"),
          elapsed_s: 0,
          error_count: 0,
          input_tokens: 0,
          output_tokens: 0,
        };
        current.calls += 1;
        current.conversation_count += typeof record.conversation_log === "string" ? 1 : 0;
        current.elapsed_s = Number((current.elapsed_s + (typeof record.elapsed_s === "number" ? record.elapsed_s : 0)).toFixed(3));
        current.error_count += record.is_error === true ? 1 : 0;
        current.input_tokens += typeof record.input_tokens === "number" ? record.input_tokens : 0;
        current.output_tokens += typeof record.output_tokens === "number" ? record.output_tokens : 0;
        if (typeof record.cost_bucket === "string" && record.cost_bucket.length > 0) {
          current.cost_bucket = record.cost_bucket;
        }
        byAgent.set(record.agent, current);
      }
      return [...byAgent.values()].sort((left, right) => right.calls - left.calls || left.agent.localeCompare(right.agent));
    }

    function buildBucketStats(agentStats) {
      const buckets = new Map();
      for (const stat of agentStats) {
        const key = stat.cost_bucket || "unknown";
        const current = buckets.get(key) ?? {
          calls: 0,
          conversation_count: 0,
          cost_bucket: key,
          elapsed_s: 0,
          error_count: 0,
          input_tokens: 0,
          output_tokens: 0,
        };
        current.calls += stat.calls;
        current.conversation_count += stat.conversation_count;
        current.elapsed_s = Number((current.elapsed_s + stat.elapsed_s).toFixed(3));
        current.error_count += stat.error_count;
        current.input_tokens += stat.input_tokens;
        current.output_tokens += stat.output_tokens;
        buckets.set(key, current);
      }
      return [...buckets.values()].sort((left, right) => right.calls - left.calls || left.cost_bucket.localeCompare(right.cost_bucket));
    }

    function inferConversationLogs(events) {
      return [...new Set(events
        .map((record) => typeof record.conversation_log === "string" ? record.conversation_log : null)
        .filter(Boolean))];
    }

    function deriveRunMeta(events, embeddedMeta) {
      if (embeddedMeta) {
        return embeddedMeta;
      }
      const args = events.find((record) => record.event === "cli_args") || {};
      const start = events.find((record) => record.event === "run_start") || {};
      const runEnd = [...events].reverse().find((record) => record.event === "run_end") || null;
      const stageEnds = events.filter((record) => record.event === "stage_end" && record.finished);
      const agentStats = buildAgentStatsFromEvents(events);
      return {
        agent_stats: agentStats,
        completed_stage_count: stageEnds.length,
        conversation_count: inferConversationLogs(events).length,
        conversation_logs: inferConversationLogs(events),
        current_stage_cycles: 0,
        has_stages: events.some((record) => record.event === "stage_start" || record.event === "stage_end"),
        last_summary: String(runEnd?.summary ?? [...events].reverse().find((record) => typeof record.summary === "string")?.summary ?? ""),
        completed_cycles: events.filter((record) => record.event === "cycle_end").length,
        error_count: agentStats.reduce((sum, entry) => sum + entry.error_count, 0),
        finished: runEnd ? runEnd.finished !== false : false,
        goal: String(start.goal ?? args.goal_text ?? ""),
        input_tokens: agentStats.reduce((sum, entry) => sum + entry.input_tokens, 0),
        is_debug: events.some((record) => record.event === "debug_run_start"),
        log_file: INITIAL_LOG_PATH || "",
        max_cycles: Number(start.max_cycles ?? args.max_cycles ?? 0),
        max_exchanges: Number(start.max_exchanges ?? args.max_exchanges ?? 0),
        model: String(start.model ?? args.orchestrator_model ?? "unknown"),
        orchestrator_bucket_breakdown: buildBucketStats(agentStats),
        orchestrator_cost_bucket: String(start.cost_bucket ?? "unknown"),
        orchestrator: String(start.orchestrator ?? args.orchestrator ?? "unknown"),
        output_tokens: agentStats.reduce((sum, entry) => sum + entry.output_tokens, 0),
        parallel_stage_count: 0,
        pending_exchange_count: 0,
        project_dir: String(start.project_dir ?? args.project_dir ?? EMBEDDED_CWD),
        project_name: String((start.project_dir ?? args.project_dir ?? EMBEDDED_CWD).split(/[\\\\/]/u).filter(Boolean).pop() ?? "?"),
        run_id: "",
        stage_summaries: stageEnds.map((record) => String(record.summary ?? "")).filter((value) => value.length > 0),
        team_count: Array.isArray(start.team) ? start.team.length : 0,
        team_preset: String(args.team ?? args.mode ?? "full"),
        total_agent_calls: agentStats.reduce((sum, entry) => sum + entry.calls, 0),
        total_elapsed_s: Number(agentStats.reduce((sum, entry) => sum + entry.elapsed_s, 0).toFixed(3)),
      };
    }

    function summarizeEvent(record) {
      const name = String(record.event ?? "event");
      if (name === "cycle_end") return String(record.summary ?? "Cycle completed");
      if (name === "stage_end") return "Stage " + String(record.stage_index ?? "?") + (record.finished ? " finished" : " paused");
      if (name === "orchestrator_tool_call") return "Delegated to " + String(record.agent ?? record.tool ?? "tool");
      if (name === "orchestrator_tool_result") return "Tool result received";
      if (name === "agent_run_end") return String(record.agent ?? "agent") + " finished";
      if (name === "session_query_end") return "Session " + String(record.session ?? "query") + " ended";
      return name.replaceAll("_", " ");
    }

    function buildTree(events) {
      const tree = { header: {}, cycles: [], outside: [], runEnd: null };
      let currentCycle = null;
      let currentExchange = null;

      for (const record of events) {
        const eventName = String(record.event ?? "");
        if (["run_init", "cli_args", "run_start", "run_resumed", "debug_run_start"].includes(eventName)) {
          tree.header[eventName] = record;
          continue;
        }
        if (eventName === "run_end") {
          tree.runEnd = record;
          continue;
        }
        if (eventName === "cycle_start" || eventName === "run_cycle") {
          currentCycle = {
            cycle: record.cycle_index ?? record.cycle ?? (tree.cycles.length + 1),
            start: record,
            exchanges: [],
            events: [],
            end: null,
          };
          tree.cycles.push(currentCycle);
          currentExchange = null;
          continue;
        }
        if (eventName === "orchestrator_tool_call") {
          if (!currentCycle) {
            currentCycle = { cycle: tree.cycles.length + 1, start: null, exchanges: [], events: [], end: null };
            tree.cycles.push(currentCycle);
          }
          currentExchange = { start: record, events: [], end: null };
          currentCycle.exchanges.push(currentExchange);
          continue;
        }
        if (eventName === "orchestrator_tool_result") {
          if (currentExchange) {
            currentExchange.end = record;
            currentExchange = null;
          } else if (currentCycle) {
            currentCycle.events.push(record);
          } else {
            tree.outside.push(record);
          }
          continue;
        }
        if (eventName === "cycle_end") {
          if (!currentCycle) {
            currentCycle = { cycle: tree.cycles.length + 1, start: null, exchanges: [], events: [], end: null };
            tree.cycles.push(currentCycle);
          }
          currentCycle.end = record;
          currentExchange = null;
          currentCycle = null;
          continue;
        }
        if (currentExchange) {
          currentExchange.events.push(record);
        } else if (currentCycle) {
          currentCycle.events.push(record);
        } else {
          tree.outside.push(record);
        }
      }
      return tree;
    }

    function renderRunPicker() {
      const localRuns = EMBEDDED_INDEX.filter((run) => run.project_dir === EMBEDDED_CWD);
      const hasLocalRuns = localRuns.length > 0;
      const hasDebugRuns = EMBEDDED_INDEX.some((run) => run.is_debug);
      pickerMetaEl.textContent = hasLocalRuns
        ? formatCount(localRuns.length, "run") + " for this project • " + formatCount(EMBEDDED_INDEX.length, "known run")
        : formatCount(EMBEDDED_INDEX.length, "known run");
      filterRowEl.innerHTML = "";
      if (hasLocalRuns) {
        const localLabel = document.createElement("label");
        localLabel.innerHTML = '<input id="filter-projects" type="checkbox"' + (showAllProjects ? " checked" : "") + '> show all projects';
        filterRowEl.appendChild(localLabel);
        localLabel.querySelector("input").addEventListener("change", (event) => {
          showAllProjects = event.target.checked;
          renderRunPicker();
        });
      }
      if (hasDebugRuns) {
        const debugLabel = document.createElement("label");
        debugLabel.innerHTML = '<input id="filter-debug" type="checkbox"' + (showDebugRuns ? " checked" : "") + '> show debug runs';
        filterRowEl.appendChild(debugLabel);
        debugLabel.querySelector("input").addEventListener("change", (event) => {
          showDebugRuns = event.target.checked;
          renderRunPicker();
        });
      }

      let runs = EMBEDDED_INDEX;
      if (hasLocalRuns && !showAllProjects) {
        runs = runs.filter((run) => run.project_dir === EMBEDDED_CWD);
      }
      if (!showDebugRuns) {
        runs = runs.filter((run) => !run.is_debug);
      }

      runGridEl.innerHTML = "";
      if (runs.length === 0) {
        runGridEl.innerHTML = '<div class="empty">No runs match the current filters. Adjust the toggles above, run simple-runner first, or open a local log file.</div>';
        return;
      }

      const groups = runs.reduce((accumulator, run) => {
        const day = formatRunDay(run.run_id);
        (accumulator[day] ??= []).push(run);
        return accumulator;
      }, {});

      for (const day of Object.keys(groups).sort((left, right) => left === "Other" ? 1 : right === "Other" ? -1 : left < right ? 1 : -1)) {
        const section = document.createElement("section");
        section.className = "run-day";
        const heading = document.createElement("div");
        heading.className = "day-heading";
        heading.textContent = day;
        section.appendChild(heading);
        for (const run of groups[day]) {
          const card = document.createElement("article");
          card.className = "run-card";
          card.dataset.runId = run.run_id;
          card.innerHTML =
            '<div class="row">' +
              '<div class="title">' + escapeHtml(formatRunTime(run.run_id)) + '</div>' +
              '<div class="status ' + (run.finished ? "" : "partial") + '">' +
                escapeHtml(run.finished ? "done" : ("cycle " + run.completed_cycles + "/" + run.max_cycles)) +
              '</div>' +
            '</div>' +
            '<p class="goal">' + escapeHtml((run.goal || "").trim() || "(no goal captured)") + '</p>' +
            '<div class="metric-row">' +
              '<span class="pill">' + escapeHtml(run.project_name) + '</span>' +
              '<span class="pill">' + escapeHtml(run.orchestrator) + " / " + escapeHtml(run.model) + '</span>' +
              '<span class="pill">' + escapeHtml(formatBucket(run.orchestrator_cost_bucket)) + '</span>' +
              '<span class="pill">' + escapeHtml(formatCount(run.total_agent_calls, "agent call")) + '</span>' +
              (run.is_debug ? '<span class="pill">debug</span>' : "") +
            '</div>' +
            '<div class="kv">' +
              '<div>' + escapeHtml(run.run_id) + " • " + escapeHtml(formatSeconds(run.total_elapsed_s)) + " elapsed • in " + escapeHtml(String(run.input_tokens)) + " • out " + escapeHtml(String(run.output_tokens)) + " • errors " + escapeHtml(String(run.error_count)) + '</div>' +
              '<div>' + escapeHtml(formatCount(run.conversation_count, "conversation capture")) + " • " + escapeHtml(formatCount(run.completed_stage_count, "completed stage")) + " • pending exchanges " + escapeHtml(String(run.pending_exchange_count)) + '</div>' +
              '<div>' + escapeHtml(run.last_summary || run.log_file) + '</div>' +
            '</div>';
          card.addEventListener("click", () => {
            void loadRunById(run.run_id);
          });
          section.appendChild(card);
        }
        runGridEl.appendChild(section);
      }
    }

    function renderSummary(events, tree, runMeta) {
      const args = tree.header.cli_args || {};
      const start = tree.header.run_start || {};
      const runEnd = tree.runEnd || {};
      const completedCycles = events.filter((record) => record.event === "cycle_end").length;
      const completedStages = events.filter((record) => record.event === "stage_end" && record.finished).length;
      const toolCalls = events.filter((record) => record.event === "orchestrator_tool_call").length;
      const goal = String(runMeta.goal ?? start.goal ?? args.goal_text ?? "").trim() || "(no goal captured)";

      summaryGridEl.innerHTML = "";
      const entries = [
        ["Goal", goal],
        ["Project", String(runMeta.project_dir ?? start.project_dir ?? args.project_dir ?? EMBEDDED_CWD)],
        ["Orchestrator", String(runMeta.orchestrator ?? start.orchestrator ?? args.orchestrator ?? "unknown") + " • " + String(runMeta.model ?? start.model ?? args.orchestrator_model ?? "unknown")],
        ["Run Stats", completedCycles + " cycles • " + completedStages + " stages • " + toolCalls + " tool calls"],
        ["Accounting", runMeta.total_agent_calls + " agent calls • in " + runMeta.input_tokens + " • out " + runMeta.output_tokens + " • errors " + runMeta.error_count],
        ["Artifacts", runMeta.conversation_count + " conversation capture(s) • bucket " + formatBucket(runMeta.orchestrator_cost_bucket)],
        ["Status", runMeta.finished || runEnd.finished ? "completed" : (events.length > 0 ? "in progress / partial" : "empty log")],
        ["Summary", String(runMeta.last_summary || runEnd.summary || events.findLast((record) => record.event === "cycle_end")?.summary || "No summary captured")],
      ];

      for (const [label, value] of entries) {
        const card = document.createElement("div");
        card.className = "summary-box";
        card.innerHTML = "<strong>" + escapeHtml(label) + "</strong><div>" + escapeHtml(value) + "</div>";
        summaryGridEl.appendChild(card);
      }
    }

    function renderAccounting(runMeta) {
      accountingListEl.innerHTML = "";
      const bucketStats = runMeta.orchestrator_bucket_breakdown?.length > 0
        ? runMeta.orchestrator_bucket_breakdown
        : buildBucketStats(runMeta.agent_stats || []);
      if (bucketStats.length > 0) {
        for (const bucket of bucketStats) {
          const item = document.createElement("div");
          item.className = "detail-item";
          item.innerHTML =
            "<strong>" + escapeHtml(formatBucket(bucket.cost_bucket)) + "</strong>" +
            "<span>" +
            escapeHtml(formatCount(bucket.calls, "call")) +
            " • in " + escapeHtml(String(bucket.input_tokens)) +
            " • out " + escapeHtml(String(bucket.output_tokens)) +
            " • " + escapeHtml(formatSeconds(bucket.elapsed_s)) +
            " • errors " + escapeHtml(String(bucket.error_count)) +
            " • conversations " + escapeHtml(String(bucket.conversation_count)) +
            "</span>";
          accountingListEl.appendChild(item);
        }
      }

      const agentStats = runMeta.agent_stats || [];
      if (agentStats.length === 0) {
        accountingListEl.innerHTML = '<div class="empty">No agent accounting was found in this log.</div>';
        return;
      }
      for (const stat of agentStats) {
        const item = document.createElement("div");
        item.className = "detail-item";
        item.innerHTML =
          "<strong>" + escapeHtml(stat.agent) + "</strong>" +
          "<span>" +
          escapeHtml(formatBucket(stat.cost_bucket)) +
          " • " + escapeHtml(formatCount(stat.calls, "call")) +
          " • in " + escapeHtml(String(stat.input_tokens)) +
          " • out " + escapeHtml(String(stat.output_tokens)) +
          " • " + escapeHtml(formatSeconds(stat.elapsed_s)) +
          " • errors " + escapeHtml(String(stat.error_count)) +
          " • conversations " + escapeHtml(String(stat.conversation_count)) +
          "</span>";
        accountingListEl.appendChild(item);
      }
    }

    function renderArtifacts(runMeta) {
      artifactsListEl.innerHTML = "";
      artifactFilesEl.innerHTML = "";
      artifactFilesEl.classList.add("hidden");

      const items = [
        ["Run ID", runMeta.run_id || "(local file)"],
        ["Log File", runMeta.log_file || INITIAL_LOG_PATH || "(browser-loaded file)"],
        ["Team", runMeta.team_count > 0 ? runMeta.team_preset + " • " + formatCount(runMeta.team_count, "agent") : runMeta.team_preset || "unknown"],
        ["Stages", runMeta.has_stages ? formatCount(runMeta.completed_stage_count, "completed stage") + " • current stage cycles " + runMeta.current_stage_cycles : "no staged execution captured"],
        ["Pending Work", runMeta.pending_exchange_count > 0 ? formatCount(runMeta.pending_exchange_count, "pending exchange") : "no pending exchanges captured"],
        ["Parallel State", runMeta.parallel_stage_count > 0 ? formatCount(runMeta.parallel_stage_count, "parallel stage group") : "no parallel stage state captured"],
      ];
      if (runMeta.stage_summaries?.length > 0) {
        items.push(["Stage Summaries", runMeta.stage_summaries.join(" | ")]);
      }

      for (const [label, value] of items) {
        const item = document.createElement("div");
        item.className = "detail-item";
        item.innerHTML = "<strong>" + escapeHtml(label) + "</strong><span>" + escapeHtml(value) + "</span>";
        artifactsListEl.appendChild(item);
      }

      if (runMeta.conversation_logs?.length > 0) {
        artifactFilesEl.classList.remove("hidden");
        for (const artifact of runMeta.conversation_logs) {
          const entry = document.createElement("div");
          entry.className = "artifact-item";
          entry.textContent = artifact;
          artifactFilesEl.appendChild(entry);
        }
      }
    }

    function renderEventList(target, events) {
      const list = document.createElement("div");
      list.className = "event-list";
      for (const record of events) {
        const item = document.createElement("div");
        item.className = "event-item";
        const stampParts = [];
        if (record.ts) stampParts.push(String(record.ts));
        if (typeof record.t === "number") stampParts.push(formatSeconds(record.t));
        item.innerHTML =
          '<div><span class="event-label">' + escapeHtml(String(record.event ?? "event")) + '</span>' +
          (stampParts.length === 0 ? "" : '<span class="stamp">' + escapeHtml(stampParts.join(" • ")) + '</span>') +
          '</div>' +
          '<div class="subtle">' + escapeHtml(summarizeEvent(record)) + '</div>' +
          '<pre>' + escapeHtml(JSON.stringify(record, null, 2)) + '</pre>';
        list.appendChild(item);
      }
      target.appendChild(list);
    }

    function renderTimeline(events, embeddedMeta) {
      const tree = buildTree(events);
      const runMeta = deriveRunMeta(events, embeddedMeta);
      renderSummary(events, tree, runMeta);
      renderAccounting(runMeta);
      renderArtifacts(runMeta);
      timelineEl.innerHTML = "";

      if (events.length === 0) {
        timelineEl.innerHTML = '<div class="empty">No valid JSON events were found in this log.</div>';
        return;
      }

      if (tree.outside.length > 0) {
        const outsideCard = document.createElement("section");
        outsideCard.className = "timeline-card";
        outsideCard.innerHTML = "<h3>Run Events</h3>";
        renderEventList(outsideCard, tree.outside);
        timelineEl.appendChild(outsideCard);
      }

      for (const cycle of tree.cycles) {
        const card = document.createElement("section");
        card.className = "timeline-card";
        card.innerHTML = "<h3>Cycle " + escapeHtml(String(cycle.cycle ?? "?")) + "</h3>";

        if (cycle.start) {
          renderEventList(card, [cycle.start]);
        }
        if (cycle.events.length > 0) {
          const section = document.createElement("div");
          section.innerHTML = '<p class="subtle">Cycle events</p>';
          renderEventList(section, cycle.events);
          card.appendChild(section);
        }
        for (const [index, exchange] of cycle.exchanges.entries()) {
          const section = document.createElement("div");
          section.style.marginTop = "12px";
          section.innerHTML = '<p class="subtle">Exchange ' + escapeHtml(String(index + 1)) + "</p>";
          renderEventList(section, [exchange.start, ...exchange.events, ...(exchange.end ? [exchange.end] : [])]);
          card.appendChild(section);
        }
        if (cycle.end) {
          const section = document.createElement("div");
          section.style.marginTop = "12px";
          section.innerHTML = '<p class="subtle">Cycle result</p>';
          renderEventList(section, [cycle.end]);
          card.appendChild(section);
        }
        timelineEl.appendChild(card);
      }

      if (tree.runEnd) {
        const endCard = document.createElement("section");
        endCard.className = "timeline-card";
        endCard.innerHTML = "<h3>Run Result</h3>";
        renderEventList(endCard, [tree.runEnd]);
        timelineEl.appendChild(endCard);
      }
    }

    async function loadRunById(runId) {
      try {
        const response = await fetch("/api/log/" + encodeURIComponent(runId));
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }
        const text = await response.text();
        const events = text
          .split(/\\r?\\n/u)
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .flatMap((line) => {
            try { return [JSON.parse(line)]; } catch { return []; }
          });
        showLogView(events, runId, EMBEDDED_INDEX.find((candidate) => candidate.run_id === runId) || null);
      } catch {
        const run = EMBEDDED_INDEX.find((candidate) => candidate.run_id === runId);
        const message = run?.log_file
          ? 'To inspect this run from file mode, open: ' + run.log_file + '\\n\\nUse simple-runner logs --port 8080 for in-browser run browsing.'
          : 'Run could not be loaded.';
        window.alert(message);
      }
    }

    function showLogView(events, runId, runMeta = null) {
      currentRunMeta = runMeta;
      const inferredTitle = runId ? "simple-runner log viewer — " + runId : INITIAL_TITLE;
      titleEl.textContent = inferredTitle;
      metaEl.textContent = [
        INITIAL_LOG_PATH || runId || "",
        events.length + " event" + (events.length === 1 ? "" : "s"),
        EMBEDDED_INDEX.length + " known run" + (EMBEDDED_INDEX.length === 1 ? "" : "s"),
      ].filter(Boolean).join(" • ");
      pickerEl.classList.add("hidden");
      viewerEl.classList.remove("hidden");
      backBtnEl.classList.toggle("hidden", EMBEDDED_INDEX.length === 0);
      renderTimeline(events, runMeta);
    }

    function showPicker() {
      currentRunMeta = null;
      titleEl.textContent = INITIAL_TITLE;
      metaEl.textContent = [
        INITIAL_LOG_PATH || "",
        EMBEDDED_DATA.length + " event" + (EMBEDDED_DATA.length === 1 ? "" : "s"),
        EMBEDDED_INDEX.length + " known run" + (EMBEDDED_INDEX.length === 1 ? "" : "s"),
      ].filter(Boolean).join(" • ");
      viewerEl.classList.add("hidden");
      pickerEl.classList.remove("hidden");
      backBtnEl.classList.add("hidden");
    }

    function parseTextLog(text) {
      return text
        .split(/\\r?\\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .flatMap((line) => {
          try { return [JSON.parse(line)]; } catch { return []; }
        });
    }

    function bindLocalFilePicker() {
      logInputEl.addEventListener("change", async (event) => {
        const file = event.target.files?.[0];
        if (!file) {
          return;
        }
        const text = await file.text();
        showLogView(parseTextLog(text), file.name);
      });

      const prevent = (event) => {
        event.preventDefault();
      };
      ["dragenter", "dragover", "dragleave", "drop"].forEach((name) => {
        window.addEventListener(name, prevent);
      });
      window.addEventListener("drop", async (event) => {
        const file = event.dataTransfer?.files?.[0];
        if (!file) {
          return;
        }
        const text = await file.text();
        showLogView(parseTextLog(text), file.name);
      });
    }

    function renderTraceAffordance() {
      traceBadgeEl.textContent = TRACE_UPLOAD_ENABLED ? "Trace Upload Enabled" : "Trace Upload Disabled";
      if (!TRACE_UPLOAD_ENABLED) {
        return;
      }
      traceBoxEl.classList.remove("hidden");
      traceBoxEl.textContent = "Runtime trace upload support is enabled for this viewer session. New orchestrator runs can upload run archives when credentials are available; older logs only display the accounting and artifact data already captured on disk.";
    }

    backBtnEl.addEventListener("click", () => {
      showPicker();
    });

    titleEl.textContent = INITIAL_TITLE;
    renderRunPicker();
    renderTraceAffordance();
    bindLocalFilePicker();

    if (EMBEDDED_DATA.length > 0) {
      showLogView(EMBEDDED_DATA, INITIAL_LOG_PATH || "embedded log", null);
    } else {
      showPicker();
    }
  </script>
</body>
</html>`;
}

function maybeOpenExternal(target: string): void {
  if (process.env.SIMPLE_RUNNER_NO_VIEWER || process.env.CI || process.env.VITEST) {
    return;
  }

  const platform = process.platform;
  const command =
    platform === "darwin"
      ? { file: "open", args: [target] }
      : platform === "win32"
        ? { file: "cmd", args: ["/c", "start", "", target] }
        : { file: "xdg-open", args: [target] };

  try {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    return;
  }
}

export function openViewer(logPath: string | null = null, options: ViewerOptions = {}): string {
  if (logPath !== null && !existsSync(logPath)) {
    throw new Error(`File not found: ${logPath}`);
  }

  cleanupStaleViewerFiles();
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "simple_runner_viewer_"));
  const htmlPath = path.join(tempDir, "index.html");
  writeFileSync(htmlPath, buildHtml(logPath), "utf8");
  const url = new URL(`file://${htmlPath}`).toString();

  if (options.openBrowser ?? true) {
    maybeOpenExternal(url);
  }

  return url;
}

export async function serveViewer(
  port: number,
  options: ServeViewerOptions = {},
): Promise<ViewerServer> {
  const logPath = options.logPath ?? null;
  if (logPath !== null && !existsSync(logPath)) {
    throw new Error(`File not found: ${logPath}`);
  }

  cleanupStaleViewerFiles();
  const html = buildHtml(logPath);

  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

    if (requestUrl.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }

    if (requestUrl.pathname.startsWith("/api/log/")) {
      const runId = decodeURIComponent(requestUrl.pathname.slice("/api/log/".length));
      try {
        const data = loadRunLog(runId);
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(data);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status =
          message === "Invalid run_id" ? 400 : message.startsWith("Run not found:") ? 404 : 500;
        response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
        response.end(message);
      }
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    throw new Error("Failed to determine viewer server address.");
  }

  const url = `http://127.0.0.1:${address.port}/`;
  if (options.openBrowser ?? true) {
    maybeOpenExternal(url);
  }
  options.onListen?.(url);

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    port: address.port,
    url,
  };
}

function parseViewerArgs(argv: string[]): {
  help: boolean;
  logfile: string | null;
  port: number;
  serve: boolean;
} {
  let logfile: string | null = null;
  let port = 8080;
  let serve = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      return { help: true, logfile, port, serve };
    }
    if (token === "--serve") {
      serve = true;
      continue;
    }
    if (token === "--port") {
      const value = argv[index + 1];
      if (value === undefined || !/^-?\d+$/u.test(value)) {
        throw new Error("argument --port: expected integer value");
      }
      port = Number.parseInt(value, 10);
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      throw new Error(`unrecognized arguments: ${token}`);
    }
    if (logfile !== null) {
      throw new Error(`unrecognized arguments: ${token}`);
    }
    logfile = token;
  }

  return { help: false, logfile, port, serve };
}

async function waitForSignals(server: ViewerServer): Promise<number> {
  return await new Promise<number>((resolve) => {
    const close = () => {
      process.off("SIGINT", close);
      process.off("SIGTERM", close);
      void server.close().finally(() => resolve(0));
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

export async function runViewerCli(argv = process.argv.slice(2)): Promise<number> {
  const hintPortIndex = argv.indexOf("--port");
  const requestedPort =
    hintPortIndex >= 0 &&
    hintPortIndex + 1 < argv.length &&
    /^-?\d+$/u.test(argv[hintPortIndex + 1] ?? "")
      ? Number.parseInt(argv[hintPortIndex + 1] ?? "8080", 10)
      : 8080;
  try {
    const parsed = parseViewerArgs(argv);
    if (parsed.help) {
      process.stdout.write(
        [
          "Usage: simple-runner-viewer [logfile] [--serve] [--port PORT]",
          "",
          "Open a JSONL log file in the simple-runner viewer.",
        ].join("\n") + "\n",
      );
      return 0;
    }

    if (parsed.logfile !== null) {
      const resolved = path.resolve(parsed.logfile);
      if (!existsSync(resolved)) {
        process.stderr.write(`File not found: ${resolved}\n`);
        return 1;
      }
      const stats = statSync(resolved);
      if (stats.isDirectory()) {
        process.stderr.write(`Expected a log file, not a directory: ${resolved}\n`);
        return 1;
      }
      if (parsed.serve) {
        const server = await serveViewer(parsed.port, { logPath: resolved });
        process.stdout.write(`Log viewer: ${server.url}\n`);
        return await waitForSignals(server);
      }

      process.stdout.write(`Log viewer: ${openViewer(resolved)}\n`);
      return 0;
    }

    if (parsed.serve) {
      const server = await serveViewer(parsed.port, { logPath: null });
      process.stdout.write(`Log viewer: ${server.url}\n`);
      return await waitForSignals(server);
    }

    process.stdout.write(`Log viewer: ${openViewer(null)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    if (error instanceof Error && /EADDRINUSE/u.test(message)) {
      process.stderr.write(`Hint: try a different port with --port ${requestedPort + 1}\n`);
    }
    return 1;
  }
}

export function cleanupViewerFile(url: string): void {
  if (!url.startsWith("file://")) {
    return;
  }
  try {
    const filePath = new URL(url).pathname;
    const directory = path.dirname(filePath);
    unlinkSync(filePath);
    rmSync(directory, { force: true, recursive: true });
  } catch {
    return;
  }
}
