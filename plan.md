# TypeScript Migration Checklist for `kodo`

## Goal

Turn this repository into the TypeScript implementation of [`/Users/eddie/dev/arcqdev/kodo`](/Users/eddie/dev/arcqdev/kodo), replacing the current placeholder CLI with a feature-complete Node.js/TypeScript port of the Python application.

Baseline:

- Source of truth: `/Users/eddie/dev/arcqdev/kodo`
- Baseline date: March 22, 2026
- Python version baseline: `0.4.261`

## Success Criteria

- [x] `npm run build` passes in this repo.
- [x] `npm run typecheck` passes in this repo.
- [x] `npm run lint` passes in this repo.
- [x] `npm run test` passes in this repo.
- [ ] The `kodo` CLI in this repo supports the same user-facing commands, subcommands, aliases, flags, and documented entrypoints as the Python CLI.
- [ ] User-visible behavior matches the Python implementation feature-for-feature.
- [ ] Core workflows work end-to-end: goal run, `test`, `improve`, `resume`, run listing, and log viewing.
- [ ] Backend integrations required for normal usage work from Node with the same lifecycle and failure behavior.
- [ ] Existing Python behavior is covered by TS regression tests or parity fixtures for the critical paths.
- [x] A checked-in parity matrix exists for the migrated surface.
- [x] A checked-in test migration matrix exists.
- [ ] No normal user workflow requires the Python repo at cutover.
- [ ] The README and install flow point to the TypeScript package as the primary implementation.

## Phase 0: Discovery and Parity Contract

Deliverables:

- [x] Audit the Python CLI surface and produce a command/flag parity matrix.
- [ ] Audit all user-visible runtime behavior, not just CLI syntax.
- [ ] Produce a complete feature inventory for every documented and shipped user-visible surface.
- [x] Audit the Python test suite and produce a TS parity test migration matrix.
- [ ] Identify external dependencies and their Node equivalents.
- [ ] Decide which behaviors are exact-parity vs intentionally revised.
- [x] Freeze the first migration target to the current Python repo state.

Concrete tasks:

- [x] Enumerate core CLI commands, aliases, and top-level flags used to drive the TS shell.
- [ ] Enumerate all CLI commands, aliases, flags, defaults, and JSON output shapes exhaustively.
- [ ] Enumerate all subcommands and secondary entrypoints:
  - [x] `runs`, `logs`, `issue`, `backends`, `teams`, `update`
  - [ ] `teams add`, `teams edit`, `teams auto`
  - [ ] standalone viewer invocation paths
  - [x] singular/plural command aliases
  - [x] `test` / `improve` alias routing
- [x] Enumerate and port initial user-visible option validation for:
  - [x] `--debug`
  - [x] `--resume`
  - [x] `--fix-from`
  - [x] `--skip-intake`
  - [x] `--auto-refine`
  - [x] `--no-auto-commit`
  - [x] `--effort`
  - [x] `--focus`
  - [x] `--target`
  - [x] `--orchestrator-model` alias handling via TS parser
- [ ] Enumerate all user-visible outputs and artifacts:
  - [x] help/version shell
  - [x] JSON validation error mode
  - [ ] terminal prompts and summaries
  - [ ] banners, warnings, hints, and next-step messages
  - [ ] report file names and sections
  - [ ] run directory layout
  - [ ] log event shapes
  - [ ] viewer expectations
  - [ ] resume behavior and session recovery semantics
- [ ] Catalog filesystem layout for runs, logs, cached state, defaults, and generated artifacts.
- [ ] Catalog environment variables and backend credential expectations.
- [x] Record which Python tests define critical behavior that must be mirrored first.
- [x] Classify the Python tests by migration status:
  - [x] `port-direct`
  - [x] `rewrite-equivalent`
  - [x] `retire-python-only`

Exit criteria:

- [x] A checked-in migration matrix exists.
- [x] A checked-in parity matrix identifies the currently known user-visible feature set and migration status.
- [ ] The parity matrix is exhaustive enough that removing any shipped Python user feature would show up as a gap, not as an implicit omission.
- [x] A checked-in test migration matrix maps the Python test suite to planned TS test files.
- [ ] No unresolved runtime choice remains for any core dependency path.

## Phase 1: Test Harness and Suite Skeleton

Deliverables:

- [x] TS test tree mirrors the major structure of `../kodo/tests`.
- [x] Shared test helpers exist for captured CLI output.
- [ ] Shared subprocess harness, mocked backend processes, fixture projects, weird filename fixtures, and run/log fixture builders exist.
- [x] Highest-value parity tests are checked in before broader implementation continues.

Concrete tasks:

