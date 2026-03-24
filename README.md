# kodo TypeScript Cutover

This repository is now the primary implementation path for `kodo`.

Normal workflows no longer require the Python repo:

- start a run with `kodo --goal ...`
- use specialized modes with `kodo --test`, `kodo --improve`, and `kodo --fix-from`
- inspect runs with `kodo runs`, `kodo logs`, and `kodo-viewer`
- report failures with `kodo issue`
- manage teams with `kodo teams`
- upgrade with `kodo update`

## Install And Run

Requirements:

- Node.js 20+
- npm
- for ACP-backed local runs, `gemini` or `opencode` on `PATH`
- for Gemini/OpenCode ACP auth, `GEMINI_API_KEY` or `GOOGLE_API_KEY`
- or provider API credentials for the API orchestrator path

Local setup:

```bash
npm install
npm run build
npm link
```

This makes the local binaries available:

- `kodo`
- `kodo-viewer`

Examples:

```bash
kodo --goal "Ship the feature"
kodo --goal "Ship the feature" --orchestrator gemini-cli:gemini-3-flash
kodo --goal "Ship the feature" --orchestrator opencode:gemini-2.5-flash
kodo --test --project .
kodo runs
kodo logs
kodo issue --no-open
```

If you do not want browser windows to open automatically, set `KODO_NO_VIEWER=1`.

Operator verification helpers live in [docs/verify-resume.md](/Users/eddie/dev/arcqdev/simple-runner/docs/verify-resume.md), [docs/ralph-loop.md](/Users/eddie/dev/arcqdev/simple-runner/docs/ralph-loop.md), and [scripts/README.md](/Users/eddie/dev/arcqdev/simple-runner/scripts/README.md).

## ACP Runtime Ops

ACP is the default local runtime path for Gemini and OpenCode. In normal local usage:

- `gemini-cli` uses the `gemini` ACP server command
- `opencode` uses the `opencode acp --provider gemini` ACP server command
- both expect Gemini-family credentials from `GEMINI_API_KEY` or `GOOGLE_API_KEY`

Preflight the current machine before operator testing:

```bash
kodo backends
```

What to check:

- `gemini-cli` or `opencode` shows as installed and ACP-ready
- credential warnings are resolved before expecting live ACP runs to succeed
- if only API keys are available, `api` remains a valid orchestrator path, but that is distinct from the ACP local runtime

Resume and run inspection:

```bash
kodo runs
kodo logs
kodo --resume --project /path/to/project
```

Troubleshooting:

- install or fix `gemini` / `opencode` if `kodo backends` reports the backend as unavailable
- set `GEMINI_API_KEY` or `GOOGLE_API_KEY` if ACP preflight reports missing credentials
- use `npm run ops:analyze-run -- <run-id>` to inspect run state and artifacts
- use `npm run ops:verify-resume` to verify resume flow without live backend dependencies
- set `KODO_RUNS_DIR` to isolate operator test runs from your normal `~/.kodo/runs`
- set `KODO_NO_VIEWER=1` if browser auto-open is not wanted during ops testing

## Ralph Loop

ACP migration specs can be executed sequentially with `ralph.py` from the repo root:

```bash
python3 ralph.py --specs-dir specs
```

Useful options:

- `--dry-run` to list the spec order without invoking Codex
- `--done-path specs/done.md` to track completed specs
- `--log-path specs/agent-run.log` to keep the per-attempt transcript
- `--magic-phrase SPEC_COMPLETE` to require the completion token from the worker

`ralph.py` runs each spec from the repository root and, by default, shells out to `codex exec --dangerously-bypass-approvals-and-sandbox`.

## Cutover Notes

ACP is now the default local runtime path. The built-in teams target Gemini and OpenCode through ACP, and the legacy direct vendor CLI session adapters have been removed from the session layer.

The current cutover status is documented in [cutover.md](/Users/eddie/dev/arcqdev/simple-runner/cutover.md), [parity-matrix.md](/Users/eddie/dev/arcqdev/simple-runner/parity-matrix.md), and [test-migration-matrix.md](/Users/eddie/dev/arcqdev/simple-runner/test-migration-matrix.md).

The remaining deferred work is non-blocking for normal CLI usage:

- Python knowledge mode is not ported yet.
- Benchmark tooling from the Python repo is not ported yet.
- Runtime state still persists string session identifiers instead of full ACP conversation locators.
- Log summaries still collapse streamed ACP events into the existing terminal-text oriented surfaces.
