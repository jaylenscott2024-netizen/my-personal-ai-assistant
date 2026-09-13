import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { registerUser } from "../src/auth/authService.js";
import { prisma } from "../src/database/client.js";
import { updateUserSettings } from "../src/settings/userSettingsService.js";
import { eyesService } from "../src/eyes/eyesService.js";
import { __setVisualProviderForTesting } from "../src/eyes/visualProviderFactory.js";
import { VisualPerceptionEngine } from "../src/eyes/visualPerceptionEngine.js";
import { coalesceLatest } from "../src/eyes/visualStream.js";
import { realtimeVisualSessions, PacedRealtimeVisualFeed, type RealtimeVisualNegotiation, type RealtimeVisualSink } from "../src/eyes/transport/realtimeVisualTransport.js";
import type { VisualProvider } from "../src/eyes/visualProvider.js";
import type { UIElementNode, VisualEvent, VisualFrame, VisualProviderCapabilities, WindowSummary } from "../src/eyes/types.js";
import type { VisualSample } from "../src/eyes/visualStream.js";

class FakeVisualProvider implements VisualProvider {
  readonly platform = "fake";
  private running = false;
  private onEvent: ((event: VisualEvent) => void) | null = null;

  get isRunning() {
    return this.running;
  }
  getCapabilities(): VisualProviderCapabilities {
    return { supported: true, windowEvents: true, uiAutomationEvents: true, uiAutomationQueries: true, onDemandFrameCapture: true };
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
    return { mimeType: "image/png", base64: "SECRET_SCREEN_PIXELS", region: null, capturedAt: new Date().toISOString() };
  }
}

function node(): UIElementNode {
  return { automationId: null, name: null, controlType: "Window", className: null, processName: null, windowTitle: null, boundingBox: null, enabled: true, focused: false, patterns: [], elementRef: "r", children: [] };
}

let counter = 0;
function makeEvent(overrides: Partial<VisualEvent> = {}): VisualEvent {
  counter++;
  return {
    type: "window_focus_changed",
    at: new Date().toISOString(),
    attention: "primary",
    summary: `change ${counter}`,
    window: { windowId: `w${counter}`, processName: "app.exe", title: `Window ${counter}`, isForeground: true, boundingBox: null },
    region: null,
    significance: 0.8,
    ...overrides,
  };
}

