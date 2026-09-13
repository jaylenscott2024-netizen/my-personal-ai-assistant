import { VisualPerceptionEngine } from "./visualPerceptionEngine.js";
import { createVisualProvider } from "./visualProviderFactory.js";
import { getUserSettings } from "../settings/userSettingsService.js";
import { prisma } from "../database/client.js";
import { eventBus } from "../events/eventBus.js";
import { childLogger } from "../config/logger.js";
import { NotConfiguredError } from "../utils/errors.js";
import type { EyesLatencyPolicy } from "../settings/userSettingsService.js";

const log = childLogger("eyes.service");

// One VisualPerceptionEngine per user, started/stopped in lockstep with
// their `eyesEnabled` setting — nothing runs until a user explicitly
// opts in (Section: "the user should be able to completely disable the
// Eyes system"), and this is also where the setting change actually
// takes effect immediately rather than requiring a restart.
class EyesService {
  private engines = new Map<string, VisualPerceptionEngine>();

  async getEngineIfRunning(userId: string): Promise<VisualPerceptionEngine | null> {
    const engine = this.engines.get(userId);
    return engine?.isRunning ? engine : null;
  }

  /** Starts the engine for a user if their settings say Eyes should be
   *  on and it isn't already running. Throws NotConfiguredError (not
   *  silently swallowed) if the platform can't support it — callers
   *  (the settings route) surface that to the user directly. */
  async ensureStarted(userId: string): Promise<VisualPerceptionEngine> {
    const existing = this.engines.get(userId);
    if (existing?.isRunning) return existing;

    const settings = await getUserSettings(userId);
    if (!settings.eyesEnabled) {
      throw new NotConfiguredError("Jarvis Eyes (disabled in settings — enable it first)");
    }

    const provider = await createVisualProvider();
    const engine = new VisualPerceptionEngine(userId, provider, settings.eyesUpdateLatencyPolicy);
    await engine.start();
    this.engines.set(userId, engine);
    eventBus.emitEvent("eyes.started", { platform: provider.platform }, userId);
    return engine;
  }

  async stop(userId: string): Promise<void> {
    const engine = this.engines.get(userId);
    if (!engine) return;
    await engine.stop();
    this.engines.delete(userId);
    eventBus.emitEvent("eyes.stopped", {}, userId);
  }

  async setLatencyPolicy(userId: string, policy: EyesLatencyPolicy): Promise<void> {
    this.engines.get(userId)?.setLatencyPolicy(policy);
  }

  /** Called once at server startup (mirrors scheduler.ts's
   *  restoreScheduledJobs) so a user who had Eyes enabled before a
   *  restart doesn't have to manually re-enable it. Failures for
   *  unsupported platforms are logged, not thrown — this must not crash
   *  server startup. */
  async restoreEnabledEngines(): Promise<number> {
    const rows = await prisma.userSettings.findMany({ where: { eyesEnabled: true } });
    let started = 0;
    for (const row of rows) {
      try {
        await this.ensureStarted(row.userId);
        started++;
      } catch (err) {
        log.warn({ err, userId: row.userId }, "could not restore Jarvis Eyes engine on startup");
      }
    }
    return started;
  }

  async stopAll(): Promise<void> {
    for (const userId of [...this.engines.keys()]) await this.stop(userId);
  }
}

export const eyesService = new EyesService();
