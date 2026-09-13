import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../auth/middleware.js";
import { listProviders } from "../../ai/router.js";

// Section 46/84: /providers and /models plus health checks.
export async function providerRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/providers", async (_request, reply) => {
    const providers = listProviders();
    reply.send(
      providers.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        configured: p.isConfigured(),
        models: p.listModels(),
      })),
    );
  });

  app.get("/providers/:id/health", async (request, reply) => {
    const { id } = request.params as { id: string };
    const providers = listProviders();
    const provider = providers.find((p) => p.id === id);
    if (!provider) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Unknown provider." } });
    reply.send(await provider.checkHealth());
  });
}
