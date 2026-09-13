import { describe, it, expect, afterEach } from "vitest";
import { registerUser } from "../src/auth/authService.js";
import { DEFAULT_USER_SETTINGS, updateUserSettings, type UserSettings } from "../src/settings/userSettingsService.js";
import { eyesService } from "../src/eyes/eyesService.js";
import { __setVisualProviderForTesting } from "../src/eyes/visualProviderFactory.js";
import { getVisualContextForModel } from "../src/eyes/visualContextAdapter.js";
import type { VisualProvider } from "../src/eyes/visualProvider.js";
import type { UIElementNode, VisualEvent, VisualFrame, VisualProviderCapabilities, WindowSummary } from "../src/eyes/types.js";

class FakeVisualProvider implements VisualProvider {
  readonly platform = "fake";
  private running = false;
  private onEvent: ((event: VisualEvent) => void) | null = null;

  get isRunning() {
    return this.running;
  }
  getCapabilities(): VisualProviderCapabilities {
    return { supported: true, windowEvents: true, uiAutomationEvents: true, uiAutomationQueries: true, onDemandFrameCapture: true };
  }
  async start(onEvent: (event: VisualEvent) => void): Promise<void> {
    this.running = true;
    this.onEvent = onEvent;
  }
  async stop(): Promise<void> {
    this.running = false;
    this.onEvent = null;
  }
  emit(event: VisualEvent): void {
    this.onEvent?.(event);
  }
  async listWindows(): Promise<WindowSummary[]> {
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
}

function makeEvent(overrides: Partial<VisualEvent> = {}): VisualEvent {
  return {
    type: "window_focus_changed",
    at: new Date().toISOString(),
    attention: "primary",
    summary: 'Focus moved to "Save" button',
    window: { windowId: "1", processName: "notepad.exe", title: "Untitled - Notepad", isForeground: true, boundingBox: null },
    region: null,
    significance: 0.7,
    ...overrides,
  };
}

async function makeUser() {
  const email = `visualctx-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { user } = await registerUser(email, "a-strong-password");
  return user.id;
}

afterEach(async () => {
  await eyesService.stopAll();
  __setVisualProviderForTesting(null);
});

// Section 26: this is the gate that decides whether any pixel/structural
// awareness ever reaches a given AI provider's prompt this turn. Every
// branch here is a distinct privacy/security requirement, not just a
// happy-path feature test.
describe("getVisualContextForModel", () => {
  it("contributes nothing when Eyes is disabled in settings", async () => {
    const userId = await makeUser();
    const settings: UserSettings = { ...DEFAULT_USER_SETTINGS, eyesEnabled: false };
    const result = await getVisualContextForModel({ userId, role: "owner", providerId: "anthropic", settings });
    expect(result).toBeUndefined();
  });

  it("checks the permission gate rather than skipping it (computer.eyes.read is deliberately a read-tier permission every role holds)", async () => {
    const fake = new FakeVisualProvider();
    __setVisualProviderForTesting(fake);
    const userId = await makeUser();
    await updateUserSettings(userId, { eyesEnabled: true, eyesAllowedProviders: ["anthropic"] });
    await eyesService.ensureStarted(userId);
    fake.emit(makeEvent());

    const settings = { ...DEFAULT_USER_SETTINGS, eyesEnabled: true, eyesAllowedProviders: ["anthropic"] };
    // A read-tier permission is granted to every role by policy
    // (security/permissionService.ts), including a role with no explicit
    // grants at all — this documents that computer.eyes.read is
    // intentionally low-risk (structural/event awareness, not pixels),
    // unlike computer.eyes.capture which is gated much higher.
    const result = await getVisualContextForModel({ userId, role: "member", providerId: "anthropic", settings });
    expect(result).toContain("notepad.exe");
  });

  it("contributes nothing when the current provider is not on the allowlist", async () => {
    __setVisualProviderForTesting(new FakeVisualProvider());
    const userId = await makeUser();
    await updateUserSettings(userId, { eyesEnabled: true, eyesAllowedProviders: ["gemini"] });
    await eyesService.ensureStarted(userId);

    const settings = { ...DEFAULT_USER_SETTINGS, eyesEnabled: true, eyesAllowedProviders: ["gemini"] };
    const result = await getVisualContextForModel({ userId, role: "owner", providerId: "anthropic", settings });
    expect(result).toBeUndefined();
  });

  it("contributes nothing when eyesAllowedProviders is empty (the default — no provider opted in yet)", async () => {
    const userId = await makeUser();
    const settings: UserSettings = { ...DEFAULT_USER_SETTINGS, eyesEnabled: true, eyesAllowedProviders: [] };
    const result = await getVisualContextForModel({ userId, role: "owner", providerId: "anthropic", settings });
    expect(result).toBeUndefined();
  });

  it("contributes nothing when the engine is not actually running", async () => {
    const userId = await makeUser();
    const settings: UserSettings = { ...DEFAULT_USER_SETTINGS, eyesEnabled: true, eyesAllowedProviders: ["anthropic"] };
    const result = await getVisualContextForModel({ userId, role: "owner", providerId: "anthropic", settings });
    expect(result).toBeUndefined();
  });

  it("contributes nothing when the engine is running but has not observed anything yet", async () => {
    __setVisualProviderForTesting(new FakeVisualProvider());
    const userId = await makeUser();
    await updateUserSettings(userId, { eyesEnabled: true, eyesAllowedProviders: ["anthropic"] });
    await eyesService.ensureStarted(userId);

    const settings = { ...DEFAULT_USER_SETTINGS, eyesEnabled: true, eyesAllowedProviders: ["anthropic"] };
    const result = await getVisualContextForModel({ userId, role: "owner", providerId: "anthropic", settings });
    expect(result).toBeUndefined();
  });

  it("renders a text summary wrapped as untrusted external content once every gate passes", async () => {
    const fake = new FakeVisualProvider();
    __setVisualProviderForTesting(fake);
    const userId = await makeUser();
    await updateUserSettings(userId, { eyesEnabled: true, eyesAllowedProviders: ["anthropic"] });
    const engine = await eyesService.ensureStarted(userId);
    void engine;
    fake.emit(makeEvent());

    const settings = { ...DEFAULT_USER_SETTINGS, eyesEnabled: true, eyesAllowedProviders: ["anthropic"] };
    const result = await getVisualContextForModel({ userId, role: "owner", providerId: "anthropic", settings });

    expect(result).toBeDefined();
    expect(result).toContain('<external_content trust="untrusted">');
    expect(result).toContain("</external_content>");
    expect(result).toContain("notepad.exe");
    expect(result).toContain('Focus moved to "Save" button');
    expect(result).not.toContain("image/png"); // never a pixel payload — text only
  });
});
