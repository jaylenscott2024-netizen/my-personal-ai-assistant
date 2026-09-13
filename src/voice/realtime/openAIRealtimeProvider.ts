import { WebSocket } from "ws";
import { env } from "../../config/env.js";
import { childLogger } from "../../config/logger.js";
import { ProviderError } from "../../utils/errors.js";
import { resolveApiKey } from "../credentialResolution.js";
import type {
  RealtimeAudioCapabilities,
  RealtimeAudioEvent,
  RealtimeAudioListener,
  RealtimeAudioProvider,
  RealtimeAudioSession,
  RealtimeAudioSessionOptions,
} from "./realtimeAudioProvider.js";

const log = childLogger("voice.realtime.openai");

const REALTIME_URL = "wss://api.openai.com/v1/realtime";

// OpenAI's Realtime API: genuinely audio-in / audio-out over one
// WebSocket. Microphone PCM goes up, generated speech comes back, and the
// model itself hears and produces prosody — there is no transcription step
// in the middle. That is what makes this the native speech-to-speech path
// rather than a faster STT -> LLM -> TTS pipeline.
//
// ─── VERIFICATION STATUS ────────────────────────────────────────────────
// IMPLEMENTED BUT NOT LIVE-VERIFIED. This was written without a live
// session: no OPENAI_API_KEY is available here, and the primary protocol
// references (developers.openai.com, learn.microsoft.com) are blocked by
// this environment's egress proxy, so the message shapes below come from
// secondary sources rather than a doc page actually read end to end.
//
// One consequence is worth being explicit about, because it changed
// between the beta and GA revisions of this API: several event names were
// renamed (`response.audio.delta` became `response.output_audio.delta`,
// and session audio config moved from flat `session.input_audio_format`
// into a nested `session.audio.input.format`). Sources disagree about
// which spelling is current. Rather than betting the feature on one
// guess, the receive path accepts BOTH spellings, and the session config
// sends the GA nested shape. Accepting both costs nothing and means a
// naming difference degrades into "one branch is dead code" instead of
// "Jarvis is silent and nobody knows why".
//
// What still requires a real key to confirm: that the session handshake
// is accepted, that audio actually flows in both directions, measured
// latency, and that tool calls round-trip. See VOICE.md.
export class OpenAIRealtimeProvider implements RealtimeAudioProvider {
  readonly id = "openai-realtime";

  getCapabilities(): RealtimeAudioCapabilities {
    return {
      nativeSpeechToSpeech: true,
      serverSideVad: true,
      interruptible: true,
      toolCalling: true,
      transcripts: true,
      // The Realtime API works in 24kHz mono PCM16 in both directions.
      inputSampleRate: 24_000,
      outputSampleRate: 24_000,
      // Deliberately NOT claiming pitch/rate/emphasis knobs: this API
      // exposes voice selection and natural-language direction through
      // `instructions`, not numeric prosody parameters. The model varies
      // its own delivery from conversational context, which is a real and
      // better source of expressiveness — but it is not something Jarvis
      // dials, so it is not listed as a control.
      expressiveControls: ["voice", "instructions"],
      detail: "Native audio-to-audio. Prosody emerges from the model rather than from explicit parameters.",
    };
  }

  async isConfigured(userId?: string): Promise<boolean> {
    try {
      await resolveApiKey(userId, "openai", env.OPENAI_API_KEY, "");
      return true;
    } catch {
      return false;
    }
  }

  async connect(options: RealtimeAudioSessionOptions): Promise<RealtimeAudioSession> {
    const key = await resolveApiKey(
      options.userId,
      "openai",
      env.OPENAI_API_KEY,
      "OpenAI Realtime speech-to-speech (an OPENAI_API_KEY or a saved credential)",
    );
    const session = new OpenAIRealtimeSession(key, options);
    await session.open();
    return session;
  }
}

class OpenAIRealtimeSession implements RealtimeAudioSession {
  readonly providerId = "openai-realtime";
  private socket: WebSocket | null = null;
  private listeners: RealtimeAudioListener[] = [];
  private open_ = false;
  private closing = false;
  // Audio that arrived before the socket finished opening. The microphone
  // cannot be told to wait, so early chunks are held rather than dropped.
  private pendingAudio: Buffer[] = [];
  private static readonly MAX_PENDING_CHUNKS = 100;

  constructor(
    private readonly apiKey: string,
    private readonly options: RealtimeAudioSessionOptions,
  ) {}

  get isOpen(): boolean {
    return this.open_;
  }

