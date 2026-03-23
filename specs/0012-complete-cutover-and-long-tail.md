# Spec 0012: Complete Cutover And Long Tail

## Status

Pending.

## Goal

Handle the remaining cutover blockers so the TypeScript implementation becomes the primary product path without requiring the Python repo for normal usage.

## Required Work

- Decide and document the TS plan for knowledge mode, benchmark tooling, and any intentionally deferred Python-only surfaces.
- Finish the missing parity coverage around prompts, viewer/log serving, `update`, malformed output, subprocess edge cases, and long-tail regression behavior.
- Update README and install flow so the TS package is the primary implementation.
- Document anything that intentionally remains out of scope after cutover.
- Resolve the explicitly audited long-tail UX gaps before cutover:
  - banner/warning/next-step copy that still differs from Python
  - `kodo issue` browser/open-folder guidance and archive instructions
  - `kodo update` messaging around missing `uv` and upgrade failures
  - viewer/browser suppression behavior driven by `KODO_NO_VIEWER`
- Document which temporary migration deviations from `parity-matrix.md` remain acceptable at cutover, if any, and retire the rest.

## Acceptance Criteria

- No normal user workflow still requires the Python repo.
- Remaining Python-only behavior is either ported or explicitly documented as non-blocking.
- Cutover documentation and migration notes are checked in.
