# Voice & Realtime Speech-to-Speech

## What this is

Jarvis supports genuine two-way voice conversation, not record-then-wait
transcription. This document explains how it actually works, what's real
and tested versus what needs a live microphone/speaker to fully verify,
and how to configure it.

## Architecture

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

## Why "sentence-chunked streaming," not literal continuous audio

Being precise about what "realtime" means here, per the project's own
"no fake features" rule: this is turn-based, utterance-segmented
streaming. Jarvis doesn't produce continuous token-to-audio synthesis the
way a single end-to-end speech model would. Instead:

- Speech-to-text runs once per detected utterance (not word-by-word).
- The agent's text response streams token-by-token.
- Text-to-speech starts on each *sentence* as soon as it's complete in
  the streamed text, so playback begins well before the whole reply
  exists — this is what makes it feel responsive rather than "wait for
  the full answer, then wait again for audio."

ElevenLabs' own "Conversational AI" product does offer true end-to-end
speech-to-speech, but adopting it would mean handing the entire
conversation loop — including tool use — to ElevenLabs instead of this
project's own permission-gated, tool-using orchestrator. That would
defeat the point of everything else in this backend (approvals, memory,
computer control, business integrations), so it isn't used here. The
sentence-chunked approach is the standard, honest way to get "starts
talking before it's finished thinking" without giving that up.

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

## What's real and tested vs. what needs a live environment to verify

**Real and tested (no network/hardware needed):**
- VAD segmentation logic — sustained-onset detection, trailing-silence
  endpointing, short-noise rejection, push-to-talk force-end
  (`tests/voice.vad.test.ts`).
- The full utterance → STT → agent → streaming TTS pipeline, with
  deterministic fake STT/TTS providers standing in for ElevenLabs/OpenAI
  (`tests/voice.realtimeSession.test.ts`).
- Barge-in genuinely stopping audio mid-stream and cancelling the
  in-flight agent run (same file).
- Activation gating state machine (`tests/voice.activationGate.test.ts`).
- Credential resolution preferring the user-scoped store over env
  (`tests/voice.credentialResolution.test.ts`).
- ElevenLabs' streaming TTS HTTP request shape, buffered TTS, and STT
  request shape (code-reviewed against ElevenLabs' documented API; not
  executed against the real API in this environment since no API key is
  configured here).

**Needs a live microphone/speaker/network to fully verify end-to-end:**
- Actually talking to Jarvis through a browser or app's microphone —
  this sandbox has no audio input device.
- A live ElevenLabs API key's actual latency/audio quality.
- Real-world VAD threshold tuning against real room noise (the default
  thresholds are reasonable starting points, not acoustically validated
  against a physical microphone).

## Known gaps

- **Wake-word detection model**: not implemented server-side by design
  (Section 87). A client (desktop app, browser extension) needs its own
  lightweight wake-word model (e.g. Porcupine, a small on-device model)
  and reports matches to this backend.
- **STT is per-utterance, not streaming**: ElevenLabs/OpenAI's STT
  endpoints used here are batch (send complete audio, get complete
  text) — genuinely fast because utterances are short, but not
  word-by-word live transcription. A provider with a true streaming STT
  websocket API could replace this without touching the rest of the
  pipeline (`VoiceProvider.transcribe` is the seam).
