import { describe, it, expect } from "vitest";
import { UnsupportedVisualProvider } from "../src/eyes/providers/unsupportedVisualProvider.js";
import type { VisualProvider } from "../src/eyes/visualProvider.js";
import { NotConfiguredError } from "../src/utils/errors.js";

// Section: "If the visual-perception engine cannot support a particular
// environment, report that limitation clearly" — and never fall back to
// screenshots. This is what actually runs on this project's own headless
// Linux dev/test sandbox, so it's directly exercised, not just reviewed.
describe("UnsupportedVisualProvider", () => {
  const provider: VisualProvider = new UnsupportedVisualProvider("linux", "no display server");

  it("reports every capability as false with a specific reason", () => {
    const caps = provider.getCapabilities();
    expect(caps.supported).toBe(false);
    expect(caps.windowEvents).toBe(false);
    expect(caps.uiAutomationEvents).toBe(false);
    expect(caps.uiAutomationQueries).toBe(false);
    expect(caps.onDemandFrameCapture).toBe(false);
    expect(caps.detail).toContain("no display server");
  });

  it("throws NotConfiguredError rather than silently no-op'ing for every operation", async () => {
    await expect(provider.start(() => {})).rejects.toThrow(NotConfiguredError);
    await expect(provider.listWindows()).rejects.toThrow(NotConfiguredError);
    await expect(provider.getUiTree()).rejects.toThrow(NotConfiguredError);
    await expect(provider.findUiElement({})).rejects.toThrow(NotConfiguredError);
    await expect(provider.getUiElement("x")).rejects.toThrow(NotConfiguredError);
    await expect(provider.invokeUiElement("x")).rejects.toThrow(NotConfiguredError);
    await expect(provider.setUiElementValue("x", "y")).rejects.toThrow(NotConfiguredError);
    await expect(provider.focusUiElement("x")).rejects.toThrow(NotConfiguredError);
    await expect(provider.captureFrame()).rejects.toThrow(NotConfiguredError);
  });

  it("never claims to be running", () => {
    expect(provider.isRunning).toBe(false);
  });

  it("stop() is a harmless no-op", async () => {
    await expect(provider.stop()).resolves.toBeUndefined();
  });
});