  async open(): Promise<void> {
    const url = `${REALTIME_URL}?model=${encodeURIComponent(this.options.model)}`;
    const socket = new WebSocket(url, {
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        // Required by the Realtime API for WebSocket connections.
        "OpenAI-Beta": "realtime=v1",
      },
    });
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        socket.off("error", onError);
        resolve();
      };
      const onError = (err: Error) => {
        socket.off("open", onOpen);
        reject(new ProviderError(`OpenAI Realtime connection failed: ${err.message}`, true));
      };
      socket.once("open", onOpen);
      socket.once("error", onError);
    });

    socket.on("message", (raw: Buffer) => this.handleMessage(raw));
    socket.on("close", (code: number, reason: Buffer) => {
      this.open_ = false;
      this.emit({ type: "closed", reason: `${code} ${reason.toString("utf8")}`.trim() });
    });
    socket.on("error", (err: Error) => {
      // A socket error after open is not necessarily fatal to the
      // conversation (the close handler decides), so report it without
      // tearing anything down here.
      this.emit({ type: "error", message: err.message, fatal: false });
    });

    this.open_ = true;
    this.configureSession();
    this.flushPendingAudio();
  }

  private configureSession(): void {
    // GA nested shape. `turn_detection` on the input is what gives server-
    // side VAD and, with it, barge-in that does not depend on Jarvis
    // endpointing speech itself.
    const tools = (this.options.tools ?? []).map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));

    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: this.options.instructions,
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            turn_detection: { type: "server_vad" },
            transcription: { model: "whisper-1" },
          },
          output: {
            format: { type: "audio/pcm", rate: 24_000 },
            ...(this.options.voice ? { voice: this.options.voice } : {}),
          },
        },
        ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
      },
    });
  }

  private handleMessage(raw: Buffer): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch {
      return; // a frame we cannot parse is not worth tearing the session down over
    }

    const type = String(msg.type ?? "");

    switch (type) {
      case "session.created":
      case "session.updated":
        this.emit({ type: "session_ready" });
        break;

      // Both spellings accepted deliberately — see the verification note
      // at the top of this file.
      case "response.output_audio.delta":
      case "response.audio.delta": {
        const b64 = typeof msg.delta === "string" ? msg.delta : "";
        if (b64) this.emit({ type: "audio_delta", audio: Buffer.from(b64, "base64") });
        break;
      }

      case "response.output_audio.done":
      case "response.audio.done":
        this.emit({ type: "audio_done" });
        break;

      case "input_audio_buffer.speech_started":
        // Server VAD heard the user start talking. This is the barge-in
        // trigger: the owner should stop playback immediately.
        this.emit({ type: "speech_started" });
        break;

      case "input_audio_buffer.speech_stopped":
        this.emit({ type: "speech_stopped" });
        break;

      case "conversation.item.input_audio_transcription.completed": {
        const text = typeof msg.transcript === "string" ? msg.transcript : "";
        if (text) this.emit({ type: "input_transcript", text });
        break;
      }

      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta": {
        const text = typeof msg.delta === "string" ? msg.delta : "";
        if (text) this.emit({ type: "output_transcript_delta", text });
        break;
      }

      case "response.function_call_arguments.done": {
        const callId = typeof msg.call_id === "string" ? msg.call_id : "";
        const name = typeof msg.name === "string" ? msg.name : "";
        if (!callId || !name) break;
        let args: Record<string, unknown> = {};
        try {
          args = msg.arguments ? (JSON.parse(String(msg.arguments)) as Record<string, unknown>) : {};
        } catch {
          // Malformed arguments are surfaced to the tool layer as empty
          // rather than guessed at; schema validation there will reject.
          args = {};
        }
        this.emit({ type: "tool_call", callId, name, arguments: args });
        break;
      }

      case "response.done":
        this.emit({ type: "response_done" });
        break;

      case "error": {
        const err = (msg.error ?? {}) as Record<string, unknown>;
        this.emit({ type: "error", message: String(err.message ?? "Unknown Realtime API error"), fatal: false });
        break;
      }

      default:
        break; // unknown event types are ignored, not fatal
    }
  }

  sendAudio(pcm16: Buffer): void {
    if (!this.open_) {
      // Bounded: if the socket never opens, this must not grow without
      // limit. Oldest chunks go first — stale audio is the least useful.
      this.pendingAudio.push(pcm16);
      if (this.pendingAudio.length > OpenAIRealtimeSession.MAX_PENDING_CHUNKS) this.pendingAudio.shift();
      return;
    }
    this.send({ type: "input_audio_buffer.append", audio: pcm16.toString("base64") });
  }

  private flushPendingAudio(): void {
    const queued = this.pendingAudio;
    this.pendingAudio = [];
    for (const chunk of queued) this.sendAudio(chunk);
  }

  commitInput(): void {
    if (!this.open_) return;
    // Only meaningful with server VAD disabled (push-to-talk). Harmless
    // otherwise: the provider is already deciding turn boundaries.
    this.send({ type: "input_audio_buffer.commit" });
    this.send({ type: "response.create" });
  }

  interrupt(): void {
    if (!this.open_) return;
    // Stops generation server-side so the model does not keep producing
    // audio into a conversation that has already moved on.
    this.send({ type: "response.cancel" });
  }

  submitToolResult(callId: string, result: unknown): void {
    if (!this.open_) return;
    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: typeof result === "string" ? result : JSON.stringify(result),
      },
    });
    // The model needs a nudge to continue speaking after a tool result.
    this.send({ type: "response.create" });
  }

  subscribe(listener: RealtimeAudioListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.open_ = false;
    this.pendingAudio = [];
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      socket.close(1000, "session ended");
    } catch {
      socket.terminate();
    }
    this.listeners = [];
  }

  private send(payload: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch (err) {
      log.warn({ err }, "failed to send realtime frame");
    }
  }

  private emit(event: RealtimeAudioEvent): void {
    // Never let one bad listener break the audio path.
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        log.warn({ err }, "realtime audio listener threw");
      }
    }
  }
}
