import type { OpenAICompletionsCompat, OpenAIResponsesCompat } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { LoggingConfig } from "../logging/types.js";

export type IngressProvider = "telegram";

export interface TelegramIngressConfig {
  enabled: boolean;
  botTokenEnvVar: string;
  allowedChatIds: string[];
  media: TelegramMediaIngressConfig;
}

export interface TelegramMediaIngressConfig {
  pendingImageTimeoutMs: number;
  ffmpegCommand: string;
  transcription: TelegramTranscriptionConfig;
}

export interface TelegramTranscriptionConfig {
  model: string;
  apiKeyEnvVar: string;
  prompt: string;
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
  logging: LoggingConfig;
}

export const DEFAULT_CONFIG: AppConfig = {
  schemaVersion: 1,
  ingress: {
    telegram: {
      enabled: false,
      botTokenEnvVar: "TELEGRAM_BOT_TOKEN",
      allowedChatIds: [],
      media: {
        pendingImageTimeoutMs: 10 * 60 * 1000,
        ffmpegCommand: "ffmpeg",
        transcription: {
          model: "gpt-4o-mini-transcribe",
          apiKeyEnvVar: "OPENAI_API_KEY",
          prompt:
            "The speaker is chatting with mahabot. The conversation is usually in Chinese. Transcribe the user's words accurately and keep the original language.",
        },
      },
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
  logging: {
    level: "info",
    persist: true,
    path: "logs/latest.ndjson",
    maxEntries: 1000,
    maxAgeMs: 7 * 24 * 60 * 60 * 1000,
    compactEveryWrites: 100,
    compactIntervalMs: 60_000,
    debugEvents: false,
    redactMessageText: true,
    messagePreviewChars: 120,
    includeStack: true,
  },
};
