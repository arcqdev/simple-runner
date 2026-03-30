#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP_DIR="$ROOT_DIR/e2e/docker/simple-app"
RUNS_DIR="$ROOT_DIR/.tmp/simple-runner-runs"
PROOF_DIR="$APP_DIR/.e2e"
PORT=3210

export PATH="$ROOT_DIR/e2e/docker/fake-bin:$PATH"
export SIMPLE_RUNNER_ENABLE_SESSION_RUNTIME=1
export SIMPLE_RUNNER_RUNS_DIR="$RUNS_DIR"
export GEMINI_API_KEY="${GEMINI_API_KEY:-e2e-gemini-key}"

rm -rf "$RUNS_DIR" "$APP_DIR/dist" "$PROOF_DIR"
mkdir -p "$PROOF_DIR"

echo "== Building simple-runner =="
npm run build

echo "== Backend preflight =="
node -e 'console.log("ENV", JSON.stringify({ SIMPLE_RUNNER_ENABLE_SESSION_RUNTIME: process.env.SIMPLE_RUNNER_ENABLE_SESSION_RUNTIME, SIMPLE_RUNNER_RUNS_DIR: process.env.SIMPLE_RUNNER_RUNS_DIR }))'
CODEX_BIN="$(which codex)"
CLAUDE_BIN="$(which claude)"
GEMINI_BIN="$(which gemini)"
OPENCODE_BIN="$(which opencode)"
printf '%s\n' "$CODEX_BIN" "$CLAUDE_BIN" "$GEMINI_BIN" "$OPENCODE_BIN"
[[ "$CODEX_BIN" == "$ROOT_DIR/e2e/docker/fake-bin/codex" ]]
[[ "$CLAUDE_BIN" == "$ROOT_DIR/e2e/docker/fake-bin/claude" ]]
[[ "$GEMINI_BIN" == "$ROOT_DIR/e2e/docker/fake-bin/gemini" ]]
[[ "$OPENCODE_BIN" == "$ROOT_DIR/e2e/docker/fake-bin/opencode" ]]
codex --version
claude --version
gemini --version
opencode --version

echo "== Running simple-runner e2e workflow =="
node dist/cli.js \
  --yes \
  --skip-intake \
  --no-auto-commit \
  --cycles 3 \
  --exchanges 1 \
  --project "$APP_DIR" \
  --team simple-e2e \
  --orchestrator codex:gpt-5.4-mini \
  --goal "Create the smallest full-stack app in this repository: a built static HTML frontend that fetches /api/message from a Node backend, plus npm build and npm start scripts."

echo "== Running gemini orchestrator smoke workflow =="
node dist/cli.js \
  --yes \
  --skip-intake \
  --no-auto-commit \
  --cycles 1 \
  --exchanges 1 \
  --project "$APP_DIR" \
  --team simple-e2e \
  --orchestrator gemini-cli:gemini-2.5-flash \
  --goal "Confirm the generated simple app still satisfies the repository goal and stop once verified."

echo "== Building generated app =="
npm --prefix "$APP_DIR" run build

echo "== Starting generated app =="
PORT="$PORT" node "$APP_DIR/dist/server.mjs" >"$PROOF_DIR/server.log" 2>&1 &
SERVER_PID=$!
cleanup() {
  if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "== Validating live HTTP responses =="
PORT="$PORT" node <<'NODE'
const port = Number(process.env.PORT || "3210");

async function fetchWithRetry(url) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const apiResponse = await fetchWithRetry(`http://127.0.0.1:${port}/api/message`);
const apiPayload = await apiResponse.json();
if (apiPayload.message !== "hello from the backend") {
  throw new Error(`Unexpected API payload: ${JSON.stringify(apiPayload)}`);
}

const htmlResponse = await fetchWithRetry(`http://127.0.0.1:${port}/`);
const html = await htmlResponse.text();
if (!html.includes("Simple Runner E2E") || !html.includes("/api/message")) {
  throw new Error("Rendered HTML is missing the expected frontend content.");
}

console.log("API_OK", JSON.stringify(apiPayload));
console.log("HTML_OK", html.match(/<title>.*<\/title>/)?.[0] ?? "<title>missing</title>");
NODE

echo "== OpenCode smoke via Gemini credentials =="
opencode --provider gemini --model gemini-2.5-flash >"$PROOF_DIR/opencode-proof.json"
cat "$PROOF_DIR/opencode-proof.json"

LATEST_RUN_LOG="$(find "$RUNS_DIR" -name log.jsonl 2>/dev/null | sort | tail -n 1)"
if [[ -z "$LATEST_RUN_LOG" ]]; then
  LATEST_RUN_LOG="$(find "$HOME/.simple-runner/runs" -name log.jsonl 2>/dev/null | sort | tail -n 1)"
fi

echo "== Proof: agent models used =="
cat "$PROOF_DIR/agent-proof.log"

echo "== Proof: orchestration events =="
grep '"event":"agent_run_start"' "$LATEST_RUN_LOG"

echo "== Proof: built files =="
find "$APP_DIR/dist" -maxdepth 2 -type f | sort

echo "== E2E container completed successfully =="
