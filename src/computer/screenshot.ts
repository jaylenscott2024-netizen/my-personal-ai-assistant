import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { currentPlatform } from "./platform.js";
import { NotConfiguredError } from "../utils/errors.js";

const execFileAsync = promisify(execFile);

// Section 3: computer.screenshot / computer.get_screen (LOW risk — "read
// screen"). Genuinely captures the display via each platform's standard
// screenshot utility; honestly reports NotConfiguredError when no display
// is available (this sandbox has none) rather than returning a fake image.
export async function captureScreenshot(): Promise<{ pngBase64: string }> {
  const platform = currentPlatform();
  const tmpFile = path.join(os.tmpdir(), `jarvis-screenshot-${Date.now()}.png`);

  try {
    if (platform === "windows") {
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
        "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen;",
        "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height;",
        "$g = [System.Drawing.Graphics]::FromImage($bmp);",
        "$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size);",
        `$bmp.Save('${tmpFile.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png);`,
      ].join(" ");
      await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], { timeout: 15_000 });
    } else if (platform === "macos") {
      await execFileAsync("screencapture", ["-x", tmpFile], { timeout: 15_000 });
    } else {
      if (!process.env.DISPLAY) {
        throw new NotConfiguredError("Screenshot on Linux (no DISPLAY — requires a graphical session)");
      }
      await tryLinuxScreenshotTools(tmpFile);
    }

    const data = await fs.readFile(tmpFile);
    return { pngBase64: data.toString("base64") };
  } finally {
    await fs.rm(tmpFile, { force: true }).catch(() => undefined);
  }
}

async function tryLinuxScreenshotTools(outputPath: string): Promise<void> {
  const attempts: Array<[string, string[]]> = [
    ["gnome-screenshot", ["-f", outputPath]],
    ["scrot", [outputPath]],
    ["import", ["-window", "root", outputPath]], // ImageMagick
  ];
  let lastError: unknown;
  for (const [cmd, args] of attempts) {
    try {
      await execFileAsync(cmd, args, { timeout: 15_000 });
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw new NotConfiguredError(`Screenshot on Linux (install gnome-screenshot, scrot, or ImageMagick — none were usable: ${(lastError as Error)?.message})`);
}
