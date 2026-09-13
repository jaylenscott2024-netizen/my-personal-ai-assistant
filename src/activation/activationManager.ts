import { EventEmitter } from "node:events";
import { ClapDetector, type ClapDetectorConfig } from "./clapDetector.js";
import { eventBus } from "../events/eventBus.js";
import type { ActivationMode, UserSettings } from "../settings/userSettingsService.js";

// Section 31/32/87: Activation subsystem. Strictly separate from AI model
// selection and voice-mode selection (Section 87) — an activation event
// only ever means "begin interaction," decided per user session.
export interface WakeWordConfig {
  enabled: boolean;
  phrase: string; // configurable wake phrase, matched by the client-side/edge detector; this manager just receives the event
}

export interface ActivationConfig {
  mode: ActivationMode;
  wakeWord: WakeWordConfig;
  clap: ClapDetectorConfig;
}

export const DEFAULT_ACTIVATION_CONFIG: ActivationConfig = {
  mode: "push_to_talk",
  wakeWord: { enabled: false, phrase: "Jarvis" },
  clap: { enabled: false, sensitivity: 3.0, pattern: "double", cooldownMs: 1500, sampleRate: 16_000 },
};

// Maps the persisted, user-facing settings shape (Section 11: "Make
// activation settings persistent") onto the runtime config this manager
// actually evaluates against every audio chunk / wake-word event. Kept as
// a pure function so it's trivially testable without a database.
export function activationConfigFromSettings(settings: UserSettings): ActivationConfig {
  return {
    mode: settings.activationMode,
    wakeWord: {
      enabled: settings.activationMode === "wake_word",
      phrase: settings.wakeWordPhrase,
    },
    clap: {
      enabled: settings.activationMode === "clap",
      sensitivity: settings.clapSensitivity,
      pattern: settings.clapPattern,
      cooldownMs: settings.clapCooldownMs,
      sampleRate: 16_000,
    },
  };
}

class ActivationManager extends EventEmitter {
  private configs = new Map<string, ActivationConfig>();
  private clapDetectors = new Map<string, ClapDetector>();
  private hydrated = new Set<string>();

  getConfig(userId: string): ActivationConfig {
    return this.configs.get(userId) ?? DEFAULT_ACTIVATION_CONFIG;
  }

  /** True once this user's config has been loaded from persisted settings
   *  at least once in this process — lets callers (e.g. the WebSocket
   *  route) avoid a redundant DB read on every reconnect. */
  isHydrated(userId: string): boolean {
    return this.hydrated.has(userId);
  }

  /** Loads a user's persisted settings into the live in-memory config.
   *  Called once per user per process (typically on their first
   *  WebSocket connection) rather than on every audio chunk, since
   *  `feedAudioChunk` must stay synchronous to keep up with a live audio
   *  stream — see settings/userSettingsService.ts for the DB-backed
   *  persistence this hydrates from. */
  hydrate(userId: string, settings: UserSettings): ActivationConfig {
    const config = activationConfigFromSettings(settings);
    this.configs.set(userId, config);
    this.clapDetectors.get(userId)?.updateConfig(config.clap);
    this.hydrated.add(userId);
    return config;
  }

  setConfig(userId: string, config: Partial<ActivationConfig>): ActivationConfig {
    const current = this.getConfig(userId);
    const merged: ActivationConfig = {
      mode: config.mode ?? current.mode,
      wakeWord: { ...current.wakeWord, ...config.wakeWord },
      clap: { ...current.clap, ...config.clap },
    };
    this.configs.set(userId, merged);
    this.clapDetectors.get(userId)?.updateConfig(merged.clap);
    this.hydrated.add(userId);
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
