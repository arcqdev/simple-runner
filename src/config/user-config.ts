import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type UserConfig = Record<string, unknown>;

const cache = new Map<string, UserConfig>();

function configPath(homeDir: string): string {
  return path.join(homeDir, ".simple-runner", "config.json");
}

export function loadUserConfig(homeDir = os.homedir()): UserConfig {
  const cached = cache.get(homeDir);
  if (cached !== undefined) {
    return cached;
  }

  const filePath = configPath(homeDir);
  if (!existsSync(filePath)) {
    cache.set(homeDir, {});
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    const config =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as UserConfig)
        : {};
    cache.set(homeDir, config);
    return config;
  } catch {
    cache.set(homeDir, {});
    return {};
  }
}

export function clearUserConfigCache(): void {
  cache.clear();
}

export function getUserDefault<T>(key: string, fallback: T, homeDir = os.homedir()): T {
  const config = loadUserConfig(homeDir);
  return (config[key] as T | undefined) ?? fallback;
}
