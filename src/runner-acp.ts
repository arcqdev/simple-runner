import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadDotEnv } from "./config/dotenv.js";
import { createPendingRun } from "./cli/main.js";
import { parseMainArgs } from "./cli/params.js";
import { emit as emitLogEvent, subscribe, type LogEventRecord } from "./logging/log.js";
import { executePendingRun } from "./runtime/engine.js";

type RunnerAcpSession = {
  cwd: string;
  sessionId: string;
};

type RunnerAcpPromptMetadata = {
  args?: unknown;
  autoRefine?: unknown;
  cycles?: unknown;
  debug?: unknown;
  effort?: unknown;
  exchanges?: unknown;
  fixFrom?: unknown;
  focus?: unknown;
  improve?: unknown;
  loge?: unknown;
  noAutoCommit?: unknown;
  orchestrator?: unknown;
  project?: unknown;
  resume?: unknown;
  skipIntake?: unknown;
  target?: unknown;
  team?: unknown;
  test?: unknown;
  yes?: unknown;
};

type RunnerAcpPromptParams = {
  cwd?: unknown;
  maxTurns?: unknown;
  metadata?: RunnerAcpPromptMetadata | null;
  prompt?: unknown;
  sessionId?: unknown;
};

type RunnerAcpRequest = {
  id?: number | string | null;
  jsonrpc?: string;
  method?: string;
  params?: Record<string, unknown>;
};

