import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import readline from "node:readline/promises";
import { Telegraf } from "telegraf";

import { Agent, EventInspection } from "../agent/index.js";
import { AgentWorker } from "../agent/worker/agentWorker.js";
import type { AgentRuntimeStatusPublisher } from "../agent/runtimeStatus/types.js";
import { assembleTools, ToolRegistry } from "../agent/tools/index.js";
import { ConfigManager } from "../config/index.js";
import { ContextManager } from "../context/index.js";
import {
  evaluateTelegramOnboarding,
  renderTelegramOnboardingReport,
} from "../onboarding/index.js";
import { createCliRenderer } from "./egress/cliRenderer.js";
import { createTelegramEgressRelay } from "./egress/telegramEgressAdapter.js";
import {
  RuntimeCommandController,
  createRuntimeEventInspectionConfig,
  parseRuntimeCommands,
  type RuntimeEventInspectionConfig,
} from "./commands/index.js";
import { publishCliUserMessage } from "./ingress/cliIngressAdapter.js";
import { evaluateTelegramIngress } from "./ingress/telegramAccessPolicy.js";
import { publishTelegramUserParts } from "./ingress/telegramIngressAdapter.js";
import { TelegramMediaStore } from "./ingress/telegramMediaStore.js";
import { TelegramPendingImageBuffer } from "./ingress/telegramPendingImageBuffer.js";
import { resolveTelegramRuntimeConfig } from "./ingress/telegramRuntimeConfig.js";
import { TelegramVoiceTranscriber } from "./ingress/telegramVoiceTranscriber.js";
import {
  InMemoryMessageBus,
  createBusMessageId,
  type MessageBus,
  type UserToAgentPart,
} from "../messageBus/index.js";

const CLI_WORKSPACE_SESSION_ID = "cli-stable-session";

interface SessionRuntime {
  agent: Agent;
  worker: AgentWorker;
  eventInspectionConfig: RuntimeEventInspectionConfig;
  commandController: RuntimeCommandController;
}

interface WorkerBinding {
  channel: "cli" | "telegram";
  chatId: string;
  userId: string;
}

interface TelegramSessionRuntime extends SessionRuntime {
  sessionId: string;
  chatId: string;
  userId: string;
  stopTelegramRelay: () => void;
  mediaStore: TelegramMediaStore;
  pendingImages: TelegramPendingImageBuffer;
  voiceTranscriber: TelegramVoiceTranscriber;
}

/**
 * Gateway orchestrates process lifecycle only.
 * It no longer handles turn execution directly; AgentWorker consumes MessageBus ingress.
 */
export class MahabotGatewayManager {
  private readonly contextManager: ContextManager;

  constructor(
    private readonly configManager: ConfigManager = new ConfigManager(),
    private readonly io = { input, output },
  ) {
    this.contextManager = new ContextManager(this.configManager, {
      debug: () => {},
      warn: console.warn,
      error: console.error,
    });
  }

