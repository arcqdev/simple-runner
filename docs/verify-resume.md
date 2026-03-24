# Verify Resume Flow

This document recreates the Python-side resume verification workflow for the TypeScript repo.

## Setup

From the repo root:

```bash
npm install
```

For a live ACP resume check instead of the mocked path:

- install `gemini` or `opencode` on `PATH`
- set `GEMINI_API_KEY` or `GOOGLE_API_KEY`
- run `kodo backends` and confirm the target backend is ACP-ready before creating the interrupted run

## 1. Create a mock interrupted run

```bash
npm run ops:create-mock-interrupted-run
```

By default this creates:

- `~/.kodo/runs/interrupted_run/log.jsonl`
- `~/.kodo/runs/interrupted_run/goal.md`
- `/tmp/kodo_resume_test`

You can redirect the run storage or project path with `KODO_RUNS_DIR` and `KODO_RESUME_TEST_PROJECT_DIR`.

## 2. Verify the run is discoverable

```bash
npm run ops:analyze-run -- interrupted_run
```

Expected:

- status is `incomplete`
- the goal and project path match the created fixture
- the cycle count shows the interrupted first cycle

## 3. Resume the latest incomplete run

```bash
kodo --resume --yes --project /tmp/kodo_resume_test
```

Expected:

- `kodo` finds the interrupted run for that project
- the run completes successfully
- the run log gains `run_resumed` and `run_end`

## 4. Resume by run ID

```bash
kodo --resume interrupted_run --yes --project /tmp/kodo_resume_test
```

Expected:

- same behavior as the latest-incomplete flow, but targeted explicitly by run ID

## Mocked end-to-end verification

To verify both resume flows without backend CLIs or API keys:

```bash
npm run ops:verify-resume
```

That script forces the synthetic runtime path and fails if the mock run is not discovered, resumed, or marked complete.

## Live ACP Troubleshooting

If mocked resume passes but a live Gemini/OpenCode resume does not:

- run `kodo backends` and resolve install or credential warnings first
- inspect the run with `npm run ops:analyze-run -- <run-id>`
- check `runtime-state.json` inside the run directory to confirm saved cycle state exists
- check `log.jsonl` for `run_resumed`, `session_query_start`, `session_query_end`, and `run_end`
- if browser auto-open is getting in the way during repeated checks, set `KODO_NO_VIEWER=1`

## Cleanup

```bash
rm -rf ~/.kodo/runs/interrupted_run
rm -rf /tmp/kodo_resume_test
```
