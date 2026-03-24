import type { JsonObject } from "./json.js";

/**
 * Stable ACP-facing runtime contract for the staged migration away from
 * vendor-specific subprocess sessions in src/runtime/sessions.ts.
 *
 * The current Session interface stays in place until implementation specs
 * switch orchestration onto ACP, but new ACP work should target the types in
 * this module so transport/session semantics stay consistent.
 */

export const ACP_PROTOCOL_VERSION = "0.1";

export type AcpTransportKind = "stdio";
export type AcpBackendKind = "gemini" | "opencode";
export type AcpProviderKind = "gemini";
export type AcpConversationLocator = {
  conversationId: string;
  providerThreadId?: string | null;
  serverSessionId?: string | null;
};

export type AcpTransportConfig = {
  kind: AcpTransportKind;
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
};

export type AcpTransportCapabilities = {
  initialize: true;
  prompt: true;
  sessionLifecycle: true;
  streaming: true;
  usage: boolean;
  resume: boolean;
};

export type AcpNegotiatedCapabilities = AcpTransportCapabilities & {
  serverName: string;
  serverVersion?: string;
  protocolVersion: string;
};

export type AcpInitializeRequest = {
  protocolVersion: string;
  clientName: string;
  clientVersion: string;
  requestedCapabilities: AcpTransportCapabilities;
};

export type AcpInitializeResult = {
  capabilities: AcpNegotiatedCapabilities;
  instructions?: string | null;
};

export type AcpBackendProfile = {
  backendKind: AcpBackendKind;
  provider: AcpProviderKind;
  defaultModel: string;
  envVars: string[];
  teamBackends: string[];
  supportsResume: boolean;
  transport: AcpTransportConfig;
  notes?: string[];
};

export type AcpSessionCreateRequest = {
  backend: AcpBackendKind;
  model: string;
  systemPrompt?: string | null;
  cwd: string;
  metadata?: JsonObject;
};

export type AcpSessionResumeRequest = {
  backend: AcpBackendKind;
  locator: AcpConversationLocator;
  model?: string;
  cwd: string;
  metadata?: JsonObject;
};

export type AcpSessionHandle = {
  backend: AcpBackendKind;
  locator: AcpConversationLocator;
  model: string;
  capabilities: AcpNegotiatedCapabilities;
};

export type AcpPromptRequest = {
  prompt: string;
  cwd: string;
  maxTurns: number;
  metadata?: JsonObject;
};

export type AcpUsage = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
  raw?: JsonObject | null;
};

export type AcpNormalizedEvent = {
  event: AcpStreamEvent;
  raw?: JsonObject | null;
};

export type AcpStreamEvent =
  | {
      type: "session.created";
      locator: AcpConversationLocator;
      model: string;
      backend: AcpBackendKind;
    }
  | {
      type: "session.resumed";
      locator: AcpConversationLocator;
      model: string;
      backend: AcpBackendKind;
    }
  | {
      type: "message.delta";
      delta: string;
    }
  | {
      type: "message.completed";
      text: string;
    }
  | {
      type: "tool.call";
      toolName: string;
      input?: JsonObject | null;
    }
  | {
      type: "tool.result";
      toolName: string;
      output?: JsonObject | null;
      isError?: boolean;
    }
  | {
      type: "usage";
      usage: AcpUsage;
    }
  | {
      type: "warning";
      message: string;
      code?: string;
      retryable?: boolean;
    }
  | {
      type: "error";
      error: AcpRuntimeError;
    }
  | {
      type: "result";
      result: AcpTerminalResult;
    };

export type AcpTerminalStopReason =
  | "completed"
  | "cancelled"
  | "failed"
  | "timed_out"
  | "interrupted";

export type AcpTerminalResult = {
  stopReason: AcpTerminalStopReason;
  text: string;
  usage?: AcpUsage | null;
  locator: AcpConversationLocator;
  raw?: JsonObject | null;
};

export type AcpRuntimeErrorCode =
  | "transport_start_failed"
  | "transport_shutdown_failed"
  | "initialize_failed"
  | "capability_mismatch"
  | "session_create_failed"
  | "session_resume_failed"
  | "prompt_rejected"
  | "prompt_failed"
  | "stream_protocol_error"
  | "timeout"
  | "unauthorized"
  | "rate_limited"
  | "service_unavailable"
  | "unsupported";

export type AcpRuntimeError = {
  code: AcpRuntimeErrorCode;
  message: string;
  retryable: boolean;
  backend?: AcpBackendKind;
  statusCode?: number;
  details?: JsonObject | null;
};

export type AcpQueryOutcome =
  | {
      ok: true;
      result: AcpTerminalResult;
      events: AcpNormalizedEvent[];
      usage: AcpUsage | null;
    }
  | {
      ok: false;
      error: AcpRuntimeError;
      events: AcpNormalizedEvent[];
      usage: AcpUsage | null;
      locator?: AcpConversationLocator;
    };

/**
 * Gemini and OpenCode stay distinct backend kinds because they expose distinct
 * ACP server binaries and resume semantics, but they both map to the Gemini
 * provider credential family for now.
 */
export const ACP_BACKEND_PROFILES: Record<AcpBackendKind, AcpBackendProfile> = {
  gemini: {
    backendKind: "gemini",
    provider: "gemini",
    defaultModel: "gemini-3-flash",
    envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    teamBackends: ["gemini-cli"],
    supportsResume: true,
    transport: {
      kind: "stdio",
      command: "gemini",
      args: ["acp"],
    },
    notes: [
      "Primary ACP backend for Gemini-native execution.",
      "Model defaults should follow existing Gemini CLI defaults unless team config overrides them.",
    ],
  },
  opencode: {
    backendKind: "opencode",
    provider: "gemini",
    defaultModel: "gemini-2.5-flash",
    envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    teamBackends: ["opencode"],
    supportsResume: true,
    transport: {
      kind: "stdio",
      command: "opencode",
      args: ["acp", "--provider", "gemini"],
    },
    notes: [
      "OpenCode is a separate ACP backend kind, not just an alias, because its server process and event framing are expected to differ from Gemini's native server.",
      "OpenCode should inherit Gemini credentials and default to Gemini provider/model settings unless an explicit OpenCode profile is added later.",
    ],
  },
};
