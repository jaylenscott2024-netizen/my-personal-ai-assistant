import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../auth/middleware.js";
import { listApprovals, getApproval, resolveApproval } from "../../approvals/approvalService.js";

const resolveSchema = z.object({ decision: z.enum(["approved", "denied"]), reason: z.string().optional() });

export async function approvalRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/approvals", async (request, reply) => {
    const { status } = request.query as { status?: string };
    reply.send(await listApprovals(request.user!.id, status));
  });

  app.get("/approvals/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    reply.send(await getApproval(request.user!.id, id));
  });

  app.post("/approvals/:id/resolve", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = resolveSchema.parse(request.body);
    reply.send(await resolveApproval(request.user!.id, id, body.decision, body.reason));
  });
}
