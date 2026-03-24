# CLI Parity Matrix

This document tracks the user-visible Python CLI surface from `/Users/eddie/dev/arcqdev/kodo` against the TypeScript port in this repo.

Baseline:

- Python repo state: March 22, 2026
- Python package version: `0.4.261`
- TS package version target: `0.4.261`

Legend:

- `matched`: TS behavior is intended to match the Python surface closely enough for parity work
- `partial`: TS implements the surface, but known output/runtime differences remain
- `pending`: Python behavior exists and is not yet implemented in TS
- `intentional-deviation`: TS differs on purpose; the difference is documented and must stay visible

## Entry Points And Routing

| Surface                  | Python reference                             | TS status | Notes                                                                                                                                                     |
| ------------------------ | -------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kodo --help`            | `kodo/cli/_main.py`                          | `matched` | TS help text mirrors the Python shell surface and subcommand list                                                                                         |
| `kodo --version`         | `kodo/cli/_main.py`                          | `matched` | Emits `kodo <version>`                                                                                                                                    |
| `kodo help`              | `kodo/cli/_main.py`                          | `matched` | Python rewrites to `--help`; TS routes the same way                                                                                                       |
| `kodo test ...`          | `kodo/cli/_main.py`                          | `matched` | Rewritten to `--test` before main parsing                                                                                                                 |
| `kodo improve ...`       | `kodo/cli/_main.py`                          | `matched` | Rewritten to `--improve` before main parsing                                                                                                              |
| Singular/plural aliases  | `kodo/cli/_main.py`                          | `matched` | `run/runs`, `log/logs`, `team/teams`, `backend/backends`, `issue/issues`                                                                                  |
| `kodo runs`              | `kodo/cli/_subcommands.py`                   | `matched` | TS lists real run metadata rather than a placeholder                                                                                                      |
| `kodo logs`              | `kodo/cli/_subcommands.py`, `kodo/viewer.py` | `partial` | TS opens a viewer, serves logs, preserves `KODO_NO_VIEWER`, and preserves the port-collision hint; viewer UX/event rendering is still simpler than Python |
| `kodo issue`             | `kodo/cli/_subcommands.py`                   | `matched` | TS now builds the archive, prints attach instructions, and mirrors browser/open-folder guidance closely enough for cutover                                |
| `kodo backends`          | `kodo/cli/_subcommands.py`                   | `partial` | TS prints backend presence and key status, but Python has richer version/preflight diagnostics                                                            |
| `kodo teams`             | `kodo/cli/_subcommands.py`                   | `partial` | TS supports list/add/edit/auto, but prompt copy and some fallback heuristics still differ                                                                 |
| `kodo update`            | `kodo/cli/_subcommands.py`                   | `matched` | TS shells out to `uv tool upgrade ...` and now preserves the missing-`uv` and upgrade-failure messaging family                                            |
| Standalone viewer binary | `python -m kodo.viewer`                      | `partial` | TS ships `kodo-viewer`, but HTML content and drag-and-drop/index parity are not complete                                                                  |

## Main Flags, Defaults, And Validation

| Surface                                                      | Python behavior                                                                                                                                                | TS status | Notes                                                                                                               |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------- |
| `--resume [RUN_ID]`                                          | Optional value, `__latest__` sentinel when omitted                                                                                                             | `matched` | TS matches optional-value parsing and latest-incomplete selection semantics                                         |
| `--goal`, `--goal-file`, `--improve`, `--test`, `--fix-from` | Mutually exclusive goal sources                                                                                                                                | `matched` | TS matches the top-level exclusivity contract                                                                       |
| `--focus`                                                    | Allowed only with `--improve` or `--test`; cannot be blank                                                                                                     | `matched` |                                                                                                                     |
| `--target`                                                   | Repeatable; allowed only with `--test`; each path must exist under project dir                                                                                 | `matched` |                                                                                                                     |
| `--team`                                                     | Dynamic choices from discovered teams; default depends on mode                                                                                                 | `partial` | TS resolves team names and mode defaults, but interactive discovery/presentation differs                            |
| `--exchanges`                                                | Positive integer, max `1000`, default resolved from config/factory                                                                                             | `partial` | TS validates numeric bounds and resolves defaults, but the full interactive preset flow is not yet ported           |
| `--cycles`                                                   | Positive integer, max `100`, default resolved from config/factory                                                                                              | `partial` | Same gap as `--exchanges`                                                                                           |
| `--orchestrator`                                             | Free-form orchestrator/model selector                                                                                                                          | `partial` | TS supports `--orchestrator-model` alias handling but does not yet mirror Python’s full provider/model chooser      |
| `--skip-intake`                                              | Requires non-interactive goal source                                                                                                                           | `matched` |                                                                                                                     |
| `--auto-refine`                                              | Requires non-interactive goal source; implies `--yes`                                                                                                          | `matched` |                                                                                                                     |
| `--json`                                                     | Implies `--yes`; redirects progress to stderr and structured result to stdout                                                                                  | `partial` | TS matches the error/result split, but the result payload is still narrower than Python runtime parity will require |
| `--yes` / `-y`                                               | Skip confirmation prompts                                                                                                                                      | `matched` |                                                                                                                     |
| `--effort {low,standard,high,max}`                           | Validated choice set; forwarded into runtime                                                                                                                   | `partial` | TS validates and stores the value, but downstream runtime effects are not yet Python-complete                       |
| `--no-auto-commit`                                           | Disables auto commit                                                                                                                                           | `partial` | Shell exists; full orchestrator-side behavior is pending                                                            |
| `--debug`                                                    | Mocked backends, skip intake, deterministic sessions                                                                                                           | `partial` | TS records debug mode and emits a debug marker, but full mocked-backend parity is pending                           |
| `--project PROJECT`                                          | Must exist and be a directory; default `.`                                                                                                                     | `matched` |                                                                                                                     |
| Goal text validation                                         | Blank or whitespace-only goal rejected                                                                                                                         | `matched` |                                                                                                                     |
| `--resume` incompatibility set                               | Cannot combine with non-interactive goal modes                                                                                                                 | `matched` |                                                                                                                     |
| Mode defaults                                                | `--improve` forces `team=full`, `skip-intake`, `yes`; `--test` forces `team=test`, `skip-intake`, `yes`; `--fix-from` forces `team=full`, `skip-intake`, `yes` | `matched` |                                                                                                                     |

## Subcommands And Secondary Flags

| Command                                               | Python syntax/defaults                                     | TS status | Notes                                                                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `kodo runs [project_dir]`                             | Optional positional filter by resolved project directory   | `matched` |                                                                                                                                   |
| `kodo logs [logfile] [--port PORT]`                   | Default port `8080`; missing file is fatal                 | `partial` | TS accepts the same arguments and now preserves browser suppression plus the port-collision hint, but viewer output still differs |
| `kodo issue [run_id] [--project PROJECT] [--no-open]` | Default project `.`; if `run_id` omitted, prompt from runs | `matched` | TS supports the current syntax, archive instructions, and browser/open-folder guidance                                            |
| `kodo backends`                                       | No flags                                                   | `partial` |                                                                                                                                   |
| `kodo teams`                                          | No args lists teams                                        | `matched` |                                                                                                                                   |
| `kodo teams add <name>`                               | Interactive creator, no extra flags                        | `partial` | TS persists JSON, but the exact prompt sequence differs                                                                           |
| `kodo teams edit <name>`                              | Interactive editor, no extra flags                         | `partial` |                                                                                                                                   |
| `kodo teams auto [mode]`                              | No mode means regenerate all built-in templates            | `partial` | TS mirrors overwrite confirmation and mode handling, but fallback role/model heuristics are not yet audited field-for-field       |
| `kodo update`                                         | No flags; requires `uv`                                    | `matched` |                                                                                                                                   |
| `kodo-viewer [logfile]`                               | Open `file://` viewer when no `--serve`                    | `partial` |                                                                                                                                   |
| `kodo-viewer --serve [--port PORT] [logfile]`         | Default port `8080`; serves `/api/log/<run_id>`            | `partial` | TS serves the endpoint, but viewer HTML semantics remain incomplete                                                               |

