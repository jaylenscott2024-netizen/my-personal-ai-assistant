import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../auth/middleware.js";
import { activationManager } from "../../activation/activationManager.js";

const activationConfigSchema = z.object({
  wakeWord: z.object({ enabled: z.boolean().optional(), phrase: z.string().optional() }).optional(),
  clap: z
    .object({
      enabled: z.boolean().optional(),
      sensitivity: z.number().min(1).max(10).optional(),
      pattern: z.enum(["single", "double", "triple"]).optional(),
      cooldownMs: z.number().int().positive().optional(),
      sampleRate: z.number().int().positive().optional(),
    })
    .optional(),
});

// Section 31/32/87/88: activation and voice-mode settings are explicit,
// per-user configuration — never inferred automatically.
export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/settings/activation", async (request, reply) => {
    reply.send(activationManager.getConfig(request.user!.id));
  });

  app.patch("/settings/activation", async (request, reply) => {
    const body = activationConfigSchema.parse(request.body);
    reply.send(activationManager.setConfig(request.user!.id, body as never));
  });

  app.post("/settings/activation/wake-word-detected", async (request, reply) => {
    const { phrase } = z.object({ phrase: z.string() }).parse(request.body);
    activationManager.reportWakeWordDetected(request.user!.id, phrase);
    reply.status(204).send();
  });
}
