import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth, assertOwnsResource } from "../../auth/middleware.js";
import {
  createConversation,
  getConversation,
  listConversations,
  getHistory,
} from "../../conversation/conversationService.js";
import { runAgent, resumeAgentRun } from "../../agent/orchestrator.js";
import { getDefaultProvider, getConfiguredProvider, defaultModelFor } from "../../ai/router.js";
import { prisma } from "../../database/client.js";
import { NotFoundError } from "../../utils/errors.js";
import { eventBus, type AgentEvent } from "../../events/eventBus.js";
import { abortById } from "../../tasks/taskService.js";

const createConversationSchema = z.object({
  title: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
});

const sendMessageSchema = z.object({
  message: z.string().min(1),
  provider: z.string().optional(),
  model: z.string().optional(),
});

export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.post("/conversations", async (request, reply) => {
    const body = createConversationSchema.parse(request.body);
    const provider = body.provider ? getConfiguredProvider(body.provider) : getDefaultProvider();
    const model = body.model ?? defaultModelFor(provider.id);
    const conversation = await createConversation(request.user!.id, body.title, provider.id, model);
    reply.status(201).send(conversation);
  });

  app.get("/conversations", async (request, reply) => {
    reply.send(await listConversations(request.user!.id));
  });

  app.get("/conversations/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const conversation = await getConversation(request.user!.id, id);
    reply.send(conversation);
  });

  app.get("/conversations/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    await getConversation(request.user!.id, id); // ownership check
    reply.send(await getHistory(id, 200));
  });

  // Section 9: this is the primary entrypoint into the agent orchestrator.
  app.post("/conversations/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = sendMessageSchema.parse(request.body);
    const conversation = await getConversation(request.user!.id, id);

    const providerId = body.provider ?? conversation.provider ?? getDefaultProvider().id;
    const model = body.model ?? conversation.model ?? defaultModelFor(providerId);

    const outcome = await runAgent({
      userId: request.user!.id,
      role: request.user!.role,
      conversationId: id,
      providerId,
      model,
      userMessage: body.message,
    });
    reply.send(outcome);
  });

  // Section 14: streaming variant of the same entrypoint — Server-Sent
  // Events carrying incremental text deltas and tool activity as the
  // agent orchestrator produces them, instead of waiting for the whole
  // turn to finish. Uses the exact same runAgent()/permission/approval
  // pipeline as the non-streaming route above; only the transport differs.
  app.post("/conversations/:id/messages/stream", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = sendMessageSchema.parse(request.body);
    const conversation = await getConversation(request.user!.id, id);

    const providerId = body.provider ?? conversation.provider ?? getDefaultProvider().id;
    const model = body.model ?? conversation.model ?? defaultModelFor(providerId);

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const sendEvent = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let agentRunId: string | undefined;
    const unsubscribe = eventBus.onEvent((evt: AgentEvent) => {
      if (!agentRunId) return;
      const payload = evt.payload as Record<string, unknown>;
      if (payload.agentRunId !== agentRunId) return;

      if (evt.type === "message.delta") sendEvent("delta", payload);
      else if (evt.type === "tool.started" || evt.type === "tool.completed" || evt.type === "tool.failed") {
        sendEvent("tool", { kind: evt.type, ...payload });
      } else if (evt.type === "agent.thinking") sendEvent("thinking", payload);
    });

    // If the client disconnects mid-stream, cancel the in-flight run
    // rather than letting it keep consuming provider/tool resources for
    // an answer nobody will see.
    request.raw.on("close", () => {
      if (agentRunId) abortById(agentRunId);
    });

    try {
      const outcome = await runAgent({
        userId: request.user!.id,
        role: request.user!.role,
        conversationId: id,
        providerId,
        model,
        userMessage: body.message,
        stream: true,
        onAgentRunCreated: (runId) => {
          agentRunId = runId;
          sendEvent("run", { agentRunId: runId });
        },
      });
      sendEvent("done", outcome);
    } catch (err) {
      sendEvent("error", { message: (err as Error).message });
    } finally {
      unsubscribe();
      reply.raw.end();
    }
  });

  app.post("/conversations/:id/agent-runs/:runId/resume", async (request, reply) => {
    const { id, runId } = request.params as { id: string; runId: string };
    await getConversation(request.user!.id, id);
    const run = await prisma.agentRun.findUnique({ where: { id: runId } });
    if (!run || run.conversationId !== id) throw new NotFoundError("Agent run not found.");
    assertOwnsResource(request, request.user!.id);
    const outcome = await resumeAgentRun(runId, request.user!.id, request.user!.role);
    reply.send(outcome);
  });
}
