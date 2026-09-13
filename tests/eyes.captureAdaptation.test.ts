import { describe, it, expect } from "vitest";
import { VisualPerceptionEngine } from "../src/eyes/visualPerceptionEngine.js";
import type { CaptureStreamState, VisualProvider } from "../src/eyes/visualProvider.js";
import type {
  ContinuousCaptureOptions,
  ContinuousFrameSample,
  UIElementNode,
  VisualFrame,
  VisualProviderCapabilities,
  WindowSummary,
} from "../src/eyes/types.js";

let seq = 0;

class CaptureProvider implements VisualProvider {
  readonly platform = "fake";
  private running = false;
  private onFrame: ((frame: ContinuousFrameSample) => void) | null = null;
  startCalls: ContinuousCaptureOptions[] = [];
  stopCalls = 0;

  get isRunning() {
    return this.running;
  }
  getCapabilities(): VisualProviderCapabilities {
    return {
      supported: true,
      windowEvents: true,
      uiAutomationEvents: true,
      uiAutomationQueries: true,
      onDemandFrameCapture: true,
      continuousCapture: {
        supported: true,
        technology: "fake_continuous_capture",
        maxCaptureFps: null,
        supportsDirtyRects: true,
        supportsMultiDisplay: false,
      },
    };
  }
  async start(): Promise<void> {
    this.running = true;
  }
  async stop(): Promise<void> {
    this.running = false;
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
    return { mimeType: "image/png", base64: "f", region: null, capturedAt: new Date().toISOString() };
  }
  private statusListener: ((state: CaptureStreamState, detail: string) => void) | null = null;
  onCaptureStatus(listener: (state: CaptureStreamState, detail: string) => void): void {
    this.statusListener = listener;
  }
  /** Simulate the platform reporting its capture stream's lifecycle. */
  reportStatus(state: CaptureStreamState, detail = ""): void {
    this.statusListener?.(state, detail);
  }
  async startContinuousCapture(options: ContinuousCaptureOptions, onFrame: (frame: ContinuousFrameSample) => void): Promise<void> {
    this.startCalls.push(options);
    this.onFrame = onFrame;
  }
  async stopContinuousCapture(): Promise<void> {
    this.stopCalls++;
    this.onFrame = null;
  }
  /** Deliver one tick with explicit pipeline telemetry and a controlled
   *  timestamp, so a whole measurement window can be replayed without
   *  waiting in real time. */
  tick(atMs: number, telemetry: Partial<ContinuousFrameSample> = {}): void {
    seq++;
    this.onFrame?.({
      sequence: seq,
      atMs,
      displayId: "0",
      width: 1920,
      height: 1080,
      changedRegions: [],
      changeScore: 0.2,
      frame: null,
      ...telemetry,
    });
  }
}

function node(): UIElementNode {
  return { automationId: null, name: null, controlType: "Window", className: null, processName: null, windowTitle: null, boundingBox: null, enabled: true, focused: false, patterns: [], elementRef: "r", children: [] };
}

async function startedEngine(captureFps: number | null): Promise<{ engine: VisualPerceptionEngine; provider: CaptureProvider }> {
  const provider = new CaptureProvider();
  const engine = new VisualPerceptionEngine("cap-user", provider, {
    continuousCapturePolicy: { enabled: true, captureFps, processingFps: 2, maxBufferedFrames: 50 },
  });
  await engine.start();
  return { engine, provider };
}

describe("capture rate: auto by default, never a number the user had to invent", () => {
  it("starts capture without the user having configured any FPS", async () => {
    const { provider, engine } = await startedEngine(null);

    expect(provider.startCalls).toHaveLength(1);
    // It asked the source for a real, positive rate — derived from the
    // estimator's probe, not from a value a user typed in.
    expect(provider.startCalls[0].captureFps).toBeGreaterThan(0);
    expect(engine.getCaptureDiagnostics().mode).toBe("auto");
    await engine.stop();
  });

  it("reports the sustainable rate as unmeasured rather than guessing one", async () => {
    const { engine } = await startedEngine(null);

    const diag = engine.getCaptureDiagnostics();
    expect(diag.measuredSustainableFps).toBeNull(); // nothing observed yet
    expect(diag.conclusiveWindows).toBe(0);
    await engine.stop();
  });

  it("passes an explicit manual override straight through untouched", async () => {
    const { provider, engine } = await startedEngine(144);

    expect(provider.startCalls[0].captureFps).toBe(144);
    const diag = engine.getCaptureDiagnostics();
    expect(diag.mode).toBe("manual");
    expect(diag.requestedCaptureFps).toBe(144);
    expect(diag.effectiveCaptureFps).toBe(144);
    await engine.stop();
  });

  it("allows a manual rate far above any legacy 60fps cap", async () => {
    const { provider, engine } = await startedEngine(240);
    expect(provider.startCalls[0].captureFps).toBe(240);
    await engine.stop();
  });
});

