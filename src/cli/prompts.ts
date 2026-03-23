import { readSync } from "node:fs";
import process from "node:process";

import { writeStdout } from "./ui.js";

export type PromptAdapter = {
  confirm(message: string, defaultValue?: boolean): boolean | null;
  multiline?(message: string): string | null;
  multiselect(message: string, choices: string[], defaults?: string[]): string[] | null;
  select(message: string, choices: string[], defaultValue?: string): string | null;
  text(message: string, defaultValue?: string): string | null;
};

let activeAdapter: PromptAdapter | null = null;

function readLine(): string | null {
  const chunks: number[] = [];
  const buffer = Buffer.alloc(1);

  while (true) {
    const count = readSync(0, buffer, 0, 1, null);
    if (count === 0) {
      return chunks.length === 0 ? null : Buffer.from(chunks).toString("utf8");
    }
    if (buffer[0] === 10) {
      return Buffer.from(chunks).toString("utf8");
    }
    if (buffer[0] !== 13) {
      chunks.push(buffer[0]);
    }
  }
}

const defaultAdapter: PromptAdapter = {
  text(message, defaultValue) {
    writeStdout(defaultValue !== undefined && defaultValue.length > 0 ? `${message} [${defaultValue}]: ` : `${message}: `);
    const line = readLine();
    if (line === null) {
      return null;
    }
    return line.length === 0 && defaultValue !== undefined ? defaultValue : line;
  },
  confirm(message, defaultValue = false) {
    const suffix = defaultValue ? "[Y/n]" : "[y/N]";
    writeStdout(`${message} ${suffix} `);
    const line = readLine();
    if (line === null) {
      return null;
    }
    if (line.trim() === "") {
      return defaultValue;
    }
    const normalized = line.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  },
  multiline(message) {
    writeStdout(`${message}\n`);
    writeStdout("----------------------------------------\n");
    const lines: string[] = [];

    if (!process.stdin.isTTY) {
      while (true) {
        const line = readLine();
        if (line === null) {
          break;
        }
        lines.push(line);
      }
    } else {
      while (true) {
        const line = readLine();
        if (line === null) {
          break;
        }
        if (line === "") {
          break;
        }
        lines.push(line);
      }
    }

    return lines.join("\n");
  },
  select(message, choices, defaultValue) {
    writeStdout(`${message}\n`);
    for (const choice of choices) {
      writeStdout(`  - ${choice}${choice === defaultValue ? " (default)" : ""}\n`);
    }
    writeStdout("> ");
    const line = readLine();
    if (line === null) {
      return null;
    }
    const trimmed = line.trim();
    if (trimmed === "" && defaultValue !== undefined) {
      return defaultValue;
    }
    if (choices.includes(trimmed)) {
      return trimmed;
    }
    const parsedIndex = Number.parseInt(trimmed, 10);
    if (Number.isInteger(parsedIndex) && parsedIndex >= 1 && parsedIndex <= choices.length) {
      return choices[parsedIndex - 1];
    }
    return trimmed;
  },
  multiselect(message, choices, defaults = []) {
    writeStdout(`${message}\n`);
    for (const choice of choices) {
      writeStdout(`  - ${choice}${defaults.includes(choice) ? " (default)" : ""}\n`);
    }
    writeStdout("Comma-separated values, empty for default: ");
    const line = readLine();
    if (line === null) {
      return null;
    }
    const trimmed = line.trim();
    if (trimmed === "") {
      return defaults;
    }
    return trimmed
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  },
};

export function getPromptAdapter(): PromptAdapter {
  return activeAdapter ?? defaultAdapter;
}

export function setPromptAdapter(adapter: PromptAdapter | null): void {
  activeAdapter = adapter;
}
