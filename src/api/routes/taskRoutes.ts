import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../auth/middleware.js";
import { createTask, getTask, listTasks, cancelTask, setPlan } from "../../tasks/taskService.js";
import { runTask } from "../../tasks/taskRunner.js";
import { registerScheduledTask, unregisterScheduledTask } from "../../scheduler/scheduler.js";
import { prisma } from "../../database/client.js";
import { childLogger } from "../../config/logger.js";

const log = childLogger("api.tasks");

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
    await getTask(request.user!.id, id); // 404s before responding if the task doesn't exist/isn't the caller's
    const userId = request.user!.id;
    const role = request.user!.role;
    // Not awaited: starting a task kicks off an agent run that can take a
    // while (multiple model calls, tool executions) — the HTTP response
    // confirms the task was accepted, and progress is observable the same
    // way any other agent run's is (task.* events on the event bus, the
    // task's own status field). Errors are handled inside runTask itself
    // (it transitions the task to "failed" rather than throwing into the
    // void), so nothing here needs its own catch beyond a log line for the
    // genuinely unexpected case.
    runTask(userId, role, id).catch((err) => log.error({ err, taskId: id }, "unexpected error starting task"));
    reply.status(202).send();
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
