import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  availableBackends,
  checkBackendStatus,
  preflightWarningsForBackends,
} from "../../src/runtime/backends.js";

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ORIGINAL_GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

function makeTempDir(prefix: string): string {
  const directory = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(directory, { recursive: true });
  return directory;
}

function writeExecutable(filePath: string, content: string): void {
  writeFileSync(filePath, content, "utf8");
  chmodSync(filePath, 0o755);
}

function installFakeGemini(binDir: string): void {
  const script = `#!${process.execPath}
const { createInterface } = require("node:readline");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("gemini 1.0.0");
  process.exit(0);
}
if (args[0] !== "acp") {
  process.exit(1);
}
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      id: message.id,
      jsonrpc: "2.0",
      result: {
        capabilities: {
          initialize: true,
          prompt: true,
          protocolVersion: "0.1",
          resume: true,
          serverName: "fake-gemini-acp",
          serverVersion: "1.0.0",
          sessionLifecycle: true,
          streaming: true,
          usage: true,
        },
      },
    });
    return;
  }
  if (message.method === "shutdown") {
    send({ id: message.id, jsonrpc: "2.0", result: {} });
    process.exit(0);
  }
});
`;
  writeExecutable(path.join(binDir, "gemini"), script);
}

function installFakeOpencode(binDir: string): void {
  const script = `#!${process.execPath}
const { createInterface } = require("node:readline");
const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("opencode 0.1.0");
  process.exit(0);
}
if (args[0] !== "acp") {
  process.exit(1);
}
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      id: message.id,
      jsonrpc: "2.0",
      result: {
        capabilities: {
          initialize: true,
          prompt: true,
          protocolVersion: "0.1",
          resume: true,
          serverName: "fake-opencode-acp",
          serverVersion: "0.1.0",
          sessionLifecycle: true,
          streaming: true,
          usage: true,
        },
      },
    });
    return;
  }
  if (message.method === "shutdown") {
    send({ id: message.id, jsonrpc: "2.0", result: {} });
    process.exit(0);
  }
});
`;
  writeExecutable(path.join(binDir, "opencode"), script);
}

afterEach(() => {
  process.env.PATH = ORIGINAL_PATH;
  if (ORIGINAL_GEMINI_API_KEY === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = ORIGINAL_GEMINI_API_KEY;
  }
  if (ORIGINAL_GOOGLE_API_KEY === undefined) {
    delete process.env.GOOGLE_API_KEY;
  } else {
    process.env.GOOGLE_API_KEY = ORIGINAL_GOOGLE_API_KEY;
  }
});

describe("ACP backend discovery", () => {
  it("marks gemini-cli and opencode available from their ACP transport commands", () => {
    const binDir = makeTempDir("backend-bin");
    installFakeGemini(binDir);
    installFakeOpencode(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH ?? ""}`;

    const backends = availableBackends();
    expect(backends["gemini-cli"]).toBe(true);
    expect(backends.opencode).toBe(true);
  });

  it("reports ACP readiness and missing credentials distinctly", () => {
    const binDir = makeTempDir("backend-bin");
    installFakeGemini(binDir);
    process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH ?? ""}`;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    const status = checkBackendStatus("gemini-cli");
    expect(status.version).toContain("fake-gemini-acp");
    expect(status.warning).toContain("credentials are missing");
    expect(status.warning).toContain("GEMINI_API_KEY");
  });

  it("surfaces ACP-specific install and credential hints in preflight warnings", () => {
    const binDir = makeTempDir("backend-bin");
    installFakeOpencode(binDir);
    process.env.PATH = binDir;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;

    const warnings = preflightWarningsForBackends(["opencode", "gemini-cli", "claude-cli"]);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "opencode: opencode: ACP transport is reachable, but credentials are missing.",
        ),
        expect.stringContaining("gemini-cli: backend unavailable. Install gemini-cli"),
        expect.stringContaining("claude-cli: backend unavailable. Install claude"),
      ]),
    );
  });
});
