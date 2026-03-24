import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

let loaded = false;

function findDotEnv(startDir: string): string | null {
  let current = path.resolve(startDir);

  while (true) {
    const candidate = path.join(current, ".env");
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function loadDotEnv(startDir = process.cwd()): void {
  if (loaded) {
    return;
  }
  loaded = true;

  const filePath = findDotEnv(startDir);
  if (filePath === null) {
    return;
  }

  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return;
  }

  for (const line of content.split(/\r?\n/gu)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const normalized = trimmed.startsWith("export ") ? trimmed.slice(7).trimStart() : trimmed;
    const separator = normalized.indexOf("=");
    if (separator <= 0) {
      continue;
    }

    const key = normalized.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || process.env[key] !== undefined) {
      continue;
    }

    const rawValue = normalized.slice(separator + 1).trim();
    process.env[key] = stripWrappingQuotes(rawValue);
  }
}

export function resetDotEnvForTests(): void {
  loaded = false;
}