## Structured JSON Output Shapes

Python has two currently shipped JSON payload families. Missing any of these in TS should be treated as a visible parity gap.

### 1. Validation / fatal error payload

```json
{
  "status": "error",
  "error": "message text"
}
```

Status: `matched`

Notes:

- Python emits this for parser errors, top-level exceptions, and `_fail(...)` when `--json` is active.
- TS already mirrors this shape for shell-level validation failures.

### 2. Run result payload

```json
{
  "status": "completed|partial|failed",
  "finished": true,
  "cycles": 0,
  "exchanges": 0,
  "cost_usd": 0.0,
  "summary": "...",
  "stages": [
    {
      "index": 1,
      "name": "Stage name",
      "finished": true,
      "summary": "...",
      "cycles": 1
    }
  ],
  "improve_report": "...",
  "test_report": "..."
}
```

Status: `partial`

Notes:

- `status` derives from runtime outcome: `completed` when finished, `partial` when cycles exist but the run is unfinished, `failed` when no useful result exists.
- `stages`, `improve_report`, and `test_report` are optional.
- TS has the top-level shell and can emit a simplified result, but full runtime population is still pending.

## Prompts, Summaries, Warnings, And Hints

| User-visible behavior                                          | Python reference                  | TS status | Notes                                                                                                                |
| -------------------------------------------------------------- | --------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------- |
| Banner before interactive/non-JSON runs                        | `kodo/cli/_ui.py`, `_main.py`     | `matched` | TS now prints a cutover banner and project context before non-JSON run/resume flows                                  |
| Existing `goal.md` detection and `Use this goal? [Y/n]` prompt | `kodo/cli/_main.py`               | `partial` | TS reuses `goal.md`, but the surrounding preview/warning text is not a copy-accurate port                            |
| Multiline pasted goal input                                    | `kodo/cli/_intake.py`             | `pending` | Python distinguishes pasted buffered stdin from manual blank-line termination                                        |
| Resume confirmation                                            | `kodo/cli/_main.py`               | `matched` | TS asks before resuming unless prompts are skipped                                                                   |
| `teams auto` overwrite confirmation                            | `kodo/cli/_subcommands.py`        | `matched` |                                                                                                                      |
| `issue` description prompt                                     | `kodo/cli/_subcommands.py`        | `matched` | TS now uses the audited copy family and mirrors browser/open-folder/archive instructions closely enough for cutover  |
| Backend preflight warnings                                     | `kodo/cli/_launch.py`             | `pending` | Python warns but continues when only some team backends fail preflight                                               |
| Auto-commit disabled hint when no `.git`                       | `kodo/cli/_launch.py`             | `pending` | Python prints and logs this; TS behavior remains narrower                                                            |
| Missing-backend hint under `kodo teams`                        | `kodo/cli/_subcommands.py`        | `matched` | `Hint: Run 'kodo teams auto' ...`                                                                                    |
| `kodo logs` port collision hint                                | `kodo/viewer.py`                  | `matched` | TS now preserves the `Hint: try a different port with --port <n+1>` diagnostic family                                |
| Next-step tips after run/resume                                | `kodo.tips` hooks from `_main.py` | `matched` | TS now prints a primary next step to reopen the run in `kodo-viewer`, plus follow-up report/fix hints where relevant |

