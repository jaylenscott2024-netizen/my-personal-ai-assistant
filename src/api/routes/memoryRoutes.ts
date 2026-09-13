import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../auth/middleware.js";
import { createMemory, updateMemory, deleteMemory, listMemory, retrieveRelevantMemory } from "../../memory/memoryService.js";

const createSchema = z.object({
  category: z.enum(["preference", "project", "task", "fact", "instruction"]),
  content: z.string().min(1),
  key: z.string().optional(),
  importance: z.number().int().min(1).max(5).optional(),
  provenance: z.enum(["user_stated", "inferred", "task_result"]),
  scope: z.string().optional(),
});

const updateSchema = z.object({
  content: z.string().optional(),
  importance: z.number().int().min(1).max(5).optional(),
  scope: z.string().optional(),
  disabled: z.boolean().optional(),
});

// Section 22: full user-controlled CRUD over memory, including disable.
export async function memoryRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.post("/memory", async (request, reply) => {
    const body = createSchema.parse(request.body);
    reply.status(201).send(await createMemory({ userId: request.user!.id, ...body }));
  });

  app.get("/memory", async (request, reply) => {
    const { category } = request.query as { category?: string };
    reply.send(await listMemory(request.user!.id, category as never));
  });

  app.get("/memory/relevant", async (request, reply) => {
    const { query, scope } = request.query as { query?: string; scope?: string };
    reply.send(await retrieveRelevantMemory(request.user!.id, { query, scope }));
  });

  app.patch("/memory/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = updateSchema.parse(request.body);
    reply.send(await updateMemory(request.user!.id, id, body));
  });

  app.delete("/memory/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    await deleteMemory(request.user!.id, id);
    reply.status(204).send();
  });
}
