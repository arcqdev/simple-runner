# Orchestrator Parity Notes

Current TS orchestration now covers the main execution lifecycle: cycle planning hooks, worker execution, verifier-gated completion, retry after rejection, stage sequencing from `goal-plan.json`, resumable runtime state, run-status updates, auto-commit behavior, and isolated git-worktree execution for parallel stages.

Remaining explicit gaps versus Python:

- Adaptive advisor-driven stage generation is still pending. TS consumes an existing `goal-plan.json` but does not yet regenerate stages between completions.
- Intra-cycle multi-tool orchestrator conversations are approximated with one agent turn per cycle plus verifier turns. Python's MCP tool loop can perform multiple done attempts inside a single cycle.
- When a selected team has no runnable worker backend available, TS falls back to the chosen orchestrator backend as a worker so the run can still progress.
