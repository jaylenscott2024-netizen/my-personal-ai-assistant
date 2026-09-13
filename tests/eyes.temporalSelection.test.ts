import { describe, it, expect } from "vitest";
import { buildVisualContext, selectSamples, relativeLabel } from "../src/eyes/visualContext.js";
import { VisualHistory } from "../src/eyes/visualHistory.js";
import type { VisualSample } from "../src/eyes/visualStream.js";
import type { VisualFrame, VisualState } from "../src/eyes/types.js";

const NOW = 1_700_000_000_000;

let counter = 0;
function sample(overrides: Partial<VisualSample> = {}): VisualSample {
  counter++;
  return {
    id: `s${counter}`,
    atMs: NOW - 1000,
    source: { displayId: "primary", windowId: `w${counter}`, processName: "app.exe", windowTitle: "Window" },
    changeKind: "window_focus",
    attentionScore: 0.5,
    attention: "primary",
    summary: `change ${counter}`,
    changedRegions: [],
    dimensions: null,
    uiContext: null,
    frame: null,
    ...overrides,
  };
}

function frame(): VisualFrame {
  return { mimeType: "image/png", base64: "img", region: null, capturedAt: new Date(NOW).toISOString() };
}

const state: VisualState = {
  initialized: true,
  foregroundWindow: { windowId: "w1", processName: "chrome.exe", title: "GitHub", isForeground: true, boundingBox: null },
  windows: [],
  primaryFocus: null,
  recentEvents: [],
  lastUpdatedAt: new Date(NOW).toISOString(),
};

function historyWith(samples: VisualSample[]): VisualHistory {
  const history = new VisualHistory({ maxSamples: 500, maxAgeMs: 600_000, maxFrames: 500, maxFrameBytes: 10 ** 9 });
  for (const s of samples) history.record(s);
  return history;
}

