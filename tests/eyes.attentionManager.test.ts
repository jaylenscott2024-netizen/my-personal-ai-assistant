import { describe, it, expect, vi } from "vitest";
import { AttentionManager } from "../src/eyes/attentionManager.js";
import type { VisualEvent, VisualState, WindowSummary } from "../src/eyes/types.js";

function makeState(overrides: Partial<VisualState> = {}): VisualState {
  return {
    initialized: true,
    foregroundWindow: null,
    windows: [],
    primaryFocus: null,
    recentEvents: [],
    lastUpdatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeWindow(overrides: Partial<WindowSummary> = {}): WindowSummary {
  return { windowId: "w1", processName: "chrome", title: "GitHub", isForeground: true, boundingBox: null, ...overrides };
}

function makeEvent(overrides: Partial<VisualEvent> = {}): VisualEvent {
  return {
    type: "window_focus_changed",
    at: new Date().toISOString(),
    attention: "peripheral",
    summary: "test event",
    window: makeWindow(),
    region: null,
    significance: 0.5,
    ...overrides,
  };
}

// Section: "avoid sending unchanged visual information repeatedly,"
// "throttling only when appropriate," "avoiding redundant model calls" —
// this is the logic that actually enforces those requirements.
describe("AttentionManager", () => {
  it("accepts a genuinely new foreground window as primary attention", () => {
    const manager = new AttentionManager("balanced");
    const decision = manager.evaluate(makeEvent({ window: makeWindow({ windowId: "w2", title: "New App" }) }), makeState());

    expect(decision.accept).toBe(true);
    expect(decision.event.attention).toBe("primary");
    expect(decision.newPrimaryFocus).toBeDefined();
  });

  it("down-ranks a focus-changed event onto the window that's already foreground", () => {
    const manager = new AttentionManager("balanced");
    const window = makeWindow({ windowId: "w1" });
    const state = makeState({ foregroundWindow: window });

    const decision = manager.evaluate(makeEvent({ window }), state);
    expect(decision.accept).toBe(true);
    expect(decision.event.attention).toBe("peripheral");
    expect(decision.event.significance).toBeLessThan(0.5);
  });

  it("throttles repeated events of the same type/window within the policy window", () => {
    const manager = new AttentionManager("balanced");
    const event = makeEvent({ type: "window_moved_or_resized", significance: 0.15 });

    const first = manager.evaluate(event, makeState());
    expect(first.accept).toBe(true);

    const second = manager.evaluate(event, makeState());
    expect(second.accept).toBe(false); // fired immediately after — within the throttle window
  });

  it("accepts a throttled event type again after enough time passes", async () => {
    const manager = new AttentionManager("realtime"); // shortest throttle window
    const event = makeEvent({ type: "window_moved_or_resized", significance: 0.15 });

    expect(manager.evaluate(event, makeState()).accept).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 450)); // > realtime throttle (800ms * 0.5 = 400ms)
    expect(manager.evaluate(event, makeState()).accept).toBe(true);
  });

  it("never throttles a notification, regardless of frequency", () => {
    const manager = new AttentionManager("low_power"); // most aggressive throttling
    const event = makeEvent({ type: "notification_appeared", significance: 0.9 });

    expect(manager.evaluate(event, makeState()).accept).toBe(true);
    expect(manager.evaluate(event, makeState()).accept).toBe(true);
  });

  it("scales throttle duration by latency policy", () => {
    vi.useFakeTimers();
    try {
      const manager = new AttentionManager("low_power"); // 3x multiplier
      const event = makeEvent({ type: "ui_structure_changed", significance: 0.3, attention: "peripheral" });

      expect(manager.evaluate(event, makeState()).accept).toBe(true);
      vi.advanceTimersByTime(1000); // base throttle (500ms) * 3 = 1500ms — still within window
      expect(manager.evaluate(event, makeState()).accept).toBe(false);
      vi.advanceTimersByTime(600); // now past 1500ms total
      expect(manager.evaluate(event, makeState()).accept).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reset() clears throttle history", () => {
    const manager = new AttentionManager("balanced");
    const event = makeEvent({ type: "window_moved_or_resized", significance: 0.15 });

    expect(manager.evaluate(event, makeState()).accept).toBe(true);
    expect(manager.evaluate(event, makeState()).accept).toBe(false);
    manager.reset();
    expect(manager.evaluate(event, makeState()).accept).toBe(true);
  });
});
