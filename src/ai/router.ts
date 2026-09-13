import { env } from "../config/env.js";
import { NotConfiguredError, ValidationError } from "../utils/errors.js";
import { AnthropicProvider } from "./providers/anthropicProvider.js";
import { OpenAIProvider } from "./providers/openAIProvider.js";
import { GeminiProvider } from "./providers/geminiProvider.js";
import { MockProvider } from "./providers/mockProvider.js";
import type { AIProvider, ModelCapabilities } from "./types.js";

// Section 7: Model Routing. This is the single place that knows which
// concrete provider implementations exist; everything else (the agent,
// API routes) asks the router for "the provider named X" or "the
// currently configured default provider" and gets back the same normalized
// AIProvider interface either way (Section 86: model/voice separation).
const providers: Record<string, AIProvider> = {
  anthropic: new AnthropicProvider(),
  openai: new OpenAIProvider(),
  gemini: new GeminiProvider(),
  mock: new MockProvider(),
};

export function listProviders(): AIProvider[] {
  return Object.values(providers);
}

// Test-only seam: lets the test suite register a deterministic fake
// provider (e.g. one that always requests a tool call, to exercise the
// agent loop's runaway-protection guard) without exposing any mutation of
// the provider registry in production code paths.
export function __registerProviderForTesting(provider: AIProvider): void {
  if (env.NODE_ENV !== "test") {
    throw new Error("__registerProviderForTesting is only available when NODE_ENV=test.");
  }
  providers[provider.id] = provider;
}

export function getProvider(id: string): AIProvider {
  const provider = providers[id];
  if (!provider) throw new ValidationError(`Unknown AI provider "${id}".`);
  return provider;
}

export function getConfiguredProvider(id: string): AIProvider {
  const provider = getProvider(id);
  if (!provider.isConfigured()) {
    throw new NotConfiguredError(`AI provider "${provider.displayName}"`);
  }
  return provider;
}

export function getDefaultProvider(): AIProvider {
  return getConfiguredProvider(env.DEFAULT_AI_PROVIDER);
}

export function defaultModelFor(providerId: string): string {
  switch (providerId) {
    case "anthropic":
      return env.ANTHROPIC_MODEL;
    case "openai":
      return env.OPENAI_MODEL;
    case "gemini":
      return env.GEMINI_MODEL;
    default:
      return "mock-1";
  }
}

export function capabilitiesFor(providerId: string, model: string): ModelCapabilities {
  return getProvider(providerId).getCapabilities(model);
}

// Section 85: Provider Fallback. Only used when the caller explicitly opts
// in (fallbackProviderId set) — the router never silently swaps providers
// on its own, since that could violate cost/quality expectations.
export function resolveProviderWithFallback(preferredId: string, fallbackId?: string): AIProvider {
  const preferred = getProvider(preferredId);
  if (preferred.isConfigured()) return preferred;
  if (fallbackId) {
    const fallback = getProvider(fallbackId);
    if (fallback.isConfigured()) return fallback;
  }
  throw new NotConfiguredError(`AI provider "${preferred.displayName}"`);
}
