import type { ChatRequest, ModelCapabilities, VisionTransportStrategy } from "../../ai/types.js";
import { visionCapabilitiesOf } from "../../ai/visionCapabilities.js";
import type { VisualContextDetail } from "../visualContext.js";
import { attachVisualContext, toVisualContextImages, type VisionTransportAdapter, type VisionTransportInput } from "./visionTransportAdapter.js";

// Section 7: OpenAI's chat models accept still images, not video and not a
// live visual stream. Rather than pretend otherwise (or degrade to "here's
// one screenshot"), this adapter reconstructs *time* out of the local
// temporal buffer: a small, deliberately chosen set of keyframes around
// what actually changed, labelled with when each was captured, plus the
// structural summary that explains them.
//
// What this is emphatically NOT: a screenshot-upload loop. Frames are
// selected from observations Eyes already recorded, only when the model is
// asked something visual, and capped hard — never streamed, never
// periodic, never one-per-turn-regardless-of-need.

// Per-detail image budgets, tighter than Claude's: every image costs a
// meaningful share of a 128k context, and OpenAI's own guidance favors
// fewer, well-chosen images over many marginal ones.
const DETAIL_BUDGET: Record<VisualContextDetail, number> = { low: 1, medium: 3, high: 5 };

export const openAIVisionAdapter: VisionTransportAdapter = {
  id: "openai",

  canHandle(capabilities: ModelCapabilities): boolean {
    return visionCapabilitiesOf(capabilities).imageInput;
  },

  getStrategy(capabilities: ModelCapabilities): VisionTransportStrategy {
    const vision = visionCapabilitiesOf(capabilities);
    if (!vision.imageInput) return "text_only";
    return vision.temporalImageContext ? "temporal_image_set" : "image_set";
  },

  async sendVisualContext(input: VisionTransportInput): Promise<ChatRequest> {
    const { visualContext, capabilities, request } = input;
    const vision = visionCapabilitiesOf(capabilities);
    const strategy = this.getStrategy(capabilities);

    if (strategy === "text_only") {
      return attachVisualContext(request, {
        strategy: "text_only",
        images: [],
        temporalSummary: visualContext.temporalSummary,
        sourceTimestampMs: visualContext.currentSample?.atMs,
      });
    }

    const budget = Math.min(
      DETAIL_BUDGET[visualContext.detail],
      vision.maxImagesPerRequest ?? DETAIL_BUDGET[visualContext.detail],
    );
    // A single-image strategy has no way to express a sequence, so don't
    // pretend: send only the newest frame in that case.
    const images = toVisualContextImages(visualContext, strategy === "image_set" ? 1 : budget);

    return attachVisualContext(request, {
      strategy: images.length > 0 ? strategy : "text_only",
      images,
      temporalSummary: visualContext.temporalSummary,
      sourceTimestampMs: visualContext.currentSample?.atMs,
    });
  },
};
