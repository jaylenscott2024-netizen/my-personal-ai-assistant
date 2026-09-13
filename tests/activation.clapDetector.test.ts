import { describe, it, expect } from "vitest";
import { ClapDetector } from "../src/activation/clapDetector.js";

function makeFrame(amplitude: number, numSamples: number): Buffer {
  const samples = new Int16Array(numSamples).fill(amplitude);
  return Buffer.from(samples.buffer);
}

function concatFrames(frames: Buffer[]): Buffer {
  return Buffer.concat(frames);
}

// 16kHz, 20ms frames => 320 samples/frame (matches clapDetector.ts internals).
const FRAME_SAMPLES = 320;

describe("ClapDetector", () => {
  it("detects a double-clap pattern: two sharp transients separated by quiet", () => {
    const detector = new ClapDetector({ pattern: "double", sensitivity: 3.0, sampleRate: 16_000 });
    const quiet = () => makeFrame(50, FRAME_SAMPLES);
    const clap = () => makeFrame(4000, FRAME_SAMPLES);

    // Frames are 20ms each; the detector merges transients closer than
    // 80ms, so leave >=5 quiet frames (100ms) between the two claps.
    const buffer = concatFrames([quiet(), quiet(), quiet(), clap(), quiet(), quiet(), quiet(), quiet(), quiet(), clap(), quiet(), quiet()]);
    const result = detector.processChunk(buffer);

    expect(result.detected).toBe(true);
    expect(result.transientCount).toBe(2);
  });

  it("does not mistake a continuous loud tone (e.g. music) for a clap pattern", () => {
    const detector = new ClapDetector({ pattern: "double", sensitivity: 3.0, sampleRate: 16_000 });
    const quiet = () => makeFrame(50, FRAME_SAMPLES);
    const loudSustained = () => makeFrame(1000, FRAME_SAMPLES);

    // One onset into sustained loudness, then flat — not two distinct spikes.
    const buffer = concatFrames([quiet(), quiet(), loudSustained(), loudSustained(), loudSustained(), loudSustained()]);
    const result = detector.processChunk(buffer);

    expect(result.detected).toBe(false);
  });

  it("ignores gradually-rising energy (e.g. a door, an echo tail)", () => {
    const detector = new ClapDetector({ pattern: "single", sensitivity: 3.0, sampleRate: 16_000 });
    const ramp = [50, 80, 120, 180, 260, 380].map((amp) => makeFrame(amp, FRAME_SAMPLES));
    const result = detector.processChunk(concatFrames(ramp));
    expect(result.detected).toBe(false);
  });

  it("respects a cooldown so a rapid repeat does not double-fire", () => {
    const detector = new ClapDetector({ pattern: "single", sensitivity: 3.0, cooldownMs: 1500, sampleRate: 16_000 });
    const quiet = () => makeFrame(50, FRAME_SAMPLES);
    const clap = () => makeFrame(4000, FRAME_SAMPLES);

    const first = detector.processChunk(concatFrames([quiet(), quiet(), clap(), quiet()]));
    expect(first.detected).toBe(true);

    const second = detector.processChunk(concatFrames([quiet(), quiet(), clap(), quiet()]));
    expect(second.detected).toBe(false); // still inside the cooldown window
  });

  it("does nothing when disabled", () => {
    const detector = new ClapDetector({ enabled: false });
    const result = detector.processChunk(concatFrames([makeFrame(4000, FRAME_SAMPLES), makeFrame(4000, FRAME_SAMPLES)]));
    expect(result.detected).toBe(false);
    expect(result.transientCount).toBe(0);
  });
});