  async runInCliMode(): Promise<void> {
    const bootstrap = await this.configManager.initializeSessionWorkspace(CLI_WORKSPACE_SESSION_ID);

    if (bootstrap.isFirstConfigCreated) {
      this.io.output.write(
        [
          "Created session config for mahabot.",
          `Config path: ${bootstrap.configPath}`,
          "Please fill in required values in the config file, then re-run `mahabot cli`.",
          "",
        ].join("\n"),
      );
      return;
    }

    await this.configManager.load();

    const bus = new InMemoryMessageBus({
      warn: console.warn,
    });
    const stopRenderer = createCliRenderer({
      bus,
      sessionId: bootstrap.workspaceSessionId,
      output: this.io.output,
    });

    let runtime = await this.buildSessionRuntime(
      bootstrap.workspaceSessionId,
      bootstrap.sessionRoot,
      bootstrap.workspaceRoot,
      bootstrap.persistenceRoot,
      bus,
      {
        channel: "cli",
        chatId: "local",
        userId: "cli-user",
      }
    );
    runtime.worker.start();

    const rl = readline.createInterface({
      input: this.io.input,
      output: this.io.output,
      terminal: true,
    });

    this.io.output.write("mahabot CLI mode started. Type /exit to quit.\n\n");

    try {
      while (true) {
        const userLine = (await rl.question(getUserPrompt(this.io.output))).trim();
        if (!userLine) {
          continue;
        }

        if (isExitCommand(userLine)) {
          this.io.output.write("Bye.\n");
          break;
        }

        if (userLine === "/help") {
          this.io.output.write(helpText());
          continue;
        }

        if (userLine === "/clear") {
          try {
            await runtime.worker.stop();
            await runtime.agent.stop();

            runtime = await this.buildSessionRuntime(
              bootstrap.workspaceSessionId,
              bootstrap.sessionRoot,
              bootstrap.workspaceRoot,
              bootstrap.persistenceRoot,
              bus,
              {
                channel: "cli",
                chatId: "local",
                userId: "cli-user",
              }
            );
            runtime.worker.start();
            this.io.output.write("Conversation context cleared and system prompt reloaded.\n\n");
          } catch (error) {
            this.io.output.write(`bot> [error] ${String(error)}\n\n`);
          }
          continue;
        }

        publishCliUserMessage({
          bus,
          sessionId: bootstrap.workspaceSessionId,
          text: userLine,
        });
      }
    } finally {
      rl.close();
      await runtime.worker.stop();
      await runtime.agent.stop();
      stopRenderer();
    }
  }

  async runInTelegramMode(): Promise<void> {
    const onboarding = await evaluateTelegramOnboarding({
      configManager: this.configManager,
    });

    if (!onboarding.report.ready || !onboarding.appConfig) {
      this.io.output.write(renderTelegramOnboardingReport(onboarding.report));
      return;
    }

    const bootstrap = onboarding.report;
    const appConfig = onboarding.appConfig;
    const telegramConfig = resolveTelegramRuntimeConfig(appConfig, process.env);

    const bus = new InMemoryMessageBus({
      warn: console.warn,
    });

    const bot = new Telegraf(telegramConfig.botToken);
    let activeChatId: string | null = null;
    let activeRuntime: TelegramSessionRuntime | null = null;
    let messageQueue: Promise<void> = Promise.resolve();

    let resolveStopSignal: (() => void) | null = null;
    const stopSignal = new Promise<void>((resolve) => {
      resolveStopSignal = resolve;
    });

    let shuttingDown = false;
    const shutdown = async (reason: string): Promise<void> => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;

      try {
        bot.stop(reason);
      } catch {
        // no-op if bot is not currently running
      }

      if (activeRuntime) {
        await activeRuntime.worker.stop();
        await activeRuntime.agent.stop();
        activeRuntime.stopTelegramRelay();
        activeRuntime.pendingImages.stop();
        activeRuntime = null;
      }

      resolveStopSignal?.();
    };

    const onSigint = () => {
      void shutdown("SIGINT");
    };
    const onSigterm = () => {
      void shutdown("SIGTERM");
    };
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    bot.catch((error) => {
      console.warn(`[telegram] unhandled middleware error: ${String(error)}`);
    });

