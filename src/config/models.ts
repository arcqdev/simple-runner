import { spawnSync } from "node:child_process";
import process from "node:process";

export const OLLAMA_LOCAL = "ollama-local";
export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1";
export const ACP_GEMINI_ENV_VARS = ["GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;

export type RuntimeModelBackend =
  | "claude"
  | "claude-cli"
  | "codex"
  | "cursor"
  | "gemini-cli"
  | "opencode"
  | "kimi";

type ModelInfo = {
  alias: string;
  displayName: string;
  fullModelId: string;
};

type Provider = {
  envVars: readonly string[];
  models: readonly ModelInfo[];
  name: string;
  prefix: string;
};

const PROVIDER_REGISTRY: readonly Provider[] = [
  {
    envVars: ["ANTHROPIC_API_KEY"],
    models: [
      { alias: "opus", displayName: "Claude Opus", fullModelId: "claude-opus-4-6" },
      { alias: "sonnet", displayName: "Claude Sonnet", fullModelId: "claude-sonnet-4-6" },
      { alias: "haiku", displayName: "Claude Haiku", fullModelId: "claude-haiku-4-5" },
    ],
    name: "Anthropic",
    prefix: "anthropic",
  },
  {
    envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    models: [
      {
        alias: "gemini-pro",
        displayName: "Gemini Pro",
        fullModelId: "gemini-3.1-pro-preview",
      },
      {
        alias: "gemini-flash",
        displayName: "Gemini Flash",
        fullModelId: "gemini-3-flash-preview",
      },
      {
        alias: "gemini-flash-lite",
        displayName: "Gemini Flash Lite",
        fullModelId: "gemini-3.1-flash-lite-preview",
      },
    ],
    name: "Google",
    prefix: "google-gla",
  },
  {
    envVars: ["OPENAI_API_KEY"],
    models: [
      { alias: "gpt-5.4", displayName: "GPT-5.4", fullModelId: "gpt-5.4" },
      { alias: "gpt-5.4-mini", displayName: "GPT-5.4 Mini", fullModelId: "gpt-5.4-mini" },
      { alias: "gpt-5.4-nano", displayName: "GPT-5.4 Nano", fullModelId: "gpt-5.4-nano" },
    ],
    name: "OpenAI",
    prefix: "openai",
  },
  {
    envVars: ["DEEPSEEK_API_KEY"],
    models: [
      { alias: "deepseek", displayName: "DeepSeek Chat", fullModelId: "deepseek-chat" },
      {
        alias: "deepseek-reasoner",
        displayName: "DeepSeek Reasoner",
        fullModelId: "deepseek-reasoner",
      },
    ],
    name: "DeepSeek",
    prefix: "deepseek",
  },
  {
    envVars: ["GROQ_API_KEY"],
    models: [
      {
        alias: "llama-4-scout",
        displayName: "Llama 4 Scout",
        fullModelId: "meta-llama/llama-4-scout-17b-16e-instruct",
      },
      {
        alias: "llama-70b",
        displayName: "Llama 3.3 70B",
        fullModelId: "llama-3.3-70b-versatile",
      },
    ],
    name: "Groq",
    prefix: "groq",
  },
  {
    envVars: ["OPENROUTER_API_KEY"],
    models: [
      {
        alias: "openrouter-auto",
        displayName: "OpenRouter Auto",
        fullModelId: "openrouter/auto",
      },
    ],
    name: "OpenRouter",
    prefix: "openrouter",
  },
  {
    envVars: ["MISTRAL_API_KEY"],
    models: [
      { alias: "codestral", displayName: "Codestral", fullModelId: "codestral-2508" },
      {
        alias: "mistral-large",
        displayName: "Mistral Large",
        fullModelId: "mistral-large-latest",
      },
    ],
    name: "Mistral",
    prefix: "mistral",
  },
  {
    envVars: ["XAI_API_KEY"],
    models: [{ alias: "grok-3", displayName: "Grok 3", fullModelId: "grok-3" }],
    name: "xAI",
    prefix: "xai",
  },
] as const;

const RUNTIME_MODEL_CATALOG: Record<
  RuntimeModelBackend,
  { defaultModel: string; suggestions: string[] }
> = {
  claude: {
    defaultModel: "opus",
    suggestions: ["opus", "sonnet", "haiku"],
  },
  "claude-cli": {
    defaultModel: "opus",
    suggestions: ["opus", "sonnet", "haiku"],
  },
  codex: {
    defaultModel: "gpt-5.4",
    suggestions: ["gpt-5.4", "gpt-5.3-codex", "o3"],
  },
  cursor: {
    defaultModel: "composer-1.5",
    suggestions: ["composer-1.5", "sonnet-4-thinking", "gpt-5"],
  },
  "gemini-cli": {
    defaultModel: "gemini-3-flash",
    suggestions: ["gemini-3-flash", "gemini-3-pro", "gemini-2.5-flash"],
  },
  opencode: {
    defaultModel: "gemini-2.5-flash",
    suggestions: ["gemini-2.5-flash", "gemini-3-flash", "gemini-3-pro"],
  },
  kimi: {
    defaultModel: "kimi-k2.5",
    suggestions: ["kimi-k2.5"],
  },
};

const CLI_ORCHESTRATORS = new Set(["claude-code", "gemini-cli", "codex", "cursor", "kimi-code"]);

function hasEnvVar(name: string, env: NodeJS.ProcessEnv): boolean {
  return typeof env[name] === "string" && env[name]!.trim().length > 0;
}

function providerHasKey(provider: Provider, env: NodeJS.ProcessEnv): boolean {
  return provider.envVars.some((envVar) => hasEnvVar(envVar, env));
}

function providerForModel(model: string): Provider | null {
  for (const provider of PROVIDER_REGISTRY) {
    if (
      provider.models.some(
        (candidate) => candidate.alias === model || candidate.fullModelId === model,
      )
    ) {
      return provider;
    }
    if (model.startsWith(`${provider.prefix}:`)) {
      return provider;
    }
  }
  return null;
}

export function availableProviders(env = process.env): Provider[] {
  return PROVIDER_REGISTRY.filter((provider) => providerHasKey(provider, env));
}

export function availableModelChoices(env = process.env): Array<[string, string, string]> {
  return availableProviders(env).flatMap((provider) =>
    provider.models.map((model) => [model.alias, model.displayName, provider.name] as const),
  );
}

export function defaultModelForBackend(
  backend: RuntimeModelBackend,
): (typeof RUNTIME_MODEL_CATALOG)[RuntimeModelBackend]["defaultModel"] {
  return RUNTIME_MODEL_CATALOG[backend].defaultModel;
}

export function suggestedModelsForBackend(backend: RuntimeModelBackend): string[] {
  return [...RUNTIME_MODEL_CATALOG[backend].suggestions];
}

export function isOllamaModel(model: string | null | undefined): boolean {
  if (typeof model !== "string" || model.length === 0) {
    return false;
  }
  return model === OLLAMA_LOCAL || model.startsWith("ollama:") || model.startsWith("ollama/");
}

export function impliedOrchestratorFromModel(model: string | null | undefined): string | null {
  return isOllamaModel(model) ? "api" : null;
}

export function ensureOllamaBaseUrl(env: NodeJS.ProcessEnv): string {
  const existing = env.OLLAMA_BASE_URL;
  if (typeof existing === "string" && existing.trim().length > 0) {
    return existing;
  }
  env.OLLAMA_BASE_URL = OLLAMA_DEFAULT_BASE_URL;
  return env.OLLAMA_BASE_URL;
}

export function listOllamaModels(env = process.env): string[] {
  const script = `
    const target = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
    const base = target.endsWith("/v1") ? target.slice(0, -3) : target;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(base.replace(/\\/$/, "") + "/api/tags", {
        method: "GET",
        signal: controller.signal,
      });
      const payload = await response.json();
      const names = [];
      for (const item of payload?.models ?? []) {
        const name = typeof item?.name === "string" ? item.name : typeof item?.model === "string" ? item.model : null;
        if (name && !names.includes(name)) names.push(name);
      }
      process.stdout.write(JSON.stringify(names));
    } catch {
      process.stdout.write("[]");
    } finally {
      clearTimeout(timer);
    }
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    encoding: "utf8",
    env: { ...env },
    timeout: 3000,
  });
  if (child.status !== 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(child.stdout.trim()) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

export function normalizeOllamaModel(model: string, env = process.env): string {
  if (model === OLLAMA_LOCAL) {
    const detected = listOllamaModels(env);
    if (detected.length === 0) {
      throw new Error(
        "No local Ollama model detected at http://localhost:11434. Run `ollama pull <model>` first.",
      );
    }
    return `ollama:${detected[0]}`;
  }
  if (model.startsWith("ollama/")) {
    return `ollama:${model.slice("ollama/".length)}`;
  }
  return model;
}

export function apiOrchestratorModelOptions(env = process.env): string[] {
  return [
    ...availableModelChoices(env).map(([alias]) => alias),
    ...listOllamaModels(env).map((model) => `ollama:${model}`),
  ];
}

export function defaultApiModel(env = process.env): string {
  if (hasEnvVar("OPENAI_API_KEY", env)) {
    return "gpt-5.4";
  }
  if (hasEnvVar("ANTHROPIC_API_KEY", env)) {
    return "opus";
  }
  if (hasEnvVar("GEMINI_API_KEY", env) || hasEnvVar("GOOGLE_API_KEY", env)) {
    return "gemini-flash";
  }
  const provider = availableProviders(env)[0];
  if (provider !== undefined) {
    return provider.models[0]?.alias ?? "gpt-5.4";
  }
  const ollamaModel = listOllamaModels(env)[0];
  if (ollamaModel !== undefined) {
    return `ollama:${ollamaModel}`;
  }
  return "gpt-5.4";
}

export function checkApiKeyForModel(
  model: string | null | undefined,
  env = process.env,
): string | null {
  if (!model) {
    return null;
  }
  if (isOllamaModel(model)) {
    if (model === OLLAMA_LOCAL && listOllamaModels(env).length === 0) {
      return "No local Ollama model detected at http://localhost:11434. Run `ollama pull <model>` first.";
    }
    return null;
  }

  const provider = providerForModel(model);
  if (provider !== null) {
    if (providerHasKey(provider, env)) {
      return null;
    }
    return `${provider.envVars.join(" or ")} not set — required for ${provider.name} models`;
  }

  if (model.startsWith("gemini")) {
    return hasEnvVar("GEMINI_API_KEY", env) || hasEnvVar("GOOGLE_API_KEY", env)
      ? null
      : "GEMINI_API_KEY or GOOGLE_API_KEY not set — required for Gemini models";
  }
  if (!hasEnvVar("ANTHROPIC_API_KEY", env)) {
    return "ANTHROPIC_API_KEY not set — required for API orchestrator with Claude models";
  }
  return null;
}

export function checkApiKey(
  orchestrator: string,
  model: string | null | undefined,
  env = process.env,
): string | null {
  if (CLI_ORCHESTRATORS.has(orchestrator)) {
    return null;
  }
  return checkApiKeyForModel(model, env);
}
