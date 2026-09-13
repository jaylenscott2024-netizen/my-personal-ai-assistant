// Section: Jarvis "Eyes" visual-perception subsystem.
//
// Core distinction this file encodes: VISUAL perception (what does the
// screen look like — pixels, layout, motion) is a separate concern from
// UI AUTOMATION (structured semantic data — this is a button named
// "Save", it is enabled, its automation id is "btnSave"). Both feed the
// same VisualState so the agent can reason "I see the window, the
// relevant control is this one" and act on it — but neither replaces the
// other (per the spec: "UI Automation is not a replacement for the
// Eyes").
//
// Nothing in this file is Windows-specific. `VisualProvider` (in
// visualProvider.ts) is the seam a real platform implementation plugs
// into; this file is pure data shape, testable with zero OS dependency.

export type AttentionLevel = "primary" | "peripheral";

// A rectangular region of the visual environment, in the coordinate space
// of the monitor it belongs to. Used both for "what changed" and for
// "where should the model look."
export interface ScreenRegion {
  monitorId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// Structured, UI-Automation-sourced semantic description of a window or
// control. Deliberately mirrors the exact property set the spec asks
// for, so `computer_get_ui_tree`/`computer_find_ui_element` can return
// this shape directly.
export interface UIElementNode {
  automationId: string | null;
  name: string | null;
  controlType: string; // e.g. "Button", "Edit", "Window", "MenuItem"
  className: string | null;
  processName: string | null;
  windowTitle: string | null;
  boundingBox: ScreenRegion | null;
  enabled: boolean;
  focused: boolean;
  /** UI Automation control patterns this element supports, e.g. ["Invoke", "Value", "Toggle"]. */
  patterns: string[];
  /** An opaque handle the platform provider can resolve back to the real
   *  automation element for invoke/set-value/focus calls — never
   *  exposed to the model as anything but an opaque string. */
  elementRef: string;
  children: UIElementNode[];
}

// One window, as far as the Eyes Engine's "what apps exist and which is
// in front" awareness is concerned — the peripheral-vision layer's unit
// of attention, independent of pixel content.
export interface WindowSummary {
  windowId: string;
  processName: string;
  title: string;
  isForeground: boolean;
  boundingBox: ScreenRegion | null;
}

// A single frame of pixel content. Two ways one of these comes to exist:
// (1) on-demand, tool- or attention-triggered (`VisualProvider.captureFrame`)
// — a one-shot "show me right now"; or (2) as part of the continuous
// capture stream (`VisualProvider.startContinuousCapture`), where the
// platform's native low-latency capture technology (e.g. Windows DXGI
// Desktop Duplication) hands frames to Jarvis as the display actually
// changes. Neither path is a screenshot-polling loop: (1) never fires on a
// timer, and (2) is driven by the OS/GPU signaling a new frame is ready,
// not by Jarvis asking for one on an interval.
export interface VisualFrame {
  mimeType: "image/png" | "image/jpeg";
  base64: string;
  region: ScreenRegion | null;
  capturedAt: string;
}

// What a platform's continuous capture technology can actually do —
// checked before ever starting it, and reported honestly (never faked
// with a hidden capture-on-a-timer) when unsupported.
export interface ContinuousCaptureCapabilities {
  supported: boolean;
  /** Human-identifiable name of the underlying technology, e.g.
   *  "dxgi_desktop_duplication" — never invented; null when unsupported. */
  technology: string | null;
  /** A known hardware/display ceiling, when the platform can report one
   *  up front. Null means "not known in advance — negotiated/observed at
   *  runtime," which is the normal case: display refresh rate, GPU driver
   *  behavior, and remote-desktop sessions all affect the real ceiling in
   *  ways that can't be predicted before capture actually starts. */
  maxCaptureFps: number | null;
  /** Whether the platform can report which regions of the display
   *  actually changed between frames without Jarvis having to diff pixels
   *  itself (e.g. DXGI's own dirty-rect/move-rect reporting). */
  supportsDirtyRects: boolean;
  supportsMultiDisplay: boolean;
  detail?: string;
}

// Requested parameters for the continuous capture stream. These are
// requests, not guarantees — the platform capture loop adapts to what the
// display/hardware can actually sustain rather than blocking or degrading
// the rest of Jarvis to hit an unreachable number (Section: "prefer 'up to
// the requested rate' with automatic adaptation").
export interface ContinuousCaptureOptions {
  /** Requested native capture rate — how often the platform's capture
   *  technology should check for a new frame. This is the "local Eyes
   *  FPS" and is completely independent of any AI provider's transport
   *  rate; up to 60fps where the display/hardware actually supports it. */
  captureFps: number;
  /** How often a captured tick is actually worth fully materializing
   *  (encoded to bytes and handed up to Jarvis) versus reported as
   *  change-metadata only. Bounds local CPU/memory cost of encoding —
   *  distinct from, and normally much lower than, captureFps. */
  processingFps: number;
  /** Upper bound on how many recent captured frames Jarvis's local
   *  temporal buffer may hold at once (see VisualHistory). */
  maxBufferedFrames: number;
  /** Which display to capture; omit for the primary/active display. */
  displayId?: string;
}

// One observation from the continuous capture stream, handed to the
// engine's ingestion path. `frame` is populated only on ticks the capture
// loop (or the engine's own processingFps enforcement) decided were worth
// fully materializing — every other tick still carries real change
// metadata (from the platform's own dirty-rect reporting where available),
// so local motion/attention scoring never goes blind between materialized
// frames.
export interface ContinuousFrameSample {
  /** Monotonically increasing per capture session — lets a consumer detect
   *  gaps (dropped/coalesced ticks) without relying on timestamps alone. */
  sequence: number;
  atMs: number;
  displayId: string;
  width: number;
  height: number;
  /** Regions that changed since the previous tick, when the capture
   *  technology can report them natively (e.g. DXGI dirty rects). Empty
   *  does not mean "nothing changed" on a platform that can't report
   *  regions — see `changeScore`. */
  changedRegions: ScreenRegion[];
  /** 0 (no detectable change) to 1 (near-total redraw), derived from
   *  changed-region coverage — the raw signal AttentionManager-adjacent
   *  scoring in the engine turns into attention/significance. */
  changeScore: number;
  frame: VisualFrame | null;
}

// The Eyes Engine's continuously-maintained understanding of the visual
// environment. This is what "continuous awareness" actually means here:
// a live, in-memory, event-updated structure — not a screenshot taken
// moments ago and already stale.
export interface VisualState {
  /** True once at least one real observation has landed (event-driven; not on startup with empty defaults). */
  initialized: boolean;
  foregroundWindow: WindowSummary | null;
  windows: WindowSummary[];
  /** The window/region attention is currently focused on, if any. */
  primaryFocus: ScreenRegion | null;
  /** Recent significant changes, most recent first, bounded in length —
   *  this is the "peripheral awareness" trail (Section: peripheral vision). */
  recentEvents: VisualEvent[];
  lastUpdatedAt: string;
}

export type VisualEventType =
  | "window_created"
  | "window_destroyed"
  | "window_focus_changed"
  | "window_moved_or_resized"
  | "ui_structure_changed"
  | "ui_property_changed"
  | "ui_focus_changed"
  | "notification_appeared";

export interface VisualEvent {
  type: VisualEventType;
  at: string;
  attention: AttentionLevel;
  /** Human-readable, model-ready description of what happened — this is
   *  what actually reaches the model's context, never raw OS event data. */
  summary: string;
  window: WindowSummary | null;
  region: ScreenRegion | null;
  /** 0 (trivial) to 1 (highly significant) — AttentionManager's change-
   *  significance score, used to decide primary vs. peripheral and
   *  whether an update is worth surfacing at all (Section: avoid
   *  redundant model calls). */
  significance: number;
}

// What a given platform's Eyes implementation actually supports right
// now — checked before ever attempting an operation, and surfaced
// honestly to the user/model when something isn't available, rather than
// silently degrading to a fallback (Section: NO SCREENSHOT FALLBACK).
export interface VisualProviderCapabilities {
  supported: boolean;
  /** Event-driven window/foreground-change awareness (WinEventHook-equivalent). */
  windowEvents: boolean;
  /** Event-driven UI Automation structure/property/focus change awareness. */
  uiAutomationEvents: boolean;
  /** One-shot UI Automation tree queries (get_ui_tree, find_element, invoke, set_value, focus). */
  uiAutomationQueries: boolean;
  /** On-demand (attention- or tool-triggered, never polled) single pixel
   *  frame capture — a one-shot "show me right now", distinct from the
   *  continuous capture stream below. */
  onDemandFrameCapture: boolean;
  /** The platform's continuous, low-latency display capture technology,
   *  if any — see ContinuousCaptureCapabilities. */
  continuousCapture: ContinuousCaptureCapabilities;
  detail?: string;
}
