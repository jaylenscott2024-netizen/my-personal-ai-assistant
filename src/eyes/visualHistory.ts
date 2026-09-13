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
  /** Hard cap on retained samples in the long-range (warm) tier —
   *  structural/low-density retention, not every observation. */
  maxSamples: number;
  /** Anything older than this is dropped from the warm tier, on write and
   *  on read — this is the user-facing `eyesHistorySeconds` window. */
  maxAgeMs: number;
  /** Hard cap on how many retained samples (across all tiers) may carry
   *  pixel data — the user-facing `eyesMaxKeyframes`. */
  maxFrames: number;
  /** Approximate byte budget for retained pixel data, across all tiers. */
  maxFrameBytes: number;
  /** Short, high-frequency buffer capacity: every accepted observation
   *  from the continuous capture stream lands here first, uncondition-
   *  ally, giving fine-grained "just now" motion/before-after recall
   *  without needing the long-range tier to hold every single tick. Not
   *  user-configurable — this is sizing detail, not a retention policy. */
  hotMaxSamples: number;
  hotMaxAgeMs: number;
  /** Minimum spacing enforced when thinning hot-tier samples down into
   *  the warm tier — this is what keeps "low frequency" actually low
   *  frequency instead of mirroring the hot tier at the same density. */
  warmBucketMs: number;
  /** Salience floor for promotion into the warm tier ahead of its normal
   *  time-bucket schedule — a significant change is worth remembering
   *  long-range even if it happened moments after the last warm entry. */
  warmSignificanceFloor: number;
  /** Salience floor for promotion into the keyframe tier — this is the
   *  "significant-event keyframes" bucket the retention model asks for. */
  keyframeMinAttentionScore: number;
}

export const DEFAULT_VISUAL_HISTORY_LIMITS: VisualHistoryLimits = {
  maxSamples: 240,
  maxAgeMs: 120_000,
  maxFrames: 12,
  maxFrameBytes: 24 * 1024 * 1024,
  hotMaxSamples: 90,
  hotMaxAgeMs: 8_000,
  warmBucketMs: 2_000,
  warmSignificanceFloor: 0.6,
  keyframeMinAttentionScore: IMPORTANCE_FLOOR.high,
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
  /** Per-tier counts, for observability into the retention model itself. */
  tiers: { hot: number; warm: number; keyframes: number };
}

// A single bounded ring: append-only, evicts by count then by age,
// oldest-first. Each tier below is one of these with its own limits and
// promotion rule — the shared plumbing (eviction, byte accounting) lives
// here so the three tiers can't drift into inconsistent eviction logic.
class RingTier {
  samples: VisualSample[] = [];
  dropped = 0;

  constructor(
    private maxCount: number,
    private maxAgeMs: number,
  ) {}

  add(sample: VisualSample, now: number): void {
    this.samples.push(sample);
    this.evict(now);
  }

  evict(now: number): void {
    const cutoff = now - this.maxAgeMs;
    if (this.samples.length > 0 && this.samples[0].atMs < cutoff) {
      const kept = this.samples.filter((s) => s.atMs >= cutoff);
      this.dropped += this.samples.length - kept.length;
      this.samples = kept;
    }
    if (this.samples.length > this.maxCount) {
      const excess = this.samples.length - this.maxCount;
      this.samples.splice(0, excess);
      this.dropped += excess;
    }
  }

  clear(): void {
    this.samples = [];
  }
}

// Bounded, in-memory temporal visual memory — the three-tier model a
// continuous capture stream actually needs: a HIGH-FREQUENCY SHORT BUFFER
// (every observation, briefly) so fine motion/before-after questions work
// at the moment they're asked, a LOW-FREQUENCY LONGER BUFFER (thinned,
// longer-range recall without mirroring the hot tier's density) so "what
// have I been doing" reaches back further, and SIGNIFICANT-EVENT
// KEYFRAMES (salience-gated, retained longest) so the handful of moments
// actually worth showing a model survive independently of both.
//
// Every accepted observation is written to the hot tier unconditionally,
// and independently OFFERED to warm/keyframes based on each tier's own
// promotion rule — the same VisualSample object is shared across tiers it
// appears in (not copied), so stripping its pixels once (see the frame
// budget below) is consistent everywhere it's retained.
//
// Retention rules that matter (Section 15: security):
//  - Nothing here is ever written to the database. Process memory only.
//  - Every tier is independently bounded by count and age; pixels are
//    additionally bounded by ONE combined frame count and byte budget
//    scanned across all three tiers — a sample promoted into warm keeps
//    whatever it arrived with (promotion never copies or strips), so the
//    budget has to see it there too, not just in hot/keyframes, or a
//    frame outliving hot's short window inside warm's much longer one
//    would silently escape the bound entirely.
//  - Under pixel pressure, frame payloads are stripped from the OLDEST
//    frame-bearing samples first, keeping their structural record intact
//    — so the timeline of what happened survives even when the imagery
//    of it doesn't. Losing pixels degrades detail; losing the timeline
//    would degrade correctness.
export class VisualHistory {
  private hot: RingTier;
  private warm: RingTier;
  private keyframes: RingTier;
  private newest: VisualSample | null = null;
  private strippedFrames = 0;

  private limits: VisualHistoryLimits;

