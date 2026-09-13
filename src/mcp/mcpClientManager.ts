import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { toolRegistry } from "../tools/registry.js";
import type { ToolDefinition } from "../tools/types.js";
import { childLogger } from "../config/logger.js";
import { NotConfiguredError } from "../utils/errors.js";

const log = childLogger("mcp");

export interface McpServerConfig {
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

// Section 41: MCP support. Tools discovered from a connected MCP server are
// wrapped into our normal ToolDefinition shape and registered into the
// *same* toolRegistry builtin tools use — they go through identical
// permission checks and approval gating (Section 41: "do not allow MCP
// tools to bypass the security layer"). MCP tools are conservatively
// required to request approval by default since we cannot know their real
// side effects ahead of time; an operator can lower this per-server in
// config if they trust the server.
class McpClientManager {
  private clients = new Map<string, Client>();

  async connect(config: McpServerConfig, opts?: { defaultRequiresApproval?: boolean }): Promise<{ toolsRegistered: number }> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: config.env,
    });

    const client = new Client({ name: "jarvis", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);
    this.clients.set(config.id, client);

    const { tools } = await client.listTools();
    let registered = 0;
    for (const mcpTool of tools) {
      const definition: ToolDefinition = {
        name: `mcp_${config.id}_${mcpTool.name}`,
        description: mcpTool.description ?? `MCP tool "${mcpTool.name}" from server "${config.id}".`,
        version: "mcp",
        // MCP tool schemas are already JSON Schema; we accept-all at the
        // zod layer and let the MCP server itself validate, but we still
        // require an object so the model can't pass a bare scalar.
        inputSchema: z.record(z.unknown()),
        jsonSchema: (mcpTool.inputSchema as Record<string, unknown>) ?? { type: "object" },
        // Unknown side effects -> treat as writes by default (least privilege).
        requiredPermissions: ["network.fetch"],
        requiresApproval: opts?.defaultRequiresApproval ?? true,
        source: "mcp",
        async execute(input, ctx) {
          const result = await client.callTool({ name: mcpTool.name, arguments: input as Record<string, unknown> }, undefined, {
            signal: ctx.signal,
          });
          return { output: result.content, untrusted: true };
        },
      };
      toolRegistry.register(definition);
      registered++;
    }

    log.info({ server: config.id, registered }, "connected MCP server and registered tools");
    return { toolsRegistered: registered };
  }

  async disconnect(serverId: string): Promise<void> {
    const client = this.clients.get(serverId);
    if (!client) throw new NotConfiguredError(`MCP server "${serverId}"`);
    await client.close();
    this.clients.delete(serverId);
    for (const tool of toolRegistry.listBySource("mcp")) {
      if (tool.name.startsWith(`mcp_${serverId}_`)) toolRegistry.unregister(tool.name);
    }
  }

  listConnected(): string[] {
    return [...this.clients.keys()];
  }
}

export const mcpClientManager = new McpClientManager();
