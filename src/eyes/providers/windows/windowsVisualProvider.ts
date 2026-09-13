import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { NotConfiguredError, ProviderError } from "../../../utils/errors.js";
import { childLogger } from "../../../config/logger.js";
import type { CaptureStreamState, VisualProvider } from "../../visualProvider.js";
import type {
  ContinuousCaptureOptions,
  ContinuousFrameSample,
  ScreenRegion,
  UIElementNode,
  VisualEvent,
  VisualFrame,
  VisualProviderCapabilities,
  WindowSummary,
} from "../../types.js";
import { mapRawEventToVisualEvent, type RawWatcherEvent } from "./eventMapping.js";

const log = childLogger("eyes.windows");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCHER_SCRIPT = path.join(__dirname, "eyesWatcher.ps1");

const COMMAND_TIMEOUT_MS = 10_000;

interface PendingCommand {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

// Shape of a `{"kind":"frame",...}` line from the watcher's continuous
// capture loop (see eyesWatcher.ps1's DXGI section). `pixels` is present
// only on ticks the capture loop (or its own processingFps enforcement)
// chose to materialize; every other tick still carries real dirty-rect
// change metadata.
interface RawContinuousFrame {
  sequence: number;
  atMs: number;
  displayId: string;
  width: number;
  height: number;
  changedRegions?: ScreenRegion[];
  changeScore: number;
  pixels: { mimeType: "image/png" | "image/jpeg"; base64: string } | null;
  /** Acquire attempts that returned "nothing new" since the previous
   *  delivered frame — how a motionless desktop is told apart from a
   *  pipeline that can't keep up. */
  idleTimeouts?: number;
  captureLatencyMs?: number;
}

// Shape of a `{"kind":"capture_status",...}` line. The capture thread's
// lifecycle is reported explicitly so this side never has to infer, from
// silence alone, whether a stream is alive — silence is ambiguous on a
// static desktop, which is exactly when a dead stream looks identical to
// a quiet one.
interface RawCaptureStatus {
  state: "capturing" | "reinitializing" | "reconnecting" | "failed" | "stopped";
  detail: string;
  atMs: number;
}

// Real Windows implementation: a single persistent PowerShell/.NET helper
// process (eyesWatcher.ps1) provides three independent things over one
// newline-JSON stdin/stdout protocol, so nothing pays the cost of
// spawning a fresh process per operation: (1) the structural, event-driven
// window/UI-Automation stream (SetWinEventHook + UI Automation event
// handlers), (2) one-shot query commands (get_ui_tree, invoke, etc.), and
// (3) the CONTINUOUS visual capture stream — a background-thread DXGI
// Desktop Duplication loop that hands frames up as the display actually
// changes, entirely independent of (1)/(2) and of any AI provider.
//
// UNVERIFIED ON REAL WINDOWS HARDWARE — this development environment has
// no Windows host. The IPC/process-management logic here is reviewable
// and its message-parsing is unit-tested (eventMapping.test.ts), but
// end-to-end behavior against a real `powershell.exe` has not been run.
// The DXGI/D3D11 COM interop in eyesWatcher.ps1 is the single
// highest-risk piece of native code in this codebase — see that file's
// header for why, and validate it on real Windows hardware before relying
// on it.
export class WindowsVisualProvider implements VisualProvider {
  readonly platform = "windows";
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingCommand>();
  private stdoutBuffer = "";
  private onEventCallback: ((event: VisualEvent) => void) | null = null;
  private onFrameCallback: ((frame: ContinuousFrameSample) => void) | null = null;
  private onCaptureStatusCallback: ((state: string, detail: string) => void) | null = null;
  private captureState: string = "stopped";
  private windows: WindowSummary[] = [];

  get isRunning(): boolean {
    return this.child !== null;
  }

