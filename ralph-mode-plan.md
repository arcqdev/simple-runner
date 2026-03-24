# Ralph Mode Plan

Baseline:

- Repo: `/Users/eddie/dev/arcqdev/simple-runner`
- Date: March 23, 2026
- Scope: design only, no implementation in this document

## Goal

Add an optional "Ralph mode" to the TypeScript runner that introduces a dedicated validator-based stop decision.

When Ralph mode is enabled in configuration:

- the runtime must ask a validator whether the current run state is sufficient to stop
- the validator must return a configured stop phrase only when it is satisfied the goal is complete enough
- if the validator does not return that stop phrase, the run must continue

This should be implemented as a runtime feature, not as an ad hoc prompt hack.

## Current Runtime Shape

The existing runtime already has the right seam for this:

- workers produce cycle outcomes and explicit directives such as `GOAL_DONE:` and `END_CYCLE:` in [`src/runtime/orchestration.ts`](/Users/eddie/dev/arcqdev/simple-runner/src/runtime/orchestration.ts)
- the runtime already has a verification phase in `runVerification(...)`
- verification already supports:
  - configured verifier agents from team config
  - fallback verifier selection when no explicit verifier exists
  - browser-gated validation
  - retry messaging back into the loop when done is rejected

That means Ralph mode should extend the existing done-verification path, not replace worker directives and not add a separate outer loop.

## Recommended Design

### 1. Treat Ralph mode as a verification policy

Best approach:

- keep the worker/orchestrator contract unchanged
- keep `GOAL_DONE:` as the worker saying "I believe I am done"
- add a second gate that decides whether the runtime is allowed to accept that done signal
- run that gate inside the existing verification flow

Why this is the best fit:

- it preserves current behavior for non-Ralph teams
- it avoids duplicating the cycle loop
- it keeps "stop vs continue" as a runtime-owned decision
- it composes cleanly with existing verifiers, browser verifiers, and fallback verifier behavior

### 2. Add a dedicated Ralph validator config block

Recommended team config addition:

```json
{
  "ralph_mode": {
    "enabled": true,
    "validator": "architect",
    "stop_phrase": "RALPH_STOP",
    "max_turns": 8,
    "require_phrase_alone": true,
    "run_after_verifiers": true
  }
}
```

Recommended semantics:

- `enabled`
  - turns Ralph mode on for that team
- `validator`
  - names the agent to use as the Ralph validator
  - should reference an entry in `agents`
- `stop_phrase`
  - exact phrase required to accept stop
- `max_turns`
  - optional override for validator query budget
- `require_phrase_alone`
  - if true, the response must equal the stop phrase after trimming
  - this is safer than substring matching
- `run_after_verifiers`
  - if true, run ordinary verification first, then ask Ralph validator for final stop approval

This belongs in team config, not CLI flags, because it changes run policy and should travel with the team preset.

## Why A Dedicated Validator Is Better Than Reusing Existing Verifiers

Existing verifiers answer "did you find problems?"

Ralph mode needs a stronger, narrower contract:

- "Should the runtime stop now?"
- "Return exactly this phrase if yes"
- "Anything else means keep going"

That is not the same as free-form test or review output. Reusing normal verifier output and then trying to parse sentiment would be brittle.

The validator should still be an ordinary team agent under the hood, but invoked with a special prompt and a strict response contract.

## Proposed Runtime Contract

### Worker side

No change to current worker protocol:

- worker can emit `GOAL_DONE: ...`
- worker can emit `END_CYCLE: ...`
- worker can emit `RAISE_ISSUE: ...`

### Ralph validator side

On a candidate done attempt:

- runtime builds a validator prompt containing:
  - original goal
  - current cycle summary
  - optional acceptance criteria
  - current repository/run context as already used by verification
  - strict instruction:
    - return exactly `<stop_phrase>` if the goal is complete enough to stop
    - otherwise explain briefly what still remains or why the run should continue

Acceptance rule:

- stop only if the validator response matches the configured stop phrase exactly under the configured matching mode

Rejection rule:

- any other response means "continue"
- the rejection text should be fed back into the cycle just like current done-rejection verification issues

## Exact Placement In The Runtime

Recommended order when a worker emits a done attempt:

1. run normal verification if configured and not skipped
2. if normal verification finds issues, reject done immediately
3. if Ralph mode is enabled, run Ralph validator
4. if validator returns stop phrase, accept done
5. otherwise reject done and continue

Why this order is best:

- ordinary verifiers keep doing what they already do well: bug finding, review, browser checks
- Ralph validator becomes the final stop authority rather than duplicating all verification responsibilities
- the validator sees a cleaner candidate because obvious failures were already screened

Alternative considered:

- run Ralph validator before ordinary verifiers

Why not:

- it wastes validator calls on obviously incomplete or broken candidates
- it pushes bug-finding responsibility into the stop gate
- it blurs the role separation

## Matching Rules For The Stop Phrase

Recommended default:

- exact trimmed string match only

Do not use:

- substring matching
- case-insensitive fuzzy matching
- regex by default

Reason:

- false positives are too risky
- validator explanations may mention the phrase in prose
- deterministic stop semantics matter more than convenience here

If flexibility is ever needed later, add it explicitly as a match mode:

