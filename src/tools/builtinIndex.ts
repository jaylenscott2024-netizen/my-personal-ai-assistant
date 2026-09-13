import { toolRegistry } from "./registry.js";
import { calculatorTool } from "./builtin/calculatorTool.js";
import { datetimeTool } from "./builtin/datetimeTool.js";
import { webFetchTool } from "./builtin/webFetchTool.js";
import { filesystemTool } from "./builtin/filesystemTool.js";
import { browserTool } from "./builtin/browserTool.js";
import { integrationTools } from "./builtin/integrationTools.js";

export function registerBuiltinTools(): void {
  for (const tool of [calculatorTool, datetimeTool, webFetchTool, filesystemTool, browserTool, ...integrationTools]) {
    toolRegistry.register(tool as never);
  }
}
