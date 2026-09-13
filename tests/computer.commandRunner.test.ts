import { describe, it, expect } from "vitest";
import { isCommandAllowed, runAllowlistedCommand } from "../src/computer/commandRunner.js";
import { envSchemaDefaults } from "../src/config/env.js";
import { ValidationError } from "../src/utils/errors.js";

// Section 8: "Do NOT simply give the LLM unrestricted shell access." This
// is the actual enforcement point. Config (env.ts) is a frozen singleton
// read once at process startup, so these tests exercise it against the
// fixed allowlist tests/setup.ts configures ("echo,false") rather than
// toggling process.env per case.
describe("computer command allowlist", () => {
  it("is empty by default in a real deployment (secure by default)", () => {
    expect(envSchemaDefaults.COMPUTER_COMMAND_ALLOWLIST).toBe("");
  });

  it("allows only executables explicitly named in the configured allowlist", () => {
    expect(isCommandAllowed("echo")).toBe(true);
    expect(isCommandAllowed("false")).toBe(true);
    expect(isCommandAllowed("rm")).toBe(false);
    expect(isCommandAllowed("bash")).toBe(false);
  });

  it("refuses to run a non-allowlisted command with a clear error", async () => {
    await expect(runAllowlistedCommand("rm", ["-rf", "/"])).rejects.toThrow(ValidationError);
  });

  it("refuses a path instead of a bare executable name, even if the basename is allowlisted", async () => {
    await expect(runAllowlistedCommand("/bin/echo", ["hi"])).rejects.toThrow(ValidationError);
  });

  it("actually runs an allowlisted command and returns its output", async () => {
    const result = await runAllowlistedCommand("echo", ["hello-from-jarvis"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello-from-jarvis");
  });

  it("captures a nonzero exit code instead of throwing", async () => {
    const result = await runAllowlistedCommand("false", []);
    expect(result.exitCode).not.toBe(0);
  });
});
