# ACP Port Plan

## Assumption

This plan assumes ACP means Agent Client Protocol and that this repository should standardize its session/runtime boundary on ACP instead of directly invoking vendor-specific CLI command shapes.

## Goal

Replace the current subprocess adapter layer with an ACP-based runtime while keeping the current user-facing `kodo` flows working during the migration. The target backend set for this migration includes the current CLI surfaces plus Gemini and OpenCode, with OpenCode expected to run on the Gemini provider path where that keeps the stack simpler. The plan is staged so the Ralph loop can execute independent specs with clear acceptance criteria and minimal cross-spec ambiguity.

## Migration Strategy

1. Define the ACP contract this repo will own.
2. Add an ACP transport/session layer beside the current CLI adapters.
3. Add Gemini and OpenCode backend/profile support on top of that ACP layer.
4. Migrate orchestrator and team-agent creation onto the ACP layer behind a flag.
5. Port resume, usage accounting, logging, and error handling.
6. Cut config, docs, and tests over to ACP as the primary path.
7. Remove the legacy direct-CLI session adapters once ACP parity is proven.

## Scope Breakdown

### Core runtime

- Introduce ACP transport abstractions for initialize, session/thread lifecycle, prompt submission, streaming events, tool calls, usage events, and resume.
- Normalize ACP events into the existing internal `SessionQueryResult` shape or replace that shape where it blocks parity.
- Preserve non-ACP API orchestrator behavior only where it is intentionally distinct.

### Configuration

- Add ACP-capable backend definitions and config validation.
- Decide whether vendor names remain user-facing or collapse into an ACP transport plus provider profile model.
- Add an explicit story for Gemini-native execution and OpenCode-over-Gemini execution, including model defaults and environment requirements.
- Add feature flags for incremental rollout and fallback.

### Reliability

- Preserve timeouts, structured errors, retries, and run logging.
- Keep preflight useful by validating ACP executables/endpoints instead of raw vendor CLI presence.
- Keep resume semantics stable across interrupted runs.

### Testing

- Add unit coverage for ACP event parsing and transport failures.
- Add integration coverage for orchestrator and team-agent flows on ACP.
- Expand Docker coverage so Gemini is exercised in the e2e path and OpenCode is at least smoke-tested with the Gemini provider configuration until first-class runtime support lands.
- Add regression tests for logs, resume, and accounting.

### Cutover

- Update docs and defaults.
- Make ACP the default runtime path.
- Remove legacy direct subprocess session adapters after parity checks pass.
