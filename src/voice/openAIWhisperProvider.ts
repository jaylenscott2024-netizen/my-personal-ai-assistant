import { env } from "../config/env.js";
import { NotConfiguredError, ProviderError } from "../utils/errors.js";
import type { TranscriptionResult, VoiceInfo, VoiceProvider } from "./types.js";

// Section 28: an alternative STT-only provider. OpenAI has no TTS voice
// catalogue comparable to ElevenLabs configured here, so synthesize/
// listVoices honestly report not-implemented for this provider rather than
// silently degrading.
export class OpenAIWhisperProvider implements VoiceProvider {
  readonly id = "openai-whisper";

  isConfigured(): boolean {
    return Boolean(env.OPENAI_API_KEY);
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<TranscriptionResult> {
    if (!env.OPENAI_API_KEY) throw new NotConfiguredError("OpenAI Whisper (OPENAI_API_KEY)");
    const form = new FormData();
    form.append("model", "whisper-1");
    form.append("file", new Blob([audio], { type: mimeType }), "audio");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: form,
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new ProviderError(`OpenAI Whisper error (${res.status}): ${JSON.stringify(body)}`, res.status >= 500);
    return { text: String(body.text ?? "") };
  }

  async synthesize(): Promise<{ audio: Buffer; mimeType: string }> {
    throw new ProviderError("Text-to-speech is not implemented for the OpenAI Whisper provider; use ElevenLabs.", false);
  }

  async listVoices(): Promise<VoiceInfo[]> {
    return [];
  }
}
