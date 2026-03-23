import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type BackendKey = "claude" | "codex" | "cursor" | "gemini-cli" | "kimi";
export type TeamBackend = "claude" | "claude-cli" | "cursor" | "codex" | "gemini-cli";

export type BackendAvailability = Record<BackendKey, boolean>;

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

function commandOnPath(command: string): boolean {
  const pathValue = process.env.PATH ?? "";
  const homeDir = os.homedir();

  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const resolvedDir = directory.startsWith("~") ? path.join(homeDir, directory.slice(1)) : directory;
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