const PROTOCOL_VERSION = 1;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: Record<string, unknown> | null | undefined, key: string): string | null {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function boolField(value: RunnerAcpPromptMetadata | null | undefined, key: keyof RunnerAcpPromptMetadata): boolean {
  return value?.[key] === true;
}

function intArg(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? String(Math.trunc(value)) : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function currentRunId(logFile: string | null): string | null {
  return typeof logFile === "string" ? path.basename(path.dirname(logFile)) : null;
}

function runnerAcpFilePath(): string {
  return fileURLToPath(import.meta.url);
}

export function runnerAcpCliPath(): string {
  return runnerAcpFilePath();
}

export function spawnRunnerAcpServer(options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
} = {}): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [runnerAcpCliPath()], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

class RunnerAcpServer {
  readonly #sessions = new Map<string, RunnerAcpSession>();
  #busy = false;
  #nextSessionId = 1;

  write(message: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  writeResponse(id: number | string | null | undefined, result: Record<string, unknown>): void {
    this.write({
      id: id ?? null,
      jsonrpc: "2.0",
      result,
    });
  }

  writeError(
    id: number | string | null | undefined,
    code: number,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    this.write({
      error: {
        code,
        data: data ?? null,
        message,
      },
      id: id ?? null,
      jsonrpc: "2.0",
    });
  }

  writeNotification(method: string, params: Record<string, unknown>): void {
    this.write({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  buildArgv(promptParams: RunnerAcpPromptParams, session: RunnerAcpSession): string[] {
    const metadata = isObject(promptParams.metadata) ? (promptParams.metadata as RunnerAcpPromptMetadata) : null;
    const argv: string[] = ["--yes", "--json"];

    if (typeof promptParams.prompt === "string" && promptParams.prompt.trim().length > 0) {
      argv.push("--goal", promptParams.prompt.trim());
    } else if (typeof metadata?.fixFrom === "string" && metadata.fixFrom.length > 0) {
      argv.push("--fix-from", metadata.fixFrom);
    } else if (boolField(metadata, "improve")) {
      argv.push("--improve");
    } else if (boolField(metadata, "test")) {
      argv.push("--test");
    } else if (typeof metadata?.resume === "string" && metadata.resume.length > 0) {
      argv.push("--resume", metadata.resume);
    } else {
      throw new Error("runner ACP prompt requires a non-empty prompt or an explicit goal mode.");
    }

    if (boolField(metadata, "skipIntake") || typeof promptParams.prompt === "string") {
      argv.push("--skip-intake");
    }
    if (boolField(metadata, "autoRefine")) {
      argv.push("--auto-refine");
    }
    if (boolField(metadata, "debug")) {
      argv.push("--debug");
    }
    if (boolField(metadata, "loge")) {
      argv.push("--loge");
    }
    if (boolField(metadata, "noAutoCommit")) {
      argv.push("--no-auto-commit");
    }

    const project =
      stringField(metadata, "project") ??
      (typeof promptParams.cwd === "string" && promptParams.cwd.length > 0 ? promptParams.cwd : null) ??
      session.cwd;
    argv.push("--project", project);

    const team = stringField(metadata, "team");
    if (team !== null) {
      argv.push("--team", team);
    }
    const orchestrator = stringField(metadata, "orchestrator");
    if (orchestrator !== null) {
      argv.push("--orchestrator", orchestrator);
    }
    const focus = stringField(metadata, "focus");
    if (focus !== null) {
      argv.push("--focus", focus);
    }
    const cycles = intArg(metadata?.cycles);
    if (cycles !== null) {
      argv.push("--cycles", cycles);
    }
    const exchanges = intArg(metadata?.exchanges);
    if (exchanges !== null) {
      argv.push("--exchanges", exchanges);
    }
    const effort = stringField(metadata, "effort");
    if (effort !== null) {
      argv.push("--effort", effort);
    }
    for (const target of stringArray(metadata?.target)) {
      argv.push("--target", target);
    }
    for (const extraArg of stringArray(metadata?.args)) {
      argv.push(extraArg);
    }

    return argv;
  }

  async handlePrompt(id: number | string | null | undefined, params: Record<string, unknown>): Promise<void> {
    if (this.#busy) {
      this.writeError(id, -32000, "runner ACP is busy with another run");
      return;
    }

    const sessionId = stringField(params, "sessionId");
    if (sessionId === null) {
      this.writeError(id, -32602, "prompt requires sessionId");
      return;
    }

    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      this.writeError(id, -32602, `unknown sessionId: ${sessionId}`);
      return;
    }

    let unsubscribe: (() => void) | null = null;
    let runId: string | null = null;
    this.#busy = true;
    this.writeResponse(id, { accepted: true });

    try {
      const promptParams = params as RunnerAcpPromptParams;
      const argv = this.buildArgv(promptParams, session);
      unsubscribe = subscribe((entry: LogEventRecord) => {
        runId = runId ?? currentRunId(entry.logFile);
        this.writeNotification("run.log_event", {
          event: entry.event,
          record: entry.record,
          runId,
          sessionId,
        });
      });

      const parsed = parseMainArgs(argv);
      const pending = createPendingRun(parsed);
      runId = pending.runDir.runId;
      this.writeNotification("run.started", {
        goal: pending.goal.goalText,
        projectDir: pending.runDir.projectDir,
        runId,
        runRoot: pending.runDir.root,
        sessionId,
      });

      const result = executePendingRun(pending.runDir, pending.params, pending.goal, parsed.flags);

      this.writeNotification("result", {
        result: {
          locator: {
            conversationId: result.runId,
          },
          raw: {
            logFile: pending.runDir.logFile,
            reportPath: result.artifacts.reportPath,
            runRoot: result.runRoot,
          },
          stopReason: result.finished ? "completed" : "interrupted",
          text: result.summary,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (runId !== null) {
        emitLogEvent("runner_acp_error", {
          error: message,
          run_id: runId,
        });
      }
      this.writeNotification("run.failed", {
        error: {
          message,
        },
        runId,
        sessionId,
      });
      this.writeNotification("result", {
        result: {
          locator: {
            conversationId: runId ?? sessionId,
          },
          raw: null,
          stopReason: "failed",
          text: message,
        },
      });
    } finally {
      unsubscribe?.();
      this.#busy = false;
    }
  }

  async handle(request: RunnerAcpRequest): Promise<void> {
    const id = request.id;
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      this.writeError(id, -32600, "invalid request");
      return;
    }

    switch (request.method) {
      case "initialize":
        this.writeResponse(id, {
          agentCapabilities: {
            initialize: true,
            prompt: true,
            resume: false,
            sessionLifecycle: true,
            streaming: true,
            usage: false,
          },
          agentInfo: {
            name: "simple-runner-acp",
            version: "0.1.0",
          },
          instructions: "Use session.create, then prompt. This server exposes runner-level events, not worker ACP envelopes.",
          protocolVersion: PROTOCOL_VERSION,
        });
        return;
      case "session.create": {
        const params = isObject(request.params) ? request.params : {};
        const sessionId = `runner-session-${this.#nextSessionId++}`;
        const cwd = stringField(params, "cwd") ?? process.cwd();
        this.#sessions.set(sessionId, { cwd, sessionId });
        this.writeResponse(id, {
          sessionId,
        });
        this.writeNotification("session.created", {
          cwd,
          sessionId,
        });
        return;
      }
      case "prompt":
        await this.handlePrompt(id, isObject(request.params) ? request.params : {});
        return;
      case "shutdown":
        this.writeResponse(id, {});
        return;
      default:
        this.writeError(id, -32601, `method not found: ${request.method}`);
    }
  }
}

export async function runRunnerAcpServer(): Promise<void> {
  loadDotEnv();
  const server = new RunnerAcpServer();
  const rl = createInterface({ input: process.stdin });
  let chain = Promise.resolve();

  rl.on("line", (line) => {
    chain = chain.then(async () => {
      let parsed: RunnerAcpRequest;
      try {
        parsed = JSON.parse(line) as RunnerAcpRequest;
      } catch {
        server.writeError(null, -32700, "parse error");
        return;
      }
      await server.handle(parsed);
    });
  });

  await new Promise<void>((resolve) => {
    rl.once("close", () => {
      resolve();
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runRunnerAcpServer();
}
