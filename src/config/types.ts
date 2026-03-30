import type { OpenAICompletionsCompat, OpenAIResponsesCompat } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

export type IngressProvider = "telegram";

export interface TelegramIngressConfig {
  enabled: boolean;
  botTokenEnvVar: string;
  allowedChatIds: string[];
}

export interface IngressConfig {
  telegram: TelegramIngressConfig;
}

export interface LlmProviderConfig {
  provider: string;
  models: LlmModelConfig[];
  enabled: boolean;
  apiKeyEnvVar?: string;
  baseUrl?: string;
  organization?: string;
  category?: "openai" | "anthropic" | "google" | "openrouter";
}

export interface LlmModelConfig {
  name: string;
  params?: ModelFactoryDefaultsConfig;
}

export interface ModelFactoryModelOverridesConfig {
  reasoning?: boolean;
  input?: Array<"text" | "image">;
  headers?: Record<string, string>;
  compat?: OpenAICompletionsCompat | OpenAIResponsesCompat | Record<string, unknown>;
}

export interface ModelFactoryDefaultsConfig {
  model?: ModelFactoryModelOverridesConfig;
}

export interface AgentConfig {
  activeProvider: string;
  activeModel: string;
  defaultProvider: string;
  defaultModel: string;
  systemPromptFile: string;
  workspaceRoot: string;
  memoryWindow: number;
  startupRestoreMessageCount: number;
  compactHighWatermarkTokens: number;
  compactLowWatermarkTokens: number;
  maxTokens: number;
  thinkingLevel: ThinkingLevel;
  llmProviders: LlmProviderConfig[];
}

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

export interface WebSearchConfig {
  tavilyApiKeyEnvVar: string;
  linkupApiKeyEnvVar: string;
}

export interface ToolsConfig {
  restrictToWorkspace: boolean;
  mcpServers: McpServerConfig[];
  webSearch: WebSearchConfig;
}

export interface EventInspectionIncludeConfig {
  agent_start: boolean;
  agent_end: boolean;
  turn_start: boolean;
  turn_end: boolean;
  message_start: boolean;
  message_update: boolean;
  message_end: boolean;
  tool_execution_start: boolean;
  tool_execution_update: boolean;
  tool_execution_end: boolean;
}

export interface EventInspectionThinkingConfig {
  enabled: boolean;
  emitMode: "on_end";
  maxChars?: number;
}

export interface EventInspectionConfig {
  useEventInspection: boolean;
  showTokenUsage: boolean;
  include: EventInspectionIncludeConfig;
  thinking: EventInspectionThinkingConfig;
}

export interface AppConfig {
  schemaVersion: number;
  ingress: IngressConfig;
  agent: AgentConfig;
  tools: ToolsConfig;
  eventInspection: EventInspectionConfig;
}

export const DEFAULT_CONFIG: AppConfig = {
  schemaVersion: 1,
  ingress: {
    telegram: {
      enabled: false,
      botTokenEnvVar: "TELEGRAM_BOT_TOKEN",
      allowedChatIds: [],
    },
  },
  agent: {
    activeProvider: "openai",
    activeModel: "gpt-4o-mini",
    defaultProvider: "openai",
    defaultModel: "gpt-4o-mini",
    systemPromptFile: "AGENTS.md",
    workspaceRoot: ".",
    memoryWindow: 50,
    startupRestoreMessageCount: 50,
    compactHighWatermarkTokens: 100000,
    compactLowWatermarkTokens: 40000,
    maxTokens: 4096,
    thinkingLevel: "off",
    llmProviders: [
      {
        provider: "openai",
        models: [{ name: "gpt-4o-mini" }],
        enabled: true,
        apiKeyEnvVar: "OPENAI_API_KEY",
      },
    ],
  },
  tools: {
    restrictToWorkspace: true,
    mcpServers: [],
    webSearch: {
      tavilyApiKeyEnvVar: "TAVILY_API_KEY",
      linkupApiKeyEnvVar: "LINKUP_API_KEY",
    },
  },
  eventInspection: {
    useEventInspection: false,
    showTokenUsage: false,
    include: {
      agent_start: false,
      agent_end: false,
      turn_start: false,
      turn_end: false,
      message_start: false,
      message_update: false,
      message_end: false,
      tool_execution_start: false,
      tool_execution_update: false,
      tool_execution_end: false,
    },
    thinking: {
      enabled: false,
      emitMode: "on_end",
    },
  },
};