## Filesystem Layout And Generated Artifacts

### Run storage roots

| Surface               | Python behavior                                                                | TS status | Notes                                                                            |
| --------------------- | ------------------------------------------------------------------------------ | --------- | -------------------------------------------------------------------------------- |
| Runs root             | `~/.kodo/runs`, override via `KODO_RUNS_DIR`                                   | `matched` |                                                                                  |
| User config           | `~/.kodo/config.json`                                                          | `partial` | TS has a user-config loader, but full default-resolution parity is pending       |
| User teams            | `~/.kodo/teams/<name>.json`                                                    | `matched` |                                                                                  |
| Project team override | `<project>/.kodo/team.json`                                                    | `partial` | Python gives this precedence over user teams; TS support is not yet fully ported |
| Project config cache  | `<project>/.kodo/config.json` with legacy fallback to `.kodo/last-config.json` | `pending` | TS has not yet matched the full reuse flow                                       |

### Per-run artifact layout

Python expects each run directory under `~/.kodo/runs/<run_id>/` to use these artifact names:

- `log.jsonl`
- `run.jsonl` as a legacy log fallback when reading older runs
- `goal.md`
- `goal-refined.md`
- `goal-plan.json`
- `config.json`
- `team.json`
- `improve-report.md` for `--improve`
- `test-report.md` for `--test`
- `run.tar.gz` when `kodo issue` prepares a scrubbed archive

