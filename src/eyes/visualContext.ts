import type { VisionTransportStrategy } from "../ai/types.js";
import type { ScreenRegion, VisualState } from "./types.js";
import type { VisualHistory } from "./visualHistory.js";
import type { VisualChangeKind, VisualSample } from "./visualStream.js";

// Section 12: the model-facing temporal context API.
//
// A model doesn't ask for "frames"; it asks a *question* ("what just
// happened?", "what am I looking at?"). The purpose is what drives how far
// back to look, how many observations to include, and how selective to be
// — and the transport adapter then decides how to actually carry that to
// its provider. Purpose here, transport there: neither knows the other's
// business.
export type VisualContextPurpose =
  | "current_state"
  | "what_changed"
  | "what_just_happened"
  | "inspect_region"
  | "understand_scene"
  | "follow_visual_activity";

export type VisualContextDetail = "low" | "medium" | "high";

export interface VisualContextRequest {
  purpose: VisualContextPurpose;
  /** Epoch ms bounds. Default: `purpose`'s own lookback window ending now. */
  since?: number;
  until?: number;
  detail?: VisualContextDetail;
  /** 0..1 — observations below this salience are ignored entirely. */
  attentionThreshold?: number;
  maxSamples?: number;
  region?: ScreenRegion;
  /** A hint only. The adapter still decides from real model capabilities. */
  preferredTransport?: VisionTransportStrategy;
}

export interface VisualContext {
  purpose: VisualContextPurpose;
  detail: VisualContextDetail;
  requestedAtMs: number;
  windowMs: { since: number; until: number };
  /** The engine's live structural state at build time. */
  visualState: VisualState;
  /** The most recent observation, if any. */
  currentSample: VisualSample | null;
  /** Chronologically ordered selection (may include `currentSample`). */
  samples: VisualSample[];
  /** Always-safe text rendering of the selection. Sent even to models
   *  that cannot accept a single pixel. */
  temporalSummary: string;
  attention: { maxScore: number; primaryCount: number; peripheralCount: number };
  preferredTransport?: VisionTransportStrategy;
}

interface PurposeDefaults {
  lookbackMs: number;
  maxSamples: number;
  attentionThreshold: number;
  /** Whether a before/after pair around the peak change is worth spending
   *  sample budget on. */
  pairAroundPeak: boolean;
}

const PURPOSE_DEFAULTS: Record<VisualContextPurpose, PurposeDefaults> = {
  // "What am I looking at?" — the latest observation is the answer;
  // history would only dilute it.
  current_state: { lookbackMs: 5_000, maxSamples: 1, attentionThreshold: 0, pairAroundPeak: false },
  // "What changed?" — needs the transition, so a before/after pair around
  // the most significant change beats any number of recent stills.
  what_changed: { lookbackMs: 60_000, maxSamples: 4, attentionThreshold: 0.4, pairAroundPeak: true },
  what_just_happened: { lookbackMs: 30_000, maxSamples: 6, attentionThreshold: 0.3, pairAroundPeak: true },
  inspect_region: { lookbackMs: 5_000, maxSamples: 2, attentionThreshold: 0, pairAroundPeak: false },
  understand_scene: { lookbackMs: 10_000, maxSamples: 3, attentionThreshold: 0, pairAroundPeak: false },
  // "Watch this and tell me when something important changes" — a wider
  // sweep of salient moments, still bounded.
  follow_visual_activity: { lookbackMs: 15_000, maxSamples: 8, attentionThreshold: 0.2, pairAroundPeak: true },
};

const DETAIL_MULTIPLIER: Record<VisualContextDetail, number> = { low: 0.5, medium: 1, high: 1.75 };

/** Change kinds that represent a real scene transition rather than a tweak. */
const SIGNIFICANT_KINDS: VisualChangeKind[] = ["window_focus", "window_lifecycle", "notification", "ui_structure"];

/** Two observations closer together than this are near-duplicates for
 *  selection purposes — keep the better-scoring one, spend the budget on
 *  a genuinely different moment instead. */
const MIN_SPACING_MS = 750;

