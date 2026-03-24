# ACP Runtime Contract

## Goal

This document defines the ACP-facing runtime contract that later implementation specs must target. It captures the current session-layer assumptions in the subprocess runtime and names the semantic gaps that ACP needs to close during migration.

The typed source of truth lives in `src/runtime/acp-contract.ts`. This document explains why those types look the way they do and how they map onto the current code.

## Current Runtime Assumptions

### `src/runtime/sessions.ts`

- Session execution is synchronous and subprocess-based: `Session.query()` blocks until one vendor CLI exits.
- Session identity is a single opaque string, but the concrete field name is vendor-shaped: `session_id` for Claude/Codex/Gemini and `chat_id` for Cursor.
- Prompt submission is coupled to process startup. There is no persistent transport lifecycle, initialize handshake, or capability negotiation.
- Streaming output is collapsed into a single `SessionQueryResult.text` plus optional `rawMessages` log output.
- Usage accounting is best-effort and adapter-specific.
- Error handling is inferred from exit code, stderr/stdout snippets, and regex classifiers rather than structured protocol errors.
- Gemini resume is not a true conversation locator today. The adapter toggles `--resume` and stores `"last"` as a synthetic session id when usage exists.

### `src/runtime/orchestration.ts`

- Runtime state persists agent resume state as `Record<string, string>` in `agentSessionIds`.
- Orchestration assumes one active conversation handle per agent and a single terminal response per query cycle.
- Parallel stages store `sessionId` as nullable string state, which means resume currently cannot distinguish transport session identity from provider thread identity.
- Agent creation gates only on local backend availability and immediately constructs a queryable session object.

### `src/runtime/backends.ts`

- Backend discovery is executable-based (`claude`, `codex`, `cursor-agent`, `gemini`).
- Team-facing backend names are mapped directly to executable/preflight keys through `TEAM_BACKEND_MAP`.
- Preflight validates `--version` on binaries and reuses subprocess error classification to guess configuration/auth problems.

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
- Team backend mapping during migration: existing `gemini-cli` team/backend settings map here first
- Default model: `gemini-3-flash`

### OpenCode

- ACP backend kind: `opencode`
- Provider: `gemini`
- Team backend mapping during migration: not exposed as a team backend yet
- Default model: `gemini-2.5-flash`
- Credential behavior: reuse Gemini credentials and provider defaults unless a later spec introduces an OpenCode-specific provider profile

## Known Semantic Gaps

- Current `SessionQueryResult` assumes one terminal text result. ACP supports richer event streams, so adapters will need a normalization layer instead of lossy direct parsing.
- Current runtime state persists a bare session id string. ACP requires a structured locator to resume safely across transports and providers.
- Current preflight checks binary presence and `--version`. ACP preflight will need to verify transport startup and initialize/capability negotiation, not just executable existence.
- Current session timeouts kill the whole subprocess query. ACP introduces transport startup timeouts, per-query timeouts, and server-side retryable failures that need separate handling.
- Current Gemini resume behavior is weaker than ACP resume requirements and must not be treated as equivalent.
- Cost buckets are currently backend-fixed strings. ACP usage may come from provider profiles or server-emitted accounting, so the accounting layer must tolerate both.

## Implementation Guardrails For Later Specs

- Keep user-facing backend labels stable while migration is in progress.
- Translate existing `Session` and orchestration state onto ACP as a compatibility layer first; do not force a full runtime rewrite in one spec.
- Preserve raw ACP events in logs whenever feasible so future debugging does not depend on vendor-specific parsers again.
