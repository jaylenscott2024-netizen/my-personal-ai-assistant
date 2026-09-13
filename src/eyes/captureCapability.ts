// Section: measured capture capability — "maximum sustainable local
// desktop capture performance supported by the user's actual computer."
//
// Why this file exists at all: the sustainable capture rate is a property
// of a specific machine at a specific moment (GPU, driver, display mode,
// what else is running, whether this is a remote session), and none of it
// is knowable up front. So Jarvis does not ask the user to type an FPS
// number and does not assume one. It measures the real pipeline and
// adapts.
//
// Three things this deliberately does NOT do:
//
//  1. It does not treat the monitor's refresh rate as proof of capture
//     capability. A 240Hz panel says nothing about whether this machine
//     can acquire, copy, encode and hand over 240 frames a second.
//  2. It does not assume GPU spec sheets equal capture throughput.
//  3. It does not pick a round number. If a machine sustains 83 fps, the
//     answer is 83 — not 60 because 60 is familiar.
//
// THE IDLE-DESKTOP TRAP (the subtle part). A native capture source like
// DXGI Desktop Duplication is change-driven: when the desktop is static
// it produces NO frames at all and AcquireNextFrame simply times out.
// Naively measuring "frames per second delivered" would therefore read a
// motionless desktop as "this machine can only do 0.2 fps" and ratchet
// the target down to nothing — and then, because the target is now tiny,
// it would never discover the machine's real capability once motion
// resumed. So a measurement window is only allowed to *lower* the
// estimate when the display was actually producing work to keep up with.
// Idle windows are inconclusive: they hold the estimate rather than
// moving it. This distinction is the difference between a capability
// measurement and a content measurement.

/** One measurement window's worth of raw counters from the capture loop. */
export interface CaptureWindowStats {
  /** Frames actually acquired and handed onward during the window. */
  framesDelivered: number;
  /** Acquire attempts that timed out because the desktop produced nothing
   *  new. High values mean an idle display, NOT a slow pipeline. */
  idleTimeouts: number;
  /** Frames the pipeline had available but discarded (queue full, still
   *  busy encoding the previous one). This is the real "couldn't keep up"
   *  signal. */
  framesDropped: number;
  /** Wall-clock length of the window. */
  windowMs: number;
  /** Mean time from a frame becoming available to it being handed onward.
   *  Null when the window delivered nothing to measure. */
  meanFrameLatencyMs: number | null;
}

export type CaptureWindowVerdict =
  /** The display produced enough work to judge, and the pipeline kept up. */
  | "sustained"
  /** The display produced work and the pipeline fell behind. */
  | "overloaded"
  /** Not enough happened on screen to tell — hold the current estimate. */
  | "inconclusive";

export interface CaptureCapabilityLimits {
  /** Lowest rate the controller will ever settle on. */
  minFps: number;
  /** Sanity ceiling. Deliberately far above any display anyone currently
   *  ships, because its job is to stop a runaway probe, not to express a
   *  product opinion about how fast Eyes are allowed to be. */
  maxFps: number;
  /** Where probing starts before anything has been measured. */
  startFps: number;
  /** Fraction of the target that must actually be achieved for a window
   *  to count as sustained. */
  sustainRatio: number;
  /** Drop fraction above which a window counts as overloaded regardless
   *  of achieved rate. */
  maxDropRatio: number;
  /** Consecutive sustained windows required before probing higher. Stops
   *  a single lucky window from ratcheting the target up. */
  windowsBeforeRaise: number;
  /** Multiplier applied when probing upward. */
  raiseFactor: number;
  /** Floor multiplier applied when backing off, relative to what the
   *  pipeline actually achieved. */
  backoffFactor: number;
}

export const DEFAULT_CAPTURE_CAPABILITY_LIMITS: CaptureCapabilityLimits = {
  minFps: 1,
  maxFps: 480,
  startFps: 30,
  sustainRatio: 0.85,
  maxDropRatio: 0.1,
  windowsBeforeRaise: 3,
  raiseFactor: 1.25,
  backoffFactor: 0.9,
};

export interface CaptureCapabilityReport {
  /** The rate currently being requested of the capture source. */
  targetFps: number;
  /** Highest rate this machine has actually proven it can sustain. Null
   *  until at least one conclusive window has been observed — and
   *  reported as null rather than guessed, so callers can tell
   *  "measured" apart from "not yet measured". */
  sustainedFps: number | null;
  /** Rate achieved in the most recent window, whatever its verdict. */
  lastAchievedFps: number;
  lastVerdict: CaptureWindowVerdict;
  /** Windows observed, and how many were conclusive. A report built
   *  entirely from inconclusive windows is not a measurement. */
  windowsObserved: number;
  conclusiveWindows: number;
  meanFrameLatencyMs: number | null;
  totalFramesDelivered: number;
  totalFramesDropped: number;
  /** True once the estimate has stopped moving across conclusive windows
   *  — i.e. the probe has found this machine's ceiling. */
  converged: boolean;
}

/**
 * Closed-loop controller that discovers the highest capture rate a
 * machine can actually sustain, by probing upward while the pipeline
 * keeps up and backing off to the observed rate when it doesn't.
 *
 * Intentionally operates on counters rather than on frames themselves, so
 * it is platform-neutral and fully testable without a display.
 */
