import { request } from "undici";
import { env } from "../config/env.js";
import { NotConfiguredError, ProviderError } from "../utils/errors.js";
import { resolveApiKey } from "./credentialResolution.js";
import type { SynthesisOptions, TranscribeOptions, TranscriptionResult, VoiceInfo, VoiceProvider } from "./types.js";

const API_BASE = "https://api.elevenlabs.io/v1";

// A low-latency model suited to realtime conversational TTS. Callers can
// still override via SynthesisOptions.model (Section 2: "configurable
// model").
const DEFAULT_TTS_MODEL = "eleven_flash_v2_5";

// Section 2/30: real, first-class ElevenLabs integration — TTS (buffered
// and streaming), STT, and voice listing, with the API key resolved
// through the same user-scoped encrypted credential store every other
// integration uses (falling back to an operator env var), never returned
// to a caller, never logged, and never handed to the LLM.
export class ElevenLabsVoiceProvider implements VoiceProvider {
  readonly id = "elevenlabs";

  async isConfigured(userId?: string): Promise<boolean> {
    try {
      await this.resolveKey(userId);
      return true;
    } catch {
      return false;
    }
  }

  private async resolveKey(userId?: string): Promise<string> {
    return resolveApiKey(userId, "elevenlabs", env.ELEVENLABS_API_KEY, "ElevenLabs voice provider (an ELEVENLABS_API_KEY or a saved credential)");
  }

  async listVoices(userId?: string): Promise<VoiceInfo[]> {
    const key = await this.resolveKey(userId);
    const res = await request(`${API_BASE}/voices`, { headers: { "xi-api-key": key } });
    const body = (await res.body.json()) as Record<string, unknown>;
    if (res.statusCode >= 400) throw new ProviderError(`ElevenLabs error (${res.statusCode})`, res.statusCode >= 500);
    return ((body.voices as Array<Record<string, unknown>>) ?? []).map((v) => ({
      id: String(v.voice_id),
      name: String(v.name),
      previewUrl: v.preview_url ? String(v.preview_url) : undefined,
    }));
  }

  private async resolveVoiceId(opts?: SynthesisOptions): Promise<string> {
    if (opts?.voiceId) return opts.voiceId;
    if (env.ELEVENLABS_DEFAULT_VOICE_ID) return env.ELEVENLABS_DEFAULT_VOICE_ID;
    throw new NotConfiguredError("ElevenLabs voice (pass voiceId, set a default in Settings, or set ELEVENLABS_DEFAULT_VOICE_ID)");
  }

  async synthesize(text: string, opts?: SynthesisOptions): Promise<{ audio: Buffer; mimeType: string }> {
    const key = await this.resolveKey(opts?.userId);
    const voice = await this.resolveVoiceId(opts);

    const res = await request(`${API_BASE}/text-to-speech/${voice}`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: opts?.model ?? DEFAULT_TTS_MODEL }),
      signal: opts?.signal,
    });
    if (res.statusCode >= 400) {
      const body = await res.body.text();
      throw new ProviderError(`ElevenLabs TTS error (${res.statusCode}): ${body}`, res.statusCode >= 500);
    }
    const chunks: Buffer[] = [];
    for await (const chunk of res.body) chunks.push(Buffer.from(chunk));
    return { audio: Buffer.concat(chunks), mimeType: "audio/mpeg" };
  }

  // Real streaming TTS against ElevenLabs' chunked `/stream` endpoint —
  // audio bytes are yielded as they arrive over the HTTP response rather
  // than buffered until the full utterance is synthesized. This is what
  // lets the realtime voice pipeline (voice/realtimeSession.ts) start
  // playback before ElevenLabs has finished generating the whole reply.
  async *synthesizeStream(text: string, opts?: SynthesisOptions): AsyncGenerator<Buffer, void, unknown> {
    const key = await this.resolveKey(opts?.userId);
    const voice = await this.resolveVoiceId(opts);

    const res = await request(`${API_BASE}/text-to-speech/${voice}/stream`, {
      method: "POST",
      headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: opts?.model ?? DEFAULT_TTS_MODEL, optimize_streaming_latency: 3 }),
      signal: opts?.signal,
    });
    if (res.statusCode >= 400) {
      const body = await res.body.text();
      throw new ProviderError(`ElevenLabs streaming TTS error (${res.statusCode}): ${body}`, res.statusCode >= 500);
    }
    for await (const chunk of res.body) {
      yield Buffer.from(chunk);
    }
  }

  async transcribe(audio: Buffer, mimeType: string, opts?: TranscribeOptions): Promise<TranscriptionResult> {
    const key = await this.resolveKey(opts?.userId);
    const form = new FormData();
    form.append("model_id", "scribe_v1");
    form.append("file", new Blob([audio], { type: mimeType }), "audio");

    // Native fetch (not undici's low-level `request`) so the multipart
    // boundary for FormData is encoded correctly.
    const res = await fetch(`${API_BASE}/speech-to-text`, {
      method: "POST",
      headers: { "xi-api-key": key },
      body: form,
      signal: opts?.signal,
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new ProviderError(`ElevenLabs STT error (${res.status}): ${JSON.stringify(body)}`, res.status >= 500);
    return { text: String(body.text ?? ""), language: body.language_code ? String(body.language_code) : undefined };
  }
}