TS status: `partial`

Notes:

- TS already writes `log.jsonl`, `goal.md`, `goal-refined.md`, `goal-plan.json`, `config.json`, and `team.json`.
- Report-file generation, archive naming guarantees, and compatibility with Python-generated legacy artifacts remain open parity work.

## Log Parsing, Event Shapes, Resume, And Viewer Expectations

### Run reconstruction contract

Python `parse_run(...)` and `list_runs(...)` define the minimum resume/discovery contract:

- A valid run log must contain `cli_args` and either `run_start` or enough `cli_args` data to reconstruct a failed-before-start run.
- `list_runs(project_dir)` filters by resolved project directory.
- `find_incomplete_runs(project_dir)` means `not finished`, including runs that failed before the first cycle.
- Resume must preserve `completed_cycles`, `last_summary`, `completed_stages`, `stage_summaries`, `current_stage_cycles`, `team_preset`, `is_debug`, and `agent_session_ids`.
- Session IDs are reconstructed from `session_query_end` and rebound to logical agent names when `agent_run_end` appears.

TS status: `partial`

Notes:

- TS can parse/list runs and resume basic run state.
- Stage-aware resume state, session-id rebinding, and failed-before-start reconstruction are not fully matched yet.

### Python log event inventory

These Python event names are currently shipped and therefore part of the visible parity contract for run artifacts and the viewer:

- `advisor_assess_end`
- `advisor_assess_error`
- `advisor_assess_start`
- `advisor_done`
- `advisor_safety_limit`
- `advisor_type`
- `agent_crash`
- `agent_query`
- `agent_run_end`
- `agent_run_start`
- `agent_session_reset`
- `agent_timeout`
- `agent_timeout_worker_stuck`
- `auto_commit_disabled`
- `auto_commit_done`
- `auto_commit_error`
- `auto_commit_skip`
- `auto_commit_start`
- `claude_stderr`
- `cleanup_orphaned_branch_failed`
- `cleanup_orphaned_branch_removed`
- `cleanup_orphaned_branches_found`
- `cleanup_stale_worktree_failed`
- `cleanup_stale_worktree_removed`
- `cleanup_stale_worktrees_error`
- `cleanup_stale_worktrees_found`
- `cleanup_stale_worktrees_list_failed`
- `cli_args`
- `cycle_end`
- `cycle_error`
- `cycle_fatal_agent_error`
- `cycle_start`
- `debug_run_start`
- `done_verification`
- `done_verification_error`
- `intake_response`
- `intake_stage_skipped`
- `knowledge_run_end`
- `knowledge_run_start`
- `knowledge_team_designed`
- `mcp_server_thread_stuck`
- `orchestrator_auth_error`
- `orchestrator_close_error`
- `orchestrator_done_accepted`
- `orchestrator_done_attempt`
- `orchestrator_done_rejected`
- `orchestrator_end_cycle`
- `orchestrator_fallback`
- `orchestrator_raise_issue`
- `orchestrator_response`
- `orchestrator_retry`
- `orchestrator_tool_call`
- `orchestrator_tool_result`
- `orchestrator_wall_timeout`
- `parallel_group_end`
- `parallel_group_start`
- `persist_conflict_resolve_crash`
- `persist_conflict_resolve_failed`
- `persist_conflict_resolve_ok`
- `persist_conflict_resolve_start`
- `persist_merge_failed`
- `persist_merge_ok`
- `persist_stage_merge`
- `preflight_warnings`
- `run_cycle`
- `run_empty_plan_fallback`
- `run_end`
- `run_init`
- `run_resumed`
- `run_start`
- `session_cleanup_warning`
- `session_close_warning`
- `session_query_end`
- `session_query_error`
- `session_query_start`
- `session_reset`
- `session_timeout`
- `stage_end`
- `stage_error`
- `stage_start`
- `summarize_end`
- `summarize_error`
- `summarize_start`
- `summarizer_error`
- `worktree_cleanup_error`
- `zombie_process`

