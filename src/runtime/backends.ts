import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { classifySessionError } from "./sessions.js";

export type BackendKey = "claude" | "codex" | "cursor" | "gemini-cli" | "kimi";
export type TeamBackend = "claude" | "claude-cli" | "cursor" | "codex" | "gemini-cli";

export type BackendAvailability = Record<BackendKey, boolean>;
export type BackendStatus = {
  version: string;
  warning: string | null;
};

export const API_KEY_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
] as const;

const EXECUTABLES: Record<BackendKey, string> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor-agent",
  "gemini-cli": "gemini",
  kimi: "kimi",
};

const SMART_MODELS: Record<BackendKey, string> = {
  claude: "opus",
  codex: "gpt-5.4",
  cursor: "composer-1.5",
  "gemini-cli": "gemini-3-flash",
  kimi: "kimi-k2.5",
};

export function isBackendKey(value: string): value is BackendKey {
  return value in EXECUTABLES;
}

function isExecutable(filePath: string): boolean {
  return existsSync(filePath);
}

export function executableForBackend(backend: BackendKey): string {
  return EXECUTABLES[backend];
}

export function commandOnPath(command: string): boolean {
  const pathValue = process.env.PATH ?? "";
  const homeDir = os.homedir();

  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const resolvedDir = directory.startsWith("~")
      ? path.join(homeDir, directory.slice(1))
      : directory;
    const candidate = path.join(resolvedDir, command);
    if (isExecutable(candidate)) {
      return true;
    }
  }

  return false;
}

export function availableBackends(): BackendAvailability {
  return {
    claude: commandOnPath(EXECUTABLES.claude),
    codex: commandOnPath(EXECUTABLES.codex),
    cursor: commandOnPath(EXECUTABLES.cursor),
    "gemini-cli": commandOnPath(EXECUTABLES["gemini-cli"]),
    kimi: commandOnPath(EXECUTABLES.kimi),
  };
}

export function smartModelForBackend(backend: BackendKey): string {
  return SMART_MODELS[backend];
}

export function checkBackendStatus(backend: BackendKey): BackendStatus {
  const command = executableForBackend(backend);

  try {
    const result = spawnSync(command, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    });

    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const combined = `${stdout}\n${stderr}`;
    const version =
      result.status === 0
        ? (combined
            .split(/\r?\n/gu)
            .map((line) => line.trim())
            .find((line) => line.length > 0) ?? "ok")
        : `error (exit ${result.status ?? -1})`;

    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
      return { version: "timeout", warning: "Version check timed out (15 s)" };
    }

    const warning = classifySessionError(
      {
        error: result.error ?? null,
        exitCode: typeof result.status === "number" ? result.status : -1,
        signal: result.signal ?? null,
        stderr,
        stdout,
        timedOut: false,
      },
      backend,
      15,
    );

    if (warning !== null) {
      return { version, warning };
    }

    if (result.status !== 0) {
      const snippet = combined.trim().slice(0, 200);
      return {
        version,
        warning:
          snippet.length > 0 ? snippet : `Preflight failed with exit code ${result.status ?? -1}`,
      };
    }

    return { version, warning: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { version: "error", warning: message };
  }
}

export function preflightWarningsForBackends(backends: string[]): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const backend of backends) {
    const normalized = backend === "claude-cli" ? "claude" : backend;
    if (!isBackendKey(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);

    if (!availableBackends()[normalized]) {
      warnings.push(`  ${backend}: binary not found on PATH`);
      continue;
    }

    const status = checkBackendStatus(normalized);
    if (status.warning !== null) {
      warnings.push(`  ${backend}: ${status.warning}`);
    }
  }

  return warnings;
}
