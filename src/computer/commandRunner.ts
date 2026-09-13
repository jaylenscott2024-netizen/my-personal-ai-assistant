import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "../config/env.js";
import { ValidationError } from "../utils/errors.js";

const execFileAsync = promisify(execFile);

// Section 8: "Do NOT simply give the LLM unrestricted shell access. Use
// an allowlisted/scoped execution architecture." This is that
// architecture: an executable is only ever runnable if its bare name (no
// path, no shell metacharacters) is in COMPUTER_COMMAND_ALLOWLIST — which
// is empty by default, so an operator must explicitly opt each one in.
// Even an allowlisted command still goes through the same
// permission-check + mandatory-approval gate as everything else in the
// tool registry (computer.execute is always CRITICAL risk — see
// security/permissions.ts), so this is defense in depth, not the only
// gate.
function parseAllowlist(): Set<string> {
  return new Set(
    env.COMPUTER_COMMAND_ALLOWLIST.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function isCommandAllowed(executable: string): boolean {
  return parseAllowlist().has(executable);
}

export async function runAllowlistedCommand(executable: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (/[\\/]/.test(executable)) {
    throw new ValidationError("Only a bare executable name is allowed, not a path.");
  }
  if (!isCommandAllowed(executable)) {
    const allowlist = [...parseAllowlist()];
    throw new ValidationError(
      allowlist.length > 0
        ? `"${executable}" is not in the allowed command list (${allowlist.join(", ")}). An operator must add it to COMPUTER_COMMAND_ALLOWLIST.`
        : `"${executable}" is not allowed — no commands are allowlisted (COMPUTER_COMMAND_ALLOWLIST is empty). An operator must explicitly opt commands in.`,
    );
  }

  try {
    const { stdout, stderr } = await execFileAsync(executable, args, { timeout: 30_000, maxBuffer: 1024 * 1024 });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? (err as Error).message, exitCode: e.code ?? 1 };
  }
}
