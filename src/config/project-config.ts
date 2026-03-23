import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CliError } from "../core/errors.js";

export type ProjectConfig = Record<string, unknown>;

export function projectConfigPath(projectDir: string): string {
  return path.join(projectDir, ".kodo", "config.json");
}

export function saveProjectConfig(projectDir: string, config: ProjectConfig): void {
  const filePath = projectConfigPath(projectDir);
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliError(`Cannot write config to ${path.dirname(filePath)} (${detail})`);
  }
}

export function loadProjectConfig(projectDir: string): ProjectConfig | null {
  const primary = projectConfigPath(projectDir);
  const legacy = path.join(projectDir, ".kodo", "last-config.json");

  for (const filePath of [primary, legacy]) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        continue;
      }
      const config = { ...(parsed as ProjectConfig) };
      if ("mode" in config && !("team" in config)) {
        config.team = config.mode;
        delete config.mode;
      }
      return config;
    } catch {
      continue;
    }
  }

  return null;
}
