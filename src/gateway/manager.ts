import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import readline from "node:readline/promises";

import { Agent, EventInspection } from "../agent/index.js";
import type { InspectionSink } from "../agent/index.js";
import { assembleTools, ToolRegistry } from "../agent/tools/index.js";
import { createCliProgressUpdateSink } from "./progress/cliProgressSink.js";
import { ConfigManager } from "../config/index.js";
import { ContextManager } from "../context/index.js";

const DEMO_SESSION_ID = "cli-stable-session";
/**
 * Future gateway/external manager entrypoint.
 *
 * Current implementation:
 * - `mahabot cli` interactive mode
 * Future scope:
 * - message bus ingestion
 * - telegram/webhook ingress
 * - external transport orchestration
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

    let agent = await this.buildAgentForSession(
      bootstrap.workspaceSessionId,
      bootstrap.sessionRoot,
      bootstrap.workspaceRoot,
      bootstrap.persistenceRoot
    );
    // await this.printAgentStatusOverview(agent);

    const rl = readline.createInterface({
      input: this.io.input,
      output: this.io.output,
      terminal: true,
    });

    this.io.output.write("mahabot CLI mode started. Type /exit to quit.\n\n");

    try {
      while (true) {
        const userLine = (await rl.question("you> ")).trim();

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
            await agent.stop();
            agent = await this.buildAgentForSession(
              bootstrap.workspaceSessionId,
              bootstrap.sessionRoot,
              bootstrap.workspaceRoot,
              bootstrap.persistenceRoot
            );
            // await this.printAgentStatusOverview(agent);
            this.io.output.write("Conversation context cleared and system prompt reloaded.\n\n");
          } catch (error) {
            this.io.output.write(`bot> [error] ${String(error)}\n\n`);
          }
          continue;
        }

        try {
          const result = await agent.runCliTurn(userLine);
          this.io.output.write(`bot> ${result.cliMessage}\n\n`);
        } catch (error) {
          this.io.output.write(`bot> [error] ${String(error)}\n\n`);
        }
      }
    } finally {
      rl.close();
      await agent.stop();
    }
  }

  private async buildAgentForSession(
    sessionId: string,
    sessionRoot: string,
    workspaceRoot: string,
    persistenceRoot: string
  ): Promise<Agent> {
    const appConfig = this.configManager.get();
    const { provider: activeProvider, model: activeModel } = this.configManager.getActiveProviderModel();

    // Progress path (docs/progress_sink_and_inspection_sink.md): `in_flight_update` is wired here only.
    // - `quotaRef` is shared with Agent (passed below) so Agent.invokeAgentLoop can reset `used` each turn;
    //   the tool increments `used` on successful sink delivery.
    // - `progressSink` is independent of EventInspection / AgentEvent; it is not an InspectionSink.
    const progressUpdateQuotaRef = { used: 0 };
    const progressSink = createCliProgressUpdateSink(
      this.io.output,
      supportsAnsi(this.io.output)
    );

    const toolRegistry = new ToolRegistry();
    assembleTools(toolRegistry, appConfig, {
      workspaceRoot,
      progressUpdate: { quotaRef: progressUpdateQuotaRef, sink: progressSink },
    });

    const systemPromptAssembly = await this.contextManager.assembleSystemPrompt(
      sessionId,
      sessionRoot,
      workspaceRoot,
      persistenceRoot,
      toolRegistry
    );

    // Inspection path: subscribe to runtime AgentEvent stream via `onAgentEvent` (see Agent constructor).
    // EventInspection filters by appConfig.eventInspection, renders `[event_name]` lines, and calls
    // InspectionSink.publish — see eventInspection.ts for microtask deferral.
    const eventInspection = new EventInspection(appConfig.eventInspection, {
      sinks: [
        {
          channel: "cli",
          sink: createCliInspectionSink(this.io.output),
        },
      ],
      getContextWatermarks: () => ({
        lowWaterMark: appConfig.agent.compactLowWatermarkTokens,
        highWaterMark: appConfig.agent.compactHighWatermarkTokens,
      }),
      supportsAnsi: (channel) =>
        channel === "cli" ? supportsAnsi(this.io.output) : false,
      logger: {
        debug: () => {},
        warn: console.warn,
        error: console.error,
      },
    });

    return Agent.createFromAppConfig(
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
        // CLI prints final assistant text itself; suppress noisy event logs.
        logger: {
          debug: () => {},
          info: () => {},
          warn: console.warn,
          error: console.error,
        },
        outboundSink: async () => {
          // keep outbound in-process for CLI mode
        },
        onAgentEvent: (event) => {
          // Forwards pi-agent-core AgentEvent to EventInspection.handleAgentEvent, which immediately
          // returns after queueMicrotask (heavy work + sink.publish are deferred — see eventInspection.ts).
          eventInspection.handleAgentEvent(event);
        },
        progressUpdateQuotaRef,
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
  }

  // private async printAgentStatusOverview(agent: Agent): Promise<void> {
  //   const overview = await agent.getStartupStatusOverview();
  //   const historyRoleSummary = `user=${overview.history.loadedByRole.user}, assistant=${overview.history.loadedByRole.assistant}, toolResult=${overview.history.loadedByRole.toolResult}, other=${overview.history.loadedByRole.other}`;
  //   const thinkingBudgets = overview.agent.thinkingBudgets
  //     ? JSON.stringify(overview.agent.thinkingBudgets)
  //     : "(none)";
  //   const sessionId = overview.agent.sessionId ?? "(none)";
  //   const maxRetryDelayMs =
  //     overview.agent.maxRetryDelayMs === undefined ? "(default)" : String(overview.agent.maxRetryDelayMs);
  //   const historyError = overview.history.error ? ` error=${overview.history.error}` : "";

  //   this.io.output.write(
  //     [
  //       "[agent status overview]",
  //       `model provider=${overview.model.provider} id=${overview.model.id} name=${overview.model.name} api=${overview.model.api}`,
  //       `model baseUrl=${overview.model.baseUrl}`,
  //       `model reasoning=${overview.model.reasoning} input=${overview.model.input.join(",")} contextWindow=${overview.model.contextWindow} maxTokens=${overview.model.maxTokens}`,
  //       `model cost input=${overview.model.cost.input} output=${overview.model.cost.output} cacheRead=${overview.model.cost.cacheRead} cacheWrite=${overview.model.cost.cacheWrite}`,
  //       `model headersConfigured=${overview.model.headersConfigured} compatConfigured=${overview.model.compatConfigured}`,
  //       `agent thinkingLevel=${overview.agent.thinkingLevel} transport=${overview.agent.transport} sessionId=${sessionId} maxRetryDelayMs=${maxRetryDelayMs}`,
  //       `agent thinkingBudgets=${thinkingBudgets} tools=${overview.agent.tools} runtimeMessages=${overview.agent.runtimeMessages} isStreaming=${overview.agent.isStreaming} pendingToolCalls=${overview.agent.pendingToolCalls}`,
  //       `history restoreStatus=${overview.history.restoreStatus} loadedMessages=${overview.history.loadedMessages} persistedCursor=${overview.history.persistedCursor} runtimeMessages=${overview.history.runtimeMessages}`,
  //       `history loadedByRole ${historyRoleSummary}${historyError}`,
  //       "",
  //     ].join("\n")
  //   );
  // }
}

// Minimal InspectionSink for CLI: one rendered line per publish (prefix already in `event.line`).
function createCliInspectionSink(output: { write: (chunk: string) => unknown }): InspectionSink {
  return {
    publish(event) {
      output.write(`${event.line}\n`);
    },
  };
}

function supportsAnsi(output: { isTTY?: boolean }): boolean {
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }

  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== "0") {
    return true;
  }

  if (process.env.TERM === "dumb") {
    return false;
  }

  return Boolean(output.isTTY);
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
