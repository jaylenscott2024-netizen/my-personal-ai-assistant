import { describe, it, expect } from "vitest";
import { mapRawEventToVisualEvent } from "../src/eyes/providers/windows/eventMapping.js";

// Pure parsing/mapping logic from the Windows watcher's raw JSON to our
// normalized VisualEvent shape — unit-testable without Windows or a
// spawned PowerShell process (which this sandbox cannot run at all).
describe("mapRawEventToVisualEvent", () => {
  it("maps a foreground-change event with a window into a primary-ish event", () => {
    const event = mapRawEventToVisualEvent({
      kind: "event",
      type: "window_focus_changed",
      window: { windowId: "123", processName: "chrome", title: "GitHub", isForeground: true, boundingBox: { monitorId: "primary", x: 0, y: 0, width: 800, height: 600 } },
    });

    expect(event).not.toBeNull();
    expect(event?.type).toBe("window_focus_changed");
    expect(event?.window?.processName).toBe("chrome");
    expect(event?.summary).toContain("GitHub");
    expect(event?.significance).toBeGreaterThan(0.5);
  });

  it("returns null for an unrecognized event type rather than crashing", () => {
    const event = mapRawEventToVisualEvent({ kind: "event", type: "totally_unknown_event" });
    expect(event).toBeNull();
  });

  it("handles an event with no window gracefully", () => {
    const event = mapRawEventToVisualEvent({ kind: "event", type: "window_destroyed" });
    expect(event).not.toBeNull();
    expect(event?.window).toBeNull();
    expect(event?.summary).toBeTruthy();
  });

  it("scores window_moved_or_resized as low significance / peripheral", () => {
    const event = mapRawEventToVisualEvent({
      kind: "event",
      type: "window_moved_or_resized",
      window: { windowId: "1", processName: "notepad", title: "Untitled", isForeground: false, boundingBox: null },
    });
    expect(event?.attention).toBe("peripheral");
    expect(event?.significance).toBeLessThan(0.3);
  });

  it("scores notification_appeared as high significance / primary", () => {
    const event = mapRawEventToVisualEvent({ kind: "event", type: "notification_appeared" });
    expect(event?.attention).toBe("primary");
    expect(event?.significance).toBeGreaterThan(0.7);
  });

  it("uses a provided summary over the default when present", () => {
    const event = mapRawEventToVisualEvent({ kind: "event", type: "ui_focus_changed", summary: "Focus moved to Button 'Save'" });
    expect(event?.summary).toBe("Focus moved to Button 'Save'");
  });
});
