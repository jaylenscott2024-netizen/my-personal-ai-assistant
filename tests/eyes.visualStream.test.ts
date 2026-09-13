import { describe, it, expect, vi } from "vitest";
import { VisualPerceptionEngine } from "../src/eyes/visualPerceptionEngine.js";
import { coalesceLatest, type VisualSample } from "../src/eyes/visualStream.js";
import type { VisualProvider } from "../src/eyes/visualProvider.js";
import type { UIElementNode, VisualEvent, VisualFrame, VisualProviderCapabilities, WindowSummary } from "../src/eyes/types.js";

class FakeVisualProvider implements VisualProvider {
  readonly platform = "fake";
  private running = false;
  private onEvent: ((event: VisualEvent) => void) | null = null;
  captureCount = 0;
  captureDelayMs = 0;
  supportsCapture = true;

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
}

function node(): UIElementNode {
  return { automationId: null, name: null, controlType: "Window", className: null, processName: null, windowTitle: null, boundingBox: null, enabled: true, focused: false, patterns: [], elementRef: "r", children: [] };
}

let windowCounter = 0;
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

describe("keyframe capture policy", () => {
  it("captures nothing at all in the default structural-only mode", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("kf-user-1", provider);
    await engine.start();

    for (let i = 0; i < 5; i++) provider.emit(makeEvent({ significance: 0.95 }));
    await vi.waitFor(() => expect(engine.queryHistory()).toHaveLength(5));

    expect(provider.captureCount).toBe(0);
    expect(engine.queryHistory().every((sample) => sample.frame === null)).toBe(true);
  });

  it("captures on attention-significant change once enabled, and rate-limits bursts", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("kf-user-2", provider, {
      keyframePolicy: { enabled: true, minAttentionScore: 0.6, minIntervalMs: 10_000 },
    });
    await engine.start();

    provider.emit(makeEvent({ significance: 0.9 }));
    provider.emit(makeEvent({ significance: 0.9 }));
    provider.emit(makeEvent({ significance: 0.9 }));
    await vi.waitFor(() => expect(provider.captureCount).toBeGreaterThan(0));

    // Three significant events inside the rate window produce ONE capture —
    // attention-triggered capture can never become a capture loop.
    expect(provider.captureCount).toBe(1);
  });

  it("ignores low-salience changes even when capture is enabled", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("kf-user-3", provider, {
      keyframePolicy: { enabled: true, minAttentionScore: 0.6, minIntervalMs: 0 },
    });
    await engine.start();

    provider.emit(makeEvent({ type: "window_moved_or_resized", significance: 0.15, attention: "peripheral" }));
    await vi.waitFor(() => expect(engine.queryHistory()).toHaveLength(1));

    expect(provider.captureCount).toBe(0);
  });

  it("does not queue captures: a slow capture is coalesced away, not backed up", async () => {
    const provider = new FakeVisualProvider();
    provider.captureDelayMs = 50;
    const engine = new VisualPerceptionEngine("kf-user-4", provider, {
      keyframePolicy: { enabled: true, minAttentionScore: 0.5, minIntervalMs: 0 },
    });
    await engine.start();

    for (let i = 0; i < 10; i++) provider.emit(makeEvent({ significance: 0.9 }));

    // One in-flight capture; the other nine were dropped rather than queued.
    expect(provider.captureCount).toBe(1);
    expect(engine.queryHistory()).toHaveLength(10); // structural record unaffected
  });

  it("never captures when the provider reports no on-demand capture support", async () => {
    const provider = new FakeVisualProvider();
    provider.supportsCapture = false;
    const engine = new VisualPerceptionEngine("kf-user-5", provider, {
      keyframePolicy: { enabled: true, minAttentionScore: 0, minIntervalMs: 0 },
    });
    await engine.start();

    provider.emit(makeEvent({ significance: 0.9 }));
    expect(provider.captureCount).toBe(0);
  });
});
