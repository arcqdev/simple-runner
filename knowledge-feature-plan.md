# Knowledge Feature Plan

## Goal

Port the Python `kodo/knowledge/*` subsystem into the TypeScript codebase as a first-class, non-coding execution mode for research, analysis, synthesis, and answer-generation workflows.

The TypeScript repo already covers the main coding workflow:

- goal-driven code runs
- `--test`, `--improve`, and `--fix-from`
- run logging, resume, viewer, issue packaging, and team management

Knowledge mode should extend the product without weakening or entangling the coding path.

## What Knowledge Mode Is

Knowledge mode is for tasks where the output is an answer, report, synthesis, recommendation, or analysis rather than a set of repository edits.

Examples:

- “Research the tradeoffs between three database options and recommend one.”
- “Summarize the current architecture and identify migration risks.”
- “Read these reference docs and produce an implementation brief.”
- “Compare vendors and produce a decision memo with open questions.”

Unlike coding mode, knowledge mode should optimize for:

- task-specific agent design
- shared artifact production
- iterative convergence on an answer
- explicit confidence / open-questions reporting

## Source Of Truth In Python

Primary Python references:

- `../kodo/kodo/knowledge/cli.py`
- `../kodo/kodo/knowledge/orchestrator.py`
- `../kodo/kodo/knowledge/models.py`
- `../kodo/kodo/knowledge/team_designer.py`
- `../kodo/kodo/knowledge/tools.py`
- `../kodo/kodo/knowledge/convergence.py`
- `../kodo/kodo/knowledge/sessions.py`

## Coding Mode Vs Knowledge Mode

### Coding mode

- Primary objective: change code in a repository.
- Main unit of progress: cycles, stages, verifier-approved completion.
- Success signal: repository state satisfies goal and verifiers pass.
- Tools: coding agent sessions, filesystem edits, tests, git/worktree isolation, run-status summaries.
- Team shape: fixed or semi-fixed team config from presets / JSON.
- Output artifacts: logs, reports, archives, modified files, commits.

### Knowledge mode

- Primary objective: produce a high-quality answer.
- Main unit of progress: rounds of analysis and artifact refinement.
- Success signal: answer converges with adequate confidence/completeness.
- Tools: artifact read/write, shared workspace, synthesis tools, optional references, agent delegation.
- Team shape: designed dynamically per task and domain.
- Output artifacts: answer draft, notes, reference extracts, open questions, final verdict.

### Practical difference

Coding mode asks:

- “What should change in this repo?”
- “Did the code pass verification?”

Knowledge mode asks:

- “What is the best current answer?”
- “Has the answer converged enough to stop?”

## Porting Principles

- Keep coding mode and knowledge mode as separate runtime paths with shared logging primitives where useful.
- Reuse existing TS infrastructure only where the abstraction genuinely fits.
- Avoid forcing knowledge mode into the current coding-stage model.
- Preserve viewer compatibility where possible by logging knowledge-specific events cleanly.
- Ship a minimal end-to-end version first, then add dynamic team design and richer convergence behavior.

## Proposed TS Surface

### CLI

Add a dedicated CLI entrypoint:

- `kodo-knowledge`

Optional future integration:

- `kodo knowledge ...`

Recommended initial flags:

- positional `goal`
- `--effort quick|standard|deep|exhaustive`
- `--model`
- `--designer-model`
- `--agent-model`
- `--domain` repeatable
- `--constraint` repeatable
- `--format`
- `--ref` repeatable
- `--output`
- `--json`

## Proposed TS Modules

- `src/knowledge/cli.ts`
- `src/knowledge/models.ts`
- `src/knowledge/orchestrator.ts`
- `src/knowledge/team-designer.ts`
- `src/knowledge/tools.ts`
- `src/knowledge/convergence.ts`
- `src/knowledge/sessions.ts`
- `src/knowledge/workspace.ts`

Possible shared logging/viewer touchpoints:

- `src/logging/log.ts`
- `src/logging/runs.ts`
- `src/viewer.ts`

## Feature Breakdown

### Phase 1: Minimal runnable knowledge mode

Deliver:

