import { describe, it, expect } from "vitest";
import { registerUser } from "../src/auth/authService.js";
import { resolveApiKey } from "../src/voice/credentialResolution.js";
import { upsertUserCredential } from "../src/security/credentials.js";
import { NotConfiguredError } from "../src/utils/errors.js";

async function makeUser() {
  const email = `cred-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { user } = await registerUser(email, "a-strong-password");
  return user.id;
}

// Section 2/16 of the Jarvis spec: voice providers must resolve API keys
// through the same encrypted, user-scoped credential system every other
// integration uses — never a separate plaintext store, and the key must
// never come back out through a normal read.
describe("voice credential resolution", () => {
  it("prefers a user-configured encrypted credential over the env fallback", async () => {
    const userId = await makeUser();
    await upsertUserCredential(userId, "elevenlabs", "user-scoped-secret-key");

    const resolved = await resolveApiKey(userId, "elevenlabs", "env-level-fallback-key", "ElevenLabs");
    expect(resolved).toBe("user-scoped-secret-key");
  });

  it("falls back to the env-level key when the user has no saved credential", async () => {
    const userId = await makeUser();
    const resolved = await resolveApiKey(userId, "elevenlabs", "env-level-fallback-key", "ElevenLabs");
    expect(resolved).toBe("env-level-fallback-key");
  });

  it("throws NotConfiguredError when neither a credential nor an env value exists", async () => {
    const userId = await makeUser();
    await expect(resolveApiKey(userId, "elevenlabs", undefined, "ElevenLabs")).rejects.toThrow(NotConfiguredError);
  });

  it("uses only the env value for a system-level call with no userId", async () => {
    await expect(resolveApiKey(undefined, "elevenlabs", undefined, "ElevenLabs")).rejects.toThrow(NotConfiguredError);
    const resolved = await resolveApiKey(undefined, "elevenlabs", "env-key", "ElevenLabs");
    expect(resolved).toBe("env-key");
  });

  it("never leaks the resolved secret through the credential upsert response", async () => {
    const userId = await makeUser();
    const result = await upsertUserCredential(userId, "elevenlabs", "top-secret-value");
    expect(JSON.stringify(result)).not.toContain("top-secret-value");
  });
});
