import { describe, it, expect, vi } from "vitest";
import { VisualPerceptionEngine } from "../src/eyes/visualPerceptionEngine.js";
import { coalesceLatest, type VisualSample } from "../src/eyes/visualStream.js";
import type { VisualProvider } from "../src/eyes/visualProvider.js";
import type {
  ContinuousCaptureOptions,
  ContinuousFrameSample,
  UIElementNode,
  VisualEvent,
  VisualFrame,
  VisualProviderCapabilities,
  WindowSummary,
} from "../src/eyes/types.js";

class FakeVisualProvider implements VisualProvider {
  readonly platform = "fake";
  private running = false;
  private onEvent: ((event: VisualEvent) => void) | null = null;
  private onFrame: ((frame: ContinuousFrameSample) => void) | null = null;
  captureCount = 0;
  captureDelayMs = 0;
  supportsCapture = true;
  supportsContinuousCapture = true;
  continuousCaptureFailure: Error | null = null;
  startContinuousCaptureCalls: ContinuousCaptureOptions[] = [];
  stopContinuousCaptureCalls = 0;

  get isRunning() {
    return this.running;
  }
  getCapabilities(): VisualProviderCapabilities {
    return {
      supported: true,
      windowEvents: true,
      uiAutomationEvents: true,
      uiAutomationQueries: true,
      onDemandFrameCapture: this.supportsCapture,
      continuousCapture: {
        supported: this.supportsContinuousCapture,
        technology: this.supportsContinuousCapture ? "fake_continuous_capture" : null,
        maxCaptureFps: null,
        supportsDirtyRects: true,
        supportsMultiDisplay: false,
      },
    };
  }
  async start(onEvent: (event: VisualEvent) => void): Promise<void> {
    this.running = true;
    this.onEvent = onEvent;
  }
  async stop(): Promise<void> {
    this.running = false;
    this.onEvent = null;
  }
  emit(event: VisualEvent): void {
    this.onEvent?.(event);
  }
  async listWindows(): Promise<WindowSummary[]> {
    return [];
  }
  async getUiTree(): Promise<UIElementNode> {
    return node();
  }
  async findUiElement(): Promise<UIElementNode[]> {
    return [];
  }
  async getUiElement(): Promise<UIElementNode> {
    return node();
  }
  async invokeUiElement() {}
  async setUiElementValue() {}
  async focusUiElement() {}
  async captureFrame(): Promise<VisualFrame> {
    this.captureCount++;
    if (this.captureDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.captureDelayMs));
    return { mimeType: "image/png", base64: "frame", region: null, capturedAt: new Date().toISOString() };
  }
  async startContinuousCapture(options: ContinuousCaptureOptions, onFrame: (frame: ContinuousFrameSample) => void): Promise<void> {
    if (this.continuousCaptureFailure) throw this.continuousCaptureFailure;
    this.startContinuousCaptureCalls.push(options);
    this.onFrame = onFrame;
  }
  async stopContinuousCapture(): Promise<void> {
    this.stopContinuousCaptureCalls++;
    this.onFrame = null;
  }
  emitFrame(overrides: Partial<ContinuousFrameSample> = {}): void {
    frameCounter++;
    this.onFrame?.({
      sequence: frameCounter,
      atMs: Date.now(),
      displayId: "0",
      width: 1920,
      height: 1080,
      changedRegions: [],
      changeScore: 0.8,
      frame: { mimeType: "image/jpeg", base64: `frame-${frameCounter}`, region: null, capturedAt: new Date().toISOString() },
      ...overrides,
    });
  }
}

function node(): UIElementNode {
  return { automationId: null, name: null, controlType: "Window", className: null, processName: null, windowTitle: null, boundingBox: null, enabled: true, focused: false, patterns: [], elementRef: "r", children: [] };
}

let windowCounter = 0;
let frameCounter = 0;
function makeEvent(overrides: Partial<VisualEvent> = {}): VisualEvent {
  windowCounter++;
  return {
    type: "window_focus_changed",
    at: new Date().toISOString(),
    attention: "primary",
    summary: `focus change ${windowCounter}`,
    // A distinct window each time, so AttentionManager's per-window
    // throttle doesn't suppress events this test needs delivered.
    window: { windowId: `w${windowCounter}`, processName: "app.exe", title: `Window ${windowCounter}`, isForeground: true, boundingBox: null },
    region: null,
    significance: 0.7,
    ...overrides,
  };
}

