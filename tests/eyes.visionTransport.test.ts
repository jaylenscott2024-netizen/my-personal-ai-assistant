import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getProvider } from "../src/ai/router.js";
import { visionCapabilitiesOf, supportsAnyVisualInput, imageOnlyVision, NO_VISION } from "../src/ai/visionCapabilities.js";
import { resolveVisionTransport } from "../src/eyes/transport/visionTransportRegistry.js";
import { openAIVisionAdapter } from "../src/eyes/transport/openAIVisionAdapter.js";
import { anthropicVisionAdapter } from "../src/eyes/transport/anthropicVisionAdapter.js";
import { geminiVisionAdapter, setVideoClipSource } from "../src/eyes/transport/geminiVisionAdapter.js";
import { textOnlyVisionAdapter } from "../src/eyes/transport/textOnlyVisionAdapter.js";
import {
  negotiateRealtimeVisual,
  PacedRealtimeVisualFeed,
  RealtimeVisualSessionManager,
  realtimeVisualSessions,
  type RealtimeVisualNegotiation,
  type RealtimeVisualSink,
} from "../src/eyes/transport/realtimeVisualTransport.js";
import type { ChatRequest, ModelCapabilities } from "../src/ai/types.js";
import type { VisualContext } from "../src/eyes/visualContext.js";
import type { VisualSample } from "../src/eyes/visualStream.js";
import type { VisualFrame, VisualState } from "../src/eyes/types.js";

function frame(tag: string): VisualFrame {
  return { mimeType: "image/png", base64: `frame-${tag}`, region: null, capturedAt: new Date().toISOString() };
}

