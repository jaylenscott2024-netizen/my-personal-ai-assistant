import type { FastifyInstance } from "fastify";
import { verifyAccessToken } from "../../auth/tokens.js";
import { isSessionActive } from "../../auth/authService.js";
import { prisma } from "../../database/client.js";
import { getUserSettings } from "../../settings/userSettingsService.js";
import { getDefaultProvider, getConfiguredProvider, defaultModelFor } from "../../ai/router.js";
import { createConversation } from "../../conversation/conversationService.js";
import { RealtimeVoiceSession } from "../../voice/realtimeSession.js";
import { NativeRealtimeSession } from "../../voice/realtime/nativeRealtimeSession.js";
import { getRealtimeAudioProvider } from "../../voice/realtime/realtimeAudioRegistry.js";
import { assembleSystemPrompt } from "../../context/instructions.js";
import { activationManager } from "../../activation/activationManager.js";
import { ActivationGate } from "../../voice/activationGate.js";
import { eventBus, type AgentEvent } from "../../events/eventBus.js";
import { childLogger } from "../../config/logger.js";
import type { VoiceMode } from "../../voice/types.js";

const log = childLogger("ws.voice");

const VALID_MODES: VoiceMode[] = ["speech_to_speech", "stt", "tts"];

// Section 1/10/11/14/88 of the Jarvis spec: the realtime voice transport,
// and the place activation (wake word / clap / push-to-talk) actually
// connects to the voice assistant.
//
// Mode selection (Section 88) is EXPLICIT and manual — the backend never
// infers which of the three modes a connection wants:
//
//   ?mode=speech_to_speech  NATIVE audio-to-audio (voice/realtime/). No
//                           VoiceProvider (STT or TTS) is used anywhere in
//                           this path — the realtime model itself hears
//                           and speaks. Binary frames are raw PCM in both
//                           directions at whatever sample rate the
//                           provider's onConnected message states.
//
//   ?mode=stt               Microphone audio in, transcript + the agent's
//                           TEXT reply out. synthesizeStream is never
//                           called — no audio is ever produced by this
//                           connection.
//
//   ?mode=tts                Typed text in (a `user_text` control
//                           message), synthesized speech out. Binary
//                           (microphone) frames are rejected outright —
//                           no STT provider is ever invoked.
//
// A connection that omits `mode` gets the pre-existing default behavior
// (the full STT -> agent -> streaming-TTS relay loop with barge-in) for
// backward compatibility with clients written before mode selection
// existed — this is the one case the backend still decides, and only
// because there is nothing to "infer": it is simply the documented
// default, unchanged from before this feature existed. A client that
// wants one of the three explicit modes must say so.
export async function realtimeVoiceRoute(app: FastifyInstance): Promise<void> {
  app.get("/ws/voice", { websocket: true }, async (socket, request) => {
    const query = request.query as { token?: string; conversationId?: string; provider?: string; model?: string; mode?: string };

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

    if (query.mode !== undefined && !VALID_MODES.includes(query.mode as VoiceMode)) {
      socket.close(4002, `Invalid mode "${query.mode}". Must be one of: ${VALID_MODES.join(", ")}.`);
      return;
    }
    const mode = query.mode as VoiceMode | undefined;

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

    if (mode === "speech_to_speech") {
      await runNativeSpeechToSpeech({ socket, send, userId, role, conversationId, settings, gate, activationMode: activationConfig.mode });
      return;
    }

    // stt, tts, and the legacy default all use the relay session — they
    // differ only in which side of it (mic input / synthesized output) is
    // actually wired up.
    await runRelaySession({ socket, send, userId, role, conversationId, aiProvider: aiProvider.id, aiModel, settings, gate, activationMode: activationConfig.mode, mode });
  });
}

interface CommonSessionArgs {
  socket: import("ws").WebSocket;
  send: (message: Record<string, unknown>) => void;
  userId: string;
  role: string;
  conversationId: string;
  settings: Awaited<ReturnType<typeof getUserSettings>>;
  gate: ActivationGate;
  activationMode: string;
}

