// Section 29: Voice Provider Abstraction. The AI model and the voice
// provider are fully independent (Section 86) — this interface has zero
// knowledge of which AIProvider is in use, and vice versa.
export interface VoiceInfo {
  id: string;
  name: string;
  previewUrl?: string;
}

export interface TranscriptionResult {
  text: string;
  language?: string;
}

export interface SynthesisOptions {
  /** Explicit voice to use. Falls back to the provider's/user's configured default. */
  voiceId?: string;
  /** Explicit model to use (e.g. a lower-latency model for realtime use). */
  model?: string;
  /** Whose credential/settings to resolve — omit for a system-level call
   *  (health checks) that should only ever use an operator env var. */
  userId?: string;
  signal?: AbortSignal;
}

export interface TranscribeOptions {
  userId?: string;
  signal?: AbortSignal;
}

export interface VoiceProvider {
  readonly id: string;
  /** True if this provider is usable at all right now for the given user
   *  (a user-scoped credential or an operator env var), or system-wide
   *  when no userId is given. */
  isConfigured(userId?: string): Promise<boolean>;

  /** Section 28: speech-to-text. */
  transcribe(audio: Buffer, mimeType: string, opts?: TranscribeOptions): Promise<TranscriptionResult>;

  /** Section 30: text-to-speech, returns the complete audio in one buffer. */
  synthesize(text: string, opts?: SynthesisOptions): Promise<{ audio: Buffer; mimeType: string }>;

  /** Streaming text-to-speech (Section 1/30: "streaming audio"). Yields
   *  audio chunks as they arrive from the provider rather than waiting
   *  for the complete file — this is what lets Jarvis start speaking
   *  before the whole reply has been synthesized. Providers that cannot
   *  stream may implement this by yielding the one buffer from
   *  `synthesize()` in a single chunk. */
  synthesizeStream(text: string, opts?: SynthesisOptions): AsyncGenerator<Buffer, void, unknown>;

  listVoices(userId?: string): Promise<VoiceInfo[]>;
}

// Section 88: the three voice modes a client explicitly selects — never
// inferred from message content, and never switched between automatically
// by the backend. Each is a genuinely different pipeline, not a UI label
// over the same one:
//
//   "speech_to_speech" — NATIVE audio-to-audio, one live session with a
//   realtime-capable model (voice/realtime/nativeRealtimeSession.ts).
//   Neither a VoiceProvider's transcribe() nor synthesize() is called at
//   any point in this mode — there is no STT/TTS step to be "hidden"
//   because none exists in this path at all.
//
//   "stt" — microphone audio in, transcript + the agent's TEXT reply out.
//   No audio is ever synthesized in this mode.
//
//   "tts" — typed text in, synthesized speech out. No microphone audio is
//   ever accepted in this mode.
export type VoiceMode = "speech_to_speech" | "stt" | "tts";
