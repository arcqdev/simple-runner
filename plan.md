# Runner ACP Plan

## Purpose

Add a top-level ACP interface for `simple-runner` itself so an ACP client can:

- start a run in an ACP-native way
- watch the run progress live
- observe orchestrator and worker activity as the run proceeds
- receive a terminal run result with artifact references

This must be done without breaking the existing CLI workflow.

## Hard Separation: Two Different ACP Layers

This repository will have two distinct ACP concepts. They must not be blended in naming, code structure, logs, or docs.

### 1. Runner ACP

Runner ACP is the public ACP surface exposed by `simple-runner`.

Its job is to let an external client talk to the runner as a whole:

- create a run
- observe run lifecycle events
- reconnect to a run
- receive final status and artifacts

Runner ACP is about orchestration-level control and observability.

### 2. Worker ACP

Worker ACP is the private implementation detail used by `simple-runner` when it talks to worker backends such as Gemini or OpenCode.

Its job is to let the orchestrator communicate with underlying agents:

- create or resume worker sessions
- send prompts to workers
- consume worker streaming events
- normalize usage and provider metadata

Worker ACP is not the public API of the runner.

### Rule

Runner ACP must never expose worker ACP transport shapes directly. If worker ACP changes, runner ACP should remain stable.

## Explicit Terminology

Use the following names consistently:

- `runner ACP`: the public ACP server exposed by this repo
- `worker ACP`: the private ACP client/runtime used for agent backends
- `run`: one top-level execution of `simple-runner`
- `worker session`: one underlying backend session used by a worker or orchestrator agent
- `run handle`: the runner ACP identity for a run
- `worker locator`: the private ACP locator for a backend conversation

Never call a worker locator a run handle.
Never call a run handle a session id.
Never reuse worker ACP event names as runner ACP event names unless they are deliberately normalized first.

## Goals

- Preserve the existing CLI: `simple-runner ...` remains a first-class entry point.
- Add a new ACP-native entry point for launching and observing runs.
- Stream structured progress and activity events live.
- Preserve current run logs and viewer compatibility.
- Keep worker ACP hidden behind internal runtime boundaries.

## Non-Goals

- No steering of active workers over runner ACP.
- No external tool injection into a running orchestrator.
- No direct exposure of vendor-specific worker ACP envelopes.
- No requirement that runner ACP support every worker ACP event one-to-one.
- No replacement of the current CLI UX.

## Architectural Decision

The correct model is:

- `simple-runner` remains the orchestrator and run owner
- runner ACP wraps the runner
- worker ACP remains behind the runtime/session layer

The incorrect model is:

- exposing underlying Gemini/OpenCode ACP sessions as if they were the runner API
- making external clients reason about backend-specific worker session locators
- letting runner ACP become a thin proxy over worker ACP

## Existing Seams To Reuse

The current codebase already has useful boundaries:

- CLI entrypoint in `src/cli/main.ts`
- execution entry in `src/runtime/engine.ts`
- orchestration lifecycle in `src/runtime/orchestration.ts`
- worker session runtime in `src/runtime/sessions.ts`
- worker ACP transport and normalization in `src/runtime/acp-transport.ts`, `src/runtime/acp-normalization.ts`, and `src/runtime/acp-contract.ts`
- log persistence in `src/logging/log.ts`
- run/viewer reconstruction in `src/logging/runs.ts` and `src/viewer.ts`

The plan should build on those seams instead of replacing them.

## Target Design

### Public entry points

Keep:

- existing CLI entrypoint for interactive and script usage

Add:

- `simple-runner --acp` or a dedicated `simple-runner-acp` binary

The ACP entry point should host the runner ACP server.

### Shared execution layer

Extract a programmatic run-launch API below the CLI parser, something conceptually like:

- `startRun(request, sinks)`
- `resumeRun(request, sinks)`

Both the CLI and runner ACP server should call this shared execution layer.

The CLI remains responsible for:

- argument parsing
- TTY prompts
- printing terminal-oriented output

The shared execution layer becomes responsible for:

- run creation
- run lifecycle execution
- structured event emission
- artifact production

### Event bus

Add an internal event subscriber mechanism alongside the current JSONL logging.

Requirements:

- every important run event is still written to `log.jsonl`
- the same event can also be published to in-process subscribers
- runner ACP subscribes to that in-process stream
- the current viewer can continue to rely on logs

The runner ACP server should not tail files to get live updates if an in-process event bus is available.

## Event Model Separation

### Runner ACP events

Runner ACP should publish normalized run-level events such as:

- `run.started`
- `run.resumed`
- `run.preflight.started`
- `run.preflight.completed`
- `planning.started`
- `planning.completed`
- `stage.started`
- `stage.completed`
- `cycle.started`
- `cycle.completed`
- `agent.started`
- `agent.progress`
- `agent.completed`
- `tool.call`
- `tool.result`
- `warning`
- `run.completed`
- `run.failed`

These are runner-owned events. They are stable, product-level events.

### Worker ACP events

Worker ACP events remain internal and backend-shaped, for example:

- `session.created`
- `session.resumed`
- `message.delta`
- `message.completed`
- `tool.call`
- `tool.result`
- `usage`
- `warning`
- `result`

These are transport/runtime events for backend sessions, not the public run API.

