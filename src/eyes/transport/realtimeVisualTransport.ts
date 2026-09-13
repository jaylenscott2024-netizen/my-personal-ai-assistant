import type { ModelCapabilities } from "../../ai/types.js";
import { visionCapabilitiesOf } from "../../ai/visionCapabilities.js";
import { childLogger } from "../../config/logger.js";
import type { VisualSample } from "../visualStream.js";

const log = childLogger("eyes.realtimeVisual");

// Section 9/16: the realtime visual transport, kept provider-neutral so a
// future provider with a live visual endpoint reuses all of this and only
// writes its own sink.
//
// The single most important property here: LOCAL EYES FPS IS NOT CLOUD
// TRANSPORT FPS. The engine may observe dozens of changes per second; a
// live API may accept one frame per second. This pacer is the only place
// those two rates meet, and it resolves the mismatch by dropping and
// coalescing — never by slowing perception down to the cloud's rate.

export interface RealtimeVisualNegotiation {
  model: string;
  /** Effective frames/second this session will accept. */
  fps: number;
  intervalMs: number;
  acceptsAudio: boolean;
}

export interface NegotiationOptions {
  /** What the caller would like, if the model allows it. */
  requestedFps?: number;
  /** What the server said it would accept at setup, when it says anything
   *  at all. Always wins downward — never upward. */
  serverAcceptedFps?: number;
}

/** Resolves the effective rate as the MINIMUM of every constraint that
 *  actually exists. Nothing here assumes a fixed per-provider fps: the
 *  declared ceiling comes from the model's own VisionCapabilities, and a
 *  server-advertised limit overrides it downward at setup. */
export function negotiateRealtimeVisual(
  model: string,
  capabilities: ModelCapabilities,
  options: NegotiationOptions = {},
): RealtimeVisualNegotiation | null {
  const vision = visionCapabilitiesOf(capabilities);
  if (!vision.realtimeVision) return null;

  const constraints = [vision.maxRealtimeVisualFps, options.requestedFps, options.serverAcceptedFps].filter(
    (value): value is number => typeof value === "number" && value > 0,
  );
  // A model that declares realtime vision without any numeric ceiling gets
  // a conservative 1 fps rather than an unbounded firehose.
  const fps = constraints.length > 0 ? Math.min(...constraints) : 1;

  return {
    model,
    fps,
    intervalMs: Math.max(1, Math.round(1000 / fps)),
    acceptsAudio: vision.realtimeAudio,
  };
}

/** Where paced frames actually go. The Gemini Live client implements this;
 *  tests implement it with a deterministic fake. */
export interface RealtimeVisualSink {
  readonly id: string;
  readonly isOpen: boolean;
  open(negotiation: RealtimeVisualNegotiation): Promise<void>;
  sendFrame(sample: VisualSample): Promise<void>;
  close(): Promise<void>;
}

export type PacedOfferResult =
  | "sent"
  | "dropped_rate" // arrived sooner than the negotiated interval allows
  | "dropped_busy" // a send is still in flight; newest sample kept pending
  | "dropped_no_frame" // structural-only observation, nothing to transmit
  | "closed";

export interface PacedFeedStats {
  sent: number;
  droppedRate: number;
  droppedBusy: number;
  droppedNoFrame: number;
  failed: number;
  lastSentAtMs: number | null;
}

// Bounded, non-blocking, drop-happy by design.
//
// `offer()` is synchronous and returns immediately in every case — it is
// called from the Eyes event path, where any await would put cloud latency
// directly into local perception. When the sink is slow, the newest sample
// replaces the pending one: falling behind costs detail, never liveness.
export class PacedRealtimeVisualFeed {
  private inFlight = false;
  private pending: VisualSample | null = null;
  private lastSentAtMs: number | null = null;
  private stats: PacedFeedStats = {
    sent: 0,
    droppedRate: 0,
    droppedBusy: 0,
    droppedNoFrame: 0,
    failed: 0,
    lastSentAtMs: null,
  };

  constructor(
    private readonly sink: RealtimeVisualSink,
    readonly negotiation: RealtimeVisualNegotiation,
  ) {}

  get isOpen(): boolean {
    return this.sink.isOpen;
  }

