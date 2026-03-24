# Missing Functionality Vs `../kodo`

Baseline:

- Compared repo: `/Users/eddie/dev/arcqdev/kodo`
- This repo: `/Users/eddie/dev/arcqdev/simple-runner`
- Comparison date: March 23, 2026
- Explicitly excluded from this list: Kimi execution support

## Goal

Track the user-visible functionality that still exists in `../kodo` but is missing or materially reduced in this TypeScript implementation.

## Missing Features

### 1. Intake And Goal Refinement

- Core intake flow is now ported in TypeScript.
  - Interactive goal intake can preview `goal.md`, offer quick refine vs interview, and reuse stored intake artifacts.
  - Non-interactive `--goal` / `--goal-file` runs can generate and reuse staged plans.
  - `--auto-refine` now writes a real refined goal artifact instead of acting like a placeholder flag.
  - `--skip-intake` now skips a real intake path rather than a stub.
- Remaining delta:
  - The intake implementation is deterministic/local rather than backend-conversation driven like Python.

### 2. Runtime Team And Config Resolution

- Team config loading is less capable than Python.
  - Missing runtime construction of fully validated executable teams from JSON.
  - Missing Python-equivalent prompt enrichment and role-default injection during team build.
  - Missing verifier-reference validation at Python parity.
- Launch-time team recovery is missing.
  - Python can recover from unavailable backends by offering `kodo teams auto` and retrying.
  - TypeScript has `teams auto`, but not the same launch-time recovery behavior.
- Interactive orchestrator/model selection is reduced.
  - Missing provider/model discovery parity.
  - Missing Ollama model discovery in the config flow.
  - Missing early per-model API-key validation parity.
- JSON/non-interactive launch behavior is thinner.
  - Missing Python-equivalent separation of machine output from human progress output throughout launch.
- Environment handling is reduced.
  - Missing Python’s concurrency-safe environment mutation behavior used around backend selection and session setup.

### 3. Orchestrator Implementations

- Separate orchestrator implementations are not ported.
  - Missing API orchestrator parity.
  - Missing Claude Code orchestrator parity.
  - Missing Codex CLI orchestrator parity.
  - Missing Cursor CLI orchestrator parity.
  - Missing Gemini CLI orchestrator parity.
- The TypeScript runtime currently relies on a single generic orchestration loop instead of the Python set of backend-specific orchestrators.

### 4. Stage Planning And Execution

- Adaptive stage planning is now present.
  - Runtime stage execution re-assesses progress between completed stages.
  - The runtime can inject follow-up stages discovered during execution and stop early when the goal is already complete.
- Parallel stage execution is now present.
  - Stages sharing a `parallel_group` run as a real concurrent stage group.
  - Parallel stage groups execute in isolated per-stage loops and then continue into later sequential stages.
  - Parallel stage groups now execute in isolated git worktrees and merge back persisted changes.

### 5. Verification And Done Semantics

- Verification and done semantics now cover the Python-equivalent normal paths.
  - Full, skip, and quick-check verification modes are available.
  - First-attempt verifier reset and fresh-worker fallback verification are present.
  - Stage-specific verification control and browser-verifier gating are wired through execution.
  - Done handling now normalizes structured signals in addition to legacy text markers.

### 6. Git Worktree Isolation

- Worktree-based execution support is now present.
  - Isolated git worktree creation is used for parallel stage execution.
  - Stale worktree cleanup is implemented.
  - Worktree commit handling is implemented for persisted stage branches.
  - Persisted stage branches merge back into the main branch after completion.
- TypeScript still keeps the simpler repo-level auto-commit behavior for normal sequential execution.

### 7. Resume Behavior

- Resume is present but simpler than Python.
  - Missing richer resume state parity.
  - Missing backend-specific resume injection semantics that Python applies per session type.
  - Missing Python-equivalent pending-exchange resume behavior.

### 8. Logging And Run Accounting

- Rich run accounting is present in TypeScript logs and parsed run state.
  - Per-agent call, token, elapsed-time, and error accounting are captured.
  - Orchestrator cost-bucket metadata is carried through logs and downstream parsing.

### 9. Conversation Capture

- Conversation artifacts are persisted under each run directory in `conversations/`.
  - Archives include those artifacts as part of the normal run payload.
  - Viewer and run parsing can surface the captured conversation paths.

### 10. Viewer Richness

- Viewer richness is now closed at the current parity target.
  - Embedded run index metadata includes run accounting, stage state, conversation artifacts, and per-agent/bucket breakdowns.
  - The TypeScript viewer surfaces richer run summaries, picker filtering, artifact state, and accounting breakdowns in both standalone and served modes.
  - Browser-level verification now covers the main served-viewer and embedded-log behaviors.

### 11. Operational Docs And Support Scripts

- Supporting operational workflows are thinner than Python.
  - Missing Python-equivalent docs/scripts for resume verification.
  - Missing Python-equivalent docs/scripts for viewer verification.
  - Missing Python’s surrounding support assets for these workflows.

### 12. Test Coverage For Missing Areas

- The TypeScript repo does not yet have parity-grade test coverage for the missing areas above.
  - Missing broader orchestration parity coverage for adaptive flows beyond the staged/worktree cases now covered.

## Not Missing Or Good Enough For Normal Use

These areas appear to exist in usable form already, even if the implementation differs from Python:

- Top-level CLI shell and aliases
- `test`, `improve`, and `fix-from` entrypoints
- Run listing
- Basic log viewing
- Basic run resume
- Team management commands
- Basic backend detection
- Basic orchestration loop
- Basic staged plan loading
- Basic verification loop
- Basic auto-commit

## Suggested Priority

### Must-Have For Full Parity

- Intake and goal refinement
- Separate orchestrator implementations
- Adaptive and parallel stage execution
- Verification and done-signal parity
- Git worktree isolation and merge-back
- Richer resume semantics
- Trace upload

### Strongly Desired

- Rich run accounting
- Conversation capture
- Archive scrubbing parity
- Viewer richness
- Launch-time team recovery and config parity

### Nice To Have Or Separate Track

- Operational docs and support scripts
- Expanded parity tests for all of the above
