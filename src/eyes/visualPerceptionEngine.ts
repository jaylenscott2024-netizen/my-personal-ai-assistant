import crypto from "node:crypto";
import { AttentionManager, type LatencyPolicy } from "./attentionManager.js";
import type { CaptureStreamState, VisualProvider } from "./visualProvider.js";
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
import { CaptureCapabilityEstimator, type CaptureWindowVerdict } from "./captureCapability.js";
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
  /** Native capture rate (frames/sec) — independent of, and normally much
   *  higher than, processingFps, and entirely independent of any AI
   *  provider's transport rate.
   *
   *  NULL means AUTO: the engine measures what this machine can actually
   *  sustain (captureCapability.ts) and adapts, instead of committing to a
   *  number nobody has verified. A number is an explicit manual override.
   *  There is no fixed ceiling here by design — a machine that sustains
   *  144 or 240 is allowed to run at 144 or 240. */
  captureFps: number | null;
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
  captureFps: null, // auto: measured on the real pipeline, never assumed
  processingFps: 2,
  maxBufferedFrames: 90,
};

/** How long each capture-capability measurement window runs before the
 *  estimator judges it. Long enough that a brief hitch doesn't read as a
 *  capability limit, short enough to adapt within a few seconds of a real
 *  change (a game launching, a display switching mode). */
const CAPABILITY_WINDOW_MS = 2_000;

/** Phase 10 diagnostics. Counters and rates only — never pixels, window
 *  titles, or anything else derived from screen contents, so this is safe
 *  to log and to expose. */
