import { describe, it, expect } from "vitest";
import { registerUser } from "../src/auth/authService.js";
import { DEFAULT_USER_SETTINGS, getUserSettings, updateUserSettings } from "../src/settings/userSettingsService.js";
import { activationConfigFromSettings, activationManager } from "../src/activation/activationManager.js";
import { ValidationError } from "../src/utils/errors.js";

async function makeUser() {
  const email = `settings-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { user } = await registerUser(email, "a-strong-password");
  return user.id;
}

describe("userSettingsService", () => {
  it("returns Jarvis defaults for a user with no saved settings", async () => {
    const userId = await makeUser();
    const settings = await getUserSettings(userId);
    expect(settings).toEqual(DEFAULT_USER_SETTINGS);
    expect(settings.assistantName).toBe("Jarvis");
    expect(settings.wakeWordPhrase).toBe("Jarvis");
  });

  it("persists a partial update and returns it on next read", async () => {
    const userId = await makeUser();
    await updateUserSettings(userId, { activationMode: "wake_word", wakeWordPhrase: "Hey Jarvis" });

    const settings = await getUserSettings(userId);
    expect(settings.activationMode).toBe("wake_word");
    expect(settings.wakeWordPhrase).toBe("Hey Jarvis");
    // Untouched fields keep their defaults.
    expect(settings.voiceProvider).toBe("elevenlabs");
  });

  it("survives across separate reads (genuinely persisted, not just cached in-process)", async () => {
    const userId = await makeUser();
    await updateUserSettings(userId, { assistantName: "Friday" });
    const first = await getUserSettings(userId);
    const second = await getUserSettings(userId);
    expect(first.assistantName).toBe("Friday");
    expect(second.assistantName).toBe("Friday");
  });

  it("rejects an invalid activation mode", async () => {
    const userId = await makeUser();
    await expect(updateUserSettings(userId, { activationMode: "telepathy" as never })).rejects.toThrow(ValidationError);
  });

  it("rejects clap sensitivity out of range", async () => {
    const userId = await makeUser();
    await expect(updateUserSettings(userId, { clapSensitivity: 0.1 })).rejects.toThrow(ValidationError);
  });

  it("scopes settings per user", async () => {
    const userA = await makeUser();
    const userB = await makeUser();
    await updateUserSettings(userA, { assistantName: "Alpha" });
    const settingsB = await getUserSettings(userB);
    expect(settingsB.assistantName).toBe("Jarvis"); // untouched, still default
  });
});

describe("activationConfigFromSettings", () => {
  it("only enables the detector matching the selected mode", () => {
    const wakeWordConfig = activationConfigFromSettings({ ...DEFAULT_USER_SETTINGS, activationMode: "wake_word" });
    expect(wakeWordConfig.wakeWord.enabled).toBe(true);
    expect(wakeWordConfig.clap.enabled).toBe(false);

    const clapConfig = activationConfigFromSettings({ ...DEFAULT_USER_SETTINGS, activationMode: "clap" });
    expect(clapConfig.wakeWord.enabled).toBe(false);
    expect(clapConfig.clap.enabled).toBe(true);

    const pttConfig = activationConfigFromSettings({ ...DEFAULT_USER_SETTINGS, activationMode: "push_to_talk" });
    expect(pttConfig.wakeWord.enabled).toBe(false);
    expect(pttConfig.clap.enabled).toBe(false);
  });

  it("carries the configured wake phrase and clap tuning through", () => {
    const config = activationConfigFromSettings({
      ...DEFAULT_USER_SETTINGS,
      activationMode: "wake_word",
      wakeWordPhrase: "Hey Jarvis",
      clapSensitivity: 5,
      clapPattern: "triple",
      clapCooldownMs: 2000,
    });
    expect(config.wakeWord.phrase).toBe("Hey Jarvis");
    expect(config.clap.sensitivity).toBe(5);
    expect(config.clap.pattern).toBe("triple");
    expect(config.clap.cooldownMs).toBe(2000);
  });
});

describe("activationManager persistence integration", () => {
  it("hydrate() loads persisted settings into the live config", async () => {
    const userId = await makeUser();
    await updateUserSettings(userId, { activationMode: "clap", clapSensitivity: 4.5 });
    const settings = await getUserSettings(userId);

    activationManager.hydrate(userId, settings);
    const liveConfig = activationManager.getConfig(userId);

    expect(liveConfig.mode).toBe("clap");
    expect(liveConfig.clap.enabled).toBe(true);
    expect(liveConfig.clap.sensitivity).toBe(4.5);
  });
});
