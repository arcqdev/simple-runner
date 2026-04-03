import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function runnerAcpCliPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "runner-acp.js");
}

export function spawnRunnerAcpServer(options = {}) {
  return spawn(process.execPath, [runnerAcpCliPath()], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
