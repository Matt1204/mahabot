import type { AppConfig } from "../../../config/types.js";
import { createBashTool } from "../bashTool.js";
import { createEditFileTool } from "../editFileTool.js";
import { createListTreeTool } from "../listTreeTool.js";
import { createReadFileTool } from "../readFileTool.js";
import { createWriteFileTool } from "../writeFileTool.js";
import { createEchoStructuredInputTool } from "../showcase/echoStructuredInputTool.js";
import { createFailIntentionallyTool } from "../showcase/failIntentionallyTool.js";
import { createProgressiveTickerTool } from "../showcase/progressiveTickerTool.js";
import { createRenderDebugBadgeTool } from "../showcase/renderDebugBadgeTool.js";
import { createShowRuntimeInfoTool } from "../showcase/showRuntimeInfoTool.js";

import type { ToolRegistry } from "./toolRegistry.js";

export interface ToolRuntimeContext {
  workspaceRoot?: string;
}

/**
 * Central tool assembly entrypoint.
 *
 * Why this exists:
 * - callers should not care about internal phases (standard/addon/future packs).
 * - we keep one business-assembly seam for all tool availability decisions.
 */
export function registerTools(
  toolRegistry: ToolRegistry,
  appConfig: AppConfig,
  toolRuntimeContext: ToolRuntimeContext = {}
): void {
  registerStandardTools(toolRegistry, appConfig, toolRuntimeContext);
  registerAddonTools(toolRegistry, appConfig, toolRuntimeContext);
}

function registerStandardTools(
  registry: ToolRegistry,
  appConfig: AppConfig,
  toolRuntimeContext: ToolRuntimeContext
): void {
  registry.registerStandard(createShowRuntimeInfoTool());
  // Bash needs an explicit workspace root to enforce path-boundary checks.
  // In fallback construction paths without this context, we intentionally skip Bash.
  if (toolRuntimeContext.workspaceRoot) {
    registry.registerStandard(
      createBashTool({
        workspaceRoot: toolRuntimeContext.workspaceRoot,
        restrictToWorkspace: appConfig.tools.restrictToWorkspace,
      })
    );
    registry.registerStandard(
      createReadFileTool({
        workspaceRoot: toolRuntimeContext.workspaceRoot,
        restrictToWorkspace: appConfig.tools.restrictToWorkspace,
      })
    );
    registry.registerStandard(
      createWriteFileTool({
        workspaceRoot: toolRuntimeContext.workspaceRoot,
        restrictToWorkspace: appConfig.tools.restrictToWorkspace,
      })
    );
    registry.registerStandard(
      createEditFileTool({
        workspaceRoot: toolRuntimeContext.workspaceRoot,
        restrictToWorkspace: appConfig.tools.restrictToWorkspace,
      })
    );
    registry.registerStandard(
      createListTreeTool({
        workspaceRoot: toolRuntimeContext.workspaceRoot,
        restrictToWorkspace: appConfig.tools.restrictToWorkspace,
      })
    );
  }
  // registry.registerStandard(createEchoStructuredInputTool());
  // registry.registerStandard(createProgressiveTickerTool());
  // registry.registerStandard(createRenderDebugBadgeTool());
  // registry.registerStandard(createFailIntentionallyTool());
}

function registerAddonTools(
  _registry: ToolRegistry,
  _appConfig: AppConfig,
  _toolRuntimeContext: ToolRuntimeContext
): void {
  // Reserved phase: add-on tool policy is intentionally disabled in this stage.
}
