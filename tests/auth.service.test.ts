import { describe, it, expect } from "vitest";
import { registerUser, loginUser, isSessionActive, revokeSession } from "../src/auth/authService.js";
import { AuthenticationError, ConflictError, ValidationError } from "../src/utils/errors.js";

function uniqueEmail(): string {
  return `user-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

describe("authService", () => {
  it("registers a user and issues a valid session", async () => {
    const email = uniqueEmail();
    const result = await registerUser(email, "a-strong-password");
    expect(result.user.email).toBe(email);
    expect(result.token).toBeTypeOf("string");
    expect(await isSessionActive(result.user.id)).toBe(false); // sessionId, not userId — sanity check on the API shape
  });

  it("rejects passwords shorter than 10 characters", async () => {
    await expect(registerUser(uniqueEmail(), "short")).rejects.toThrow(ValidationError);
  });

  it("rejects duplicate registration for the same email", async () => {
    const email = uniqueEmail();
    await registerUser(email, "a-strong-password");
    await expect(registerUser(email, "another-strong-pw")).rejects.toThrow(ConflictError);
  });

  it("logs in with correct credentials and rejects incorrect ones", async () => {
    const email = uniqueEmail();
    await registerUser(email, "a-strong-password");

    const login = await loginUser(email, "a-strong-password");
    expect(login.user.email).toBe(email);

    await expect(loginUser(email, "wrong-password")).rejects.toThrow(AuthenticationError);
    await expect(loginUser(uniqueEmail(), "a-strong-password")).rejects.toThrow(AuthenticationError);
  });

  it("revokes a session so it is no longer active", async () => {
    const email = uniqueEmail();
    const result = await registerUser(email, "a-strong-password");
    // Extract session id via the token by logging in again isn't needed —
    // registerUser's own session should be active until revoked.
    const claimsPayload = JSON.parse(Buffer.from(result.token.split(".")[1], "base64").toString("utf8"));
    expect(await isSessionActive(claimsPayload.sid)).toBe(true);
    await revokeSession(claimsPayload.sid);
    expect(await isSessionActive(claimsPayload.sid)).toBe(false);
  });
});
