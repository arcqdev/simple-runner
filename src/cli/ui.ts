import process from "node:process";

export function writeStdout(text: string): void {
  process.stdout.write(text);
}

export function writeStderr(text: string): void {
  process.stderr.write(text);
}

export function emitJson(payload: Record<string, unknown>): void {
  writeStdout(`${JSON.stringify(payload)}\n`);
}

export function printLines(lines: string[]): void {
  writeStdout(`${lines.join("\n")}\n`);
}
