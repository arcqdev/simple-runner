import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type RunFixtureOptions = {
  completedCycles?: number;
  finished?: boolean;
  goal?: string;
  maxCycles?: number;
  projectDir?: string;
  runId: string;
};

export function makeRunsHome(): string {
  const homeDir = path.join(
    os.tmpdir(),
    `kodo-runs-home-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(homeDir, { recursive: true });
  return homeDir;
}

export function writeRunFixture(homeDir: string, options: RunFixtureOptions): string {
  const projectDir = path.resolve(options.projectDir ?? path.join(homeDir, "project"));
  mkdirSync(projectDir, { recursive: true });

  const runDir = path.join(homeDir, ".kodo", "runs", options.runId);
  mkdirSync(runDir, { recursive: true });

  const events: Array<Record<string, unknown>> = [
    {
      event: "cli_args",
      goal_text: options.goal ?? "Ship the feature end-to-end",
      max_cycles: options.maxCycles ?? 3,
      orchestrator: "codex",
      orchestrator_model: "gpt-5.4",
      project_dir: projectDir,
      team: "full",
    },
    {
      event: "run_start",
      goal: options.goal ?? "Ship the feature end-to-end",
      max_cycles: options.maxCycles ?? 3,
      model: "gpt-5.4",
      orchestrator: "codex",
      project_dir: projectDir,
    },
  ];

  for (let index = 0; index < (options.completedCycles ?? 0); index += 1) {
    events.push({
      agent: "worker_fast",
      conversation_log: `conversations/worker_fast_${String(index + 1).padStart(3, "0")}.jsonl.gz`,
      cost_bucket: "cursor_subscription",
      elapsed_s: 0.5,
      event: "agent_run_end",
      input_tokens: 5,
      output_tokens: 3,
      status: "completed",
    });
    events.push({ event: "cycle_end", summary: `Cycle ${index + 1} complete` });
  }

  if (options.finished ?? false) {
    events.push({ event: "run_end" });
  }

  writeFileSync(
    path.join(runDir, "log.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );

  return runDir;
}
