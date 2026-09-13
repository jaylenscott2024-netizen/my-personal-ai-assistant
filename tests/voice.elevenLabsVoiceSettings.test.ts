import { describe, it, expect, vi, beforeEach } from "vitest";

// Verifies SynthesisOptions.voiceSettings (voice/types.ts) actually reaches
// ElevenLabs' request body as its own real `voice_settings` field, and
// that omitting it leaves the request exactly as it always was — undici's
// `request` is mocked since there is no live ElevenLabs credential here.

const requestMock = vi.fn(async (_url: string, _opts: { body?: string }) => ({
  statusCode: 200,
  body: (async function* () {
    yield Buffer.from("audio-bytes");
  })(),
}));

vi.mock("undici", () => ({
  request: (...args: unknown[]) => (requestMock as (...a: unknown[]) => unknown)(...args),
}));

vi.mock("../src/config/env.js", () => ({
  env: { ELEVENLABS_API_KEY: "test-key", ELEVENLABS_DEFAULT_VOICE_ID: "voice-1", NODE_ENV: "test" },
}));

beforeEach(() => {
  requestMock.mockClear();
});

function lastRequestBody(): Record<string, unknown> {
  const call = requestMock.mock.calls[requestMock.mock.calls.length - 1];
  const opts = call[1] as { body: string };
  return JSON.parse(opts.body);
}

describe("ElevenLabsVoiceProvider — voiceSettings passthrough", () => {
  it("sends no voice_settings field when the caller doesn't ask for one", async () => {
    const { ElevenLabsVoiceProvider } = await import("../src/voice/elevenLabsProvider.js");
    const provider = new ElevenLabsVoiceProvider();
    await provider.synthesize("hello");

    const body = lastRequestBody();
    expect(body.voice_settings).toBeUndefined();
  });

  it("maps every documented field onto ElevenLabs' own snake_case names", async () => {
    const { ElevenLabsVoiceProvider } = await import("../src/voice/elevenLabsProvider.js");
    const provider = new ElevenLabsVoiceProvider();
    await provider.synthesize("hello", {
      voiceSettings: { stability: 0.3, similarityBoost: 0.8, style: 0.5, useSpeakerBoost: true, speed: 1.1 },
    });

    const body = lastRequestBody();
    expect(body.voice_settings).toEqual({
      stability: 0.3,
      similarity_boost: 0.8,
      style: 0.5,
      use_speaker_boost: true,
      speed: 1.1,
    });
  });

  it("includes only the fields actually supplied", async () => {
    const { ElevenLabsVoiceProvider } = await import("../src/voice/elevenLabsProvider.js");
    const provider = new ElevenLabsVoiceProvider();
    await provider.synthesize("hello", { voiceSettings: { stability: 0.2 } });

    const body = lastRequestBody();
    expect(body.voice_settings).toEqual({ stability: 0.2 });
  });

  it("applies the same mapping to the streaming endpoint", async () => {
    const { ElevenLabsVoiceProvider } = await import("../src/voice/elevenLabsProvider.js");
    const provider = new ElevenLabsVoiceProvider();
    const stream = provider.synthesizeStream("hello", { voiceSettings: { style: 0.9 } });
    for await (const _chunk of stream) {
      // drain
    }

    const body = lastRequestBody();
    expect(body.voice_settings).toEqual({ style: 0.9 });
  });
});
