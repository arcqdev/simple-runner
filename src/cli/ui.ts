import process from "node:process";

import { stringifyJson } from "../runtime/json.js";

export function writeStdout(text: string): void {
  process.stdout.write(text);
}

export function writeStderr(text: string): void {
  process.stderr.write(text);
}

export function emitJson(payload: Record<string, unknown>): void {
  writeStdout(`${stringifyJson(payload)}\n`);
}

export function printLines(lines: string[]): void {
  writeStdout(`${lines.join("\n")}\n`);
}
