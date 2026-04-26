import type { AppConfig } from "../../config/index.js";

export interface TelegramRuntimeConfig {
  botToken: string;
  allowedUserIds: ReadonlySet<string>;
}

export function resolveTelegramRuntimeConfig(
  appConfig: AppConfig,
  env: NodeJS.ProcessEnv = process.env
): TelegramRuntimeConfig {
  const telegram = appConfig.ingress?.telegram;
  if (!telegram?.enabled) {
    throw new Error(
      "Telegram mode is disabled in config. Set ingress.telegram.enabled=true in config.json."
    );
  }

  if (!Array.isArray(telegram.allowedChatIds)) {
    throw new Error("Invalid config: ingress.telegram.allowedChatIds must be an array.");
  }

  const allowedUserIds = new Set(
    telegram.allowedChatIds
      .map((value) => String(value).trim())
      .filter((value) => value.length > 0)
  );

  if (allowedUserIds.size === 0) {
    throw new Error(
      "Telegram mode requires at least one allowed user id in ingress.telegram.allowedChatIds."
    );
  }

  const tokenEnvVar = telegram.botTokenEnvVar?.trim();
  if (!tokenEnvVar) {
    throw new Error("Invalid config: ingress.telegram.botTokenEnvVar must be a non-empty string.");
  }

  const botToken = env[tokenEnvVar]?.trim();
  if (!botToken) {
    throw new Error(
      `Missing Telegram bot token. Set environment variable '${tokenEnvVar}' before starting telegram mode.`
    );
  }

  return {
    botToken,
    allowedUserIds,
  };
}