let counter = 0;
function sample(overrides: Partial<VisualSample> = {}): VisualSample {
  counter++;
  return {
    id: `s${counter}`,
    atMs: 1_700_000_000_000 + counter * 1000,
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

const emptyState: VisualState = {
  initialized: true,
  foregroundWindow: null,
  windows: [],
  primaryFocus: null,
  recentEvents: [],
  lastUpdatedAt: new Date().toISOString(),
};

function context(samples: VisualSample[], detail: VisualContext["detail"] = "high"): VisualContext {
  return {
    purpose: "what_just_happened",
    detail,
    requestedAtMs: samples[samples.length - 1]?.atMs ?? Date.now(),
    windowMs: { since: 0, until: Date.now() },
    visualState: emptyState,
    currentSample: samples[samples.length - 1] ?? null,
    samples,
    temporalSummary: "Observed changes (oldest first): ...",
    attention: { maxScore: 0.9, primaryCount: samples.length, peripheralCount: 0 },
  };
}

const baseRequest: ChatRequest = { model: "test-model", messages: [{ role: "user", content: "what just happened?" }] };

function capabilities(vision: ModelCapabilities["visionCapabilities"], model = "test-model"): ModelCapabilities {
  void model;
  return {
    text: true,
    vision: Boolean(vision && (vision.imageInput || vision.videoInput || vision.realtimeVision)),
    audio: false,
    streaming: true,
    toolCalling: true,
    structuredOutput: true,
    reasoning: false,
    longContext: true,
    contextWindowTokens: 200_000,
    visionCapabilities: vision,
  };
}

// Section 5: capability negotiation — what each provider ACTUALLY declares,
// read off the real provider implementations rather than a fixture, so a
// provider that quietly changes its claims fails this test.
describe("vision capability declarations", () => {
  it("Claude declares images with temporal sequencing, and no video or realtime vision", () => {
    const caps = visionCapabilitiesOf(getProvider("anthropic").getCapabilities("claude-sonnet-5"));
    expect(caps.imageInput).toBe(true);
    expect(caps.temporalImageContext).toBe(true);
    expect(caps.videoInput).toBe(false);
    expect(caps.realtimeVision).toBe(false);
  });

  it("OpenAI chat models declare images only — never video or a live visual session", () => {
    const caps = visionCapabilitiesOf(getProvider("openai").getCapabilities("gpt-4o"));
    expect(caps.imageInput).toBe(true);
    expect(caps.videoInput).toBe(false);
    expect(caps.realtimeVision).toBe(false);
  });

  it("Gemini declares video on the standard endpoint, but realtime vision only on Live models", () => {
    const standard = visionCapabilitiesOf(getProvider("gemini").getCapabilities("gemini-2.0-flash"));
    expect(standard.videoInput).toBe(true);
    expect(standard.realtimeVision).toBe(false);

    const live = visionCapabilitiesOf(getProvider("gemini").getCapabilities("gemini-2.0-flash-live-001"));
    expect(live.realtimeVision).toBe(true);
    expect(live.maxRealtimeVisualFps).toBeGreaterThan(0);
  });

  it("a model with no declared capabilities falls back conservatively to its coarse vision flag", () => {
    expect(visionCapabilitiesOf(capabilities(undefined))).toEqual(NO_VISION);
    const legacyVisionModel = { ...capabilities(undefined), vision: true };
    expect(visionCapabilitiesOf(legacyVisionModel).imageInput).toBe(true);
    expect(visionCapabilitiesOf(legacyVisionModel).realtimeVision).toBe(false);
  });

  it("the mock provider is correctly treated as having no visual input", () => {
    expect(supportsAnyVisualInput(getProvider("mock").getCapabilities("mock-1"))).toBe(false);
  });
});

describe("adapter selection and provider isolation", () => {
  it("routes each provider to its own adapter", () => {
    expect(resolveVisionTransport("openai", getProvider("openai").getCapabilities("gpt-4o"))).toBe(openAIVisionAdapter);
    expect(resolveVisionTransport("anthropic", getProvider("anthropic").getCapabilities("claude-sonnet-5"))).toBe(anthropicVisionAdapter);
    expect(resolveVisionTransport("gemini", getProvider("gemini").getCapabilities("gemini-2.0-flash"))).toBe(geminiVisionAdapter);
  });

  it("never substitutes another provider's adapter for an unknown provider", () => {
    const adapter = resolveVisionTransport("some-future-provider", capabilities(imageOnlyVision()));
    expect(adapter).toBe(textOnlyVisionAdapter);
    expect(adapter).not.toBe(openAIVisionAdapter);
  });

  it("falls back to text-only for a model that cannot see at all", () => {
    expect(resolveVisionTransport("openai", getProvider("mock").getCapabilities("mock-1"))).toBe(textOnlyVisionAdapter);
  });
});

describe("text-only transport", () => {
  it("carries the temporal summary and no pixels, even when frames exist", async () => {
    const ctx = context([sample({ frame: frame("a") })]);
    const request = await textOnlyVisionAdapter.sendVisualContext({
      visualContext: ctx,
      request: baseRequest,
      capabilities: capabilities(NO_VISION),
    });

    const attached = request.messages[request.messages.length - 1].visualContext!;
    expect(attached.strategy).toBe("text_only");
    expect(attached.images).toHaveLength(0);
    expect(attached.temporalSummary).toContain("Observed changes");
  });
});

describe("OpenAI vision transport", () => {
  const openAiCaps = getProvider("openai").getCapabilities("gpt-4o");

  it("uses a temporal image set and labels each frame with its capture time", async () => {
    const ctx = context([sample({ frame: frame("a") }), sample({ frame: frame("b") })]);
    const request = await openAIVisionAdapter.sendVisualContext({ visualContext: ctx, request: baseRequest, capabilities: openAiCaps });

    const attached = request.messages[request.messages.length - 1].visualContext!;
    expect(attached.strategy).toBe("temporal_image_set");
    expect(attached.images).toHaveLength(2);
    expect(attached.images[0].label).toMatch(/^-?\d+(\.\d+)?s|now/);
    expect(attached.images[0].capturedAtMs).toBeGreaterThan(0);
  });

  it("respects a tighter per-detail budget than Claude's", async () => {
    const samples = Array.from({ length: 8 }, (_, i) => sample({ frame: frame(`f${i}`) }));
    const low = await openAIVisionAdapter.sendVisualContext({ visualContext: context(samples, "low"), request: baseRequest, capabilities: openAiCaps });
    const high = await openAIVisionAdapter.sendVisualContext({ visualContext: context(samples, "high"), request: baseRequest, capabilities: openAiCaps });

    expect(low.messages[low.messages.length - 1].visualContext!.images).toHaveLength(1);
    expect(high.messages[high.messages.length - 1].visualContext!.images).toHaveLength(5);
  });

  it("degrades to text-only when no frames are available rather than inventing one", async () => {
    const request = await openAIVisionAdapter.sendVisualContext({ visualContext: context([sample()]), request: baseRequest, capabilities: openAiCaps });
    const attached = request.messages[request.messages.length - 1].visualContext!;
    expect(attached.strategy).toBe("text_only");
    expect(attached.images).toHaveLength(0);
    expect(attached.temporalSummary).toBeTruthy();
  });

  it("never mutates the request it was given", async () => {
    const original: ChatRequest = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] };
    await openAIVisionAdapter.sendVisualContext({ visualContext: context([sample({ frame: frame("a") })]), request: original, capabilities: openAiCaps });
    expect(original.messages[0].visualContext).toBeUndefined();
  });
});

