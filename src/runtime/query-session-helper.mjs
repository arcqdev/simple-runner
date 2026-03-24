import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";

const DEFAULT_TIMEOUT_S = 7200;
const MAX_BUFFER_BYTES = 50 * 1024 * 1024;

function toRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function stringField(value, key) {
  const candidate = value?.[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function numberField(value, key) {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : 0;
}

function parseJsonLines(text) {
  return text
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return toRecord(parsed) === null ? [] : [parsed];
      } catch {
        return [];
      }
    });
}

function parseTextBlocks(content) {
  if (!Array.isArray(content)) {
    return null;
  }

  const joined = content
    .flatMap((item) => {
      const record = toRecord(item);
      const text = stringField(record, "text") ?? stringField(record, "content");
      return text === null ? [] : [text];
    })
    .join("");

  return joined.length > 0 ? joined : null;
}

function parseClaudeCliOutput(result) {
  const messages = parseJsonLines(result.stdout);
  let resultText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let sessionId = null;
  const errorMessages = [];

  for (const message of messages) {
    sessionId ??= stringField(message, "session_id") ?? stringField(message, "sessionId");
    const messageType = stringField(message, "type") ?? "";

    if (messageType === "result") {
      resultText =
        stringField(message, "result") ??
        stringField(message, "response") ??
        stringField(message, "message") ??
        resultText;
      const usage = toRecord(message.usage);
      inputTokens += numberField(usage, "input_tokens") || numberField(usage, "prompt_tokens");
      outputTokens +=
        numberField(usage, "output_tokens") || numberField(usage, "completion_tokens");
      continue;
    }

    if (messageType === "assistant" || messageType === "assistant_message") {
      const embedded = toRecord(message.message);
      resultText =
        stringField(message, "message") ??
        stringField(embedded, "message") ??
        parseTextBlocks(embedded?.content) ??
        resultText;
      continue;
    }

    if (messageType === "error") {
      const errorText = stringField(message, "message") ?? stringField(message, "error");
      if (errorText !== null) {
        errorMessages.push(errorText);
      }
    }
  }

  if (resultText.length === 0 && errorMessages.length > 0) {
    resultText = errorMessages.at(-1) ?? "";
  }

  return {
    inputTokens,
    isError: errorMessages.length > 0 && resultText.length === 0,
    outputTokens,
    resultText,
    sessionId,
  };
}

function parseCodexOutput(result) {
  const messages = parseJsonLines(result.stdout);
  let resultText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let sessionId = null;
  const errorMessages = [];

  for (const message of messages) {
    const inner = toRecord(message.msg);
    const messageType = stringField(message, "type") ?? stringField(inner, "type") ?? "";

    if (messageType === "thread.started") {
      sessionId = stringField(message, "thread_id") ?? stringField(message, "session_id") ?? sessionId;
      continue;
    }
    if (messageType === "agent_message") {
      resultText = stringField(inner, "message") ?? stringField(message, "message") ?? resultText;
      continue;
    }
    if (messageType === "token_count") {
      inputTokens += numberField(inner, "input_tokens") || numberField(message, "input_tokens");
      outputTokens += numberField(inner, "output_tokens") || numberField(message, "output_tokens");
      continue;
    }
    if (messageType === "item.completed") {
      const item = toRecord(message.item);
      if (stringField(item, "type") === "agent_message") {
        resultText = stringField(item, "text") ?? resultText;
      } else if (stringField(item, "role") === "assistant") {
        resultText = parseTextBlocks(item?.content) ?? resultText;
      }
      continue;
    }
    if (messageType === "error") {
      const text =
        stringField(inner, "message") ??
        stringField(inner, "error") ??
        stringField(message, "message") ??
        stringField(message, "error");
      if (text !== null) {
        errorMessages.push(text);
      }
    }
  }

  if (resultText.length === 0 && errorMessages.length > 0) {
    resultText = errorMessages.at(-1) ?? "";
  }

  return {
    inputTokens,
    isError: errorMessages.length > 0 && resultText.length > 0,
    outputTokens,
    resultText,
    sessionId,
  };
}

function parseCursorOutput(result) {
  const messages = parseJsonLines(result.stdout);
  let resultText = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let sessionId = null;

  for (const message of messages) {
    if (stringField(message, "type") === "result") {
      const raw = message.result;
      resultText = raw == null ? resultText : typeof raw === "string" ? raw : JSON.stringify(raw);
    }

    const usage = toRecord(message.usage) ?? message;
    if ("input_tokens" in usage) {
      inputTokens += numberField(usage, "input_tokens");
      outputTokens += numberField(usage, "output_tokens");
    }

    sessionId =
      stringField(message, "chatId") ??
      stringField(message, "chat_id") ??
      stringField(message, "session_id") ??
      sessionId;
  }

  return {
    inputTokens,
    outputTokens,
    resultText,
    sessionId,
  };
}

