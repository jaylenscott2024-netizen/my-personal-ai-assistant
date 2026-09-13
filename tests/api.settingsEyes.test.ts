import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { buildApp } from "../src/app.js";
import { eyesService } from "../src/eyes/eyesService.js";
import { __setVisualProviderForTesting } from "../src/eyes/visualProviderFactory.js";
import { UnsupportedVisualProvider } from "../src/eyes/providers/unsupportedVisualProvider.js";
import type { VisualProvider } from "../src/eyes/visualProvider.js";
import type { UIElementNode, VisualEvent, VisualFrame, VisualProviderCapabilities, WindowSummary } from "../src/eyes/types.js";

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
  async startContinuousCapture(): Promise<void> {}
  async stopContinuousCapture(): Promise<void> {}
}

// Section 27/28: this is where a Settings change actually takes effect —
// PATCH /settings/eyes is the one HTTP surface a real client uses to turn
// Jarvis's Eyes on/off, so it needs to be exercised end-to-end (auth
// boundary, persistence, and the engine actually starting/stopping),
// not just the underlying service in isolation.
describe("PATCH /settings/eyes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(async () => {
    await eyesService.stopAll();
    __setVisualProviderForTesting(null);
  });

  async function registerAndLogin(email: string) {
    const res = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "a-strong-password" } });
    return JSON.parse(res.body) as { token: string; user: { id: string } };
  }

  it("rejects an unauthenticated request", async () => {
    const res = await app.inject({ method: "PATCH", url: "/settings/eyes", payload: { eyesEnabled: true } });
    expect(res.statusCode).toBe(401);
  });

  it("enabling Eyes on a supported (faked) platform starts the engine and persists the setting", async () => {
    __setVisualProviderForTesting(new FakeVisualProvider());
    const user = await registerAndLogin(`eyes-on-${Date.now()}@example.com`);

    const res = await app.inject({
      method: "PATCH",
      url: "/settings/eyes",
      headers: { authorization: `Bearer ${user.token}` },
      payload: { eyesEnabled: true, eyesAllowedProviders: ["anthropic"] },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { eyesEnabled: boolean; eyesAllowedProviders: string[] };
    expect(body.eyesEnabled).toBe(true);
    expect(body.eyesAllowedProviders).toEqual(["anthropic"]);
    expect(await eyesService.getEngineIfRunning(user.user.id)).not.toBeNull();
  });

  it("enabling Eyes on an unsupported platform reports the failure honestly and rolls eyesEnabled back to false", async () => {
    __setVisualProviderForTesting(new UnsupportedVisualProvider("linux", "no display server"));
    const user = await registerAndLogin(`eyes-unsupported-${Date.now()}@example.com`);

    const res = await app.inject({
      method: "PATCH",
      url: "/settings/eyes",
      headers: { authorization: `Bearer ${user.token}` },
      payload: { eyesEnabled: true },
    });

    expect(res.statusCode).toBe(412); // NotConfiguredError — never a silent success
    expect(JSON.parse(res.body).error.message).toContain("no display server");

    const getRes = await app.inject({ method: "GET", url: "/settings/eyes", headers: { authorization: `Bearer ${user.token}` } });
    expect(JSON.parse(getRes.body).eyesEnabled).toBe(false); // rolled back — never left half-enabled
  });

  it("disabling Eyes stops a running engine", async () => {
    __setVisualProviderForTesting(new FakeVisualProvider());
    const user = await registerAndLogin(`eyes-off-${Date.now()}@example.com`);

    await app.inject({
      method: "PATCH",
      url: "/settings/eyes",
      headers: { authorization: `Bearer ${user.token}` },
      payload: { eyesEnabled: true },
    });
    expect(await eyesService.getEngineIfRunning(user.user.id)).not.toBeNull();

    await app.inject({
      method: "PATCH",
      url: "/settings/eyes",
      headers: { authorization: `Bearer ${user.token}` },
      payload: { eyesEnabled: false },
    });
    expect(await eyesService.getEngineIfRunning(user.user.id)).toBeNull();
  });

  it("rejects an invalid eyesMode at the API boundary", async () => {
    const user = await registerAndLogin(`eyes-invalid-${Date.now()}@example.com`);
    const res = await app.inject({
      method: "PATCH",
      url: "/settings/eyes",
      headers: { authorization: `Bearer ${user.token}` },
      payload: { eyesMode: "full_video_stream" },
    });
    expect(res.statusCode).toBe(400);
  });
});
