# Voice & Realtime Speech-to-Speech

## What this is

Jarvis has three explicit, manually-selected voice modes — never inferred
from message content, never switched automatically. This document
explains how each actually works, what's real and tested versus what
needs a live microphone/speaker/API key to fully verify, and how to
configure them.

| Mode | Selected via | What actually happens |
|---|---|---|
| `speech_to_speech` | `?mode=speech_to_speech` on `/ws/voice` | **Native** audio-to-audio over one live session with a realtime-capable model (voice/realtime/). No `VoiceProvider` (no STT, no TTS) is called anywhere in this path. |
| `stt` | `?mode=stt` | Microphone audio in, transcript + the agent's **text** reply out. `synthesizeStream` is never called — no audio is ever produced. |
| `tts` | `?mode=tts` | Typed text in (a `user_text` control message), synthesized speech out. No microphone audio is accepted — binary frames are rejected outright. |
| *(no `mode` given)* | omit `mode` | The original relay pipeline below, unchanged, for backward compatibility with clients written before mode selection existed. |

## Native speech_to_speech: real audio-to-audio

```
Mic audio (raw PCM, provider's own sample rate)
   │  binary WebSocket frames → /ws/voice?mode=speech_to_speech
   ▼
NativeRealtimeSession (voice/realtime/nativeRealtimeSession.ts)
   ▼
RealtimeAudioProvider (voice/realtime/realtimeAudioProvider.ts)
   │  currently: OpenAIRealtimeProvider — OpenAI's Realtime API over
   │  WebSocket. The model itself hears the microphone audio and produces
   │  generated speech; there is no transcription step in between.
   ▼
Audio out (raw PCM) → binary WebSocket frames back to the client
```

The provider's own server-side VAD reports `speech_started` the instant
it hears the user talking, which triggers immediate barge-in
(`session.interrupt()` sent to the provider) — not a queued "let me
finish this sentence first." Tool calls the model makes over the audio
channel run through `agent/orchestrator.ts`'s `executeToolCall`, the
exact same permission/approval/audit path the text agent uses (a
"member" role's tool call is denied here exactly as it would be from
text — see `tests/voice.nativeRealtimeSession.test.ts`).

**The one rule this path never breaks**: `RealtimeAudioProvider.connect()`
throws rather than silently falling back to the STT/LLM/TTS relay when a
provider doesn't actually support native audio-to-audio
(`getCapabilities().nativeSpeechToSpeech`). A caller that asked for
native realtime either gets it or gets told clearly why not.

**Verification status: IMPLEMENTED BUT NOT LIVE-VERIFIED.** The OpenAI
Realtime adapter was written without a live session — no `OPENAI_API_KEY`
is configured here, and this environment's egress proxy blocks the
primary protocol references (`developers.openai.com`,
`learn.microsoft.com`), so the message shapes come from secondary
sources. The GA event names changed from the beta ones in ways sources
disagree on (`response.audio.delta` vs `response.output_audio.delta`,
flat vs nested `session.audio` config); the receive path accepts both
spellings rather than betting the feature on one guess, so a naming
mismatch degrades to dead code instead of silence. What still needs a
real key to confirm: the handshake is accepted, audio flows both
directions, measured latency, and tool calls round-trip.

## stt / tts: explicit, single-direction modes

These reuse `RealtimeVoiceSession` (the pre-existing relay class) with
one side of it deliberately not wired up:

- **`stt`**: `speakReplies: false` — `speak()` returns immediately without
  ever calling the voice provider's `synthesizeStream`. The transcript and
  the agent's text reply still reach the caller via `onTranscript`/
  `onAssistantText`; no audio chunk is ever emitted. Proven in
  `tests/voice.realtimeSession.test.ts` by asserting
  `fakeVoice.synthesizeCalls` stays empty, not just that no chunks showed
  up on the wire.
- **`tts`**: the route never calls `session.feedAudio()` for this mode —
  instead a `{"type":"user_text","text":"..."}` control message reaches
  `session.respondToText()`, which runs the exact same agent-then-speak
  path `respondTo()` always used, with no STT provider ever invoked. A
  test asserts `onTranscript` throwing (i.e. STT running at all) would
  fail the test.

## The relay pipeline (default when `mode` is omitted)

