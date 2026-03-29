import type { Model, OpenAICompletionsCompat, OpenAIResponsesCompat } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";

import type {
  AppConfig,
  LlmModelConfig,
  LlmProviderConfig,
  ModelFactoryModelOverridesConfig,
} from "./types.js";

interface ProviderModelMatch {
  providerConfig: LlmProviderConfig;
  modelConfig: LlmModelConfig;
}

const DEFAULT_CUSTOM_OPENAI_MODEL_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
} as const;

const DEFAULT_CUSTOM_OPENAI_INPUT: Array<"text" | "image"> = ["text"];
const DEFAULT_CUSTOM_OPENAI_CONTEXT_WINDOW = 8192;
const DEFAULT_CUSTOM_OPENAI_MAX_TOKENS = 2048;

/**
 * Resolves the LLM model from config.
 *
 * Fallback order:
 * 1) requested provider/model (or requested partial + active fallback for missing side)
 * 2) activeProvider/activeModel
 * 3) defaultProvider/defaultModel
 */
export function createModelFromConfig(
  config: AppConfig,
  llmProvider?: string,
  model?: string
): Model<any> {
  const { providerConfig, modelConfig } = resolveTargetProviderModel(config, llmProvider, model);
  const modelId = modelConfig.name;
  const overrides = modelConfig.params?.model;

  // OpenAI-compatible custom providers (Foundry/Azure/LiteLLM/etc.) use provider-level baseUrl.
  if (providerConfig.category === "openai" && providerConfig.baseUrl) {
    return createCustomOpenAIModel({
      id: modelId,
      name: `${modelId} (Custom)`,
      baseUrl: providerConfig.baseUrl,
      provider: providerConfig.provider,
      overrides,
    });
  }

  const baseModel = getModel(providerConfig.provider as any, modelId as any);
  return applySlimModelOverrides(baseModel, overrides);
}

/**
 * Creates a custom model for OpenAI-compatible endpoints.
 *
 * Metadata fields (cost/contextWindow/maxTokens) are intentionally internal defaults,
 * not config-exposed.
 */
export function createCustomOpenAIModel(options: {
  id: string;
  name: string;
  baseUrl: string;
  provider: string;
  overrides?: ModelFactoryModelOverridesConfig;
}): Model<"openai-completions"> {
  const { id, name, baseUrl, provider, overrides } = options;

  return {
    id,
    name,
    api: "openai-completions",
    provider,
    baseUrl: normalizeBaseUrl(baseUrl),
    reasoning: overrides?.reasoning ?? false,
    input: overrides?.input ?? DEFAULT_CUSTOM_OPENAI_INPUT,
    cost: {
      ...DEFAULT_CUSTOM_OPENAI_MODEL_COST,
    },
    contextWindow: DEFAULT_CUSTOM_OPENAI_CONTEXT_WINDOW,
    maxTokens: DEFAULT_CUSTOM_OPENAI_MAX_TOKENS,
    headers: overrides?.headers,
    compat: overrides?.compat as any,
  };
}

function resolveTargetProviderModel(
  config: AppConfig,
  requestedProvider?: string,
  requestedModel?: string
): ProviderModelMatch {
  const { llmProviders, activeProvider, activeModel, defaultProvider, defaultModel } = config.agent;

  const requestedPair = {
    provider: requestedProvider ?? activeProvider,
    model: requestedModel ?? activeModel,
  };
  const activePair = { provider: activeProvider, model: activeModel };
  const defaultPair = { provider: defaultProvider, model: defaultModel };

  const orderedCandidates = dedupeProviderModelPairs([requestedPair, activePair, defaultPair]);
  for (const candidate of orderedCandidates) {
    const match = findProviderModelMatch(llmProviders, candidate.provider, candidate.model);
    if (match) {
      return match;
    }
  }

  const attempted = orderedCandidates
    .map((candidate) => `'${candidate.provider}' + model '${candidate.model}'`)
    .join(" -> ");
  throw new Error(
    `No enabled provider config for ${attempted}. Check config.json agent.llmProviders.`
  );
}

function dedupeProviderModelPairs(
  pairs: Array<{ provider: string; model: string }>
): Array<{ provider: string; model: string }> {
  const seen = new Set<string>();
  const unique: Array<{ provider: string; model: string }> = [];

  for (const pair of pairs) {
    const key = `${pair.provider}\u0000${pair.model}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(pair);
  }

  return unique;
}

function applySlimModelOverrides<TApi extends string>(
  model: Model<TApi>,
  overrides?: ModelFactoryModelOverridesConfig
): Model<TApi> {
  if (!overrides) {
    return model;
  }

  const next: Model<TApi> = {
    ...model,
    reasoning: overrides.reasoning ?? model.reasoning,
    input: overrides.input ?? model.input,
    headers:
      overrides.headers !== undefined
        ? mergeStringRecord(model.headers, overrides.headers)
        : model.headers,
  };

  if (overrides.compat !== undefined) {
    (next as any).compat = mergeCompat((model as any).compat, overrides.compat);
  }

  return next;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

function mergeStringRecord(
  base?: Record<string, string>,
  override?: Record<string, string>
): Record<string, string> | undefined {
  if (!base && !override) {
    return undefined;
  }
  return { ...(base ?? {}), ...(override ?? {}) };
}

function mergeCompat(
  base?: OpenAICompletionsCompat | OpenAIResponsesCompat | Record<string, unknown>,
  override?: OpenAICompletionsCompat | OpenAIResponsesCompat | Record<string, unknown>
): OpenAICompletionsCompat | OpenAIResponsesCompat | Record<string, unknown> | undefined {
  if (!base && !override) {
    return undefined;
  }
  return { ...(base ?? {}), ...(override ?? {}) };
}

function findProviderModelMatch(
  llmProviders: LlmProviderConfig[],
  providerName: string,
  modelName: string
): ProviderModelMatch | undefined {
  for (const providerConfig of llmProviders) {
    if (!providerConfig.enabled || providerConfig.provider !== providerName) {
      continue;
    }

    const modelConfig = providerConfig.models.find((candidate) => candidate.name === modelName);
    if (modelConfig) {
      return { providerConfig, modelConfig };
    }
  }

  return undefined;
}

