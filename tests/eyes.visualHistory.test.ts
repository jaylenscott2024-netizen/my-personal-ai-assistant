import { describe, it, expect } from "vitest";
import { VisualHistory, importanceOf } from "../src/eyes/visualHistory.js";
import type { VisualSample } from "../src/eyes/visualStream.js";
import type { VisualFrame } from "../src/eyes/types.js";

let counter = 0;
function sample(overrides: Partial<VisualSample> = {}): VisualSample {
  counter++;
  return {
    id: `s${counter}`,
    atMs: 1_000_000 + counter,
    source: { displayId: "primary", windowId: `w${counter}`, processName: "app.exe", windowTitle: "Window" },
    changeKind: "window_focus",
    attentionScore: 0.7,
    attention: "primary",
    summary: `change ${counter}`,
    changedRegions: [],
    dimensions: null,
    uiContext: null,
    frame: null,
    ...overrides,
  };
}

function frame(bytes = 1200): VisualFrame {
  return { mimeType: "image/png", base64: "a".repeat(bytes), region: null, capturedAt: new Date().toISOString() };
}

// Section 4: HIGH-FREQUENCY SHORT BUFFER (hot) + LOW-FREQUENCY LONGER
// BUFFER (warm) + SIGNIFICANT-EVENT KEYFRAMES — the three-tier model a
// continuous capture stream actually needs. Every accepted observation
// lands in hot unconditionally; warm and keyframes are independent,
// narrower promotions from the same stream.
describe("VisualHistory tiering", () => {
  it("writes every observation to the hot tier regardless of significance", () => {
    const history = new VisualHistory({ hotMaxSamples: 10, hotMaxAgeMs: 60_000 });
    const now = Date.now();
    for (let i = 0; i < 5; i++) history.record(sample({ atMs: now + i, attentionScore: 0.05 }));

    expect(history.stats(now + 100).tiers.hot).toBe(5);
    expect(history.query({}, now + 100)).toHaveLength(5);
  });

  it("bounds the hot tier by count independently of the warm/keyframe limits", () => {
    const history = new VisualHistory({ hotMaxSamples: 3, maxSamples: 100, maxAgeMs: 600_000 });
    const now = Date.now();
    for (let i = 0; i < 5; i++) history.record(sample({ atMs: now + i, attentionScore: 0.05 }));

    expect(history.stats(now + 100).tiers.hot).toBeLessThanOrEqual(3);
  });

  it("bounds the hot tier by age independently of the warm tier's age", () => {
    const history = new VisualHistory({ hotMaxSamples: 100, hotMaxAgeMs: 1_000, maxAgeMs: 600_000 });
    const now = 2_000_000;
    history.record(sample({ atMs: now - 5_000, attentionScore: 0.05 })); // old — should age out of hot
    history.record(sample({ atMs: now - 100, attentionScore: 0.05 }));

    expect(history.stats(now).tiers.hot).toBe(1);
  });

  it("promotes into the warm tier on a time bucket even without high significance", () => {
    const history = new VisualHistory({ warmBucketMs: 1_000, warmSignificanceFloor: 0.9, maxSamples: 100, maxAgeMs: 600_000 });
    const now = 1_000_000;
    history.record(sample({ atMs: now, attentionScore: 0.1 }));
    history.record(sample({ atMs: now + 1_500, attentionScore: 0.1 })); // past the bucket window

    expect(history.stats(now + 1_500).tiers.warm).toBe(2);
  });

  it("promotes into the warm tier ahead of schedule when significance is high enough", () => {
    const history = new VisualHistory({ warmBucketMs: 10_000, warmSignificanceFloor: 0.6, maxSamples: 100, maxAgeMs: 600_000 });
    const now = 1_000_000;
    history.record(sample({ atMs: now, attentionScore: 0.1 }));
    history.record(sample({ atMs: now + 50, attentionScore: 0.9 })); // well inside the bucket window, but significant

    expect(history.stats(now + 50).tiers.warm).toBe(2);
  });

  it("keeps a frame governed by the shared budget even once only the warm tier still holds it", () => {
    // Promotion never copies or strips — a sample keeps whatever it
    // arrived with wherever it's retained. So the frame budget has to
    // scan every tier a sample could be sitting in, not just hot/
    // keyframes, or a frame that outlives hot's short window but is
    // still held by warm's much longer one would silently escape the
    // bound. This proves that doesn't happen.
    const history = new VisualHistory({
      hotMaxSamples: 100,
      hotMaxAgeMs: 50, // hot ages this out almost immediately
      warmBucketMs: 0,
      maxSamples: 100,
      maxAgeMs: 600_000,
      maxFrames: 1,
      maxFrameBytes: 10 ** 9,
      keyframeMinAttentionScore: 0.99, // high enough that this sample never becomes a keyframe either
    });
    const now = Date.now();
    const older = sample({ atMs: now, attentionScore: 0.5, frame: frame() });
    history.record(older);

    // Age hot out, then record a second framed sample — the budget
    // (maxFrames: 1) must still find `older` via the warm tier to strip.
    const newer = sample({ atMs: now + 1_000, attentionScore: 0.5, frame: frame() });
    history.record(newer);

    expect(history.stats(now + 1_000).tiers.hot).toBe(1); // `older` has aged out of hot
    expect(older.frame).toBeNull(); // ...but the budget still found and stripped it via warm
    expect(newer.frame).not.toBeNull();
  });

  it("promotes into the keyframe tier only when the sample carries a frame AND clears the threshold", () => {
    const history = new VisualHistory({ keyframeMinAttentionScore: 0.7, maxSamples: 100, maxAgeMs: 600_000 });
    const now = Date.now();
    history.record(sample({ atMs: now, attentionScore: 0.9, frame: null })); // significant but no pixels
    history.record(sample({ atMs: now + 1, attentionScore: 0.3, frame: frame() })); // pixels but not significant
    history.record(sample({ atMs: now + 2, attentionScore: 0.9, frame: frame() })); // both

    expect(history.stats(now + 2).tiers.keyframes).toBe(1);
  });

  it("merges and deduplicates across tiers on query rather than double-counting shared samples", () => {
    const history = new VisualHistory({ warmBucketMs: 0, keyframeMinAttentionScore: 0.5, maxSamples: 100, maxAgeMs: 600_000 });
    const now = Date.now();
    // High significance + a frame: eligible for hot, warm, AND keyframes simultaneously.
    history.record(sample({ atMs: now, attentionScore: 0.9, frame: frame() }));

    expect(history.query({}, now)).toHaveLength(1);
    expect(history.stats(now).samples).toBe(1);
  });

  it("clear() empties every tier", () => {
    const history = new VisualHistory();
    history.record(sample({ attentionScore: 0.9, frame: frame() }));
    history.clear();

    const stats = history.stats(Date.now());
    expect(stats.samples).toBe(0);
    expect(stats.tiers).toEqual({ hot: 0, warm: 0, keyframes: 0 });
    expect(history.latest()).toBeNull();
  });
});

