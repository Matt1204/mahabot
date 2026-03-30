import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import readline from "node:readline/promises";

import { Agent, EventInspection } from "../agent/index.js";
import { AgentWorker } from "../agent/worker/agentWorker.js";
import type { AgentRuntimeStatusPublisher } from "../agent/runtimeStatus/types.js";
import { assembleTools, ToolRegistry } from "../agent/tools/index.js";
import { ConfigManager } from "../config/index.js";
import { ContextManager } from "../context/index.js";
import { createCliRenderer } from "./egress/cliRenderer.js";
import { publishCliUserMessage } from "./ingress/cliIngressAdapter.js";
import { InMemoryMessageBus, createBusMessageId, type MessageBus } from "../messageBus/index.js";

const DEMO_SESSION_ID = "cli-stable-session";

interface SessionRuntime {
  agent: Agent;
  worker: AgentWorker;
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
    const bootstrap = await this.configManager.initializeSessionWorkspace(DEMO_SESSION_ID);

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
      bus
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
              bus
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

  private async buildSessionRuntime(
    sessionId: string,
    sessionRoot: string,
    workspaceRoot: string,
    persistenceRoot: string,
    bus: MessageBus
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
      channel: "cli",
      chatId: "local",
      userId: "cli-user",
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