describe("VisualStream (VisualPerceptionEngine)", () => {
  it("delivers samples to subscribers and keeps the latest sample", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("stream-user", provider);
    await engine.start();

    const seen: VisualSample[] = [];
    engine.subscribe((sample) => seen.push(sample));

    provider.emit(makeEvent({ summary: "first" }));
    provider.emit(makeEvent({ summary: "second" }));

    expect(seen).toHaveLength(2);
    expect(seen[1].summary).toBe("second");
    expect(engine.getLatestSample()?.summary).toBe("second");
    // Every sample carries a wall-clock timestamp on the same epoch-ms
    // clock the voice pipeline stamps utterances with.
    expect(seen[0].atMs).toBeGreaterThan(0);
  });

  it("unsubscribe actually detaches the listener", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("stream-user-2", provider);
    await engine.start();

    const seen: VisualSample[] = [];
    const unsubscribe = engine.subscribe((sample) => seen.push(sample));
    provider.emit(makeEvent());
    unsubscribe();
    provider.emit(makeEvent());

    expect(seen).toHaveLength(1);
  });

  it("isolates a throwing subscriber so perception continues", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("stream-user-3", provider);
    await engine.start();

    engine.subscribe(() => {
      throw new Error("subscriber exploded");
    });
    const healthy: VisualSample[] = [];
    engine.subscribe((sample) => healthy.push(sample));

    expect(() => provider.emit(makeEvent())).not.toThrow();
    expect(healthy).toHaveLength(1);
    expect(engine.getState().initialized).toBe(true);
  });

  // THE latency requirement (Section 16): a slow consumer — which in
  // production is a cloud model round trip — must not slow perception.
  it("a slow async consumer never blocks the event path or loses the newest observation", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("stream-user-4", provider);
    await engine.start();

    let releaseHandler: (() => void) | null = null;
    const handled: string[] = [];
    const listener = coalesceLatest(async (sample) => {
      handled.push(sample.summary);
      await new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
    });
    engine.subscribe(listener);

    const startedAt = Date.now();
    for (let i = 0; i < 50; i++) provider.emit(makeEvent({ summary: `event-${i}` }));
    const elapsed = Date.now() - startedAt;

    // 50 events dispatched into a handler that has not returned once.
    expect(elapsed).toBeLessThan(200);
    // Exactly one call is in flight; the rest collapsed into one pending slot.
    expect(handled).toEqual(["event-0"]);
    expect(listener.stats().coalesced).toBeGreaterThan(0);
    // Perception itself recorded everything regardless of the consumer.
    expect(engine.queryHistory()).toHaveLength(50);
    expect(engine.getLatestSample()?.summary).toBe("event-49");

    // When the consumer finally frees up, it resumes on the FRESHEST
    // observation rather than replaying a stale backlog.
    releaseHandler!();
    await vi.waitFor(() => expect(handled).toHaveLength(2));
    expect(handled[1]).toBe("event-49");
  });

  it("keeps perceiving with no subscribers at all (no AI provider involved)", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("stream-user-5", provider);
    await engine.start();

    provider.emit(makeEvent());
    provider.emit(makeEvent());

    expect(engine.queryHistory()).toHaveLength(2);
    expect(engine.getCurrentState().initialized).toBe(true);
  });
});

