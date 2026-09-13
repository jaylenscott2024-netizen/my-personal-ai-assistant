import { prisma } from "../database/client.js";
import { ValidationError } from "../utils/errors.js";

// Section 11/12/28/29/88: persistent, user-controlled assistant identity,
// activation, and voice configuration. Replaces the old in-memory-only
// activation config, which reset to defaults on every restart.
export type ActivationMode = "push_to_talk" | "wake_word" | "clap" | "disabled";
export type ClapPattern = "single" | "double" | "triple";
// structural_only: window/UI-Automation semantic awareness only — Eyes
// never starts the continuous visual capture stream, so zero pixels are
// ever obtained. structural_plus_visual: the platform's continuous, GPU-
// signaled capture stream (e.g. Windows DXGI Desktop Duplication) runs
// for as long as Eyes is enabled — real pixels flow continuously into
// Jarvis's local temporal buffer, at the rates eyesLocalCaptureFps/
// eyesLocalProcessingFps configure. This is NOT "take a screenshot when
// something significant happens" — that model has been removed. Whether
// any of what's continuously captured ever leaves the process (to an AI
// provider) remains a separate, always-explicit decision gated by
// eyesAllowedProviders/permissions/model capability, unaffected by this
// setting.
export type EyesMode = "structural_only" | "structural_plus_visual";
export type EyesAttentionMode = "auto" | "manual";
export type EyesLatencyPolicy = "realtime" | "balanced" | "low_power";

export interface UserSettings {
  assistantName: string;
  activationMode: ActivationMode;
  wakeWordPhrase: string;
  clapSensitivity: number;
  clapPattern: ClapPattern;
  clapCooldownMs: number;
  voiceProvider: string;
  voiceId: string | null;
  voiceModel: string | null;
  sttProvider: string;
  /** Jarvis "Eyes" visual perception (EYES.md). Off by default. */
  eyesEnabled: boolean;
  eyesMode: EyesMode;
  eyesAttentionMode: EyesAttentionMode;
  eyesUpdateLatencyPolicy: EyesLatencyPolicy;
  /** AI provider ids allowed to receive ANY visual context. Empty by default. */
  eyesAllowedProviders: string[];
  /** How far back the in-memory temporal visual buffer reaches (its
   *  long-range "warm" tier — see VisualHistory). */
  eyesHistorySeconds: number;
  /** How many captured keyframes that buffer may hold at once. */
  eyesMaxKeyframes: number;
  /** Native continuous-capture rate (frames/sec) — the "local Eyes FPS,"
   *  independent of any AI provider's transport rate.
   *
   *  NULL (the default) means AUTO: Jarvis measures what this specific
   *  machine can actually sustain and adapts, rather than making the user
   *  guess a number. See eyes/captureCapability.ts — the estimate comes
   *  from the real capture pipeline, not from the monitor's refresh rate
   *  or the GPU's spec sheet.
   *
   *  A number here is an explicit manual override for users who want to
   *  cap Eyes deliberately (e.g. to leave GPU headroom for a game). There
   *  is no product-imposed ceiling: the bound is a sanity limit, not an
   *  opinion about how fast Eyes are allowed to be. Only takes effect
   *  when eyesMode is "structural_plus_visual". */
  eyesLocalCaptureFps: number | null;
  /** How often a captured tick is worth fully materializing into a
   *  pixel-bearing observation versus change-metadata only. Bounds local
   *  CPU/memory cost of encoding, independent of eyesLocalCaptureFps. */
  eyesLocalProcessingFps: number;
  /** Upper bound on how many recent continuous-capture observations may
   *  be buffered in memory at once (VisualHistory's hot-tier capacity). */
  eyesMaxBufferedFrames: number;
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  assistantName: "Jarvis",
  activationMode: "push_to_talk",
  wakeWordPhrase: "Jarvis",
  clapSensitivity: 3.0,
  clapPattern: "double",
  clapCooldownMs: 1500,
  voiceProvider: "elevenlabs",
  voiceId: null,
  voiceModel: null,
  sttProvider: "elevenlabs",
  eyesEnabled: false,
  eyesMode: "structural_only",
  eyesAttentionMode: "auto",
  eyesUpdateLatencyPolicy: "balanced",
  eyesAllowedProviders: [],
  eyesHistorySeconds: 120,
  eyesMaxKeyframes: 12,
  eyesLocalCaptureFps: null, // auto — measured, not guessed
  eyesLocalProcessingFps: 2,
  eyesMaxBufferedFrames: 90,
};

const ACTIVATION_MODES: ActivationMode[] = ["push_to_talk", "wake_word", "clap", "disabled"];
const CLAP_PATTERNS: ClapPattern[] = ["single", "double", "triple"];
const EYES_MODES: EyesMode[] = ["structural_only", "structural_plus_visual"];
const EYES_ATTENTION_MODES: EyesAttentionMode[] = ["auto", "manual"];
const EYES_LATENCY_POLICIES: EyesLatencyPolicy[] = ["realtime", "balanced", "low_power"];

interface UserSettingsRow {
  assistantName: string;
  activationMode: string;
  wakeWordPhrase: string;
  clapSensitivity: number;
  clapPattern: string;
  clapCooldownMs: number;
  voiceProvider: string;
  voiceId: string | null;
  voiceModel: string | null;
  sttProvider: string;
  eyesEnabled: boolean;
  eyesMode: string;
  eyesAttentionMode: string;
  eyesUpdateLatencyPolicy: string;
  eyesAllowedProviders: string;
  eyesHistorySeconds: number;
  eyesMaxKeyframes: number;
  eyesLocalCaptureFps: number | null;
  eyesLocalProcessingFps: number;
  eyesMaxBufferedFrames: number;
}

