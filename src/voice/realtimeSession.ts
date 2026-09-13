import { UtteranceSegmenter, pcm16ToWav, type VadConfig } from "./vad.js";
import { getVoiceProvider } from "./voiceRegistry.js";
import { runAgent } from "../agent/orchestrator.js";
import { abortById } from "../tasks/taskService.js";
import { eventBus, type AgentEvent } from "../events/eventBus.js";
import { childLogger } from "../config/logger.js";

const log = childLogger("realtimeVoice");

export type RealtimeVoiceState = "idle" | "listening" | "thinking" | "speaking";

export interface RealtimeVoiceSessionOptions {
  userId: string;
  role: string;
  conversationId: string;
  aiProviderId: string;
  aiModel: string;
  voiceProviderId: string;
  sttProviderId: string;
  voiceId?: string;
  voiceModel?: string;
  vad?: Partial<VadConfig>;
  /** False puts this session into pure "stt" mode (voice/types.ts):
   *  transcript and the agent's text reply are delivered, but
   *  synthesizeStream/synthesize are never called and no audio is ever
   *  produced. Defaults to true, which preserves this class's original,
   *  pre-existing behavior (the full STT -> agent -> streaming-TTS relay
   *  loop with barge-in) unchanged — still what a /ws/voice connection
   *  gets when it doesn't specify an explicit `mode`, for backward
   *  compatibility with clients written before mode selection existed. */
  speakReplies?: boolean;
  onAudioChunk: (chunk: Buffer, mimeType: string) => void;
  onTranscript: (text: string) => void;
  onAssistantText: (text: string) => void;
  onStateChange: (state: RealtimeVoiceState) => void;
  onError: (message: string) => void;
}

// Section 1/10/14 of the Jarvis spec: the full realtime speech-to-speech
// loop — microphone audio in, speech-endpointed by a real VAD (not a
// fixed record-then-wait window), transcribed, run through the streaming
// agent orchestrator, and spoken back sentence-by-sentence as the model
// generates text, so playback starts well before the full reply exists.
//
// Honesty about what "realtime" means here: this is turn-based,
// utterance-segmented streaming — not literal continuous token-to-audio
// synthesis (no provider used here offers that as a composable primitive
// alongside our own tool-using agent; ElevenLabs' own end-to-end
// "Conversational AI" product does, but adopting it would mean handing
// the entire conversation loop to ElevenLabs instead of our permission-
// gated, tool-using orchestrator, which defeats the point). Sentence-
// chunked streaming TTS is the standard, honest way to get "Jarvis starts
// talking before it's finished thinking" without giving that up.
export class RealtimeVoiceSession {
  private readonly opts: RealtimeVoiceSessionOptions;
  private readonly segmenter: UtteranceSegmenter;
  private state: RealtimeVoiceState = "idle";
  private activeAgentRunId: string | null = null;
  private ttsAbortController: AbortController | null = null;
  private unsubscribeDelta: (() => void) | null = null;
  private closed = false;
  // Incremented on every interrupt; respondTo()/drainQueue() capture the
  // value at start and bail out as soon as it changes, so a stale
  // in-flight response can't keep queueing sentences or speaking after
  // the user has already been interrupted (a plain AbortController on
  // the current TTS request alone isn't enough — it doesn't stop the
  // *next* queued sentence from starting).
  private responseGeneration = 0;

  constructor(opts: RealtimeVoiceSessionOptions) {
    this.opts = opts;
    this.segmenter = new UtteranceSegmenter(opts.vad);
  }

  getState(): RealtimeVoiceState {
    return this.state;
  }

  private setState(state: RealtimeVoiceState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onStateChange(state);
  }

  /** Feed one chunk of PCM16 mono 16kHz audio from the microphone. */
  feedAudio(pcm16: Buffer): void {
    if (this.closed) return;
    const wasSpeaking = this.state === "speaking" || this.state === "thinking";
    this.handleVadEvents(this.segmenter.process(pcm16), wasSpeaking);
    if (this.state === "idle") this.setState("listening");
  }

