import { approximateSampleBytes, type VisualChangeKind, type VisualSample } from "./visualStream.js";

export type VisualImportance = "low" | "medium" | "high";

const IMPORTANCE_FLOOR: Record<VisualImportance, number> = {
  low: 0,
  medium: 0.4,
  high: 0.7,
};

export function importanceOf(attentionScore: number): VisualImportance {
  if (attentionScore >= IMPORTANCE_FLOOR.high) return "high";
  if (attentionScore >= IMPORTANCE_FLOOR.medium) return "medium";
  return "low";
}

export interface VisualHistoryLimits {
  /** Hard cap on retained samples (structural records included). */
  maxSamples: number;
  /** Anything older than this is dropped, on write and on read. */
  maxAgeMs: number;
  /** Hard cap on how many retained samples may carry pixel data. */
  maxFrames: number;
  /** Approximate byte budget for retained pixel data. */
  maxFrameBytes: number;
}

export const DEFAULT_VISUAL_HISTORY_LIMITS: VisualHistoryLimits = {
  maxSamples: 240,
  maxAgeMs: 120_000,
  maxFrames: 12,
  maxFrameBytes: 24 * 1024 * 1024,
};

export interface VisualHistoryQuery {
  since?: number;
  until?: number;
  importance?: VisualImportance;
  minAttentionScore?: number;
  changeKinds?: VisualChangeKind[];
  /** Only samples that actually carry pixels. */
  requireFrame?: boolean;
  /** Newest-first cap applied after filtering; results stay oldest-first. */
  maxSamples?: number;
}

export interface VisualHistoryStats {
  samples: number;
  frames: number;
  approxFrameBytes: number;
  oldestAtMs: number | null;
  newestAtMs: number | null;
  droppedSamples: number;
  strippedFrames: number;
}

// Bounded, in-memory temporal visual memory.
//
// This is what makes "what just happened?" answerable without any
// screenshot polling: the engine records every accepted observation as it
// occurs, so recent history already exists at the moment it's asked for.
//
// Retention rules that matter (Section 15: security):
//  - Nothing here is ever written to the database. Process memory only.
//  - Bounded four ways at once (count, age, frame count, frame bytes).
//  - Under pixel pressure, frame payloads are stripped from the OLDEST
//    frame-bearing samples first, keeping their structural record intact —
//    so the timeline of what happened survives even when the imagery of it
//    doesn't. Losing pixels degrades detail; losing the timeline would
//    degrade correctness.
export class VisualHistory {
  private samples: VisualSample[] = [];
  private droppedSamples = 0;
  private strippedFrames = 0;

  constructor(private limits: VisualHistoryLimits = DEFAULT_VISUAL_HISTORY_LIMITS) {}

  setLimits(limits: Partial<VisualHistoryLimits>): void {
    this.limits = { ...this.limits, ...limits };
    this.enforceLimits(Date.now());
  }

  getLimits(): VisualHistoryLimits {
    return { ...this.limits };
  }

  record(sample: VisualSample): void {
    this.samples.push(sample);
    this.enforceLimits(sample.atMs);
  }

  latest(): VisualSample | null {
    return this.samples.length > 0 ? this.samples[this.samples.length - 1] : null;
  }

  /** Oldest-first list of matching samples. */
  query(query: VisualHistoryQuery = {}, now = Date.now()): VisualSample[] {
    this.evictExpired(now);

    const minScore = query.minAttentionScore ?? (query.importance ? IMPORTANCE_FLOOR[query.importance] : undefined);
    const matched = this.samples.filter((sample) => {
      if (query.since !== undefined && sample.atMs < query.since) return false;
      if (query.until !== undefined && sample.atMs > query.until) return false;
      if (minScore !== undefined && sample.attentionScore < minScore) return false;
      if (query.requireFrame && !sample.frame) return false;
      if (query.changeKinds && !query.changeKinds.includes(sample.changeKind)) return false;
      return true;
    });

    if (query.maxSamples !== undefined && matched.length > query.maxSamples) {
      // Keep the most RECENT n, but hand them back in chronological order —
      // a model reading a sequence needs it ordered, not reversed.
      return matched.slice(matched.length - query.maxSamples);
    }
    return matched;
  }

  stats(now = Date.now()): VisualHistoryStats {
    this.evictExpired(now);
    const withFrames = this.samples.filter((s) => s.frame);
    return {
      samples: this.samples.length,
      frames: withFrames.length,
      approxFrameBytes: withFrames.reduce((total, s) => total + approximateSampleBytes(s), 0),
      oldestAtMs: this.samples[0]?.atMs ?? null,
      newestAtMs: this.samples[this.samples.length - 1]?.atMs ?? null,
      droppedSamples: this.droppedSamples,
      strippedFrames: this.strippedFrames,
    };
  }

  clear(): void {
    this.samples = [];
  }

  private evictExpired(now: number): void {
    const cutoff = now - this.limits.maxAgeMs;
    if (this.samples.length === 0 || this.samples[0].atMs >= cutoff) return;
    const kept = this.samples.filter((s) => s.atMs >= cutoff);
    this.droppedSamples += this.samples.length - kept.length;
    this.samples = kept;
  }

  private enforceLimits(now: number): void {
    this.evictExpired(now);

    if (this.samples.length > this.limits.maxSamples) {
      const excess = this.samples.length - this.limits.maxSamples;
      this.samples.splice(0, excess);
      this.droppedSamples += excess;
    }

    this.enforceFrameBudget();
  }

  private enforceFrameBudget(): void {
    const framed = this.samples.filter((s) => s.frame);
    let frameCount = framed.length;
    let frameBytes = framed.reduce((total, s) => total + approximateSampleBytes(s), 0);
    if (frameCount <= this.limits.maxFrames && frameBytes <= this.limits.maxFrameBytes) return;

    for (const sample of framed) {
      if (frameCount <= this.limits.maxFrames && frameBytes <= this.limits.maxFrameBytes) break;
      frameBytes -= approximateSampleBytes(sample);
      frameCount--;
      sample.frame = null; // structural record survives; only pixels go
      this.strippedFrames++;
    }
  }
}
