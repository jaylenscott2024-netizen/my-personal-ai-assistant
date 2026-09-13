import { env } from "../config/env.js";
import { ProviderError } from "../utils/errors.js";
import { resolveApiKey } from "./credentialResolution.js";
import type { TranscribeOptions, TranscriptionResult, VoiceInfo, VoiceProvider } from "./types.js";

// Section 28: an alternative STT-only provider. OpenAI has no TTS voice
// catalogue comparable to ElevenLabs configured here, so synthesize/
// listVoices honestly report not-implemented for this provider rather than
// silently degrading.
export class OpenAIWhisperProvider implements VoiceProvider {
  readonly id = "openai-whisper";

  async isConfigured(userId?: string): Promise<boolean> {
    try {
      await resolveApiKey(userId, "openai", env.OPENAI_API_KEY, "");
      return true;
    } catch {
      return false;
    }
  }

  async transcribe(audio: Buffer, mimeType: string, opts?: TranscribeOptions): Promise<TranscriptionResult> {
    const key = await resolveApiKey(opts?.userId, "openai", env.OPENAI_API_KEY, "OpenAI Whisper (an OPENAI_API_KEY or a saved credential)");
    const form = new FormData();
    form.append("model", "whisper-1");
    form.append("file", new Blob([audio], { type: mimeType }), "audio");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: form,
      signal: opts?.signal,
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new ProviderError(`OpenAI Whisper error (${res.status}): ${JSON.stringify(body)}`, res.status >= 500);
    return { text: String(body.text ?? "") };
  }

  async synthesize(): Promise<{ audio: Buffer; mimeType: string }> {
    throw new ProviderError("Text-to-speech is not implemented for the OpenAI Whisper provider; use ElevenLabs.", false);
  }

  // eslint-disable-next-line require-yield
  async *synthesizeStream(): AsyncGenerator<Buffer, void, unknown> {
    throw new ProviderError("Text-to-speech is not implemented for the OpenAI Whisper provider; use ElevenLabs.", false);
  }

  async listVoices(): Promise<VoiceInfo[]> {
    return [];
  }
}