  /** Push-to-talk release (Section 11): end the current utterance right
   *  now rather than waiting for the VAD to infer trailing silence. */
  endUtteranceNow(): void {
    if (this.closed) return;
    const event = this.segmenter.forceEnd();
    if (event) this.handleVadEvents([event], false);
  }

  private handleVadEvents(events: ReturnType<UtteranceSegmenter["process"]>, wasSpeaking: boolean): void {
    for (const event of events) {
      if (event.type === "speech_start" && wasSpeaking) {
        // Section 1: barge-in. The user started talking while Jarvis was
        // still speaking or thinking — stop immediately and listen.
        this.interrupt("user_spoke");
      }
      if (event.type === "speech_end") {
        this.handleUtterance(event.audio).catch((err) => {
          log.error({ err }, "failed to handle utterance");
          this.opts.onError((err as Error).message);
        });
      }
    }
  }

  /** Explicit client-side interrupt (e.g. a "stop" button), or called
   *  internally when the VAD detects the user talking over Jarvis. */
  interrupt(reason: "user_spoke" | "explicit" = "explicit"): void {
    if (this.state !== "speaking" && this.state !== "thinking") return;

    this.responseGeneration++;
    this.ttsAbortController?.abort();
    this.ttsAbortController = null;
    if (this.activeAgentRunId) {
      abortById(this.activeAgentRunId);
      this.activeAgentRunId = null;
    }
    this.unsubscribeDelta?.();
    this.unsubscribeDelta = null;

    eventBus.emitEvent("voice.interrupted", { reason }, this.opts.userId);
    this.setState("listening");
  }

  close(): void {
    this.closed = true;
    this.interrupt("explicit");
  }

  private async handleUtterance(audioPcm16: Buffer): Promise<void> {
    this.setState("thinking");
    // Epoch-ms bounds for the utterance itself, stamped before
    // transcription so they describe when the user actually spoke rather
    // than when STT finished. Jarvis Eyes stamps every visual observation
    // on the same clock (VisualSample.atMs), which is what makes "what was
    // on screen while I said that?" answerable by intersecting the two
    // ranges — see EYES.md. Derived from the audio length, so it holds
    // regardless of how long STT takes.
    const endedAtMs = Date.now();
    const startedAtMs = endedAtMs - Math.round((audioPcm16.length / 2 / 16_000) * 1000);

    const sttProvider = getVoiceProvider(this.opts.sttProviderId);
    const wav = pcm16ToWav(audioPcm16, 16_000);
    const transcript = await sttProvider.transcribe(wav, "audio/wav", { userId: this.opts.userId });
    const text = transcript.text.trim();

    eventBus.emitEvent("voice.transcript", { text, startedAtMs, endedAtMs }, this.opts.userId);
    this.opts.onTranscript(text);

    if (!text) {
      // Endpointed audio that transcribed to nothing (breath, background
      // noise that slipped past the VAD threshold) — don't waste a model
      // call on it.
      this.setState("listening");
      return;
    }

    await this.respondTo(text);
  }

  /** Pure "tts" mode entry point (voice/types.ts): text in, synthesized
   *  speech out. No microphone audio and no STT provider are ever
   *  involved — this bypasses feedAudio/VAD/transcription entirely and
   *  goes straight to the agent, exactly as respondTo() does for a
   *  transcribed utterance. */
  async respondToText(text: string): Promise<void> {
    if (this.closed) return;
    await this.respondTo(text);
  }

