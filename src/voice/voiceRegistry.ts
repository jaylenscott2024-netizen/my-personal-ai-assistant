import { ElevenLabsVoiceProvider } from "./elevenLabsProvider.js";
import { OpenAIWhisperProvider } from "./openAIWhisperProvider.js";
import type { VoiceProvider } from "./types.js";
import { ValidationError } from "../utils/errors.js";
import { env } from "../config/env.js";

const providers: Record<string, VoiceProvider> = {
  elevenlabs: new ElevenLabsVoiceProvider(),
  "openai-whisper": new OpenAIWhisperProvider(),
};

export function getVoiceProvider(id: string): VoiceProvider {
  const provider = providers[id];
  if (!provider) throw new ValidationError(`Unknown voice provider "${id}".`);
  return provider;
}

export function listVoiceProviders(): VoiceProvider[] {
  return Object.values(providers);
}

// Test-only seam, mirroring ai/router.ts's __registerProviderForTesting —
// lets the test suite exercise the realtime voice pipeline (STT -> agent
// -> TTS) with deterministic fakes instead of real network calls to
// ElevenLabs/OpenAI.
export function __registerVoiceProviderForTesting(provider: VoiceProvider): void {
  if (env.NODE_ENV !== "test") {
    throw new Error("__registerVoiceProviderForTesting is only available when NODE_ENV=test.");
  }
  providers[provider.id] = provider;
}
