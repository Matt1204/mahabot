import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { ConfigManager, DEFAULT_CONFIG } from "../config/index.js";
import type { AppConfig } from "../config/types.js";

export const TELEGRAM_ONBOARDING_SESSION_ID = "telegram-stable-session";

export type OnboardingSeverity = "blocking" | "ok";

export type OnboardingCheckId =
  | "config_created"
  | "config_valid"
  | "telegram_enabled"
  | "telegram_bot_token_env_var_configured"
  | "telegram_bot_token_present"
  | "telegram_allowed_user_ids"
  | "env_example_written";

export interface OnboardingCheck {
  id: OnboardingCheckId;
  severity: OnboardingSeverity;
  title: string;
  detail: string;
  action?: string;
}

export interface TelegramOnboardingReport {
  target: "telegram";
  ready: boolean;
  workspaceSessionId: string;
  sessionRoot: string;
  workspaceRoot: string;
  persistenceRoot: string;
  configPath: string;
  envExamplePath: string;
  nextCommand: "mahabot telegram";
  checks: OnboardingCheck[];
}

export interface TelegramOnboardingResult {
  report: TelegramOnboardingReport;
  appConfig?: AppConfig;
}

export interface TelegramOnboardingPaths {
  workspaceSessionId: string;
  sessionRoot: string;
  workspaceRoot: string;
  persistenceRoot: string;
  configPath: string;
  envExamplePath: string;
  isFirstConfigCreated: boolean;
}

export interface BuildTelegramOnboardingReportInput {
  paths: TelegramOnboardingPaths;
  appConfig?: AppConfig;
  configError?: unknown;
  env?: NodeJS.ProcessEnv;
  envExampleWritten?: boolean;
}

export interface EvaluateTelegramOnboardingInput {
  configManager: ConfigManager;
  env?: NodeJS.ProcessEnv;
  writeEnvExample?: boolean;
}

export async function evaluateTelegramOnboarding(
  input: EvaluateTelegramOnboardingInput
): Promise<TelegramOnboardingResult> {
  const env = input.env ?? process.env;
  const bootstrap = await input.configManager.initializeSessionWorkspace(
    TELEGRAM_ONBOARDING_SESSION_ID
  );

  let appConfig: AppConfig | undefined;
  let configError: unknown;

  try {
    appConfig = await input.configManager.load();
  } catch (error) {
    configError = error;
  }

  const envExamplePath = resolve(bootstrap.sessionRoot, ".env.example");
  let envExampleWritten = false;
  if (input.writeEnvExample !== false) {
    await writeTelegramEnvExample(envExamplePath, appConfig);
    envExampleWritten = true;
  }

  const report = buildTelegramOnboardingReport({
    paths: {
      workspaceSessionId: bootstrap.workspaceSessionId,
      sessionRoot: bootstrap.sessionRoot,
      workspaceRoot: bootstrap.workspaceRoot,
      persistenceRoot: bootstrap.persistenceRoot,
      configPath: bootstrap.configPath,
      envExamplePath,
      isFirstConfigCreated: bootstrap.isFirstConfigCreated,
    },
    appConfig,
    configError,
    env,
    envExampleWritten,
  });

  return { report, appConfig };
}

export function buildTelegramOnboardingReport(
  input: BuildTelegramOnboardingReportInput
): TelegramOnboardingReport {
  const env = input.env ?? process.env;
  const checks: OnboardingCheck[] = [];

  checks.push(
    ok(
      "config_created",
      input.paths.isFirstConfigCreated ? "Session config created" : "Session config exists",
      input.paths.configPath
    )
  );

  if (input.configError) {
    checks.push(
      blocking(
        "config_valid",
        "Config file is invalid",
        errorToMessage(input.configError),
        `Edit ${input.paths.configPath}.`
      )
    );
  } else if (input.appConfig) {
    checks.push(ok("config_valid", "Config file is valid", input.paths.configPath));
    addConfigReadinessChecks(checks, input.appConfig, env, input.paths.configPath);
  } else {
    checks.push(
      blocking(
        "config_valid",
        "Config file could not be loaded",
        "No parsed config was available.",
        `Edit ${input.paths.configPath}.`
      )
    );
  }

  if (input.envExampleWritten) {
    checks.push(
      ok(
        "env_example_written",
        "Example env file is available",
        input.paths.envExamplePath
      )
    );
  }

  return {
    target: "telegram",
    ready: checks.every((check) => check.severity !== "blocking"),
    workspaceSessionId: input.paths.workspaceSessionId,
    sessionRoot: input.paths.sessionRoot,
    workspaceRoot: input.paths.workspaceRoot,
    persistenceRoot: input.paths.persistenceRoot,
    configPath: input.paths.configPath,
    envExamplePath: input.paths.envExamplePath,
    nextCommand: "mahabot telegram",
    checks,
  };
}

