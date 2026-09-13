import crypto from "node:crypto";
import { AttentionManager, type LatencyPolicy } from "./attentionManager.js";
import type { VisualProvider } from "./visualProvider.js";
import type {
  ContinuousFrameSample,
  ScreenRegion,
  UIElementNode,
  VisualEvent,
  VisualFrame,
  VisualProviderCapabilities,
  VisualState,
  WindowSummary,
} from "./types.js";
import { changeKindForEvent, type VisualSample, type VisualSampleListener, type VisualStream } from "./visualStream.js";
import { DEFAULT_VISUAL_HISTORY_LIMITS, VisualHistory, type VisualHistoryLimits, type VisualHistoryQuery } from "./visualHistory.js";
import { buildVisualContext, type VisualContext, type VisualContextRequest } from "./visualContext.js";
import { eventBus } from "../events/eventBus.js";
import { childLogger } from "../config/logger.js";

const log = childLogger("eyes.engine");
const MAX_RECENT_EVENTS = 50;

// Whether — and how — this engine draws on the platform's CONTINUOUS
// visual capture stream. This replaced an earlier, narrower model where
// "visual mode" meant "take an on-demand screenshot when a structural
// event looks significant." That was still fundamentally screenshot-on-
// event, just gated by attention instead of a timer. This is not that:
// when enabled, real pixels flow continuously from the platform's native
// capture technology (see VisualProvider.startContinuousCapture) the
// entire time Eyes is running — attention/significance now governs
// RETENTION (how long a given frame survives, and whether it's promoted
// into VisualHistory's longer-range tiers), never whether capture happens
// at all.
export interface ContinuousCapturePolicy {
  /** False (the default, from eyesMode=structural_only) means this engine
   *  never starts the continuous capture stream — perception is purely
   *  structural, and zero pixels are ever obtained. */
  enabled: boolean;
  /** Requested native capture rate (frames/sec) — independent of, and
   *  normally much higher than, processingFps. Up to 60fps where the
   *  display/hardware actually supports it; the platform capture loop
   *  adapts down rather than forcing an unreachable rate. */
  captureFps: number;
  /** How often a tick is worth fully materializing into a pixel-bearing
   *  VisualSample versus retained as change-metadata only. Bounds local
   *  CPU/memory cost of decoding/encoding, independent of captureFps. */
  processingFps: number;
  /** Passed straight through to VisualHistory as its hot-tier capacity —
   *  how many recent captured observations may be buffered in memory. */
  maxBufferedFrames: number;
}

export const DEFAULT_CONTINUOUS_CAPTURE_POLICY: ContinuousCapturePolicy = {
  enabled: false,
  captureFps: 10,
  processingFps: 2,
  maxBufferedFrames: 90,
};

export interface VisualPerceptionEngineOptions {
  latencyPolicy?: LatencyPolicy;
  continuousCapturePolicy?: Partial<ContinuousCapturePolicy>;
  historyLimits?: Partial<VisualHistoryLimits>;
}

// Section: the persistent, continuously-maintained understanding of the
// visual environment — and, since this revision, the VisualStream itself.
//
// Why the engine *is* the stream rather than owning a separate one: there
// is exactly one source of observations (the provider's event callbacks),
// and duplicating it into a parallel object would create two versions of
// "what Jarvis has seen" that could drift. Consumers subscribe here.
//
// Three properties this class defends, in order of importance:
//  1. Perception never waits on a consumer. Both `ingestEvent` (structural)
//     and `ingestContinuousFrame` (continuous visual) are synchronous and
//     do no I/O; subscribers are invoked without being awaited. A model
//     that takes ten seconds cannot slow either path by one millisecond.
//  2. Perception never waits on a model. Nothing here imports an AI
//     provider, and no code path requires a cloud request to advance.
//  3. Perception is never a poll loop. Structural samples originate in a
//     real OS event; continuous visual samples originate in the
//     platform's native capture technology signaling a new frame is
//     ready (see VisualProvider.startContinuousCapture) — not a timer
//     re-checking the screen. There is no `setInterval`/`setTimeout`
//     anywhere in this class.
//
// What changed from an earlier revision of this class, explicitly: pixels
// used to arrive only via an attention-triggered, on-demand `captureFrame`
// call made from inside the structural event path — i.e. "a structural
// event looked significant, so take a screenshot." That was gated by
// attention, but it was still fundamentally screenshot-on-event. Now,
// visual pixels (when enabled) flow continuously and independently via
// `ingestContinuousFrame`, entirely decoupled from structural events;
// attention/significance governs which continuously-captured observations
// get promoted into VisualHistory's longer-range tiers, not whether
// capture happens.
export class VisualPerceptionEngine implements VisualStream {
  private state: VisualState = {
    initialized: false,
    foregroundWindow: null,
    windows: [],
    primaryFocus: null,
    recentEvents: [],
    lastUpdatedAt: new Date(0).toISOString(),
  };