describe("VisualHistory frame budget", () => {
  it("strips frame payloads beyond the frame-count budget but keeps the structural record", () => {
    const history = new VisualHistory({ maxFrames: 2, maxFrameBytes: 10 ** 9, keyframeMinAttentionScore: 0.5, warmBucketMs: 0 });
    const now = Date.now();
    const samples = [
      sample({ atMs: now, attentionScore: 0.9, frame: frame() }),
      sample({ atMs: now + 1, attentionScore: 0.9, frame: frame() }),
      sample({ atMs: now + 2, attentionScore: 0.9, frame: frame() }),
    ];
    for (const s of samples) history.record(s);

    const retained = history.query({}, now + 2);
    // The timeline survives intact...
    expect(retained).toHaveLength(3);
    // ...but only the newest two still carry pixels.
    expect(retained.filter((s) => s.frame !== null)).toHaveLength(2);
    expect(retained[0].frame).toBeNull();
    expect(retained[0].summary).toBeTruthy();
  });

  it("strips frame payloads beyond the byte budget, oldest first", () => {
    const history = new VisualHistory({ maxFrames: 100, maxFrameBytes: 2_000, keyframeMinAttentionScore: 0.5 });
    const now = Date.now();
    const a = sample({ atMs: now, attentionScore: 0.9, frame: frame(1_600) });
    const b = sample({ atMs: now + 1, attentionScore: 0.9, frame: frame(1_600) });
    history.record(a);
    history.record(b);

    const stats = history.stats(now + 1);
    expect(stats.approxFrameBytes).toBeLessThanOrEqual(2_000);
    expect(stats.strippedFrames).toBeGreaterThan(0);
    expect(a.frame).toBeNull();
    expect(b.frame).not.toBeNull(); // newest imagery is the one worth keeping
  });

  it("setLimits re-enforces the frame budget immediately against already-retained samples", () => {
    const history = new VisualHistory({ maxFrames: 100, maxFrameBytes: 10 ** 9, keyframeMinAttentionScore: 0.5 });
    const now = Date.now();
    for (let i = 0; i < 10; i++) history.record(sample({ atMs: now + i, attentionScore: 0.9, frame: frame() }));

    history.setLimits({ maxFrames: 2 });
    expect(history.stats(now + 10).frames).toBeLessThanOrEqual(2);
  });
});

