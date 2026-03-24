import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { getRunById, listRuns, parseRun, truncateWord } from "../src/logging/runs.js";

function usage(): string {
  return [
    "Usage:",
    "  npm run ops:analyze-run -- <run-id|path-to-log.jsonl>",
    "  npm run ops:analyze-run",
  ].join("\n");
}

function printSummary(target: ReturnType<typeof parseRun>): void {
  if (target === null) {
    throw new Error("Run could not be parsed.");
  }

  const status = target.finished ? "finished" : "incomplete";
  process.stdout.write(`Run ID:        ${target.runId}\n`);
  process.stdout.write(`Status:        ${status}\n`);
  process.stdout.write(`Goal:          ${truncateWord(target.goal, 120)}\n`);
  process.stdout.write(`Project:       ${target.projectDir}\n`);
  process.stdout.write(`Orchestrator:  ${target.orchestrator} (${target.model})\n`);
  process.stdout.write(`Cycles:        ${target.completedCycles}/${target.maxCycles}\n`);
  process.stdout.write(`Agent calls:   ${target.totalAgentCalls}\n`);
  process.stdout.write(`Tokens:        in=${target.inputTokens} out=${target.outputTokens}\n`);
  process.stdout.write(`Errors:        ${target.errorCount}\n`);
  process.stdout.write(`Pending work:  ${target.pendingExchanges.length}\n`);
  process.stdout.write(`Artifacts:     ${target.conversationArtifacts.length}\n`);
  if (target.lastSummary.length > 0) {
    process.stdout.write(`Last summary:  ${truncateWord(target.lastSummary, 160)}\n`);
  }

  if (target.stageSummaries.length > 0) {
    process.stdout.write("\nStage summaries:\n");
    for (const summary of target.stageSummaries) {
      process.stdout.write(`- ${truncateWord(summary, 160)}\n`);
    }
  }

  const agentNames = Object.keys(target.agentStats).sort();
  if (agentNames.length > 0) {
    process.stdout.write("\nPer-agent accounting:\n");
    for (const agentName of agentNames) {
      const stats = target.agentStats[agentName]!;
      process.stdout.write(
        `- ${agentName}: calls=${stats.calls} tokens=${stats.inputTokens}/${stats.outputTokens} elapsed=${stats.elapsedS.toFixed(3)}s errors=${stats.errors} bucket=${stats.costBucket || "unknown"}\n`,
      );
    }
  }
}

function main(): void {
  const target = process.argv[2];
  if (target === "--help" || target === "-h") {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (!target) {
    const runs = listRuns().slice(0, 10);
    process.stdout.write("Recent runs:\n");
    for (const run of runs) {
      process.stdout.write(
        `- ${run.runId} [${run.finished ? "finished" : "incomplete"}] ${truncateWord(run.goal, 80)}\n`,
      );
    }
    if (runs.length === 0) {
      process.stdout.write("- none\n");
    }
    return;
  }

  const parsed =
    existsSync(target) && path.basename(target).endsWith(".jsonl")
      ? parseRun(path.resolve(target))
      : getRunById(target);
  if (parsed === null) {
    throw new Error(`Run not found or not parseable: ${target}`);
  }
  printSummary(parsed);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.stderr.write(`${usage()}\n`);
  process.exitCode = 1;
}