- `kodo-knowledge` CLI
- knowledge goal model
- simple knowledge orchestrator with one orchestrator model and one agent model
- shared workspace/artifact store on disk
- final answer output file
- knowledge-specific log events

Non-goals:

- dynamic team design
- advanced convergence heuristics
- tool-rich delegated agent graph

Exit criteria:

- user can run a knowledge task with a goal and optional refs
- system writes final answer and logs the run

### Phase 2: Workspace and artifact semantics

Deliver:

- artifact types for notes, answer drafts, evidence, and open questions
- read/write/list APIs
- reference-file ingestion into workspace
- stable file layout for artifacts inside run directory

Exit criteria:

- agents can iteratively build and revise shared artifacts
- artifacts are inspectable in logs and on disk

### Phase 3: Dynamic team design

Deliver:

- task classification / pattern selection
- per-task role generation
- model assignment rules
- domain-aware prompts

Exit criteria:

- knowledge runs no longer depend on a fixed preset team
- team design is visible in logs and reproducible enough for debugging

### Phase 4: Knowledge tools

Deliver:

- `read_artifact`
- `write_artifact`
- `list_artifacts`
- `finish`
- optional `delegate_to_agent` or equivalent orchestration helper
- optional compute / structured extraction helpers

Exit criteria:

- agents collaborate through explicit workspace operations rather than ad hoc text only

### Phase 5: Convergence engine

Deliver:

- convergence assessment model
- stop / continue decision logic
- answer confidence scoring
- open-questions capture
- incomplete-answer reporting

Exit criteria:

- runs stop because the answer is “good enough,” not just because an agent says done

### Phase 6: Viewer and resume support

Deliver:

- viewer support for knowledge events
- artifact browsing
- round summaries
- resume semantics for unfinished knowledge runs

Exit criteria:

- interrupted knowledge runs can resume
- viewer can display the knowledge workspace and final answer cleanly

## Data Model Sketch

Core types to introduce:

- `KnowledgeGoal`
- `KnowledgeAgentRole`
- `KnowledgeWorkspace`
- `KnowledgeArtifact`
- `KnowledgeRoundResult`
- `KnowledgeConvergenceResult`
- `KnowledgeRunResult`

Important fields:

- goal text
- effort
- domain hints
- constraints
- output format
- reference files
- workspace artifact index
- rounds used
- confidence
- verdict type
- final answer
- open questions

## Logging / Viewer Plan

Add knowledge-specific events, likely including:

- `knowledge_run_start`
- `knowledge_team_designed`
- `knowledge_round_start`
- `knowledge_round_end`
- `knowledge_artifact_written`
- `knowledge_convergence_assessed`
- `knowledge_run_end`

Viewer work should be additive:

- do not regress current coding-run views
- detect knowledge runs and render the final answer, artifacts, and convergence state

## Resume Plan

Knowledge resume should restore:

- workspace artifacts
- rounds completed
- team design
- convergence state
- per-agent session identifiers where applicable

This should be designed explicitly, not bolted onto the current coding runtime state shape.

## Recommended Implementation Order

1. CLI + models
2. workspace + artifact persistence
3. minimal orchestrator
4. basic single-model convergence loop
5. logging + viewer support
6. dynamic team design
7. richer tool surface
8. resume support

## Risks

- Over-reusing the coding orchestrator will make the knowledge path awkward.
- Under-specifying artifacts will make convergence and resume unreliable.
- Mixing coding and knowledge event semantics without clear separation will complicate the viewer.
- Dynamic team design can become expensive and hard to debug if introduced too early.

## Open Decisions

- Should `kodo-knowledge` be standalone only, or also available as `kodo knowledge`?
- Should knowledge mode reuse the existing session adapters directly, or define a thinner abstraction first?
- Should workspace artifacts live only in the run directory, or also support project-local caching?
- Should the first shipped version support browser/search tools, or stay local/reference-file only?

## Definition Of Done

Knowledge mode is “ported” when:

- a user can run a non-coding knowledge task from the TS repo
- the system produces a final answer with explicit confidence/open-question reporting
- the run is logged and viewable
- the workspace/artifact model is persistent and inspectable
- the implementation no longer depends on the Python repo for any knowledge workflow
