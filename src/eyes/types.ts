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

// A single frame of pixel content, captured on demand (attention- or
// tool-triggered — never on a fixed timer; see visualProvider.ts).
export interface VisualFrame {
  mimeType: "image/png" | "image/jpeg";
  base64: string;
  region: ScreenRegion | null;
  capturedAt: string;
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
  /** On-demand (attention-triggered, never polled) pixel frame capture. */
  onDemandFrameCapture: boolean;
  detail?: string;
}
