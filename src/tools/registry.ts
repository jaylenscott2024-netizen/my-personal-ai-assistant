import type { ToolDefinition } from "./types.js";
import { ValidationError } from "../utils/errors.js";
import { childLogger } from "../config/logger.js";

const log = childLogger("toolRegistry");

// Section 15: centralized, dynamic tool discovery. Plugins (Section 40) and
// MCP servers (Section 41) register into the exact same map builtin tools
// live in, so the agent's tool-selection step is source-agnostic.
class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      log.warn({ tool: tool.name }, "overwriting previously registered tool");
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) throw new ValidationError(`Unknown tool "${name}".`);
    return tool;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  listBySource(source: ToolDefinition["source"]): ToolDefinition[] {
    return this.list().filter((t) => t.source === source);
  }

  toDescriptors() {
    return this.list().map((t) => ({ name: t.name, description: t.description, inputSchema: t.jsonSchema }));
  }
}

export const toolRegistry = new ToolRegistry();
