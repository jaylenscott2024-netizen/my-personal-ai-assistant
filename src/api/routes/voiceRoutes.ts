import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../auth/middleware.js";
import { getVoiceProvider, listVoiceProviders } from "../../voice/voiceRegistry.js";
import { eventBus } from "../../events/eventBus.js";

const transcribeSchema = z.object({ provider: z.string(), audioBase64: z.string(), mimeType: z.string() });
const synthesizeSchema = z.object({ provider: z.string(), text: z.string().min(1), voiceId: z.string().optional() });

// Section 28/29/88: voice mode is always explicit in the request — the
// backend never infers STT vs TTS vs realtime from the payload shape.
export async function voiceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/voice/providers", async (_request, reply) => {
    reply.send(listVoiceProviders().map((p) => ({ id: p.id, configured: p.isConfigured() })));
  });

  app.get("/voice/providers/:id/voices", async (request, reply) => {
    const { id } = request.params as { id: string };
    reply.send(await getVoiceProvider(id).listVoices());
  });

  app.post("/voice/transcribe", async (request, reply) => {
    const body = transcribeSchema.parse(request.body);
    eventBus.emitEvent("voice.started", { mode: "stt" }, request.user!.id);
    const result = await getVoiceProvider(body.provider).transcribe(Buffer.from(body.audioBase64, "base64"), body.mimeType);
    eventBus.emitEvent("voice.stopped", { mode: "stt" }, request.user!.id);
    reply.send(result);
  });

  app.post("/voice/synthesize", async (request, reply) => {
    const body = synthesizeSchema.parse(request.body);
    eventBus.emitEvent("voice.started", { mode: "tts" }, request.user!.id);
    const result = await getVoiceProvider(body.provider).synthesize(body.text, body.voiceId);
    eventBus.emitEvent("voice.stopped", { mode: "tts" }, request.user!.id);
    reply.send({ audioBase64: result.audio.toString("base64"), mimeType: result.mimeType });
  });
}
