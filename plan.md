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

- Adaptive stage planning is missing.
  - Missing advisor-driven reassessment between stages.
  - Missing dynamic next-stage generation based on completed work.
- Parallel stage execution is missing.
  - Missing parallel stage groups.
  - Missing isolated parallel execution loops per stage group.
- Static staged execution exists, but it is materially simpler than Python’s staged execution model.

### 5. Verification And Done Semantics

- Verification is reduced.
  - Missing Python’s richer verification modes such as full, skip, and quick-check behavior.
  - Missing reset-on-first-attempt verification semantics.
  - Missing fresh-worker fallback verification behavior.
  - Missing richer verifier dictionaries and stage-specific verification control.
- Done-signal handling is reduced.
  - TypeScript currently depends on parsing textual markers such as `GOAL_DONE`, `END_CYCLE`, and `RAISE_ISSUE`.
  - Missing Python’s richer structured done-signal handling and normalization logic.

### 6. Git Worktree Isolation

- Worktree-based execution support is not ported.
  - Missing isolated git worktree creation for parallel stage execution.
  - Missing stale worktree cleanup.
  - Missing worktree commit handling.
  - Missing branch merge-back behavior for persisted work.
- TypeScript only has simpler repo-level auto-commit behavior.

### 7. Resume Behavior

- Resume is present but simpler than Python.
  - Missing richer resume state parity.
  - Missing backend-specific resume injection semantics that Python applies per session type.
  - Missing Python-equivalent pending-exchange resume behavior.

### 8. Logging And Run Accounting

- Rich live run accounting is not ported.
  - Missing per-agent call counts.
  - Missing per-agent token accounting parity.
  - Missing per-agent elapsed-time accounting parity.
  - Missing per-agent error-count accounting parity.
  - Missing orchestrator cost-bucket accounting parity.
- TypeScript logging is functional, but the Python run-stats layer is not present.

### 9. Conversation Capture

- Conversation artifact capture is missing.
  - Archives can include `conversations/` if such files exist.
  - The TypeScript runtime does not currently persist those per-agent conversation artifacts the way Python does.

### 10. Trace Upload

- Trace upload is not ported.
  - Missing best-effort archive upload to remote storage.
  - Missing metadata indexing behavior.
  - Missing run-teardown upload behavior.
- Viewer/UI mentions around trace upload are not equivalent to the actual Python functionality.

### 11. Archive Scrubbing

- Archive scrubbing is reduced.
  - Current TypeScript behavior is limited to a narrow regex-based redaction pass.
  - Missing Python-equivalent secret scanning.
  - Missing Python-equivalent PII cleaning.
  - Missing Python-equivalent archive scrubbing depth for shared run artifacts.

### 12. Summarization

- LLM-backed summarization is not ported.
  - Missing asynchronous summarizer behavior.
  - Missing Ollama-backed summarization fallback.
  - Missing Gemini-backed summarization fallback.
  - Missing accumulated cycle-summary generation parity.

### 13. Viewer Richness

- Viewer support exists, but the Python viewer remains richer.
  - Missing parity with the reusable Python HTML viewer app.
  - Missing richer stats presentation driven by Python run accounting.
  - Missing Python-level browser-verified viewer behavior coverage.

### 14. Operational Docs And Support Scripts

- Supporting operational workflows are thinner than Python.
  - Missing Python-equivalent docs/scripts for resume verification.
  - Missing Python-equivalent docs/scripts for viewer verification.
  - Missing Python’s surrounding support assets for these workflows.

### 15. Test Coverage For Missing Areas

- The TypeScript repo does not yet have parity-grade test coverage for the missing areas above.
  - Missing summarizer tests.
  - Missing trace-upload tests.
  - Missing browser-level viewer verification coverage.
  - Missing broader orchestration parity coverage for adaptive, parallel, and worktree flows.

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
- Summarization

### Strongly Desired

- Rich run accounting
- Conversation capture
- Archive scrubbing parity
- Viewer richness
- Launch-time team recovery and config parity

### Nice To Have Or Separate Track

- Operational docs and support scripts
- Expanded parity tests for all of the above