describe("Anthropic vision transport", () => {
  const claudeCaps = getProvider("anthropic").getCapabilities("claude-sonnet-5");

  it("protects the before/after bookends rather than just taking the newest frames", async () => {
    const samples = [
      sample({ frame: frame("oldest"), attentionScore: 0.2 }),
      sample({ frame: frame("mid-low"), attentionScore: 0.3 }),
      sample({ frame: frame("mid-high"), attentionScore: 0.95 }),
      sample({ frame: frame("newest"), attentionScore: 0.4 }),
    ];
    const request = await anthropicVisionAdapter.sendVisualContext({
      visualContext: context(samples, "low"), // budget of 1 → newest only
      request: baseRequest,
      capabilities: claudeCaps,
    });
    expect(request.messages[request.messages.length - 1].visualContext!.images).toHaveLength(1);

    const medium = await anthropicVisionAdapter.sendVisualContext({
      visualContext: context(samples, "medium"), // budget of 4
      request: baseRequest,
      capabilities: claudeCaps,
    });
    const images = medium.messages[medium.messages.length - 1].visualContext!.images;
    expect(images).toHaveLength(4);
    // Chronological, and the oldest ("before") frame is present.
    expect(images[0].base64).toBe("frame-oldest");
    expect(images[images.length - 1].base64).toBe("frame-newest");
  });

  it("keeps the oldest frame even when the budget forces dropping a more recent one", async () => {
    const samples = [
      sample({ frame: frame("oldest"), attentionScore: 0.1 }),
      sample({ frame: frame("boring"), attentionScore: 0.15 }),
      sample({ frame: frame("newest"), attentionScore: 0.2 }),
    ];
    const request = await anthropicVisionAdapter.sendVisualContext({
      visualContext: { ...context(samples), detail: "low" as const, samples },
      request: baseRequest,
      capabilities: { ...claudeCaps, visionCapabilities: { ...claudeCaps.visionCapabilities!, maxImagesPerRequest: 2 } },
    });
    const images = request.messages[request.messages.length - 1].visualContext!.images;
    expect(images.map((i) => i.base64)).toEqual(["frame-newest"]);
  });
});

