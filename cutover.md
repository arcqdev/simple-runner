# TypeScript Cutover Notes

## Primary Product Path

This repo is the primary `kodo` implementation for normal usage. The following workflows are expected to run entirely from the TypeScript codebase:

- interactive and non-interactive runs
- `--test`, `--improve`, and `--fix-from`
- resume, run discovery, and log viewing
- issue archive generation and GitHub issue URL creation
- team management
- local viewer serving
- package update via `kodo update`

No normal user workflow should require checking out or invoking the Python repo.

## Deferred Python-Only Surfaces

The following Python surfaces are intentionally deferred after cutover and are not required for the core CLI path:

- Knowledge mode:
  TS does not yet ship the `kodo/knowledge/*` feature set. The cutover plan is to port it as a dedicated TS subsystem after the core CLI/session/runtime path is stable, rather than blocking cutover on a parallel product line that is not part of the normal run/test/improve flow.
- Benchmark tooling:
  Python benchmark helpers and `tests/test_benchmark.py` coverage remain deferred. The TS plan is to reintroduce benchmark tooling only after the session/runtime layer is finalized, so it measures the real TS orchestration path instead of a transitional scaffold.

## Acceptable Cutover Deviations

These deviations remain acceptable at cutover and are documented instead of treated as hidden parity gaps:

- Viewer UX is functionally complete for local files and HTTP serving, but the HTML/event presentation remains simpler than Python.
- Trace-upload browser affordances are still lighter than Python even though `kodo issue` now prepares and points to the local archive.
- Orchestration still uses the documented TS simplifications in [orchestrator-parity-notes.md](/Users/eddie/dev/arcqdev/simple-runner/orchestrator-parity-notes.md), especially sequential handling where Python previously used broader worktree fan-out.

## Long-Tail Behaviors Closed For Cutover

The audited cutover blockers addressed in TS are:

- banner and next-step copy for non-JSON runs
- `goal.md` preview and reuse prompt
- `kodo issue` archive instructions, browser guidance, and run-folder guidance
- `kodo update` messaging for missing `uv` and failed upgrades
- browser suppression controlled by `KODO_NO_VIEWER`
- regression coverage for malformed subprocess output, viewer serving edge cases, and issue archive scrubbing
