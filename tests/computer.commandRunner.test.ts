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
    expect(isCommandAllowed("node")).toBe(true);
    expect(isCommandAllowed("false")).toBe(true);
    expect(isCommandAllowed("rm")).toBe(false);
    expect(isCommandAllowed("bash")).toBe(false);
  });

  it("refuses to run a non-allowlisted command with a clear error", async () => {
    await expect(runAllowlistedCommand("rm", ["-rf", "/"])).rejects.toThrow(ValidationError);
  });

  it("refuses a path instead of a bare executable name, even if the basename is allowlisted", async () => {
    await expect(runAllowlistedCommand("/bin/node", ["-e", "1"])).rejects.toThrow(ValidationError);
  });

  it("actually runs an allowlisted command and returns its output", async () => {
    // "node" rather than the POSIX-only "echo": node is guaranteed
    // present on every platform these tests run on (it's the interpreter
    // running the test itself), whereas "echo" is only a cmd.exe
    // built-in on Windows with no standalone executable at all — using
    // it here would test a platform gap in the fixture, not in
    // runAllowlistedCommand()'s own (already platform-agnostic) logic.
    const result = await runAllowlistedCommand("node", ["-e", "console.log('hello-from-jarvis')"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello-from-jarvis");
  });

  it("captures a nonzero exit code instead of throwing", async () => {
    const result = await runAllowlistedCommand("node", ["-e", "process.exit(7)"]);
    expect(result.exitCode).not.toBe(0);
  });
});
