import type { ChatRequest, ModelCapabilities, VisionTransportStrategy } from "../../ai/types.js";
import { attachVisualContext, type VisionTransportAdapter, type VisionTransportInput } from "./visionTransportAdapter.js";

// The universal floor. A model with no visual input at all still gets the
// structural/temporal summary as text — Jarvis knowing what's on screen is
// useful even to a text-only model, and this is what keeps "Eyes work with
// every provider" true rather than "Eyes work with vision providers."
//
// It is also what a vision-capable model receives when the user hasn't
// allowed that provider to receive pixels: the gate removes imagery, not
// awareness.
export const textOnlyVisionAdapter: VisionTransportAdapter = {
  id: "text-only",

  canHandle(_capabilities: ModelCapabilities): boolean {
    return true; // nothing is ever unservable by text
  },

  getStrategy(_capabilities: ModelCapabilities): VisionTransportStrategy {
    return "text_only";
  },

  async sendVisualContext(input: VisionTransportInput): Promise<ChatRequest> {
    return attachVisualContext(input.request, {
      strategy: "text_only",
      images: [],
      temporalSummary: input.visualContext.temporalSummary,
      sourceTimestampMs: input.visualContext.currentSample?.atMs,
    });
  },
};
