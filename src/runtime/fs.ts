import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

import { CliError } from "../core/errors.js";

export type PathKind = "any" | "directory" | "file";

function matchesKind(filePath: string, kind: PathKind): boolean {
  if (kind === "any") {
    return true;
  }

  const stats = statSync(filePath);
  return kind === "directory" ? stats.isDirectory() : stats.isFile();
}

export function resolveExistingPath(filePath: string, kind: PathKind = "any"): string {
  const resolved = path.resolve(filePath);
  if (!existsSync(resolved)) {
    throw new CliError(`Path does not exist: ${filePath}`);
  }
  if (!matchesKind(resolved, kind)) {
    throw new CliError(
      kind === "directory"
        ? `Expected a directory: ${filePath}`
        : kind === "file"
          ? `Expected a file: ${filePath}`
          : `Invalid path: ${filePath}`,
    );
  }
  return resolved;
}

export function ensureDirectory(filePath: string): string {
  const resolved = path.resolve(filePath);
  mkdirSync(resolved, { recursive: true });
  return resolved;
}

export function isSubPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function safeJoin(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, ...segments);
  if (!isSubPath(resolvedRoot, candidate)) {
    throw new CliError(`Path escapes root: ${segments.join("/") || "."}`);
  }
  return candidate;
}
