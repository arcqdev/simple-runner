# Spec 0008: Complete Run State And Viewer Parity

## Status

Pending.

## Goal

Finish the run-state, logging, resume, and viewer work so TS-generated artifacts match the Python workflow closely enough for normal usage.

## Required Work

- Port run directory management, stats/report helpers, replay/log formatting, and resume bookkeeping.
- Preserve on-disk artifact names and layout unless a compatibility shim is added intentionally.
- Finish `kodo logs` HTTP-serving behavior and any remaining viewer asset/trace-upload support.
- Ensure TS-generated run data is compatible with the expected CLI workflows.
- Match the audited artifact and compatibility details:
  - read `log.jsonl` with legacy `run.jsonl` fallback
  - preserve `goal.md`, `goal-refined.md`, `goal-plan.json`, `config.json`, `team.json`, `improve-report.md`, `test-report.md`, and `run.tar.gz`
  - reconstruct failed-before-start runs from `cli_args` when `run_start` is missing
- Expand TS log coverage toward the Python event contract, especially:
  - session lifecycle events
  - stage and parallel-group events
  - preflight/auto-commit/persist events
  - viewer-consumed orchestrator tool events
- Port the richer `viewer.html` expectations:
  - embedded run index metadata
  - timeline rendering for cycle/exchange/tool events
  - `/api/log/<run_id>` compatibility
  - trace-upload affordances gated by `KODO_TRACE_UPLOAD`

## Acceptance Criteria

- `runs`, `logs`, `resume`, issue-reporting, and viewer flows work against TS-generated run data.
- Artifact names and layout are stable and documented.
- Regression tests cover the critical log/viewer/resume flows that are still missing.
