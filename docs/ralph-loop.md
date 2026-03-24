# Ralph Loop

`ralph.py` is the repo-local driver for executing migration specs sequentially with Codex.

## Basic Usage

From the repo root:

```bash
python3 ralph.py --specs-dir specs
```

By default this:

- discovers numbered spec files in `specs/`
- skips any spec already listed in `specs/done.md`
- logs each attempt to `specs/agent-run.log`
- invokes `codex exec --dangerously-bypass-approvals-and-sandbox`
- requires the worker to print `SPEC_COMPLETE` after committing

## Useful Options

```bash
python3 ralph.py --dry-run
python3 ralph.py --specs-dir specs --done-path specs/done.md --log-path specs/agent-run.log
python3 ralph.py --codex-args "exec --dangerously-bypass-approvals-and-sandbox -m gpt-5.4"
```

Key flags:

- `--dry-run` prints the execution order without invoking Codex
- `--max-attempts-per-spec` controls retry count
- `--magic-phrase` changes the required completion token
- `--codex-exe` and `--codex-args` let operators point Ralph at a different Codex binary or model config

## Operator Notes

- `ralph.py` always switches to the repository root before running a spec
- usage-limit responses are detected and retried automatically after the reported reset time
- a spec is only marked done after Codex exits successfully and prints the configured magic phrase
- the loop does not validate repository cleanliness for you, so check `git status --short` before large batches if that matters for your workflow