export function renderTelegramOnboardingReport(report: TelegramOnboardingReport): string {
  const blockingChecks = report.checks.filter((check) => check.severity === "blocking");
  const lines = [
    "mahabot Telegram onboarding",
    "",
    `Config: ${report.configPath}`,
    `Workspace: ${report.workspaceRoot}`,
    `Env example: ${report.envExamplePath}`,
    "",
    report.ready
      ? "Status: ready"
      : `Status: not ready (${blockingChecks.length} blocking item${blockingChecks.length === 1 ? "" : "s"})`,
    "",
    "Checks:",
    ...report.checks.flatMap(renderCheck),
    "",
  ];

  if (report.ready) {
    lines.push(`Next: run \`${report.nextCommand}\`.`, "");
  } else {
    lines.push(
      "Next:",
      ...blockingChecks.map((check) => `- ${check.action ?? check.detail}`),
      "",
      `After fixing the blocking items, run \`${report.nextCommand}\`.`,
      ""
    );
  }

  return lines.join("\n");
}

export async function writeTelegramEnvExample(
  envExamplePath: string,
  appConfig?: AppConfig
): Promise<void> {
  const envVars = getRequiredEnvVarNames(appConfig);
  const lines = [
    "# Copy these placeholder names into your shell environment or a .env file.",
    "# Do not commit real secret values.",
    ...envVars.map((name) => `${name}=${placeholderForEnvVar(name)}`),
    "",
  ];

  await writeFile(envExamplePath, lines.join("\n"), "utf-8");
}

function addConfigReadinessChecks(
  checks: OnboardingCheck[],
  appConfig: AppConfig,
  env: NodeJS.ProcessEnv,
  configPath: string
): void {
  if (appConfig.ingress.telegram.enabled) {
    checks.push(ok("telegram_enabled", "Telegram ingress is enabled", "ingress.telegram.enabled=true"));
  } else {
    checks.push(
      blocking(
        "telegram_enabled",
        "Telegram ingress is disabled",
        "ingress.telegram.enabled is false.",
        `Set ingress.telegram.enabled=true in ${configPath}.`
      )
    );
  }

  const tokenEnvVar = appConfig.ingress.telegram.botTokenEnvVar.trim();
  if (tokenEnvVar) {
    checks.push(
      ok(
        "telegram_bot_token_env_var_configured",
        "Telegram token env var is configured",
        tokenEnvVar
      )
    );
    if (env[tokenEnvVar]?.trim()) {
      checks.push(ok("telegram_bot_token_present", "Telegram token env var is set", tokenEnvVar));
    } else {
      checks.push(
        blocking(
          "telegram_bot_token_present",
          "Telegram token env var is missing",
          `Environment variable ${tokenEnvVar} is not set.`,
          `Set ${tokenEnvVar} before running mahabot telegram.`
        )
      );
    }
  } else {
    checks.push(
      blocking(
        "telegram_bot_token_env_var_configured",
        "Telegram token env var is not configured",
        "ingress.telegram.botTokenEnvVar is empty.",
        `Set ingress.telegram.botTokenEnvVar in ${configPath}.`
      )
    );
  }

  const allowedUserIds = appConfig.ingress.telegram.allowedChatIds
    .map((value) => String(value).trim())
    .filter((value) => value.length > 0);
  if (allowedUserIds.length > 0) {
    checks.push(
      ok(
        "telegram_allowed_user_ids",
        "Telegram allowed user ids are configured",
        `Configured ${allowedUserIds.length} allowed user id${allowedUserIds.length === 1 ? "" : "s"}.`
      )
    );
  } else {
    checks.push(
      blocking(
        "telegram_allowed_user_ids",
        "Telegram allowed user ids are missing",
        "ingress.telegram.allowedChatIds is empty.",
        `Put your Telegram user id in ingress.telegram.allowedChatIds in ${configPath}.`
      )
    );
  }
}

function getRequiredEnvVarNames(appConfig?: AppConfig): string[] {
  const telegramToken = appConfig?.ingress.telegram.botTokenEnvVar || DEFAULT_CONFIG.ingress.telegram.botTokenEnvVar;
  return Array.from(new Set([telegramToken].map((value) => value.trim()).filter(Boolean)));
}

function placeholderForEnvVar(name: string): string {
  const normalized = name.toLowerCase();
  if (normalized.includes("telegram") || normalized.includes("bot_token")) {
    return "your_telegram_bot_token_here";
  }
  if (normalized.includes("openai")) {
    return "your_openai_api_key_here";
  }
  return "your_secret_value_here";
}

function renderCheck(check: OnboardingCheck): string[] {
  const prefix = check.severity === "ok" ? "[ok]" : "[blocking]";
  const lines = [`- ${prefix} ${check.title}: ${check.detail}`];
  if (check.action) {
    lines.push(`  Action: ${check.action}`);
  }
  return lines;
}

function ok(id: OnboardingCheckId, title: string, detail: string): OnboardingCheck {
  return {
    id,
    severity: "ok",
    title,
    detail,
  };
}

function blocking(
  id: OnboardingCheckId,
  title: string,
  detail: string,
  action: string
): OnboardingCheck {
  return {
    id,
    severity: "blocking",
    title,
    detail,
    action,
  };
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
