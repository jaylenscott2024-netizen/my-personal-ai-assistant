import { describe, it, expect } from "vitest";
import { ActivationGate } from "../src/voice/activationGate.js";

// Section 11: "activation should not automatically be permanently
// enabled without the user's choice." This is the gating decision that
// connects wake-word/clap activation to the actual voice pipeline.
describe("ActivationGate", () => {
  it("push_to_talk is never gated — always open", () => {
    const gate = new ActivationGate("push_to_talk");
    expect(gate.isGated).toBe(false);
    expect(gate.isOpen).toBe(true);
  });

  it("disabled starts closed and has no possible trigger, so it never opens", () => {
    const gate = new ActivationGate("disabled");
    expect(gate.isGated).toBe(true);
    expect(gate.isOpen).toBe(false);
    // No trigger() call ever happens for "disabled" in real use (the
    // route only fires it from an activation.detected event, which
    // activationManager never emits for a disabled config) — this just
    // documents that the gate itself doesn't special-case that; the
    // safety comes from nothing ever calling trigger().
  });

  it("wake_word starts closed and opens only after trigger()", () => {
    const gate = new ActivationGate("wake_word");
    expect(gate.isGated).toBe(true);
    expect(gate.isOpen).toBe(false);
    gate.trigger();
    expect(gate.isOpen).toBe(true);
  });

  it("clap starts closed and opens only after trigger()", () => {
    const gate = new ActivationGate("clap");
    expect(gate.isOpen).toBe(false);
    gate.trigger();
    expect(gate.isOpen).toBe(true);
  });

  it("re-arms after a completed turn in wake_word/clap mode", () => {
    const gate = new ActivationGate("wake_word");
    gate.trigger();
    expect(gate.isOpen).toBe(true);
    gate.onTurnComplete();
    expect(gate.isOpen).toBe(false);
  });

  it("push_to_talk never re-closes on turn completion", () => {
    const gate = new ActivationGate("push_to_talk");
    gate.onTurnComplete();
    expect(gate.isOpen).toBe(true);
  });
});
