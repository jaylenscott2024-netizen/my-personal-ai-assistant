import { prisma } from "../database/client.js";
import { ValidationError } from "../utils/errors.js";

// Section 11/12/28/29/88: persistent, user-controlled assistant identity,
// activation, and voice configuration. Replaces the old in-memory-only
// activation config, which reset to defaults on every restart.
export type ActivationMode = "push_to_talk" | "wake_word" | "clap" | "disabled";
export type ClapPattern = "single" | "double" | "triple";
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

  const current = await getUserSettings(userId);
  const merged: UserSettings = { ...current, ...updates };

  const row = await prisma.userSettings.upsert({
    where: { userId },
    create: { userId, ...merged, eyesAllowedProviders: JSON.stringify(merged.eyesAllowedProviders) },
    update: { ...merged, eyesAllowedProviders: JSON.stringify(merged.eyesAllowedProviders) },
  });

  return rowToSettings(row);
}
