import { describe, it, expect, afterEach } from "vitest";
import { registerUser } from "../src/auth/authService.js";
import { updateUserSettings } from "../src/settings/userSettingsService.js";
import { eyesService } from "../src/eyes/eyesService.js";
import { __setVisualProviderForTesting } from "../src/eyes/visualProviderFactory.js";
import { NotConfiguredError } from "../src/utils/errors.js";
import type { VisualProvider } from "../src/eyes/visualProvider.js";
import type { UIElementNode, VisualEvent, VisualFrame, VisualProviderCapabilities } from "../src/eyes/types.js";

class FakeVisualProvider implements VisualProvider {
  readonly platform = "fake";
  private running = false;
  get isRunning() {
    return this.running;
  }
  getCapabilities(): VisualProviderCapabilities {
    return { supported: true, windowEvents: true, uiAutomationEvents: true, uiAutomationQueries: true, onDemandFrameCapture: true, continuousCapture: { supported: false, technology: null, maxCaptureFps: null, supportsDirtyRects: false, supportsMultiDisplay: false } };
  }
  async start(_onEvent: (event: VisualEvent) => void): Promise<void> {
    this.running = true;
  }
  async stop(): Promise<void> {
    this.running = false;
  }
  async listWindows() {
    return [];
  }
  async getUiTree(): Promise<UIElementNode> {
    return { automationId: null, name: null, controlType: "Window", className: null, processName: null, windowTitle: null, boundingBox: null, enabled: true, focused: false, patterns: [], elementRef: "r", children: [] };
  }
  async findUiElement() {
    return [];
  }
  async getUiElement(): Promise<UIElementNode> {
    return { automationId: null, name: null, controlType: "Button", className: null, processName: null, windowTitle: null, boundingBox: null, enabled: true, focused: false, patterns: [], elementRef: "r", children: [] };
  }
  async invokeUiElement() {}
  async setUiElementValue() {}
  async focusUiElement() {}
  async captureFrame(): Promise<VisualFrame> {
    return { mimeType: "image/png", base64: "x", region: null, capturedAt: new Date().toISOString() };
  }
  async startContinuousCapture(): Promise<void> {}
  async stopContinuousCapture(): Promise<void> {}
}

async function makeUser() {
  const email = `eyes-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { user } = await registerUser(email, "a-strong-password");
  return user.id;
}

afterEach(() => {
  __setVisualProviderForTesting(null);
});

describe("eyesService", () => {
  it("refuses to start when the user has not enabled Eyes", async () => {
    __setVisualProviderForTesting(new FakeVisualProvider());
    const userId = await makeUser();
    await expect(eyesService.ensureStarted(userId)).rejects.toThrow(NotConfiguredError);
  });

  it("starts the engine once eyesEnabled is set, and is idempotent", async () => {
    __setVisualProviderForTesting(new FakeVisualProvider());
    const userId = await makeUser();
    await updateUserSettings(userId, { eyesEnabled: true });

    const engine = await eyesService.ensureStarted(userId);
    expect(engine.isRunning).toBe(true);

    const again = await eyesService.ensureStarted(userId);
    expect(again).toBe(engine); // same instance — not restarted
  });

  it("stop() tears the engine down and getEngineIfRunning reflects that", async () => {
    __setVisualProviderForTesting(new FakeVisualProvider());
    const userId = await makeUser();
    await updateUserSettings(userId, { eyesEnabled: true });
    await eyesService.ensureStarted(userId);

    expect(await eyesService.getEngineIfRunning(userId)).not.toBeNull();
    await eyesService.stop(userId);
    expect(await eyesService.getEngineIfRunning(userId)).toBeNull();
  });

  it("restoreEnabledEngines starts engines for every user with eyesEnabled=true and skips the rest", async () => {
    __setVisualProviderForTesting(new FakeVisualProvider());
    const enabledUser = await makeUser();
    const disabledUser = await makeUser();
    await updateUserSettings(enabledUser, { eyesEnabled: true });
    await updateUserSettings(disabledUser, { eyesEnabled: false });

    const startedCount = await eyesService.restoreEnabledEngines();
    expect(startedCount).toBeGreaterThanOrEqual(1);
    expect(await eyesService.getEngineIfRunning(enabledUser)).not.toBeNull();
    expect(await eyesService.getEngineIfRunning(disabledUser)).toBeNull();

    await eyesService.stopAll();
  });

  it("propagates an unsupported-platform failure honestly rather than swallowing it in ensureStarted", async () => {
    const { UnsupportedVisualProvider } = await import("../src/eyes/providers/unsupportedVisualProvider.js");
    __setVisualProviderForTesting(new UnsupportedVisualProvider("linux", "no display server"));
    const userId = await makeUser();
    await updateUserSettings(userId, { eyesEnabled: true });

    await expect(eyesService.ensureStarted(userId)).rejects.toThrow(NotConfiguredError);
  });
});