    const activateRuntime = async (chatId: string, userId: string): Promise<TelegramSessionRuntime | null> => {
      if (activeRuntime) {
        return activeRuntime;
      }

      const sessionId = `tg:${chatId}`;
      const runtime = await this.buildSessionRuntime(
        sessionId,
        bootstrap.sessionRoot,
        bootstrap.workspaceRoot,
        bootstrap.persistenceRoot,
        bus,
        {
          channel: "telegram",
          chatId,
          userId,
        }
      );

      if (shuttingDown) {
        await runtime.agent.stop();
        return null;
      }

      runtime.worker.start();
      const stopTelegramRelay = createTelegramEgressRelay({
        bus,
        sessionId,
        chatId,
        client: {
          sendMessage: (targetChatId, text, options) =>
            bot.telegram.sendMessage(targetChatId, text, options),
        },
        logger: {
          warn: console.warn,
        },
      });

      activeChatId = chatId;
      activeRuntime = {
        ...runtime,
        sessionId,
        chatId,
        userId,
        stopTelegramRelay,
        mediaStore: new TelegramMediaStore({
          persistenceRoot: bootstrap.persistenceRoot,
          sessionId,
          telegram: {
            getFileLink: (fileId) => bot.telegram.getFileLink(fileId),
          },
        }),
        pendingImages: new TelegramPendingImageBuffer({
          timeoutMs: telegramConfig.media.pendingImageTimeoutMs,
        }),
        voiceTranscriber: new TelegramVoiceTranscriber({
          ffmpegCommand: telegramConfig.media.ffmpegCommand,
          transcription: telegramConfig.media.transcription,
        }),
      };

      this.io.output.write(`[telegram] active chat set to ${chatId}, session ${sessionId}\n`);
      return activeRuntime;
    };

    const handleTelegramMessage = async (ctx: any): Promise<void> => {
      if (shuttingDown) {
        return;
      }

      if (!ctx.chat || !ctx.from || !ctx.message) {
        return;
      }

      const chatId = String(ctx.chat.id);
      const userId = String(ctx.from.id);
      const messageKind = getTelegramMessageKind(ctx.message);

      if (ctx.chat.type !== "private") {
        await ctx.reply("This bot currently supports private text, voice, and photo chats only.");
        return;
      }

      const decision = evaluateTelegramIngress({
        activeChatId,
        chatId,
        userId,
        allowedUserIds: telegramConfig.allowedUserIds,
      });

      if (decision.type === "reject_not_whitelisted") {
        await ctx.reply("Access denied: your Telegram user ID is not whitelisted.");
        return;
      }

      if (decision.type === "reject_other_chat") {
        await ctx.reply("This bot is already active in another chat for this run.");
        return;
      }

      if (!messageKind) {
        await ctx.reply("Unsupported message type. Send text, voice, or photo.");
        return;
      }

      if (decision.type === "accept_activate") {
        try {
          await activateRuntime(chatId, userId);
        } catch (error) {
          activeChatId = null;
          activeRuntime = null;
          await ctx.reply(`bot> [error] ${String(error)}`);
          return;
        }
      }

      if (!activeRuntime) {
        await ctx.reply("bot> [error] runtime is not ready.");
        return;
      }

      if (messageKind === "photo") {
        const expired = activeRuntime.pendingImages.clearExpired(activeRuntime.sessionId);
        if (expired?.type === "expired") {
          await activeRuntime.mediaStore.deleteFiles(expired.expiredImages.map((image) => image.path));
          await ctx.reply("Previous pending images expired. Please resend images you still want to include.");
        }

        try {
          const image = await activeRuntime.mediaStore.savePhoto(ctx.message);
          activeRuntime.pendingImages.addImage(activeRuntime.sessionId, image);
          await ctx.reply("Image received. Send a text or voice message to submit it.");
        } catch (error) {
          await ctx.reply(`bot> [error] failed to save image: ${errorMessage(error)}`);
        }
        return;
      }

      if (messageKind === "voice") {
        try {
          const voice = await activeRuntime.mediaStore.saveVoiceTemp(ctx.message);
          const transcription = await activeRuntime.voiceTranscriber.transcribe(voice);
          await publishTriggeredTelegramMessage({
            runtime: activeRuntime,
            bus,
            ctx,
            text: transcription.text,
            origin: "telegram_voice_transcript",
            voice: {
              transcriptModel: transcription.model,
              duration: transcription.duration,
              mimeType: transcription.mimeType,
              fileSize: transcription.fileSize,
            },
          });
        } catch (error) {
          await ctx.reply(`bot> [error] failed to transcribe voice: ${errorMessage(error)}`);
        }
        return;
      }

      const text = String(ctx.message.text).trim();
      if (!text) {
        return;
      }

      const commandParseResult = parseRuntimeCommands(text);
      for (const unknownCommandText of commandParseResult.unknownCommandTexts) {
        console.log(`[telegram command] unknown command: ${unknownCommandText}`);
      }

      if (commandParseResult.commands.length > 0) {
        const commandResult = activeRuntime.commandController.execute(commandParseResult.commands);
        for (const reply of commandResult.replies) {
          await ctx.reply(reply);
        }
      }

      const remainingText = commandParseResult.remainingText.trim();
      if (!remainingText) {
        return;
      }

      await publishTriggeredTelegramMessage({
        runtime: activeRuntime,
        bus,
        ctx,
        text: remainingText,
        origin: "telegram_text",
      });
    };

