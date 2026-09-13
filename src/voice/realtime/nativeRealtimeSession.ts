import { prisma } from "../../database/client.js";
import { childLogger } from "../../config/logger.js";
import { eventBus } from "../../events/eventBus.js";
import { toolRegistry } from "../../tools/registry.js";
import { executeToolCall } from "../../agent/orchestrator.js";
import { appendMessage } from "../../conversation/conversationService.js";
import type { RealtimeAudioProvider, RealtimeAudioSession, RealtimeToolDefinition } from "./realtimeAudioProvider.js";

const log = childLogger("voice.realtime.native");

export type NativeRealtimeState = "connecting" | "listening" | "speaking" | "closed";

export interface NativeRealtimeSessionOptions {
  userId: string;
  role: string;
  conversationId: string;
  provider: RealtimeAudioProvider;
  model: string;
  instructions: string;
  voice?: string;
  /** Whether the model may call tools during this conversation. When
   *  false, the session is conversation-only — a deliberate, explicit
   *  choice rather than a silent capability gap. */
  toolsEnabled: boolean;
  onAudioChunk: (chunk: Buffer) => void;
  onInputTranscript: (text: string) => void;
  onOutputTranscript: (text: string) => void;
  onStateChange: (state: NativeRealtimeState) => void;
  onError: (message: string) => void;
}

// The NATIVE speech-to-speech path: microphone audio goes straight to the
// realtime session and generated audio comes straight back, with no STT/
// text-LLM/TTS relay in between. Contrast with voice/realtimeSession.ts,
// which *is* that relay and is what the explicit Speech-to-Text and
// Text-to-Speech modes use.
//
// Tool calls the model makes over the audio channel are executed through
// the exact same permission/approval/audit path the text agent uses
// (agent/orchestrator.ts's executeToolCall) — a voice conversation gets no
// security shortcut for being faster. Every tool call here is attached to
// a real AgentRun row (created lazily, once) purely so ToolCallRecord's
// audit trail and the approval flow work identically to the text path;
// this class does not run the text agent LOOP (no LLM text turns, no
// message deltas) — the realtime provider's own model is the one
// reasoning and speaking.
export class NativeRealtimeSession {
  private readonly opts: NativeRealtimeSessionOptions;
  private state: NativeRealtimeState = "connecting";
  private session: RealtimeAudioSession | null = null;
  private unsubscribe: (() => void) | null = null;
  private agentRunId: string | null = null;
  private closed = false;

  constructor(opts: NativeRealtimeSessionOptions) {
    this.opts = opts;
  }

  getState(): NativeRealtimeState {
    return this.state;
  }

  private setState(state: NativeRealtimeState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onStateChange(state);
  }

  async connect(): Promise<void> {
    const capabilities = this.opts.provider.getCapabilities();
    if (!capabilities.nativeSpeechToSpeech) {
      // Load-bearing check: a provider without real audio-to-audio must
      // never be silently substituted with the STT/LLM/TTS pipeline under
      // the "speech-to-speech" name. The caller asked for native realtime
      // and gets a clear failure if this provider can't deliver it.
      throw new Error(`Provider "${this.opts.provider.id}" does not support native speech-to-speech.`);
    }

    const tools: RealtimeToolDefinition[] = this.opts.toolsEnabled
      ? toolRegistry.list().map((t) => ({ name: t.name, description: t.description, parameters: t.jsonSchema }))
      : [];

    this.session = await this.opts.provider.connect({
      model: this.opts.model,
      instructions: this.opts.instructions,
      voice: this.opts.voice,
      tools,
      userId: this.opts.userId,
    });

    this.unsubscribe = this.session.subscribe((event) => this.handleEvent(event));
  }

  /** Microphone audio, pushed through untouched — no transcription
   *  happens on this side of the wire. */
  feedAudio(pcm16: Buffer): void {
    if (this.closed) return;
    this.session?.sendAudio(pcm16);
  }

  /** Push-to-talk release, or an explicit "I'm done talking" signal when
   *  the provider isn't using server-side VAD. */
  endUtteranceNow(): void {
    if (this.closed) return;
    this.session?.commitInput();
  }

  /** Barge-in / explicit stop: interrupt the model mid-utterance. */
  interrupt(): void {
    if (this.closed) return;
    this.session?.interrupt();
    this.setState("listening");
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.session?.close();
    this.session = null;
    this.setState("closed");
  }

  private async ensureAgentRun(): Promise<string> {
    if (this.agentRunId) return this.agentRunId;
    const run = await prisma.agentRun.create({
      data: {
        conversationId: this.opts.conversationId,
        provider: this.opts.provider.id,
        model: this.opts.model,
        status: "running",
        maxSteps: 1, // unused by this path — tool calls arrive one at a time from the realtime session, not a text-agent loop
      },
    });
    this.agentRunId = run.id;
    return run.id;
  }

  private handleEvent(event: Parameters<Parameters<RealtimeAudioSession["subscribe"]>[0]>[0]): void {
    switch (event.type) {
      case "session_ready":
        this.setState("listening");
        break;

      case "speech_started":
        // Provider-side VAD heard the user start talking. This IS
        // barge-in: stop whatever is currently playing immediately rather
        // than waiting for a queued sentence to finish, which is the
        // whole difference between "interruptible" and "polite queueing".
        this.interrupt();
        break;

      case "speech_stopped":
        break; // informational; response.create / server VAD decides what happens next

      case "audio_delta":
        this.setState("speaking");
        this.opts.onAudioChunk(event.audio);
        break;

      case "audio_done":
        break;

      case "input_transcript":
        this.opts.onInputTranscript(event.text);
        void appendMessage(this.opts.conversationId, "user", event.text);
        eventBus.emitEvent("voice.transcript", { text: event.text }, this.opts.userId);
        break;

      case "output_transcript_delta":
        this.opts.onOutputTranscript(event.text);
        break;

      case "tool_call":
        void this.handleToolCall(event.callId, event.name, event.arguments);
        break;

      case "response_done":
        if (this.state !== "closed") this.setState("listening");
        break;

      case "error":
        this.opts.onError(event.message);
        if (event.fatal) void this.close();
        break;

      case "closed":
        this.setState("closed");
        break;
    }
  }

  private async handleToolCall(callId: string, name: string, args: Record<string, unknown>): Promise<void> {
    if (!this.opts.toolsEnabled) {
      // The model was never given tools, so it should never ask for one —
      // but if a provider bug or a stale session state does this anyway,
      // refuse rather than silently executing.
      this.session?.submitToolResult(callId, { error: "Tools are disabled for this session." });
      return;
    }

    try {
      const agentRunId = await this.ensureAgentRun();
      const controller = new AbortController();
      const outcome = await executeToolCall(agentRunId, { userId: this.opts.userId, role: this.opts.role }, { id: callId, name, arguments: args }, controller.signal);

      if (outcome.status === "waiting_for_approval") {
        // A voice conversation cannot block on a human clicking approve —
        // tell the model plainly rather than hanging the audio session.
        this.session?.submitToolResult(callId, { error: "This action requires approval. Please check the app and approve it, then ask again." });
        return;
      }

      // Persist before acking to the provider: a caller that observes the
      // tool result (e.g. a test, or anything reading the conversation
      // right after) should never race the write.
      await appendMessage(this.opts.conversationId, "tool", outcome.contentForModel, { toolCallId: callId });
      this.session?.submitToolResult(callId, outcome.contentForModel);
    } catch (err) {
      log.error({ err, tool: name }, "native realtime tool call failed");
      this.session?.submitToolResult(callId, { error: (err as Error).message });
    }
  }
}
