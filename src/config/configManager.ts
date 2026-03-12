import { access, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AppConfig, LlmProviderConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";


export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export class ConfigManager {
  private configPath: string;
  private config: AppConfig;

  constructor(configPath = resolve(process.cwd(), "config.json")) {
    this.configPath = configPath;
    this.config = clone(DEFAULT_CONFIG);
  }

  get path(): string {
    return this.configPath;
  }

  setPath(nextPath: string): void {
    this.configPath = resolve(nextPath);
  }

  get(): AppConfig {
    // Defensive copy: callers get data, but cannot mutate internal state directly.
    return clone(this.config);
  }

  async load(): Promise<AppConfig> {
    // Check whether the config file already exists on disk.
    const exists = await fileExists(this.configPath);

    if (!exists) {
      // First run scenario:
      // 1) start from safe defaults in memory,
      // 2) persist them to disk so users can edit the generated file later,
      // 3) return a cloned copy to callers.
      this.config = clone(DEFAULT_CONFIG);
      await this.save();
      return this.get();
    }

    // Existing file scenario:
    // Read raw JSON text from disk...
    const raw = await readFile(this.configPath, "utf-8");
    // ...parse it into a JS value...
    const parsed = JSON.parse(raw) as unknown;
    // ...then normalize + validate it before storing.
    // This guarantees `this.config` always stays in a valid shape.
    this.config = validateAndNormalizeConfig(parsed);
    // Return a clone so callers cannot accidentally mutate internal state.
    return this.get();
  }

  async save(config?: AppConfig): Promise<void> {
    if (config) {
      // If caller passes a full config, validate/normalize before persisting.
      this.config = validateAndNormalizeConfig(config);
    }

    // Persist pretty JSON so the file is human-readable in editors.
    // Trailing newline is a common file formatting convention.
    await writeFile(this.configPath, `${JSON.stringify(this.config, null, 2)}\n`, "utf-8");
  }

  set(config: AppConfig): AppConfig {
    this.config = validateAndNormalizeConfig(config);
    return this.get();
  }

  update(patch: DeepPartial<AppConfig>): AppConfig {
    this.config = validateAndNormalizeConfig(deepMerge(this.config, patch));
    return this.get();
  }

  resetToDefault(): AppConfig {
    this.config = clone(DEFAULT_CONFIG);
    return this.get();
  }

  getTargetProviderConfig(provider: string): LlmProviderConfig | undefined {
    return this.config.agent.llmProviders.find((entry) => entry.provider === provider && entry.enabled);
  }

  getApiKeyForProvider(providerConfig: LlmProviderConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (!providerConfig) {
      return undefined;
    }

    if (providerConfig.apiKeyEnvVar) {
      return env[providerConfig.apiKeyEnvVar];
    }

    return undefined;
  }

  getBaseUrlForProvider(provider: string): string | undefined {
    const providerConfig = this.getTargetProviderConfig(provider);
    return providerConfig?.baseUrl;
  }

  getThinkingLevel(): ThinkingLevel {
    return this.config.agent?.thinkingLevel ?? "off";
  }

  /**
   * Validates that API key exists for the given provider without exposing the key to memory.
   * Throws if the credential is missing.
   */
  ensureProviderCredentials(providerName: string, env: NodeJS.ProcessEnv = process.env): void {
    const providerConfig = this.getTargetProviderConfig(providerName);
    
    if (!providerConfig) {
      throw new Error(`No enabled provider config found for '${providerName}'.`);
    }

    if (!providerConfig.apiKeyEnvVar) {
      throw new Error(`No API key environment variable configured for provider '${providerName}'.`);
    }

    const hasKey = !!env[providerConfig.apiKeyEnvVar];
    if (!hasKey) {
      throw new Error(
        `Missing API key for provider '${providerName}'. Set the environment variable '${providerConfig.apiKeyEnvVar}'.`
      );
    }
  }
}

function validateAndNormalizeConfig(input: unknown): AppConfig {
  // Guard early: top-level config must be a JSON object.
  if (!isRecord(input)) {
    throw new Error("Invalid config: root must be a JSON object.");
  }

  // Step 1) Build a full config object by overlaying user input on top of defaults.
  // - Anything missing in the input falls back to DEFAULT_CONFIG.
  // - Nested objects are merged recursively.
  // - Arrays (like llmProviders) are replaced as a whole when provided.
  //
  // Why this matters:
  // We can validate and use a single "complete" object (`merged`) instead of
  // handling lots of optional/undefined checks throughout the app.
  const merged = deepMerge(DEFAULT_CONFIG, input as DeepPartial<AppConfig>);

  // Step 2) Validate important fields so we fail fast with clear errors.
  if (typeof merged.schemaVersion !== "number") {
    throw new Error("Invalid config: schemaVersion must be a number.");
  }

  // Require at least one enabled/available provider entry to run the agent.
  if (!Array.isArray(merged.agent.llmProviders) || merged.agent.llmProviders.length === 0) {
    throw new Error("Invalid config: agent.llmProviders must contain at least one provider.");
  }

  // Normalize llmProviders: migrate legacy "model" (string) to "models" (string[]).
  merged.agent.llmProviders = merged.agent.llmProviders.map((entry) => {
    const e = entry as LlmProviderConfig & { model?: string };
    if (Array.isArray(e.models)) {
      return entry;
    }
    if (typeof e.model === "string") {
      const { model, ...rest } = e;
      return { ...rest, models: [model] } as LlmProviderConfig;
    }
    throw new Error(
      "Invalid config: each agent.llmProviders entry must have 'models' (string[]) or legacy 'model' (string)."
    );
  });

  // Keep runtime behavior safe/predictable with sane numeric constraints.
  if (typeof merged.agent.memoryWindow !== "number" || merged.agent.memoryWindow < 1) {
    throw new Error("Invalid config: agent.memoryWindow must be >= 1.");
  }

  if (typeof merged.agent.maxTokens !== "number" || merged.agent.maxTokens < 1) {
    throw new Error("Invalid config: agent.maxTokens must be >= 1.");
  }

  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // In JS, arrays/functions are also "object"-ish in some checks;
  // this helper intentionally allows any non-null object-like value.
  return typeof value === "object" && value !== null;
}

function deepMerge<T>(base: T, patch: DeepPartial<T>): T {
  // Base case: if either side is not object-like, patch wins directly.
  if (!isRecord(base) || !isRecord(patch)) {
    return patch as T;
  }

  // Start from base, then overlay keys from patch.
  const merged: Record<string, unknown> = { ...base };

  for (const [key, patchValue] of Object.entries(patch)) {
    // `undefined` means "no update for this key" in partial patches.
    if (patchValue === undefined) {
      continue;
    }

    const baseValue = (base as Record<string, unknown>)[key];

    if (Array.isArray(patchValue)) {
      // Arrays are replaced (not merged item-by-item) to avoid ambiguity.
      merged[key] = patchValue;
      continue;
    }

    if (isRecord(baseValue) && isRecord(patchValue)) {
      // For nested objects, recurse so only changed nested keys are overwritten.
      merged[key] = deepMerge(baseValue, patchValue);
      continue;
    }

    // Primitive values (string/number/boolean/etc.) overwrite base values.
    merged[key] = patchValue;
  }

  return merged as T;
}

function clone<T>(value: T): T {
  // Simple deep clone for plain JSON-safe data structures.
  // Good fit here because config values are expected to be JSON data.
  return JSON.parse(JSON.stringify(value));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    // `access` throws if file is missing or not accessible.
    await access(path);
    return true;
  } catch {
    // Any failure is treated as "not available" for load bootstrap logic.
    return false;
  }
}