  offer(sample: VisualSample): PacedOfferResult {
    if (!this.sink.isOpen) return "closed";
    if (!sample.frame) {
      this.stats.droppedNoFrame++;
      return "dropped_no_frame";
    }
    if (this.lastSentAtMs !== null && sample.atMs - this.lastSentAtMs < this.negotiation.intervalMs) {
      this.stats.droppedRate++;
      return "dropped_rate";
    }
    if (this.inFlight) {
      this.pending = sample; // newest wins
      this.stats.droppedBusy++;
      return "dropped_busy";
    }
    this.dispatch(sample);
    return "sent";
  }

  getStats(): PacedFeedStats {
    return { ...this.stats };
  }

  async close(): Promise<void> {
    this.pending = null;
    await this.sink.close();
  }

  private dispatch(sample: VisualSample): void {
    this.inFlight = true;
    this.lastSentAtMs = sample.atMs;
    this.stats.lastSentAtMs = sample.atMs;

    void (async () => {
      try {
        await this.sink.sendFrame(sample);
        this.stats.sent++;
      } catch (err) {
        this.stats.failed++;
        // A failed cloud send is never allowed to propagate into the Eyes
        // event path — perception continues regardless.
        log.warn({ err, sink: this.sink.id }, "realtime visual frame send failed; perception unaffected");
      } finally {
        this.inFlight = false;
        const next = this.pending;
        this.pending = null;
        if (next && this.sink.isOpen) {
          const dueAt = (this.lastSentAtMs ?? 0) + this.negotiation.intervalMs;
          if (Date.now() >= dueAt) this.dispatch(next);
          else this.stats.droppedRate++;
        }
      }
    })();
  }
}

export type RealtimeVisualSinkFactory = (
  negotiation: RealtimeVisualNegotiation,
) => RealtimeVisualSink | Promise<RealtimeVisualSink>;

// Owns at most one live visual session per (user, provider, model). A
// session that can't be opened is NOT an error the caller has to handle —
// the adapter simply falls back to the still-image transport, which is a
// transport fallback, not a perception fallback (Eyes never changes).
export type SessionOpenedListener = (key: string, feed: PacedRealtimeVisualFeed) => void;

export class RealtimeVisualSessionManager {
  private sessions = new Map<string, PacedRealtimeVisualFeed>();
  private failedKeys = new Set<string>();
  private openedListeners: SessionOpenedListener[] = [];

  constructor(private sinkFactory: RealtimeVisualSinkFactory | null = null) {}

  setSinkFactory(factory: RealtimeVisualSinkFactory | null): void {
    this.sinkFactory = factory;
    this.failedKeys.clear();
  }

  /** Fires when a session opens, so whoever owns the visual stream can
   *  attach it to the new feed. Keeps the transport from having to know
   *  the engine, and the engine from having to know the transport. */
  onSessionOpened(listener: SessionOpenedListener): () => void {
    this.openedListeners.push(listener);
    return () => {
      this.openedListeners = this.openedListeners.filter((l) => l !== listener);
    };
  }

  get(key: string): PacedRealtimeVisualFeed | null {
    const session = this.sessions.get(key);
    if (!session) return null;
    if (!session.isOpen) {
      this.sessions.delete(key);
      return null;
    }
    return session;
  }

  async ensureSession(
    key: string,
    negotiation: RealtimeVisualNegotiation,
  ): Promise<PacedRealtimeVisualFeed | null> {
    const existing = this.get(key);
    if (existing) return existing;
    if (!this.sinkFactory) return null;
    // Don't reattempt a session that already failed to open — a dead
    // endpoint must not add connect latency to every subsequent turn.
    if (this.failedKeys.has(key)) return null;

    try {
      const sink = await this.sinkFactory(negotiation);
      await sink.open(negotiation);
      const feed = new PacedRealtimeVisualFeed(sink, negotiation);
      this.sessions.set(key, feed);
      for (const listener of this.openedListeners) {
        try {
          listener(key, feed);
        } catch (err) {
          log.warn({ err, key }, "realtime visual session listener failed");
        }
      }
      return feed;
    } catch (err) {
      this.failedKeys.add(key);
      log.warn({ err, key }, "realtime visual session unavailable; falling back to still-image transport");
      return null;
    }
  }

  async closeAll(): Promise<void> {
    for (const [key, session] of [...this.sessions]) {
      this.sessions.delete(key);
      await session.close().catch(() => undefined);
    }
    this.failedKeys.clear();
  }
}

export const realtimeVisualSessions = new RealtimeVisualSessionManager();
