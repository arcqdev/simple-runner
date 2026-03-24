# Verify Resume Flow

This document recreates the Python-side resume verification workflow for the TypeScript repo.

## Setup

From the repo root:

```bash
npm install
```

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

## Cleanup

```bash
rm -rf ~/.kodo/runs/interrupted_run
rm -rf /tmp/kodo_resume_test
```
