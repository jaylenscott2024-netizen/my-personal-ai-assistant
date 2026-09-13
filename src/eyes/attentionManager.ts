import type { ScreenRegion, VisualEvent, VisualEventType, VisualState } from "./types.js";

export type LatencyPolicy = "realtime" | "balanced" | "low_power";

// Section: "avoid sending unchanged visual information repeatedly,"
// "throttling only when appropriate," "avoiding redundant model calls."
// This is the actual decision logic — separate from VisualPerceptionEngine
// (which just holds state) so it's independently unit-testable and so the
// throttle/redundancy policy is one obvious place to tune.
//
// Two independent jobs:
//  1. Redundancy suppression — the same kind of event about the same
//     window firing repeatedly (e.g. rapid resize) shouldn't each
//     individually reach the model; only the first in a policy-driven
//     window does.
//  2. Primary vs. peripheral classification — "primary attention" is
//     what the user is actively doing right now (the foreground window,
//     a just-focused control); "peripheral awareness" is everything else
//     worth remembering but not worth interrupting reasoning over.
const BASE_THROTTLE_MS: Record<VisualEventType, number> = {
  window_focus_changed: 300,
  window_created: 300,
  window_destroyed: 300,
  window_moved_or_resized: 800,
  ui_structure_changed: 500,
  ui_property_changed: 500,
  ui_focus_changed: 300,
  notification_appeared: 0, // never throttled — always worth surfacing
};

const POLICY_MULTIPLIER: Record<LatencyPolicy, number> = {
  realtime: 0.5,
  balanced: 1,
  low_power: 3,
};

export interface AttentionDecision {
  /** False when this event is redundant/throttled and should be dropped
   *  entirely rather than added to state. */
  accept: boolean;
  /** The event as it should be recorded — attention/significance may be
   *  adjusted from the provider's initial guess based on current context
   *  (e.g. an event about the already-focused window is less significant
   *  than one announcing a genuinely new window). */
  event: VisualEvent;
  /** Set when this event should become the engine's new primary-focus region. */
  newPrimaryFocus?: ScreenRegion | null;
}

export class AttentionManager {
  private lastAcceptedAtByKey = new Map<string, number>();

  constructor(private latencyPolicy: LatencyPolicy = "balanced") {}

  setLatencyPolicy(policy: LatencyPolicy): void {
    this.latencyPolicy = policy;
  }

  private throttleKey(event: VisualEvent): string {
    return `${event.type}:${event.window?.windowId ?? "none"}`;
  }

  private isThrottled(event: VisualEvent): boolean {
    const baseMs = BASE_THROTTLE_MS[event.type] ?? 300;
    if (baseMs === 0) return false;
    const throttleMs = baseMs * POLICY_MULTIPLIER[this.latencyPolicy];
    const key = this.throttleKey(event);
    const lastAt = this.lastAcceptedAtByKey.get(key);
    if (lastAt === undefined) return false;
    return Date.now() - lastAt < throttleMs;
  }

  evaluate(candidate: VisualEvent, state: VisualState): AttentionDecision {
    if (this.isThrottled(candidate)) {
      return { accept: false, event: candidate };
    }

    let significance = candidate.significance;
    let attention = candidate.attention;
    let newPrimaryFocus: ScreenRegion | null | undefined;

    // A focus/foreground change onto a window that's already the
    // recorded foreground window is noise (can happen from duplicate OS
    // events) — down-rank rather than drop outright, since it still
    // refreshes staleness.
    if (candidate.type === "window_focus_changed" && candidate.window) {
      if (state.foregroundWindow?.windowId === candidate.window.windowId) {
        significance = Math.min(significance, 0.2);
        attention = "peripheral";
      } else {
        newPrimaryFocus = candidate.window.boundingBox;
        significance = Math.max(significance, 0.7);
        attention = "primary";
      }
    }

    const finalEvent: VisualEvent = { ...candidate, significance, attention };
    this.lastAcceptedAtByKey.set(this.throttleKey(candidate), Date.now());
    return { accept: true, event: finalEvent, newPrimaryFocus };
  }

  reset(): void {
    this.lastAcceptedAtByKey.clear();
  }
}
