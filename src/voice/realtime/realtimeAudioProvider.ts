// Section: NATIVE realtime speech-to-speech — the provider-neutral seam.
//
// The distinction this file exists to enforce, and which the rest of
// Jarvis depends on being told the truth about:
//
//   NATIVE SPEECH-TO-SPEECH   microphone audio goes to the model, and the
//                             model returns audio. The model hears tone,
//                             pacing, hesitation and emphasis, and speaks
//                             with them. Nothing is transcribed in the
//                             middle.
//
//   STT -> LLM -> TTS         audio is flattened to text, a text model
//                             answers, and a separate voice reads the
//                             answer out. Everything not in the words is
//                             discarded, and latency is the sum of three
//                             round trips.
//
// The second is a legitimate mode and Jarvis keeps it (see
// voice/realtimeSession.ts, which is exactly that pipeline and is what the
// explicit Speech-to-Text mode uses). What it must never do is masquerade
// as the first. A provider that cannot do native audio-to-audio declares
// `nativeSpeechToSpeech: false` and the speech-to-speech mode refuses to
// start on it — it does NOT quietly substitute the transcription pipeline
// and call itself realtime.

/** What a provider's realtime audio API can actually do. Every field is a
 *  claim about a real API, never an aspiration. */
export interface RealtimeAudioCapabilities {
  /** THE load-bearing flag. True only when the provider accepts raw
   *  microphone audio and returns generated audio over one live session,
   *  with no transcription step in between. */
  nativeSpeechToSpeech: boolean;
  /** Whether the provider detects turn boundaries itself, so Jarvis does
   *  not have to endpoint speech locally. */
  serverSideVad: boolean;
  /** Whether the model can be interrupted mid-utterance and will stop
   *  generating — what makes barge-in feel immediate rather than queued. */
  interruptible: boolean;
  /** Whether tools/functions can be called from inside the audio session.
   *  False means a voice conversation on this provider cannot take
   *  actions, only talk. */
  toolCalling: boolean;
  /** Whether the session can also emit a text transcript alongside audio
   *  (useful for the conversation log; not required for the audio path). */
  transcripts: boolean;
  /** PCM sample rate the provider expects for microphone audio. */
  inputSampleRate: number;
  /** PCM sample rate the provider emits. */
  outputSampleRate: number;
  /** Expressive delivery the provider actually exposes as controls. An
   *  empty array means the provider gives no explicit prosody knobs —
   *  which is NOT the same as flat delivery: a native speech-to-speech
   *  model generally varies tone and pacing from conversational context on
   *  its own. Listing only real, documented controls here keeps Jarvis
   *  from pretending to steer something it cannot. */
  expressiveControls: string[];
  /** Human-readable note about anything a caller should not assume. */
  detail?: string;
}

export interface RealtimeAudioSessionOptions {
  model: string;
  /** System instructions — the Jarvis identity, same source as the text
   *  path, so the assistant is recognizably itself in either mode. */
  instructions: string;
  /** Provider-specific voice identifier. */
  voice?: string;
  /** Tool definitions the model may call during the conversation. Passing
   *  none means a conversation-only session. */
  tools?: RealtimeToolDefinition[];
  userId: string;
}

export interface RealtimeToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Everything a live session can tell its owner. Deliberately an event
 *  union rather than callbacks-per-thing, so a transport can add events
 *  without every consumer changing shape. */
export type RealtimeAudioEvent =
  /** Generated audio to play, in the provider's output format. */
  | { type: "audio_delta"; audio: Buffer }
  /** The model finished an utterance. */
  | { type: "audio_done" }
  /** Provider-side VAD heard the user start talking. The cue for barge-in:
   *  stop playback immediately rather than waiting for a turn to end. */
  | { type: "speech_started" }
  | { type: "speech_stopped" }
  /** Running transcript of what the user said, when available. */
  | { type: "input_transcript"; text: string }
  /** Running transcript of what the model said, when available. */
  | { type: "output_transcript_delta"; text: string }
  /** The model wants to call a tool. The session owner is responsible for
   *  running it through the normal permission/approval path and replying
   *  with `submitToolResult`. */
  | { type: "tool_call"; callId: string; name: string; arguments: Record<string, unknown> }
  /** The model's turn ended (audio and tool calls complete). */
  | { type: "response_done" }
  | { type: "session_ready" }
  | { type: "error"; message: string; fatal: boolean }
  | { type: "closed"; reason: string };

export type RealtimeAudioListener = (event: RealtimeAudioEvent) => void;

/** One live audio conversation. */
export interface RealtimeAudioSession {
  readonly providerId: string;
  readonly isOpen: boolean;

  /** Push microphone audio. Must not block: implementations queue and
   *  return immediately, because the microphone cannot be asked to wait. */
  sendAudio(pcm16: Buffer): void;

  /** Tell the provider the user's turn is over. Only needed when server
   *  VAD is off (push-to-talk); with server VAD the provider decides. */
  commitInput(): void;

  /** Stop the model talking right now. Used for barge-in and for an
   *  explicit stop. */
  interrupt(): void;

  /** Hand back the result of a tool the model asked for. */
  submitToolResult(callId: string, result: unknown): void;

  subscribe(listener: RealtimeAudioListener): () => void;

  close(): Promise<void>;
}

export interface RealtimeAudioProvider {
  readonly id: string;
  getCapabilities(): RealtimeAudioCapabilities;
  /** True when this provider could actually open a session for this user
   *  right now (credential present). */
  isConfigured(userId?: string): Promise<boolean>;
  /** Opens a live session. Throws rather than degrading: a caller that
   *  asked for native speech-to-speech must never be silently handed
   *  something else. */
  connect(options: RealtimeAudioSessionOptions): Promise<RealtimeAudioSession>;
}
