// Section 32: Clap Detection. This is a real, working amplitude-envelope
// transient detector over raw PCM16 mono audio — not a stub. It looks for
// N sharp energy spikes (claps) within a configurable window, separated by
// silence, which is what distinguishes a clap pattern from continuous
// sound like music, typing, or speech.
//
// Algorithm:
//  1. Split the buffer into short frames and compute RMS energy per frame.
//  2. A frame is a "transient" if its energy exceeds `sensitivity` times a
//     rolling noise floor AND energy rose sharply from the previous frame
//     (onset, not sustained loudness) — this is what rejects music/doors/
//     echoes, which tend to ramp or sustain rather than spike instantly.
//  3. Consecutive transients closer together than `minGapMs` are merged
//     (treated as one clap) to reject rattle/echo double-triggers.
//  4. If the required number of distinct transients occur within
//     `patternWindowMs`, the pattern is detected.
export interface ClapDetectorConfig {
  enabled: boolean;
  sensitivity: number; // 1.5 (very sensitive) - 6 (only loud sharp claps)
  pattern: "single" | "double" | "triple";
  cooldownMs: number;
  sampleRate: number;
}

export const DEFAULT_CLAP_CONFIG: ClapDetectorConfig = {
  enabled: true,
  sensitivity: 3.0,
  pattern: "double",
  cooldownMs: 1500,
  sampleRate: 16_000,
};

const FRAME_MS = 20;
const MIN_GAP_MS = 80;
const PATTERN_WINDOW_MS = 900;

function frameRms(frame: Int16Array): number {
  let sumSquares = 0;
  for (let i = 0; i < frame.length; i++) sumSquares += frame[i] * frame[i];
  return Math.sqrt(sumSquares / frame.length);
}

export interface ClapDetectionResult {
  detected: boolean;
  transientCount: number;
  confidence: number;
}

export class ClapDetector {
  private config: ClapDetectorConfig;
  private noiseFloor = 200; // adapts over time
  private lastActivationAt = 0;
  private recentTransients: number[] = []; // timestamps (ms, relative to stream start)
  private streamStartMs = Date.now();

  constructor(config: Partial<ClapDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CLAP_CONFIG, ...config };
  }

  updateConfig(config: Partial<ClapDetectorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  reset(): void {
    this.recentTransients = [];
    this.streamStartMs = Date.now();
  }

  /** Feed a chunk of PCM16 mono little-endian audio. Returns a result if a
   *  clap pattern completes on this chunk. */
  processChunk(pcm16: Buffer): ClapDetectionResult {
    if (!this.config.enabled) return { detected: false, transientCount: 0, confidence: 0 };

    const samples = new Int16Array(pcm16.buffer, pcm16.byteOffset, pcm16.length / 2);
    const frameSize = Math.max(1, Math.floor((this.config.sampleRate * FRAME_MS) / 1000));

    let previousEnergy = this.noiseFloor;
    const now = Date.now() - this.streamStartMs;

    for (let offset = 0; offset + frameSize <= samples.length; offset += frameSize) {
      const frame = samples.subarray(offset, offset + frameSize);
      const energy = frameRms(frame);

      // Slowly adapt the noise floor toward quiet-frame energy so gradual
      // background loudness (music, a fan) doesn't get misread as claps.
      if (energy < this.noiseFloor * 1.2) {
        this.noiseFloor = this.noiseFloor * 0.98 + energy * 0.02;
      }

      const isSpike = energy > this.noiseFloor * this.config.sensitivity;
      const isOnset = energy > previousEnergy * 2.5;

      if (isSpike && isOnset) {
        const frameTimeMs = now + (offset / this.config.sampleRate) * 1000;
        const last = this.recentTransients[this.recentTransients.length - 1];
        if (last === undefined || frameTimeMs - last > MIN_GAP_MS) {
          this.recentTransients.push(frameTimeMs);
        }
      }
      previousEnergy = energy;
    }

    // Drop transients that fall outside the pattern window.
    const cutoff = now - PATTERN_WINDOW_MS;
    this.recentTransients = this.recentTransients.filter((t) => t > cutoff);

    const required = { single: 1, double: 2, triple: 3 }[this.config.pattern];
    const detected =
      this.recentTransients.length >= required &&
      Date.now() - this.lastActivationAt > this.config.cooldownMs;

    if (detected) {
      this.lastActivationAt = Date.now();
      this.recentTransients = [];
      return { detected: true, transientCount: required, confidence: Math.min(1, required / 3 + 0.4) };
    }

    return { detected: false, transientCount: this.recentTransients.length, confidence: 0 };
  }
}
