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

// Section 88: the four modes a client may explicitly select. The backend
// never infers or switches between these on its own.
export type VoiceMode = "stt" | "tts" | "speech_to_speech" | "realtime_voice";