async function makeUser() {
  const email = `independence-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { user } = await registerUser(email, "a-strong-password");
  return user.id;
}

afterEach(async () => {
  await eyesService.stopAll();
  __setVisualProviderForTesting(null);
  realtimeVisualSessions.setSinkFactory(null);
});

// Section 10 + acceptance criteria 2/7/8: the AI model is a CONSUMER of
// perception, never its source. These are the tests that would fail if
// anyone ever reintroduced a model-in-the-loop perception cycle.
describe("local perception is independent of any AI provider", () => {
  it("perceives with no AI provider configured or involved at all", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("independent-user", provider);
    await engine.start();

    provider.emit(makeEvent());
    provider.emit(makeEvent());

    expect(engine.getCurrentState().initialized).toBe(true);
    expect(engine.queryHistory()).toHaveLength(2);
    // And it can answer a temporal question entirely locally.
    const context = engine.buildContext({ purpose: "what_just_happened" });
    expect(context.samples.length).toBeGreaterThan(0);
  });

  it("keeps perceiving while a 'model' consumer is hung indefinitely", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("hung-model-user", provider);
    await engine.start();

    // A consumer that never returns — a stuck cloud request.
    engine.subscribe(coalesceLatest(() => new Promise<void>(() => {})));

    const startedAt = Date.now();
    for (let i = 0; i < 25; i++) provider.emit(makeEvent());
    expect(Date.now() - startedAt).toBeLessThan(200);
    expect(engine.queryHistory()).toHaveLength(25);
  });

  it("keeps perceiving after a realtime visual session dies mid-stream", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("disconnect-user", provider);
    await engine.start();

    const sink = new FlakySink();
    const negotiation: RealtimeVisualNegotiation = { model: "m", fps: 100, intervalMs: 0, acceptsAudio: false };
    await sink.open(negotiation);
    const feed = new PacedRealtimeVisualFeed(sink, negotiation);
    engine.subscribe((sample) => feed.offer(sample));

    provider.emit(makeEvent());
    await sink.close(); // the cloud session drops
    provider.emit(makeEvent());
    provider.emit(makeEvent());

    // Perception is entirely unaffected by the dead transport.
    expect(engine.queryHistory()).toHaveLength(3);
    expect(engine.getCurrentState().initialized).toBe(true);
  });

  it("keeps perceiving when the transport throws on every frame", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("throwing-transport-user", provider, {
      keyframePolicy: { enabled: true, minAttentionScore: 0, minIntervalMs: 0 },
    });
    await engine.start();

    engine.subscribe(() => {
      throw new Error("transport exploded");
    });

    expect(() => provider.emit(makeEvent())).not.toThrow();
    expect(engine.queryHistory()).toHaveLength(1);
  });

  it("survives the visual provider failing to capture without losing the structural record", async () => {
    const provider = new FakeVisualProvider();
    provider.captureFrame = async () => {
      throw new Error("display unavailable");
    };
    const engine = new VisualPerceptionEngine("capture-fail-user", provider, {
      keyframePolicy: { enabled: true, minAttentionScore: 0, minIntervalMs: 0 },
    });
    await engine.start();

    provider.emit(makeEvent());
    await vi.waitFor(() => expect(engine.queryHistory()).toHaveLength(1));
    expect(engine.queryHistory()[0].frame).toBeNull();
    expect(engine.queryHistory()[0].summary).toBeTruthy();
  });
});

// Acceptance criterion 9: perception is event-driven, not a poll loop.
// Asserted structurally against the source, because "we didn't add a timer"
// is exactly the kind of property that silently regresses.
describe("no polling in the perception path", () => {
  const eyesDir = path.join(process.cwd(), "src", "eyes");

  function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.name.endsWith(".ts") ? [full] : [];
    });
  }

  it("contains no timer-driven capture anywhere in the Eyes engine", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(eyesDir)) {
      const source = readFileSync(file, "utf8");
      // setInterval is the signature of a poll loop. setTimeout is allowed
      // only where it guards something (e.g. a connect timeout), never in
      // the engine itself.
      if (/setInterval\s*\(/.test(source)) offenders.push(`${path.basename(file)}: setInterval`);
    }
    expect(offenders).toEqual([]);
  });

  it("the engine itself contains no timers at all", () => {
    const engineSource = readFileSync(path.join(eyesDir, "visualPerceptionEngine.ts"), "utf8");
    expect(engineSource).not.toMatch(/setInterval\s*\(/);
    expect(engineSource).not.toMatch(/setTimeout\s*\(/);
  });

  it("the Eyes engine never imports an AI provider or the router", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(eyesDir)) {
      if (file.includes(`${path.sep}transport${path.sep}`)) continue; // transports legitimately know about capabilities
      const source = readFileSync(file, "utf8");
      if (/from "\.\.\/ai\/(router|providers)/.test(source)) offenders.push(path.basename(file));
    }
    expect(offenders).toEqual([]);
  });
});

// Section 15 + acceptance criterion 10.
describe("no raw visual data is persisted", () => {
  it("captured pixels never reach the database, and die with the session", async () => {
    const fake = new FakeVisualProvider();
    __setVisualProviderForTesting(fake);
    const userId = await makeUser();
    await updateUserSettings(userId, { eyesEnabled: true, eyesMode: "structural_plus_visual", eyesAllowedProviders: ["anthropic"] });
    const engine = await eyesService.ensureStarted(userId);

    fake.emit(makeEvent({ significance: 0.95 }));
    await vi.waitFor(() => expect(engine.queryHistory()[0]?.frame).not.toBeNull());

    // The frame exists in memory...
    expect(engine.queryHistory()[0].frame?.base64).toBe("SECRET_SCREEN_PIXELS");

    // ...and nowhere in any persisted table.
    const [messages, events, toolCalls] = await Promise.all([
      prisma.message.findMany(),
      prisma.activityEvent.findMany(),
      prisma.toolCallRecord.findMany(),
    ]);
    const persisted = JSON.stringify({ messages, events, toolCalls });
    expect(persisted).not.toContain("SECRET_SCREEN_PIXELS");

    // Stopping the engine clears visual memory entirely.
    await eyesService.stop(userId);
    expect(engine.queryHistory()).toHaveLength(0);
  });

  it("settings bound the in-memory buffer rather than enabling any retention", async () => {
    const fake = new FakeVisualProvider();
    __setVisualProviderForTesting(fake);
    const userId = await makeUser();
    await updateUserSettings(userId, { eyesEnabled: true, eyesHistorySeconds: 30, eyesMaxKeyframes: 3 });
    const engine = await eyesService.ensureStarted(userId);

    expect(engine.getHistory().getLimits().maxAgeMs).toBe(30_000);
    expect(engine.getHistory().getLimits().maxFrames).toBe(3);
  });

  it("keyframe capture stays off unless the user explicitly chose structural_plus_visual", async () => {
    const fake = new FakeVisualProvider();
    __setVisualProviderForTesting(fake);
    const userId = await makeUser();
    await updateUserSettings(userId, { eyesEnabled: true }); // default eyesMode
    const engine = await eyesService.ensureStarted(userId);

    expect(engine.getKeyframePolicy().enabled).toBe(false);
    fake.emit(makeEvent({ significance: 0.99 }));
    await vi.waitFor(() => expect(engine.queryHistory()).toHaveLength(1));
    expect(engine.queryHistory()[0].frame).toBeNull();
  });
});

class FlakySink implements RealtimeVisualSink {
  readonly id = "flaky";
  private open_ = false;
  sent: VisualSample[] = [];

  get isOpen(): boolean {
    return this.open_;
  }
  async open(_negotiation: RealtimeVisualNegotiation): Promise<void> {
    this.open_ = true;
  }
  async sendFrame(sample: VisualSample): Promise<void> {
    this.sent.push(sample);
  }
  async close(): Promise<void> {
    this.open_ = false;
  }
}
