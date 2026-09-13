import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../auth/middleware.js";
import { activationManager } from "../../activation/activationManager.js";
import { getUserSettings, updateUserSettings } from "../../settings/userSettingsService.js";
import { eyesService } from "../../eyes/eyesService.js";

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

const eyesUpdateSchema = z.object({
  eyesEnabled: z.boolean().optional(),
  eyesMode: z.enum(["structural_only", "structural_plus_visual"]).optional(),
  eyesAttentionMode: z.enum(["auto", "manual"]).optional(),
  eyesUpdateLatencyPolicy: z.enum(["realtime", "balanced", "low_power"]).optional(),
  /** AI provider ids allowed to receive ANY visual context — empty by
   *  default, so no provider gets it until explicitly opted in here. */
  eyesAllowedProviders: z.array(z.string()).optional(),
  /** Bounds on the in-memory temporal visual buffer. Nothing it holds is
   *  ever written to disk; these control how much recent activity Jarvis
   *  keeps in RAM. */
  eyesHistorySeconds: z.number().int().min(5).max(1800).optional(),
  eyesMaxKeyframes: z.number().int().min(0).max(120).optional(),
  /** Continuous capture rates ("local Eyes FPS") — independent of any AI
   *  provider's transport rate. 60 is a documented ceiling, never an
   *  assumption the hardware can sustain it. */
  eyesLocalCaptureFps: z.number().int().min(1).max(60).optional(),
  eyesLocalProcessingFps: z.number().int().min(1).max(60).optional(),
  eyesMaxBufferedFrames: z.number().int().min(1).max(600).optional(),
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

  app.get("/settings/eyes", async (request, reply) => {
    reply.send(await getUserSettings(request.user!.id));
  });

  // Section 27/28: this is where a settings change actually takes effect —
  // enabling Eyes starts the engine right away (surfacing a platform's
  // "not supported" honestly instead of silently leaving eyesEnabled=true
  // with nothing actually running), disabling it stops the engine, and a
  // latency-policy change is pushed into any already-running engine.
  app.patch("/settings/eyes", async (request, reply) => {
    const body = eyesUpdateSchema.parse(request.body);
    await updateUserSettings(request.user!.id, body);

    if (body.eyesEnabled === true) {
      try {
        await eyesService.ensureStarted(request.user!.id);
      } catch (err) {
        // Never leave eyesEnabled persisted as true when it never actually
        // started (Section: "report the limitation clearly" — not a
        // silent, misleading half-enabled state).
        await updateUserSettings(request.user!.id, { eyesEnabled: false });
        throw err;
      }
    } else if (body.eyesEnabled === false) {
      await eyesService.stop(request.user!.id);
    }

    // Push every Eyes setting into the live engine so changes take effect
    // immediately, without restarting it (which would throw away the
    // visual history built up so far).
    const current = await getUserSettings(request.user!.id);
    await eyesService.applySettings(request.user!.id, current);

    reply.send(current);
  });

  app.post("/settings/activation/wake-word-detected", async (request, reply) => {
    const { phrase } = z.object({ phrase: z.string() }).parse(request.body);
    activationManager.reportWakeWordDetected(request.user!.id, phrase);
    reply.status(204).send();
  });
}
