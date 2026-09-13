import type { ActivationConfig } from "../activation/activationManager.js";

// Section 11: "activation should not automatically be permanently
// enabled without the user's choice." This is the actual decision logic
// behind that — factored out of api/routes/realtimeVoiceRoute.ts so it's
// unit-testable without standing up a WebSocket server. Push-to-talk and
// disabled modes never gate (the client already controls when audio is
// sent, or there's nothing to gate); wake-word and clap modes require an
// activation event before audio reaches the agent pipeline, and re-arm
// after each completed turn so the next utterance needs the trigger again.
export class ActivationGate {
  private activated: boolean;
  private readonly gated: boolean;

  constructor(private readonly mode: ActivationConfig["mode"]) {
    // Only push-to-talk is open by default — the client already controls
    // exactly when audio is sent, so there's nothing to gate. Every other
    // mode, "disabled" included, starts closed: wake-word/clap need a
    // real trigger to open, and "disabled" has no possible trigger at
    // all (activationManager never fires one for it), so it simply never
    // opens — audio is never processed, matching "never automatically
    // enabled without the user's choice."
    this.gated = mode !== "push_to_talk";
    this.activated = !this.gated;
  }

  get isGated(): boolean {
    return this.gated;
  }

  /** True if audio arriving right now should reach the voice session. */
  get isOpen(): boolean {
    return this.activated;
  }

  /** Call when activation fires (a clap was detected, or the client
   *  reported a wake-word match). */
  trigger(): void {
    this.activated = true;
  }

  /** Call when a turn completes and returns to idle listening — re-arms
   *  wake-word/clap modes so the next utterance needs the trigger again. */
  onTurnComplete(): void {
    if (this.gated) this.activated = false;
  }
}
