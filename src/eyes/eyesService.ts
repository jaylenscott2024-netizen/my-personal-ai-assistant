import { VisualPerceptionEngine } from "./visualPerceptionEngine.js";
import { createVisualProvider } from "./visualProviderFactory.js";
import { getUserSettings } from "../settings/userSettingsService.js";
import { prisma } from "../database/client.js";
import { eventBus } from "../events/eventBus.js";
import { childLogger } from "../config/logger.js";
import { NotConfiguredError } from "../utils/errors.js";
import type { EyesLatencyPolicy, UserSettings } from "../settings/userSettingsService.js";
import { realtimeVisualSessions } from "./transport/realtimeVisualTransport.js";
import { userIdFromSessionKey } from "./eyesVisionAccess.js";

const log = childLogger("eyes.service");

// One VisualPerceptionEngine per user, started/stopped in lockstep with
// their `eyesEnabled` setting — nothing runs until a user explicitly
// opts in (Section: "the user should be able to completely disable the
// Eyes system"), and this is also where the setting change actually
// takes effect immediately rather than requiring a restart.
class EyesService {
  private engines = new Map<string, VisualPerceptionEngine>();
  private streamUnsubscribeByKey = new Map<string, () => void>();
  private sessionHookInstalled = false;

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

    this.installRealtimeSessionHook();

    const provider = await createVisualProvider();
    const engine = new VisualPerceptionEngine(userId, provider, engineOptionsFor(settings));
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
    this.detachStreamsForUser(userId);
    eventBus.emitEvent("eyes.stopped", {}, userId);
  }

  async setLatencyPolicy(userId: string, policy: EyesLatencyPolicy): Promise<void> {
    this.engines.get(userId)?.setLatencyPolicy(policy);
  }

  /** Re-applies every Eyes setting to an already-running engine, so a
   *  settings change takes effect without a restart (and without losing
   *  the visual history built up so far). Starts/stops the continuous
   *  capture stream live if eyesMode actually changed. */
  async applySettings(userId: string, settings: UserSettings): Promise<void> {
    const engine = this.engines.get(userId);
    if (!engine) return;
    const options = engineOptionsFor(settings);
    engine.setLatencyPolicy(settings.eyesUpdateLatencyPolicy);
    engine.setHistoryLimits(options.historyLimits ?? {});
    await engine.setContinuousCapturePolicy(options.continuousCapturePolicy ?? {});
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
    await realtimeVisualSessions.closeAll();
  }

  // When a live visual session opens for a user, attach that user's stream
  // to it. This is the only place the engine and the realtime transport
  // meet, and it's a one-way hand-off: the feed drops frames on its own
  // schedule and can never apply backpressure to perception.
  private installRealtimeSessionHook(): void {
    if (this.sessionHookInstalled) return;
    this.sessionHookInstalled = true;

    realtimeVisualSessions.onSessionOpened((key, feed) => {
      const userId = userIdFromSessionKey(key);
      const engine = this.engines.get(userId);
      if (!engine) return;
      this.streamUnsubscribeByKey.get(key)?.();
      const unsubscribe = engine.subscribe((sample) => {
        feed.offer(sample); // synchronous, non-blocking, drops when behind
      });
      this.streamUnsubscribeByKey.set(key, unsubscribe);
      log.info({ userId, fps: feed.negotiation.fps }, "attached visual stream to realtime session");
    });
  }

  private detachStreamsForUser(userId: string): void {
    for (const [key, unsubscribe] of [...this.streamUnsubscribeByKey]) {
      if (userIdFromSessionKey(key) !== userId) continue;
      unsubscribe();
      this.streamUnsubscribeByKey.delete(key);
    }
  }
}

/** Translates user-facing settings into engine policy. Continuous visual
 *  capture is started only by the explicit structural_plus_visual mode —
 *  in the default structural_only mode the engine never starts the
 *  capture stream, so zero pixels are ever obtained. */
function engineOptionsFor(settings: UserSettings) {
  return {
    latencyPolicy: settings.eyesUpdateLatencyPolicy,
    continuousCapturePolicy: {
      enabled: settings.eyesMode === "structural_plus_visual",
      captureFps: settings.eyesLocalCaptureFps,
      processingFps: settings.eyesLocalProcessingFps,
      maxBufferedFrames: settings.eyesMaxBufferedFrames,
    },
    historyLimits: {
      maxAgeMs: settings.eyesHistorySeconds * 1000,
      maxFrames: settings.eyesMaxKeyframes,
    },
  };
}

export const eyesService = new EyesService();
