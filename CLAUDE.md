# simple-runner notes

## What this repo is

`simple-runner` is a run orchestrator. It owns:

- CLI entry and run launch
- orchestration lifecycle
- run logs and artifacts
- viewer/readback of past runs

It does not expose backend agent protocols directly as its public API.

## Important code seams

- `src/cli/main.ts`: CLI entrypoint and user-facing argument flow
- `src/runtime/engine.ts`: run startup and execution entry
- `src/runtime/orchestration.ts`: orchestrator loop, stage/cycle flow, agent dispatch
- `src/runtime/sessions.ts`: worker session runtime
- `src/runtime/acp-*`: worker ACP transport/normalization for backend agents
- `src/logging/log.ts`: canonical run event log writer
- `src/logging/runs.ts`: run reconstruction
- `src/viewer.ts`: viewer and run inspection

## ACP rule: keep the two layers separate

There are two ACP layers in this repo.

### Runner ACP

Runner ACP is the public API of `simple-runner`.

It should let a client:

- start a run
- reconnect to a run
- observe run progress
- receive final status and artifacts

Runner ACP is run-level.

### Worker ACP

Worker ACP is private runtime plumbing used when the runner talks to Gemini/OpenCode-style backends.

It handles:

- backend session create/resume
- prompt/response exchange
- worker streaming events
- usage/provider metadata

Worker ACP is session-level.

### Non-negotiable boundary

- Do not expose worker ACP transports as the runner API.
- Do not expose worker locators as run handles.
- Do not forward raw backend ACP envelopes to runner clients.
- Do not put runner ACP types in `src/runtime/acp-*`.
- Do not use ambiguous names that blur run identity and worker session identity.

## Naming rules

Prefer:

- `RunnerAcp*` for public runner ACP types
- `WorkerAcp*` for internal backend/session ACP types
- `runHandle` for runner identity
- `workerLocator` for backend conversation identity

Avoid:

- `AcpSession` when you mean a run handle
- `sessionId` when you mean run id
- generic `Acp*` types for runner-specific contracts

## Design rules

- Keep the current CLI working.
- Runner ACP should wrap the shared run execution path, not replace it.
- Logs stay canonical; live updates should come from structured runtime events.
- Viewer and ACP should consume the same normalized run story where possible.
- Resume at runner ACP is run-centric. Worker ACP resume stays internal.

## If you touch ACP code

Check these before finishing:

1. Is this public runner ACP or private worker ACP?
2. Does the type/module name make that obvious?
3. Would a client need Gemini/OpenCode-specific knowledge to consume this?
4. Did a worker session identity leak into the runner API?

If any answer is bad, fix the boundary first.
