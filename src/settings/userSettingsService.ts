import { prisma } from "../database/client.js";
import { ValidationError } from "../utils/errors.js";

// Section 11/12/28/29/88: persistent, user-controlled assistant identity,
// activation, and voice configuration. Replaces the old in-memory-only
// activation config, which reset to defaults on every restart.
export type ActivationMode = "push_to_talk" | "wake_word" | "clap" | "disabled";
export type ClapPattern = "single" | "double" | "triple";

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
};

const ACTIVATION_MODES: ActivationMode[] = ["push_to_talk", "wake_word", "clap", "disabled"];
const CLAP_PATTERNS: ClapPattern[] = ["single", "double", "triple"];

function rowToSettings(row: {
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
}): UserSettings {
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

  const current = await getUserSettings(userId);
  const merged: UserSettings = { ...current, ...updates };

  const row = await prisma.userSettings.upsert({
    where: { userId },
    create: { userId, ...merged },
    update: { ...merged },
  });

  return rowToSettings(row);
}
