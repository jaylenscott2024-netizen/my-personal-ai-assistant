import type { FastifyInstance } from "fastify";
import { prisma } from "../../database/client.js";
import { listProviders } from "../../ai/router.js";

// Section 84: Health Checks — backend, database, and AI providers.
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async (_request, reply) => {
    let dbHealthy = true;
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      dbHealthy = false;
    }

    const providers = await Promise.all(listProviders().map((p) => p.checkHealth()));

    const healthy = dbHealthy;
    reply.status(healthy ? 200 : 503).send({
      status: healthy ? "ok" : "degraded",
      database: dbHealthy ? "healthy" : "unhealthy",
      providers,
      timestamp: new Date().toISOString(),
    });
  });
}
