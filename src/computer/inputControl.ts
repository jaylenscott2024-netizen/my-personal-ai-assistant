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

// Windows mouse events, via user32!mouse_event (winuser.h flags below).
// This is the P/Invoke shim the click()/moveMouse() doc comments used to
// say was "not included here" — SendKeys/Cursor.Position alone can
// position the cursor but cannot generate an actual button-down/up or
// wheel event, so computer_click on Windows previously always threw
// NotConfiguredError. mouse_event (rather than the newer SendInput) is
// used because it needs no marshaled struct — a single flat P/Invoke
// declaration — which keeps this shim as small and reviewable as the
// action it performs.
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_WHEEL = 0x0800;
const WHEEL_DELTA = 120;

const MOUSE_EVENT_TYPE = `
Add-Type -TypeDefinition '
using System;
using System.Runtime.InteropServices;
public class JarvisMouse {
  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);
}
' -ErrorAction SilentlyContinue;`.trim();

function moveCursorPs(x: number, y: number): string {
  return `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y});`;
}

function mouseEventPs(flag: number, data = 0): string {
  return `[JarvisMouse]::mouse_event(${flag}, 0, 0, ${data}, [IntPtr]::Zero);`;
}

async function runWindowsMouseScript(script: string): Promise<void> {
  await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Add-Type -AssemblyName System.Windows.Forms; ${MOUSE_EVENT_TYPE} ${script}`,
  ]);
}

export async function click(x: number, y: number, button: "left" | "right" = "left"): Promise<{ x: number; y: number }> {
  const platform = currentPlatform();
  if (platform === "windows") {
    const [down, up] = button === "right" ? [MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP] : [MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP];
    await runWindowsMouseScript(moveCursorPs(x, y) + mouseEventPs(down) + mouseEventPs(up));
    return { x, y };
  }
  if (platform === "macos") {
    await execFileAsync("osascript", ["-e", `tell application "System Events" to ${button === "right" ? "right click" : "click"} at {${x}, ${y}}`]);
    return { x, y };
  }
  requireLinuxXdotool();
  await execFileAsync("xdotool", ["mousemove", String(x), String(y), "click", button === "right" ? "3" : "1"]);
  return { x, y };
}

export async function doubleClick(x: number, y: number): Promise<{ x: number; y: number }> {
  const platform = currentPlatform();
  if (platform === "windows") {
    const clickOnce = mouseEventPs(MOUSEEVENTF_LEFTDOWN) + mouseEventPs(MOUSEEVENTF_LEFTUP);
    await runWindowsMouseScript(moveCursorPs(x, y) + clickOnce + clickOnce);
    return { x, y };
  }
  if (platform === "macos") {
    await execFileAsync("osascript", ["-e", `tell application "System Events" to double click at {${x}, ${y}}`]);
    return { x, y };
  }
  requireLinuxXdotool();
  await execFileAsync("xdotool", ["mousemove", String(x), String(y), "click", "--repeat", "2", "--delay", "50", "1"]);
  return { x, y };
}

/** Positive amount scrolls up/away from the user, negative scrolls down —
 *  matches the sign convention of a physical scroll wheel and of
 *  MOUSEEVENTF_WHEEL's dwData. */
export async function scroll(x: number, y: number, amount: number): Promise<{ x: number; y: number; amount: number }> {
  const platform = currentPlatform();
  if (platform === "windows") {
    const delta = Math.round(amount * WHEEL_DELTA);
    // dwData is declared as uint; a negative delta must be passed as its
    // 32-bit unsigned representation or PowerShell's numeric conversion
    // throws rather than wrapping.
    const unsignedDelta = delta < 0 ? (delta >>> 0) : delta;
    await runWindowsMouseScript(moveCursorPs(x, y) + mouseEventPs(MOUSEEVENTF_WHEEL, unsignedDelta));
    return { x, y, amount };
  }
  if (platform === "macos") {
    throw new NotConfiguredError("Mouse scroll on macOS (requires Accessibility permissions + a native automation helper)");
  }
  requireLinuxXdotool();
  // xdotool has no wheel-delta primitive; it simulates a wheel step as a
  // button click (4 = up, 5 = down), repeated to approximate magnitude.
  const button = amount >= 0 ? "4" : "5";
  const steps = Math.max(1, Math.round(Math.abs(amount)));
  await execFileAsync("xdotool", ["mousemove", String(x), String(y), "click", "--repeat", String(steps), button]);
  return { x, y, amount };
}

export async function drag(fromX: number, fromY: number, toX: number, toY: number): Promise<{ from: { x: number; y: number }; to: { x: number; y: number } }> {
  const platform = currentPlatform();
  if (platform === "windows") {
    await runWindowsMouseScript(moveCursorPs(fromX, fromY) + mouseEventPs(MOUSEEVENTF_LEFTDOWN) + moveCursorPs(toX, toY) + mouseEventPs(MOUSEEVENTF_LEFTUP));
    return { from: { x: fromX, y: fromY }, to: { x: toX, y: toY } };
  }
  if (platform === "macos") {
    // System Events' scripting dictionary has no press-move-release
    // primitive (only discrete "click"/"double click" at a point), so a
    // real drag needs a native Accessibility-API helper this project does
    // not bundle. Reporting that honestly rather than shipping an
    // AppleScript that merely clicks the start point and calls it a drag.
    throw new NotConfiguredError("Mouse drag on macOS (requires Accessibility permissions + a native automation helper for press-move-release)");
  }
  requireLinuxXdotool();
  await execFileAsync("xdotool", ["mousemove", String(fromX), String(fromY), "mousedown", "1", "mousemove", String(toX), String(toY), "mouseup", "1"]);
  return { from: { x: fromX, y: fromY }, to: { x: toX, y: toY } };
}

export async function moveMouse(x: number, y: number): Promise<{ x: number; y: number }> {
  const platform = currentPlatform();
  if (platform === "windows") {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      `Add-Type -AssemblyName System.Windows.Forms; ${moveCursorPs(x, y)}`,
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