describe("capture rate adaptation is driven by measurement, not assumption", () => {
  it("a motionless desktop does NOT drag the capture rate down", async () => {
    // The trap this guards against: a change-driven source emits almost
    // nothing while the screen is static. If that read as "this machine is
    // slow", Eyes would ratchet itself to uselessness and never recover.
    const { engine, provider } = await startedEngine(null);
    const before = engine.getCaptureDiagnostics().effectiveCaptureFps;

    let t = 1_000_000;
    for (let w = 0; w < 5; w++) {
      for (let i = 0; i < 3; i++) {
        provider.tick((t += 800), { idleTimeouts: 40 });
      }
    }

    const diag = engine.getCaptureDiagnostics();
    expect(diag.effectiveCaptureFps).toBe(before);
    expect(diag.lastWindowVerdict).toBe("inconclusive");
    expect(provider.stopCalls).toBe(0); // never retuned on idle evidence
    await engine.stop();
  });

  it("backs the rate down when the pipeline genuinely cannot keep up", async () => {
    const { engine, provider } = await startedEngine(null);
    const before = engine.getCaptureDiagnostics().effectiveCaptureFps;

    // Two full windows where the source had frames waiting and we dropped
    // most of them: conclusive overload, not an idle screen.
    let t = 2_000_000;
    for (let w = 0; w < 2; w++) {
      for (let i = 0; i < 5; i++) {
        provider.tick((t += 500), { dropped: 20, captureLatencyMs: 45 });
      }
    }

    const diag = engine.getCaptureDiagnostics();
    expect(diag.lastWindowVerdict).toBe("overloaded");
    expect(diag.effectiveCaptureFps).toBeLessThan(before);
    expect(diag.framesDropped).toBeGreaterThan(0);
    await engine.stop();
  });

  it("does not retune a manually pinned rate even when it measures overload", async () => {
    // The user pinned 144. Measurement still runs so diagnostics stay
    // honest, but Jarvis must not silently override an explicit choice.
    const { engine, provider } = await startedEngine(144);

    let t = 3_000_000;
    for (let w = 0; w < 3; w++) {
      for (let i = 0; i < 5; i++) provider.tick((t += 500), { dropped: 30, captureLatencyMs: 60 });
    }

    const diag = engine.getCaptureDiagnostics();
    expect(diag.effectiveCaptureFps).toBe(144); // untouched
    expect(diag.framesDropped).toBeGreaterThan(0); // but honestly reported
    expect(provider.stopCalls).toBe(0);
    await engine.stop();
  });
});

describe("capture diagnostics", () => {
  it("exposes counters and rates without leaking any screen content", async () => {
    const { engine, provider } = await startedEngine(null);

    let t = 4_000_000;
    for (let i = 0; i < 6; i++) {
      provider.tick((t += 400), { captureLatencyMs: 8, changeScore: 0.9, frame: { mimeType: "image/jpeg", base64: "SECRET_PIXELS", region: null, capturedAt: new Date().toISOString() } });
    }

    const diag = engine.getCaptureDiagnostics();
    expect(diag.capturing).toBe(true);
    expect(diag.framesDelivered).toBeGreaterThan(0);
    expect(diag.meanCaptureLatencyMs).toBeGreaterThan(0);
    expect(diag.processingFps).toBe(2);
    expect(diag.maxBufferedFrames).toBe(50);
    expect(diag.reconnects).toBe(0);

    // Privacy: diagnostics are counters, never imagery.
    expect(JSON.stringify(diag)).not.toContain("SECRET_PIXELS");
    await engine.stop();
  });

  it("counts materialized frames separately from delivered ticks", async () => {
    // processingFps gates how many ticks become pixel-bearing. The gap
    // between the two counters is the whole point of separating local
    // capture rate from local processing rate.
    const { engine, provider } = await startedEngine(null);

    let t = 5_000_000;
    for (let i = 0; i < 10; i++) {
      provider.tick((t += 50), { changeScore: 0.1, frame: { mimeType: "image/jpeg", base64: "px", region: null, capturedAt: new Date().toISOString() } });
    }

    const diag = engine.getCaptureDiagnostics();
    expect(diag.framesDelivered).toBe(10);
    expect(diag.framesMaterialized).toBeLessThan(10);
    await engine.stop();
  });

  it("reports capturing=false once the engine stops", async () => {
    const { engine } = await startedEngine(null);
    await engine.stop();
    expect(engine.getCaptureDiagnostics().capturing).toBe(false);
  });
});

describe("capture stream death is reported, not silently believed alive", () => {
  it("stops claiming to capture once the platform reports the stream failed", async () => {
    // The bug this guards: on a static desktop, a DEAD stream and a QUIET
    // one produce identical silence. Without an explicit lifecycle signal
    // the engine would keep reporting Eyes as capturing indefinitely after
    // a GPU reset or display-mode change killed duplication.
    const { engine, provider } = await startedEngine(null);
    expect(engine.isCapturingContinuously).toBe(true);

    provider.reportStatus("failed", "AcquireNextFrame failed: 0x887A0005");

    expect(engine.isCapturingContinuously).toBe(false);
    const diag = engine.getCaptureDiagnostics();
    expect(diag.capturing).toBe(false);
    expect(diag.lastError).toContain("0x887A0005");
    await engine.stop();
  });

  it("counts a recoverable interruption as a reconnect and recovers on 'capturing'", async () => {
    const { engine, provider } = await startedEngine(null);

    provider.reportStatus("reinitializing", "duplication invalidated (0x887A0026)");
    expect(engine.getCaptureDiagnostics().reconnects).toBe(1);

    provider.reportStatus("capturing", "display 0 3840x2160 reconnects=1");
    const diag = engine.getCaptureDiagnostics();
    expect(diag.capturing).toBe(true);
    expect(diag.lastError).toBeNull(); // recovered cleanly
    expect(diag.reconnects).toBe(1); // but the interruption is still on the record
    await engine.stop();
  });

  it("keeps structural perception alive after the visual stream dies", async () => {
    // Losing pixels must never cost Jarvis its window/UI-Automation
    // awareness — the two are independent by design.
    const { engine, provider } = await startedEngine(null);
    provider.reportStatus("failed", "gpu reset");

    expect(engine.isCapturingContinuously).toBe(false);
    expect(engine.isRunning).toBe(true); // Eyes are still open, structurally
    await engine.stop();
  });
});
