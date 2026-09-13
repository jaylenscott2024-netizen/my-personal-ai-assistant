import { toolRegistry } from "./registry.js";
import { calculatorTool } from "./builtin/calculatorTool.js";
import { datetimeTool } from "./builtin/datetimeTool.js";
import { webFetchTool } from "./builtin/webFetchTool.js";
import { filesystemTool } from "./builtin/filesystemTool.js";
import { browserTool } from "./builtin/browserTool.js";
import { integrationTools } from "./builtin/integrationTools.js";
import { computerTools } from "./builtin/computerTools.js";
import { eyesTools } from "./builtin/eyesTools.js";
import { uiAutomationTools } from "./builtin/uiAutomationTools.js";

export function registerBuiltinTools(): void {
  for (const tool of [
    calculatorTool,
    datetimeTool,
    webFetchTool,
    filesystemTool,
    browserTool,
    ...integrationTools,
    ...computerTools,
    ...eyesTools,
    ...uiAutomationTools,
  ]) {
    toolRegistry.register(tool as never);
  }
}