async function runNativeSpeechToSpeech(args: CommonSessionArgs): Promise<void> {
  const { socket, send, userId, role, conversationId, settings, gate, activationMode } = args;

  let provider;
  try {
    provider = getRealtimeAudioProvider(settings.realtimeVoiceProvider);
  } catch (err) {
    send({ kind: "error", message: (err as Error).message });
    socket.close(4004, "Unknown realtime voice provider");
    return;
  }

  if (!(await provider.isConfigured(userId))) {
    send({ kind: "error", message: `Realtime voice provider "${provider.id}" is not configured.` });
    socket.close(4005, "Realtime voice provider not configured");
    return;
  }

  const instructions = assembleSystemPrompt({ assistantName: settings.assistantName });
  const capabilities = provider.getCapabilities();

  const session = new NativeRealtimeSession({
    userId,
    role,
    conversationId,
    provider,
    model: settings.realtimeVoiceModel,
    instructions,
    toolsEnabled: settings.realtimeVoiceToolsEnabled,
    onAudioChunk: (chunk) => {
      if (socket.readyState === socket.OPEN) socket.send(chunk, { binary: true });
    },
    onInputTranscript: (text) => send({ kind: "transcript", text }),
    onOutputTranscript: (text) => send({ kind: "assistant_text_delta", text }),
    onStateChange: (state) => {
      send({ kind: "state", state });
      if (state === "listening") gate.onTurnComplete();
    },
    onError: (message) => send({ kind: "error", message }),
  });

  try {
    await session.connect();
  } catch (err) {
    // The load-bearing honesty check: never silently fall back to the
    // STT/LLM/TTS relay when native audio-to-audio isn't actually
    // available. Report it and close.
    send({ kind: "error", message: (err as Error).message });
    socket.close(4006, "Failed to start native speech-to-speech session");
    return;
  }

  const unsubscribeActivation = eventBus.onEvent((event: AgentEvent) => {
    if (event.type !== "activation.detected" || event.userId !== userId) return;
    gate.trigger();
    send({ kind: "activated", method: (event.payload as { method: string }).method });
  });

  send({
    kind: "connected",
    mode: "speech_to_speech",
    conversationId,
    realtimeVoiceProvider: provider.id,
    inputSampleRate: capabilities.inputSampleRate,
    outputSampleRate: capabilities.outputSampleRate,
    activationMode,
  });

  socket.on("message", (raw: Buffer, isBinary: boolean) => {
    if (isBinary) {
      if (!gate.isOpen) {
        activationManager.feedAudioChunk(userId, raw);
        return;
      }
      session.feedAudio(raw);
      return;
    }
    try {
      const msg = JSON.parse(raw.toString("utf8"));
      if (msg.type === "interrupt") {
        session.interrupt();
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
    void session.close();
  });
}

async function runRelaySession(
  args: CommonSessionArgs & { aiProvider: string; aiModel: string; mode?: VoiceMode },
): Promise<void> {
  const { socket, send, userId, role, conversationId, aiProvider, aiModel, settings, gate, activationMode, mode } = args;

  // mode undefined => legacy default (speak replies); "stt" => never
  // speak; "tts" is handled by never feeding it microphone audio at all
  // (below), so speakReplies stays true — it needs the audio-out side.
  const speakReplies = mode !== "stt";

  const session = new RealtimeVoiceSession({
    userId,
    role,
    conversationId,
    aiProviderId: aiProvider,
    aiModel,
    voiceProviderId: settings.voiceProvider,
    sttProviderId: settings.sttProvider,
    voiceId: settings.voiceId ?? undefined,
    voiceModel: settings.voiceModel ?? undefined,
    speakReplies,
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

  const unsubscribeActivation = eventBus.onEvent((event: AgentEvent) => {
    if (event.type !== "activation.detected" || event.userId !== userId) return;
    gate.trigger();
    send({ kind: "activated", method: (event.payload as { method: string }).method });
  });

  send({
    kind: "connected",
    mode: mode ?? "speech_to_speech_relay_default",
    conversationId,
    aiProvider,
    aiModel,
    voiceProvider: settings.voiceProvider,
    activationMode,
  });

  socket.on("message", (raw: Buffer, isBinary: boolean) => {
    if (isBinary) {
      if (mode === "tts") {
        // No microphone audio is ever accepted in this mode — enforced
        // here, not just by convention, so a misbehaving client can't
        // sneak an STT path open by sending binary frames anyway.
        send({ kind: "error", message: "Microphone audio is not accepted in tts mode." });
        return;
      }
      if (!gate.isOpen) {
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
      } else if (msg.type === "user_text" && typeof msg.text === "string") {
        if (mode !== "tts") {
          send({ kind: "error", message: "user_text is only accepted in tts mode." });
          return;
        }
        session.respondToText(msg.text).catch((err) => {
          log.error({ err }, "failed to handle text-to-speech request");
          send({ kind: "error", message: (err as Error).message });
        });
      }
    } catch (err) {
      log.debug({ err }, "ignored malformed ws text message");
    }
  });

  socket.on("close", () => {
    unsubscribeActivation();
    session.close();
  });
}
