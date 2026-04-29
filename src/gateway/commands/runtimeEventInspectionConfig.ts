import type {
  EventInspectionConfig,
  EventInspectionIncludeConfig,
  EventInspectionThinkingConfig,
} from "../../config/types.js";

export interface RuntimeEventInspectionConfigSnapshot extends EventInspectionConfig {}

export class RuntimeEventInspectionConfig {
  private useEventInspection: boolean;
  private showTokenUsage: boolean;
  private include: EventInspectionIncludeConfig;
  private thinking: EventInspectionThinkingConfig;

  constructor(initialConfig: EventInspectionConfig) {
    this.useEventInspection = initialConfig.useEventInspection;
    this.showTokenUsage = initialConfig.showTokenUsage;
    this.include = cloneInclude(initialConfig.include);
    this.thinking = cloneThinking(initialConfig.thinking);
  }

  getSnapshot(): RuntimeEventInspectionConfigSnapshot {
    return {
      useEventInspection: this.useEventInspection,
      showTokenUsage: this.showTokenUsage,
      include: cloneInclude(this.include),
      thinking: cloneThinking(this.thinking),
    };
  }

  setAllEvents(enabled: boolean): RuntimeEventInspectionConfigSnapshot {
    this.useEventInspection = enabled;
    this.include = mapInclude(enabled);
    return this.getSnapshot();
  }

  setToolEvents(enabled: boolean): RuntimeEventInspectionConfigSnapshot {
    this.include = {
      ...this.include,
      tool_execution_start: enabled,
      tool_execution_update: enabled,
      tool_execution_end: enabled,
    };
    if (enabled) {
      this.useEventInspection = true;
    }
    return this.getSnapshot();
  }

  setThinking(enabled: boolean): RuntimeEventInspectionConfigSnapshot {
    this.thinking = {
      ...this.thinking,
      enabled,
    };
    return this.getSnapshot();
  }
}

export function createRuntimeEventInspectionConfig(
  initialConfig: EventInspectionConfig
): RuntimeEventInspectionConfig {
  return new RuntimeEventInspectionConfig(initialConfig);
}

function cloneInclude(include: EventInspectionIncludeConfig): EventInspectionIncludeConfig {
  return { ...include };
}

function cloneThinking(thinking: EventInspectionThinkingConfig): EventInspectionThinkingConfig {
  return { ...thinking };
}

function mapInclude(enabled: boolean): EventInspectionIncludeConfig {
  return {
    agent_start: enabled,
    agent_end: enabled,
    turn_start: enabled,
    turn_end: enabled,
    message_start: enabled,
    message_update: enabled,
    message_end: enabled,
    tool_execution_start: enabled,
    tool_execution_update: enabled,
    tool_execution_end: enabled,
  };
}
