import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import os from "node:os";

export const RUN_ARCHIVE_NAME = "run.tar.gz";
const TRACE_ARCHIVE_NAME = "trace.tar.gz";
const TRACE_ARCHIVE_ENTRIES = [
  "log.jsonl",
  "run.jsonl",
  "goal.md",
  "config.json",
  "team.json",
] as const;
const SECRET_ASSIGNMENT_RE =
  /(?:(["'])?([a-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|access[_-]?key)[a-z0-9_.-]*)(\1)?\s*(=|:)\s*)(["'])?([^"',\s}]+)\5?/giu;
const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const PHONE_RE =
  /(?<!\w)(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?:\s*(?:#|x|ext\.?)\s*\d+)?(?!\w)/gu;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/gu;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu;
const PRIVATE_KEY_RE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu;
const COMMON_SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bAIza[0-9A-Za-z_-]{20,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
] as const;

export type ArchiveStats = {
  filesChanged: number;
  redactions: number;
};

export type ArchiveResult = {
  path: string;
  stats: ArchiveStats;
};

type ArchivePayloadResult = {
  payload: Buffer;
  stats: ArchiveStats;
};

function traceArchiveEntries(runDir: string): string[] {
  const entries = TRACE_ARCHIVE_ENTRIES.filter((name) => existsSync(path.join(runDir, name))).map(
    (name) => String(name),
  );
  if (existsSync(path.join(runDir, "conversations"))) {
    entries.push("conversations");
  }
  return [...entries];
}

function gatherShareArchiveEntries(runDir: string): string[] {
  const candidates = [
    "log.jsonl",
    "run.jsonl",
    "goal.md",
    "goal-refined.md",
    "goal-plan.json",
    "config.json",
    "team.json",
    "test-report.md",
    "improve-report.md",
  ];
  const entries = candidates.filter((name) => existsSync(path.join(runDir, name)));

  const conversationsDir = path.join(runDir, "conversations");
  if (existsSync(conversationsDir)) {
    entries.push("conversations");
  }

  for (const entry of readdirSync(runDir)) {
    if (!entry.endsWith(".md") || entries.includes(entry)) {
      continue;
    }
    entries.push(entry);
  }

  return entries;
}

export function packRunArchive(runDir: string): ArchiveResult | null {
  const entries = gatherShareArchiveEntries(runDir);
  if (entries.length === 0) {
    return null;
  }

  const archivePath = path.join(runDir, RUN_ARCHIVE_NAME);
  const archive = buildArchivePayload(runDir, entries);
  writeFileSync(archivePath, archive.payload);
  return { path: archivePath, stats: archive.stats };
}

export function createTraceArchive(runDir: string): ArchiveResult | null {
  const entries = traceArchiveEntries(runDir);
  if (entries.length === 0) {
    return null;
  }

  const archivePath = path.join(runDir, TRACE_ARCHIVE_NAME);
  const archive = buildArchivePayload(runDir, entries);
  writeFileSync(archivePath, archive.payload);
  return { path: archivePath, stats: archive.stats };
}

export function createTraceArchivePayload(runDir: string): ArchivePayloadResult | null {
  const entries = traceArchiveEntries(runDir);
  return entries.length === 0 ? null : buildArchivePayload(runDir, entries);
}

function buildArchivePayload(runDir: string, entries: string[]): ArchivePayloadResult {
  const stagingDir = mkdtempSync(path.join(os.tmpdir(), "simple-runner-archive-"));
  const stats: ArchiveStats = {
    filesChanged: 0,
    redactions: 0,
  };

  try {
    for (const entry of entries) {
      stageEntry(runDir, stagingDir, entry, stats);
    }

    const result = spawnSync("tar", ["-czf", "-", ...entries], {
      cwd: stagingDir,
      encoding: null,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status !== 0) {
      const fallback = Object.fromEntries(
        entries.map((entry) => {
          const fullPath = path.join(stagingDir, entry);
          const entryStats = statSync(fullPath);
          if (entryStats.isDirectory()) {
            return [entry, { type: "directory" }];
          }
          return [entry, { type: "file", content: readFileSync(fullPath, "utf8") }];
        }),
      );
      return { payload: gzipSync(JSON.stringify(fallback, null, 2)), stats };
    }
    return { payload: Buffer.from(result.stdout), stats };
  } finally {
    rmSync(stagingDir, { force: true, recursive: true });
  }
}

function stageEntry(
  sourceRoot: string,
  stagingRoot: string,
  relativePath: string,
  stats: ArchiveStats,
): void {
  const sourcePath = path.join(sourceRoot, relativePath);
  const destinationPath = path.join(stagingRoot, relativePath);
  const entryStats = statSync(sourcePath);

  if (entryStats.isDirectory()) {
    mkdirSync(destinationPath, { recursive: true });
    for (const child of readdirSync(sourcePath)) {
      stageEntry(sourceRoot, stagingRoot, path.join(relativePath, child), stats);
    }
    return;
  }

  mkdirSync(path.dirname(destinationPath), { recursive: true });
  const original = readFileSync(sourcePath);
  const asText = maybeReadText(original);
  if (asText === null) {
    cpSync(sourcePath, destinationPath);
    return;
  }

  const scrubbed = scrubArchiveText(asText);
  if (scrubbed.redactions > 0) {
    stats.filesChanged += 1;
    stats.redactions += scrubbed.redactions;
  }
  writeFileSync(destinationPath, scrubbed.text, "utf8");
}

function maybeReadText(payload: Buffer): string | null {
  if (payload.includes(0)) {
    return null;
  }
  return payload.toString("utf8");
}

function replaceMatches(
  text: string,
  pattern: RegExp,
  replacement: string | ((match: string, ...groups: string[]) => string),
): { count: number; text: string } {
  let count = 0;
  const next = text.replaceAll(pattern, (...args) => {
    count += 1;
    if (typeof replacement === "string") {
      return replacement;
    }
    return replacement(
      String(args[0]),
      ...args.slice(1, Math.max(args.length - 2, 1)).map((value) => String(value ?? "")),
    );
  });
  return { count, text: next };
}

function luhnCheck(digits: string): boolean {
  let sum = 0;
  let shouldDouble = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = Number(digits[index]);
    if (Number.isNaN(value)) {
      return false;
    }
    if (shouldDouble) {
      value *= 2;
      if (value > 9) {
        value -= 9;
      }
    }
    sum += value;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

function scrubCreditCards(text: string): { redactions: number; text: string } {
  let redactions = 0;
  const next = text.replaceAll(/\b(?:\d[ -]*?){13,19}\b/gu, (match) => {
    const digits = match.replaceAll(/\D/gu, "");
    if (digits.length < 13 || digits.length > 19 || !luhnCheck(digits)) {
      return match;
    }
    redactions += 1;
    return "[secret-redacted]";
  });
  return { redactions, text: next };
}

function scrubArchiveText(text: string): { redactions: number; text: string } {
  let redactions = 0;
  let current = text;

  const assignment = replaceMatches(
    current,
    SECRET_ASSIGNMENT_RE,
    (_match, keyQuote, key, closingQuote, separator, valueQuote) =>
      `${keyQuote}${key}${closingQuote}${separator}${valueQuote}[secret-redacted]${valueQuote}`,
  );
  current = assignment.text;
  redactions += assignment.count;

  for (const pattern of COMMON_SECRET_PATTERNS) {
    const replacement = replaceMatches(current, pattern, "[secret-redacted]");
    current = replacement.text;
    redactions += replacement.count;
  }

  for (const pattern of [JWT_RE, PRIVATE_KEY_RE]) {
    const replacement = replaceMatches(current, pattern, "[secret-redacted]");
    current = replacement.text;
    redactions += replacement.count;
  }

  const card = scrubCreditCards(current);
  current = card.text;
  redactions += card.redactions;

  for (const pattern of [EMAIL_RE, PHONE_RE, SSN_RE]) {
    const replacement = replaceMatches(current, pattern, "[pii-redacted]");
    current = replacement.text;
    redactions += replacement.count;
  }

  return { redactions, text: current };
}