Current TS-emitted events:

- `agent_run_end`
- `cli_args`
- `cycle_end`
- `cycle_start`
- `debug_run_start`
- `planning_end`
- `planning_start`
- `run_end`
- `run_start`

TS status: `pending`

Notes:

- The Python viewer consumes a much richer event grammar than TS currently emits.
- Missing event families must remain visible in planning until the viewer, resume, and runtime work is complete.

### Viewer contract

| Viewer behavior                                                      | Python reference                 | TS status | Notes                                                                                                 |
| -------------------------------------------------------------------- | -------------------------------- | --------- | ----------------------------------------------------------------------------------------------------- |
| Open temp-file viewer when not serving                               | `kodo/viewer.py`                 | `matched` | Both use temporary HTML and browser launch                                                            |
| Build run index when no specific log is given                        | `kodo/viewer.py`                 | `partial` | TS lists runs, but does not preserve Python’s index metadata richness                                 |
| Skip corrupt JSONL lines while embedding log data                    | `kodo/viewer.py`                 | `matched` |                                                                                                       |
| Serve `/api/log/<run_id>` with `log.jsonl` then `run.jsonl` fallback | `kodo/viewer.py`                 | `matched` |                                                                                                       |
| Reject invalid `run_id` path traversal attempts                      | `kodo/viewer.py`                 | `matched` |                                                                                                       |
| Rich timeline/event rendering from `viewer.html`                     | `kodo/viewer.html`               | `pending` | TS HTML is intentionally simplified today                                                             |
| Drag-and-drop / log picker / embedded run index UX                   | `kodo/viewer.py`, `viewer.html`  | `pending` |                                                                                                       |
| Trace upload affordances                                             | `viewer.html`, `trace_upload.py` | `partial` | `kodo issue` now prepares a scrubbed `run.tar.gz`, but the viewer-side UI remains lighter than Python |

## External Dependency Map

| Python dependency / integration           | Python role                                                          | TS status | Notes                                                                         |
| ----------------------------------------- | -------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------- |
| `argparse`                                | CLI parsing and help shell                                           | `matched` | TS uses a custom parser/help shell rather than a direct library equivalent    |
| `questionary`                             | Interactive text/select prompts                                      | `partial` | TS has a prompt adapter, but the Python prompt repertoire is not fully ported |
| `python-dotenv`                           | Load `.env` at process startup                                       | `pending` | TS has not yet matched automatic `.env` loading                               |
| `webbrowser`                              | Open issue URL and viewer in browser                                 | `partial` | TS shells out through platform commands                                       |
| `HTTPServer` / `SimpleHTTPRequestHandler` | Local log-viewer server                                              | `matched` | TS uses Node `http` with equivalent endpoint responsibilities                 |
| CLI backends on `PATH`                    | `claude`, `cursor-agent`, `codex`, `gemini`, `kimi`                  | `partial` | TS checks presence, but richer preflight/error classification remains pending |
| Provider API env vars                     | Anthropic, Gemini/Google, OpenAI, DeepSeek, OpenRouter, Mistral, xAI | `pending` | Full adapter/runtime parity is still ahead                                    |
| Git worktree / merge helpers              | Parallel stage persistence and auto-commit                           | `partial` | TS now has worktree isolation, cleanup, commit handling, and merge-back for parallel stages |

## Environment Variables And Backend Credential Expectations

### Core env vars

