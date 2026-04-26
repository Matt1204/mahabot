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
import { createCliRenderer } from "./egress/cliRenderer.js";
import { createTelegramEgressRelay } from "./egress/telegramEgressAdapter.js";
import { publishCliUserMessage } from "./ingress/cliIngressAdapter.js";
import { evaluateTelegramIngress } from "./ingress/telegramAccessPolicy.js";
import { publishTelegramUserMessage } from "./ingress/telegramIngressAdapter.js";
import { resolveTelegramRuntimeConfig } from "./ingress/telegramRuntimeConfig.js";
import { InMemoryMessageBus, createBusMessageId, type MessageBus } from "../messageBus/index.js";

const CLI_WORKSPACE_SESSION_ID = "cli-stable-session";
const TELEGRAM_WORKSPACE_SESSION_ID = "telegram-stable-session";

interface SessionRuntime {
  agent: Agent;
  worker: AgentWorker;
}

interface WorkerBinding {
  channel: "cli" | "telegram";
  chatId: string;
  userId: string;
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
    const bootstrap = await this.configManager.initializeSessionWorkspace(TELEGRAM_WORKSPACE_SESSION_ID);

    if (bootstrap.isFirstConfigCreated) {
      this.io.output.write(
        [
          "Created session config for mahabot.",
          `Config path: ${bootstrap.configPath}`,
          "Please fill in required values in the config file, then re-run `mahabot telegram`.",
          "",
        ].join("\n"),
      );
      return;
    }

    const appConfig = await this.configManager.load();
    const telegramConfig = resolveTelegramRuntimeConfig(appConfig, process.env);

    const bus = new InMemoryMessageBus({
      warn: console.warn,
    });

    const bot = new Telegraf(telegramConfig.botToken);
    let activeChatId: string | null = null;
    let activeRuntime:
      | (SessionRuntime & { sessionId: string; chatId: string; stopTelegramRelay: () => void })
      | null = null;
    let activationPromise: Promise<void> | null = null;

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

    bot.on("message", async (ctx) => {
      if (shuttingDown) {
        return;
      }

      if (!ctx.chat || !ctx.from || !ctx.message || !("text" in ctx.message)) {
        return;
      }

      const chatId = String(ctx.chat.id);
      const userId = String(ctx.from.id);
      const messageText = ctx.message.text;

      if (ctx.chat.type !== "private") {
        await ctx.reply("This bot currently supports private text chats only.");
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

      if (decision.type === "accept_activate") {
        const sessionId = `tg:${chatId}`;
        activeChatId = chatId;

        activationPromise = (async () => {
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
            return;
          }
          runtime.worker.start();
          const stopTelegramRelay = createTelegramEgressRelay({
            bus,
            sessionId,
            chatId,
            client: {
              sendMessage: (targetChatId, text) => bot.telegram.sendMessage(targetChatId, text),
            },
            logger: {
              warn: console.warn,
            },
          });

          activeRuntime = {
            ...runtime,
            sessionId,
            chatId,
            stopTelegramRelay,
          };

          this.io.output.write(`[telegram] active chat set to ${chatId}, session ${sessionId}\n`);
        })();

        try {
          await activationPromise;
        } catch (error) {
          activeChatId = null;
          activeRuntime = null;
          await ctx.reply(`bot> [error] ${String(error)}`);
          return;
        } finally {
          activationPromise = null;
        }
      }

      if (activationPromise) {
        try {
          await activationPromise;
        } catch (error) {
          await ctx.reply(`bot> [error] ${String(error)}`);
          return;
        }
      }

      if (!activeRuntime) {
        await ctx.reply("bot> [error] runtime is not ready.");
        return;
      }

      publishTelegramUserMessage({
        bus,
        sessionId: activeRuntime.sessionId,
        text: messageText,
        chatId,
        userId,
        username: ctx.from?.username,
        firstName: ctx.from?.first_name,
        lastName: ctx.from?.last_name,
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

    const eventInspection = new EventInspection(appConfig.eventInspection, {
      publishStatus: publishRuntimeStatus,
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
          sessionJsonlPath: resolve(persistenceRoot, "session.jsonl"),
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
