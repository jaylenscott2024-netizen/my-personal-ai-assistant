import type { VisualEvent, VisualEventType, WindowSummary } from "../../types.js";

// Pure mapping from the watcher script's raw JSON event shape to our
// normalized VisualEvent — factored out from windowsVisualProvider.ts so
// it's unit-testable without spawning PowerShell (which this development
// environment can't do at all — no Windows host).
export interface RawWatcherEvent {
  kind: "event";
  type: string;
  window?: {
    windowId: string;
    processName: string | null;
    title: string;
    isForeground: boolean;
    boundingBox: { monitorId: string; x: number; y: number; width: number; height: number } | null;
  };
  summary?: string;
}

const KNOWN_EVENT_TYPES: VisualEventType[] = [
  "window_created",
  "window_destroyed",
  "window_focus_changed",
  "window_moved_or_resized",
  "ui_structure_changed",
  "ui_property_changed",
  "ui_focus_changed",
  "notification_appeared",
];

function toWindowSummary(raw: RawWatcherEvent["window"]): WindowSummary | null {
  if (!raw) return null;
  return {
    windowId: raw.windowId,
    processName: raw.processName ?? "unknown",
    title: raw.title,
    isForeground: raw.isForeground,
    boundingBox: raw.boundingBox,
  };
}

function defaultSummaryFor(type: VisualEventType, window: WindowSummary | null): string {
  switch (type) {
    case "window_focus_changed":
      return window ? `Switched to "${window.title}" (${window.processName}).` : "Foreground window changed.";
    case "window_created":
      return window ? `A new window appeared: "${window.title}" (${window.processName}).` : "A new window appeared.";
    case "window_destroyed":
      return window ? `A window closed: "${window.title}" (${window.processName}).` : "A window closed.";
    case "window_moved_or_resized":
      return window ? `Window "${window.title}" moved or resized.` : "A window moved or resized.";
    default:
      return "A UI change occurred.";
  }
}

// Section: significance scoring feeds AttentionManager's primary vs.
// peripheral decision — a moved/resized window is routine background
// noise, a new window or focus change is worth more attention.
function significanceOf(type: VisualEventType): number {
  switch (type) {
    case "window_focus_changed":
      return 0.7;
    case "window_created":
      return 0.6;
    case "notification_appeared":
      return 0.9;
    case "window_destroyed":
      return 0.4;
    case "ui_focus_changed":
      return 0.5;
    case "ui_structure_changed":
    case "ui_property_changed":
      return 0.3;
    case "window_moved_or_resized":
      return 0.15;
    default:
      return 0.2;
  }
}

export function mapRawEventToVisualEvent(raw: RawWatcherEvent): VisualEvent | null {
  const type = KNOWN_EVENT_TYPES.includes(raw.type as VisualEventType) ? (raw.type as VisualEventType) : null;
  if (!type) return null;

  const window = toWindowSummary(raw.window);
  const significance = significanceOf(type);

  return {
    type,
    at: new Date().toISOString(),
    attention: significance >= 0.5 ? "primary" : "peripheral",
    summary: raw.summary ?? defaultSummaryFor(type, window),
    window,
    region: window?.boundingBox ?? null,
    significance,
  };
}
