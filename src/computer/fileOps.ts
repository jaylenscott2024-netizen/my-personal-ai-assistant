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
const DANGEROUS_PATH_PATTERNS: RegExp[] =
  currentPlatform() === "windows"
    ? [/^[a-z]:\\windows(\\|$)/i, /^[a-z]:\\program files/i, /^[a-z]:\\programdata(\\|$)/i]
    : [/^\/(bin|sbin|usr|etc|lib|lib64|boot|sys|proc|dev)(\/|$)/, /^\/System(\/|$)/, /^\/Library(\/|$)/];

function assertSafePath(target: string): string {
  const resolved = path.resolve(target.replace(/^~/, os.homedir()));
  if (DANGEROUS_PATH_PATTERNS.some((pattern) => pattern.test(resolved))) {
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
