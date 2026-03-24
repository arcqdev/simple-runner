# Scripts

Operator-facing support scripts for verifying and inspecting the TypeScript `kodo` runtime.

## `create-mock-interrupted-run.ts`

Creates an interrupted run fixture under `KODO_RUNS_DIR` (or `~/.kodo/runs`) plus a local test project so `kodo --resume` has something real to discover.

```bash
npm run ops:create-mock-interrupted-run
```

Useful env overrides:

- `KODO_RUNS_DIR` to redirect run storage
- `KODO_RESUME_TEST_PROJECT_DIR` to choose the project path
- `KODO_RESUME_TEST_RUN_ID` to choose the run ID

## `verify-resume-mocked.ts`

End-to-end resume verification without requiring backend CLIs or API keys. The script:

1. creates a mock interrupted run
2. verifies latest-incomplete resume by project
3. recreates the fixture
4. verifies explicit `--resume <run_id>`

The script forces the synthetic runtime path with `KODO_ENABLE_SESSION_RUNTIME=0`, so it exercises the real CLI resume flow without external dependencies.

```bash
npm run ops:verify-resume
```

## `verify-viewer-browser.ts`

Browser-level viewer verification using Playwright. It covers the served run picker, richer accounting/artifact rendering, trace-upload affordances, and embedded-log escaping.

```bash
npm run test:viewer-browser
```

## `analyze-run.ts`

Human-readable run inspection helper for local debugging and parity checks.

```bash
# Recent runs
npm run ops:analyze-run

# Specific run
npm run ops:analyze-run -- 20260323_010203

# Or parse a log path directly
npm run ops:analyze-run -- ~/.kodo/runs/20260323_010203/log.jsonl
```