- `exact`
- `exact_case_insensitive`
- `regex`

But the first implementation should stay exact-only.

## Failure And Edge Cases

### 1. Missing validator agent

If Ralph mode is enabled but the configured validator is absent or pruned due to unavailable backend:

- fail configuration validation up front during team build
- do not silently fall back to a random verifier

Reason:

- Ralph mode changes stop semantics
- silent degradation would be surprising and unsafe

### 2. Validator backend error

If the validator query errors:

- treat it as "cannot approve stop"
- reject done and continue if cycles remain
- log the validator failure clearly

Reason:

- runtime should not stop on uncertain validation

### 3. Validator returns empty output

Treat as rejection, not approval.

### 4. Resume behavior

Ralph mode should remain stateless enough that resume is simple:

- no separate validator session needs to be persisted in v1
- use a fresh validator session per done attempt
- continue storing ordinary run summaries as today

This is the simplest and least fragile version.

### 5. Infinite rejection loops

This already exists conceptually with verification rejection. Ralph mode should use the same cycle limits:

- no special unbounded Ralph retry loop
- if the validator keeps rejecting stop, the run ends via normal max-cycle behavior

## Config Validation Changes

Team config validation should be extended to support:

- optional `ralph_mode` object
- boolean `enabled`
- required non-empty `validator` and `stop_phrase` when enabled
- validator must reference a valid available agent
- optional positive integer `max_turns`
- optional boolean `require_phrase_alone`
- optional boolean `run_after_verifiers`

This validation belongs in [`src/config/team-config.ts`](/Users/eddie/dev/arcqdev/simple-runner/src/config/team-config.ts).

## Runtime API Changes

Recommended internal additions:

- add a normalized Ralph config type in team config handling
- thread that config into the resolved runtime team
- add a helper alongside `runVerification(...)`, for example:
  - `runRalphValidation(...)`
- have `runVerification(...)` remain focused on bug-finding verification
- have the higher-level done-attempt path orchestrate:
  - normal verification
  - Ralph validation
  - final accept/reject decision

This separation is cleaner than overloading `verificationPassed(...)` with stop-phrase semantics.

## Prompt Design

The Ralph validator prompt should be explicit and narrow.

Recommended shape:

- explain that the validator is the final stop gate
- provide the goal and current summary
- instruct it to inspect the repo honestly
- define the exact stop phrase
- define that any response other than the exact phrase means continue
- ask for a concise explanation when rejecting stop

Example contract:

```text
You are the Ralph validator.

Goal:
<goal>

Candidate completion summary:
<summary>

Inspect the repository and determine whether the goal is complete enough to stop this run.

Rules:
- If the goal is complete enough to stop, reply with exactly: RALPH_STOP
- Do not include any other words when approving stop.
- If the run should continue, do not output RALPH_STOP.
- Instead, briefly state what is still missing, uncertain, or unverified.
```

This prompt should be generated by runtime code, not stored as a free-form user string, so the contract stays stable.

## Logging

Add dedicated events for observability:

- `ralph_validation_start`
- `ralph_validation_end`
- `ralph_validation_rejected`
- `ralph_validation_approved`
- `ralph_validation_error`

Record:

- validator agent
- stop phrase identifier or hash-safe representation
- cycle index
- elapsed time
- response text
- whether approval matched exactly

## Defaults

Do not enable Ralph mode in built-in teams by default.

Why:

- it changes completion semantics
- existing users expect current behavior
- rollout should be opt-in per team

If a future built-in preset is wanted, add a dedicated team such as:

- `ralph`
- `full-ralph`

## Tests To Add When Implementing

### Team config tests

- accepts valid Ralph config
- rejects missing validator when enabled
- rejects missing stop phrase when enabled
- rejects validator name not present in agents
- preserves disabled Ralph config without affecting normal teams

### Orchestration tests

- done accepted when normal verification passes and validator returns exact stop phrase
- done rejected when validator returns anything else
- done rejected when validator errors
- done rejected when validator returns stop phrase with extra text and exact-only mode is enabled
- Ralph mode skipped entirely when disabled
- Ralph mode composes correctly with no normal verifiers configured
- resume still works because validator is stateless per attempt

### Logging tests

- emits Ralph validation events with expected metadata

## Implementation Sequence

1. Extend team config types and validation.
2. Add normalized Ralph runtime config to built team output.
3. Add Ralph validator prompt builder and response matcher.
4. Add `runRalphValidation(...)`.
5. Insert Ralph validation into the existing done-attempt acceptance path.
6. Add tests for config, orchestration, and logging.
7. Document Ralph mode in the README and team examples.

## Non-Goals For V1

- a new top-level CLI flag for Ralph mode
- multi-validator consensus
- phrase matching modes beyond exact match
- persisted validator sessions across resume
- a separate Ralph outer loop distinct from the existing orchestration loop

## Final Recommendation

The best implementation is:

- an opt-in `ralph_mode` block in team config
- one explicitly named validator agent
- one exact stop phrase
- validator invoked only on candidate done attempts
- validator runs after normal verification and acts as the final stop gate
- any non-matching validator response causes the run to continue

That gives you deterministic stop behavior, keeps the current orchestrator model intact, and minimizes both implementation risk and behavioral surprise.
