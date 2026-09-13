import type { ChatRequest, ModelCapabilities, VisionTransportStrategy, VisualContextImage } from "../../ai/types.js";
import { visionCapabilitiesOf } from "../../ai/visionCapabilities.js";
import { relativeLabel, type VisualContext, type VisualContextDetail } from "../visualContext.js";
import type { VisualSample } from "../visualStream.js";
import { attachVisualContext, type VisionTransportAdapter, type VisionTransportInput } from "./visionTransportAdapter.js";

// Section 8: Claude's own image pathway, with its own frame-selection
// policy — deliberately NOT a copy of the OpenAI adapter's.
//
// Two real differences drive the divergence:
//  - Claude's context window is large and it handles a labelled multi-image
//    sequence as a sequence, so the image budget is wider.
//  - Because it reasons across the set rather than mostly about the last
//    image, "bookending" matters: the OLDEST frame in the window (what the
//    screen looked like before) is as load-bearing as the newest (what it
//    looks like now). OpenAI's adapter spends its smaller budget on the
//    most recent frames; this one always protects the before/after pair
//    and fills the middle with the most salient moments.
const DETAIL_BUDGET: Record<VisualContextDetail, number> = { low: 1, medium: 4, high: 8 };

export const anthropicVisionAdapter: VisionTransportAdapter = {
  id: "anthropic",

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
    const images =
      strategy === "image_set"
        ? pickBookendedFrames(visualContext, 1)
        : pickBookendedFrames(visualContext, budget);

    return attachVisualContext(request, {
      strategy: images.length > 0 ? strategy : "text_only",
      images,
      temporalSummary: visualContext.temporalSummary,
      sourceTimestampMs: visualContext.currentSample?.atMs,
    });
  },
};

/** Newest frame first in priority, then the oldest (the "before"), then
 *  the most salient moments between them — returned chronologically. */
export function pickBookendedFrames(context: VisualContext, budget: number): VisualContextImage[] {
  const framed = context.samples.filter((s): s is VisualSample & { frame: NonNullable<VisualSample["frame"]> } => s.frame !== null);
  if (framed.length === 0 || budget <= 0) return [];

  const chosen = new Set<(typeof framed)[number]>();
  chosen.add(framed[framed.length - 1]);
  if (chosen.size < budget && framed.length > 1) chosen.add(framed[0]);

  const middle = framed
    .filter((sample) => !chosen.has(sample))
    .sort((a, b) => b.attentionScore - a.attentionScore);
  for (const sample of middle) {
    if (chosen.size >= budget) break;
    chosen.add(sample);
  }

  return [...chosen]
    .sort((a, b) => a.atMs - b.atMs)
    .map((sample) => ({
      mimeType: sample.frame.mimeType,
      base64: sample.frame.base64,
      label: `${relativeLabel(sample.atMs, context.requestedAtMs)} — ${sample.summary}`,
      capturedAtMs: sample.atMs,
    }));
}
