import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { currentPlatform } from "./platform.js";
import { childLogger } from "../config/logger.js";

const execFileAsync = promisify(execFile);
const log = childLogger("appDiscovery");

// Section 4 of the Jarvis spec: application discovery instead of a
// hard-coded app list. Each platform has a real, standard place
// installed applications register themselves — this reads from there
// rather than maintaining a list of "known" apps.
export interface DiscoveredApp {
  id: string;
  name: string;
  /** What to hand to appLauncher.ts to actually start it — platform-specific. */
  launchTarget: string;
  source: "windows_start_apps" | "linux_desktop_file" | "macos_applications";
}

let cache: { apps: DiscoveredApp[]; at: number } | null = null;
const CACHE_TTL_MS = 60_000; // installed apps don't change every second; avoid re-scanning on every request

export async function discoverApplications(forceRefresh = false): Promise<DiscoveredApp[]> {
  if (!forceRefresh && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.apps;
  }
  const platform = currentPlatform();
  let apps: DiscoveredApp[];
  if (platform === "windows") apps = await discoverWindowsApps();
  else if (platform === "macos") apps = await discoverMacApps();
  else apps = await discoverLinuxApps();

  cache = { apps, at: Date.now() };
  return apps;
}

// --- Windows: Get-StartApps enumerates the Start Menu's actual app list
// (both classic Win32 shortcuts and UWP/Store apps) without needing to
// parse .lnk shortcut binaries or walk the registry by hand. AppID is
// exactly what `explorer.exe shell:AppsFolder\<AppID>` or Start-Process
// expects (appLauncher.ts). Unverified in this sandbox (no Windows host
// available) — the PowerShell invocation itself is standard and stable
// across modern Windows versions.
async function discoverWindowsApps(): Promise<DiscoveredApp[]> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-StartApps | ConvertTo-Json -Compress"],
      { timeout: 15_000 },
    );
    const parsed = JSON.parse(stdout.trim() || "[]");
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter((entry) => entry && entry.Name && entry.AppID)
      .map((entry) => ({
        id: String(entry.AppID),
        name: String(entry.Name),
        launchTarget: String(entry.AppID),
        source: "windows_start_apps" as const,
      }));
  } catch (err) {
    log.warn({ err }, "Windows application discovery failed (Get-StartApps)");
    return [];
  }
}

// --- macOS: /Applications and ~/Applications are the two standard
// install locations; every .app bundle there is launchable via `open -a`.
async function discoverMacApps(): Promise<DiscoveredApp[]> {
  const dirs = ["/Applications", path.join(os.homedir(), "Applications")];
  const apps: DiscoveredApp[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".app")) continue;
      const name = entry.replace(/\.app$/, "");
      apps.push({ id: path.join(dir, entry), name, launchTarget: path.join(dir, entry), source: "macos_applications" });
    }
  }
  return apps;
}

// --- Linux: the XDG standard puts every installed application's launcher
// metadata in a .desktop file under one of a handful of well-known
// directories. This is the same mechanism every desktop environment's
// app menu (GNOME, KDE, etc.) reads from — genuinely testable in this
// sandbox, which has real .desktop files installed.
function parseDesktopFile(content: string): { name?: string; exec?: string; noDisplay?: boolean; hidden?: boolean } {
  const lines = content.split("\n");
  let inEntrySection = false;
  const result: { name?: string; exec?: string; noDisplay?: boolean; hidden?: boolean } = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inEntrySection = line === "[Desktop Entry]";
      continue;
    }
    if (!inEntrySection || !line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    if (key === "Name") result.name = value;
    else if (key === "Exec") result.exec = value;
    else if (key === "NoDisplay") result.noDisplay = value.toLowerCase() === "true";
    else if (key === "Hidden") result.hidden = value.toLowerCase() === "true";
  }
  return result;
}

// Exec= values use freedesktop field codes (%f, %F, %u, %U, %i, %c, %k)
// as placeholders for file arguments we're not providing — strip them so
// the remaining string is a plain, directly-executable command.
function cleanExecCommand(exec: string): string {
  return exec.replace(/%[fFuUick]/g, "").trim();
}

function xdgDataDirs(): string[] {
  const home = os.homedir();
  const xdgDataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const xdgDataDirs = (process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":");
  return [xdgDataHome, ...xdgDataDirs].map((d) => path.join(d, "applications"));
}

async function discoverLinuxApps(): Promise<DiscoveredApp[]> {
  const apps: DiscoveredApp[] = [];
  const seen = new Set<string>();

  for (const dir of xdgDataDirs()) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".desktop") || seen.has(entry)) continue;
      seen.add(entry);
      try {
        const content = await fs.readFile(path.join(dir, entry), "utf8");
        const parsed = parseDesktopFile(content);
        if (!parsed.name || !parsed.exec || parsed.noDisplay || parsed.hidden) continue;
        apps.push({
          id: entry,
          name: parsed.name,
          launchTarget: cleanExecCommand(parsed.exec),
          source: "linux_desktop_file",
        });
      } catch (err) {
        log.debug({ err, entry }, "failed to parse .desktop file, skipping");
      }
    }
  }
  return apps;
}

export interface AppMatch {
  app: DiscoveredApp;
  score: number;
}

// Section 4: resolve a natural-language request ("Blender", "open my
// browser") to the right installed application, and say so plainly when
// there's real ambiguity rather than guessing.
export function matchApplications(query: string, apps: DiscoveredApp[]): AppMatch[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  const scored = apps.map((app) => {
    const name = app.name.toLowerCase();
    let score = 0;
    if (name === normalizedQuery) score = 100;
    else if (name.startsWith(normalizedQuery)) score = 80;
    else if (name.includes(normalizedQuery)) score = 60;
    else {
      const queryTokens = normalizedQuery.split(/\s+/);
      const nameTokens = name.split(/\s+/);
      const overlap = queryTokens.filter((t) => nameTokens.some((n) => n.includes(t))).length;
      score = overlap > 0 ? (overlap / queryTokens.length) * 40 : 0;
    }
    return { app, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}
