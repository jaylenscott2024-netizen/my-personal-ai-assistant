import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../auth/middleware.js";
import { activationManager } from "../../activation/activationManager.js";
import { getUserSettings, updateUserSettings } from "../../settings/userSettingsService.js";

const activationUpdateSchema = z.object({
  activationMode: z.enum(["push_to_talk", "wake_word", "clap", "disabled"]).optional(),
  wakeWordPhrase: z.string().min(1).optional(),
  clapSensitivity: z.number().min(1).max(10).optional(),
  clapPattern: z.enum(["single", "double", "triple"]).optional(),
  clapCooldownMs: z.number().int().positive().optional(),
});

const voiceUpdateSchema = z.object({
  voiceProvider: z.string().optional(),
  voiceId: z.string().nullable().optional(),
  voiceModel: z.string().nullable().optional(),
  sttProvider: z.string().optional(),
});

const identityUpdateSchema = z.object({
  assistantName: z.string().min(1).max(64).optional(),
});

// Section 11/12/28/29/87/88: activation, voice, and identity settings are
// explicit, per-user, and persistent (Section 11: "make activation
// settings persistent" — the old activationManager-only config reset on
// every restart; it's now backed by settings/userSettingsService.ts and
// this route both reads and writes through it).
export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/settings", async (request, reply) => {
    reply.send(await getUserSettings(request.user!.id));
  });

  app.get("/settings/activation", async (request, reply) => {
    const settings = await getUserSettings(request.user!.id);
    reply.send(settings);
  });

  app.patch("/settings/activation", async (request, reply) => {
    const body = activationUpdateSchema.parse(request.body);
    const settings = await updateUserSettings(request.user!.id, body);
    // Push the change into the live in-memory activation manager
    // immediately, so a connected client doesn't need to reconnect for a
    // setting change to take effect.
    activationManager.hydrate(request.user!.id, settings);
    reply.send(settings);
  });

  app.patch("/settings/voice", async (request, reply) => {
    const body = voiceUpdateSchema.parse(request.body);
    reply.send(await updateUserSettings(request.user!.id, body));
  });

  app.patch("/settings/identity", async (request, reply) => {
    const body = identityUpdateSchema.parse(request.body);
    reply.send(await updateUserSettings(request.user!.id, body));
  });

  app.post("/settings/activation/wake-word-detected", async (request, reply) => {
    const { phrase } = z.object({ phrase: z.string() }).parse(request.body);
    activationManager.reportWakeWordDetected(request.user!.id, phrase);
    reply.status(204).send();
  });
}
