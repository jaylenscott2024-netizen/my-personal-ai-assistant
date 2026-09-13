# Voltic Lane AI — Project Requirements

## What this is

Voltic Lane AI is a personal AI assistant platform: a backend-first system
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

It is a clean-room build. It does not import, depend on, or migrate
anything from a prior "JARVIS" project.

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
6. **Voice as a first-class subsystem** — STT/TTS/speech-to-speech
   interfaces independent of both the AI model and the activation
   mechanism (wake word / clap detection), with the client always
   choosing the mode explicitly.
7. **Real integrations, honestly scoped** — GitHub, Shopify, email,
   Google Calendar, and Twilio voice calling are implemented against
   their real APIs; anything not configured reports that plainly rather
   than faking success.
8. **Security by default** — least-privilege permissions, encrypted
   credential storage, audit logging, and explicit trust boundaries
   between system instructions, user instructions, and external content
   (prompt-injection defense).
9. **Observability and operability** — structured logs, health checks,
   an activity/event stream, and a deployment path that isn't tied to one
   cloud provider.

## Explicit non-goals (for this iteration)

These are architected for — real interfaces, config validation, and
honest "not configured" errors exist — but not fully implemented, per the
project's own "graceful partial implementation" directive rather than
building fake versions of them:

- **Computer control** (keyboard/mouse/window automation on the host) —
  a real implementation needs a sandboxed execution target (a VM or
  dedicated device) that this environment doesn't have; only the
  permission (`computer.control`) and architectural slot exist.
- **Browser OAuth consent flows** (Google, Microsoft) — Calendar
  integration uses a pre-obtained refresh token instead of a built-in
  OAuth redirect/consent UI.
- **Wake-word DSP** — the backend accepts wake-word *events* from a
  client/edge detector (Section 87: activation is decoupled from the AI
  model); it does not itself run wake-word audio models. Clap detection,
  by contrast, is fully implemented server-side (real signal processing
  over PCM audio).
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