describe("VisualHistory queries", () => {
  it("filters by time range", () => {
    const history = new VisualHistory();
    const base = Date.now();
    history.record(sample({ atMs: base - 30_000 }));
    const recent = sample({ atMs: base - 1_000 });
    history.record(recent);

    const result = history.query({ since: base - 5_000 }, base);
    expect(result).toEqual([recent]);
  });

  it("filters by importance floor", () => {
    const history = new VisualHistory();
    const now = Date.now();
    history.record(sample({ atMs: now - 10, attentionScore: 0.1 }));
    const salient = sample({ atMs: now - 5, attentionScore: 0.85 });
    history.record(salient);

    expect(history.query({ importance: "high" }, now)).toEqual([salient]);
    expect(history.query({ importance: "low" }, now)).toHaveLength(2);
  });

  it("filters to samples that actually carry pixels", () => {
    const history = new VisualHistory();
    const now = Date.now();
    history.record(sample({ atMs: now - 10 }));
    const withFrame = sample({ atMs: now - 5, frame: frame() });
    history.record(withFrame);

    expect(history.query({ requireFrame: true }, now)).toEqual([withFrame]);
  });

  it("caps to the most recent N but returns them chronologically", () => {
    const history = new VisualHistory();
    const now = Date.now();
    const samples = [0, 1, 2, 3].map((i) => sample({ atMs: now - (10 - i) }));
    for (const s of samples) history.record(s);

    const result = history.query({ maxSamples: 2 }, now);
    expect(result).toEqual([samples[2], samples[3]]);
  });

  it("filters by change kind", () => {
    const history = new VisualHistory();
    const now = Date.now();
    history.record(sample({ atMs: now - 10, changeKind: "window_geometry" }));
    const notification = sample({ atMs: now - 5, changeKind: "notification" });
    history.record(notification);

    expect(history.query({ changeKinds: ["notification"] }, now)).toEqual([notification]);
  });

  it("clears entirely (what stop() does — visual memory dies with the session)", () => {
    const history = new VisualHistory();
    history.record(sample());
    history.clear();
    expect(history.query({}, Date.now())).toHaveLength(0);
  });

  it("latest() always reflects the most recent observation regardless of which tiers hold it", () => {
    const history = new VisualHistory();
    const now = Date.now();
    history.record(sample({ atMs: now - 100, summary: "older" }));
    const newest = sample({ atMs: now, summary: "newest" });
    history.record(newest);

    expect(history.latest()).toBe(newest);
  });
});

describe("importanceOf", () => {
  it("maps salience onto the importance bands the query API exposes", () => {
    expect(importanceOf(0.9)).toBe("high");
    expect(importanceOf(0.5)).toBe("medium");
    expect(importanceOf(0.1)).toBe("low");
  });
});
