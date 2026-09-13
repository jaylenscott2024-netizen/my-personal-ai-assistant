import crypto from "node:crypto";
import { AttentionManager, type LatencyPolicy } from "./attentionManager.js";
import type { VisualProvider } from "./visualProvider.js";
import type { ScreenRegion, UIElementNode, VisualEvent, VisualFrame, VisualProviderCapabilities, VisualState, WindowSummary } from "./types.js";
import { changeKindForEvent, type VisualSample, type VisualSampleListener, type VisualStream } from "./visualStream.js";
import { DEFAULT_VISUAL_HISTORY_LIMITS, VisualHistory, type VisualHistoryLimits, type VisualHistoryQuery } from "./visualHistory.js";
import { buildVisualContext, type VisualContext, type VisualContextRequest } from "./visualContext.js";
import { eventBus } from "../events/eventBus.js";
import { childLogger } from "../config/logger.js";

const log = childLogger("eyes.engine");
const MAX_RECENT_EVENTS = 50;

/** How the engine is allowed to obtain pixels, if at all. */
export interface KeyframePolicy {
  /** False (the default, from eyesMode=structural_only) means this engine
   *  never captures a single pixel — perception is purely structural. */
  enabled: boolean;
  /** Salience an observation must reach before it's worth a capture. */
  minAttentionScore: number;
  /** Floor between captures. Exists so a burst of significant events can't
   *  turn attention-triggered capture into a de-facto capture loop. */
  minIntervalMs: number;
}

export const DEFAULT_KEYFRAME_POLICY: KeyframePolicy = {
  enabled: false,
  minAttentionScore: 0.6,
  minIntervalMs: 1_500,
};

export interface VisualPerceptionEngineOptions {
  latencyPolicy?: LatencyPolicy;
  keyframePolicy?: Partial<KeyframePolicy>;
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
//  1. Perception never waits on a consumer. `ingestEvent` is synchronous
//     and does no I/O; subscribers are invoked without being awaited, and
//     keyframe capture is fire-and-forget with an in-flight guard. A model
//     that takes ten seconds cannot slow the event path by one millisecond.
//  2. Perception never waits on a model. Nothing here imports an AI
//     provider, and no code path requires a cloud request to advance.
//  3. Perception is never a poll loop. Every sample originates in an OS
//     event; there is no timer anywhere in this class.
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
  private keyframePolicy: KeyframePolicy;
  private listeners: VisualSampleListener[] = [];
  private latestSample: VisualSample | null = null;
  private running = false;
  private keyframeInFlight = false;
  private lastKeyframeAtMs = 0;

  constructor(
    private readonly userId: string,
    private readonly provider: VisualProvider,
    options: VisualPerceptionEngineOptions | LatencyPolicy = {},
  ) {
    // Back-compat: earlier callers passed a bare latency policy string.
    const opts: VisualPerceptionEngineOptions = typeof options === "string" ? { latencyPolicy: options } : options;
    this.attentionManager = new AttentionManager(opts.latencyPolicy ?? "balanced");
    this.history = new VisualHistory({ ...DEFAULT_VISUAL_HISTORY_LIMITS, ...opts.historyLimits });
    this.keyframePolicy = { ...DEFAULT_KEYFRAME_POLICY, ...opts.keyframePolicy };
  }

  get isRunning(): boolean {
    return this.running;
  }

  getCapabilities(): VisualProviderCapabilities {
    return this.provider.getCapabilities();
  }

  setLatencyPolicy(policy: LatencyPolicy): void {
    this.attentionManager.setLatencyPolicy(policy);
  }

  setKeyframePolicy(policy: Partial<KeyframePolicy>): void {
    this.keyframePolicy = { ...this.keyframePolicy, ...policy };
  }

  getKeyframePolicy(): KeyframePolicy {
    return { ...this.keyframePolicy };
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
    log.info({ userId: this.userId, platform: this.provider.platform }, "Jarvis Eyes engine started");
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    await this.provider.stop();
    this.running = false;
    this.attentionManager.reset();
    this.listeners = [];
    this.history.clear(); // visual memory dies with the session — never persisted
    log.info({ userId: this.userId }, "Jarvis Eyes engine stopped");
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

    this.maybeCaptureKeyframe(sample);
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
      frame: null, // attached later if and only if a keyframe is captured
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

  // Attention-triggered keyframe capture. Note every guard: disabled by
  // default, salience floor, rate floor, single in-flight capture, and
  // fire-and-forget so the event path never awaits a screen read. This is
  // what makes it "capture because something important happened" rather
  // than "capture because the clock ticked".
  private maybeCaptureKeyframe(sample: VisualSample): void {
    if (!this.keyframePolicy.enabled) return;
    if (sample.attentionScore < this.keyframePolicy.minAttentionScore) return;
    if (this.keyframeInFlight) return; // coalesce — never queue captures
    if (sample.atMs - this.lastKeyframeAtMs < this.keyframePolicy.minIntervalMs) return;
    if (!this.provider.getCapabilities().onDemandFrameCapture) return;

    this.keyframeInFlight = true;
    this.lastKeyframeAtMs = sample.atMs;
    void this.provider
      .captureFrame()
      .then((frame) => {
        sample.frame = frame;
      })
      .catch((err) => {
        // A failed capture degrades detail, never perception: the
        // structural sample is already recorded and stays valid.
        log.debug({ err }, "keyframe capture failed; structural observation retained");
      })
      .finally(() => {
        this.keyframeInFlight = false;
      });
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