    bot.on("message", (ctx) => {
      messageQueue = messageQueue
        .then(() => handleTelegramMessage(ctx))
        .catch((error) => {
          console.warn(`[telegram] failed to handle message: ${String(error)}`);
        });
    });

    this.io.output.write("mahabot Telegram mode starting...\n");

    try {
      const launchPromise = bot.launch({
        allowedUpdates: ["message"],
      });

      this.io.output.write("mahabot Telegram mode started. Press Ctrl+C to stop.\n");
      await Promise.race([launchPromise, stopSignal]);
      await stopSignal;
    } finally {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      await shutdown("normal_exit");
    }
  }

  async runTelegramOnboardingMode(): Promise<void> {
    const { report } = await evaluateTelegramOnboarding({
      configManager: this.configManager,
    });

    this.io.output.write(renderTelegramOnboardingReport(report));
  }

  private async buildSessionRuntime(
    sessionId: string,
    sessionRoot: string,
    workspaceRoot: string,
    persistenceRoot: string,
    bus: MessageBus,
    workerBinding: WorkerBinding
  ): Promise<SessionRuntime> {
    const appConfig = this.configManager.get();
    const { provider: activeProvider, model: activeModel } = this.configManager.getActiveProviderModel();

    const publishRuntimeStatus: AgentRuntimeStatusPublisher = (status) => {
      bus.publish({
        id: createBusMessageId(),
        sessionId,
        ts: Date.now(),
        direction: "agent_to_user",
        source: status.source ?? "agent_runtime",
        kind: status.kind,
        priority: status.priority ?? "normal",
        payload: {
          text: status.text,
          format: "plain",
          raw: status.raw,
        },
        renderHints: status.renderHints,
        meta: status.meta,
      });
    };

    const toolRegistry = new ToolRegistry();
    assembleTools(toolRegistry, appConfig, {
      workspaceRoot,
      runtimeStatus: {
        publish: publishRuntimeStatus,
      },
    });

    const systemPromptAssembly = await this.contextManager.assembleSystemPrompt(
      sessionId,
      sessionRoot,
      workspaceRoot,
      persistenceRoot,
      toolRegistry
    );

    const eventInspectionConfig = createRuntimeEventInspectionConfig(appConfig.eventInspection);
    const eventInspection = new EventInspection(appConfig.eventInspection, {
      publishStatus: publishRuntimeStatus,
      getInspectionConfig: () => eventInspectionConfig.getSnapshot(),
      getContextWatermarks: () => ({
        lowWaterMark: appConfig.agent.compactLowWatermarkTokens,
        highWaterMark: appConfig.agent.compactHighWatermarkTokens,
      }),
      logger: {
        debug: () => {},
        warn: console.warn,
        error: console.error,
      },
    });

    const agent = Agent.createFromAppConfig(
      {
        appConfig,
        providerName: activeProvider,
        modelName: activeModel,
        systemPrompt: systemPromptAssembly.systemPrompt,
        thinkingLevel: this.configManager.getThinkingLevel(),
        toolRegistry,
        ensureProviderCredentials: (providerName) =>
          this.configManager.ensureProviderCredentials(providerName),
        getApiKey: (providerName) =>
          this.configManager.getApiKeyForProviderName(providerName),
      },
      {
        logger: {
          debug: () => {},
          info: () => {},
          warn: console.warn,
          error: console.error,
        },
        outboundSink: async () => {
          // Final assistant output is delivered through MessageBus by AgentWorker.
        },
        onAgentEvent: (event) => {
          eventInspection.handleAgentEvent(event);
        },
        messagePersistence: {
          enabled: true,
          sessionId,
          sessionDbPath: resolve(persistenceRoot, "session.sqlite"),
          startupRestoreMessageCount: appConfig.agent.startupRestoreMessageCount,
          compactHighWatermarkTokens: appConfig.agent.compactHighWatermarkTokens,
          compactLowWatermarkTokens: appConfig.agent.compactLowWatermarkTokens,
        },
      }
    );

    const worker = new AgentWorker(bus, agent, {
      sessionId,
      channel: workerBinding.channel,
      chatId: workerBinding.chatId,
      userId: workerBinding.userId,
      logger: {
        warn: console.warn,
        error: console.error,
      },
    });

    return {
      agent,
      worker,
      eventInspectionConfig,
      commandController: new RuntimeCommandController({
        eventInspectionConfig,
        getContextSnapshot: () => agent.getRuntimeContextSnapshot(),
        getAgentStateSnapshot: () => ({
          context: agent.getRuntimeContextSnapshot(),
          appliedConfig: agent.getAppliedConfigSnapshot(),
          runtime: agent.getRuntimeLifecycleSnapshot(),
          toolCount: toolRegistry.getToolNames().length,
        }),
      }),
    };
  }
}

