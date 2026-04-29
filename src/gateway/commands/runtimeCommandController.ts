import type {
  AgentRuntimeLifecycleSnapshot,
  AppliedAgentConfigSnapshot,
  RuntimeContextSnapshot,
} from "../../agent/types.js";
import type { RuntimeEventInspectionConfig } from "./runtimeEventInspectionConfig.js";
import type { ParsedRuntimeCommand } from "./commandParser.js";

export interface RuntimeCommandAgentStateSnapshot {
  context: RuntimeContextSnapshot;
  appliedConfig: AppliedAgentConfigSnapshot;
  runtime: AgentRuntimeLifecycleSnapshot;
  toolCount: number;
}

export interface RuntimeCommandControllerDeps {
  eventInspectionConfig: RuntimeEventInspectionConfig;
  getContextSnapshot: () => RuntimeContextSnapshot;
  getAgentStateSnapshot: () => RuntimeCommandAgentStateSnapshot;
}

export interface RuntimeCommandExecutionResult {
  replies: string[];
}

export class RuntimeCommandController {
  constructor(private readonly deps: RuntimeCommandControllerDeps) {}

  execute(commands: ParsedRuntimeCommand[]): RuntimeCommandExecutionResult {
    const replies: string[] = [];

    for (const command of commands) {
      const reply = this.executeOne(command);
      if (reply) {
        replies.push(reply);
      }
    }

    return { replies };
  }

  private executeOne(command: ParsedRuntimeCommand): string {
    switch (command.name) {
      case "context":
        return formatContextSnapshot(this.deps.getContextSnapshot());
      case "agent_state":
        return formatAgentStateSnapshot(
          this.deps.getAgentStateSnapshot(),
          this.deps.eventInspectionConfig.getSnapshot()
        );
      case "inspect":
        return formatInspectionSnapshot(this.deps.eventInspectionConfig.getSnapshot());
      case "inspect_all_on":
        return formatInspectionSnapshot(this.deps.eventInspectionConfig.setAllEvents(true));
      case "inspect_all_off":
        return formatInspectionSnapshot(this.deps.eventInspectionConfig.setAllEvents(false));
      case "inspect_tool_on":
        return formatInspectionSnapshot(this.deps.eventInspectionConfig.setToolEvents(true));
      case "inspect_tool_off":
        return formatInspectionSnapshot(this.deps.eventInspectionConfig.setToolEvents(false));
      case "inspect_thinking_on":
        return formatInspectionSnapshot(this.deps.eventInspectionConfig.setThinking(true));
      case "inspect_thinking_off":
        return formatInspectionSnapshot(this.deps.eventInspectionConfig.setThinking(false));
    }
  }
}

function formatAgentStateSnapshot(
  snapshot: RuntimeCommandAgentStateSnapshot,
  inspectionSnapshot: ReturnType<RuntimeEventInspectionConfig["getSnapshot"]>
): string {
  return [
    "agent_state:",
    "",
    "context:",
    `curContextSize: ${snapshot.context.curContextSize}`,
    `compactLowWatermarkTokens: ${snapshot.context.compactLowWatermarkTokens}`,
    `compactHighWatermarkTokens: ${snapshot.context.compactHighWatermarkTokens}`,
    `runtimeMessageCount: ${snapshot.context.runtimeMessageCount}`,
    `agentBusy: ${snapshot.context.agentBusy}`,
    "",
    "applied_config:",
    `providerName: ${snapshot.appliedConfig.providerName}`,
    `modelName: ${snapshot.appliedConfig.modelName}`,
    `modelProvider: ${snapshot.appliedConfig.modelProvider}`,
    `modelId: ${snapshot.appliedConfig.modelId}`,
    `modelDisplayName: ${snapshot.appliedConfig.modelDisplayName}`,
    `thinkingLevel: ${snapshot.appliedConfig.thinkingLevel}`,
    `supportsImageInput: ${snapshot.appliedConfig.supportsImageInput}`,
    "",
    "runtime:",
    `running: ${snapshot.runtime.running}`,
    `agentBusy: ${snapshot.runtime.agentBusy}`,
    `runtimeMessageCount: ${snapshot.runtime.runtimeMessageCount}`,
    `persistenceEnabled: ${snapshot.runtime.persistenceEnabled}`,
    `startupRestoreMessageCount: ${snapshot.runtime.startupRestoreMessageCount}`,
    "",
    "tools:",
    `toolCount: ${snapshot.toolCount}`,
    "",
    "inspection:",
    `useEventInspection: ${inspectionSnapshot.useEventInspection}`,
    `enabledEvents: ${formatEnabledEvents(inspectionSnapshot)}`,
    `thinkingEnabled: ${inspectionSnapshot.thinking.enabled}`,
  ].join("\n");
}

function formatContextSnapshot(snapshot: RuntimeContextSnapshot): string {
  return [
    "context:",
    `curContextSize: ${snapshot.curContextSize}`,
    `compactLowWatermarkTokens: ${snapshot.compactLowWatermarkTokens}`,
    `compactHighWatermarkTokens: ${snapshot.compactHighWatermarkTokens}`,
    `runtimeMessageCount: ${snapshot.runtimeMessageCount}`,
    `agentBusy: ${snapshot.agentBusy}`,
  ].join("\n");
}

function formatInspectionSnapshot(snapshot: ReturnType<RuntimeEventInspectionConfig["getSnapshot"]>): string {
  return [
    "inspection:",
    `useEventInspection: ${snapshot.useEventInspection}`,
    `enabledEvents: ${formatEnabledEvents(snapshot)}`,
    `thinkingEnabled: ${snapshot.thinking.enabled}`,
  ].join("\n");
}

function formatEnabledEvents(
  snapshot: ReturnType<RuntimeEventInspectionConfig["getSnapshot"]>
): string {
  const enabledEvents = Object.entries(snapshot.include)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  return enabledEvents.length > 0 ? enabledEvents.join(", ") : "none";
}