| Variable            | Python meaning                                                       | TS status | Notes |
| ------------------- | -------------------------------------------------------------------- | --------- | ----- |
| `KODO_RUNS_DIR`     | Override run storage root                                            | `matched` |       |
| `KODO_NO_VIEWER`    | Disable browser opening for viewer flows, also forced by `--json`    | `matched` |       |
| `KODO_TRACE_UPLOAD` | Enable best-effort trace upload/archive behavior                     | `pending` |       |
| `KODO_MAX_PARALLEL` | Override parallel stage cap                                          | `pending` |       |
| `OLLAMA_BASE_URL`   | Defaults to `http://localhost:11434/v1` for Ollama-backed API models | `pending` |       |

### API key / credential env vars

| Provider/backend            | Python env vars                                                                   | TS status | Notes                                                                              |
| --------------------------- | --------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------- |
| Anthropic API orchestrator  | `ANTHROPIC_API_KEY`                                                               | `pending` | TS backend layer is not complete                                                   |
| Gemini API orchestrator     | `GEMINI_API_KEY` or `GOOGLE_API_KEY`                                              | `pending` |                                                                                    |
| OpenAI API orchestrator     | `OPENAI_API_KEY`                                                                  | `pending` |                                                                                    |
| DeepSeek API orchestrator   | `DEEPSEEK_API_KEY`                                                                | `pending` |                                                                                    |
| OpenRouter API orchestrator | `OPENROUTER_API_KEY`                                                              | `pending` |                                                                                    |
| Mistral API orchestrator    | `MISTRAL_API_KEY`                                                                 | `pending` |                                                                                    |
| xAI API orchestrator        | `XAI_API_KEY`                                                                     | `pending` |                                                                                    |
| CLI backends                | Installed commands on `PATH`: `claude`, `cursor-agent`, `codex`, `gemini`, `kimi` | `partial` | TS checks command presence, but Python also classifies version/auth/quota failures |

### Backend lifecycle expectations

These are visible runtime requirements even before the full adapter port is complete:

- Python loads `.env` via `dotenv` at CLI startup.
- CLI orchestrators do not require API keys; API orchestrators do.
- Python strips `ANTHROPIC_API_KEY` from worker subprocesses by default unless explicitly opting into API-key-backed Claude session behavior.
- Claude/Cursor/Codex resume paths persist backend session IDs into logs and reuse them on resume.
- Backend preflight checks can warn on auth/quota/billing issues without necessarily aborting the run.

TS status: `pending`

## Exact-Parity Vs Intentional Deviation Decisions

### Exact parity target

These surfaces should end up matching Python behavior as closely as practical:

- CLI routing, aliases, flag names, and default values
- Validation failures and JSON error shape
- Run directory names, artifact filenames, and legacy log fallback handling
- Run discovery and resume semantics
- `kodo logs` serving contract and `/api/log/<run_id>` endpoint behavior
- Environment variable names and backend credential expectations
- Team config file locations and override precedence

### Intentional deviations currently accepted

| Surface                                      | Decision                        | Why                                                                                                                          |
| -------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Current TS viewer HTML                       | `intentional-deviation` for now | The TS viewer is a simplified stopgap while runtime/log parity lands; it must not be mistaken for complete parity            |
| Remaining interactive prompt wording         | `intentional-deviation` for now | Team-management and runtime-selection prompts are still functional-but-not-identical; they are documented rather than hidden |
| Current TS runtime result payload population | `intentional-deviation` for now | Shell-level JSON support landed before the full orchestrator/runtime port                                                    |

## Cutover-Approved Remaining Deviations

These are the only deviations still accepted at cutover:

- Viewer HTML and event rendering remain simpler than Python even though log opening and serving are functionally complete.
- Trace-upload affordances remain centered on `kodo issue` archive preparation rather than the richer Python viewer UI.
- Knowledge mode and benchmark tooling remain deferred and are documented in [cutover.md](/Users/eddie/dev/arcqdev/simple-runner/cutover.md) rather than treated as hidden parity gaps.

These deviations are temporary migration choices, not cutover-ready exceptions.

## Current Cut

- Phase 0 discovery is now specific enough that missing Python behavior should appear as a named gap in this file rather than vanish into a broad bucket.
- The remaining major parity holes are concentrated in prompt copy, runtime event coverage, viewer richness, backend/session lifecycle behavior, and long-tail update/issue UX.
