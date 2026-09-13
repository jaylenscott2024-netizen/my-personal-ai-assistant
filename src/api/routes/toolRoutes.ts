import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../auth/middleware.js";
import { toolRegistry } from "../../tools/registry.js";
import { loadPlugin, listPlugins, disablePlugin } from "../../plugins/pluginManager.js";
import { mcpClientManager } from "../../mcp/mcpClientManager.js";

const loadPluginSchema = z.object({ path: z.string() });
const connectMcpSchema = z.object({ id: z.string(), command: z.string(), args: z.array(z.string()).optional() });

export async function toolRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  // Section 15: dynamic tool discovery, exposed read-only. Only metadata —
  // never secrets — is returned (Section 18).
  app.get("/tools", async (_request, reply) => {
    reply.send(
      toolRegistry.list().map((t) => ({
        name: t.name,
        description: t.description,
        version: t.version,
        permissions: t.requiredPermissions,
        requiresApproval: t.requiresApproval,
        source: t.source,
      })),
    );
  });

  app.get("/plugins", async (_request, reply) => {
    reply.send(await listPlugins());
  });

  app.post("/plugins", async (request, reply) => {
    const body = loadPluginSchema.parse(request.body);
    reply.status(201).send(await loadPlugin(body.path));
  });

  app.delete("/plugins/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    await disablePlugin(name);
    reply.status(204).send();
  });

  app.post("/mcp/servers", async (request, reply) => {
    const body = connectMcpSchema.parse(request.body);
    reply.status(201).send(await mcpClientManager.connect(body));
  });

  app.get("/mcp/servers", async (_request, reply) => {
    reply.send(mcpClientManager.listConnected());
  });

  app.delete("/mcp/servers/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    await mcpClientManager.disconnect(id);
    reply.status(204).send();
  });
}
