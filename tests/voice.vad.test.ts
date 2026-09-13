import { describe, it, expect } from "vitest";
import { UtteranceSegmenter, pcm16ToWav } from "../src/voice/vad.js";

// 16kHz, 20ms frames => 320 samples/frame (matches vad.ts internals).
const FRAME_SAMPLES = 320;

function makeFrame(amplitude: number, numSamples = FRAME_SAMPLES): Buffer {
  const samples = new Int16Array(numSamples).fill(amplitude);
  return Buffer.from(samples.buffer);
}

function repeat(frame: Buffer, times: number): Buffer[] {
  return Array.from({ length: times }, () => frame);
}

function concatFrames(frames: Buffer[]): Buffer {
  return Buffer.concat(frames);
}

describe("UtteranceSegmenter", () => {
  it("detects speech start after sustained energy, not a single spike", () => {
    const segmenter = new UtteranceSegmenter({ minSpeechFramesToStart: 3 });
    const quiet = makeFrame(50);
    const loud = makeFrame(2000);

    // A single loud frame among quiet ones should not start an utterance.
    const singleSpike = segmenter.process(concatFrames([quiet, quiet, loud, quiet, quiet]));
    expect(singleSpike.some((e) => e.type === "speech_start")).toBe(false);
  });

  it("emits speech_start once sustained speech begins, and speech_end after trailing silence", () => {
    const segmenter = new UtteranceSegmenter({ minSpeechFramesToStart: 3, silenceMsToEnd: 200, minUtteranceMs: 100, frameMs: 20 });
    const quiet = makeFrame(50);
    const loud = makeFrame(2000);

    const startEvents = segmenter.process(concatFrames([...repeat(quiet, 3), ...repeat(loud, 5)]));
    expect(startEvents.some((e) => e.type === "speech_start")).toBe(true);
    expect(segmenter.isSpeaking).toBe(true);

    // 200ms of trailing silence (10 frames @ 20ms) should end the utterance.
    const endEvents = segmenter.process(concatFrames(repeat(quiet, 12)));
    const endEvent = endEvents.find((e) => e.type === "speech_end");
    expect(endEvent).toBeDefined();
    expect(segmenter.isSpeaking).toBe(false);
  });

  it("discards an utterance shorter than minUtteranceMs instead of treating it as real speech", () => {
    const segmenter = new UtteranceSegmenter({ minSpeechFramesToStart: 2, silenceMsToEnd: 100, minUtteranceMs: 500, frameMs: 20 });
    const quiet = makeFrame(50);
    const loud = makeFrame(2000);

    // ~60ms of speech (well under the 500ms minimum) then silence.
    const events = segmenter.process(concatFrames([...repeat(quiet, 3), ...repeat(loud, 3), ...repeat(quiet, 10)]));
    expect(events.some((e) => e.type === "speech_end")).toBe(false);
    expect(events.some((e) => e.type === "speech_discarded")).toBe(true);
  });

  it("does not end an utterance on a brief pause shorter than silenceMsToEnd", () => {
    const segmenter = new UtteranceSegmenter({ minSpeechFramesToStart: 2, silenceMsToEnd: 400, minUtteranceMs: 50, frameMs: 20 });
    const quiet = makeFrame(50);
    const loud = makeFrame(2000);

    // Speech, brief 100ms pause (5 frames), more speech — should still be one utterance.
    segmenter.process(concatFrames([...repeat(quiet, 3), ...repeat(loud, 5)]));
    expect(segmenter.isSpeaking).toBe(true);

    const midEvents = segmenter.process(concatFrames(repeat(quiet, 5))); // 100ms, under the 400ms threshold
    expect(midEvents.some((e) => e.type === "speech_end")).toBe(false);
    expect(segmenter.isSpeaking).toBe(true);

    const moreSpeech = segmenter.process(concatFrames(repeat(loud, 3)));
    expect(moreSpeech.some((e) => e.type === "speech_start")).toBe(false); // still the same utterance
  });

  it("forceEnd() ends the utterance immediately for push-to-talk release", () => {
    const segmenter = new UtteranceSegmenter({ minSpeechFramesToStart: 2, minUtteranceMs: 50, frameMs: 20 });
    const quiet = makeFrame(50);
    const loud = makeFrame(2000);

    segmenter.process(concatFrames([...repeat(quiet, 3), ...repeat(loud, 5)]));
    expect(segmenter.isSpeaking).toBe(true);

    const event = segmenter.forceEnd();
    expect(event?.type).toBe("speech_end");
    expect(segmenter.isSpeaking).toBe(false);
  });

  it("forceEnd() returns null when nothing was being spoken", () => {
    const segmenter = new UtteranceSegmenter();
    expect(segmenter.forceEnd()).toBeNull();
  });

  it("ignores a continuous loud tone as a single ongoing utterance, not repeated starts", () => {
    const segmenter = new UtteranceSegmenter({ minSpeechFramesToStart: 3, frameMs: 20 });
    const quiet = makeFrame(50);
    const loud = makeFrame(2000);

    const first = segmenter.process(concatFrames([...repeat(quiet, 3), ...repeat(loud, 10)]));
    expect(first.filter((e) => e.type === "speech_start").length).toBe(1);

    const continued = segmenter.process(concatFrames(repeat(loud, 10)));
    expect(continued.filter((e) => e.type === "speech_start").length).toBe(0);
  });
});

describe("pcm16ToWav", () => {
  it("produces a valid, correctly-sized WAV header", () => {
    const pcm = Buffer.from(new Int16Array([1, 2, 3, 4]).buffer);
    const wav = pcm16ToWav(pcm, 16_000);

    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(16_000); // sample rate
    expect(wav.readUInt32LE(40)).toBe(pcm.length); // data chunk size
    expect(wav.length).toBe(44 + pcm.length);
  });
});
