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

export interface VoiceProvider {
  readonly id: string;
  isConfigured(): boolean;

  /** Section 28: speech-to-text. */
  transcribe(audio: Buffer, mimeType: string): Promise<TranscriptionResult>;

  /** Section 30: text-to-speech, returns raw audio bytes. */
  synthesize(text: string, voiceId?: string): Promise<{ audio: Buffer; mimeType: string }>;

  listVoices(): Promise<VoiceInfo[]>;
}

// Section 88: the four modes a client may explicitly select. The backend
// never infers or switches between these on its own.
export type VoiceMode = "stt" | "tts" | "speech_to_speech" | "realtime_voice";
