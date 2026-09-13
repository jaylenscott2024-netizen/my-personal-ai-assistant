import { AttentionManager, type LatencyPolicy } from "./attentionManager.js";
import type { VisualProvider } from "./visualProvider.js";
import type { ScreenRegion, UIElementNode, VisualEvent, VisualFrame, VisualProviderCapabilities, VisualState, WindowSummary } from "./types.js";
import { eventBus } from "../events/eventBus.js";
import { childLogger } from "../config/logger.js";

const log = childLogger("eyes.engine");
const MAX_RECENT_EVENTS = 50;

// Section: "the perception layer should maintain state and determine
// what has changed" — this is that continuously-maintained state. One
// engine instance per user (see eyesService.ts), wrapping exactly one
// VisualProvider so the rest of the codebase never touches a platform
// implementation directly.
//
// This class has zero knowledge of AI models/providers (that's
// visualContextAdapter.ts's job) and zero OS-specific code (that's
// visualProvider.ts's contract) — it only owns: holding state, applying
// AttentionManager's decisions, and exposing a small, stable API.
export class VisualPerceptionEngine {
  private state: VisualState = {
    initialized: false,
    foregroundWindow: null,
    windows: [],
    primaryFocus: null,
    recentEvents: [],
    lastUpdatedAt: new Date(0).toISOString(),
  };

  private readonly attentionManager: AttentionManager;
  private running = false;

  constructor(
    private readonly userId: string,
    private readonly provider: VisualProvider,
    latencyPolicy: LatencyPolicy = "balanced",
  ) {
    this.attentionManager = new AttentionManager(latencyPolicy);
  }

  get isRunning(): boolean {
    return this.running;
  }

  getCapabilities(): VisualProviderCapabilities {
    return this.provider.getCapabilities();
  }

  setLatencyPolicy(policy: LatencyPolicy): void {
    this.attentionManager.setLatencyPolicy(policy);
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.provider.start((event) => this.ingestEvent(event));
    this.running = true;
    try {
      this.state = { ...this.state, windows: await this.provider.listWindows() };
      this.state.foregroundWindow = this.state.windows.find((w) => w.isForeground) ?? null;
    } catch (err) {
      log.warn({ err }, "initial window snapshot failed; continuing with event-driven updates only");
    }
    log.info({ userId: this.userId, platform: this.provider.platform }, "Jarvis Eyes engine started");
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    await this.provider.stop();
    this.running = false;
    this.attentionManager.reset();
    log.info({ userId: this.userId }, "Jarvis Eyes engine stopped");
  }

  private ingestEvent(candidate: VisualEvent): void {
    const decision = this.attentionManager.evaluate(candidate, this.state);
    if (!decision.accept) return;

    const event = decision.event;
    const recentEvents = [event, ...this.state.recentEvents].slice(0, MAX_RECENT_EVENTS);

    let windows = this.state.windows;
    let foregroundWindow = this.state.foregroundWindow;
    if (event.window) {
      windows = upsertWindow(windows, event.window);
      if (event.window.isForeground) foregroundWindow = event.window;
    }

    this.state = {
      initialized: true,
      foregroundWindow,
      windows,
      primaryFocus: decision.newPrimaryFocus !== undefined ? decision.newPrimaryFocus : this.state.primaryFocus,
      recentEvents,
      lastUpdatedAt: event.at,
    };

    // Section 45/89: the activity stream gets every accepted (i.e.
    // non-redundant, non-throttled) visual event — never the raw,
    // unfiltered OS event stream, which would flood it.
    eventBus.emitEvent("eyes.event", { type: event.type, attention: event.attention, summary: event.summary }, this.userId);
  }

  getState(): VisualState {
    return this.state;
  }

  async requestFrame(region?: ScreenRegion): Promise<VisualFrame> {
    return this.provider.captureFrame(region);
  }

  async listWindows(): Promise<WindowSummary[]> {
    return this.provider.listWindows();
  }

  async getUiTree(windowId?: string, maxDepth?: number): Promise<UIElementNode> {
    return this.provider.getUiTree(windowId, maxDepth);
  }

  async findUiElement(query: { windowId?: string; name?: string; automationId?: string; controlType?: string }): Promise<UIElementNode[]> {
    return this.provider.findUiElement(query);
  }

  async getUiElement(elementRef: string): Promise<UIElementNode> {
    return this.provider.getUiElement(elementRef);
  }

  async invokeUiElement(elementRef: string): Promise<void> {
    return this.provider.invokeUiElement(elementRef);
  }

  async setUiElementValue(elementRef: string, value: string): Promise<void> {
    return this.provider.setUiElementValue(elementRef, value);
  }

  async focusUiElement(elementRef: string): Promise<void> {
    return this.provider.focusUiElement(elementRef);
  }
}

function upsertWindow(windows: WindowSummary[], window: WindowSummary): WindowSummary[] {
  const withoutForegroundFlag = window.isForeground ? windows.map((w) => ({ ...w, isForeground: false })) : windows;
  const idx = withoutForegroundFlag.findIndex((w) => w.windowId === window.windowId);
  if (idx === -1) return [...withoutForegroundFlag, window];
  const copy = [...withoutForegroundFlag];
  copy[idx] = window;
  return copy;
}
