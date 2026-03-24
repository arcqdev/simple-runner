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
- either `gemini` or `opencode` on `PATH` for the ACP runtime, or provider API credentials for the API orchestrator

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

Operator verification helpers live in [docs/verify-resume.md](/Users/eddie/dev/arcqdev/simple-runner/docs/verify-resume.md) and [scripts/README.md](/Users/eddie/dev/arcqdev/simple-runner/scripts/README.md).

## Cutover Notes

ACP is now the default local runtime path. The built-in teams target Gemini and OpenCode through ACP, and the legacy direct vendor CLI session adapters have been removed from the session layer.

The current cutover status is documented in [cutover.md](/Users/eddie/dev/arcqdev/simple-runner/cutover.md), [parity-matrix.md](/Users/eddie/dev/arcqdev/simple-runner/parity-matrix.md), and [test-migration-matrix.md](/Users/eddie/dev/arcqdev/simple-runner/test-migration-matrix.md).

The remaining deferred work is non-blocking for normal CLI usage:

- Python knowledge mode is not ported yet.
- Benchmark tooling from the Python repo is not ported yet.