  private readonly attentionManager: AttentionManager;
  private readonly history: VisualHistory;
  private continuousCapturePolicy: ContinuousCapturePolicy;
  private listeners: VisualSampleListener[] = [];
  private latestSample: VisualSample | null = null;
  private running = false;
  private continuousCaptureActive = false;
  private lastMaterializedAtMs = 0;

  constructor(
    private readonly userId: string,
    private readonly provider: VisualProvider,
    options: VisualPerceptionEngineOptions | LatencyPolicy = {},
  ) {
    // Back-compat: earlier callers passed a bare latency policy string.
    const opts: VisualPerceptionEngineOptions = typeof options === "string" ? { latencyPolicy: options } : options;
    this.attentionManager = new AttentionManager(opts.latencyPolicy ?? "balanced");
    this.history = new VisualHistory({ ...DEFAULT_VISUAL_HISTORY_LIMITS, ...opts.historyLimits });
    this.continuousCapturePolicy = { ...DEFAULT_CONTINUOUS_CAPTURE_POLICY, ...opts.continuousCapturePolicy };
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Whether the continuous capture stream is actually live right now —
   *  distinct from `continuousCapturePolicy.enabled`, which is only the
   *  user's request: the platform may not support it, or starting it may
   *  have failed at runtime (see `start()`). */
  get isCapturingContinuously(): boolean {
    return this.continuousCaptureActive;
  }

  getCapabilities(): VisualProviderCapabilities {
    return this.provider.getCapabilities();
  }

  setLatencyPolicy(policy: LatencyPolicy): void {
    this.attentionManager.setLatencyPolicy(policy);
  }

  /** Applies a new continuous-capture policy, starting or stopping the
   *  platform's capture stream live if `enabled` actually changed — this
   *  is what lets a settings change take effect immediately without
   *  restarting the whole engine (and losing history built up so far). */
  async setContinuousCapturePolicy(policy: Partial<ContinuousCapturePolicy>): Promise<void> {
    const wasEnabled = this.continuousCapturePolicy.enabled;
    this.continuousCapturePolicy = { ...this.continuousCapturePolicy, ...policy };
    if (!this.running) return;

    if (this.continuousCapturePolicy.enabled && !wasEnabled) {
      await this.startContinuousCaptureIfEnabled();
    } else if (!this.continuousCapturePolicy.enabled && wasEnabled) {
      await this.stopContinuousCaptureIfActive();
    } else if (this.continuousCapturePolicy.enabled) {
      // Rate/buffer knobs changed while already capturing: cheapest
      // correct way to apply them is to restart the stream.
      await this.stopContinuousCaptureIfActive();
      await this.startContinuousCaptureIfEnabled();
    }
  }

  getContinuousCapturePolicy(): ContinuousCapturePolicy {
    return { ...this.continuousCapturePolicy };
  }

  setHistoryLimits(limits: Partial<VisualHistoryLimits>): void {
    this.history.setLimits(limits);
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.provider.start((event) => this.ingestEvent(event));
    this.running = true;
    try {
      this.state = { ...this.state, windows: await this.provider.listWindows() };
      this.state.foregroundWindow = this.state.windows.find((w) => w.isForeground) ?? null;
    } catch (err) {
      log.warn({ err }, "initial window snapshot failed; continuing with event-driven updates only");
    }
    await this.startContinuousCaptureIfEnabled();
    log.info({ userId: this.userId, platform: this.provider.platform }, "Jarvis Eyes engine started");
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    await this.stopContinuousCaptureIfActive();
    await this.provider.stop();
    this.running = false;
    this.attentionManager.reset();
    this.listeners = [];
    this.history.clear(); // visual memory dies with the session — never persisted
    log.info({ userId: this.userId }, "Jarvis Eyes engine stopped");
  }

  // Starting continuous capture is best-effort and NEVER fails engine
  // startup: structural/UI-Automation perception is fully independent of
  // it, and a platform that can't support continuous capture (or fails to
  // initialize it at runtime — no GPU adapter, an unsupported session,
  // etc.) simply means Eyes stays structural-only, reported honestly via
  // `isCapturingContinuously`/`getCapabilities()` rather than silently
  // substituting a screenshot-polling loop for the real thing.
  private async startContinuousCaptureIfEnabled(): Promise<void> {
    if (!this.continuousCapturePolicy.enabled || this.continuousCaptureActive) return;
    if (!this.provider.getCapabilities().continuousCapture.supported) {
      log.info({ userId: this.userId, platform: this.provider.platform }, "continuous visual capture not supported on this platform; staying structural-only");
      return;
    }
    // The engine's own hot-tier capacity tracks maxBufferedFrames directly
    // — this is the actual, enforced memory bound on buffered continuous
    // observations, independent of whatever buffering (if any) the
    // platform capture loop does on its own side of the IPC boundary.
    this.history.setLimits({ hotMaxSamples: this.continuousCapturePolicy.maxBufferedFrames });

    try {
      await this.provider.startContinuousCapture(
        {
          captureFps: this.continuousCapturePolicy.captureFps,
          processingFps: this.continuousCapturePolicy.processingFps,
          maxBufferedFrames: this.continuousCapturePolicy.maxBufferedFrames,
        },
        (frame) => this.ingestContinuousFrame(frame),
      );
      this.continuousCaptureActive = true;
      this.lastMaterializedAtMs = 0;
    } catch (err) {
      log.warn({ err, userId: this.userId }, "continuous visual capture failed to start; continuing structural-only");
    }
  }

  private async stopContinuousCaptureIfActive(): Promise<void> {
    if (!this.continuousCaptureActive) return;
    this.continuousCaptureActive = false;
    try {
      await this.provider.stopContinuousCapture();
    } catch (err) {
      log.warn({ err, userId: this.userId }, "continuous visual capture failed to stop cleanly");
    }
  }

  // --- VisualStream ---------------------------------------------------

  subscribe(listener: VisualSampleListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  getCurrentState(): VisualState {
    return this.state;
  }

  getLatestSample(): VisualSample | null {
    return this.latestSample;
  }

  getHistory(): VisualHistory {
    return this.history;
  }

  queryHistory(query: VisualHistoryQuery = {}): VisualSample[] {
    return this.history.query(query);
  }

  /** Provider-neutral answer to a temporal visual question. Knows nothing
   *  about any AI provider — a transport adapter turns this into a request. */
  buildContext(request: VisualContextRequest, now = Date.now()): VisualContext {
    return buildVisualContext(this.state, this.history, request, now);
  }

  // --- Event path (hot; must stay synchronous and allocation-light) ----

  private ingestEvent(candidate: VisualEvent): void {
    const decision = this.attentionManager.evaluate(candidate, this.state);
    if (!decision.accept) return;

    const event = decision.event;
    const recentEvents = [event, ...this.state.recentEvents].slice(0, MAX_RECENT_EVENTS);

    let windows = this.state.windows;
    let foregroundWindow = this.state.foregroundWindow;
    if (event.window) {
      windows = upsertWindow(windows, event.window);
      if (event.window.isForeground) foregroundWindow = event.window;
    }

    this.state = {
      initialized: true,
      foregroundWindow,
      windows,
      primaryFocus: decision.newPrimaryFocus !== undefined ? decision.newPrimaryFocus : this.state.primaryFocus,
      recentEvents,
      lastUpdatedAt: event.at,
    };

    const sample = this.toSample(event, foregroundWindow);
    this.latestSample = sample;
    this.history.record(sample);
    this.publish(sample);

    // Section 45/89: the activity stream gets every accepted (i.e.
    // non-redundant, non-throttled) visual event — never the raw,
    // unfiltered OS event stream, which would flood it.
    eventBus.emitEvent("eyes.event", { type: event.type, attention: event.attention, summary: event.summary }, this.userId);
  }

  // Continuous capture ingestion. Called for every tick the platform's
  // capture stream produces — this is the hot path for a genuinely
  // continuous visual source, so it must stay synchronous, allocation-
  // light, and never await anything (pixels, when present, already
  // arrived synchronously with the tick; there is no async capture call
  // to make here, unlike the old on-demand-keyframe model this replaced).
  //
  // What decides retention, not whether capture happened: this engine
  // enforces `processingFps` itself as a second, authoritative gate over
  // whatever the platform's own capture loop already tried to do —
  // defense in depth, and the actual place "local processing rate" is
  // guaranteed regardless of platform behavior. A tick arriving faster
  // than the processing budget allows is still recorded (motion/change
  // continuity is never lost) — its pixels are just stripped before
  // retention unless the change is significant enough to bypass the gate,
  // mirroring how AttentionManager treats structural events.
  private ingestContinuousFrame(raw: ContinuousFrameSample): void {
    if (!this.continuousCaptureActive) return; // a stray tick after stop() — ignore

    const attentionScore = raw.changeScore;
    const attention: "primary" | "peripheral" = attentionScore >= 0.5 ? "primary" : "peripheral";
    const minIntervalMs = this.continuousCapturePolicy.processingFps > 0 ? 1000 / this.continuousCapturePolicy.processingFps : Infinity;
    const dueByRate = raw.atMs - this.lastMaterializedAtMs >= minIntervalMs;
    // A big enough change is worth keeping even ahead of schedule — the
    // same "significance can bypass throttling" idea AttentionManager
    // already applies to structural events (notification_appeared is
    // never throttled there either).
    const dueBySignificance = attentionScore >= this.history.getLimits().warmSignificanceFloor;
    const materialize = raw.frame !== null && (dueByRate || dueBySignificance);
    if (materialize) this.lastMaterializedAtMs = raw.atMs;

    const sample: VisualSample = {
      id: crypto.randomUUID(),
      atMs: raw.atMs,
      source: { displayId: raw.displayId, windowId: this.state.foregroundWindow?.windowId ?? null, processName: this.state.foregroundWindow?.processName ?? null, windowTitle: this.state.foregroundWindow?.title ?? null },
      changeKind: "visual_motion",
      attentionScore,
      attention,
      summary: summarizeVisualChange(raw.changeScore, this.state.foregroundWindow),
      changedRegions: raw.changedRegions,
      dimensions: { width: raw.width, height: raw.height },
      uiContext: { foregroundWindow: this.state.foregroundWindow },
      frame: materialize ? raw.frame : null,
    };

    this.latestSample = sample;
    this.history.record(sample);
    this.publish(sample);
  }

  private toSample(event: VisualEvent, foregroundWindow: WindowSummary | null): VisualSample {
    return {
      id: crypto.randomUUID(),
      atMs: Date.parse(event.at) || Date.now(),
      source: {
        displayId: event.window?.boundingBox?.monitorId ?? event.region?.monitorId ?? "primary",
        windowId: event.window?.windowId ?? null,
        processName: event.window?.processName ?? null,
        windowTitle: event.window?.title ?? null,
      },
      changeKind: changeKindForEvent(event.type),
      attentionScore: event.significance,
      attention: event.attention,
      summary: event.summary,
      changedRegions: event.region ? [event.region] : [],
      dimensions: event.window?.boundingBox
        ? { width: event.window.boundingBox.width, height: event.window.boundingBox.height }
        : null,
      uiContext: { foregroundWindow },
      // Structural/UI-Automation events never carry pixels — visual
      // content only ever arrives via the separate continuous capture
      // stream (`ingestContinuousFrame`), as its own samples. Keeping
      // these two paths distinct is what lets structural perception work
      // identically whether or not continuous capture is enabled/
      // supported at all.
      frame: null,
    };
  }

  /** Subscribers are notified synchronously and never awaited — a throwing
   *  or slow listener is isolated so it cannot break or stall perception. */
  private publish(sample: VisualSample): void {
    for (const listener of this.listeners) {
      try {
        listener(sample);
      } catch (err) {
        log.warn({ err }, "visual stream subscriber threw; perception unaffected");
      }
    }
  }

  // --- On-demand provider operations ----------------------------------

  getState(): VisualState {
    return this.state;
  }

  async requestFrame(region?: ScreenRegion): Promise<VisualFrame> {
    return this.provider.captureFrame(region);
  }

  async listWindows(): Promise<WindowSummary[]> {
    return this.provider.listWindows();
  }

  async getUiTree(windowId?: string, maxDepth?: number): Promise<UIElementNode> {
    return this.provider.getUiTree(windowId, maxDepth);
  }

  async findUiElement(query: { windowId?: string; name?: string; automationId?: string; controlType?: string }): Promise<UIElementNode[]> {
    return this.provider.findUiElement(query);
  }

  async getUiElement(elementRef: string): Promise<UIElementNode> {
    return this.provider.getUiElement(elementRef);
  }

  async invokeUiElement(elementRef: string): Promise<void> {
    return this.provider.invokeUiElement(elementRef);
  }

  async setUiElementValue(elementRef: string, value: string): Promise<void> {
    return this.provider.setUiElementValue(elementRef, value);
  }

  async focusUiElement(elementRef: string): Promise<void> {
    return this.provider.focusUiElement(elementRef);
  }
}

function upsertWindow(windows: WindowSummary[], window: WindowSummary): WindowSummary[] {
  const withoutForegroundFlag = window.isForeground ? windows.map((w) => ({ ...w, isForeground: false })) : windows;
  const idx = withoutForegroundFlag.findIndex((w) => w.windowId === window.windowId);
  if (idx === -1) return [...withoutForegroundFlag, window];
  const copy = [...withoutForegroundFlag];
  copy[idx] = window;
  return copy;
}

// Model-ready, one-line description of a continuous-capture observation —
// this is what actually reaches a model's context (via VisualContext's
// temporalSummary), never raw dirty-rect coordinates.
function summarizeVisualChange(changeScore: number, foregroundWindow: WindowSummary | null): string {
  const where = foregroundWindow ? ` in "${foregroundWindow.title}" (${foregroundWindow.processName})` : "";
  if (changeScore >= 0.7) return `Significant visual change${where}`;
  if (changeScore >= 0.3) return `Visual change${where}`;
  return `Minor visual change${where}`;
}
