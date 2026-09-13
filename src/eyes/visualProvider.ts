import type { ScreenRegion, UIElementNode, VisualEvent, VisualFrame, VisualProviderCapabilities, WindowSummary } from "./types.js";

// The contract every platform-specific Eyes implementation fulfills.
// VisualPerceptionEngine (visualPerceptionEngine.ts) only ever talks to
// this interface — it has zero Windows/macOS/Linux-specific code, and
// zero AI-provider-specific code. That's the two independences the spec
// asks for: Eyes independent of AI model, and Eyes independent of OS
// implementation detail beyond this seam.
//
// Every method here is either genuinely event-driven (start/stop the
// event source, receive callbacks) or genuinely on-demand (one-shot
// query, invoked when something specific is needed) — nothing in this
// interface has a "poll every N ms" shape. A provider that can only offer
// polling for a given capability should report that capability as
// unsupported (`getCapabilities().windowEvents = false`, etc.) rather
// than faking event-driven behavior with a hidden timer.
export interface VisualProvider {
  readonly platform: string;

  getCapabilities(): VisualProviderCapabilities;

  /** Begin listening for window/UI Automation events. Resolves once the
   *  event source is live; `onEvent` fires for every subsequent event
   *  until `stop()` is called. Throws NotConfiguredError (never silently
   *  degrades) if this platform/environment can't support it. */
  start(onEvent: (event: VisualEvent) => void): Promise<void>;
  stop(): Promise<void>;
  readonly isRunning: boolean;

  /** Current window list, refreshed from the live event-driven state the
   *  provider maintains internally — not a fresh OS query each call. */
  listWindows(): Promise<WindowSummary[]>;

  /** One-shot UI Automation tree query rooted at a window (or the
   *  foreground window if omitted). Real, on-demand — not part of the
   *  continuous event stream. */
  getUiTree(windowId?: string, maxDepth?: number): Promise<UIElementNode>;
  findUiElement(query: { windowId?: string; name?: string; automationId?: string; controlType?: string }): Promise<UIElementNode[]>;
  /** Re-resolves a single element by the opaque reference an earlier
   *  getUiTree/findUiElement call returned, and reports its CURRENT state
   *  (enabled/focused/value can have changed since) — without re-walking
   *  the whole tree it came from. */
  getUiElement(elementRef: string): Promise<UIElementNode>;
  invokeUiElement(elementRef: string): Promise<void>;
  setUiElementValue(elementRef: string, value: string): Promise<void>;
  focusUiElement(elementRef: string): Promise<void>;

  /** On-demand pixel capture of a specific region/window, triggered by
   *  attention or an explicit tool call — never invoked on a timer by
   *  this engine. Providers that can't support this (e.g. no display
   *  server) report `onDemandFrameCapture: false` in getCapabilities()
   *  and this throws NotConfiguredError rather than returning a fake
   *  frame or silently falling back to a generic screenshot utility. */
  captureFrame(region?: ScreenRegion): Promise<VisualFrame>;
}