describe("Gemini vision transport", () => {
  const liveCaps = getProvider("gemini").getCapabilities("gemini-2.0-flash-live-001");
  const standardCaps = getProvider("gemini").getCapabilities("gemini-2.0-flash");

  afterEach(async () => {
    setVideoClipSource(null);
    realtimeVisualSessions.setSinkFactory(null);
    await realtimeVisualSessions.closeAll();
  });

  it("prefers the realtime strategy for a Live model and still images for a standard one", () => {
    expect(geminiVisionAdapter.getStrategy(liveCaps)).toBe("realtime_stream");
    expect(geminiVisionAdapter.getStrategy(standardCaps)).toBe("temporal_image_set");
  });

  it("references the live session instead of embedding frames when one is open", async () => {
    realtimeVisualSessions.setSinkFactory(() => new FakeSink());
    const request = await geminiVisionAdapter.sendVisualContext({
      visualContext: context([sample({ frame: frame("a") })]),
      request: { ...baseRequest, model: "gemini-2.0-flash-live-001" },
      capabilities: liveCaps,
      sessionKey: "user-1::gemini::gemini-2.0-flash-live-001",
    });

    const attached = request.messages[request.messages.length - 1].visualContext!;
    expect(attached.strategy).toBe("realtime_stream");
    expect(attached.images).toHaveLength(0); // already streamed — never sent twice
    expect(attached.realtimeSessionId).toBe("user-1::gemini::gemini-2.0-flash-live-001");
    expect(attached.temporalSummary).toContain("Live visual stream active");
  });

  it("falls back to the still-image transport when the live session cannot be opened", async () => {
    realtimeVisualSessions.setSinkFactory(() => {
      throw new Error("no API key");
    });
    const request = await geminiVisionAdapter.sendVisualContext({
      visualContext: context([sample({ frame: frame("a") })]),
      request: { ...baseRequest, model: "gemini-2.0-flash-live-001" },
      capabilities: liveCaps,
      sessionKey: "user-2::gemini::gemini-2.0-flash-live-001",
    });

    const attached = request.messages[request.messages.length - 1].visualContext!;
    expect(attached.strategy).toBe("temporal_image_set");
    expect(attached.images).toHaveLength(1);
  });

  it("uses the video pathway only when a clip source actually exists", async () => {
    expect(geminiVisionAdapter.getStrategy(standardCaps)).toBe("temporal_image_set");

    setVideoClipSource({
      id: "fake-encoder",
      async encodeClip() {
        return { mimeType: "video/mp4", base64: "clip", durationMs: 4200 };
      },
    });
    expect(geminiVisionAdapter.getStrategy(standardCaps)).toBe("video_upload");

    const request = await geminiVisionAdapter.sendVisualContext({
      visualContext: context([sample({ frame: frame("a") })]),
      request: baseRequest,
      capabilities: standardCaps,
    });
    const attached = request.messages[request.messages.length - 1].visualContext!;
    expect(attached.strategy).toBe("video_upload");
    expect(attached.images[0].mimeType).toBe("video/mp4");
  });
});

// Section 9/16: negotiation and pacing — the seam where a fast local
// perception rate meets a slow cloud transport rate.
describe("realtime visual negotiation and pacing", () => {
  it("returns null for a model that does not declare realtime vision", () => {
    expect(negotiateRealtimeVisual("gpt-4o", getProvider("openai").getCapabilities("gpt-4o"))).toBeNull();
  });

  it("takes the minimum of declared, requested and server-accepted rates", () => {
    const caps = capabilities({ ...imageOnlyVision(), realtimeVision: true, maxRealtimeVisualFps: 4 });
    expect(negotiateRealtimeVisual("m", caps)!.fps).toBe(4);
    expect(negotiateRealtimeVisual("m", caps, { requestedFps: 2 })!.fps).toBe(2);
    expect(negotiateRealtimeVisual("m", caps, { requestedFps: 2, serverAcceptedFps: 1 })!.fps).toBe(1);
    // A server that would allow more never raises the declared ceiling.
    expect(negotiateRealtimeVisual("m", caps, { serverAcceptedFps: 30 })!.fps).toBe(4);
  });

  it("defaults conservatively when realtime vision is declared with no numeric ceiling", () => {
    const caps = capabilities({ ...imageOnlyVision(), realtimeVision: true });
    expect(negotiateRealtimeVisual("m", caps)!.fps).toBe(1);
  });

  it("drops frames that arrive faster than the negotiated rate (local fps > transport fps)", async () => {
    const sink = new FakeSink();
    const negotiation: RealtimeVisualNegotiation = { model: "m", fps: 1, intervalMs: 1000, acceptsAudio: false };
    await sink.open(negotiation);
    const feed = new PacedRealtimeVisualFeed(sink, negotiation);

    const base = 1_700_000_000_000;
    // 10 observations inside one second — a realistic local rate.
    const results = Array.from({ length: 10 }, (_, i) => feed.offer(sample({ atMs: base + i * 100, frame: frame(`f${i}`) })));

    expect(results[0]).toBe("sent");
    expect(results.filter((r) => r === "dropped_rate").length).toBeGreaterThan(0);
    // The send itself is dispatched asynchronously (that's the point — the
    // caller is never made to wait), so let the microtask settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(feed.getStats().sent).toBe(1);
    expect(sink.sent).toHaveLength(1);
  });

  it("skips structural-only observations, which have nothing to transmit", async () => {
    const sink = new FakeSink();
    const negotiation: RealtimeVisualNegotiation = { model: "m", fps: 10, intervalMs: 100, acceptsAudio: false };
    await sink.open(negotiation);
    const feed = new PacedRealtimeVisualFeed(sink, negotiation);

    expect(feed.offer(sample({ frame: null }))).toBe("dropped_no_frame");
    expect(feed.getStats().sent).toBe(0);
  });

  it("coalesces rather than queues while a send is in flight, and never blocks the caller", async () => {
    const sink = new FakeSink();
    sink.holdSends = true;
    const negotiation: RealtimeVisualNegotiation = { model: "m", fps: 1000, intervalMs: 1, acceptsAudio: false };
    await sink.open(negotiation);
    const feed = new PacedRealtimeVisualFeed(sink, negotiation);

    const base = 1_700_000_000_000;
    const startedAt = Date.now();
    const results = Array.from({ length: 20 }, (_, i) => feed.offer(sample({ atMs: base + i * 50, frame: frame(`f${i}`) })));
    expect(Date.now() - startedAt).toBeLessThan(100); // synchronous, non-blocking

    expect(results[0]).toBe("sent");
    expect(results.filter((r) => r === "dropped_busy").length).toBeGreaterThan(0);
    expect(sink.sent).toHaveLength(1); // only the in-flight one so far
  });

  it("reports closed once the sink is gone instead of throwing into the event path", async () => {
    const sink = new FakeSink();
    const negotiation: RealtimeVisualNegotiation = { model: "m", fps: 10, intervalMs: 100, acceptsAudio: false };
    await sink.open(negotiation);
    const feed = new PacedRealtimeVisualFeed(sink, negotiation);
    await feed.close();

    expect(feed.offer(sample({ frame: frame("a") }))).toBe("closed");
  });

  it("a failing sink never throws into the caller and perception stats stay consistent", async () => {
    const sink = new FakeSink();
    sink.failSends = true;
    const negotiation: RealtimeVisualNegotiation = { model: "m", fps: 10, intervalMs: 0, acceptsAudio: false };
    await sink.open(negotiation);
    const feed = new PacedRealtimeVisualFeed(sink, negotiation);

    expect(() => feed.offer(sample({ frame: frame("a") }))).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(feed.getStats().failed).toBe(1);
  });
});

