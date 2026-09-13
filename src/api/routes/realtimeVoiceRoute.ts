import type { FastifyInstance } from "fastify";
import { verifyAccessToken } from "../../auth/tokens.js";
import { isSessionActive } from "../../auth/authService.js";
import { prisma } from "../../database/client.js";
import { getUserSettings } from "../../settings/userSettingsService.js";
import { getDefaultProvider, getConfiguredProvider, defaultModelFor } from "../../ai/router.js";
import { createConversation } from "../../conversation/conversationService.js";
import { RealtimeVoiceSession } from "../../voice/realtimeSession.js";
import { childLogger } from "../../config/logger.js";

const log = childLogger("ws.voice");

// Section 1/10/14 of the Jarvis spec: the actual realtime speech-to-speech
// transport. One RealtimeVoiceSession per connection. Binary WebSocket
// frames carry raw PCM16 mono 16kHz microphone audio in and MP3 audio out;
// text frames carry JSON control/status messages. Auth travels as a query
// param for the same reason as /ws (Section 47: browsers can't set a
// header on a WS upgrade).
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
      onStateChange: (state) => send({ kind: "state", state }),
      onError: (message) => send({ kind: "error", message }),
    });

    send({ kind: "connected", conversationId, aiProvider: aiProvider.id, aiModel, voiceProvider: settings.voiceProvider });

    socket.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) {
        session.feedAudio(raw);
        return;
      }
      try {
        const msg = JSON.parse(raw.toString("utf8"));
        if (msg.type === "interrupt") {
          session.interrupt("explicit");
        } else if (msg.type === "end_utterance") {
          session.endUtteranceNow();
        }
      } catch (err) {
        log.debug({ err }, "ignored malformed ws text message");
      }
    });

    socket.on("close", () => session.close());
  });
}
