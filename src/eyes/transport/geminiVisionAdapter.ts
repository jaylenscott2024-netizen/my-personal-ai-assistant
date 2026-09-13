import type { ChatRequest, ModelCapabilities, VisionTransportStrategy } from "../../ai/types.js";
import { visionCapabilitiesOf } from "../../ai/visionCapabilities.js";
import { childLogger } from "../../config/logger.js";
import type { VisualContext, VisualContextDetail } from "../visualContext.js";
import { negotiateRealtimeVisual, realtimeVisualSessions } from "./realtimeVisualTransport.js";
import { attachVisualContext, toVisualContextImages, type VisionTransportAdapter, type VisionTransportInput } from "./visionTransportAdapter.js";

const log = childLogger("eyes.transport.gemini");

// Section 9: Gemini gets a genuinely different architecture, because it
// genuinely has different capabilities — a live bidirectional endpoint on
// Live models, video on the standard endpoint, images everywhere. Forcing
// all of that through the still-image pathway would throw away the one
// provider here that can actually watch something happen.
//
// Order of preference, decided purely from declared capabilities:
//   1. realtime_stream  — frames already flowed over a live session; the
//                         request just references it.
//   2. video_upload     — a real encoded clip, when a clip source exists.
//   3. temporal_image_set / image_set — the universal floor.
//
// Degrading from 1 to 3 (no API key, session refused) is a TRANSPORT
// fallback, not a perception fallback: Eyes is unaffected and keeps
// running at its own rate either way.

const DETAIL_BUDGET: Record<VisualContextDetail, number> = { low: 1, medium: 4, high: 6 };

/** Optional: something that can encode recent visual history into a clip
 *  Gemini's video pathway accepts. None is registered by default — this
 *  build has no video encoder, so the video strategy stays unreachable
 *  rather than being claimed falsely. */
export interface VideoClipSource {
  readonly id: string;
  encodeClip(
    context: VisualContext,
    options: { maxFps: number; mimeType: string },
  ): Promise<{ mimeType: string; base64: string; durationMs: number } | null>;
}

let videoClipSource: VideoClipSource | null = null;

export function setVideoClipSource(source: VideoClipSource | null): void {
  videoClipSource = source;
}

export function getVideoClipSource(): VideoClipSource | null {
  return videoClipSource;
}

export const geminiVisionAdapter: VisionTransportAdapter = {
  id: "gemini",

  canHandle(capabilities: ModelCapabilities): boolean {
    const vision = visionCapabilitiesOf(capabilities);
    return vision.imageInput || vision.videoInput || vision.realtimeVision || vision.videoUpload;
  },

  getStrategy(capabilities: ModelCapabilities): VisionTransportStrategy {
    const vision = visionCapabilitiesOf(capabilities);
    if (vision.realtimeVision) return "realtime_stream";
    if ((vision.videoInput || vision.videoUpload) && videoClipSource) return "video_upload";
    if (vision.imageInput) return vision.temporalImageContext ? "temporal_image_set" : "image_set";
    return "text_only";
  },

  async sendVisualContext(input: VisionTransportInput): Promise<ChatRequest> {
    const { visualContext, capabilities, request, sessionKey } = input;
    const vision = visionCapabilitiesOf(capabilities);

    if (vision.realtimeVision && sessionKey) {
      const negotiation = negotiateRealtimeVisual(request.model, capabilities);
      if (negotiation) {
        const feed = await realtimeVisualSessions.ensureSession(sessionKey, negotiation);
        if (feed?.isOpen) {
          // Frames are already flowing out of band at the negotiated rate —
          // embedding stills too would duplicate them and waste context.
          return attachVisualContext(request, {
            strategy: "realtime_stream",
            images: [],
            temporalSummary: `${visualContext.temporalSummary}\n(Live visual stream active at ${negotiation.fps} fps; frames are delivered over the realtime session, not embedded here.)`,
            sourceTimestampMs: visualContext.currentSample?.atMs,
            realtimeSessionId: sessionKey,
          });
        }
        log.debug({ model: request.model }, "live visual session unavailable; using still-image transport");
      }
    }

    if ((vision.videoInput || vision.videoUpload) && videoClipSource) {
      const clip = await videoClipSource.encodeClip(visualContext, {
        maxFps: vision.maxVideoFps ?? 1,
        mimeType: vision.preferredVideoFormat ?? "video/mp4",
      });
      if (clip) {
        return attachVisualContext(request, {
          strategy: "video_upload",
          images: [{ mimeType: clip.mimeType, base64: clip.base64, label: `clip (${Math.round(clip.durationMs / 100) / 10}s)` }],
          temporalSummary: visualContext.temporalSummary,
          sourceTimestampMs: visualContext.currentSample?.atMs,
        });
      }
    }

    if (!vision.imageInput) {
      return attachVisualContext(request, {
        strategy: "text_only",
        images: [],
        temporalSummary: visualContext.temporalSummary,
        sourceTimestampMs: visualContext.currentSample?.atMs,
      });
    }

    const strategy: VisionTransportStrategy = vision.temporalImageContext ? "temporal_image_set" : "image_set";
    const budget = Math.min(
      DETAIL_BUDGET[visualContext.detail],
      vision.maxImagesPerRequest ?? DETAIL_BUDGET[visualContext.detail],
    );
    const images = toVisualContextImages(visualContext, strategy === "image_set" ? 1 : budget);

    return attachVisualContext(request, {
      strategy: images.length > 0 ? strategy : "text_only",
      images,
      temporalSummary: visualContext.temporalSummary,
      sourceTimestampMs: visualContext.currentSample?.atMs,
    });
  },
};