describe("RealtimeVisualSessionManager", () => {
  let manager: RealtimeVisualSessionManager;

  beforeEach(() => {
    manager = new RealtimeVisualSessionManager();
  });

  it("returns null when no sink factory is configured (no credentials)", async () => {
    const negotiation: RealtimeVisualNegotiation = { model: "m", fps: 1, intervalMs: 1000, acceptsAudio: false };
    expect(await manager.ensureSession("k", negotiation)).toBeNull();
  });

  it("reuses an open session and notifies listeners exactly once", async () => {
    const opened: string[] = [];
    manager.onSessionOpened((key) => opened.push(key));
    manager.setSinkFactory(() => new FakeSink());
    const negotiation: RealtimeVisualNegotiation = { model: "m", fps: 1, intervalMs: 1000, acceptsAudio: false };

    const first = await manager.ensureSession("k", negotiation);
    const second = await manager.ensureSession("k", negotiation);
    expect(first).toBe(second);
    expect(opened).toEqual(["k"]);
  });

  it("does not retry a session that already failed to open", async () => {
    let attempts = 0;
    manager.setSinkFactory(() => {
      attempts++;
      throw new Error("refused");
    });
    const negotiation: RealtimeVisualNegotiation = { model: "m", fps: 1, intervalMs: 1000, acceptsAudio: false };

    expect(await manager.ensureSession("k", negotiation)).toBeNull();
    expect(await manager.ensureSession("k", negotiation)).toBeNull();
    expect(attempts).toBe(1);
  });
});

class FakeSink implements RealtimeVisualSink {
  readonly id = "fake";
  private open_ = false;
  sent: VisualSample[] = [];
  holdSends = false;
  failSends = false;

  get isOpen(): boolean {
    return this.open_;
  }
  async open(_negotiation: RealtimeVisualNegotiation): Promise<void> {
    this.open_ = true;
  }
  async sendFrame(sample: VisualSample): Promise<void> {
    if (this.failSends) throw new Error("send failed");
    this.sent.push(sample);
    if (this.holdSends) await new Promise(() => {}); // never resolves
  }
  async close(): Promise<void> {
    this.open_ = false;
  }
}