function parseGeminiOutput(result) {
  const trimmed = result.stdout.trim();
  if (trimmed.length === 0) {
    return { resultText: "" };
  }
  try {
    const parsed = JSON.parse(trimmed);
    const record = toRecord(parsed);
    if (record === null) {
      return { resultText: trimmed };
    }
    const stats = toRecord(record.stats);
    const models = toRecord(stats?.models);
    let inputTokens = 0;
    let outputTokens = 0;
    if (models !== null) {
      for (const modelStats of Object.values(models)) {
        const tokens = toRecord(toRecord(modelStats)?.tokens);
        inputTokens += numberField(tokens, "prompt");
        outputTokens += numberField(tokens, "candidates");
      }
    }
    return {
      inputTokens,
      outputTokens,
      resultText: typeof record.response === "string" ? record.response : JSON.stringify(record.response),
      sessionId: inputTokens + outputTokens > 0 ? "last" : null,
    };
  } catch {
    return { resultText: trimmed };
  }
}

const ADAPTERS = {
  "claude-cli": {
    buildCommand({ model, prompt, maxTurns, sessionId }) {
      const args = [
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
        "--permission-mode",
        "bypassPermissions",
        "--disallowedTools",
        "AskUserQuestion",
        "--model",
        model,
        "--max-turns",
        String(maxTurns),
      ];
      if (sessionId !== null) {
        args.push("--resume", sessionId);
      }
      args.push(prompt);
      return { args, command: "claude", cwd: undefined };
    },
    parseOutput: parseClaudeCliOutput,
  },
  codex: {
    buildCommand({ model, prompt, projectDir, sessionId }) {
      const args = ["exec"];
      if (sessionId !== null) {
        args.push("resume", sessionId, prompt);
      } else {
        args.push(prompt);
      }
      args.push(
        "--full-auto",
        "--json",
        "--cd",
        projectDir,
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "-m",
        model,
      );
      return { args, command: "codex", cwd: undefined };
    },
    parseOutput: parseCodexOutput,
  },
  cursor: {
    buildCommand({ model, prompt, projectDir, sessionId }) {
      const args = [
        "-p",
        "-f",
        "--output-format",
        "stream-json",
        "--model",
        model,
        "--workspace",
        projectDir,
      ];
      if (sessionId !== null) {
        args.push("--resume", sessionId);
      }
      args.push(prompt);
      return { args, command: "cursor-agent", cwd: projectDir };
    },
    parseOutput: parseCursorOutput,
  },
  "gemini-cli": {
    buildCommand({ model, prompt, projectDir, sessionId }) {
      const args = ["-p", prompt, "-y", "--output-format", "json", "-m", model];
      if (sessionId !== null) {
        args.push("--resume");
      }
      return { args, command: "gemini", cwd: projectDir };
    },
    parseOutput: parseGeminiOutput,
  },
};

function classifySessionError(result, backend, timeoutS) {
  if (result.error?.code === "ETIMEDOUT") {
    return `${backend}: Process timed out after ${timeoutS}s.`;
  }
  return result.stderr.trim() || result.stdout.trim() || `${backend}: process failed`;
}

const [, , payloadPath, outputPath] = process.argv;
const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
const adapter = ADAPTERS[payload.backend];
const finalPrompt =
  payload.systemPrompt && payload.systemPrompt.length > 0
    ? `${payload.systemPrompt}\n\n${payload.prompt}`
    : payload.prompt;
const command = adapter.buildCommand({
  maxTurns: payload.maxTurns,
  model: payload.model,
  projectDir: payload.projectDir,
  prompt: finalPrompt,
  sessionId: payload.resumeSessionId,
});
const startedAt = Date.now();
const result = spawnSync(command.command, command.args, {
  cwd: command.cwd,
  encoding: "utf8",
  env: { ...process.env, ANTHROPIC_API_KEY: undefined },
  killSignal: "SIGKILL",
  maxBuffer: MAX_BUFFER_BYTES,
  stdio: ["ignore", "pipe", "pipe"],
  timeout: (payload.timeoutS ?? DEFAULT_TIMEOUT_S) * 1000,
});
const parsed = adapter.parseOutput({
  stderr: result.stderr ?? "",
  stdout: result.stdout ?? "",
});
const isError =
  (result.status ?? 1) !== 0 || result.signal !== null || result.error !== undefined || parsed.isError === true;
const text =
  parsed.resultText?.trim() ||
  (isError ? classifySessionError(result, payload.backend, payload.timeoutS ?? DEFAULT_TIMEOUT_S) : "");

writeFileSync(
  outputPath,
  `${JSON.stringify(
    {
      elapsedS: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
      inputTokens: parsed.inputTokens ?? null,
      isError,
      outputTokens: parsed.outputTokens ?? null,
      sessionId: parsed.sessionId ?? payload.resumeSessionId ?? null,
      text,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