```
Mic audio (PCM16 mono, 16kHz)
   │  binary WebSocket frames → /ws/voice
   ▼
ActivationGate (voice/activationGate.ts)          — is Jarvis listening right now?
   │  push-to-talk: always open
   │  wake word / clap: closed until triggered, re-arms after each turn
   ▼
UtteranceSegmenter (voice/vad.ts)                  — real amplitude-envelope VAD
   │  sustained-energy onset → speech_start
   │  trailing silence → speech_end (or forceEnd() for PTT release)
   ▼
STT (voice/voiceRegistry.ts → ElevenLabs/OpenAI Whisper)
   ▼
Agent orchestrator, streaming mode (agent/orchestrator.ts, stream: true)
   │  emits "message.delta" events as the model generates text
   ▼
Sentence-chunked streaming TTS (voice/realtimeSession.ts)
   │  each completed sentence starts playing while later ones are
   │  still being generated
   ▼
Audio out (MP3 chunks) → binary WebSocket frames back to the client
```

Being precise about what this pipeline actually is, per the project's own
"no fake features" rule: turn-based, utterance-segmented streaming, not
literal continuous token-to-audio synthesis the way the native
`speech_to_speech` mode above is. Speech-to-text runs once per detected
utterance (not word-by-word); the agent's text response streams
token-by-token; text-to-speech starts on each *sentence* as soon as it's
complete, so playback begins well before the whole reply exists. This
remains available (and is still what a connection gets by default) for
compatibility and because it's a genuinely different tradeoff from native
audio-to-audio: it keeps this project's own permission-gated, tool-using
orchestrator fully in the loop rather than handing the conversation to an
end-to-end voice product, at the cost of not being literally continuous
audio.

## Barge-in (interruption)

Real cancellation, not a UI affordance:

- The VAD continuously watches for the user talking, even while Jarvis
  is speaking or "thinking" (waiting on the model).
