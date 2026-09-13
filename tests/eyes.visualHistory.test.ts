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

// Section 4: the temporal buffer is what makes "what just happened?"
// answerable without any capture at query time — but it lives in RAM, so
// every one of its bounds is load-bearing.
describe("VisualHistory bounds", () => {
  it("caps retained samples by count, dropping the oldest", () => {
    const history = new VisualHistory({ maxSamples: 3, maxAgeMs: 10 * 60_000, maxFrames: 100, maxFrameBytes: 10 ** 9 });
    const first = sample();
    history.record(first);
    history.record(sample());
    history.record(sample());
    history.record(sample());

    const retained = history.query({}, first.atMs + 1000);
    expect(retained).toHaveLength(3);
    expect(retained.includes(first)).toBe(false);
    expect(history.stats(first.atMs + 1000).droppedSamples).toBe(1);
  });

  it("evicts by age on both write and read", () => {
    const now = 2_000_000;
    const history = new VisualHistory({ maxSamples: 100, maxAgeMs: 5_000, maxFrames: 100, maxFrameBytes: 10 ** 9 });
    history.record(sample({ atMs: now - 60_000 }));
    history.record(sample({ atMs: now - 1_000 }));

    expect(history.query({}, now)).toHaveLength(1);
  });

  it("strips frame payloads beyond the frame-count budget but keeps the structural record", () => {
    const history = new VisualHistory({ maxSamples: 100, maxAgeMs: 600_000, maxFrames: 2, maxFrameBytes: 10 ** 9 });
    const samples = [sample({ frame: frame() }), sample({ frame: frame() }), sample({ frame: frame() })];
    for (const s of samples) history.record(s);

    const retained = history.query({}, samples[2].atMs + 10);
    // The timeline survives intact...
    expect(retained).toHaveLength(3);
    // ...but only the newest two still carry pixels.
    expect(retained.filter((s) => s.frame !== null)).toHaveLength(2);
    expect(retained[0].frame).toBeNull();
    expect(retained[0].summary).toBeTruthy();
  });

  it("strips frame payloads beyond the byte budget, oldest first", () => {
    const history = new VisualHistory({ maxSamples: 100, maxAgeMs: 600_000, maxFrames: 100, maxFrameBytes: 2_000 });
    const a = sample({ frame: frame(1_600) }); // ~1200 bytes decoded
    const b = sample({ frame: frame(1_600) });
    history.record(a);
    history.record(b);

    const stats = history.stats(b.atMs + 10);
    expect(stats.approxFrameBytes).toBeLessThanOrEqual(2_000);
    expect(stats.strippedFrames).toBeGreaterThan(0);
    expect(a.frame).toBeNull();
    expect(b.frame).not.toBeNull(); // newest imagery is the one worth keeping
  });

  it("setLimits re-enforces immediately against already-retained samples", () => {
    const history = new VisualHistory({ maxSamples: 100, maxAgeMs: 600_000, maxFrames: 100, maxFrameBytes: 10 ** 9 });
    for (let i = 0; i < 10; i++) history.record(sample());
    history.setLimits({ maxSamples: 4 });
    expect(history.query({}, Date.now()).length).toBeLessThanOrEqual(4);
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
});

describe("importanceOf", () => {
  it("maps salience onto the importance bands the query API exposes", () => {
    expect(importanceOf(0.9)).toBe("high");
    expect(importanceOf(0.5)).toBe("medium");
    expect(importanceOf(0.1)).toBe("low");
  });
});
