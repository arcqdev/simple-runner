# simple-runner

`simple-runner` is a local multi-agent coding runner with:

- a default "regular" orchestrator path via `pi`
- ACP-backed local orchestrators via `gemini-cli` and `opencode`
- saved run logs and a built-in run viewer

## Install

Requirements:

- Node.js 20+
- npm

Setup:

```bash
npm install
npm run build
```

With `pnpm`:

```bash
pnpm install
pnpm run build
```

Run it directly from the repo:

```bash
node dist/cli.js --help
```

If you want the binary on your `PATH`:

```bash
npm link
```

Or with `pnpm`:

```bash
pnpm link --global
```

Then you can use:

```bash
simple-runner --help
```

The linked CLI continues to point at this checkout. Since the package `bin`
entries resolve to files under `dist/`, each fresh `npm run build` or
`pnpm run build` updates what the linked `simple-runner` command executes.
If you want near-live updates while developing, run a build watcher in another
terminal:

```bash
npx vite build --watch
```

## Basic Usage

Run against the current repo with the default regular orchestrator:

```bash
simple-runner --goal "Make a small change and keep the app working."
```

Run against another repo:

```bash
simple-runner \
  --project /path/to/project \
  --goal "Make a small change and keep the app working."
```

Skip intake and prompts:

```bash
simple-runner \
  --project /path/to/project \
  --goal "Make a small change and keep the app working." \
  --skip-intake \
  --yes
```

Specialized modes:

```bash
simple-runner --test --project /path/to/project
simple-runner --improve --project /path/to/project
simple-runner --fix-from <run_id> --project /path/to/project
```

## Orchestrators

### Regular orchestrator

If you do **not** want to use `opencode`, use the default orchestrator and do not pass `--orchestrator`.

```bash
simple-runner \
  --project /path/to/project \
  --goal "Make a small change and keep the app working."
```

That uses the regular orchestrator path, which defaults to `pi`.

You can also force it explicitly:

```bash
simple-runner \
  --project /path/to/project \
  --goal "Make a small change and keep the app working." \
  --orchestrator pi
```

### ACP orchestrators

Use Gemini ACP:

```bash
simple-runner \
  --project /path/to/project \
  --goal "Make a small change and keep the app working." \
  --orchestrator gemini-cli:gemini-3-flash
```

Use OpenCode ACP:

```bash
simple-runner \
  --project /path/to/project \
  --goal "Make a small change and keep the app working." \
  --orchestrator opencode:gemini-3.1-flash-lite-preview
```

Notes:

- `opencode` and `gemini-cli` are the current live ACP-backed orchestrator paths.
- `codex` is not a live orchestrator path here yet. If you select it, `simple-runner` now errors instead of faking success.

## Live Logging

To get more live session output in the terminal, use `loge` mode:

```bash
simple-runner loge \
  --project /path/to/project \
  --goal "Make a small change and keep the app working." \
  --skip-intake \
  --yes \
  --team quick \
  --orchestrator opencode:gemini-3.1-flash-lite-preview
```

Equivalent flag form:

```bash
simple-runner \
  --loge \
  --project /path/to/project \
  --goal "Make a small change and keep the app working."
```

`--loge` is most useful on ACP-backed runs. It prints agent starts, tool activity, usage updates, and verifier progress as the run happens.

## Viewing Past Runs

Open the past-runs picker from the main binary:

```bash
simple-runner --view-past-runs
```

Other run inspection commands:

```bash
simple-runner runs
simple-runner logs
simple-runner --resume
simple-runner --resume <run_id>
```

If you want the direct viewer entrypoint, it still exists:

```bash
simple-runner-viewer ~/.simple-runner/runs/<run_id>/log.jsonl
```

## Teams

List teams:

```bash
simple-runner teams
```

Generate teams for the current machine:

```bash
simple-runner teams auto
```

Use a specific team:

```bash
simple-runner \
  --project /path/to/project \
  --goal "Make a small change" \
  --team quick
```

## Backend Checks

Check which local backends are usable:

```bash
simple-runner backends
```

For ACP-backed runs, you usually want:

- `gemini` and/or `opencode` installed
- `GEMINI_API_KEY` or `GOOGLE_API_KEY` set when required

## Notes

- Runs are stored under `~/.simple-runner/runs`.
- The viewer path for a completed run is printed at the end of each run.
- `docs/verify-resume.md`, `docs/ralph-loop.md`, and `scripts/README.md` still contain operator-focused material.