export interface CaptureDiagnostics {
  capturing: boolean;
  /** "auto" = rate is measured; "manual" = the user pinned it. */
  mode: "auto" | "manual";
  /** What the user asked for; null in auto mode. */
  requestedCaptureFps: number | null;
  /** The rate actually being requested of the capture source right now. */
  effectiveCaptureFps: number;
  /** Highest rate this machine has PROVEN it can sustain. Null means not
   *  yet measured — never a guess, and never the monitor's refresh rate. */
  measuredSustainableFps: number | null;
  achievedCaptureFps: number;
  lastWindowVerdict: CaptureWindowVerdict;
  measurementConverged: boolean;
  conclusiveWindows: number;
  processingFps: number;
  framesDelivered: number;
  framesDropped: number;
  /** Ticks that were actually encoded into pixel-bearing observations —
   *  always <= framesDelivered, and normally far lower. */
  framesMaterialized: number;
  meanCaptureLatencyMs: number | null;
  bufferedFrames: number;
  maxBufferedFrames: number;
  reconnects: number;
  lastError: string | null;
}

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

  // --- Capture capability measurement + diagnostics -------------------
  // Counters for the window currently being measured. Deliberately plain
  // numbers mutated in place: ingestContinuousFrame is the hot path and
  // must stay allocation-light.
  private readonly capability = new CaptureCapabilityEstimator();
  private windowStartedAtMs = 0;
  private windowFramesDelivered = 0;
  private windowIdleTimeouts = 0;
  private windowFramesDropped = 0;
  private windowLatencySum = 0;
  private windowLatencySamples = 0;
  private framesMaterialized = 0;
  private reconnectCount = 0;
  private lastCaptureError: string | null = null;
  // Lifetime totals, updated on every tick rather than only when a
  // measurement window closes — diagnostics must reflect what is
  // happening now, not what was true as of the last completed window.
  private framesDeliveredTotal = 0;
  private framesDroppedTotal = 0;
  private latencySumTotal = 0;
  private latencySamplesTotal = 0;

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
          // null (auto) resolves to the estimator's current target, which
          // starts as a probe and converges on what this machine actually
          // sustains. A number is the user's explicit override and is
          // passed through untouched.
          captureFps: this.continuousCapturePolicy.captureFps ?? this.capability.targetFps,
          processingFps: this.continuousCapturePolicy.processingFps,
          maxBufferedFrames: this.continuousCapturePolicy.maxBufferedFrames,
        },
        (frame) => this.ingestContinuousFrame(frame),
      );
      this.continuousCaptureActive = true;
      this.lastMaterializedAtMs = 0;
      this.windowStartedAtMs = 0;
      this.lastCaptureError = null;

      // Subscribe to the stream's own lifecycle where the platform can
      // report it. This is what stops `isCapturingContinuously` from
      // reporting true after a stream has silently died — on a static
      // desktop a dead stream and a quiet one look identical from here,
      // so the platform has to say which it is.
      this.provider.onCaptureStatus?.((state, detail) => this.handleCaptureStatus(state, detail));
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
    if (materialize) this.framesMaterialized++;
    this.history.record(sample);
    this.publish(sample);
    this.accumulateCapability(raw);
  }

  // Rolls the raw tick into the current measurement window and, once the
  // window is full, lets the estimator judge it. Only meaningful in auto
  // mode — under a manual override the user's number is authoritative, so
  // measurement still runs (diagnostics stay honest and the user can see
  // whether their chosen rate is actually being achieved) but never moves
  // the requested rate.
  private accumulateCapability(raw: ContinuousFrameSample): void {
    const now = raw.atMs;
    if (this.windowStartedAtMs === 0) this.windowStartedAtMs = now;

    this.framesDeliveredTotal++;
    this.framesDroppedTotal += raw.dropped ?? 0;
    if (raw.captureLatencyMs !== undefined) {
      this.latencySumTotal += raw.captureLatencyMs;
      this.latencySamplesTotal++;
    }

    this.windowFramesDelivered++;
    this.windowIdleTimeouts += raw.idleTimeouts ?? 0;
    this.windowFramesDropped += raw.dropped ?? 0;
    if (raw.captureLatencyMs !== undefined) {
      this.windowLatencySum += raw.captureLatencyMs;
      this.windowLatencySamples++;
    }

    const elapsed = now - this.windowStartedAtMs;
    if (elapsed < CAPABILITY_WINDOW_MS) return;

    const previousTarget = this.capability.targetFps;
    this.capability.record({
      framesDelivered: this.windowFramesDelivered,
      idleTimeouts: this.windowIdleTimeouts,
      framesDropped: this.windowFramesDropped,
      windowMs: elapsed,
      meanFrameLatencyMs: this.windowLatencySamples > 0 ? this.windowLatencySum / this.windowLatencySamples : null,
    });

    this.windowStartedAtMs = now;
    this.windowFramesDelivered = 0;
    this.windowIdleTimeouts = 0;
    this.windowFramesDropped = 0;
    this.windowLatencySum = 0;
    this.windowLatencySamples = 0;

    // In auto mode, a materially changed estimate is worth actually
    // applying to the capture source. Restarting the stream is not free,
    // so only do it on a meaningful move, and never from the hot path
    // synchronously — fire and forget, and never let a failure here
    // disturb perception.
    if (this.continuousCapturePolicy.captureFps !== null) return;
    const target = this.capability.targetFps;
    if (Math.abs(target - previousTarget) < Math.max(1, previousTarget * 0.1)) return;
    void this.retuneCaptureRate(target);
  }

  // Reacts to the platform reporting its capture stream's lifecycle.
  // Structural perception is untouched by any of this: losing pixels never
  // costs Jarvis its window/UI-Automation awareness.
  private handleCaptureStatus(state: CaptureStreamState, detail: string): void {
    switch (state) {
      case "capturing":
        this.continuousCaptureActive = true;
        this.lastCaptureError = null;
        // Geometry may have changed across a rebuild (resolution switch,
        // different monitor), so the measurement window in progress is no
        // longer comparable with what follows it.
        this.windowStartedAtMs = 0;
        break;
      case "reinitializing":
      case "reconnecting":
        // Still nominally capturing, but not delivering right now. Count
        // it and keep the engine honest about why the stream went quiet.
        this.reconnectCount++;
        this.lastCaptureError = detail;
        break;
      case "failed":
      case "stopped":
        this.continuousCaptureActive = false;
        this.lastCaptureError = state === "failed" ? detail : null;
        log.warn({ userId: this.userId, state, detail }, "continuous visual capture ended; Eyes continue structurally");
        break;
    }
  }

  private async retuneCaptureRate(targetFps: number): Promise<void> {
    if (!this.continuousCaptureActive) return;
    try {
      await this.provider.stopContinuousCapture();
      await this.provider.startContinuousCapture(
        {
          captureFps: targetFps,
          processingFps: this.continuousCapturePolicy.processingFps,
          maxBufferedFrames: this.continuousCapturePolicy.maxBufferedFrames,
        },
        (frame) => this.ingestContinuousFrame(frame),
      );
    } catch (err) {
      // Adapting the rate is an optimization. If it fails, perception
      // continues at whatever rate the source is already running.
      this.lastCaptureError = (err as Error).message;
    }
  }

  /** Live diagnostics for the capture pipeline (Phase 10). Deliberately
   *  carries no pixel data and no screen contents — only counters and
   *  rates, so it is safe to log, expose over the API, and show in a UI. */
  getCaptureDiagnostics(): CaptureDiagnostics {
    const report = this.capability.report();
    return {
      capturing: this.continuousCaptureActive,
      mode: this.continuousCapturePolicy.captureFps === null ? "auto" : "manual",
      requestedCaptureFps: this.continuousCapturePolicy.captureFps,
      effectiveCaptureFps: this.continuousCapturePolicy.captureFps ?? report.targetFps,
      measuredSustainableFps: report.sustainedFps,
      achievedCaptureFps: report.lastAchievedFps,
      lastWindowVerdict: report.lastVerdict,
      measurementConverged: report.converged,
      conclusiveWindows: report.conclusiveWindows,
      processingFps: this.continuousCapturePolicy.processingFps,
      framesDelivered: this.framesDeliveredTotal,
      framesDropped: this.framesDroppedTotal,
      framesMaterialized: this.framesMaterialized,
      meanCaptureLatencyMs: this.latencySamplesTotal > 0 ? Math.round((this.latencySumTotal / this.latencySamplesTotal) * 10) / 10 : null,
      bufferedFrames: this.history.stats(Date.now()).frames,
      maxBufferedFrames: this.continuousCapturePolicy.maxBufferedFrames,
      reconnects: this.reconnectCount,
      lastError: this.lastCaptureError,
    };
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
