import type { AttentionLevel, ScreenRegion, VisualEventType, VisualFrame, VisualState, WindowSummary } from "./types.js";

// The continuous visual source, expressed provider-neutrally.
//
// Two things this interface deliberately does NOT have:
//  - any notion of an AI provider. A stream advances from OS events; it
//    never waits on, and never needs, a model request (Section 10:
//    "local perception must continue independently").
//  - any polling knob (no interval, no "tick", no "capture now on a
//    timer"). Samples are produced when the OS says something happened.
//    An implementation that can only poll must report its capability as
//    unsupported rather than emulating a stream with a timer.
export interface VisualStream {
  readonly isRunning: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Returns an unsubscribe function. Listeners are invoked synchronously
   *  and never awaited — see `coalesceLatest` for the safe way to attach a
   *  slow/async consumer. */
  subscribe(listener: VisualSampleListener): () => void;
  getCurrentState(): VisualState;
  getLatestSample(): VisualSample | null;
}

export type VisualSampleListener = (sample: VisualSample) => void;

// What kind of change this sample represents. Coarser than VisualEventType
// on purpose: consumers selecting keyframes care about "the window
// changed" vs. "a control's property changed", not the exact OS event.
export type VisualChangeKind =
  | "window_focus"
  | "window_lifecycle"
  | "window_geometry"
  | "ui_structure"
  | "ui_property"
  | "ui_focus"
  | "notification"
  | "snapshot"
  /** Sourced from the continuous capture stream rather than a structural
   *  OS event — a change in what the display actually looks like,
   *  detected by the platform's own capture technology (e.g. DXGI dirty
   *  rects), not tied to any particular window/UI Automation event. */
  | "visual_motion";

const CHANGE_KIND_BY_EVENT: Record<VisualEventType, VisualChangeKind> = {
  window_focus_changed: "window_focus",
  window_created: "window_lifecycle",
  window_destroyed: "window_lifecycle",
  window_moved_or_resized: "window_geometry",
  ui_structure_changed: "ui_structure",
  ui_property_changed: "ui_property",
  ui_focus_changed: "ui_focus",
  notification_appeared: "notification",
};

export function changeKindForEvent(type: VisualEventType): VisualChangeKind {
  return CHANGE_KIND_BY_EVENT[type] ?? "snapshot";
}

/** Which display/window this observation came from. */
export interface VisualSourceIdentity {
  displayId: string;
  windowId: string | null;
  processName: string | null;
  windowTitle: string | null;
}

// One observation on the stream. Note what's optional: `frame` (actual
// pixels) is the *exception*, not the rule — the overwhelming majority of
// samples are structural only, which is why continuous perception here
// costs no screen captures at all.
export interface VisualSample {
  id: string;
  /** Epoch milliseconds. Deliberately the same clock the realtime voice
   *  pipeline stamps utterances with, so "what did I say while that
   *  happened on screen" is answerable by intersecting time ranges. */
  atMs: number;
  source: VisualSourceIdentity;
  changeKind: VisualChangeKind;
  /** 0..1 salience as scored by AttentionManager. */
  attentionScore: number;
  attention: AttentionLevel;
  /** Model-ready one-line description. Never raw OS event data. */
  summary: string;
  /** Regions that changed, when the source could report them. */
  changedRegions: ScreenRegion[];
  dimensions: { width: number; height: number } | null;
  /** Semantic context from UI Automation, when available. */
  uiContext: VisualSampleUiContext | null;
  /** Pixels, present ONLY when a keyframe was captured for this sample —
   *  which happens solely on attention-significant change, in
   *  structural_plus_visual mode, rate-limited. Never on a timer. */
  frame: VisualFrame | null;
}

export interface VisualSampleUiContext {
  focusedElementName?: string | null;
  focusedElementControlType?: string | null;
  foregroundWindow?: WindowSummary | null;
}

export function approximateSampleBytes(sample: VisualSample): number {
  if (!sample.frame) return 0;
  // base64 inflates by ~4/3; this is a budget estimate, not an exact
  // heap measurement (which V8 doesn't cheaply expose).
  return Math.ceil((sample.frame.base64.length * 3) / 4);
}

// Attaches an async consumer to a stream without ever letting it apply
// backpressure to perception.
//
// The problem this solves: a model adapter's handler can take seconds (a
// network round trip). A plain `subscribe(async s => await send(s))` would
// pile up unbounded concurrent sends, and an `await` inside the emit path
// would stall the event loop for every other consumer. Instead this keeps
// at most ONE in-flight call and ONE pending sample: while the handler is
// busy, newer samples overwrite the pending slot (frame coalescing), so
// the consumer always resumes with the freshest observation rather than
// replaying a stale backlog.
export interface CoalescingSubscriberStats {
  delivered: number;
  coalesced: number;
  failed: number;
  inFlight: boolean;
}

export function coalesceLatest(
  handler: (sample: VisualSample) => void | Promise<void>,
  onError?: (err: unknown, sample: VisualSample) => void,
): VisualSampleListener & { stats: () => CoalescingSubscriberStats } {
  let inFlight = false;
  let pending: VisualSample | null = null;
  const stats = { delivered: 0, coalesced: 0, failed: 0 };

  const run = (sample: VisualSample): void => {
    inFlight = true;
    void (async () => {
      try {
        await handler(sample);
        stats.delivered++;
      } catch (err) {
        stats.failed++;
        onError?.(err, sample);
      } finally {
        inFlight = false;
        const next = pending;
        pending = null;
        if (next) run(next);
      }
    })();
  };

  const listener = ((sample: VisualSample) => {
    if (inFlight) {
      if (pending) stats.coalesced++;
      pending = sample; // newest wins — deliberately drop the older one
      return;
    }
    run(sample);
  }) as VisualSampleListener & { stats: () => CoalescingSubscriberStats };

  listener.stats = () => ({ ...stats, inFlight });
  return listener;
}
