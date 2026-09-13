import type { ModelCapabilities } from "../../ai/types.js";
import { supportsAnyVisualInput } from "../../ai/visionCapabilities.js";
import { anthropicVisionAdapter } from "./anthropicVisionAdapter.js";
import { geminiVisionAdapter } from "./geminiVisionAdapter.js";
import { openAIVisionAdapter } from "./openAIVisionAdapter.js";
import { textOnlyVisionAdapter } from "./textOnlyVisionAdapter.js";
import type { VisionTransportAdapter } from "./visionTransportAdapter.js";

// Section 13: this registry is the reason the orchestrator contains no
// `if (provider === "openai")` anywhere. It asks for "the transport for
// this provider and these capabilities" and gets one back; every
// provider-specific decision lives behind that call.
//
// Adding a provider — including a future local vision model — means
// registering one adapter here and declaring its VisionCapabilities. No
// change to the Eyes engine, the attention model, the temporal buffer, or
// the orchestrator.
const adapters = new Map<string, VisionTransportAdapter>([
  ["anthropic", anthropicVisionAdapter],
  ["openai", openAIVisionAdapter],
  ["gemini", geminiVisionAdapter],
]);

export function registerVisionTransportAdapter(providerId: string, adapter: VisionTransportAdapter): void {
  adapters.set(providerId, adapter);
}

export function listVisionTransportAdapters(): Array<{ providerId: string; adapter: VisionTransportAdapter }> {
  return [...adapters].map(([providerId, adapter]) => ({ providerId, adapter }));
}

/** Resolves the transport for a provider/model pair. Falls back to
 *  text-only whenever the model can't take visual input at all, or the
 *  provider has no registered adapter — never to another provider's
 *  adapter, whose request shape would be wrong for this API. */
export function resolveVisionTransport(providerId: string, capabilities: ModelCapabilities): VisionTransportAdapter {
  if (!supportsAnyVisualInput(capabilities)) return textOnlyVisionAdapter;
  const adapter = adapters.get(providerId);
  if (!adapter || !adapter.canHandle(capabilities)) return textOnlyVisionAdapter;
  return adapter;
}