export class CaptureCapabilityEstimator {
  private readonly limits: CaptureCapabilityLimits;
  private target: number;
  private sustained: number | null = null;
  private consecutiveSustained = 0;
  private windows = 0;
  private conclusive = 0;
  private lastAchieved = 0;
  private lastVerdict: CaptureWindowVerdict = "inconclusive";
  private latencySum = 0;
  private latencySamples = 0;
  private deliveredTotal = 0;
  private droppedTotal = 0;
  private raisedSinceLastBackoff = false;
  private ceilingFound = false;

  constructor(limits: Partial<CaptureCapabilityLimits> = {}) {
    this.limits = { ...DEFAULT_CAPTURE_CAPABILITY_LIMITS, ...limits };
    this.target = clamp(this.limits.startFps, this.limits.minFps, this.limits.maxFps);
  }

  get targetFps(): number {
    return this.target;
  }

  /**
   * Classify one window without mutating anything — exposed because the
   * idle-vs-overloaded distinction is the single most important rule here
   * and deserves to be directly assertable in tests.
   */
  classify(stats: CaptureWindowStats): CaptureWindowVerdict {
    const seconds = stats.windowMs / 1000;
    if (seconds <= 0) return "inconclusive";

    const achieved = stats.framesDelivered / seconds;
    const offered = stats.framesDelivered + stats.framesDropped;
    const dropRatio = offered > 0 ? stats.framesDropped / offered : 0;

    // Dropping frames means the source had work we couldn't take. That is
    // conclusive evidence of overload no matter what the achieved rate
    // looks like.
    if (dropRatio > this.limits.maxDropRatio) return "overloaded";

    // Did the display actually offer enough work to judge the target? If
    // the desktop was mostly static (lots of idle timeouts, few frames
    // offered), a low achieved rate says nothing about capability.
    if (achieved >= this.target * this.limits.sustainRatio) return "sustained";

    // Under target with no drops: either the pipeline is struggling, or
    // the desktop simply had nothing to show. Idle timeouts tell them
    // apart — a source that is timing out is waiting on the display, not
    // falling behind it.
    if (stats.idleTimeouts > 0) return "inconclusive";

    return "overloaded";
  }

  /** Feed one measurement window and get the updated target rate. */
  record(stats: CaptureWindowStats): number {
    this.windows++;
    this.deliveredTotal += stats.framesDelivered;
    this.droppedTotal += stats.framesDropped;
    if (stats.meanFrameLatencyMs !== null && stats.framesDelivered > 0) {
      this.latencySum += stats.meanFrameLatencyMs * stats.framesDelivered;
      this.latencySamples += stats.framesDelivered;
    }

    const seconds = stats.windowMs / 1000;
    this.lastAchieved = seconds > 0 ? stats.framesDelivered / seconds : 0;

    const verdict = this.classify(stats);
    this.lastVerdict = verdict;

    if (verdict === "inconclusive") {
      // Hold. An idle desktop must never drag the estimate down, and must
      // never be mistaken for proof that a higher rate is reachable
      // either — so the sustained streak does not advance.
      return this.target;
    }

    this.conclusive++;

    if (verdict === "sustained") {
      this.sustained = Math.max(this.sustained ?? 0, this.lastAchieved);
      this.consecutiveSustained++;
      if (this.consecutiveSustained >= this.limits.windowsBeforeRaise && !this.ceilingFound) {
        this.consecutiveSustained = 0;
        const raised = clamp(this.target * this.limits.raiseFactor, this.limits.minFps, this.limits.maxFps);
        if (raised > this.target) {
          this.target = raised;
          this.raisedSinceLastBackoff = true;
        }
      }
      return this.target;
    }

    // Overloaded: settle at what the machine actually managed rather than
    // at the rate we wrongly asked for. Using the achieved rate (not a
    // fixed step down) is what lets this land on an honest 83 instead of
    // rounding to a familiar number.
    this.consecutiveSustained = 0;
    const backedOff = clamp(
      Math.max(this.lastAchieved, this.limits.minFps) * this.limits.backoffFactor,
      this.limits.minFps,
      this.limits.maxFps,
    );
    if (backedOff < this.target) this.target = backedOff;
    // Backing off after a successful probe means the probe overshot: we
    // have bracketed this machine's ceiling and should stop climbing.
    if (this.raisedSinceLastBackoff) this.ceilingFound = true;
    this.raisedSinceLastBackoff = false;
    if (this.sustained === null || this.target < this.sustained) this.sustained = this.target;
    return this.target;
  }

  report(): CaptureCapabilityReport {
    return {
      targetFps: round1(this.target),
      sustainedFps: this.sustained === null ? null : round1(this.sustained),
      lastAchievedFps: round1(this.lastAchieved),
      lastVerdict: this.lastVerdict,
      windowsObserved: this.windows,
      conclusiveWindows: this.conclusive,
      meanFrameLatencyMs: this.latencySamples > 0 ? round1(this.latencySum / this.latencySamples) : null,
      totalFramesDelivered: this.deliveredTotal,
      totalFramesDropped: this.droppedTotal,
      converged: this.ceilingFound,
    };
  }

  reset(): void {
    this.target = clamp(this.limits.startFps, this.limits.minFps, this.limits.maxFps);
    this.sustained = null;
    this.consecutiveSustained = 0;
    this.windows = 0;
    this.conclusive = 0;
    this.lastAchieved = 0;
    this.lastVerdict = "inconclusive";
    this.latencySum = 0;
    this.latencySamples = 0;
    this.deliveredTotal = 0;
    this.droppedTotal = 0;
    this.raisedSinceLastBackoff = false;
    this.ceilingFound = false;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
