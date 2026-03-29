import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AppConfig,
  EventInspectionIncludeConfig,
  LlmModelConfig,
  LlmProviderConfig,
  ModelFactoryModelOverridesConfig,
} from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ROOT_ENV_VAR = "MAHABOT_TEMPLATE_ROOT";


export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export interface WorkspaceBootstrapResult {
  workspaceSessionId: string;
  sessionRoot: string;
  workspaceRoot: string;
  persistenceRoot: string;
  configPath: string;
  isFirstConfigCreated: boolean;
}

export type PromptScaffoldFileName = "SOUL.md" | "USER.md";

export interface PromptScaffoldResult {
  created: boolean;
  filePath: string;
}

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

  async initializeSessionWorkspace(workspaceSessionId: string): Promise<WorkspaceBootstrapResult> {
    const sanitizedSessionId = sanitizeWorkspaceSessionId(workspaceSessionId);
    const sessionRoot = resolve(homedir(), ".mahabot", sanitizedSessionId);
    const workspaceRoot = resolve(sessionRoot, "workspace");
    const persistenceRoot = resolve(workspaceRoot, "persistence");
    const skillsRoot = resolve(workspaceRoot, "skills");
    const configPath = resolve(sessionRoot, "config.json");

    await ensureDir(sessionRoot);
    await ensureDir(workspaceRoot);
    await ensureDir(persistenceRoot);
    await ensureDir(skillsRoot);

    const configTemplatePath = await this.getTemplatePath("config.json");
    const agentsTemplatePath = await this.getTemplatePath("AGENTS.md");
    const soulTemplatePath = await this.getTemplatePath("SOUL.md");
    const userTemplatePath = await this.getTemplatePath("USER.md");

    const isFirstConfigCreated = await copyFileIfMissing(configTemplatePath, configPath);
    await copyFileIfMissing(agentsTemplatePath, resolve(sessionRoot, "AGENTS.md"));
    await copyFileIfMissing(soulTemplatePath, resolve(workspaceRoot, "SOUL.md"));
    await copyFileIfMissing(userTemplatePath, resolve(workspaceRoot, "USER.md"));

    await writeFileIfMissing(resolve(persistenceRoot, "history.md"), "");
    await writeFileIfMissing(resolve(persistenceRoot, "session.jsonl"), "");

    this.setPath(configPath);

    return {
      workspaceSessionId: sanitizedSessionId,
      sessionRoot,
      workspaceRoot,
      persistenceRoot,
      configPath: this.path,
      isFirstConfigCreated,
    };
  }

  async ensurePromptScaffoldIfMissing(
    sessionRoot: string,
    fileName: PromptScaffoldFileName
  ): Promise<PromptScaffoldResult> {
    const destinationPath = resolve(sessionRoot, "workspace", fileName);
    const templatePath = await this.getTemplatePath(fileName);
    const created = await copyFileIfMissing(templatePath, destinationPath);

    return {
      created,
      filePath: destinationPath,
    };
  }

  private async getTemplatePath(fileName: string): Promise<string> {
    const attemptedPaths = this.getTemplateCandidateRoots().map((root) => resolve(root, fileName));

    for (const filePath of attemptedPaths) {
      if (await fileExists(filePath)) {
        return filePath;
      }
    }

    throw new Error(
      [
        `Template file not found: '${fileName}'.`,
        `Checked ${attemptedPaths.length} location(s):`,
        ...attemptedPaths.map((path) => `- ${path}`),
        `You can override template root via ${TEMPLATE_ROOT_ENV_VAR}.`,
      ].join("\n")
    );
  }

  private getTemplateCandidateRoots(): string[] {
    const configuredRoot = process.env[TEMPLATE_ROOT_ENV_VAR]?.trim();
    const roots = [
      configuredRoot,
      resolve(MODULE_DIR, "config_template"),
      resolve(MODULE_DIR, "..", "..", "src", "config", "config_template"),
      resolve(process.cwd(), "src", "config", "config_template"),
    ];

    return roots.filter((entry): entry is string => !!entry);
  }

  get(): AppConfig {
    // Defensive copy: callers get data, but cannot mutate internal state directly.
    return clone(this.config);
  }

  async load(): Promise<AppConfig> {
    // Check whether the config file already exists on disk.
    const exists = await fileExists(this.configPath);

    if (!exists) {
      throw new Error(
        `Config file not found at '${this.configPath}'. Run workspace initialization before loading config.`
      );
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
    await ensureDir(dirname(this.configPath));
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

  getApiKeyForProviderName(provider: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    const providerConfig = this.getTargetProviderConfig(provider);
    if (!providerConfig) {
      return undefined;
    }
    return this.getApiKeyForProvider(providerConfig, env);
  }

  getBaseUrlForProvider(provider: string): string | undefined {
    const providerConfig = this.getTargetProviderConfig(provider);
    return providerConfig?.baseUrl;
  }

  getThinkingLevel(): ThinkingLevel {
    return this.config.agent?.thinkingLevel ?? "off";
  }

  getActiveProviderModel(): { provider: string; model: string } {
    return {
      provider: this.config.agent.activeProvider,
      model: this.config.agent.activeModel,
    };
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

  // Normalize llmProviders with strict schema (no legacy compatibility):
  // - each provider must use models: LlmModelConfig[]
  // - reject legacy provider.model and provider.modelFactoryDefaults
  merged.agent.llmProviders = merged.agent.llmProviders.map((entry) => {
    const e = entry as LlmProviderConfig & {
      model?: unknown;
      models?: unknown;
      modelFactoryDefaults?: unknown;
    };

    if (e.model !== undefined) {
      throw new Error(
        "Invalid config: provider-level 'model' is no longer supported. Use agent.llmProviders[].models[].name."
      );
    }

    if (e.modelFactoryDefaults !== undefined) {
      throw new Error(
        "Invalid config: provider-level 'modelFactoryDefaults' is no longer supported. Use agent.llmProviders[].models[].params."
      );
    }

    if (!Array.isArray(e.models)) {
      throw new Error(
        "Invalid config: each agent.llmProviders entry must provide 'models' as an array of model objects."
      );
    }

    const normalizedModels = e.models.map((value, index) => normalizeProviderModelConfig(value, index));

    if (normalizedModels.length === 0) {
      throw new Error("Invalid config: each agent.llmProviders entry must define at least one model.");
    }

    const { models, ...rest } = e;
    return {
      ...rest,
      models: normalizedModels,
    } as LlmProviderConfig;
  });

  if (typeof merged.agent.activeProvider !== "string" || merged.agent.activeProvider.trim().length === 0) {
    throw new Error("Invalid config: agent.activeProvider must be a non-empty string.");
  }
  if (typeof merged.agent.activeModel !== "string" || merged.agent.activeModel.trim().length === 0) {
    throw new Error("Invalid config: agent.activeModel must be a non-empty string.");
  }
  if (typeof merged.agent.defaultProvider !== "string" || merged.agent.defaultProvider.trim().length === 0) {
    throw new Error("Invalid config: agent.defaultProvider must be a non-empty string.");
  }
  if (typeof merged.agent.defaultModel !== "string" || merged.agent.defaultModel.trim().length === 0) {
    throw new Error("Invalid config: agent.defaultModel must be a non-empty string.");
  }

  validateProviderModelPairExists(
    merged.agent.llmProviders,
    merged.agent.activeProvider,
    merged.agent.activeModel,
    "active"
  );
  validateProviderModelPairExists(
    merged.agent.llmProviders,
    merged.agent.defaultProvider,
    merged.agent.defaultModel,
    "default"
  );

  // Keep runtime behavior safe/predictable with sane numeric constraints.
  if (typeof merged.agent.memoryWindow !== "number" || merged.agent.memoryWindow < 1) {
    throw new Error("Invalid config: agent.memoryWindow must be >= 1.");
  }

  if (
    typeof merged.agent.startupRestoreMessageCount !== "number" ||
    merged.agent.startupRestoreMessageCount < 1
  ) {
    throw new Error("Invalid config: agent.startupRestoreMessageCount must be >= 1.");
  }

  if (
    typeof merged.agent.compactHighWatermarkTokens !== "number" ||
    merged.agent.compactHighWatermarkTokens < 1
  ) {
    throw new Error("Invalid config: agent.compactHighWatermarkTokens must be >= 1.");
  }

  if (
    typeof merged.agent.compactLowWatermarkTokens !== "number" ||
    merged.agent.compactLowWatermarkTokens < 1
  ) {
    throw new Error("Invalid config: agent.compactLowWatermarkTokens must be >= 1.");
  }

  if (merged.agent.compactLowWatermarkTokens >= merged.agent.compactHighWatermarkTokens) {
    throw new Error(
      "Invalid config: agent.compactLowWatermarkTokens must be < agent.compactHighWatermarkTokens."
    );
  }

  if (typeof merged.agent.maxTokens !== "number" || merged.agent.maxTokens < 1) {
    throw new Error("Invalid config: agent.maxTokens must be >= 1.");
  }

  if (typeof merged.agent.workspaceRoot !== "string" || merged.agent.workspaceRoot.trim().length === 0) {
    throw new Error("Invalid config: agent.workspaceRoot must be a non-empty string.");
  }

  if ("workspaceRoot" in (merged.tools as unknown as Record<string, unknown>)) {
    throw new Error("Invalid config: tools.workspaceRoot is no longer supported. Use agent.workspaceRoot.");
  }

  if (!isRecord(merged.tools.webSearch)) {
    throw new Error("Invalid config: tools.webSearch must be an object.");
  }

  if (
    typeof merged.tools.webSearch.tavilyApiKeyEnvVar !== "string" ||
    merged.tools.webSearch.tavilyApiKeyEnvVar.trim().length === 0
  ) {
    throw new Error("Invalid config: tools.webSearch.tavilyApiKeyEnvVar must be a non-empty string.");
  }

  if (
    typeof merged.tools.webSearch.linkupApiKeyEnvVar !== "string" ||
    merged.tools.webSearch.linkupApiKeyEnvVar.trim().length === 0
  ) {
    throw new Error("Invalid config: tools.webSearch.linkupApiKeyEnvVar must be a non-empty string.");
  }

  validateEventInspectionConfig(merged.eventInspection);

  return merged;
}

function normalizeProviderModelConfig(
  value: unknown,
  index: number
): LlmModelConfig {
  if (typeof value === "string") {
    throw new Error(
      `Invalid config: agent.llmProviders[].models[${index}] must be an object like { name, params? }, not a string.`
    );
  }

  if (!isRecord(value)) {
    throw new Error(
      `Invalid config: agent.llmProviders[].models[${index}] must be an object with at least { name }.`
    );
  }

  if (value.model !== undefined) {
    throw new Error(
      `Invalid config: agent.llmProviders[].models[${index}].model is no longer supported. Use 'name'.`
    );
  }

  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) {
    throw new Error(`Invalid config: agent.llmProviders[].models[${index}].name must be a non-empty string.`);
  }

  if (value.params !== undefined && !isRecord(value.params)) {
    throw new Error(
      `Invalid config: agent.llmProviders[].models[${index}].params must be an object when provided.`
    );
  }

  const rawParams = value.params as Record<string, unknown> | undefined;
  if (!rawParams) {
    return { name };
  }

  validateAllowedModelParams(rawParams, `agent.llmProviders[].models[${index}].params`);

  const rawModel = rawParams.model;
  if (rawModel === undefined) {
    return { name };
  }

  if (!isRecord(rawModel)) {
    throw new Error(
      `Invalid config: agent.llmProviders[].models[${index}].params.model must be an object when provided.`
    );
  }

  const overrides = normalizeModelOverrides(
    rawModel,
    `agent.llmProviders[].models[${index}].params.model`
  );

  return {
    name,
    params: {
      model: overrides,
    },
  };
}

function validateAllowedModelParams(
  params: Record<string, unknown>,
  path: string
): void {
  if (params.agent !== undefined) {
    throw new Error(
      `Invalid config: ${path}.agent is removed. Use top-level agent.thinkingLevel instead.`
    );
  }
  if (params.stream !== undefined) {
    throw new Error(
      `Invalid config: ${path}.stream is removed. Stream-level per-model config is no longer supported.`
    );
  }

  for (const key of Object.keys(params)) {
    if (key !== "model") {
      throw new Error(
        `Invalid config: ${path}.${key} is not supported. Allowed keys: model.`
      );
    }
  }
}

function normalizeModelOverrides(
  value: Record<string, unknown>,
  path: string
): ModelFactoryModelOverridesConfig {
  const removedModelKeys = new Set([
    "api",
    "name",
    "cost",
    "contextWindow",
    "maxTokens",
    "baseUrl",
  ]);
  const allowedModelKeys = new Set(["reasoning", "input", "headers", "compat"]);

  for (const key of Object.keys(value)) {
    if (removedModelKeys.has(key)) {
      throw new Error(
        `Invalid config: ${path}.${key} is removed and now uses runtime defaults.`
      );
    }
    if (!allowedModelKeys.has(key)) {
      throw new Error(
        `Invalid config: ${path}.${key} is not supported. Allowed keys: reasoning, input, headers, compat.`
      );
    }
  }

  const overrides: ModelFactoryModelOverridesConfig = {};

  if (value.reasoning !== undefined) {
    if (typeof value.reasoning !== "boolean") {
      throw new Error(`Invalid config: ${path}.reasoning must be a boolean.`);
    }
    overrides.reasoning = value.reasoning;
  }

  if (value.input !== undefined) {
    if (!Array.isArray(value.input)) {
      throw new Error(`Invalid config: ${path}.input must be an array.`);
    }
    const normalizedInput = value.input.map((entry) => {
      if (entry !== "text" && entry !== "image") {
        throw new Error(`Invalid config: ${path}.input only supports "text" or "image".`);
      }
      return entry;
    });
    overrides.input = normalizedInput;
  }

  if (value.headers !== undefined) {
    overrides.headers = normalizeStringRecord(value.headers, `${path}.headers`);
  }

  if (value.compat !== undefined) {
    if (!isRecord(value.compat)) {
      throw new Error(`Invalid config: ${path}.compat must be an object when provided.`);
    }
    overrides.compat = value.compat;
  }

  return overrides;
}

function normalizeStringRecord(value: unknown, path: string): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error(`Invalid config: ${path} must be an object.`);
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") {
      throw new Error(`Invalid config: ${path}.${key} must be a string.`);
    }
    result[key] = entry;
  }

  return result;
}

