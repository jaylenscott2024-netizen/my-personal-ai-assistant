# Jarvis — Project Requirements

## What this is

Jarvis is a personal AI assistant platform: a backend-first system
intended to grow into a digital employee that can hold conversations,
remember context, execute multi-step tasks, control tools (browser,
filesystem, business integrations), and eventually operate voice and
computer-control interfaces — all under an explicit permission and
approval model, and independent of any single AI model provider.

This is **not** a wrapper around one chat API. The backend is the
authoritative system: it owns conversation state, memory, tool execution,
permissions, and task orchestration, so that any number of frontends
(desktop, web, voice-only, CLI) can sit on top of it without duplicating
logic.

It is a clean-room build. Despite sharing the "Jarvis" name (chosen for
the user-facing assistant identity — see Section 12 of the original
build spec), it does not import, depend on, or migrate anything from an
unrelated, earlier "JARVIS" project the user previously had.

## Product requirements

1. **Multi-provider AI** — Claude, OpenAI, and Gemini today, with a
   provider interface designed to add local/self-hosted models later
   without touching the agent orchestrator.
2. **Persistent memory** — user preferences, project context, task
   history, and general facts, retrievable by relevance rather than
   dumped wholesale into every prompt, and fully user-controllable
   (create/read/update/delete/disable).
3. **Tool-using agent** — a real multi-step tool-calling loop (not
   single-shot chat) with planning, observation, and failure recovery,
   bounded so it can never run away (max steps/time/tool-calls).
4. **Permissioned execution** — every tool declares the permissions it
   needs; the agent cannot exceed what the calling user's role grants;
   consequential actions pause for explicit human approval.
5. **Task engine** — trackable, resumable, cancellable multi-step work
   with an explicit state machine, independent of whether it was
   triggered by a chat message or a schedule.
6. **Realtime voice as a first-class subsystem** — a genuine speech-to-
   speech conversation loop (mic in → VAD → STT → streaming agent →
   sentence-chunked streaming TTS → audio out, with real barge-in), a
   first-class ElevenLabs provider resolved through the same encrypted
   credential store as every other integration, and activation (wake
   word / clap / push-to-talk) that's independent of both the AI model
   and the voice provider, with the client always choosing the mode
   explicitly and never silently always-on. See VOICE.md.
7. **Cross-platform computer control** — discovery-backed (never
   hard-coded) application launch/close, window management, real desktop
   file operations, keyboard/mouse input, screenshots, and an
   allowlisted command runner, each tagged with the exact LOW/MEDIUM/
   HIGH/CRITICAL risk tier that determines whether it needs approval.
   See COMPUTER_CONTROL.md.
8. **Real integrations, honestly scoped** — GitHub, Shopify, email,
   Google Calendar, and Twilio voice calling are implemented against
   their real APIs; anything not configured reports that plainly rather
   than faking success.
9. **Security by default** — least-privilege permissions, encrypted
   credential storage, audit logging, allowlisted command execution, and
   explicit trust boundaries between system instructions, user
   instructions, and external content (prompt-injection defense).
10. **Observability and operability** — structured logs, health checks,
    an activity/event stream, streaming API transports (SSE + WebSocket),
    and a deployment path that isn't tied to one cloud provider.

## Explicit non-goals (for this iteration)

These are architected for — real interfaces, config validation, and
honest "not configured" errors exist — but not fully implemented, per the
project's own "graceful partial implementation" directive rather than
building fake versions of them. See VOICE.md and COMPUTER_CONTROL.md for
the detailed, per-feature breakdown of exactly what's verified versus not:

- **Windows/macOS computer control, and any keyboard/mouse/screenshot
  automation** — the code is real and standard for each platform, but
  this development environment is a headless Linux container: no
  Windows/macOS host to run the Windows/macOS code paths against, and no
  display server for keyboard/mouse/screenshot on any platform. Linux
  application discovery, launch, close, and all file operations *are*
  verified here against real system calls.
- **A Windows native mouse-click shim** — cursor positioning works;
  the click event itself needs a small P/Invoke addition not included
  (documented in COMPUTER_CONTROL.md).
- **Browser OAuth consent flows** (Google, Microsoft) — Calendar
  integration uses a pre-obtained refresh token instead of a built-in
  OAuth redirect/consent UI.
- **Wake-word DSP** — the backend accepts wake-word *events* from a
  client/edge detector (Section 87: activation is decoupled from the AI
  model); it does not itself run wake-word audio models. Clap detection,
  by contrast, is fully implemented server-side (real signal processing
  over PCM audio) and drives real activation gating.
- **A Tauri/Electron desktop shell** — this repository is backend-only;
  computer-control tools act on whichever machine runs the backend
  process itself. See ARCHITECTURE.md's "Computer control" section for
  why this is a deliberate choice, not a placeholder.
- **Full plugin sandboxing** — the plugin loader dynamically imports local
  ES modules; it does not yet sandbox/containerize third-party code
  (Section 69 flags this as a requirement before running untrusted code).

## Success criteria

A request like *"check my Shopify store and tell me why checkout isn't
working"* should be able to flow, end to end, through: intent handling →
memory retrieval → planning → tool selection → permission check → tool
execution (Shopify + browser) → observation → analysis → a final answer —
pausing for approval if it needs to change anything. That loop is real and
tested today with the mock provider and the filesystem/calculator tools;
wiring in a paid model API key and Shopify credentials is the only step
between that and doing it against a live store.