- [x] Create test directories mirroring Python coverage:
  - [x] `test/cli`
  - [x] `test/config`
  - [x] `test/logging`
  - [x] `test/sessions`
  - [x] `test/orchestrators`
  - [x] `test/knowledge`
  - [x] `test/integration`
  - [x] `test/regression`
  - [x] `test/fixtures`
  - [x] `test/helpers`
- [ ] Port or recreate the Python test harness patterns:
  - [ ] subprocess CLI runner
  - [ ] mocked backend processes
  - [ ] fixture projects
  - [ ] weird filename fixtures
  - [ ] run/log fixture builders
- [x] Check in the first translated parity tests before broad implementation:
  - [x] CLI argument audit coverage
  - [x] help / version coverage
  - [x] JSON mode validation behavior
  - [x] run listing / resume selection
  - [x] backend status / team listing shape
- [x] Add conventions for test naming so TS files can be mapped back to Python sources via the migration matrix.

Exit criteria:

- [x] The TS test suite structure visibly covers the same major product areas as the Python suite.
- [ ] The repo has enough test harness infrastructure to port Python behavioral tests incrementally without re-inventing helpers every phase.

## Phase 2: Runtime Foundation

Deliverables:

- [ ] Node/TS runtime conventions finalized.
- [ ] Base library dependencies installed.
- [x] Shared utilities and domain types created for the current CLI shell.

Concrete tasks:

- [ ] Choose core libraries for prompts, validation, env loading, and process execution.
- [x] Add structured CLI error handling and JSON serialization helpers.
- [ ] Add path-safe filesystem helpers beyond the current CLI parser checks.
- [ ] Define shared TS types for runs, sessions, messages, goals, plans, findings, and reports.
- [ ] Create JSON serialization helpers for machine-readable runtime mode.

Exit criteria:

- [ ] Strict type-safe primitives exist for core runtime models.
- [ ] The repo can support multiple subsystems without ad hoc local types.

## Phase 3: CLI Shell Parity

Deliverables:

- [x] Real CLI argument handling replaces the placeholder implementation.
- [x] Help text, version output, command aliases, and JSON error mode behave correctly for the implemented shell.

Concrete tasks:

- [x] Port the CLI shell behavior from `kodo/cli/_main.py`.
- [x] Implement command aliases such as `kodo test` / `kodo improve`.
- [x] Implement top-level subcommand routing for `runs`, `logs`, `backends`, `teams`, `update`, `help`, and `issue`.
- [x] Implement the current singular/plural aliases:
  - [x] `run` / `runs`
  - [x] `log` / `logs`
  - [x] `team` / `teams`
  - [x] `backend` / `backends`
  - [x] `issue` / `issues`
- [x] Implement functional `teams add`, `teams edit`, and `teams auto`.
- [x] Implement initial non-interactive flags and validation rules.
- [ ] Port prompt/confirmation behavior and printed summaries fully.
- [x] Preserve exit-code behavior for current validation failures and JSON error formatting.

Exit criteria:

- [ ] Current TS CLI accepts the same full top-level commands, subcommands, aliases, and flags as Python.
- [x] CLI unit tests cover parsing, help, version, errors, JSON mode, and alias routing.
- [ ] CLI unit tests cover prompt flow and full exit-code parity.

## Phase 4: Config, Defaults, and Intake

Deliverables:

- [ ] Goal loading, intake, refinement, team selection, and parameter resolution work.

Concrete tasks:

- [ ] Port `team_config.py`.
- [ ] Port `user_config.py`.
- [ ] Port `factory.py`.
- [ ] Move JSON defaults from Python package data into TS-readable assets.
- [ ] Port `cli/_intake.py`.
- [ ] Port `cli/_params.py`.
- [ ] Recreate interactive flows with equivalent prompts and summaries.
- [ ] Preserve default team/orchestrator selection and non-interactive coercions exactly.

Exit criteria:

- [ ] A user can start a configured run from the TS CLI without placeholder behavior.

## Phase 5: Run State, Logging, Resume, and Viewer

Deliverables:

- [ ] Run directories, logs, replay metadata, run discovery, and resume bookkeeping exist in TS.

Concrete tasks:

- [ ] Port run directory management.
- [x] Port run parsing and listing.
- [x] Add initial JSONL log init/append/emit helpers with regression tests.
- [ ] Port stats/report helpers.
- [ ] Port replay/log formatting.
- [ ] Port `viewer.py`, `viewer.html`, and trace upload support.
- [ ] Port resume path expectations used by the CLI and orchestrators.
- [ ] Preserve Python artifact names and on-disk layout unless a migration shim is added.
- [ ] Preserve documented viewer invocation behavior.

Exit criteria:

- [ ] `runs`, `logs`, `resume`, issue-reporting, trace-upload, and viewer workflows operate against TS-generated run data and remain compatible with Python-generated artifacts where required.

## Phase 6: Session Layer and Backend Adapters

Deliverables:

- [ ] TS session abstraction with ACP-first backend adapters.

