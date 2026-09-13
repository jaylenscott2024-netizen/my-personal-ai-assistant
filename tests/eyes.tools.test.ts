import { describe, it, expect, afterEach } from "vitest";
import { registerUser } from "../src/auth/authService.js";
import { updateUserSettings } from "../src/settings/userSettingsService.js";
import { eyesService } from "../src/eyes/eyesService.js";
import { __setVisualProviderForTesting } from "../src/eyes/visualProviderFactory.js";
import { NotConfiguredError } from "../src/utils/errors.js";
import { riskLevelForPermissions } from "../src/security/permissions.js";
import { resolveEffectivePermissions } from "../src/tools/permissionResolution.js";
import { eyesGetVisualStateTool } from "../src/tools/builtin/eyesTools.js";
import {
  computerGetUiTreeTool,
  computerFindUiElementTool,
  computerGetUiElementTool,
  computerInvokeUiElementTool,
  computerSetUiValueTool,
  computerFocusUiElementTool,
} from "../src/tools/builtin/uiAutomationTools.js";
import type { VisualProvider } from "../src/eyes/visualProvider.js";
import type { UIElementNode, VisualEvent, VisualFrame, VisualProviderCapabilities, WindowSummary } from "../src/eyes/types.js";

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

class FakeVisualProvider implements VisualProvider {
  readonly platform = "fake";
  private running = false;
  private onEvent: ((event: VisualEvent) => void) | null = null;
  invoked: string[] = [];

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
  emit(event: VisualEvent): void {
    this.onEvent?.(event);
  }
  async stop(): Promise<void> {
    this.running = false;
  }
  async listWindows(): Promise<WindowSummary[]> {
    return [];
  }
  async getUiTree(): Promise<UIElementNode> {
    return { automationId: null, name: "root", controlType: "Window", className: null, processName: null, windowTitle: null, boundingBox: null, enabled: true, focused: false, patterns: [], elementRef: "ref-root", children: [] };
  }
  async findUiElement(): Promise<UIElementNode[]> {
    return [{ automationId: "btnSave", name: "Save", controlType: "Button", className: null, processName: null, windowTitle: null, boundingBox: null, enabled: true, focused: false, patterns: ["Invoke"], elementRef: "ref-save", children: [] }];
  }
  async getUiElement(elementRef: string): Promise<UIElementNode> {
    return { automationId: "btnSave", name: "Save", controlType: "Button", className: null, processName: null, windowTitle: null, boundingBox: null, enabled: true, focused: true, patterns: ["Invoke"], elementRef, children: [] };
  }
  async invokeUiElement(elementRef: string): Promise<void> {
    this.invoked.push(`invoke:${elementRef}`);
  }
  async setUiElementValue(elementRef: string, value: string): Promise<void> {
    this.invoked.push(`setValue:${elementRef}:${value}`);
  }
  async focusUiElement(elementRef: string): Promise<void> {
    this.invoked.push(`focus:${elementRef}`);
  }
  async captureFrame(): Promise<VisualFrame> {
    return { mimeType: "image/png", base64: "framedata", region: null, capturedAt: new Date().toISOString() };
  }
}

