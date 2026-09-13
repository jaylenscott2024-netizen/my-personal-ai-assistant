import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../auth/middleware.js";
import { createTask, getTask, listTasks, cancelTask, setPlan, transitionTask } from "../../tasks/taskService.js";
import { registerScheduledTask, unregisterScheduledTask } from "../../scheduler/scheduler.js";
import { prisma } from "../../database/client.js";

const createTaskSchema = z.object({ title: z.string().min(1), goal: z.string().min(1), conversationId: z.string().optional(), plan: z.array(z.string()).optional() });
const scheduleTaskSchema = z.object({ name: z.string(), cronExpression: z.string(), title: z.string(), goal: z.string() });

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.post("/tasks", async (request, reply) => {
    const body = createTaskSchema.parse(request.body);
    const task = await createTask(request.user!.id, body.title, body.goal, body.conversationId);
    if (body.plan?.length) await setPlan(task.id, body.plan);
    reply.status(201).send(task);
  });

  app.get("/tasks", async (request, reply) => {
    reply.send(await listTasks(request.user!.id));
  });

  app.get("/tasks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    reply.send(await getTask(request.user!.id, id));
  });

  app.post("/tasks/:id/start", async (request, reply) => {
    const { id } = request.params as { id: string };
    await getTask(request.user!.id, id);
    await transitionTask(id, "running", request.user!.id);
    reply.status(204).send();
  });

  app.post("/tasks/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    await cancelTask(request.user!.id, id);
    reply.status(204).send();
  });

  app.post("/scheduled-tasks", async (request, reply) => {
    const body = scheduleTaskSchema.parse(request.body);
    const record = await registerScheduledTask(request.user!.id, body.name, body.cronExpression, { title: body.title, goal: body.goal });
    reply.status(201).send(record);
  });

  app.get("/scheduled-tasks", async (request, reply) => {
    reply.send(await prisma.scheduledTask.findMany({ where: { userId: request.user!.id } }));
  });

  app.delete("/scheduled-tasks/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    await unregisterScheduledTask(request.user!.id, id);
    reply.status(204).send();
  });
}
