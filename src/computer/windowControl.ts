import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { currentPlatform } from "./platform.js";
import { NotConfiguredError, ValidationError } from "../utils/errors.js";

const execFileAsync = promisify(execFile);

export interface WindowInfo {
  title: string;
  processName?: string;
}

// Section 3: list_windows / focus_window. Real per-platform commands;
// Linux focus/list requires `wmctrl` to be installed (not bundled by
// default on every distro) — this reports that plainly via
// NotConfiguredError rather than pretending to succeed.
export async function listWindows(): Promise<WindowInfo[]> {
  const platform = currentPlatform();

  if (platform === "windows") {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object ProcessName,MainWindowTitle | ConvertTo-Json -Compress",
      ],
      { timeout: 15_000 },
    );
    const parsed = JSON.parse(stdout.trim() || "[]");
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((w) => ({ title: String(w.MainWindowTitle), processName: String(w.ProcessName) }));
  }

  if (platform === "macos") {
    const { stdout } = await execFileAsync("osascript", [
      "-e",
      'tell application "System Events" to get name of every process whose visible is true',
    ]);
    return stdout
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((name) => ({ title: name }));
  }

  try {
    const { stdout } = await execFileAsync("wmctrl", ["-l"]);
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const title = line.split(/\s+/).slice(3).join(" ");
        return { title };
      });
  } catch {
    throw new NotConfiguredError("Window listing on Linux (install wmctrl)");
  }
}

export async function focusWindow(titleOrProcess: string): Promise<{ focused: boolean }> {
  const platform = currentPlatform();
  const target = titleOrProcess.trim();
  if (!target) throw new ValidationError("A window title or process name is required.");

  if (platform === "windows") {
    // AppActivate matches on window title substring or process name.
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate('${target.replace(/'/g, "''")}')`,
    ]);
    return { focused: true };
  }

  if (platform === "macos") {
    await execFileAsync("osascript", ["-e", `tell application "${target.replace(/"/g, '\\"')}" to activate`]);
    return { focused: true };
  }

  try {
    await execFileAsync("wmctrl", ["-a", target]);
    return { focused: true };
  } catch {
    throw new NotConfiguredError("Window focusing on Linux (install wmctrl)");
  }
}