// Section 12: purposes drive how far back Jarvis looks and how much it
// returns — the whole point of asking a *question* rather than requesting
// "n frames".
describe("purpose-driven context building", () => {
  it("current_state answers with just the latest observation", () => {
    const history = historyWith([
      sample({ atMs: NOW - 20_000 }),
      sample({ atMs: NOW - 2_000 }),
      sample({ atMs: NOW - 500, summary: "latest thing" }),
    ]);
    const context = buildVisualContext(state, history, { purpose: "current_state" }, NOW);

    expect(context.samples).toHaveLength(1);
    expect(context.samples[0].summary).toBe("latest thing");
  });

  it("what_just_happened reaches further back and returns a sequence", () => {
    const history = historyWith(
      Array.from({ length: 6 }, (_, i) => sample({ atMs: NOW - (6 - i) * 2_000, attentionScore: 0.6 })),
    );
    const context = buildVisualContext(state, history, { purpose: "what_just_happened" }, NOW);

    expect(context.samples.length).toBeGreaterThan(1);
    // Always chronological — a sequence out of order is worse than none.
    const times = context.samples.map((s) => s.atMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("what_changed pairs the peak change with the observation right before it", () => {
    const before = sample({ atMs: NOW - 10_000, attentionScore: 0.45, summary: "before the change" });
    const peak = sample({ atMs: NOW - 9_000, attentionScore: 0.98, summary: "the big change" });
    const noise = sample({ atMs: NOW - 5_000, attentionScore: 0.45, summary: "noise" });
    const latest = sample({ atMs: NOW - 1_000, attentionScore: 0.45, summary: "latest" });
    const context = buildVisualContext(state, historyWith([before, peak, noise, latest]), { purpose: "what_changed", detail: "low" }, NOW);

    const summaries = context.samples.map((s) => s.summary);
    expect(summaries).toContain("the big change");
    expect(summaries).toContain("before the change");
  });

  it("respects an explicit attention threshold and time window", () => {
    const history = historyWith([
      sample({ atMs: NOW - 120_000, attentionScore: 0.95, summary: "too old" }),
      sample({ atMs: NOW - 3_000, attentionScore: 0.1, summary: "too boring" }),
      sample({ atMs: NOW - 2_000, attentionScore: 0.9, summary: "just right" }),
    ]);
    const context = buildVisualContext(
      state,
      history,
      { purpose: "follow_visual_activity", since: NOW - 10_000, attentionThreshold: 0.5 },
      NOW,
    );

    expect(context.samples.map((s) => s.summary)).toEqual(["just right"]);
  });

  it("detail scales how many observations come back", () => {
    const history = historyWith(Array.from({ length: 12 }, (_, i) => sample({ atMs: NOW - (12 - i) * 1_000, attentionScore: 0.6 })));
    const low = buildVisualContext(state, history, { purpose: "follow_visual_activity", detail: "low" }, NOW);
    const high = buildVisualContext(state, history, { purpose: "follow_visual_activity", detail: "high" }, NOW);

    expect(high.samples.length).toBeGreaterThan(low.samples.length);
  });

  it("still returns the newest observation when nothing clears the threshold", () => {
    const only = sample({ atMs: NOW - 1_000, attentionScore: 0.05, summary: "quiet" });
    const context = buildVisualContext(state, historyWith([only]), { purpose: "what_changed" }, NOW);

    expect(context.samples).toHaveLength(1);
    expect(context.currentSample?.summary).toBe("quiet");
  });

  it("produces an empty, honest context when nothing has been observed", () => {
    const context = buildVisualContext(state, historyWith([]), { purpose: "what_just_happened" }, NOW);
    expect(context.samples).toHaveLength(0);
    expect(context.temporalSummary).toContain("No visual changes were observed");
  });

  it("renders a summary carrying the foreground window, relative times and image markers", () => {
    const history = historyWith([sample({ atMs: NOW - 3_200, summary: "Slack opened", frame: frame() })]);
    const context = buildVisualContext(state, history, { purpose: "what_just_happened" }, NOW);

    expect(context.temporalSummary).toContain("chrome.exe");
    expect(context.temporalSummary).toContain("Slack opened");
    expect(context.temporalSummary).toContain("-3.2s");
    expect(context.temporalSummary).toContain("[image attached]");
  });
});

describe("selectSamples ranking", () => {
  it("returns everything when the pool fits the budget", () => {
    const pool = [sample(), sample()];
    expect(selectSamples(pool, { maxSamples: 5, pairAroundPeak: true })).toEqual(pool);
  });

  it("always keeps the newest observation", () => {
    const pool = Array.from({ length: 10 }, (_, i) => sample({ atMs: NOW - (10 - i) * 1_000, attentionScore: 0.3 }));
    const selected = selectSamples(pool, { maxSamples: 2, pairAroundPeak: false });
    expect(selected[selected.length - 1]).toBe(pool[pool.length - 1]);
  });

  it("prefers salient observations over trivial ones", () => {
    const trivial = Array.from({ length: 6 }, (_, i) => sample({ atMs: NOW - (10 - i) * 1_000, attentionScore: 0.05 }));
    const salient = sample({ atMs: NOW - 3_500, attentionScore: 0.99, summary: "salient" });
    const selected = selectSamples([...trivial, salient], { maxSamples: 3, pairAroundPeak: false });

    expect(selected.map((s) => s.summary)).toContain("salient");
  });

  it("prefers observations that actually carry pixels, all else equal", () => {
    const plain = Array.from({ length: 5 }, (_, i) => sample({ atMs: NOW - (10 - i) * 1_000, attentionScore: 0.5 }));
    const withFrame = sample({ atMs: NOW - 4_500, attentionScore: 0.5, summary: "framed", frame: frame() });
    const selected = selectSamples([...plain, withFrame], { maxSamples: 3, pairAroundPeak: false });

    expect(selected.map((s) => s.summary)).toContain("framed");
  });

  it("avoids near-duplicate moments so the budget buys distinct information", () => {
    const cluster = Array.from({ length: 5 }, (_, i) => sample({ atMs: NOW - 5_000 + i * 50, attentionScore: 0.8 }));
    const distinct = sample({ atMs: NOW - 1_000, attentionScore: 0.8, summary: "distinct" });
    const selected = selectSamples([...cluster, distinct], { maxSamples: 3, pairAroundPeak: false });

    const times = selected.map((s) => s.atMs).sort((a, b) => a - b);
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(750);
    }
  });
});

describe("relativeLabel", () => {
  it("labels observations by age so a model can order them", () => {
    expect(relativeLabel(NOW, NOW)).toBe("now");
    expect(relativeLabel(NOW - 2_500, NOW)).toBe("-2.5s");
  });
});
