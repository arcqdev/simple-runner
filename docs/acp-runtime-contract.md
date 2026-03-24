# ACP Runtime Contract

## Goal

This document defines the ACP-facing runtime contract for the current runtime. It records the remaining compatibility assumptions around orchestration state and logging now that session execution goes through ACP by default.

The typed source of truth lives in `src/runtime/acp-contract.ts`. This document explains why those types look the way they do and how they map onto the current code.

## Current Runtime Assumptions

### `src/runtime/sessions.ts`

- Session execution is ACP-backed for Gemini and OpenCode.
- Session identity is still persisted as a single string in orchestration state, even though ACP provides a richer conversation locator.
- Streaming output is still collapsed into a single `SessionQueryResult.text` plus optional `rawMessages` log output.
- Usage accounting and provider metadata are normalized from ACP events before they hit the existing logging surface.

### `src/runtime/orchestration.ts`

- Runtime state persists agent resume state as `Record<string, string>` in `agentSessionIds`.
- Orchestration assumes one active conversation handle per agent and a single terminal response per query cycle.
- Parallel stages store `sessionId` as nullable string state, which means resume currently cannot distinguish transport session identity from provider thread identity.
- Agent creation gates only on local backend availability and immediately constructs a queryable session object.

### `src/runtime/backends.ts`

- Backend discovery still checks local executables, but ACP-backed preflight now verifies transport startup for Gemini and OpenCode.
- Team-facing backend names still flow through `TEAM_BACKEND_MAP`, with Gemini and OpenCode as the ACP-native runtime choices.
- Legacy backend names can still appear in config and logs as compatibility inputs, but they are no longer the primary runtime path.

## ACP Contract

The repository-owned ACP contract is defined in `src/runtime/acp-contract.ts` and has these required layers:

- Transport startup/shutdown:
  Start a long-lived ACP transport explicitly and stop it explicitly. The initial transport shape is `stdio`.
- Initialize and capability negotiation:
  Send an initialize request with client identity and requested capabilities, then persist the negotiated capabilities for the session.
- Session/thread creation and resume:
  Store an `AcpConversationLocator` with `conversationId` plus optional `providerThreadId` and `serverSessionId`. Later runtime code must persist this object, not a single opaque string.
- Prompt submission:
  Submit prompts against an existing `AcpSessionHandle` with cwd, max turns, and metadata separated from transport startup.
- Streamed events and terminal results:
  Normalize server output into `AcpStreamEvent[]` and a final `AcpTerminalResult`. Streaming deltas, tool activity, warnings, and usage updates are first-class protocol events even if current logging still collapses them later.
- Usage accounting:
  Normalize usage into `AcpUsage` and preserve raw provider payloads when available.
- Structured errors and retryable failures:
  Failures are represented as `AcpRuntimeError` with stable codes and an explicit `retryable` flag.

## Gemini and OpenCode Mapping

### Decision

Gemini and OpenCode are both:

- Separate ACP backend kinds, because they are expected to run as different ACP server processes with potentially different event/resume semantics.
- Provider profiles on the same Gemini credential family, because both should initially authenticate with `GEMINI_API_KEY` or `GOOGLE_API_KEY`.

### Gemini

- ACP backend kind: `gemini`
- Provider: `gemini`
- Team backend mapping: existing `gemini-cli` team/backend settings map here
- Default model: `gemini-3-flash`

### OpenCode

- ACP backend kind: `opencode`
- Provider: `gemini`
- Team backend mapping: exposed directly as the `opencode` team/runtime choice
- Default model: `gemini-2.5-flash`
- Credential behavior: reuse Gemini credentials and provider defaults unless a later spec introduces an OpenCode-specific provider profile

## Known Semantic Gaps

- Current `SessionQueryResult` still assumes one terminal text result even though ACP emits richer streamed events.
- Current runtime state persists a bare session id string. ACP provides a structured locator that should eventually be persisted directly.
- Cost buckets are still coarse and backend-shaped even though ACP can surface richer provider accounting.

## Implementation Guardrails For Later Specs

- Keep user-facing backend labels stable where compatibility still matters.
- Continue translating the existing `Session` and orchestration state onto ACP until runtime state persists structured locators directly.
- Preserve raw ACP events in logs whenever feasible so future debugging does not regress to vendor-specific parsing.
