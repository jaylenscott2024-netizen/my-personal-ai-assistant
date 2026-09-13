import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../auth/middleware.js";
import { prisma } from "../../database/client.js";
import { listNotifications } from "../../notifications/notificationService.js";

// Section 89: activity stream, queryable as a REST log in addition to the
// live WebSocket feed (realtime/gateway.ts) — useful for a client that
// reconnects and needs to backfill what it missed.
export async function activityRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/activity", async (request, reply) => {
    const events = await prisma.activityEvent.findMany({
      where: { userId: request.user!.id },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    reply.send(events.map((e) => ({ ...e, payload: JSON.parse(e.payload) })));
  });

  app.get("/notifications", async (request, reply) => {
    reply.send(await listNotifications(request.user!.id));
  });
}
