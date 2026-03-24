import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { ACP_PROTOCOL_VERSION, ACP_BACKEND_PROFILES } from "./acp-contract.js";
import { classifySessionError } from "./sessions.js";
import { ACP_GEMINI_ENV_VARS, defaultModelForBackend } from "../config/models.js";

export type BackendKey = "claude" | "codex" | "cursor" | "gemini-cli" | "opencode" | "kimi";
export type TeamBackend = "claude" | "claude-cli" | "cursor" | "codex" | "gemini-cli" | "opencode";

export type BackendAvailability = Record<BackendKey, boolean>;
export type BackendStatus = {
  version: string;
  warning: string | null;
};

type BackendProfile = {
  defaultModel: string;
  envVars: readonly string[];
  installLink: string;
  key: BackendKey;
  legacyAliases?: readonly TeamBackend[];
  preflight:
    | {
        command: string;
        kind: "cli";
        versionArgs: readonly string[];
      }
    | {
        acpBackend: keyof typeof ACP_BACKEND_PROFILES;
        kind: "acp";
      };
  teamBackends: readonly TeamBackend[];
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

const ACP_READY_TIMEOUT_MS = 15_000;

const BACKEND_PROFILES: Record<BackendKey, BackendProfile> = {
  claude: {
    defaultModel: defaultModelForBackend("claude"),
    envVars: ["ANTHROPIC_API_KEY"],
    installLink: "https://docs.anthropic.com/en/docs/claude-code",
    key: "claude",
    legacyAliases: ["claude-cli"],
    preflight: {
      command: "claude",
      kind: "cli",
      versionArgs: ["--version"],
    },
    teamBackends: ["claude", "claude-cli"],
  },
  codex: {
    defaultModel: defaultModelForBackend("codex"),
    envVars: ["OPENAI_API_KEY"],
    installLink: "https://github.com/openai/codex",
    key: "codex",
    preflight: {
      command: "codex",
      kind: "cli",
      versionArgs: ["--version"],
    },
    teamBackends: ["codex"],
  },
  cursor: {
    defaultModel: defaultModelForBackend("cursor"),
    envVars: [],
    installLink: "https://docs.cursor.com/agent",
    key: "cursor",
    preflight: {
      command: "cursor-agent",
      kind: "cli",
      versionArgs: ["--version"],
    },
    teamBackends: ["cursor"],
  },
  "gemini-cli": {
    defaultModel: defaultModelForBackend("gemini-cli"),
    envVars: ACP_GEMINI_ENV_VARS,
    installLink: "https://github.com/google-gemini/gemini-cli",
    key: "gemini-cli",
    preflight: {
      acpBackend: "gemini",
      kind: "acp",
    },
    teamBackends: ["gemini-cli"],
  },
  opencode: {
    defaultModel: defaultModelForBackend("opencode"),
    envVars: ACP_GEMINI_ENV_VARS,
    installLink: "https://opencode.ai",
    key: "opencode",
    preflight: {
      acpBackend: "opencode",
      kind: "acp",
    },
    teamBackends: ["opencode"],
  },
  kimi: {
    defaultModel: defaultModelForBackend("kimi"),
    envVars: [],
    installLink: "https://platform.moonshot.cn",
    key: "kimi",
    preflight: {
      command: "kimi",
      kind: "cli",
      versionArgs: ["--version"],
    },
    teamBackends: [],
  },
};

const TEAM_BACKEND_TARGETS: Record<TeamBackend, BackendKey> = {
  claude: "claude",
  "claude-cli": "claude",
  codex: "codex",
  cursor: "cursor",
  "gemini-cli": "gemini-cli",
  opencode: "opencode",
};

export function isBackendKey(value: string): value is BackendKey {
  return value in BACKEND_PROFILES;
}

export function isTeamBackend(value: string): value is TeamBackend {
  return value in TEAM_BACKEND_TARGETS;
}

function isExecutable(filePath: string): boolean {
  return existsSync(filePath);
}

export function executableForBackend(backend: BackendKey): string {
  const preflight = BACKEND_PROFILES[backend].preflight;
  return preflight.kind === "acp"
    ? ACP_BACKEND_PROFILES[preflight.acpBackend].transport.command
    : preflight.command;
}

export function installLinkForBackend(backend: BackendKey): string {
  return BACKEND_PROFILES[backend].installLink;
}

export function teamBackendAvailabilityKey(backend: TeamBackend): BackendKey {
  return TEAM_BACKEND_TARGETS[backend];
}

export function availableTeamBackends(): TeamBackend[] {
  return Object.keys(TEAM_BACKEND_TARGETS) as TeamBackend[];
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
    claude: commandOnPath(executableForBackend("claude")),
    codex: commandOnPath(executableForBackend("codex")),
    cursor: commandOnPath(executableForBackend("cursor")),
    "gemini-cli": commandOnPath(executableForBackend("gemini-cli")),
    opencode: commandOnPath(executableForBackend("opencode")),
    kimi: commandOnPath(executableForBackend("kimi")),
  };
}