// Section: continuous visual capture. This replaced an earlier model where
// pixels arrived only via an attention-triggered, on-demand `captureFrame`
// call made from inside the structural event path (screenshot-on-event).
// These tests are about the CURRENT model: pixels flow continuously and
// independently of structural events whenever enabled, and attention/
// significance governs retention, never whether capture happens at all.
describe("continuous visual capture", () => {
  it("never starts the continuous capture stream in the default structural-only mode", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("cc-user-1", provider);
    await engine.start();

    expect(provider.startContinuousCaptureCalls).toHaveLength(0);
    expect(engine.isCapturingContinuously).toBe(false);

    provider.emit(makeEvent({ significance: 0.95 }));
    expect(engine.queryHistory().every((sample) => sample.frame === null)).toBe(true);
  });

  it("starts the continuous capture stream once enabled, with the requested rates", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("cc-user-2", provider, {
      continuousCapturePolicy: { enabled: true, captureFps: 30, processingFps: 5, maxBufferedFrames: 50 },
    });
    await engine.start();

    expect(engine.isCapturingContinuously).toBe(true);
    expect(provider.startContinuousCaptureCalls).toHaveLength(1);
    expect(provider.startContinuousCaptureCalls[0]).toMatchObject({ captureFps: 30, processingFps: 5, maxBufferedFrames: 50 });
  });

  it("records continuously captured frames as their own samples, independent of structural events", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("cc-user-3", provider, {
      continuousCapturePolicy: { enabled: true, processingFps: 60 }, // effectively unthrottled for this test
    });
    await engine.start();

    provider.emitFrame();
    provider.emitFrame();

    const samples = engine.queryHistory();
    expect(samples).toHaveLength(2);
    expect(samples.every((s) => s.changeKind === "visual_motion")).toBe(true);
    expect(samples.every((s) => s.frame !== null)).toBe(true);
  });

  it("enforces processingFps itself: a tick arriving faster than the budget keeps its structural record but loses its pixels", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("cc-user-4", provider, {
      continuousCapturePolicy: { enabled: true, processingFps: 1 }, // one materialized frame per second, at most
    });
    await engine.start();

    const now = Date.now();
    provider.emitFrame({ atMs: now, changeScore: 0.2 });
    provider.emitFrame({ atMs: now + 10, changeScore: 0.2 }); // 10ms later — far under the 1000ms budget, and not significant

    const samples = engine.queryHistory();
    expect(samples).toHaveLength(2); // motion continuity never lost...
    expect(samples[0].frame).not.toBeNull(); // ...but only the first got to keep its pixels
    expect(samples[1].frame).toBeNull();
  });

  it("lets a significant change bypass the processingFps throttle", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("cc-user-5", provider, {
      continuousCapturePolicy: { enabled: true, processingFps: 1 },
      historyLimits: { warmSignificanceFloor: 0.6 },
    });
    await engine.start();

    const now = Date.now();
    provider.emitFrame({ atMs: now, changeScore: 0.2 });
    provider.emitFrame({ atMs: now + 10, changeScore: 0.9 }); // big change, moments later — still worth keeping

    const samples = engine.queryHistory();
    expect(samples[1].frame).not.toBeNull();
  });

  it("classifies attention from changeScore the same way structural events are scored", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("cc-user-6", provider, { continuousCapturePolicy: { enabled: true } });
    await engine.start();

    provider.emitFrame({ changeScore: 0.9 });
    provider.emitFrame({ changeScore: 0.1 });

    const samples = engine.queryHistory();
    expect(samples[0].attention).toBe("primary");
    expect(samples[1].attention).toBe("peripheral");
  });

  it("stays structural-only when the provider reports continuous capture unsupported, without ever falling back to on-demand capture", async () => {
    const provider = new FakeVisualProvider();
    provider.supportsContinuousCapture = false;
    const engine = new VisualPerceptionEngine("cc-user-7", provider, { continuousCapturePolicy: { enabled: true } });
    await engine.start();

    expect(engine.isCapturingContinuously).toBe(false);
    expect(provider.startContinuousCaptureCalls).toHaveLength(0);
    expect(provider.captureCount).toBe(0); // never substitutes captureFrame() for the unsupported stream
  });

  it("degrades to structural-only when starting continuous capture fails at runtime, without crashing engine startup", async () => {
    const provider = new FakeVisualProvider();
    provider.continuousCaptureFailure = new Error("no GPU adapter");
    const engine = new VisualPerceptionEngine("cc-user-8", provider, { continuousCapturePolicy: { enabled: true } });

    await expect(engine.start()).resolves.toBeUndefined();
    expect(engine.isCapturingContinuously).toBe(false);
    expect(engine.isRunning).toBe(true); // structural perception is entirely unaffected
  });

  it("stops continuous capture when the engine stops", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("cc-user-9", provider, { continuousCapturePolicy: { enabled: true } });
    await engine.start();
    expect(engine.isCapturingContinuously).toBe(true);

    await engine.stop();
    expect(provider.stopContinuousCaptureCalls).toBe(1);
    expect(engine.isCapturingContinuously).toBe(false);
  });

  it("starts/stops the stream live when the policy is changed via setContinuousCapturePolicy", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("cc-user-10", provider); // starts disabled
    await engine.start();
    expect(engine.isCapturingContinuously).toBe(false);

    await engine.setContinuousCapturePolicy({ enabled: true });
    expect(engine.isCapturingContinuously).toBe(true);
    expect(provider.startContinuousCaptureCalls).toHaveLength(1);

    await engine.setContinuousCapturePolicy({ enabled: false });
    expect(engine.isCapturingContinuously).toBe(false);
    expect(provider.stopContinuousCaptureCalls).toBe(1);
  });

  it("a slow continuous-capture consumer never blocks the frame ingestion path either", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("cc-user-11", provider, { continuousCapturePolicy: { enabled: true, processingFps: 60 } });
    await engine.start();

    engine.subscribe(coalesceLatest(() => new Promise<void>(() => {})));

    const startedAt = Date.now();
    for (let i = 0; i < 50; i++) provider.emitFrame();
    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(engine.queryHistory()).toHaveLength(50);
  });
});
