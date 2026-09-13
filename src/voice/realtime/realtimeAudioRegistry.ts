import { OpenAIRealtimeProvider } from "./openAIRealtimeProvider.js";
import type { RealtimeAudioProvider } from "./realtimeAudioProvider.js";
import { ValidationError } from "../../utils/errors.js";
import { env } from "../../config/env.js";

// Only providers with a genuinely verified native audio-to-audio API are
// registered here. Anthropic and Gemini are deliberately absent: as of
// this writing neither exposes a documented native speech-to-speech
// transport equivalent to OpenAI's Realtime API in this codebase's
// integration surface. Adding one later means writing a new adapter
// against `RealtimeAudioProvider`, not touching this registry's callers.
const providers: Record<string, RealtimeAudioProvider> = {
  "openai-realtime": new OpenAIRealtimeProvider(),
};

export function getRealtimeAudioProvider(id: string): RealtimeAudioProvider {
  const provider = providers[id];
  if (!provider) throw new ValidationError(`Unknown realtime audio provider "${id}".`);
  return provider;
}

export function listRealtimeAudioProviders(): RealtimeAudioProvider[] {
  return Object.values(providers);
}

export function __registerRealtimeAudioProviderForTesting(provider: RealtimeAudioProvider): void {
  if (env.NODE_ENV !== "test") {
    throw new Error("__registerRealtimeAudioProviderForTesting is only available when NODE_ENV=test.");
  }
  providers[provider.id] = provider;
}
