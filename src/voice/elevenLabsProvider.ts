import { request } from "undici";
import { env } from "../config/env.js";
import { NotConfiguredError, ProviderError } from "../utils/errors.js";
import type { TranscriptionResult, VoiceInfo, VoiceProvider } from "./types.js";

const API_BASE = "https://api.elevenlabs.io/v1";

// Section 30: real ElevenLabs integration for TTS + voice listing + STT.
// Voice selection is always explicit (a `voiceId` argument or the
// configured default) — never hard-coded to one voice.
export class ElevenLabsVoiceProvider implements VoiceProvider {
  readonly id = "elevenlabs";

  isConfigured(): boolean {
    return Boolean(env.ELEVENLABS_API_KEY);
  }

  private requireKey(): string {
    if (!env.ELEVENLABS_API_KEY) throw new NotConfiguredError("ElevenLabs voice provider (ELEVENLABS_API_KEY)");
    return env.ELEVENLABS_API_KEY;
  }

  async listVoices(): Promise<VoiceInfo[]> {
    const key = this.requireKey();
    const res = await request(`${API_BASE}/voices`, { headers: { "xi-api-key": key } });
    const body = (await res.body.json()) as Record<string, unknown>;
    if (res.statusCode >= 400) throw new ProviderError(`ElevenLabs error (${res.statusCode})`, res.statusCode >= 500);
    return ((body.voices as Array<Record<string, unknown>>) ?? []).map((v) => ({
      id: String(v.voice_id),
      name: String(v.name),
      previewUrl: v.preview_url ? String(v.preview_url) : undefined,
    }));
  }

  async synthesize(text: string, voiceId?: string): Promise<{ audio: Buffer; mimeType: string }> {
    const key = this.requireKey();
    const voice = voiceId ?? env.ELEVENLABS_DEFAULT_VOICE_ID;
    if (!voice) throw new NotConfiguredError("ElevenLabs default voice (ELEVENLABS_DEFAULT_VOICE_ID or an explicit voiceId)");

    const res = await request(`${API_BASE}/text-to-speech/${voice}`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
    });
    if (res.statusCode >= 400) {
      const body = await res.body.text();
      throw new ProviderError(`ElevenLabs TTS error (${res.statusCode}): ${body}`, res.statusCode >= 500);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of res.body) chunks.push(Buffer.from(chunk));
    return { audio: Buffer.concat(chunks), mimeType: "audio/mpeg" };
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<TranscriptionResult> {
    const key = this.requireKey();
    const form = new FormData();
    form.append("model_id", "scribe_v1");
    form.append("file", new Blob([audio], { type: mimeType }), "audio");

    // Native fetch (not undici's low-level `request`) so the multipart
    // boundary for FormData is encoded correctly.
    const res = await fetch(`${API_BASE}/speech-to-text`, {
      method: "POST",
      headers: { "xi-api-key": key },
      body: form,
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new ProviderError(`ElevenLabs STT error (${res.status}): ${JSON.stringify(body)}`, res.status >= 500);
    return { text: String(body.text ?? ""), language: body.language_code ? String(body.language_code) : undefined };
  }
}