  constructor(limits: Partial<VisualHistoryLimits> = {}) {
    this.limits = { ...DEFAULT_VISUAL_HISTORY_LIMITS, ...limits };
    this.hot = new RingTier(this.limits.hotMaxSamples, this.limits.hotMaxAgeMs);
    this.warm = new RingTier(this.limits.maxSamples, this.limits.maxAgeMs);
    this.keyframes = new RingTier(this.limits.maxFrames * 4, this.limits.maxAgeMs); // count-bounded mainly by the shared frame budget below
  }

  setLimits(limits: Partial<VisualHistoryLimits>): void {
    this.limits = { ...this.limits, ...limits };
    this.hot = rebuildTier(this.hot, this.limits.hotMaxSamples, this.limits.hotMaxAgeMs);
    this.warm = rebuildTier(this.warm, this.limits.maxSamples, this.limits.maxAgeMs);
    this.keyframes = rebuildTier(this.keyframes, this.limits.maxFrames * 4, this.limits.maxAgeMs);
    this.enforceFrameBudget();
  }

  getLimits(): VisualHistoryLimits {
    return { ...this.limits };
  }

  record(sample: VisualSample): void {
    const now = sample.atMs;
    this.newest = sample;
    this.hot.add(sample, now);
    this.maybePromoteToWarm(sample, now);
    this.maybePromoteToKeyframe(sample, now);
    this.enforceFrameBudget();
  }

  private maybePromoteToWarm(sample: VisualSample, now: number): void {
    const last = this.warm.samples[this.warm.samples.length - 1];
    const dueByTime = !last || sample.atMs - last.atMs >= this.limits.warmBucketMs;
    const dueBySignificance = sample.attentionScore >= this.limits.warmSignificanceFloor;
    if (dueByTime || dueBySignificance) this.warm.add(sample, now);
  }

  private maybePromoteToKeyframe(sample: VisualSample, now: number): void {
    if (sample.frame && sample.attentionScore >= this.limits.keyframeMinAttentionScore) {
      this.keyframes.add(sample, now);
    }
  }

  latest(): VisualSample | null {
    return this.newest;
  }

  /** Oldest-first list of matching samples, merged across all three tiers
   *  with duplicates (a sample retained in more than one tier) collapsed. */
  query(query: VisualHistoryQuery = {}, now = Date.now()): VisualSample[] {
    this.evictExpired(now);

    const merged = new Map<string, VisualSample>();
    for (const tier of [this.hot, this.warm, this.keyframes]) {
      for (const sample of tier.samples) merged.set(sample.id, sample);
    }
    const all = [...merged.values()].sort((a, b) => a.atMs - b.atMs);

    const minScore = query.minAttentionScore ?? (query.importance ? IMPORTANCE_FLOOR[query.importance] : undefined);
    const matched = all.filter((sample) => {
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

    const merged = new Map<string, VisualSample>();
    for (const tier of [this.hot, this.warm, this.keyframes]) {
      for (const sample of tier.samples) merged.set(sample.id, sample);
    }
    const all = [...merged.values()];
    const withFrames = all.filter((s) => s.frame);

    return {
      samples: all.length,
      frames: withFrames.length,
      approxFrameBytes: withFrames.reduce((total, s) => total + approximateSampleBytes(s), 0),
      oldestAtMs: all.length > 0 ? Math.min(...all.map((s) => s.atMs)) : null,
      newestAtMs: all.length > 0 ? Math.max(...all.map((s) => s.atMs)) : null,
      droppedSamples: this.hot.dropped + this.warm.dropped + this.keyframes.dropped,
      strippedFrames: this.strippedFrames,
      tiers: { hot: this.hot.samples.length, warm: this.warm.samples.length, keyframes: this.keyframes.samples.length },
    };
  }

  clear(): void {
    this.hot.clear();
    this.warm.clear();
    this.keyframes.clear();
    this.newest = null;
  }

  private evictExpired(now: number): void {
    this.hot.evict(now);
    this.warm.evict(now);
    this.keyframes.evict(now);
  }

  // Shared byte/count budget across ALL THREE tiers. Warm-tier promotion
  // doesn't strip pixels on its own — a sample keeps carrying whatever it
  // arrived with (tiers share the same VisualSample object by reference,
  // never a copy) — so this must scan every tier, not just hot/keyframes:
  // a sample that ages out of hot but is still held by warm would
  // otherwise never be reconsidered for eviction and could hold pixels
  // for as long as warm's (much longer) retention window, silently
  // breaking the frame/byte budget. Strips the OLDEST frame-bearing
  // samples first; because tiers share objects by reference, stripping
  // once is visible everywhere that sample is retained.
  private enforceFrameBudget(): void {
    const seen = new Set<string>();
    const framed: VisualSample[] = [];
    for (const tier of [this.hot, this.warm, this.keyframes]) {
      for (const sample of tier.samples) {
        if (!sample.frame || seen.has(sample.id)) continue;
        seen.add(sample.id);
        framed.push(sample);
      }
    }
    framed.sort((a, b) => a.atMs - b.atMs);

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

function rebuildTier(existing: RingTier, maxCount: number, maxAgeMs: number): RingTier {
  const tier = new RingTier(maxCount, maxAgeMs);
  tier.samples = existing.samples;
  tier.dropped = existing.dropped;
  tier.evict(Date.now());
  return tier;
}