  getCapabilities(): VisualProviderCapabilities {
    return {
      supported: true,
      windowEvents: true,
      uiAutomationEvents: true,
      uiAutomationQueries: true,
      onDemandFrameCapture: true,
      // DXGI Desktop Duplication is a real, GPU-signaled capture
      // technology (AcquireNextFrame blocks until the display actually has
      // a new frame, or times out — it is not a sleep-then-grab loop), but
      // whether it actually initializes depends on runtime conditions this
      // process can't know in advance (a real GPU adapter, an active
      // (non-RDP-minimized) session, driver support) — reported honestly
      // as unconfigured at startContinuousCapture() time if it fails,
      // rather than claimed unconditionally here.
      continuousCapture: {
        supported: true,
        technology: "dxgi_desktop_duplication",
        maxCaptureFps: null, // display-refresh-dependent; not known until capture starts
        supportsDirtyRects: true,
        supportsMultiDisplay: true,
      },
    };
  }

  async start(onEvent: (event: VisualEvent) => void): Promise<void> {
    if (this.child) return;
    this.onEventCallback = onEvent;

    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", WATCHER_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stderr.on("data", (chunk: Buffer) => log.warn({ stderr: chunk.toString("utf8") }, "eyesWatcher.ps1 stderr"));
    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk.toString("utf8")));
    child.on("exit", (code) => {
      log.info({ code }, "eyesWatcher.ps1 exited");
      this.child = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timeout);
        p.reject(new ProviderError("Eyes watcher process exited before responding.", false));
      }
      this.pending.clear();
    });

    const ready = await Promise.race([
      new Promise<boolean>((resolve) => {
        const onReady = (chunk: Buffer) => {
          if (chunk.toString("utf8").includes('"kind":"ready"')) {
            resolve(true);
            child.stdout.off("data", onReady);
          }
        };
        child.stdout.on("data", onReady);
      }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 15_000)),
    ]);

    if (!ready) {
      child.kill();
      this.child = null;
      throw new ProviderError("Jarvis Eyes watcher process did not become ready within 15s.", true);
    }

    this.listWindows()
      .then((windows) => (this.windows = windows))
      .catch((err) => log.warn({ err }, "initial window list fetch failed"));
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    try {
      await this.sendCommand("exit", {}, 2000).catch(() => undefined);
    } finally {
      this.child?.kill();
      this.child = null;
      this.onEventCallback = null;
      this.onFrameCallback = null;
    }
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split("\n");
    this.stdoutBuffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // non-JSON noise (e.g. a stray PowerShell warning) — ignore rather than crash the watcher connection
      }

      if (parsed.kind === "event") {
        const visualEvent = mapRawEventToVisualEvent(parsed as unknown as RawWatcherEvent);
        if (visualEvent) {
          if (visualEvent.window) this.updateWindowCache(visualEvent.window);
          this.onEventCallback?.(visualEvent);
        }
      } else if (parsed.kind === "frame") {
        // Continuous capture tick — routed on arrival, never buffered or
        // batched here; the engine's own ingestion decides retention.
        const raw = parsed as unknown as RawContinuousFrame;
        this.onFrameCallback?.({
          sequence: raw.sequence,
          atMs: raw.atMs,
          displayId: raw.displayId,
          width: raw.width,
          height: raw.height,
          changedRegions: raw.changedRegions ?? [],
          changeScore: raw.changeScore,
          frame: raw.pixels ? { mimeType: raw.pixels.mimeType, base64: raw.pixels.base64, region: null, capturedAt: new Date(raw.atMs).toISOString() } : null,
          idleTimeouts: raw.idleTimeouts,
          captureLatencyMs: raw.captureLatencyMs,
        });
      } else if (parsed.kind === "capture_status") {
        const status = parsed as unknown as RawCaptureStatus;
        this.captureState = status.state;
        // "failed"/"stopped" are terminal for this capture session: drop
        // the frame sink so a late tick can't be mistaken for a live
        // stream, and let the engine see capture is no longer running
        // instead of silently believing it still is.
        if (status.state === "failed" || status.state === "stopped") {
          this.onFrameCallback = null;
        }
        this.onCaptureStatusCallback?.(status.state, status.detail);
        log.info({ state: status.state, detail: status.detail }, "continuous capture status");
      } else if (parsed.kind === "response" && typeof parsed.id === "string") {
        const pending = this.pending.get(parsed.id);
        if (!pending) continue;
        this.pending.delete(parsed.id);
        clearTimeout(pending.timeout);
        if (parsed.ok) pending.resolve(parsed.data);
        else pending.reject(new ProviderError(String(parsed.error ?? "Unknown Eyes watcher error"), true));
      }
    }
  }

  private updateWindowCache(window: WindowSummary): void {
    if (window.isForeground) {
      this.windows = this.windows.map((w) => ({ ...w, isForeground: w.windowId === window.windowId }));
    }
    const idx = this.windows.findIndex((w) => w.windowId === window.windowId);
    if (idx >= 0) this.windows[idx] = window;
    else this.windows.push(window);
  }

  private sendCommand(cmd: string, args: Record<string, unknown>, timeoutMs = COMMAND_TIMEOUT_MS): Promise<unknown> {
    if (!this.child) {
      throw new NotConfiguredError("Jarvis Eyes (watcher process is not running — call start() first)");
    }
    const id = crypto.randomUUID();
    const payload = JSON.stringify({ id, cmd, ...args });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProviderError(`Eyes watcher command "${cmd}" timed out after ${timeoutMs}ms.`, true));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.child!.stdin.write(payload + "\n");
    });
  }

  async listWindows(): Promise<WindowSummary[]> {
    const data = (await this.sendCommand("list_windows", {})) as WindowSummary[];
    this.windows = data;
    return data;
  }

  async getUiTree(windowId?: string, maxDepth = 5): Promise<UIElementNode> {
    return (await this.sendCommand("get_ui_tree", { windowId, maxDepth })) as UIElementNode;
  }

  async findUiElement(query: { windowId?: string; name?: string; automationId?: string; controlType?: string }): Promise<UIElementNode[]> {
    return (await this.sendCommand("find_ui_element", query)) as UIElementNode[];
  }

  async getUiElement(elementRef: string): Promise<UIElementNode> {
    return (await this.sendCommand("get_ui_element", { elementRef })) as UIElementNode;
  }

  async invokeUiElement(elementRef: string): Promise<void> {
    await this.sendCommand("invoke_ui_element", { elementRef });
  }

  async setUiElementValue(elementRef: string, value: string): Promise<void> {
    await this.sendCommand("set_ui_value", { elementRef, value });
  }

  async focusUiElement(elementRef: string): Promise<void> {
    await this.sendCommand("focus_ui_element", { elementRef });
  }

  async captureFrame(region?: ScreenRegion): Promise<VisualFrame> {
    const data = (await this.sendCommand("capture_frame", { region })) as { mimeType: "image/png"; base64: string; region: ScreenRegion };
    return { mimeType: data.mimeType, base64: data.base64, region: data.region, capturedAt: new Date().toISOString() };
  }

  onCaptureStatus(listener: (state: CaptureStreamState, detail: string) => void): void {
    this.onCaptureStatusCallback = (state, detail) => listener(state as CaptureStreamState, detail);
  }

  /** Last lifecycle state reported by the capture thread. */
  get continuousCaptureState(): string {
    return this.captureState;
  }

  async startContinuousCapture(options: ContinuousCaptureOptions, onFrame: (frame: ContinuousFrameSample) => void): Promise<void> {
    this.onFrameCallback = onFrame;
    // The watcher's ack just confirms the DXGI capture loop actually
    // initialized on its background thread — a real GPU/session failure
    // (e.g. no adapter, an RDP session with capture disabled) surfaces as
    // a rejection here rather than a silent no-op stream.
    await this.sendCommand("start_continuous_capture", {
      captureFps: options.captureFps,
      processingFps: options.processingFps,
      maxBufferedFrames: options.maxBufferedFrames,
      displayId: options.displayId,
    });
  }

  async stopContinuousCapture(): Promise<void> {
    this.onFrameCallback = null;
    if (!this.child) return;
    await this.sendCommand("stop_continuous_capture", {}, 5000).catch(() => undefined);
  }
}