function validateProviderModelPairExists(
  llmProviders: LlmProviderConfig[],
  provider: string,
  model: string,
  label: "active" | "default"
): void {
  const providerConfig = llmProviders.find((entry) => entry.provider === provider && entry.enabled);
  if (!providerConfig) {
    throw new Error(
      `Invalid config: agent.${label}Provider '${provider}' is not found in enabled agent.llmProviders.`
    );
  }

  if (!providerConfig.models.some((entry) => entry.name === model)) {
    throw new Error(
      `Invalid config: agent.${label}Model '${model}' is not found in provider '${provider}' models.`
    );
  }
}

function validateEventInspectionConfig(
  value: AppConfig["eventInspection"]
): asserts value is AppConfig["eventInspection"] {
  if (!isRecord(value)) {
    throw new Error("Invalid config: eventInspection must be an object.");
  }

  if (typeof value.useEventInspection !== "boolean") {
    throw new Error("Invalid config: eventInspection.useEventInspection must be a boolean.");
  }

  if (typeof value.showTokenUsage !== "boolean") {
    throw new Error("Invalid config: eventInspection.showTokenUsage must be a boolean.");
  }

  if (!isRecord(value.include)) {
    throw new Error("Invalid config: eventInspection.include must be an object.");
  }

  const includeKeys: Array<keyof EventInspectionIncludeConfig> = [
    "agent_start",
    "agent_end",
    "turn_start",
    "turn_end",
    "message_start",
    "message_update",
    "message_end",
    "tool_execution_start",
    "tool_execution_update",
    "tool_execution_end",
  ];

  for (const key of includeKeys) {
    if (typeof value.include[key] !== "boolean") {
      throw new Error(`Invalid config: eventInspection.include.${key} must be a boolean.`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // Only treat plain object-like values as records; arrays are intentionally excluded.
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function sanitizeWorkspaceSessionId(input: string): string {
  const sanitized = input.trim().replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_");
  return sanitized || "session";
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

async function copyFileIfMissing(sourcePath: string, destinationPath: string): Promise<boolean> {
  if (await fileExists(destinationPath)) {
    return false;
  }

  if (!(await fileExists(sourcePath))) {
    throw new Error(`Template file not found: '${sourcePath}'.`);
  }

  await ensureDir(dirname(destinationPath));
  await copyFile(sourcePath, destinationPath);
  return true;
}

async function writeFileIfMissing(path: string, content: string): Promise<boolean> {
  if (await fileExists(path)) {
    return false;
  }

  await ensureDir(dirname(path));
  await writeFile(path, content, "utf-8");
  return true;
}
