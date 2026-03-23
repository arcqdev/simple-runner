# Spec 0007: Complete Config, Defaults, And Intake

## Status

Pending.

## Goal

Port the configuration and intake layer so a normal TS run no longer depends on placeholder assumptions or Python-side configuration behavior.

## Required Work

- Port the remaining config behavior from the Python implementation, including team config, user config, and any factory/default resolution logic.
- Move or normalize JSON defaults so they are fully owned by the TS package.
- Port CLI intake and parameter resolution behavior, including interactive and non-interactive coercions.
- Recreate user-facing prompts and summaries with parity-appropriate behavior.
- Preserve Python config precedence and discovery details:
  - load `.env` at startup
  - respect project `.kodo/team.json` before user `~/.kodo/teams/<name>.json`
  - support project `.kodo/config.json` with legacy `.kodo/last-config.json` fallback
- Port the prompt-copy details that are now explicitly audited:
  - existing `goal.md` preview and `Use this goal? [Y/n]`
  - paste-friendly multiline goal entry behavior
  - intake-stage prompts, warnings, and summary copy
  - interactive parameter-selection copy and preset defaults

## Acceptance Criteria

- A configured user can start a run from the TS CLI using TS-owned config/default logic.
- Prompt and summary behavior is no longer a known parity gap for core intake flows.
- Tests cover the highest-risk config resolution and intake paths.