function rowToSettings(row: UserSettingsRow): UserSettings {
  let eyesAllowedProviders: string[] = [];
  try {
    const parsed = JSON.parse(row.eyesAllowedProviders);
    if (Array.isArray(parsed)) eyesAllowedProviders = parsed.filter((p): p is string => typeof p === "string");
  } catch {
    eyesAllowedProviders = [];
  }

  return {
    assistantName: row.assistantName,
    activationMode: row.activationMode as ActivationMode,
    wakeWordPhrase: row.wakeWordPhrase,
    clapSensitivity: row.clapSensitivity,
    clapPattern: row.clapPattern as ClapPattern,
    clapCooldownMs: row.clapCooldownMs,
    voiceProvider: row.voiceProvider,
    voiceId: row.voiceId,
    voiceModel: row.voiceModel,
    sttProvider: row.sttProvider,
    eyesEnabled: row.eyesEnabled,
    eyesMode: row.eyesMode as EyesMode,
    eyesAttentionMode: row.eyesAttentionMode as EyesAttentionMode,
    eyesUpdateLatencyPolicy: row.eyesUpdateLatencyPolicy as EyesLatencyPolicy,
    eyesAllowedProviders,
    eyesHistorySeconds: row.eyesHistorySeconds,
    eyesMaxKeyframes: row.eyesMaxKeyframes,
    eyesLocalCaptureFps: row.eyesLocalCaptureFps,
    eyesLocalProcessingFps: row.eyesLocalProcessingFps,
    eyesMaxBufferedFrames: row.eyesMaxBufferedFrames,
  };
}

export async function getUserSettings(userId: string): Promise<UserSettings> {
  const row = await prisma.userSettings.findUnique({ where: { userId } });
  return row ? rowToSettings(row) : { ...DEFAULT_USER_SETTINGS };
}

export async function updateUserSettings(userId: string, updates: Partial<UserSettings>): Promise<UserSettings> {
  if (updates.activationMode && !ACTIVATION_MODES.includes(updates.activationMode)) {
    throw new ValidationError(`Invalid activationMode "${updates.activationMode}".`);
  }
  if (updates.clapPattern && !CLAP_PATTERNS.includes(updates.clapPattern)) {
    throw new ValidationError(`Invalid clapPattern "${updates.clapPattern}".`);
  }
  if (updates.clapSensitivity !== undefined && (updates.clapSensitivity < 1 || updates.clapSensitivity > 10)) {
    throw new ValidationError("clapSensitivity must be between 1 and 10.");
  }
  if (updates.eyesMode && !EYES_MODES.includes(updates.eyesMode)) {
    throw new ValidationError(`Invalid eyesMode "${updates.eyesMode}".`);
  }
  if (updates.eyesAttentionMode && !EYES_ATTENTION_MODES.includes(updates.eyesAttentionMode)) {
    throw new ValidationError(`Invalid eyesAttentionMode "${updates.eyesAttentionMode}".`);
  }
  if (updates.eyesUpdateLatencyPolicy && !EYES_LATENCY_POLICIES.includes(updates.eyesUpdateLatencyPolicy)) {
    throw new ValidationError(`Invalid eyesUpdateLatencyPolicy "${updates.eyesUpdateLatencyPolicy}".`);
  }
  if (updates.eyesAllowedProviders && !Array.isArray(updates.eyesAllowedProviders)) {
    throw new ValidationError("eyesAllowedProviders must be an array of provider ids.");
  }
  // Upper bounds are the point of these settings — an unbounded visual
  // buffer is exactly the memory-growth failure mode they exist to prevent.
  if (updates.eyesHistorySeconds !== undefined && (updates.eyesHistorySeconds < 5 || updates.eyesHistorySeconds > 1800)) {
    throw new ValidationError("eyesHistorySeconds must be between 5 and 1800.");
  }
  if (updates.eyesMaxKeyframes !== undefined && (updates.eyesMaxKeyframes < 0 || updates.eyesMaxKeyframes > 120)) {
    throw new ValidationError("eyesMaxKeyframes must be between 0 and 120.");
  }
  // 60fps is the documented ceiling — "up to the requested rate," never a
  // hard-coded assumption that hardware can sustain it; the platform
  // capture loop is what actually adapts down if it can't.
  // Null is explicitly allowed and is the default: it means "measure it."
  // The upper bound is a sanity limit to stop a nonsense value reaching the
  // capture loop, NOT a cap on how fast Eyes may run — a machine that can
  // sustain 240fps is permitted to.
  if (updates.eyesLocalCaptureFps !== undefined && updates.eyesLocalCaptureFps !== null) {
    if (updates.eyesLocalCaptureFps < 1 || updates.eyesLocalCaptureFps > 480) {
      throw new ValidationError("eyesLocalCaptureFps must be between 1 and 480, or null for automatic measurement.");
    }
  }
  if (updates.eyesLocalProcessingFps !== undefined && (updates.eyesLocalProcessingFps < 1 || updates.eyesLocalProcessingFps > 60)) {
    throw new ValidationError("eyesLocalProcessingFps must be between 1 and 60.");
  }
  if (updates.eyesMaxBufferedFrames !== undefined && (updates.eyesMaxBufferedFrames < 1 || updates.eyesMaxBufferedFrames > 600)) {
    throw new ValidationError("eyesMaxBufferedFrames must be between 1 and 600.");
  }

  const current = await getUserSettings(userId);
  const merged: UserSettings = { ...current, ...updates };

  const row = await prisma.userSettings.upsert({
    where: { userId },
    create: { userId, ...merged, eyesAllowedProviders: JSON.stringify(merged.eyesAllowedProviders) },
    update: { ...merged, eyesAllowedProviders: JSON.stringify(merged.eyesAllowedProviders) },
  });

  return rowToSettings(row);
}