  private async respondTo(userText: string): Promise<void> {
    const generation = ++this.responseGeneration;
    const isCurrent = () => !this.closed && this.responseGeneration === generation;

    const sentenceQueue: string[] = [];
    let buffer = "";
    let queueRunning = false;
    const fullText: string[] = [];

    const drainQueue = async () => {
      if (queueRunning) return;
      queueRunning = true;
      while (sentenceQueue.length > 0 && isCurrent()) {
        const sentence = sentenceQueue.shift()!;
        if (!sentence.trim()) continue;
        await this.speak(sentence);
      }
      queueRunning = false;
    };

    const onDelta = (event: AgentEvent) => {
      if (!isCurrent()) return;
      if (event.type !== "message.delta") return;
      const payload = event.payload as { agentRunId: string; delta: string };
      if (payload.agentRunId !== this.activeAgentRunId) return;

      buffer += payload.delta;
      fullText.push(payload.delta);

      // Flush complete sentences as they appear so TTS can start on them
      // immediately rather than waiting for the whole reply.
      const sentenceEnd = /[.!?\n]+/;
      let match: RegExpExecArray | null;
      while ((match = sentenceEnd.exec(buffer))) {
        const end = match.index + match[0].length;
        const sentence = buffer.slice(0, end);
        buffer = buffer.slice(end);
        sentenceQueue.push(sentence);
        void drainQueue();
      }
    };

    this.unsubscribeDelta = eventBus.onEvent(onDelta);

    try {
      const outcome = await runAgent({
        userId: this.opts.userId,
        role: this.opts.role,
        conversationId: this.opts.conversationId,
        providerId: this.opts.aiProviderId,
        model: this.opts.aiModel,
        userMessage: userText,
        stream: true,
        onAgentRunCreated: (id) => {
          this.activeAgentRunId = id;
        },
      });

      this.unsubscribeDelta?.();
      this.unsubscribeDelta = null;

      if (!isCurrent()) return; // interrupted while the agent was still running

      // Anything left in the buffer (no trailing punctuation) still needs
      // to be spoken — and if the model didn't stream at all (a provider
      // without streaming support), outcome.finalMessage carries the
      // whole answer here.
      const trailing = buffer.trim() || (fullText.length === 0 ? outcome.finalMessage ?? "" : "");
      if (trailing) sentenceQueue.push(trailing);

      if (outcome.status === "waiting_for_approval") {
        sentenceQueue.push("I need your approval before I can continue with that — please check the app.");
      } else if (outcome.status === "failed") {
        sentenceQueue.push("Sorry, I ran into a problem with that request.");
        log.warn({ error: outcome.error }, "voice-triggered agent run failed");
      }

      await drainQueue();
      if (isCurrent()) this.opts.onAssistantText(fullText.join("") || outcome.finalMessage || "");
    } catch (err) {
      this.unsubscribeDelta?.();
      this.unsubscribeDelta = null;
      if ((err as Error).name === "AbortError") {
        return; // interrupted — not an error worth surfacing
      }
      throw err;
    } finally {
      this.activeAgentRunId = null;
      if (this.state !== "listening") this.setState("listening");
    }
  }

  private async speak(text: string): Promise<void> {
    if (this.closed) return;
    if (this.opts.speakReplies === false) {
      // Pure "stt" mode (voice/types.ts): the agent's text reply already
      // reached the caller via onAssistantText in respondTo(). Nothing is
      // synthesized — synthesizeStream is never called in this mode.
      return;
    }
    this.setState("speaking");

    const voiceProvider = getVoiceProvider(this.opts.voiceProviderId);
    this.ttsAbortController = new AbortController();
    const signal = this.ttsAbortController.signal;

    try {
      for await (const chunk of voiceProvider.synthesizeStream(text, {
        voiceId: this.opts.voiceId,
        model: this.opts.voiceModel,
        userId: this.opts.userId,
        signal,
      })) {
        if (signal.aborted || this.closed) return;
        this.opts.onAudioChunk(chunk, "audio/mpeg");
      }
    } catch (err) {
      if (signal.aborted) return; // expected on barge-in
      log.error({ err }, "TTS synthesis failed");
      this.opts.onError((err as Error).message);
    }
  }
}
