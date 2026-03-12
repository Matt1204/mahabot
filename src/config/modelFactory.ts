import type { Model } from "@mariozechner/pi-ai";
import { getModel } from "@mariozechner/pi-ai";

import type { AppConfig, LlmProviderConfig } from "./types.js";

/**
 * Resolves the LLM model from config.
 *
 * Priority:
 * 1. If llmProvider and model are provided, try to find matching config
 * 2. Fallback to defaultProvider and defaultModel from config
 *
 * For built-in providers (openai, anthropic, etc.), uses pi-ai's getModel().
 * For custom-openai-compatible (e.g. Microsoft Foundry, Azure OpenAI), creates
 * a custom Model with baseUrl and deployment name.
 */
export function createModelFromConfig(
  config: AppConfig,
  llmProvider?: string,
  model?: string
): Model<any> {
  const { defaultProvider, defaultModel, llmProviders } = config.agent;

  // Determine target provider and model (use params if provided, fallback to defaults)
  const targetProvider = llmProvider || defaultProvider;
  const targetModel = model || defaultModel;

  // Try to find provider config for the target
  let providerConfig = llmProviders.find(
    (p) => p.provider === targetProvider && p.models.includes(targetModel) && p.enabled
  );

  // If not found with provided params, fallback to defaults
  if (!providerConfig && (llmProvider || model)) {
    providerConfig = llmProviders.find(
      (p) => p.provider === defaultProvider && p.models.includes(defaultModel) && p.enabled
    );
  }

  if (!providerConfig) {
    // Determine which provider/model was actually attempted in the final fallback
    const isFallbackAttempt = llmProvider || model;
    const attemptedProvider = isFallbackAttempt ? defaultProvider : targetProvider;
    const attemptedModel = isFallbackAttempt ? defaultModel : targetModel;
    throw new Error(
      `No enabled provider config for '${attemptedProvider}' + model '${attemptedModel}'. Check config.json agent.llmProviders.`
    );
  }
  const modelId = providerConfig.provider === targetProvider ? targetModel : defaultModel;
  
  // For OpenAI-compatible custom providers (Microsoft Foundry, Azure OpenAI, etc.)，These require baseUrl for custom endpoints
  if (providerConfig.category === "openai" && providerConfig.baseUrl) {
    const baseUrl = providerConfig.baseUrl;
    return createCustomOpenAIModel({
      id: modelId,
      name: `${modelId} (Custom)`,
      baseUrl: baseUrl.replace(/\/$/, ""), // normalize: remove trailing slash
      provider: providerConfig.provider,
    });
  }

  // Built-in providers: openai, anthropic, google, openrouter, etc.
  return getModel(providerConfig.provider as any, modelId as any);
}

/**
 * Creates a custom Model for OpenAI-compatible endpoints (Azure OpenAI,
 * Microsoft Foundry, LiteLLM, Ollama, etc.).
 *
 * The `id` is the deployment/model name sent to the API (e.g. "Kimi-K2.5").
 */
export function createCustomOpenAIModel(options: {
  id: string;
  name: string;
  baseUrl: string;
  provider: string;
  contextWindow?: number;
  maxTokens?: number;
}): Model<"openai-completions"> {
  const {
    id,
    name,
    baseUrl,
    provider,
    contextWindow = 128000,
    maxTokens = 32000,
  } = options;

  return {
    id,
    name,
    api: "openai-completions",
    provider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
  };
}
