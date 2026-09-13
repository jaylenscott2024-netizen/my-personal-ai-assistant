import type { FastifyInstance } from "fastify";
import { verifyAccessToken } from "../../auth/tokens.js";
import { isSessionActive } from "../../auth/authService.js";
import { prisma } from "../../database/client.js";
import { getUserSettings } from "../../settings/userSettingsService.js";
import { getDefaultProvider, getConfiguredProvider, defaultModelFor } from "../../ai/router.js";
import { createConversation } from "../../conversation/conversationService.js";
import { RealtimeVoiceSession } from "../../voice/realtimeSession.js";
import { activationManager } from "../../activation/activationManager.js";
import { ActivationGate } from "../../voice/activationGate.js";
import { eventBus, type VolticEvent } from "../../events/eventBus.js";
import { childLogger } from "../../config/logger.js";

const log = childLogger("ws.voice");

// Section 1/10/11/14 of the Jarvis spec: the actual realtime speech-to-
// speech transport, and the place activation (wake word / clap /
// push-to-talk) actually connects to the voice assistant rather than
// just emitting an event nobody consumes.
//
// One RealtimeVoiceSession per connection. Binary WebSocket frames carry
// raw PCM16 mono 16kHz microphone audio in and MP3 audio out; text frames
// carry JSON control/status messages. Auth travels as a query param for
// the same reason as /ws (Section 47: browsers can't set a header on a
// WS upgrade).
//
// Activation gating (Section 11 — "activation should not automatically
// be permanently enabled without the user's choice"): in push-to-talk
// mode every audio frame reaches the session immediately (the client
// already only streams while the button is held). In wake-word or clap
// mode, incoming audio is *not* forwarded to the session's STT/agent
// pipeline until activation actually fires — clap audio is scored by the
// same real detector activation/clapDetector.ts uses elsewhere; a wake
// word is reported by the client/edge detector as a text message, per
// Section 87 (this backend doesn't run wake-word DSP itself). After one
// full utterance/response cycle, wake-word and clap modes re-arm —
// classic "say the wake word again" behavior — while push-to-talk never
// needs to.
export async function realtimeVoiceRoute(app: FastifyInstance): Promise<void> {
  app.get("/ws/voice", { websocket: true }, async (socket, request) => {
    const query = request.query as { token?: string; conversationId?: string; provider?: string; model?: string };

    if (!query.token) {
      socket.close(4001, "Missing token");
      return;
    }

    let userId: string;
    let role: string;
    try {
      const claims = verifyAccessToken(query.token);
      if (!(await isSessionActive(claims.sid))) throw new Error("session inactive");
      userId = claims.sub;
      role = claims.role;
    } catch {
      socket.close(4001, "Invalid or expired token");
      return;
    }

    const settings = await getUserSettings(userId);
    if (!activationManager.isHydrated(userId)) {
      activationManager.hydrate(userId, settings);
    }
    const activationConfig = activationManager.getConfig(userId);
    const gate = new ActivationGate(activationConfig.mode);

    let conversationId = query.conversationId;
    if (conversationId) {
      const owned = await prisma.conversation.findFirst({ where: { id: conversationId, userId } });
      if (!owned) {
        socket.close(4003, "Conversation not found");
        return;
      }
    } else {
      const conversation = await createConversation(userId, `Voice session ${new Date().toISOString()}`);
      conversationId = conversation.id;
    }

    const aiProvider = query.provider ? getConfiguredProvider(query.provider) : getDefaultProvider();
    const aiModel = query.model ?? defaultModelFor(aiProvider.id);

    const send = (message: Record<string, unknown>) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };

    const session = new RealtimeVoiceSession({
      userId,
      role,
      conversationId,
      aiProviderId: aiProvider.id,
      aiModel,
      voiceProviderId: settings.voiceProvider,
      sttProviderId: settings.sttProvider,
      voiceId: settings.voiceId ?? undefined,
      voiceModel: settings.voiceModel ?? undefined,
      onAudioChunk: (chunk) => {
        if (socket.readyState === socket.OPEN) socket.send(chunk, { binary: true });
      },
      onTranscript: (text) => send({ kind: "transcript", text }),
      onAssistantText: (text) => send({ kind: "assistant_text", text }),
      onStateChange: (state) => {
        send({ kind: "state", state });
        if (state === "listening") gate.onTurnComplete();
      },
      onError: (message) => send({ kind: "error", message }),
    });

    const unsubscribeActivation = eventBus.onEvent((event: VolticEvent) => {
      if (event.type !== "activation.detected" || event.userId !== userId) return;
      gate.trigger();
      send({ kind: "activated", method: (event.payload as { method: string }).method });
    });

    send({
      kind: "connected",
      conversationId,
      aiProvider: aiProvider.id,
      aiModel,
      voiceProvider: settings.voiceProvider,
      activationMode: activationConfig.mode,
    });

    socket.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) {
        if (!gate.isOpen) {
          // Not yet triggered — feed the clap detector (a no-op if the
          // configured mode isn't "clap") but don't hand audio to the
          // agent pipeline until activation actually fires.
          activationManager.feedAudioChunk(userId, raw);
          return;
        }
        session.feedAudio(raw);
        return;
      }
      try {
        const msg = JSON.parse(raw.toString("utf8"));
        if (msg.type === "interrupt") {
          session.interrupt("explicit");
        } else if (msg.type === "end_utterance") {
          session.endUtteranceNow();
        } else if (msg.type === "wake_word_detected" && typeof msg.phrase === "string") {
          activationManager.reportWakeWordDetected(userId, msg.phrase);
        }
      } catch (err) {
        log.debug({ err }, "ignored malformed ws text message");
      }
    });

    socket.on("close", () => {
      unsubscribeActivation();
      session.close();
    });
  });
}