- Detecting that stops the in-flight TTS stream (`AbortController`) and
  the in-flight agent run (`tasks/taskService.ts`'s `abortById`, via the
  orchestrator's `onAgentRunCreated` hook — needed because a run's id
  isn't otherwise available until the whole turn completes).
- A generation counter (`RealtimeVoiceSession.responseGeneration`) makes
  sure an already-interrupted response's queued sentences can't keep
  speaking after the interrupt — verified in
  `tests/voice.realtimeSession.test.ts`.
- The client can also send an explicit `{"type":"interrupt"}` text
  message to stop Jarvis mid-sentence (a "stop talking" button).

## Activation modes

Configured per user (`PATCH /settings/activation`), persisted in
`UserSettings`, never silently defaulting to "always listening":

| Mode | Behavior |
|---|---|
| `push_to_talk` (default) | Every audio frame reaches the session immediately. Client controls timing — start/stop sending audio, or send `{"type":"end_utterance"}` on button release. |
| `wake_word` | Audio is discarded until the client/edge wake-word detector reports a match via `{"type":"wake_word_detected","phrase":"..."}`. This backend does not run wake-word DSP itself (Section 87: activation is independent of the AI model) — it validates the phrase and enabled flag, then opens the gate. Re-closes after each completed turn. |
| `clap` | Audio is fed to a real amplitude-envelope clap detector (`activation/clapDetector.ts`) until a configured pattern (single/double/triple) is recognized. Re-closes after each completed turn. |
| `disabled` | No trigger source exists; audio is never processed. |

## Configuring ElevenLabs

```
PATCH /settings/voice
{ "voiceProvider": "elevenlabs", "voiceId": "<id from GET /voice/providers/elevenlabs/voices>", "voiceModel": "eleven_flash_v2_5" }
```

The API key resolves through the same encrypted, user-scoped credential
store every integration uses (`security/credentials.ts`) — configure it
via `POST /integrations/credentials {"provider":"elevenlabs","secret":"..."}`
rather than only the `ELEVENLABS_API_KEY` env var. It is never returned by
any API response, logged, or exposed to the model.

### Expressive delivery controls

`SynthesisOptions.voiceSettings` (`voice/types.ts`) passes through to
ElevenLabs' own real, documented `voice_settings` request field —
`stability`, `similarityBoost`, `style`, `useSpeakerBoost`, `speed`. All
optional and additive: omitting them leaves a request exactly as it
always was. Nothing here is invented — every field is a genuine
ElevenLabs API parameter (`tests/voice.elevenLabsVoiceSettings.test.ts`
proves the mapping onto ElevenLabs' snake_case names).

What's deliberately **not** implemented: Jarvis does not currently
classify a reply's tone and automatically pick `stability`/`style` values
per utterance. That would need the agent to decide "this should sound
urgent" or "this should sound calm" and thread that decision through the
voice pipeline — a real feature, but a separate one from wiring the
provider parameters themselves, and not built here. A caller (a future
orchestrator hook, or a client) can already pass `voiceSettings`
explicitly; nothing automatically drives it yet.

### Configuring native speech_to_speech

```
PATCH /settings/voice
{ "realtimeVoiceProvider": "openai-realtime", "realtimeVoiceModel": "gpt-realtime", "realtimeVoiceToolsEnabled": true }
```

`realtimeVoiceToolsEnabled` defaults to `false` — a native voice session
cannot take any real action until explicitly opted in, since a session
that can call tools is a materially different risk surface from one that
can only talk. The OpenAI Realtime API key resolves through the same
credential store as every other OpenAI usage (`OPENAI_API_KEY` or a saved
`openai` credential).

## What's real and tested vs. what needs a live environment to verify

**Real and tested (no network/hardware needed):**
- VAD segmentation logic — sustained-onset detection, trailing-silence
  endpointing, short-noise rejection, push-to-talk force-end
  (`tests/voice.vad.test.ts`).
- The full utterance → STT → agent → streaming TTS relay pipeline, with
  deterministic fake STT/TTS providers standing in for ElevenLabs/OpenAI
  (`tests/voice.realtimeSession.test.ts`), including the `stt`-mode
  variant (`speakReplies: false`, proving synthesis is never called) and
  the `tts`-mode variant (`respondToText()`, proving STT is never called).
- Barge-in genuinely stopping audio mid-stream and cancelling the
  in-flight agent run (same file).
- The native `speech_to_speech` session's audio passthrough, barge-in on
  provider-side VAD, transcript surfacing, and — the important one — tool
  calls actually running through the real permission/approval path
  (`tests/voice.nativeRealtimeSession.test.ts`, using a fake
  `RealtimeAudioProvider`/`RealtimeAudioSession` rather than a live
  OpenAI connection).
- The load-bearing honesty check that connecting with `speech_to_speech`
  against a provider lacking `nativeSpeechToSpeech` throws rather than
  silently falling back to the relay (same file).
- Activation gating state machine (`tests/voice.activationGate.test.ts`).
- Credential resolution preferring the user-scoped store over env
  (`tests/voice.credentialResolution.test.ts`).
- ElevenLabs' streaming TTS HTTP request shape, buffered TTS, STT request
  shape, and the `voiceSettings` mapping (code-reviewed against
  ElevenLabs' documented API and unit-tested against a mocked HTTP layer;
  not executed against the real API in this environment since no API key
  is configured here).

**Needs a live microphone/speaker/network to fully verify end-to-end:**
- Actually talking to Jarvis through a browser or app's microphone —
  this sandbox has no audio input device.
- A live ElevenLabs API key's actual latency/audio quality.
- A live OpenAI Realtime API session: the handshake, bidirectional audio,
  measured latency, and tool-call round-tripping for `speech_to_speech` —
  see the verification note above. No `OPENAI_API_KEY` and no network
  access to a live session were available while building this.
- Real-world VAD threshold tuning against real room noise (the default
  thresholds are reasonable starting points, not acoustically validated
  against a physical microphone).

## Known gaps

- **Wake-word detection model**: not implemented server-side by design
  (Section 87). A client (desktop app, browser extension) needs its own
  lightweight wake-word model (e.g. Porcupine, a small on-device model)
  and reports matches to this backend.
- **STT is per-utterance, not streaming** in the relay/`stt` modes:
  ElevenLabs/OpenAI's STT endpoints used here are batch (send complete
  audio, get complete text) — genuinely fast because utterances are
  short, but not word-by-word live transcription. `speech_to_speech`
  doesn't have this limitation since the realtime model hears audio
  directly; a provider with a true streaming STT websocket API could
  likewise replace this without touching the rest of the relay pipeline
  (`VoiceProvider.transcribe` is the seam).
- **No automatic tone-to-delivery mapping**: see "Expressive delivery
  controls" above — the plumbing exists, nothing drives it yet.
- **Only one native realtime provider**: Anthropic and Gemini have no
  adapter in `voice/realtime/` because neither exposes a documented native
  speech-to-speech transport in this codebase's integration surface as of
  writing. Adding one means a new `RealtimeAudioProvider` implementation,
  not a change to `NativeRealtimeSession` or the WS route.
