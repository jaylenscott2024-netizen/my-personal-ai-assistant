import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { childLogger } from "../config/logger.js";

const log = childLogger("browserManager");

// Section 25: Browser Automation Service (Playwright). Sessions are
// isolated per user+session id (own BrowserContext, not just a page) so one
// user's cookies/storage can never leak into another's session, and are
// torn down automatically after inactivity so a forgotten session doesn't
// leak resources indefinitely.
const SESSION_TTL_MS = 10 * 60 * 1000;

interface BrowserSession {
  context: BrowserContext;
  page: Page;
  lastUsedAt: number;
}

class BrowserManager {
  private browser: Browser | null = null;
  private sessions = new Map<string, BrowserSession>();
  private reaper: NodeJS.Timeout | null = null;

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: true });
      if (!this.reaper) {
        this.reaper = setInterval(() => this.reapIdleSessions(), 60_000);
        this.reaper.unref();
      }
    }
    return this.browser;
  }

  private reapIdleSessions(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastUsedAt > SESSION_TTL_MS) {
        this.closeSession(id).catch((err) => log.warn({ err, id }, "failed to reap idle browser session"));
      }
    }
  }

  async getSession(sessionId: string): Promise<BrowserSession> {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const browser = await this.getBrowser();
      const context = await browser.newContext();
      const page = await context.newPage();
      session = { context, page, lastUsedAt: Date.now() };
      this.sessions.set(sessionId, session);
    }
    session.lastUsedAt = Date.now();
    return session;
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    await session.context.close().catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    for (const id of [...this.sessions.keys()]) await this.closeSession(id);
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

export const browserManager = new BrowserManager();