### Mapping rule

Worker ACP events may be translated into runner ACP events, but only after normalization.

Examples:

- worker `message.delta` can become runner `agent.progress`
- worker `tool.call` can become runner `tool.call`
- worker `result` can contribute to runner `agent.completed`

Do not forward raw worker ACP notifications as runner ACP notifications.

## Identity Model

### Runner ACP identity

Runner ACP should identify work using a run-level handle, derived from the run id.

This handle represents:

- one `simple-runner` run
- its current lifecycle state
- its artifacts and summary

### Worker ACP identity

Worker ACP identity remains private and may include:

- conversation id
- provider thread id
- server session id

These locators are implementation details owned by the worker runtime.

### Rule

A runner ACP client should never need a worker ACP locator to observe or resume a run.

## Logging and Observability

The current log is the canonical audit trail.

Runner ACP should:

- consume structured runtime events as they happen
- emit normalized notifications to clients
- include the run id in every notification
- surface artifact paths and status transitions

Worker ACP details can still be preserved in logs for debugging, but those details should be treated as internal metadata.

### Minimum live visibility

An ACP client should be able to see:

- when the run starts
- when planning starts and ends
- when a stage or parallel group starts
- when a worker is dispatched
- what worker/tool activity is happening at a high level
- when a cycle completes
- whether the run finished, failed, or was interrupted

## Phased Implementation

### Phase 1: Shared run entrypoint

- extract a programmatic execution API from the CLI path
- keep CLI behavior unchanged
- make the execution API independent from terminal output concerns

Acceptance criteria:

- CLI still works unchanged
- a non-CLI caller can start a run programmatically

### Phase 2: Internal run event bus

- add a subscriber-based event stream for runtime/log events
- keep JSONL logging as-is
- publish key lifecycle events from engine, orchestration, and sessions

Acceptance criteria:

- run logs still reconstruct correctly
- an in-process subscriber can observe a full run without reading files

### Phase 3: Runner ACP protocol surface

- add a runner ACP server entrypoint
- implement initialize/session lifecycle/start/resume/streaming/final result
- define runner ACP request and notification schemas in a dedicated module

Acceptance criteria:

- an ACP client can start a run
- an ACP client receives live run notifications
- the final result contains status, summary, run id, and artifact references

### Phase 4: Worker-to-runner event normalization

- map worker ACP and orchestration events into runner ACP events
- preserve enough information for live visibility without leaking backend-specific envelopes
- keep usage/provider metadata available as structured optional details

Acceptance criteria:

- orchestrator and worker activity is understandable from runner ACP alone
- no consumer needs Gemini/OpenCode-specific event parsing

### Phase 5: Resume and reconnect

- support reconnecting to a run by run handle
- expose current run state and final artifacts for completed runs
- keep worker session resume private

Acceptance criteria:

- runner ACP resume/reconnect works even if worker session ids are opaque
- reconnect does not require access to backend conversation locators

### Phase 6: Tests and docs

- add unit tests for runner ACP event mapping
- add integration tests for launch, stream, complete, and reconnect
- document the boundary between runner ACP and worker ACP in repo docs

Acceptance criteria:

- clear test coverage for the public runner ACP contract
- docs make the two layers hard to confuse

## File Plan

Likely additions:

- `src/runner-acp/contract.ts`
- `src/runner-acp/server.ts`
- `src/runner-acp/normalization.ts`
- `src/runner-acp/types.ts`

Likely refactors:

- `src/cli/main.ts`
- `src/runtime/engine.ts`
- `src/runtime/orchestration.ts`
- `src/runtime/sessions.ts`
- `src/logging/log.ts`

Likely tests:

- `test/runner-acp/*.test.ts`
- integration coverage around CLI parity and ACP launch behavior

## Naming Guardrails

These rules are mandatory:

- do not place runner ACP types in `src/runtime/acp-*`
- do not name runner ACP types as generic `Acp*` if they are runner-specific
- do not expose worker ACP locators in runner ACP return types
- do not expose raw backend notifications in runner ACP streams
- do not call a run “session” unless the type explicitly means runner ACP session

Preferred naming:

- `RunnerAcpServer`
- `RunnerAcpEvent`
- `RunnerAcpRunHandle`
- `WorkerAcpLocator`
- `WorkerAcpTransport`

## Risks

### Risk 1: Layer collapse

The biggest risk is accidentally turning runner ACP into a pass-through for worker ACP.

Mitigation:

- separate modules
- separate naming
- separate event schemas
- separate identity types

### Risk 2: Dual observability systems

Another risk is building a new live event pipeline that diverges from log output.

Mitigation:

- keep one canonical runtime event stream
- log it to JSONL
- publish the same events to in-process subscribers

### Risk 3: Resume confusion

A run-level reconnect can be confused with a worker-session resume.

Mitigation:

- runner ACP resume is run-centric
- worker ACP resume remains internal
- use distinct type names everywhere

## Final Acceptance Criteria

The work is complete when all of the following are true:

- the existing CLI still works unchanged
- `simple-runner` can be launched through a runner ACP entry point
- an ACP client can watch live orchestrator and worker activity in runner terms
- the public ACP surface does not require understanding Gemini/OpenCode ACP
- worker ACP remains an internal implementation detail
- docs and type names make the separation obvious
