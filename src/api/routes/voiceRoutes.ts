import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";
import { requireAuth } from "../../auth/middleware.js";
import { getVoiceProvider, listVoiceProviders } from "../../voice/voiceRegistry.js";
import { eventBus } from "../../events/eventBus.js";
import { getUserSettings } from "../../settings/userSettingsService.js";

const transcribeSchema = z.object({ provider: z.string().optional(), audioBase64: z.string(), mimeType: z.string() });
const synthesizeSchema = z.object({
  provider: z.string().optional(),
  text: z.string().min(1),
  voiceId: z.string().optional(),
  model: z.string().optional(),
});

// Section 2/28/29/88: voice mode is always explicit in the request — the
// backend never infers STT vs TTS vs realtime from the payload shape.
// Provider/voice/model default to the user's persisted Settings
// (Section 2: "the user must be able to select ElevenLabs in Settings")
// but can be overridden per call.
export async function voiceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/voice/providers", async (request, reply) => {
    const providers = await Promise.all(
      listVoiceProviders().map(async (p) => ({ id: p.id, configured: await p.isConfigured(request.user!.id) })),
    );
    reply.send(providers);
  });

  app.get("/voice/providers/:id/voices", async (request, reply) => {
    const { id } = request.params as { id: string };
    reply.send(await getVoiceProvider(id).listVoices(request.user!.id));
  });

  app.post("/voice/transcribe", async (request, reply) => {
    const body = transcribeSchema.parse(request.body);
    const settings = await getUserSettings(request.user!.id);
    const providerId = body.provider ?? settings.sttProvider;

    eventBus.emitEvent("voice.started", { mode: "stt" }, request.user!.id);
    const result = await getVoiceProvider(providerId).transcribe(Buffer.from(body.audioBase64, "base64"), body.mimeType, {
      userId: request.user!.id,
    });
    eventBus.emitEvent("voice.stopped", { mode: "stt" }, request.user!.id);
    reply.send(result);
  });

  app.post("/voice/synthesize", async (request, reply) => {
    const body = synthesizeSchema.parse(request.body);
    const settings = await getUserSettings(request.user!.id);
    const providerId = body.provider ?? settings.voiceProvider;

    eventBus.emitEvent("voice.started", { mode: "tts" }, request.user!.id);
    const result = await getVoiceProvider(providerId).synthesize(body.text, {
      voiceId: body.voiceId ?? settings.voiceId ?? undefined,
      model: body.model ?? settings.voiceModel ?? undefined,
      userId: request.user!.id,
    });
    eventBus.emitEvent("voice.stopped", { mode: "tts" }, request.user!.id);
    reply.send({ audioBase64: result.audio.toString("base64"), mimeType: result.mimeType });
  });

  // Real chunked-transfer streaming variant: the response begins flowing
  // to the client as soon as the provider's first audio chunk arrives,
  // rather than waiting for the complete synthesis (Section 1/30).
  app.post("/voice/synthesize/stream", async (request, reply) => {
    const body = synthesizeSchema.parse(request.body);
    const settings = await getUserSettings(request.user!.id);
    const providerId = body.provider ?? settings.voiceProvider;
    const provider = getVoiceProvider(providerId);

    eventBus.emitEvent("voice.started", { mode: "tts_stream" }, request.user!.id);
    const generator = provider.synthesizeStream(body.text, {
      voiceId: body.voiceId ?? settings.voiceId ?? undefined,
      model: body.model ?? settings.voiceModel ?? undefined,
      userId: request.user!.id,
    });

    reply.raw.setHeader("content-type", "audio/mpeg");
    reply.raw.setHeader("transfer-encoding", "chunked");
    const nodeStream = Readable.from(generator);
    nodeStream.on("end", () => eventBus.emitEvent("voice.stopped", { mode: "tts_stream" }, request.user!.id));
    return reply.send(nodeStream);
  });
}