function isExitCommand(line: string): boolean {
  const normalized = line.toLowerCase();
  return (
    normalized === "exit" ||
    normalized === "quit" ||
    normalized === "/exit" ||
    normalized === ":q"
  );
}

function getTelegramMessageKind(message: unknown): "text" | "photo" | "voice" | null {
  if (!message || typeof message !== "object") {
    return null;
  }

  const value = message as Record<string, unknown>;
  if (typeof value.text === "string") {
    return "text";
  }
  if (Array.isArray(value.photo) && value.photo.length > 0) {
    return "photo";
  }
  if (value.voice && typeof value.voice === "object") {
    return "voice";
  }
  return null;
}

async function publishTriggeredTelegramMessage(input: {
  runtime: TelegramSessionRuntime;
  bus: MessageBus;
  ctx: any;
  text: string;
  origin: "telegram_text" | "telegram_voice_transcript";
  voice?: {
    transcriptModel: string;
    duration?: number;
    mimeType?: string;
    fileSize?: number;
  };
}): Promise<void> {
  const parts: UserToAgentPart[] = [];
  const pending = input.runtime.pendingImages.takeImages(input.runtime.sessionId);

  if (pending.type === "expired") {
    await input.runtime.mediaStore.deleteFiles(pending.expiredImages.map((image) => image.path));
    await input.ctx.reply("Pending images expired. Processing your message without them.");
  } else if (pending.type === "ready") {
    parts.push(...pending.images);
  }

  parts.push({
    type: "text",
    text: input.text,
    origin: input.origin,
  });

  publishTelegramUserParts({
    bus: input.bus,
    sessionId: input.runtime.sessionId,
    parts,
    chatId: String(input.ctx.chat.id),
    userId: String(input.ctx.from.id),
    username: input.ctx.from?.username,
    firstName: input.ctx.from?.first_name,
    lastName: input.ctx.from?.last_name,
    voice: input.voice,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function helpText(): string {
  return [
    "Commands:",
    "  /help  Show this help",
    "  /clear Clear conversation context",
    "  /exit  Exit CLI mode",
    "",
  ].join("\n");
}

function getUserPrompt(output: { write: (chunk: string) => unknown }): string {
  const supportsAnsi = "isTTY" in output && (output as { isTTY?: boolean }).isTTY === true;
  if (!supportsAnsi || process.env.NO_COLOR !== undefined || process.env.FORCE_COLOR === "0") {
    return "you> ";
  }
  return "\x1b[1;97myou>\x1b[0m ";
}
