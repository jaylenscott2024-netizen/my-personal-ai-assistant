import type { ModelCapabilities, VisionCapabilities } from "./types.js";

// A model that declares no VisionCapabilities gets a conservative set
// derived from its coarse `vision` flag: images if it can see at all,
// nothing more. Never assume video/realtime support that wasn't declared —
// guessing wrong means sending a request shape the API will reject.
export const NO_VISION: VisionCapabilities = {
  imageInput: false,
  videoInput: false,
  realtimeVision: false,
  realtimeAudio: false,
  temporalImageContext: false,
  videoUpload: false,
};

export function imageOnlyVision(overrides: Partial<VisionCapabilities> = {}): VisionCapabilities {
  return {
    ...NO_VISION,
    imageInput: true,
    temporalImageContext: true,
    maxImagesPerRequest: 8,
    preferredImageFormat: "image/png",
    ...overrides,
  };
}

/** The single place anything reads a model's visual input support from. */
export function visionCapabilitiesOf(capabilities: ModelCapabilities): VisionCapabilities {
  if (capabilities.visionCapabilities) return capabilities.visionCapabilities;
  return capabilities.vision ? imageOnlyVision() : NO_VISION;
}

export function supportsAnyVisualInput(capabilities: ModelCapabilities): boolean {
  const vision = visionCapabilitiesOf(capabilities);
  return vision.imageInput || vision.videoInput || vision.realtimeVision || vision.videoUpload;
}