Concrete tasks:

- [ ] Port session protocol and lifecycle behavior from `kodo/__init__.py` and `kodo/sessions/*`.
- [ ] Define a transport boundary.
- [ ] Implement ACP-backed adapters for Claude CLI / Claude Code, Codex, and Gemini CLI.
- [ ] Keep explicit non-ACP adapters only where required, including Cursor and Kimi if still needed.
- [ ] Normalize stdout/stderr draining, timeouts, JSON framing, and session IDs.
- [ ] Normalize ACP event/message mapping into the shared session model.
- [ ] Preserve Python-visible session behavior for resume, logs, accounting, and surfaced errors.
- [ ] Produce a backend parity matrix.
- [ ] Apply the subprocess session cleanup already identified in Python docs.

Exit criteria:

- [ ] Session tests validate startup, message exchange, timeout handling, resume/session-id behavior, and fallback transport behavior.
- [ ] Adapter choice is not observable from the CLI except in explicitly documented diagnostics.

## Phase 7: Orchestrators and Verification Loop

Deliverables:

- [ ] Main multi-agent orchestration loop works in TS.

Concrete tasks:

- [ ] Port `kodo/orchestrators/*`.
- [ ] Preserve role behavior for architect, worker, tester, tester_browser, advisor, and parallel flows.
- [ ] Port run status transitions, cycle planning, stage planning, verification, done-signal handling, and git ops.
- [ ] Replace Python-specific branching with TS interfaces where appropriate.

Exit criteria:

- [ ] A real run can move through planning, execution, verification, rejection, retry, and completion in Node.

## Phase 8: Specialized Modes

Deliverables:

- [ ] `test`, `improve`, and `fix-from` support work end-to-end.

Concrete tasks:

- [ ] Port discovery and report logic from `cli/_test.py`.
- [ ] Port discovery and report logic from `cli/_improve.py`.
- [ ] Port prompt templates for both modes.
- [ ] Recreate fallback plan generation and report parsing helpers.
- [ ] Ensure generated reports preserve expected sections and machine-readable behavior where applicable.
- [ ] Preserve `--fix-from` compatibility with Python-generated report artifacts.

Exit criteria:

- [ ] TS CLI can produce and resume these modes without depending on the Python implementation.

## Phase 9: Knowledge Mode

Deliverables:

- [ ] TS implementation of the `knowledge/` subsystem.

Concrete tasks:

- [ ] Port models, prompts, tools, convergence logic, team designer, and session integration.
- [ ] Decide whether any Python-only dependency needs redesign in Node.

Exit criteria:

- [ ] Knowledge workflows have equivalent CLI/runtime support or are explicitly deferred behind a documented flag.

## Phase 10: Benchmark and Dev Script Port

Deliverables:

- [ ] Benchmark harness and selected scripts are either ported or intentionally retired.

Concrete tasks:

- [ ] Separate user-facing product migration from internal benchmarking concerns.
- [ ] Port benchmark code only after the main CLI is stable.
- [ ] Replace one-off scripts with npm scripts where possible.

Exit criteria:

- [ ] Anything still left in Python is documented as intentionally non-blocking.

## Testing Plan

Test layers:

- [ ] Unit tests for parsers, models, formatting, config resolution, and helpers.
- [ ] Subsystem tests for sessions, orchestrators, resume, and logging.
- [ ] Integration tests that execute the built CLI in subprocesses.
- [ ] Golden tests for JSON output and report formatting.

Migration approach:

- [x] Start by mirroring the Python test suite categories and helpers, not by writing isolated ad hoc TS tests.
- [x] Start by translating the highest-value Python tests into Vitest.
- [ ] Preserve adversarial tests around malformed output, subprocess behavior, resume edge cases, and CLI JSON mode.
- [ ] For long-tail Python tests, finish triage into must-port, merge/rewrite in TS, or retire because they only defend Python-specific behavior.

Required suite shape before implementation accelerates:

- [x] `test/cli`
- [x] `test/config`
- [x] `test/logging`
- [x] `test/sessions`
- [x] `test/orchestrators`
- [x] `test/knowledge`
- [x] `test/integration`
- [x] `test/regression`
- [x] `test/fixtures`
- [x] `test/helpers`

Minimum parity suite before cutover:

- [x] CLI parsing and help/version coverage started.
- [x] CLI JSON validation coverage started.
- [ ] CLI prompt/confirmation/output coverage completed.
- [x] Run directory creation and listing covered.
- [x] Resume selection logic covered.
- [ ] Viewer entrypoints and log-serving coverage completed.
- [x] `issue`, `backends`, `teams`, and `teams add/edit/auto` coverage completed.
- [ ] `update` coverage completed.
- [x] `--debug` and `--orchestrator-model` parsing/validation coverage started.
- [ ] One working ACP backend path covered.