async function makeUser() {
  const email = `eyestools-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { user } = await registerUser(email, "a-strong-password");
  return user.id;
}

afterEach(async () => {
  await eyesService.stopAll();
  __setVisualProviderForTesting(null);
});

describe("eyes_get_visual_state tool", () => {
  it("declares computer.eyes.read and is low-risk / no-approval by default", () => {
    expect(eyesGetVisualStateTool.requiredPermissions).toEqual(["computer.eyes.read"]);
    expect(riskLevelForPermissions(eyesGetVisualStateTool.requiredPermissions)).toBe("low");
    expect(eyesGetVisualStateTool.requiresApproval).toBe(false);
  });

  it("permissionResolution escalates to computer.eyes.capture (HIGH) only when includeVisual is requested", () => {
    const withoutVisual = resolveEffectivePermissions("eyes_get_visual_state", { includeVisual: false }, eyesGetVisualStateTool.requiredPermissions);
    expect(withoutVisual).toEqual(["computer.eyes.read"]);
    expect(riskLevelForPermissions(withoutVisual)).toBe("low");

    const withVisual = resolveEffectivePermissions("eyes_get_visual_state", { includeVisual: true }, eyesGetVisualStateTool.requiredPermissions);
    expect(withVisual).toContain("computer.eyes.capture");
    expect(riskLevelForPermissions(withVisual)).toBe("high");
  });

  it("throws NotConfiguredError rather than silently returning empty state when Eyes is not running", async () => {
    const userId = await makeUser();
    await expect(eyesGetVisualStateTool.execute({ includeVisual: false }, { userId })).rejects.toThrow(NotConfiguredError);
  });

  it("returns the structural summary without any image when includeVisual is false", async () => {
    __setVisualProviderForTesting(new FakeVisualProvider());
    const userId = await makeUser();
    await updateUserSettings(userId, { eyesEnabled: true });
    await eyesService.ensureStarted(userId);

    const result = await eyesGetVisualStateTool.execute({ includeVisual: false }, { userId });
    expect(result.images).toBeUndefined();
    expect(result.output).toHaveProperty("windows");
    // Structural timeline still provided — just with every pixel removed.
    expect(result.visualContext).toBeDefined();
    expect(result.visualContext!.samples.every((sample) => sample.frame === null)).toBe(true);
    expect(result.visualContext!.temporalSummary).toBeTruthy();
  });

  it("attaches exactly one on-demand captured frame when includeVisual is true", async () => {
    const fake = new FakeVisualProvider();
    __setVisualProviderForTesting(fake);
    const userId = await makeUser();
    await updateUserSettings(userId, { eyesEnabled: true });
    const engine = await eyesService.ensureStarted(userId);
    // The engine only builds context from observations it has actually
    // made, so give it one real event to observe first.
    fake.emit(makeEvent());
    void engine;

    const result = await eyesGetVisualStateTool.execute({ includeVisual: true }, { userId });
    const framed = result.visualContext!.samples.filter((sample) => sample.frame !== null);
    expect(framed).toHaveLength(1);
    expect(framed[0].frame).toEqual({ mimeType: "image/png", base64: "framedata", region: null, capturedAt: expect.any(String) });
  });
});

describe("computer_*_ui_* tools", () => {
  it("get_ui_tree / find_ui_element / get_ui_element declare computer.read and are low-risk / no-approval", () => {
    for (const tool of [computerGetUiTreeTool, computerFindUiElementTool, computerGetUiElementTool]) {
      expect(tool.requiredPermissions).toEqual(["computer.read"]);
      expect(riskLevelForPermissions(tool.requiredPermissions)).toBe("low");
      expect(tool.requiresApproval).toBe(false);
    }
  });

  it("invoke_ui_element / set_ui_value / focus_ui_element declare computer.input (execute tier, no approval by default)", () => {
    for (const tool of [computerInvokeUiElementTool, computerSetUiValueTool, computerFocusUiElementTool]) {
      expect(tool.requiredPermissions).toEqual(["computer.input"]);
      expect(riskLevelForPermissions(tool.requiredPermissions)).toBe("medium");
      expect(tool.requiresApproval).toBe(false);
    }
  });

  it("every UI Automation tool throws NotConfiguredError rather than guessing when Eyes is not running", async () => {
    const userId = await makeUser();
    await expect(computerGetUiTreeTool.execute({}, { userId })).rejects.toThrow(NotConfiguredError);
    await expect(computerFindUiElementTool.execute({}, { userId })).rejects.toThrow(NotConfiguredError);
    await expect(computerGetUiElementTool.execute({ elementRef: "x" }, { userId })).rejects.toThrow(NotConfiguredError);
    await expect(computerInvokeUiElementTool.execute({ elementRef: "x" }, { userId })).rejects.toThrow(NotConfiguredError);
    await expect(computerSetUiValueTool.execute({ elementRef: "x", value: "y" }, { userId })).rejects.toThrow(NotConfiguredError);
    await expect(computerFocusUiElementTool.execute({ elementRef: "x" }, { userId })).rejects.toThrow(NotConfiguredError);
  });

  it("delegates real queries and semantic actions to the running engine instead of touching coordinates", async () => {
    const fake = new FakeVisualProvider();
    __setVisualProviderForTesting(fake);
    const userId = await makeUser();
    await updateUserSettings(userId, { eyesEnabled: true });
    await eyesService.ensureStarted(userId);

    const tree = await computerGetUiTreeTool.execute({}, { userId });
    expect((tree.output as UIElementNode).controlType).toBe("Window");

    const found = await computerFindUiElementTool.execute({ name: "Save" }, { userId });
    expect((found.output as { elements: UIElementNode[] }).elements[0].automationId).toBe("btnSave");

    const element = await computerGetUiElementTool.execute({ elementRef: "ref-save" }, { userId });
    expect((element.output as UIElementNode).focused).toBe(true);

    await computerInvokeUiElementTool.execute({ elementRef: "ref-save" }, { userId });
    await computerSetUiValueTool.execute({ elementRef: "ref-field", value: "hello" }, { userId });
    await computerFocusUiElementTool.execute({ elementRef: "ref-save" }, { userId });

    expect(fake.invoked).toEqual(["invoke:ref-save", "setValue:ref-field:hello", "focus:ref-save"]);
  });
});