export function buildVisualContext(
  state: VisualState,
  history: VisualHistory,
  request: VisualContextRequest,
  now = Date.now(),
): VisualContext {
  const defaults = PURPOSE_DEFAULTS[request.purpose];
  const detail = request.detail ?? "medium";
  const until = request.until ?? now;
  const since = request.since ?? until - defaults.lookbackMs;
  const attentionThreshold = request.attentionThreshold ?? defaults.attentionThreshold;
  const maxSamples = Math.max(
    1,
    request.maxSamples ?? Math.round(defaults.maxSamples * DETAIL_MULTIPLIER[detail]),
  );

  const candidates = history.query({ since, until, minAttentionScore: attentionThreshold }, now);
  // The newest observation is always eligible regardless of threshold —
  // "nothing salient happened recently" is itself an answer, and a context
  // with zero observations is useless to every transport.
  const newest = history.latest();
  const pool = candidates.length > 0 ? candidates : newest ? [newest] : [];

  const selected = selectSamples(pool, { maxSamples, pairAroundPeak: defaults.pairAroundPeak });
  const currentSample = pool.length > 0 ? pool[pool.length - 1] : null;

  return {
    purpose: request.purpose,
    detail,
    requestedAtMs: now,
    windowMs: { since, until },
    visualState: state,
    currentSample,
    samples: selected,
    temporalSummary: renderTemporalSummary(state, selected, { since, until }, now, request.purpose),
    attention: {
      maxScore: selected.reduce((max, s) => Math.max(max, s.attentionScore), 0),
      primaryCount: selected.filter((s) => s.attention === "primary").length,
      peripheralCount: selected.filter((s) => s.attention === "peripheral").length,
    },
    preferredTransport: request.preferredTransport,
  };
}

interface SelectionOptions {
  maxSamples: number;
  pairAroundPeak: boolean;
}

// Attention- and change-driven selection. The budget is small on purpose:
// sending every observation would be the token-burning equivalent of the
// screenshot-spam loop this architecture exists to avoid.
export function selectSamples(pool: VisualSample[], options: SelectionOptions): VisualSample[] {
  if (pool.length === 0) return [];
  if (pool.length <= options.maxSamples) return [...pool];

  const newest = pool[pool.length - 1];
  const picked = new Set<VisualSample>();

  if (options.pairAroundPeak) {
    // For a "what changed" question the transition IS the answer, so the
    // peak moment and the observation immediately before it are claimed
    // before the newest one. Under a tight budget that ordering matters:
    // "here's the latest frame" doesn't tell you what changed, whereas a
    // before/after pair does.
    let peak = pool[0];
    for (const sample of pool) {
      if (rankOf(sample) > rankOf(peak)) peak = sample;
    }
    picked.add(peak);
    const peakIndex = pool.indexOf(peak);
    if (peakIndex > 0 && picked.size < options.maxSamples) picked.add(pool[peakIndex - 1]);
  }

  if (picked.size < options.maxSamples) picked.add(newest);

  const remaining = pool
    .filter((sample) => !picked.has(sample))
    .sort((a, b) => rankOf(b) - rankOf(a));

  for (const candidate of remaining) {
    if (picked.size >= options.maxSamples) break;
    const tooClose = [...picked].some((chosen) => Math.abs(chosen.atMs - candidate.atMs) < MIN_SPACING_MS);
    if (tooClose) continue;
    picked.add(candidate);
  }

  return [...picked].sort((a, b) => a.atMs - b.atMs);
}

// Ranking blends salience, "is this a real transition", and whether we
// actually hold pixels for it — a framed observation is worth more to an
// image transport, and costs a text transport nothing.
function rankOf(sample: VisualSample): number {
  let rank = sample.attentionScore;
  if (SIGNIFICANT_KINDS.includes(sample.changeKind)) rank += 0.25;
  if (sample.attention === "primary") rank += 0.1;
  if (sample.frame) rank += 0.15;
  return rank;
}

export function relativeLabel(atMs: number, nowMs: number): string {
  const deltaSeconds = (nowMs - atMs) / 1000;
  if (deltaSeconds < 0.1) return "now";
  return `-${deltaSeconds.toFixed(1)}s`;
}

function renderTemporalSummary(
  state: VisualState,
  samples: VisualSample[],
  window: { since: number; until: number },
  now: number,
  purpose: VisualContextPurpose,
): string {
  const lines: string[] = [];
  const spanSeconds = Math.max(0, Math.round((window.until - window.since) / 1000));
  lines.push(`Visual observation window: last ${spanSeconds}s (purpose: ${purpose}).`);

  if (state.foregroundWindow) {
    lines.push(`Foreground window now: "${state.foregroundWindow.title}" (${state.foregroundWindow.processName}).`);
  }

  if (samples.length === 0) {
    lines.push("No visual changes were observed in this window.");
    return lines.join("\n");
  }

  lines.push("Observed changes (oldest first):");
  for (const sample of samples) {
    const marker = sample.frame ? " [image attached]" : "";
    lines.push(`- ${relativeLabel(sample.atMs, now)} [${sample.attention}] ${sample.summary}${marker}`);
  }
  return lines.join("\n");
}
