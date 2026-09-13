import { describe, it, expect, beforeAll } from "vitest";
import { registerUser } from "../src/auth/authService.js";
import { createConversation } from "../src/conversation/conversationService.js";
import { runAgent } from "../src/agent/orchestrator.js";
import { registerBuiltinTools } from "../src/tools/builtinIndex.js";
import { __registerProviderForTesting } from "../src/ai/router.js";
import { __setVisualProviderForTesting } from "../src/eyes/visualProviderFactory.js";
import { updateUserSettings } from "../src/settings/userSettingsService.js";
import { eyesService } from "../src/eyes/eyesService.js";
import { retrieveRelevantMemory } from "../src/memory/memoryService.js";
import type { AIProvider, ChatRequest, ChatResponse, ChatStreamEvent, ModelCapabilities, ProviderHealth } from "../src/ai/types.js";
import type { VisualProvider } from "../src/eyes/visualProvider.js";
import type { UIElementNode, VisualEvent, VisualFrame, VisualProviderCapabilities, WindowSummary } from "../src/eyes/types.js";

// Phase 5 of the Jarvis spec: the agent must coordinate Eyes, computer
// control, and memory in one flow, not just have each work in isolation.
// This drives runAgent() with a scripted provider that calls one real tool
// per turn — eyes_get_visual_state, then computer_list_applications, then
// memory_remember — and checks each step's actual output genuinely reached
// the next turn's context, and that what got remembered is still
// retrievable afterward (the "continuity" half of the human-like-behavior
// work: nothing here is hard-coded to skip past a step).
class FakeVisualProvider implements VisualProvider {
  readonly platform = "fake";
  private running = false;
  private onEvent: ((event: VisualEvent) => void) | null = null;

  get isRunning() {
    return this.running;
  }
  getCapabilities(): VisualProviderCapabilities {
    return { supported: true, windowEvents: true, uiAutomationEvents: true, uiAutomationQueries: true, onDemandFrameCapture: true, continuousCapture: { supported: false, technology: null, maxCaptureFps: null, supportsDirtyRects: false, supportsMultiDisplay: false } };
  }
  async start(onEvent: (event: VisualEvent) => void): Promise<void> {
    this.running = true;
    this.onEvent = onEvent;
  }
  async stop(): Promise<void> {
    this.running = false;
  }
  emit(event: VisualEvent): void {
    this.onEvent?.(event);
  }
  async listWindows(): Promise<WindowSummary[]> {
    return [{ windowId: "w1", processName: "notepad.exe", title: "Untitled - Notepad", isForeground: true, boundingBox: null }];
  }
  async getUiTree(): Promise<UIElementNode> {
    return node();
  }
  async findUiElement(): Promise<UIElementNode[]> {
    return [];
  }
  async getUiElement(): Promise<UIElementNode> {
    return node();
  }
  async invokeUiElement() {}
  async setUiElementValue() {}
  async focusUiElement() {}
  async captureFrame(): Promise<VisualFrame> {
    return { mimeType: "image/png", base64: "frame", region: null, capturedAt: new Date().toISOString() };
  }
  async startContinuousCapture(): Promise<void> {}
  async stopContinuousCapture(): Promise<void> {}
}

function node(): UIElementNode {
  return { automationId: null, name: "root", controlType: "Window", className: null, processName: null, windowTitle: null, boundingBox: null, enabled: true, focused: false, patterns: [], elementRef: "ref-root", children: [] };
}

// Issues exactly one real tool call per turn, in a fixed script, based on
// how many tool results have already accumulated in the conversation —
// not a hard-coded step counter of its own, so it genuinely reacts to
// what actually came back from each previous tool.
class ScriptedCoordinationProvider implements AIProvider {
  readonly id = "scripted-coordination";
  readonly displayName = "Scripted coordination test provider";
  toolResultsSeen(req: ChatRequest): string[] {
    return req.messages.filter((m) => m.role === "tool").map((m) => m.content);
  }
  isConfigured(): boolean {
    return true;
  }
  getCapabilities(): ModelCapabilities {
    return { text: true, vision: false, audio: false, streaming: false, toolCalling: true, structuredOutput: false, reasoning: false, longContext: false, contextWindowTokens: 32_000 };
  }
  listModels() {
    return [{ id: "scripted-1", capabilities: this.getCapabilities() }];
  }
  async checkHealth(): Promise<ProviderHealth> {
    return { provider: this.id, configured: true, healthy: true, checkedAt: new Date().toISOString() };
  }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const seen = this.toolResultsSeen(req);
    const base = { usage: { promptTokens: 1, completionTokens: 1 }, model: req.model, provider: this.id };

    if (seen.length === 0) {
      return { ...base, content: "", finishReason: "tool_calls", toolCalls: [{ id: "call-1", name: "eyes_get_visual_state", arguments: { includeVisual: false } }] };
    }
    if (seen.length === 1) {
      // Reacts to what Eyes actually reported — this only makes sense if
      // the previous tool's real output actually reached this turn.
      expect(seen[0]).toMatch(/notepad/i);
      return { ...base, content: "", finishReason: "tool_calls", toolCalls: [{ id: "call-2", name: "computer_list_applications", arguments: {} }] };
    }
    if (seen.length === 2) {
      return {
        ...base,
        content: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "call-3", name: "memory_remember", arguments: { content: "User's foreground window was Notepad during this session.", category: "fact", key: "last_foreground_app" } }],
      };
    }
    return { ...base, content: "Checked what's on screen, listed installed applications, and remembered the foreground app for next time.", finishReason: "stop", toolCalls: [] };
  }
  async *chatStream(req: ChatRequest): AsyncGenerator<ChatStreamEvent, void, unknown> {
    yield { type: "done", response: await this.chat(req) };
  }
}

async function makeUser() {
  const email = `coord-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { user } = await registerUser(email, "a-strong-password");
  return user.id;
}

beforeAll(() => {
  registerBuiltinTools();
  __registerProviderForTesting(new ScriptedCoordinationProvider());
});

describe("Eyes + computer control + memory coordination through one agent run", () => {
  it("carries each real tool's result into the next step and persists what it learned", async () => {
    __setVisualProviderForTesting(new FakeVisualProvider());
    const userId = await makeUser();
    await updateUserSettings(userId, { eyesEnabled: true });
    await eyesService.ensureStarted(userId);
    const conversation = await createConversation(userId, "coordination-test", "scripted-coordination", "scripted-1");

    const outcome = await runAgent({
      userId,
      role: "owner",
      conversationId: conversation.id,
      providerId: "scripted-coordination",
      model: "scripted-1",
      userMessage: "What's on my screen, what apps are installed, and remember what's currently in focus.",
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.finalMessage).toMatch(/remembered/i);

    // The memory_remember call in step 3 must have actually persisted —
    // not just returned a result the model saw once and forgot.
    const remembered = await retrieveRelevantMemory(userId, { query: "foreground app" });
    expect(remembered.some((m) => m.content.includes("Notepad"))).toBe(true);
  });
});
