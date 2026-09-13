import { ElevenLabsVoiceProvider } from "./elevenLabsProvider.js";
import { OpenAIWhisperProvider } from "./openAIWhisperProvider.js";
import type { VoiceProvider } from "./types.js";
import { ValidationError } from "../utils/errors.js";

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
