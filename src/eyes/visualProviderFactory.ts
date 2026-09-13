import { currentPlatform } from "../computer/platform.js";
import { env } from "../config/env.js";
import type { VisualProvider } from "./visualProvider.js";
import { UnsupportedVisualProvider } from "./providers/unsupportedVisualProvider.js";

// Test-only seam, mirroring ai/router.ts's __registerProviderForTesting
// and voice/voiceRegistry.ts's __registerVoiceProviderForTesting.
let overrideForTesting: VisualProvider | null = null;
export function __setVisualProviderForTesting(provider: VisualProvider | null): void {
  if (env.NODE_ENV !== "test") {
    throw new Error("__setVisualProviderForTesting is only available when NODE_ENV=test.");
  }
  overrideForTesting = provider;
}

// Lazily imports the Windows implementation only on Windows, so nothing
// in this module graph ever tries to load Win32-specific code on
// Linux/macOS (there's nothing platform-conditional to fail, but this
// keeps the dependency direction clean and matches how computer/*.ts
// branches by platform).
export async function createVisualProvider(): Promise<VisualProvider> {
  if (overrideForTesting) return overrideForTesting;

  const platform = currentPlatform();
  if (platform === "windows") {
    const { WindowsVisualProvider } = await import("./providers/windows/windowsVisualProvider.js");
    return new WindowsVisualProvider();
  }
  return new UnsupportedVisualProvider(platform, `Jarvis Eyes currently has a real implementation for Windows only (this host is ${platform})`);
}
