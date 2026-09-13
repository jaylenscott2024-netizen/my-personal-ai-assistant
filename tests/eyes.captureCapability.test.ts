import { describe, it, expect } from "vitest";
import {
  CaptureCapabilityEstimator,
  type CaptureWindowStats,
} from "../src/eyes/captureCapability.js";

function window(overrides: Partial<CaptureWindowStats> = {}): CaptureWindowStats {
  return {
    framesDelivered: 0,
    idleTimeouts: 0,
    framesDropped: 0,
    windowMs: 1000,
    meanFrameLatencyMs: null,
    ...overrides,
  };
}

/** A window where the display genuinely produced `fps` frames and the
 *  pipeline took all of them. */
function keptUp(fps: number, latencyMs = 4): CaptureWindowStats {
  return window({ framesDelivered: fps, meanFrameLatencyMs: latencyMs });
}

/** A window where the display offered more than the pipeline could take. */
function fellBehind(delivered: number, dropped: number): CaptureWindowStats {
  return window({ framesDelivered: delivered, framesDropped: dropped, meanFrameLatencyMs: 30 });
}

describe("CaptureCapabilityEstimator — the idle-desktop trap", () => {
  it("does NOT lower the estimate when the desktop was simply static", () => {
    // This is the single most important rule in the file. A change-driven
    // capture source produces nothing on a motionless desktop. Reading
    // that as "this machine can only manage 1 fps" would ratchet Eyes
    // down to uselessness and then never recover, because the lowered
    // target would stop it ever discovering the real ceiling again.
    const estimator = new CaptureCapabilityEstimator({ startFps: 60 });
    const before = estimator.targetFps;

    for (let i = 0; i < 10; i++) {
      estimator.record(window({ framesDelivered: 1, idleTimeouts: 59 }));
    }

    expect(estimator.targetFps).toBe(before);
    expect(estimator.report().lastVerdict).toBe("inconclusive");
  });

  it("reports sustainedFps as null — not a guess — until something conclusive is measured", () => {
    const estimator = new CaptureCapabilityEstimator({ startFps: 60 });
    estimator.record(window({ framesDelivered: 0, idleTimeouts: 60 }));

    const report = estimator.report();
    expect(report.sustainedFps).toBeNull();
    expect(report.conclusiveWindows).toBe(0);
    expect(report.windowsObserved).toBe(1);
  });

  it("counts dropped frames as conclusive overload even on an otherwise idle-looking window", () => {
    // Drops mean the source HAD work we couldn't take. That is capability
    // evidence regardless of how many idle timeouts accompany it.
    const estimator = new CaptureCapabilityEstimator({ startFps: 60 });
    expect(estimator.classify(window({ framesDelivered: 5, framesDropped: 20, idleTimeouts: 10 }))).toBe("overloaded");
  });

  it("treats under-target with no drops and no idle timeouts as overload", () => {
    // Nothing was waiting and nothing was dropped, yet the rate is short:
    // the pipeline itself is the bottleneck.
    const estimator = new CaptureCapabilityEstimator({ startFps: 60 });
    expect(estimator.classify(window({ framesDelivered: 20, idleTimeouts: 0 }))).toBe("overloaded");
  });
});

describe("CaptureCapabilityEstimator — probing upward", () => {
  it("probes above the starting rate once the machine proves it keeps up", () => {
    const estimator = new CaptureCapabilityEstimator({ startFps: 30, windowsBeforeRaise: 3 });
    for (let i = 0; i < 3; i++) estimator.record(keptUp(30));

    expect(estimator.targetFps).toBeGreaterThan(30);
  });

  it("does not raise on a single good window", () => {
    const estimator = new CaptureCapabilityEstimator({ startFps: 30, windowsBeforeRaise: 3 });
    estimator.record(keptUp(30));
    expect(estimator.targetFps).toBe(30);
  });

  it("does not let idle windows count toward a raise", () => {
    const estimator = new CaptureCapabilityEstimator({ startFps: 30, windowsBeforeRaise: 3 });
    estimator.record(keptUp(30));
    estimator.record(window({ framesDelivered: 0, idleTimeouts: 30 })); // idle — must not advance the streak
    estimator.record(keptUp(30));

    expect(estimator.targetFps).toBe(30);
  });

  it("never probes past the sanity ceiling", () => {
    const estimator = new CaptureCapabilityEstimator({ startFps: 100, maxFps: 120, windowsBeforeRaise: 1 });
    for (let i = 0; i < 40; i++) estimator.record(keptUp(Math.round(estimator.targetFps)));

    expect(estimator.targetFps).toBeLessThanOrEqual(120);
  });
});

describe("CaptureCapabilityEstimator — backing off honestly", () => {
  it("settles near what the machine actually achieved rather than a round number", () => {
    // A machine that manages ~83fps should land near 83 — not be rounded
    // down to 60 just because 60 is a familiar figure.
    const estimator = new CaptureCapabilityEstimator({ startFps: 144, backoffFactor: 1 });
    estimator.record(fellBehind(83, 40));

    expect(estimator.targetFps).toBeGreaterThan(75);
    expect(estimator.targetFps).toBeLessThan(90);
  });

  it("stops climbing once a probe overshoots and brackets the ceiling", () => {
    const estimator = new CaptureCapabilityEstimator({ startFps: 60, windowsBeforeRaise: 2 });
    estimator.record(keptUp(60));
    estimator.record(keptUp(60)); // raises above 60
    const probed = estimator.targetFps;
    expect(probed).toBeGreaterThan(60);

    estimator.record(fellBehind(60, 30)); // the probe was too ambitious
    expect(estimator.report().converged).toBe(true);

    const settled = estimator.targetFps;
    for (let i = 0; i < 10; i++) estimator.record(keptUp(Math.round(settled)));
    expect(estimator.targetFps).toBe(settled); // converged: no further climbing
  });

  it("never backs off below the configured floor", () => {
    const estimator = new CaptureCapabilityEstimator({ startFps: 60, minFps: 5 });
    for (let i = 0; i < 20; i++) estimator.record(fellBehind(0, 100));

    expect(estimator.targetFps).toBeGreaterThanOrEqual(5);
  });
});

describe("CaptureCapabilityEstimator — reporting", () => {
  it("accumulates delivered/dropped totals and mean latency across windows", () => {
    const estimator = new CaptureCapabilityEstimator({ startFps: 30 });
    estimator.record(window({ framesDelivered: 10, meanFrameLatencyMs: 10 }));
    estimator.record(window({ framesDelivered: 10, framesDropped: 2, meanFrameLatencyMs: 20 }));

    const report = estimator.report();
    expect(report.totalFramesDelivered).toBe(20);
    expect(report.totalFramesDropped).toBe(2);
    expect(report.meanFrameLatencyMs).toBe(15); // frame-weighted, not window-weighted
  });

  it("reset() returns to the unmeasured starting state", () => {
    const estimator = new CaptureCapabilityEstimator({ startFps: 30 });
    for (let i = 0; i < 5; i++) estimator.record(keptUp(30));
    estimator.reset();

    const report = estimator.report();
    expect(report.targetFps).toBe(30);
    expect(report.sustainedFps).toBeNull();
    expect(report.windowsObserved).toBe(0);
  });
});
