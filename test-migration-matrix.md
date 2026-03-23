# Test Migration Matrix

## Purpose

This document tracks how the TypeScript test suite in this repo will match the shipped Python suite in `../kodo/tests`.

The goal is not just "have some tests." The goal is:

- mirror the major Python suite categories
- port the highest-value behavioral tests first
- make any retired Python-only tests explicit
- prevent implementation work from outrunning parity verification

## Baseline

Source of truth:

- Python repo: `../kodo`
- Test root: `../kodo/tests`
- Baseline date: March 22, 2026

Current status in this repo:

- TS parity test files present: `2`
- Initial shell coverage:
  - `test/cli/main.test.ts`
  - `test/cli/subcommands.test.ts`

Python suite size at baseline:

- `cli`: 12 files
- `config`: 4 files
- `integration`: 4 files
- `knowledge`: 6 files
- `orchestrators`: 25 files
- `sessions`: 16 files
- root-level product/regression tests: 16 files
- Total `test_*.py` files: 83

## Required TS Suite Shape

The TS repo should mirror these categories under `test/`:

- `test/cli`
- `test/config`
- `test/logging`
- `test/sessions`
- `test/orchestrators`
- `test/knowledge`
- `test/integration`
- `test/regression`
- `test/fixtures`
- `test/helpers`

Notes:

- Python root-level tests should be redistributed into `logging`, `regression`, `integration`, or the relevant subsystem rather than left as an unstructured TS root pile.
- `test/logging` is split out explicitly because Kodo has substantial run/log/viewer/trace-upload behavior currently covered by root-level Python tests.

## Category Mapping

| Python source | Count | Planned TS location | Notes |
|---|---:|---|---|
| `tests/cli` | 12 | `test/cli` | Must be ported early; this defines the user-facing contract |
| `tests/config` | 4 | `test/config` | Team loading, factory behavior, backend adaptation |
| `tests/sessions` | 16 | `test/sessions` | Backend lifecycle, malformed output, adversarial subprocess behavior |
| `tests/orchestrators` | 25 | `test/orchestrators` | Largest risk area; should mirror behavior before cutover |
| `tests/knowledge` | 6 | `test/knowledge` | Port after core CLI/runtime is stable |
| `tests/integration` | 4 | `test/integration` | Real subprocess CLI coverage |
| root `tests/test_log.py`, `tests/test_list_runs.py`, `tests/test_trace_upload.py`, `tests/test_resume.py`, `tests/test_log_adversarial.py` | 5 | `test/logging` and `test/regression` | Run dirs, logs, viewer compatibility, resume, archive behavior |
| remaining root-level product tests | 11 | `test/regression`, `test/integration`, or matching subsystem | Classify individually; do not leave implicit |

## First Porting Tranche

These Python tests should be translated first because they define the external product boundary:

### CLI contract

- `../kodo/tests/cli/test_argument_audit.py`
- `../kodo/tests/cli/test_cli_main.py`
- `../kodo/tests/cli/test_json_mode.py`
- `../kodo/tests/cli/test_noninteractive.py`
- `../kodo/tests/cli/test_subcommands.py`

### Run/log/resume behavior

- `../kodo/tests/test_list_runs.py`
- `../kodo/tests/test_log.py`
- `../kodo/tests/test_resume.py`
- `../kodo/tests/test_trace_upload.py`
- `../kodo/tests/test_log_adversarial.py`

### Integration sanity

- `../kodo/tests/integration/test_execution.py`
- `../kodo/tests/integration/test_subcommands.py`

These define whether the TS CLI actually looks and behaves like Kodo to a user.

## Migration Rules

Each Python test file must be marked as one of:

- `port-direct`
  - Translate test intent closely into Vitest with equivalent assertions.
- `rewrite-equivalent`
  - Different helper shape in TS, but same product behavior coverage.
- `merge`
  - Multiple narrow Python files collapse into one TS file without losing behavior.
- `retire-python-only`
  - Test protects Python implementation details, not product behavior.

Any `retire-python-only` decision must include one sentence explaining why it is safe.

## Tracking Table

The table below now includes every Python `test_*.py` file from the March 22, 2026 baseline.

