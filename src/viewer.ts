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

function cleanupStaleViewerFiles(now = Date.now()): void {
  const tempDir = os.tmpdir();
  const cutoff = now - 60 * 60 * 1000;

  for (const entry of readdirSync(tempDir)) {
    if (!entry.startsWith("kodo_viewer_")) {
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

function loadEvents(logPath: string): unknown[] {
  return readFileSync(logPath, "utf8")
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
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

function buildHtml(logPath: string | null): string {
  const events = logPath === null ? [] : loadEvents(logPath);
  const runs = listRuns().map((run) => ({
    completedCycles: run.completedCycles,
    finished: run.finished,
    goal: run.goal,
    isDebug: run.isDebug,
    logFile: run.logFile,
    maxCycles: run.maxCycles,
    orchestrator: run.orchestrator,
    projectDir: run.projectDir,
    runId: run.runId,
  }));
  const title =
    logPath === null ? "kodo log viewer" : `kodo log viewer — ${path.basename(logPath)}`;

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
      --panel: rgba(255, 250, 244, 0.88);
      --border: rgba(83, 57, 41, 0.18);
      --text: #26170e;
      --muted: #6e5a4d;
      --accent: #b45309;
      --code-bg: #fffaf4;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top left, rgba(255, 200, 87, 0.28), transparent 34%),
        radial-gradient(circle at top right, rgba(239, 68, 68, 0.16), transparent 26%),
        linear-gradient(180deg, #f8f3ed 0%, var(--bg) 100%);
      min-height: 100vh;
    }
    main {
      max-width: 1100px;
      margin: 0 auto;
      padding: 40px 20px 80px;
    }
    header {
      margin-bottom: 24px;
      padding: 24px;
      border: 1px solid var(--border);
      border-radius: 24px;
      background: var(--panel);
      backdrop-filter: blur(12px);
      box-shadow: 0 20px 50px rgba(73, 40, 15, 0.08);
    }
    h1 {
      margin: 0 0 8px;
      font-size: clamp(28px, 4vw, 44px);
      line-height: 1;
      letter-spacing: -0.03em;
    }
    .meta {
      color: var(--muted);
      font-size: 14px;
      line-height: 1.5;
    }
    .run-list, .timeline {
      display: grid;
      gap: 14px;
    }
    .run-list {
      margin-bottom: 24px;
    }
    article {
      padding: 18px 18px 16px;
      border: 1px solid var(--border);
      border-radius: 20px;
      background: var(--panel);
      box-shadow: 0 12px 30px rgba(73, 40, 15, 0.06);
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px 14px;
      align-items: baseline;
      margin-bottom: 10px;
    }
    .event {
      font-size: 16px;
      font-weight: 700;
      color: var(--accent);
    }
    .stamp {
      color: var(--muted);
      font-size: 13px;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      padding: 4px 10px;
      border-radius: 999px;
      border: 1px solid rgba(180, 83, 9, 0.18);
      background: rgba(255, 255, 255, 0.65);
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
    }
    .goal {
      margin: 8px 0 0;
      font-size: 15px;
      line-height: 1.55;
    }
    pre {
      margin: 0;
      overflow-x: auto;
      padding: 14px;
      border-radius: 14px;
      background: var(--code-bg);
      border: 1px solid rgba(83, 57, 41, 0.08);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 13px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .empty {
      padding: 24px;
      border-radius: 20px;
      border: 1px dashed var(--border);
      color: var(--muted);
      background: rgba(255, 255, 255, 0.45);
      text-align: center;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1 id="title"></h1>
      <div class="meta" id="meta"></div>
    </header>
    <section class="run-list" id="runs"></section>
    <section class="timeline" id="timeline"></section>
  </main>
  <script>
    const title = ${JSON.stringify(title)};
    const logPath = ${JSON.stringify(logPath ?? "")};
    const events = ${JSON.stringify(events)};
    const runs = ${JSON.stringify(runs)};

    document.getElementById("title").textContent = title;
    const metaParts = [];
    if (logPath) metaParts.push(logPath);
    metaParts.push(events.length + " event" + (events.length === 1 ? "" : "s"));
    metaParts.push(runs.length + " known run" + (runs.length === 1 ? "" : "s"));
    document.getElementById("meta").textContent = metaParts.join(" • ");

    const runsRoot = document.getElementById("runs");
    if (runs.length > 0) {
      for (const run of runs) {
        const card = document.createElement("article");
        const row = document.createElement("div");
        row.className = "row";

        const runId = document.createElement("div");
        runId.className = "event";
        runId.textContent = run.runId;
        row.appendChild(runId);

        const pill = document.createElement("div");
        pill.className = "pill";
        pill.textContent = run.finished ? "done" : ("cycle " + run.completedCycles + "/" + run.maxCycles);
        row.appendChild(pill);

        const stamp = document.createElement("div");
        stamp.className = "stamp";
        stamp.textContent = [run.orchestrator, run.projectDir, run.logFile, run.isDebug ? "debug" : ""]
          .filter(Boolean)
          .join(" • ");
        row.appendChild(stamp);

        const goal = document.createElement("p");
        goal.className = "goal";
        goal.textContent = String(run.goal || "").trim() || "(no goal captured)";
        card.appendChild(row);
        card.appendChild(goal);
        runsRoot.appendChild(card);
      }
    }

    const timeline = document.getElementById("timeline");
    if (events.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = logPath
        ? "No valid JSON events were found in this log."
        : "Select a specific log with 'kodo logs <log.jsonl>' to inspect event details.";
      timeline.appendChild(empty);
    }

    for (const record of events) {
      const card = document.createElement("article");
      const row = document.createElement("div");
      row.className = "row";

      const event = document.createElement("div");
      event.className = "event";
      event.textContent = String(record.event ?? "event");
      row.appendChild(event);

      const stamp = document.createElement("div");
      stamp.className = "stamp";
      const parts = [];
      if (record.ts) parts.push(String(record.ts));
      if (typeof record.t === "number") parts.push(record.t.toFixed(3) + "s");
      stamp.textContent = parts.join(" • ");
      row.appendChild(stamp);

      const pre = document.createElement("pre");
      pre.textContent = JSON.stringify(record, null, 2);

      card.appendChild(row);
      card.appendChild(pre);
      timeline.appendChild(card);
    }
  </script>
</body>
</html>`;
}

function maybeOpenExternal(target: string): void {
  if (process.env.KODO_NO_VIEWER || process.env.CI || process.env.VITEST) {
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
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "kodo_viewer_"));
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
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
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

export async function runViewerCli(argv = process.argv.slice(2)): Promise<number> {
  try {
    const parsed = parseViewerArgs(argv);
    if (parsed.help) {
      process.stdout.write(
        [
          "Usage: kodo-viewer [logfile] [--serve] [--port PORT]",
          "",
          "Open a JSONL log file in the kodo viewer.",
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
        return await new Promise<number>((resolve) => {
          const close = () => {
            void server.close().finally(() => resolve(0));
          };
          process.once("SIGINT", close);
          process.once("SIGTERM", close);
        });
      }

      process.stdout.write(`Log viewer: ${openViewer(resolved)}\n`);
      return 0;
    }

    if (parsed.serve) {
      const server = await serveViewer(parsed.port, { logPath: null });
      process.stdout.write(`Log viewer: ${server.url}\n`);
      return await new Promise<number>((resolve) => {
        const close = () => {
          void server.close().finally(() => resolve(0));
        };
        process.once("SIGINT", close);
        process.once("SIGTERM", close);
      });
    }

    process.stdout.write(`Log viewer: ${openViewer(null)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
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
