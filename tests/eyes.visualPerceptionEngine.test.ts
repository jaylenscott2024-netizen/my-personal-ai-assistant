import { describe, it, expect } from "vitest";
import { VisualPerceptionEngine } from "../src/eyes/visualPerceptionEngine.js";
import type { VisualProvider } from "../src/eyes/visualProvider.js";
import type { UIElementNode, VisualEvent, VisualFrame, VisualProviderCapabilities, WindowSummary } from "../src/eyes/types.js";

class FakeVisualProvider implements VisualProvider {
  readonly platform = "fake";
  private running = false;
  private onEvent: ((event: VisualEvent) => void) | null = null;
  windows: WindowSummary[] = [{ windowId: "1", processName: "chrome", title: "GitHub", isForeground: true, boundingBox: null }];

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

  async listWindows() {
    return this.windows;
  }

  async getUiTree(): Promise<UIElementNode> {
    return { automationId: null, name: "root", controlType: "Window", className: null, processName: null, windowTitle: null, boundingBox: null, enabled: true, focused: false, patterns: [], elementRef: "ref1", children: [] };
  }

  async findUiElement() {
    return [];
  }

  async getUiElement(): Promise<UIElementNode> {
    return { automationId: null, name: "root", controlType: "Button", className: null, processName: null, windowTitle: null, boundingBox: null, enabled: true, focused: false, patterns: [], elementRef: "ref1", children: [] };
  }

  async invokeUiElement() {}
  async setUiElementValue() {}
  async focusUiElement() {}

  async captureFrame(): Promise<VisualFrame> {
    return { mimeType: "image/png", base64: "abc", region: null, capturedAt: new Date().toISOString() };
  }
}

function makeEvent(overrides: Partial<VisualEvent> = {}): VisualEvent {
  return {
    type: "window_focus_changed",
    at: new Date().toISOString(),
    attention: "peripheral",
    summary: "test",
    window: { windowId: "2", processName: "notepad", title: "Untitled", isForeground: true, boundingBox: null },
    region: null,
    significance: 0.5,
    ...overrides,
  };
}

describe("VisualPerceptionEngine", () => {
  it("starts uninitialized and populates state once the provider starts", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("user1", provider);

    expect(engine.getState().initialized).toBe(false);
    await engine.start();

    expect(engine.isRunning).toBe(true);
    expect(engine.getState().foregroundWindow?.processName).toBe("chrome");
  });

  it("applies AttentionManager's decision when ingesting an event", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("user2", provider);
    await engine.start();

    provider.emit(makeEvent());
    const state = engine.getState();

    expect(state.initialized).toBe(true);
    expect(state.foregroundWindow?.windowId).toBe("2");
    expect(state.recentEvents.length).toBe(1);
    expect(state.recentEvents[0].attention).toBe("primary"); // genuinely new foreground window
  });

  it("drops throttled/redundant events rather than growing state unboundedly", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("user3", provider);
    await engine.start();

    const event = makeEvent({ type: "window_moved_or_resized", significance: 0.15 });
    provider.emit(event);
    provider.emit(event); // immediate repeat — should be throttled

    expect(engine.getState().recentEvents.length).toBe(1);
  });

  it("stop() tears down the provider and resets running state", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("user4", provider);
    await engine.start();
    expect(engine.isRunning).toBe(true);

    await engine.stop();
    expect(engine.isRunning).toBe(false);
    expect(provider.isRunning).toBe(false);
  });

  it("delegates UI Automation and frame-capture calls to the provider", async () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("user5", provider);
    await engine.start();

    const tree = await engine.getUiTree();
    expect(tree.controlType).toBe("Window");

    const element = await engine.getUiElement("ref1");
    expect(element.controlType).toBe("Button");

    const frame = await engine.requestFrame();
    expect(frame.base64).toBe("abc");
  });

  it("reports capabilities straight from the underlying provider", () => {
    const provider = new FakeVisualProvider();
    const engine = new VisualPerceptionEngine("user6", provider);
    expect(engine.getCapabilities().supported).toBe(true);
  });
});