| Python test file | Planned TS file | Status | Decision |
|---|---|---|---|
| `tests/cli/test_argument_audit.py` | `test/cli/argument-audit.test.ts` | pending | port-direct |
| `tests/cli/test_cli_improve.py` | `test/cli/improve.test.ts` | pending | rewrite-equivalent |
| `tests/cli/test_cli_intake.py` | `test/cli/intake.test.ts` | pending | rewrite-equivalent |
| `tests/cli/test_cli_launch.py` | `test/cli/launch.test.ts` | pending | rewrite-equivalent |
| `tests/cli/test_cli_main.py` | `test/cli/main.test.ts` | pending | port-direct |
| `tests/cli/test_cli_smoke.py` | `test/integration/cli-smoke.test.ts` | pending | rewrite-equivalent |
| `tests/cli/test_cli_test.py` | `test/cli/test-mode.test.ts` | pending | rewrite-equivalent |
| `tests/cli/test_intake.py` | `test/cli/intake-flow.test.ts` | pending | rewrite-equivalent |
| `tests/cli/test_json_mode.py` | `test/cli/json-mode.test.ts` | pending | port-direct |
| `tests/cli/test_noninteractive.py` | `test/cli/noninteractive.test.ts` | pending | port-direct |
| `tests/cli/test_params.py` | `test/cli/params.test.ts` | pending | port-direct |
| `tests/cli/test_subcommands.py` | `test/cli/subcommands.test.ts` | started | port-direct |
| `tests/config/test_factory.py` | `test/config/factory.test.ts` | pending | rewrite-equivalent |
| `tests/config/test_factory_adversarial.py` | `test/config/factory-adversarial.test.ts` | pending | rewrite-equivalent |
| `tests/config/test_factory_backends.py` | `test/config/factory-backends.test.ts` | pending | rewrite-equivalent |
| `tests/config/test_team_config.py` | `test/config/team-config.test.ts` | started | rewrite-equivalent |
| `tests/test_list_runs.py` | `test/logging/list-runs.test.ts` | pending | rewrite-equivalent |
| `tests/test_log.py` | `test/logging/log.test.ts` | pending | rewrite-equivalent |
| `tests/test_resume.py` | `test/logging/resume.test.ts` | pending | rewrite-equivalent |
| `tests/test_trace_upload.py` | `test/logging/trace-upload.test.ts` | pending | rewrite-equivalent |
| `tests/test_log_adversarial.py` | `test/regression/log-adversarial.test.ts` | pending | rewrite-equivalent |
| `tests/integration/test_execution.py` | `test/integration/execution.test.ts` | pending | rewrite-equivalent |
| `tests/integration/test_infra.py` | `test/integration/infra.test.ts` | pending | rewrite-equivalent |
| `tests/integration/test_stateful.py` | `test/integration/stateful.test.ts` | pending | rewrite-equivalent |
| `tests/integration/test_subcommands.py` | `test/integration/subcommands.test.ts` | pending | rewrite-equivalent |
| `tests/knowledge/test_convergence.py` | `test/knowledge/convergence.test.ts` | pending | rewrite-equivalent |
| `tests/knowledge/test_models.py` | `test/knowledge/models.test.ts` | pending | rewrite-equivalent |
| `tests/knowledge/test_orchestrator.py` | `test/knowledge/orchestrator.test.ts` | pending | rewrite-equivalent |
| `tests/knowledge/test_sessions.py` | `test/knowledge/sessions.test.ts` | pending | rewrite-equivalent |
| `tests/knowledge/test_team_designer.py` | `test/knowledge/team-designer.test.ts` | pending | rewrite-equivalent |
| `tests/knowledge/test_tools.py` | `test/knowledge/tools.test.ts` | pending | rewrite-equivalent |
| `tests/orchestrators/test_advisor.py` | `test/orchestrators/advisor.test.ts` | pending | rewrite-equivalent |
| `tests/orchestrators/test_api.py` | `test/orchestrators/api.test.ts` | pending | rewrite-equivalent |
| `tests/orchestrators/test_api_adversarial.py` | `test/orchestrators/api-adversarial.test.ts` | pending | rewrite-equivalent |
| `tests/orchestrators/test_api_context_summarization.py` | `test/orchestrators/api-context-summarization.test.ts` | pending | rewrite-equivalent |
| `tests/orchestrators/test_auto_commit.py` | `test/orchestrators/auto-commit.test.ts` | pending | rewrite-equivalent |
| `tests/orchestrators/test_claude_code_api_key.py` | `test/orchestrators/claude-code-api-key.test.ts` | pending | rewrite-equivalent |
| `tests/orchestrators/test_claude_code_cycle.py` | `test/orchestrators/claude-code-cycle.test.ts` | pending | rewrite-equivalent |
| `tests/orchestrators/test_codex_cli.py` | `test/orchestrators/codex-cli.test.ts` | pending | rewrite-equivalent |
| `tests/orchestrators/test_cursor_cli.py` | `test/orchestrators/cursor-cli.test.ts` | pending | rewrite-equivalent |
| `tests/orchestrators/test_cycle_result.py` | `test/orchestrators/cycle-result.test.ts` | pending | rewrite-equivalent |
| `tests/orchestrators/test_cycle_utils.py` | `test/orchestrators/cycle-utils.test.ts` | pending | rewrite-equivalent |
| `tests/orchestrators/test_done_signal.py` | `test/orchestrators/done-signal.test.ts` | pending | rewrite-equivalent |
| `tests/orchestrators/test_fatal_agent_error.py` | `test/orchestrators/fatal-agent-error.test.ts` | pending | rewrite-equivalent |
| `tests/orchestrators/test_fault_injection.py` | `test/orchestrators/fault-injection.test.ts` | pending | rewrite-equivalent |
| `tests/orchestrators/test_gemini_cli.py` | `test/orchestrators/gemini-cli.test.ts` | pending | rewrite-equivalent |
| `tests/orchestrators/test_kimi_code.py` | `test/orchestrators/kimi-code.test.ts` | pending | rewrite-equivalent |
| `tests/orchestrators/test_kimi_code_cycle.py` | `test/orchestrators/kimi-code-cycle.test.ts` | pending | rewrite-equivalent |
| `tests/orchestrators/test_legacy_done_stress.py` | `test/orchestrators/legacy-done-stress.test.ts` | pending | rewrite-equivalent |
| `tests/orchestrators/test_mcp_server.py` | `test/orchestrators/mcp-server.test.ts` | pending | rewrite-equivalent |
| `tests/orchestrators/test_parallel_cleanup.py` | `test/orchestrators/parallel-cleanup.test.ts` | pending | rewrite-equivalent |
| `tests/orchestrators/test_resume.py` | `test/orchestrators/resume.test.ts` | pending | rewrite-equivalent |
| `tests/orchestrators/test_run_status.py` | `test/orchestrators/run-status.test.ts` | pending | rewrite-equivalent |
| `tests/orchestrators/test_staged_run.py` | `test/orchestrators/staged-run.test.ts` | pending | rewrite-equivalent |
| `tests/orchestrators/test_verify_done.py` | `test/orchestrators/verify-done.test.ts` | pending | rewrite-equivalent |
| `tests/orchestrators/test_worktree.py` | `test/orchestrators/worktree.test.ts` | pending | rewrite-equivalent |
| `tests/sessions/test_base.py` | `test/sessions/base.test.ts` | pending | rewrite-equivalent |
| `tests/sessions/test_claude.py` | `test/sessions/claude.test.ts` | pending | rewrite-equivalent |
| `tests/sessions/test_claude_adversarial.py` | `test/sessions/claude-adversarial.test.ts` | pending | rewrite-equivalent |
| `tests/sessions/test_claude_cli.py` | `test/sessions/claude-cli.test.ts` | pending | rewrite-equivalent |
| `tests/sessions/test_claude_coverage.py` | `test/sessions/claude-coverage.test.ts` | pending | rewrite-equivalent |
| `tests/sessions/test_claude_lifecycle_edge_cases.py` | `test/sessions/claude-lifecycle-edge-cases.test.ts` | pending | rewrite-equivalent |
| `tests/sessions/test_codex.py` | `test/sessions/codex.test.ts` | pending | rewrite-equivalent |
| `tests/sessions/test_cursor.py` | `test/sessions/cursor.test.ts` | pending | rewrite-equivalent |
| `tests/sessions/test_cursor_adversarial.py` | `test/sessions/cursor-adversarial.test.ts` | pending | rewrite-equivalent |
| `tests/sessions/test_gemini_cli.py` | `test/sessions/gemini-cli.test.ts` | pending | rewrite-equivalent |
| `tests/sessions/test_kimi.py` | `test/sessions/kimi.test.ts` | pending | rewrite-equivalent |
| `tests/sessions/test_kimi_live.py` | `test/sessions/kimi-live.test.ts` | pending | rewrite-equivalent |
| `tests/sessions/test_live.py` | `test/sessions/live.test.ts` | pending | rewrite-equivalent |
| `tests/sessions/test_live_unit.py` | `test/sessions/live-unit.test.ts` | pending | rewrite-equivalent |
| `tests/sessions/test_malformed_json.py` | `test/sessions/malformed-json.test.ts` | pending | rewrite-equivalent |
| `tests/sessions/test_subprocess_adversarial.py` | `test/sessions/subprocess-adversarial.test.ts` | pending | rewrite-equivalent |
| `tests/test_agent.py` | `test/regression/agent.test.ts` | pending | rewrite-equivalent |
| `tests/test_agent_notes.py` | `test/regression/agent-notes.test.ts` | pending | rewrite-equivalent |
| `tests/test_autospec_enforcement.py` | `test/regression/autospec-enforcement.test.ts` | pending | retire-python-only |
| `tests/test_benchmark.py` | `test/regression/benchmark.test.ts` | pending | rewrite-equivalent |
| `tests/test_git_ops.py` | `test/orchestrators/git-ops.test.ts` | pending | rewrite-equivalent |
| `tests/test_integration_runs.py` | `test/integration/runs.test.ts` | pending | rewrite-equivalent |
| `tests/test_mocked_happy_path.py` | `test/integration/mocked-happy-path.test.ts` | pending | rewrite-equivalent |
| `tests/test_models.py` | `test/regression/models.test.ts` | pending | rewrite-equivalent |
| `tests/test_orchestrator.py` | `test/orchestrators/core-orchestrator.test.ts` | pending | rewrite-equivalent |
| `tests/test_regression.py` | `test/regression/regression.test.ts` | pending | rewrite-equivalent |
| `tests/test_summarizer.py` | `test/regression/summarizer.test.ts` | pending | rewrite-equivalent |

## Exit Condition For Test Parity Readiness

Implementation work can accelerate only after all of the following are true:

- the TS `test/` tree mirrors the Python suite categories
- the first porting tranche is checked in
- the repo has shared helpers for subprocess CLI execution, fixtures, mocked backends, and run/log fixture generation
- every Python `test_*.py` file has a tracked migration decision

Cutover is blocked until the parity matrix and this test migration matrix both show no unexplained gaps in user-visible behavior coverage.
