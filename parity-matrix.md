# CLI Parity Matrix

This document tracks the user-visible Python CLI surface from `/Users/eddie/dev/arcqdev/kodo` against the TypeScript port in this repo.

Baseline:

- Python repo state: March 22, 2026
- Python package version: `0.4.261`
- TS package version target: `0.4.261`

Legend:

- `matched-shell`: command routing, aliases, help text, or validation shell exists in TS
- `pending-runtime`: full runtime behavior still needs implementation
- `pending`: not implemented yet

| Surface | Python reference | TS status | Notes |
|---|---|---|---|
| `--help` / `--version` | `kodo/cli/_main.py` | matched-shell | TS now exposes parity-oriented help/version shell |
| `--json` error mode | `kodo/cli/_main.py` | matched-shell | Validation errors emit JSON in TS |
| `test` / `improve` alias routing | `kodo/cli/_main.py` | matched-shell | `kodo test` and `kodo improve` rewrite into main parser |
| Singular/plural aliases | `kodo/cli/_main.py` | matched-shell | `run/runs`, `log/logs`, `team/teams`, `backend/backends`, `issue/issues` route in TS |
| Main flag validation | `kodo/cli/_main.py` | matched-shell | Basic validation ported for project, goal, focus, target, cycles, exchanges |
| Main run flow | `kodo/cli/_main.py`, `_launch.py`, `_intake.py`, `_params.py` | pending-runtime | TS emits pending summary only |
| Resume flow | `kodo/cli/_main.py`, `_subcommands.py`, `log.py` | pending-runtime | Parser exists; run discovery and resume execution are pending |
| `runs` subcommand | `kodo/cli/_subcommands.py` | pending-runtime | Routed, but listing output is still placeholder |
| `logs` subcommand | `kodo/cli/_subcommands.py`, `viewer.py` | pending-runtime | Routed, but viewer server is pending |
| `issue` subcommand | `kodo/cli/_subcommands.py` | pending-runtime | Routed, but archive/browser flow is pending |
| `backends` subcommand | `kodo/cli/_subcommands.py` | pending-runtime | Routed, but backend probing is pending |
| `teams` subcommand family | `kodo/cli/_subcommands.py`, `team_config.py` | matched-shell | Usage/help and dispatch shell exist; persistence and prompts are pending |
| `update` subcommand | `kodo/cli/_subcommands.py` | pending-runtime | Routed, but updater behavior is pending |
| Viewer standalone behavior | `kodo/viewer.py` | pending | No TS implementation yet |
| Run artifacts and JSON output shapes | `log.py`, `_launch.py`, orchestrators | pending | Not started |
| Session backends | `kodo/sessions/*` | pending | Not started |
| Orchestrators and verification loop | `kodo/orchestrators/*` | pending | Not started |
| Knowledge mode | `kodo/knowledge/*` | pending | Not started |

Current cut:

- Phase 0 deliverables are now represented by checked-in matrices and source-tree shape.
- Phase 1 is started with mirrored `test/` directories and initial CLI parity tests.
- Phase 3 is started with a real TypeScript CLI shell replacing the placeholder command handler.
