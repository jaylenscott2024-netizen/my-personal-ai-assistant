import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { currentPlatform } from "./platform.js";
import { NotConfiguredError, ValidationError } from "../utils/errors.js";

const execFileAsync = promisify(execFile);

// Section 3/8: keyboard/mouse control (MEDIUM risk per the spec's own
// tiering). Shells out to the standard automation tool for each platform
// rather than adding a native-binding dependency (robotjs/nut-js) that
// would need to compile against a display server this environment
// doesn't have — xdotool needs a live X11 display, which this sandbox
// does not have, so these are real, correct command invocations that are
// unverified end-to-end here. See COMPUTER_CONTROL.md.
function requireLinuxXdotool(): void {
  if (!process.env.DISPLAY) {
    throw new NotConfiguredError("Keyboard/mouse control on Linux (no DISPLAY — requires a graphical session and xdotool)");
  }
}

export async function typeText(text: string): Promise<{ typed: string }> {
  const platform = currentPlatform();
  if (platform === "windows") {
    const escaped = text.replace(/'/g, "''").replace(/[{}()+^%~]/g, "{$&}");
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')`,
    ]);
  } else if (platform === "macos") {
    await execFileAsync("osascript", ["-e", `tell application "System Events" to keystroke "${text.replace(/"/g, '\\"')}"`]);
  } else {
    requireLinuxXdotool();
    await execFileAsync("xdotool", ["type", "--", text]);
  }
  return { typed: text };
}

export async function pressKey(key: string): Promise<{ pressed: string }> {
  const platform = currentPlatform();
  if (platform === "windows") {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${key.replace(/'/g, "''")}')`,
    ]);
  } else if (platform === "macos") {
    await execFileAsync("osascript", ["-e", `tell application "System Events" to key code ${mapMacKeyCode(key)}`]);
  } else {
    requireLinuxXdotool();
    await execFileAsync("xdotool", ["key", key]);
  }
  return { pressed: key };
}

export async function hotkey(keys: string[]): Promise<{ pressed: string[] }> {
  if (keys.length === 0) throw new ValidationError("hotkey requires at least one key.");
  const platform = currentPlatform();
  if (platform === "windows") {
    // SendKeys modifier syntax: ^=ctrl, %=alt, +=shift, e.g. ^c for Ctrl+C
    const map: Record<string, string> = { ctrl: "^", alt: "%", shift: "+", win: "" };
    const combo = keys.map((k) => map[k.toLowerCase()] ?? k).join("");
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${combo}')`,
    ]);
  } else if (platform === "macos") {
    const modifiers = keys.slice(0, -1).map((k) => `${k.toLowerCase()} down`);
    const mainKey = keys[keys.length - 1];
    await execFileAsync("osascript", ["-e", `tell application "System Events" to keystroke "${mainKey}" using {${modifiers.join(", ")}}`]);
  } else {
    requireLinuxXdotool();
    await execFileAsync("xdotool", ["key", keys.join("+")]);
  }
  return { pressed: keys };
}

function mapMacKeyCode(key: string): number {
  const codes: Record<string, number> = { return: 36, enter: 36, tab: 48, space: 49, escape: 53, delete: 51 };
  return codes[key.toLowerCase()] ?? 0;
}

export async function click(x: number, y: number, button: "left" | "right" = "left"): Promise<{ x: number; y: number }> {
  const platform = currentPlatform();
  if (platform === "windows") {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y})`,
    ]);
    // A full native click requires a small P/Invoke shim; moving the
    // cursor into place is implemented and verified in code, the click
    // event itself needs mouse_event/SendInput — see COMPUTER_CONTROL.md
    // for the documented gap.
    throw new NotConfiguredError("Mouse click on Windows (cursor positioning works; the click event itself needs a native shim not included here)");
  }
  if (platform === "macos") {
    await execFileAsync("osascript", ["-e", `tell application "System Events" to ${button === "right" ? "right click" : "click"} at {${x}, ${y}}`]);
    return { x, y };
  }
  requireLinuxXdotool();
  await execFileAsync("xdotool", ["mousemove", String(x), String(y), "click", button === "right" ? "3" : "1"]);
  return { x, y };
}

export async function moveMouse(x: number, y: number): Promise<{ x: number; y: number }> {
  const platform = currentPlatform();
  if (platform === "windows") {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y})`,
    ]);
    return { x, y };
  }
  if (platform === "macos") {
    throw new NotConfiguredError("Mouse movement on macOS (requires Accessibility permissions + a native automation helper)");
  }
  requireLinuxXdotool();
  await execFileAsync("xdotool", ["mousemove", String(x), String(y)]);
  return { x, y };
}
