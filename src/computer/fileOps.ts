import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { currentPlatform } from "./platform.js";
import { ValidationError } from "../utils/errors.js";

const execFileAsync = promisify(execFile);

// Section 5/39 distinction: this operates on the user's real desktop
// filesystem (their actual Downloads folder, Desktop, Documents — not the
// sandboxed workspace tools/builtin/filesystemTool.ts is scoped to). A
// real desktop assistant needs that broader reach, so instead of a single
// allowed root, this blocks a fixed list of operating-system-critical
// paths no legitimate "organize my files" request should ever touch.
// Everything else is allowed, gated by permission + approval, not by path.
const POSIX_DANGEROUS_PATH_PATTERNS: RegExp[] = [/^\/(bin|sbin|usr|etc|lib|lib64|boot|sys|proc|dev)(\/|$)/, /^\/System(\/|$)/, /^\/Library(\/|$)/];
const WINDOWS_DANGEROUS_PATH_PATTERNS: RegExp[] = [/^[a-z]:\\windows(\\|$)/i, /^[a-z]:\\program files/i, /^[a-z]:\\programdata(\\|$)/i];
// Checked regardless of which platform Jarvis is actually running on
// (see assertSafePath below for why) — a strict superset of either
// platform's own native check, so this can only ever block MORE paths
// than a single-platform list would, never fewer.
const ALL_DANGEROUS_PATH_PATTERNS: RegExp[] = [...POSIX_DANGEROUS_PATH_PATTERNS, ...WINDOWS_DANGEROUS_PATH_PATTERNS];

function assertSafePath(target: string): string {
  const expanded = target.replace(/^~/, os.homedir());
  const resolved = path.resolve(expanded);

  // path.resolve() is platform-native, which silently defeats a
  // cross-platform-shaped critical-path check if it only ran on the
  // resolved output: on Windows, a POSIX-style input like "/etc/passwd"
  // resolves relative to the current drive (e.g. "C:\etc\passwd" — a
  // harmless-looking path with no leading "/etc"), so a check that only
  // looked at the resolved path would never recognize this input as the
  // well-known critical directory it names. Checking the raw input
  // (before resolution) against BOTH POSIX- and Windows-style dangerous
  // prefixes closes that gap: a caller (an LLM tool call, a path copied
  // from documentation written for a different OS) could hand this
  // either style regardless of which platform Jarvis actually runs on.
  // The resolved path is still checked too — that's what catches
  // traversal (e.g. "../../../../etc/passwd") that only becomes a
  // critical path after normalization, which the raw-input check alone
  // would miss since it doesn't look like a dangerous prefix pre-resolution.
  const candidates = [expanded, resolved, expanded.replace(/\\/g, "/"), resolved.replace(/\\/g, "/")];
  if (ALL_DANGEROUS_PATH_PATTERNS.some((pattern) => candidates.some((candidate) => pattern.test(candidate)))) {
    throw new ValidationError(`Refusing to operate on a system path: "${resolved}".`);
  }
  return resolved;
}

export async function openFile(targetPath: string): Promise<{ opened: string }> {
  const resolved = assertSafePath(targetPath);
  await openWithDefaultApp(resolved);
  return { opened: resolved };
}

export async function openFolder(targetPath: string): Promise<{ opened: string }> {
  const resolved = assertSafePath(targetPath);
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) throw new ValidationError(`"${resolved}" is not a directory.`);
  await openWithDefaultApp(resolved);
  return { opened: resolved };
}

async function openWithDefaultApp(resolved: string): Promise<void> {
  const platform = currentPlatform();
  if (platform === "windows") {
    await execFileAsync("powershell.exe", ["-NoProfile", "-Command", `Invoke-Item -LiteralPath '${resolved.replace(/'/g, "''")}'`], {
      timeout: 15_000,
    });
  } else if (platform === "macos") {
    await execFileAsync("open", [resolved], { timeout: 15_000 });
  } else {
    const child = spawn("xdg-open", [resolved], { detached: true, stdio: "ignore" });
    child.unref();
  }
}

export async function createFolder(targetPath: string): Promise<{ created: string }> {
  const resolved = assertSafePath(targetPath);
  await fs.mkdir(resolved, { recursive: true });
  return { created: resolved };
}

export async function moveFile(from: string, to: string): Promise<{ from: string; to: string }> {
  const src = assertSafePath(from);
  const dest = assertSafePath(to);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rename(src, dest);
  return { from: src, to: dest };
}

export async function copyFile(from: string, to: string): Promise<{ from: string; to: string }> {
  const src = assertSafePath(from);
  const dest = assertSafePath(to);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const stat = await fs.stat(src);
  if (stat.isDirectory()) {
    await fs.cp(src, dest, { recursive: true });
  } else {
    await fs.copyFile(src, dest);
  }
  return { from: src, to: dest };
}

export async function deleteFile(targetPath: string): Promise<{ deleted: string }> {
  const resolved = assertSafePath(targetPath);
  await fs.rm(resolved, { recursive: true, force: true });
  return { deleted: resolved };
}

export { assertSafePath };