export function smartModelForBackend(backend: BackendKey): string {
  return BACKEND_PROFILES[backend].defaultModel;
}

function hasRequiredEnvVar(envVars: readonly string[], env: NodeJS.ProcessEnv): boolean {
  return envVars.some((name) => {
    const value = env[name];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function envHint(envVars: readonly string[]): string | null {
  return envVars.length === 0 ? null : `Set one of: ${envVars.join(", ")}`;
}

function checkCliBackendStatus(backend: BackendKey): BackendStatus {
  const profile = BACKEND_PROFILES[backend];
  const preflight = profile.preflight;
  if (preflight.kind !== "cli") {
    return { version: "error", warning: "invalid CLI preflight profile" };
  }

  try {
    const result = spawnSync(preflight.command, [...preflight.versionArgs], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: ACP_READY_TIMEOUT_MS,
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

function checkAcpBackendStatus(backend: BackendKey): BackendStatus {
  const profile = BACKEND_PROFILES[backend];
  const preflight = profile.preflight;
  if (preflight.kind !== "acp") {
    return { version: "error", warning: "invalid ACP preflight profile" };
  }

  const acpProfile = ACP_BACKEND_PROFILES[preflight.acpBackend];
  const initializePayload = {
    id: 1,
    jsonrpc: "2.0",
    method: "initialize",
    params: {
      clientName: "kodo-preflight",
      clientVersion: "0",
      protocolVersion: ACP_PROTOCOL_VERSION,
      requestedCapabilities: {
        initialize: true,
        prompt: true,
        resume: true,
        sessionLifecycle: true,
        streaming: true,
        usage: true,
      },
    },
  };
  const shutdownPayload = {
    id: 2,
    jsonrpc: "2.0",
    method: "shutdown",
    params: {},
  };

  try {
    const result = spawnSync(acpProfile.transport.command, acpProfile.transport.args, {
      encoding: "utf8",
      input: `${JSON.stringify(initializePayload)}\n${JSON.stringify(shutdownPayload)}\n`,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: ACP_READY_TIMEOUT_MS,
    });

    if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
      return { version: "timeout", warning: "ACP initialize timed out (15 s)" };
    }

    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const lines = stdout
      .split(/\r?\n/gu)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const responses = lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    const initResponse = responses.find((entry) => entry.id === 1);
    const initResult =
      typeof initResponse?.result === "object" && initResponse.result !== null
        ? (initResponse.result as Record<string, unknown>)
        : null;
    const capabilities =
      typeof initResult?.capabilities === "object" && initResult.capabilities !== null
        ? (initResult.capabilities as Record<string, unknown>)
        : null;
    const serverName =
      typeof capabilities?.serverName === "string" && capabilities.serverName.length > 0
        ? capabilities.serverName
        : acpProfile.transport.command;
    const serverVersion =
      typeof capabilities?.serverVersion === "string" && capabilities.serverVersion.length > 0
        ? capabilities.serverVersion
        : null;
    const version =
      serverVersion === null ? `${serverName} (ACP ready)` : `${serverName} ${serverVersion}`;

    if (initResult === null || capabilities === null) {
      const snippet = [stderr.trim(), stdout.trim()].filter((part) => part.length > 0).join("\n");
      return {
        version: "error",
        warning:
          snippet.length > 0
            ? `ACP initialize failed: ${snippet.slice(0, 200)}`
            : "ACP initialize failed: malformed response from server.",
      };
    }

    const envWarning = hasRequiredEnvVar(profile.envVars, process.env)
      ? null
      : `${backend}: ACP transport is reachable, but credentials are missing. ${envHint(profile.envVars)}`;

    if (result.status !== 0) {
      const snippet = [stderr.trim(), stdout.trim()].filter((part) => part.length > 0).join("\n");
      return {
        version,
        warning:
          snippet.length > 0
            ? `ACP transport exited early: ${snippet.slice(0, 200)}`
            : `ACP transport exited with code ${result.status ?? -1}`,
      };
    }

    return {
      version,
      warning: envWarning,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { version: "error", warning: `ACP preflight failed: ${message}` };
  }
}

export function checkBackendStatus(backend: BackendKey): BackendStatus {
  return BACKEND_PROFILES[backend].preflight.kind === "acp"
    ? checkAcpBackendStatus(backend)
    : checkCliBackendStatus(backend);
}

export function preflightWarningsForBackends(backends: string[]): string[] {
  const warnings: string[] = [];
  const seen = new Set<BackendKey>();
  const installed = availableBackends();

  for (const backend of backends) {
    if (!isTeamBackend(backend)) {
      continue;
    }
    const normalized = teamBackendAvailabilityKey(backend);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);

    if (!installed[normalized]) {
      warnings.push(
        `  ${backend}: backend unavailable. Install ${normalized} from ${installLinkForBackend(normalized)}`,
      );
      continue;
    }

    const status = checkBackendStatus(normalized);
    if (status.warning !== null) {
      warnings.push(`  ${backend}: ${status.warning}`);
    }
  }

  return warnings;
}
