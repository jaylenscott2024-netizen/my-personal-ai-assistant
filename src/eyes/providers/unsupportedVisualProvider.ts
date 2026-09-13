import { NotConfiguredError } from "../../utils/errors.js";
import type { VisualProvider } from "../visualProvider.js";
import type { VisualProviderCapabilities } from "../types.js";

// Section: "If the visual-perception engine cannot support a particular
// environment, report that limitation clearly." This is that honest
// report — used on any platform without a real VisualProvider
// implementation (today: Linux, macOS; this is also what runs in this
// project's own headless Linux test/dev sandbox). It never falls back to
// screenshots or any other substitute — every method throws
// NotConfiguredError with a specific, actionable reason.
export class UnsupportedVisualProvider implements VisualProvider {
  readonly platform: string;
  private readonly reason: string;

  constructor(platform: string, reason: string) {
    this.platform = platform;
    this.reason = reason;
  }

  get isRunning(): boolean {
    return false;
  }

  getCapabilities(): VisualProviderCapabilities {
    return {
      supported: false,
      windowEvents: false,
      uiAutomationEvents: false,
      uiAutomationQueries: false,
      onDemandFrameCapture: false,
      detail: this.reason,
    };
  }

  async start(): Promise<void> {
    throw new NotConfiguredError(`Jarvis Eyes on ${this.platform} (${this.reason})`);
  }

  async stop(): Promise<void> {
    // No-op: nothing was ever started.
  }

  async listWindows(): Promise<never> {
    throw new NotConfiguredError(`Jarvis Eyes window listing on ${this.platform} (${this.reason})`);
  }

  async getUiTree(): Promise<never> {
    throw new NotConfiguredError(`Windows UI Automation on ${this.platform} (${this.reason})`);
  }

  async findUiElement(): Promise<never> {
    throw new NotConfiguredError(`Windows UI Automation on ${this.platform} (${this.reason})`);
  }

  async getUiElement(): Promise<never> {
    throw new NotConfiguredError(`Windows UI Automation on ${this.platform} (${this.reason})`);
  }

  async invokeUiElement(): Promise<never> {
    throw new NotConfiguredError(`Windows UI Automation on ${this.platform} (${this.reason})`);
  }

  async setUiElementValue(): Promise<never> {
    throw new NotConfiguredError(`Windows UI Automation on ${this.platform} (${this.reason})`);
  }

  async focusUiElement(): Promise<never> {
    throw new NotConfiguredError(`Windows UI Automation on ${this.platform} (${this.reason})`);
  }

  async captureFrame(): Promise<never> {
    throw new NotConfiguredError(`Jarvis Eyes on-demand frame capture on ${this.platform} (${this.reason})`);
  }
}
