import { EventEmitter } from "node:events";
import { ClapDetector, type ClapDetectorConfig } from "./clapDetector.js";
import { eventBus } from "../events/eventBus.js";

// Section 31/32/87: Activation subsystem. Strictly separate from AI model
// selection and voice-mode selection (Section 87) — an activation event
// only ever means "begin interaction," decided per user session.
export interface WakeWordConfig {
  enabled: boolean;
  phrase: string; // configurable wake phrase, matched by the client-side/edge detector; this manager just receives the event
}

export interface ActivationConfig {
  wakeWord: WakeWordConfig;
  clap: ClapDetectorConfig;
}

export const DEFAULT_ACTIVATION_CONFIG: ActivationConfig = {
  wakeWord: { enabled: false, phrase: "Hey Voltic" },
  clap: { enabled: true, sensitivity: 3.0, pattern: "double", cooldownMs: 1500, sampleRate: 16_000 },
};

class ActivationManager extends EventEmitter {
  private configs = new Map<string, ActivationConfig>();
  private clapDetectors = new Map<string, ClapDetector>();

  getConfig(userId: string): ActivationConfig {
    return this.configs.get(userId) ?? DEFAULT_ACTIVATION_CONFIG;
  }

  setConfig(userId: string, config: Partial<ActivationConfig>): ActivationConfig {
    const current = this.getConfig(userId);
    const merged: ActivationConfig = {
      wakeWord: { ...current.wakeWord, ...config.wakeWord },
      clap: { ...current.clap, ...config.clap },
    };
    this.configs.set(userId, merged);
    this.clapDetectors.get(userId)?.updateConfig(merged.clap);
    return merged;
  }

  private getClapDetector(userId: string): ClapDetector {
    let detector = this.clapDetectors.get(userId);
    if (!detector) {
      detector = new ClapDetector(this.getConfig(userId).clap);
      this.clapDetectors.set(userId, detector);
    }
    return detector;
  }

  /** Client streams raw PCM16 audio chunks here for clap detection. */
  feedAudioChunk(userId: string, pcm16: Buffer): void {
    const config = this.getConfig(userId);
    if (!config.clap.enabled) return;
    const result = this.getClapDetector(userId).processChunk(pcm16);
    if (result.detected) {
      this.emitActivation(userId, "clap", result.confidence);
    }
  }

  /** Client/edge wake-word detector reports a match directly — this
   *  backend does not run wake-word DSP itself, it just enforces that the
   *  event is well-formed and respects the enabled flag. */
  reportWakeWordDetected(userId: string, phrase: string): void {
    const config = this.getConfig(userId);
    if (!config.wakeWord.enabled) return;
    if (phrase.toLowerCase() !== config.wakeWord.phrase.toLowerCase()) return;
    this.emitActivation(userId, "wake_word", 1);
  }

  private emitActivation(userId: string, method: "clap" | "wake_word", confidence: number): void {
    const payload = { method, confidence, at: new Date().toISOString() };
    this.emit("activation", { userId, ...payload });
    eventBus.emitEvent("activation.detected", payload, userId);
  }
}

export const activationManager = new ActivationManager();
