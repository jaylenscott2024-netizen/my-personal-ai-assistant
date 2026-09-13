// Real, working voice-activity-detection/utterance-segmentation over raw
// PCM16 mono audio. This is what turns a continuous microphone stream
// into discrete utterances to send to speech-to-text, and what detects
// "the user started talking again" for barge-in — it is the same
// amplitude-envelope technique as activation/clapDetector.ts (rolling
// noise floor + per-frame RMS), tuned for sustained speech instead of
// sharp transients: speech must persist for several consecutive frames to
// count (rejects clicks/pops), and an utterance only ends after a real
// trailing silence (so natural pauses mid-sentence don't cut it off).
export interface VadConfig {
  sampleRate: number;
  frameMs: number;
  /** Energy must exceed noiseFloor * this multiplier to count as speech. */
  speechThresholdMultiplier: number;
  /** Consecutive speech frames required before we commit to "speech started". */
  minSpeechFramesToStart: number;
  /** Trailing silence duration that ends an utterance. */
  silenceMsToEnd: number;
  /** Utterances shorter than this (likely noise, not real speech) are discarded. */
  minUtteranceMs: number;
}

export const DEFAULT_VAD_CONFIG: VadConfig = {
  sampleRate: 16_000,
  frameMs: 20,
  speechThresholdMultiplier: 2.2,
  minSpeechFramesToStart: 3, // 60ms of sustained energy
  silenceMsToEnd: 700,
  minUtteranceMs: 250,
};

export type VadEvent =
  | { type: "speech_start" }
  | { type: "speech_end"; audio: Buffer; durationMs: number }
  | { type: "speech_discarded"; durationMs: number }; // too short to be real speech

export class UtteranceSegmenter {
  private config: VadConfig;
  private noiseFloor = 200;
  private consecutiveSpeechFrames = 0;
  private consecutiveSilenceMs = 0;
  private speaking = false;
  private frames: Buffer[] = [];

  constructor(config: Partial<VadConfig> = {}) {
    this.config = { ...DEFAULT_VAD_CONFIG, ...config };
  }

  updateConfig(config: Partial<VadConfig>): void {
    this.config = { ...this.config, ...config };
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** Forcibly ends the current utterance right now, regardless of
   *  trailing silence — used for push-to-talk (Section 11: activation
   *  mode is explicit), where releasing the button IS the end of the
   *  utterance rather than something to infer from silence. */
  forceEnd(): VadEvent | null {
    if (!this.speaking) return null;
    const audio = Buffer.concat(this.frames);
    const durationMs = (audio.length / 2 / this.config.sampleRate) * 1000;
    this.speaking = false;
    this.frames = [];
    this.consecutiveSpeechFrames = 0;
    this.consecutiveSilenceMs = 0;
    if (durationMs >= this.config.minUtteranceMs) {
      return { type: "speech_end", audio, durationMs };
    }
    return { type: "speech_discarded", durationMs };
  }

  reset(): void {
    this.consecutiveSpeechFrames = 0;
    this.consecutiveSilenceMs = 0;
    this.speaking = false;
    this.frames = [];
  }

  private frameRms(frame: Int16Array): number {
    let sumSquares = 0;
    for (let i = 0; i < frame.length; i++) sumSquares += frame[i] * frame[i];
    return Math.sqrt(sumSquares / frame.length);
  }

  /** Feed one chunk of PCM16 mono little-endian audio. May emit zero or
   *  more events — a single chunk can contain both a speech_end and (if
   *  the caller keeps streaming afterward) start of the next utterance. */
  process(pcm16: Buffer): VadEvent[] {
    const events: VadEvent[] = [];
    const samples = new Int16Array(pcm16.buffer, pcm16.byteOffset, Math.floor(pcm16.length / 2));
    const frameSize = Math.max(1, Math.floor((this.config.sampleRate * this.config.frameMs) / 1000));

    for (let offset = 0; offset + frameSize <= samples.length; offset += frameSize) {
      const frame = samples.subarray(offset, offset + frameSize);
      const energy = this.frameRms(frame);
      const frameBuffer = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);

      if (energy < this.noiseFloor * 1.2) {
        this.noiseFloor = this.noiseFloor * 0.98 + energy * 0.02;
      }

      const isSpeechFrame = energy > this.noiseFloor * this.config.speechThresholdMultiplier;

      if (isSpeechFrame) {
        this.consecutiveSpeechFrames++;
        this.consecutiveSilenceMs = 0;

        if (!this.speaking && this.consecutiveSpeechFrames >= this.config.minSpeechFramesToStart) {
          this.speaking = true;
          events.push({ type: "speech_start" });
        }
        if (this.speaking) this.frames.push(frameBuffer);
      } else {
        this.consecutiveSpeechFrames = 0;
        if (this.speaking) {
          this.frames.push(frameBuffer); // keep brief pauses inside the utterance
          this.consecutiveSilenceMs += this.config.frameMs;

          if (this.consecutiveSilenceMs >= this.config.silenceMsToEnd) {
            const audio = Buffer.concat(this.frames);
            const durationMs = (audio.length / 2 / this.config.sampleRate) * 1000;
            if (durationMs >= this.config.minUtteranceMs) {
              events.push({ type: "speech_end", audio, durationMs });
            } else {
              events.push({ type: "speech_discarded", durationMs });
            }
            this.speaking = false;
            this.frames = [];
          }
        }
      }
    }

    return events;
  }
}

// Section 28: providers' STT endpoints expect a real audio file, not raw
// PCM — wrapping in a minimal 44-byte WAV header is enough for every
// provider used here (ElevenLabs, OpenAI Whisper both accept WAV).
export function pcm16ToWav(pcm16: Buffer, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm16.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm16.length, 40);

  return Buffer.concat([header, pcm16]);
}
