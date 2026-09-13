// Section 3/9 of the Jarvis computer-control spec: cross-platform desktop
// control. This backend runs on whatever host machine the operator starts
// it on — for a genuine "control my Windows computer" experience, that
// means running this backend process on the Windows machine itself (see
// DEVELOPMENT.md / COMPUTER_CONTROL.md for the full explanation of why
// there is no separate Tauri bridge doing this instead).
export type DesktopPlatform = "windows" | "linux" | "macos";

export function currentPlatform(): DesktopPlatform {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    default:
      return "linux";
  }
}

export function isWindows(): boolean {
  return currentPlatform() === "windows";
}

export function isMac(): boolean {
  return currentPlatform() === "macos";
}

export function isLinux(): boolean {
  return currentPlatform() === "linux";
}
