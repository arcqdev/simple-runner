import process from "node:process";

import { stringifyJson } from "../runtime/json.js";

let progressStream: "stdout" | "stderr" = "stdout";

export function setProgressOutput(target: "stdout" | "stderr"): void {
  progressStream = target;
}

export function writeStdout(text: string): void {
  if (progressStream === "stderr") {
    process.stderr.write(text);
    return;
  }
  process.stdout.write(text);
}

export function writeStderr(text: string): void {
  process.stderr.write(text);
}

export function emitJson(payload: Record<string, unknown>): void {
  process.stdout.write(`${stringifyJson(payload)}\n`);
}

export function printLines(lines: string[]): void {
  writeStdout(`${lines.join("\n")}\n`);
}
