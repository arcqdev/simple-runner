import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium, type ConsoleMessage, type Page } from "playwright";

import { cleanupViewerFile, openViewer, serveViewer } from "../src/viewer.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function makeTempDir(label: string): string {
  const directory = path.join(
    os.tmpdir(),
    `simple-runner-viewer-browser-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(directory, { recursive: true });
  return directory;
}

function writeJsonl(filePath: string, events: Array<Record<string, unknown>>): void {
  writeFileSync(filePath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

function writeRun(
  runsRoot: string,
  options: {
    debug?: boolean;
    events: Array<Record<string, unknown>>;
    pendingExchanges?: Array<Record<string, unknown>>;
    projectDir: string;
    runId: string;
  },
): void {
  const runDir = path.join(runsRoot, options.runId);
  mkdirSync(runDir, { recursive: true });
  mkdirSync(options.projectDir, { recursive: true });
  writeJsonl(path.join(runDir, "log.jsonl"), options.events);
  if (options.pendingExchanges !== undefined) {
    writeFileSync(
      path.join(runDir, "runtime-state.json"),
      JSON.stringify(
        {
          pendingExchanges: options.pendingExchanges,
          parallelStageState: {
            "parallel-ui": { state: "running" },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
  }
}

async function collectConsoleErrors(page: Page, action: () => Promise<void>): Promise<string[]> {
  const errors: string[] = [];
  const listener = (message: ConsoleMessage) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  };
  page.on("console", listener);
  try {
    await action();
  } finally {
    page.off("console", listener);
  }
  return errors;
}

async function verifyServedViewer(): Promise<void> {
  const tempRoot = makeTempDir("served");
  const runsDir = path.join(tempRoot, "runs");
  const localProject = process.cwd();
  const otherProject = path.join(tempRoot, "other-project");
  const debugProject = path.join(tempRoot, "debug-project");
  mkdirSync(runsDir, { recursive: true });

  writeRun(runsDir, {
    projectDir: localProject,
    runId: "20260323_010203",
    pendingExchanges: [{ agent: "worker_fast", task: "Finish browser coverage" }],
    events: [
      {
        event: "cli_args",
        goal_text: "Investigate viewer richness",
        max_cycles: 4,
        orchestrator: "codex",
        orchestrator_model: "gpt-5.4",
        project_dir: localProject,
        team: "full",
      },
      {
        cost_bucket: "codex_subscription",
        event: "run_start",
        goal: "Investigate viewer richness",
        has_stages: true,
        max_cycles: 4,
        max_exchanges: 8,
        model: "gpt-5.4",
        orchestrator: "codex",
        project_dir: localProject,
        team: ["worker_fast", "architect"],
      },
      { event: "stage_start", stage_index: 1 },
      {
        event: "session_query_end",
        session: "codex",
        session_id: "sess-1",
        conversation_log: "conversations/worker_fast_001.jsonl.gz",
      },
      {
        agent: "worker_fast",
        conversation_log: "conversations/worker_fast_001.jsonl.gz",
        cost_bucket: "codex_subscription",
        elapsed_s: 1.25,
        event: "agent_run_end",
        input_tokens: 101,
        output_tokens: 55,
        response_text: "Implemented the first viewer pass.",
        status: "completed",
      },
      { cycle: 1, event: "run_cycle" },
      {
        agent: "architect",
        conversation_log: "conversations/architect_001.jsonl.gz",
        cost_bucket: "claude_subscription",
        elapsed_s: 0.75,
        event: "agent_run_end",
        input_tokens: 12,
        is_error: true,
        output_tokens: 7,
        response_text: "Need one more pass.",
        status: "completed",
      },
      { event: "cycle_end", summary: "Cycle 1 complete" },
      {
        event: "stage_end",
        finished: true,
        stage_index: 1,
        summary: "Viewer metadata wired through",
      },
    ],
  });

  writeRun(runsDir, {
    projectDir: otherProject,
    runId: "20260322_222222",
    events: [
      {
        event: "cli_args",
        goal_text: "Other project work",
        max_cycles: 2,
        orchestrator: "codex",
        orchestrator_model: "gpt-5.4",
        project_dir: otherProject,
        team: "full",
      },
      {
        cost_bucket: "codex_subscription",
        event: "run_start",
        goal: "Other project work",
        max_cycles: 2,
        model: "gpt-5.4",
        orchestrator: "codex",
        project_dir: otherProject,
      },
      {
        agent: "worker_fast",
        cost_bucket: "codex_subscription",
        elapsed_s: 0.4,
        event: "agent_run_end",
        input_tokens: 4,
        output_tokens: 2,
      },
      { event: "cycle_end", summary: "Done" },
      { event: "run_end", finished: true, summary: "Complete" },
    ],
  });

  writeRun(runsDir, {
    projectDir: debugProject,
    runId: "20260321_111111",
    events: [
      {
        event: "cli_args",
        goal_text: "Debug run should be hidden",
        max_cycles: 1,
        orchestrator: "codex",
        orchestrator_model: "gpt-5.4",
        project_dir: debugProject,
        team: "full",
      },
      {
        cost_bucket: "codex_subscription",
        event: "run_start",
        goal: "Debug run should be hidden",
        max_cycles: 1,
        model: "gpt-5.4",
        orchestrator: "codex",
        project_dir: debugProject,
      },
      { event: "debug_run_start" },
    ],
  });

  const originalRunsDir = process.env.SIMPLE_RUNNER_RUNS_DIR;
  const originalTraceUpload = process.env.SIMPLE_RUNNER_TRACE_UPLOAD;
  process.env.SIMPLE_RUNNER_RUNS_DIR = runsDir;
  process.env.SIMPLE_RUNNER_TRACE_UPLOAD = "1";

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const server = await serveViewer(0, { openBrowser: false });

  try {
    const errors = await collectConsoleErrors(page, async () => {
      await page.goto(server.url, { waitUntil: "networkidle" });
      await page.locator("#run-grid .run-card").first().waitFor();
      await page.locator("#filter-projects").waitFor();
    });
    assert(
      errors.length === 0,
      `Unexpected console errors in served viewer: ${errors.join(" | ")}`,
    );

    await page.waitForSelector("#trace-badge");
    assert(
      (await page.locator("#trace-badge").textContent())?.includes("Enabled") === true,
      "Trace upload badge should show enabled",
    );

    const initialCards = await page.locator("#run-grid .run-card").count();
    assert(
      initialCards === 1,
      `Expected only the local non-debug run by default, found ${initialCards}`,
    );
    assert(
      (await page.locator("#run-grid").textContent())?.includes("Other project work") !== true,
      "Other-project runs should be hidden until the project filter is relaxed",
    );

    await page.locator("#filter-projects").check();
    await page.waitForTimeout(100);
    assert(
      (await page.locator("#run-grid").textContent())?.includes("Other project work") === true,
      "Other project run should appear after enabling all-projects filter",
    );

    await page.locator("#filter-debug").check();
    await page.waitForTimeout(100);
    assert(
      (await page.locator("#run-grid").textContent())?.includes("Debug run should be hidden") ===
        true,
      "Debug run should appear after enabling debug filter",
    );

    await page.locator(".run-card", { hasText: "Investigate viewer richness" }).click();
    await page.locator("#viewer").waitFor();
    assert(
      (await page.locator("#summary-grid").textContent())?.includes(
        "Investigate viewer richness",
      ) === true,
      "Summary should include the selected goal",
    );
    assert(
      (await page.locator("#accounting-list").textContent())?.includes("worker_fast") === true,
      "Accounting should include per-agent details",
    );
    assert(
      (await page.locator("#accounting-list").textContent())?.includes("codex subscription") ===
        true,
      "Accounting should include cost-bucket labels",
    );
    assert(
      (await page.locator("#artifacts-list").textContent())?.includes("pending exchange") === true,
      "Artifacts panel should include pending-exchange state",
    );
    assert(
      (await page.locator("#artifact-files").textContent())?.includes(
        "conversations/worker_fast_001.jsonl.gz",
      ) === true,
      "Artifact file list should include conversation captures",
    );

    await page.locator("#back-btn").click();
    await page.locator("#picker").waitFor();
  } finally {
    await server.close();
    await page.close();
    await browser.close();
    rmSync(tempRoot, { force: true, recursive: true });
    if (originalRunsDir === undefined) {
      delete process.env.SIMPLE_RUNNER_RUNS_DIR;
    } else {
      process.env.SIMPLE_RUNNER_RUNS_DIR = originalRunsDir;
    }
    if (originalTraceUpload === undefined) {
      delete process.env.SIMPLE_RUNNER_TRACE_UPLOAD;
    } else {
      process.env.SIMPLE_RUNNER_TRACE_UPLOAD = originalTraceUpload;
    }
  }
}

async function verifyEmbeddedViewerEscaping(): Promise<void> {
  const tempRoot = makeTempDir("embedded");
  const dangerousLogPath = path.join(tempRoot, "dangerous.jsonl");
  writeJsonl(dangerousLogPath, [
    {
      event: "cli_args",
      goal_text: "Embed a literal </script> marker safely",
      project_dir: tempRoot,
    },
    {
      event: "run_start",
      goal: "Embed a literal </script> marker safely",
      model: "gpt-5.4",
      orchestrator: "codex",
      project_dir: tempRoot,
    },
    { event: "run_cycle", cycle: 1 },
    {
      agent: "worker_fast",
      cost_bucket: "codex_subscription",
      elapsed_s: 0.5,
      event: "agent_run_end",
      input_tokens: 8,
      output_tokens: 3,
      response_text: "literal </script> marker survived",
    },
    { event: "cycle_end", summary: "Embedded view loaded" },
  ]);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const url = openViewer(dangerousLogPath, { openBrowser: false });

  try {
    const errors = await collectConsoleErrors(page, async () => {
      await page.goto(url, { waitUntil: "load" });
      await page.locator("#viewer").waitFor();
    });
    assert(
      errors.length === 0,
      `Unexpected console errors in embedded viewer: ${errors.join(" | ")}`,
    );
    assert(
      (await page.locator("#timeline").textContent())?.includes(
        "literal </script> marker survived",
      ) === true,
      "Embedded viewer should render logs containing literal </script> text",
    );
  } finally {
    cleanupViewerFile(url);
    await page.close();
    await browser.close();
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

async function main(): Promise<void> {
  await verifyServedViewer();
  await verifyEmbeddedViewerEscaping();
  process.stdout.write("Browser verification: OK\n");
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
