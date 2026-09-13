# Jarvis Eyes — Visual Perception

## The one-sentence version

**Eyes are provider-independent. Vision transport is provider-specific.**

Jarvis has exactly one continuous, provider-neutral visual perception
system. Every AI provider receives visual information through its own
adapter, shaped by what that provider's selected model *actually*
supports. The AI providers are not the Eyes; they are consumers of
perception.

```
                       JARVIS EYES
                            |
                   Continuous Visual Stream    (DXGI Desktop Duplication → VisualStream)
                            |
                   Temporal Memory             (bounded in-memory VisualHistory, 3 tiers)
                            |
                   Attention Engine            (salience, primary vs. peripheral)
                            |
                   Vision Adapter              (capability-driven transport choice)
                            |
        +-------------------+--------------------+
        |                   |                    |
      OpenAI             Claude               Gemini
      images             images            realtime / video / images
```

**Screenshots are NOT the computer-perception mechanism, and are NOT used
as an automatic fallback.** There is no capture → upload → wait → capture
loop anywhere in this subsystem. Pixels flow from a genuine continuous
capture source (Windows DXGI Desktop Duplication) the entire time Eyes is
enabled with visual capture on — not a screenshot taken when something
looks interesting. If a platform cannot provide that, Jarvis says so
(`NotConfiguredError`) rather than substituting a screenshot loop.

## The four layers, kept distinct

| Layer | What it is | Where |
|---|---|---|
| **Eyes / visual perception** | Continuous awareness of *what is happening on screen* — both structural events (window/focus changes, UI structure changes, notifications) AND a genuinely continuous pixel stream from the platform's native capture technology. | `src/eyes/*` |
| **Windows UI Automation** | Structured semantic control data — this is a button named "Save", automation id `btnSave`, enabled, supports Invoke. | `src/eyes/providers/windows/*`, `tools/builtin/uiAutomationTools.ts` |
| **Computer control** | Actually *doing* something — launching an app, invoking a UI element. Prefers semantic references over coordinates. | `tools/builtin/computerTools.ts`, `uiAutomationTools.ts` |
| **AI reasoning / realtime voice** | The model that decides what to do, and separately the speech pipeline. Neither owns visual state. | `agent/orchestrator.ts`, `ai/*`, VOICE.md |

UI Automation is not a replacement for Eyes and neither replaces computer
control. A model can hold a complete UI tree and still have no idea that a
notification just appeared or that the user alt-tabbed away — that is what
the Eyes side of the system is for.

## Architecture

```
Computer display
   │                                    │
   │ Win32 / UI Automation events       │ DXGI Desktop Duplication
   │ (structural — no polling)          │ (continuous pixels — GPU-signaled, no polling)
   ▼                                    ▼
VisualProvider ...................................................... the OS seam
        │  WindowsVisualProvider; UnsupportedVisualProvider elsewhere
        ▼
AttentionManager .............................. salience + throttling (structural events)
        ▼
VisualPerceptionEngine (implements VisualStream)
        │  • live VisualState                • bounded, 3-tier VisualHistory
        │  • subscribe() fan-out             • local processingFps enforcement
        │  • ingestEvent (structural)        • ingestContinuousFrame (pixels)
        ▼
VisualContext (purpose-driven temporal selection)
        │  "what just happened?" → observations + keyframes + summary
        ▼
VisionTransportAdapter ........................ the provider seam
        │  chosen from declared ModelCapabilities.visionCapabilities
   ┌────┴──────────┬────────────────┬───────────────────┐
   ▼               ▼                ▼                   ▼
OpenAI          Anthropic        Gemini             text-only
temporal        bookended        realtime /         structural
image set       image set        video / images     summary
```

Nothing above the `VisualProvider` line is Windows-specific. Nothing above
the `VisionTransportAdapter` line is AI-provider-specific. Those are the
two independences the architecture exists to guarantee.

## Why this is genuinely continuous (and not a screenshot loop)

Two independent event-driven sources feed the engine — neither is a timer:

- **Window/foreground awareness**: Win32 `SetWinEventHook` — a real
  kernel-brokered callback that fires only when a window is created,
  destroyed, focused, moved or resized.
- **UI Automation awareness**: .NET `AddAutomationFocusChangedEventHandler`
  and structure/property-changed handlers — equally event-driven.
- **Continuous pixels**: Windows DXGI Desktop Duplication's
  `AcquireNextFrame` — a call that **blocks** until the GPU actually has a
  new frame ready (or a timeout elapses), the same "wait for a real signal"
  shape as the two sources above, not a `sleep(N); grab pixels` loop. It
  runs at up to the display's own refresh rate wherever the hardware
  supports it, on its own dedicated background thread so it can never
  block, or be blocked by, the structural event pump.
- **Delivery**: the structural sources require a live Win32 message loop,
  which is what `eyesWatcher.ps1` runs (`Application::Run()`); the
  continuous-capture source runs independently on its own thread. Neither
  is a `setInterval`.
- **Enforced**: `tests/eyes.perceptionIndependence.test.ts` asserts
  structurally that no `setInterval` exists anywhere under `src/eyes/`, and
  that `visualPerceptionEngine.ts` contains no timers at all.

`eyesWatcher.ps1` is a single **long-lived** PowerShell/.NET helper process
per user, speaking newline-delimited JSON over stdin/stdout:
`{"kind":"event"}` for structural changes, `{"kind":"frame"}` for
continuous-capture ticks, `{"kind":"response"}` answering one-shot
queries. Two threads (the message pump and the capture thread) can write
concurrently, so every write goes through one shared lock to keep the
protocol's lines from interleaving. Reading already-buffered stdin
commands on the message-pump thread uses a `Forms.Timer` tick (UI
Automation is STA/COM-affine); that timer drains commands already in the
pipe and is not how structural events are observed.

## Local capture rate vs. cloud transport rate vs. local processing rate

Three independent rates, not one:

- **`eyesLocalCaptureFps`** — how often the native capture technology
  checks for a new frame. Up to 60fps where the display/hardware actually
  supports it (`AcquireNextFrame`'s timeout parameter naturally adapts:
  if nothing changed, it just waits longer, never busy-spins).
- **`eyesLocalProcessingFps`** — how often a captured tick is worth fully
  decoding/encoding into a pixel-bearing observation versus retained as
  change-metadata only. The engine enforces this itself
  (`VisualPerceptionEngine.ingestContinuousFrame`) as a second,
  authoritative gate over whatever the platform side already tried to do
  — a significant enough change can bypass the budget early, the same way
  `notification_appeared` is never throttled on the structural side.
- **Cloud transport rate** — negotiated per provider/model (see below),
  completely independent of both of the above.

A tick that arrives faster than `eyesLocalProcessingFps` allows is never
dropped outright — its structural record (change score, changed regions,
timestamp) is always retained; only its pixels are stripped when the
budget says so. Motion/change continuity is therefore never lost between
materialized frames.

## Temporal visual memory: three tiers, not one flat list

`VisualHistory` is a bounded, in-memory structure recording observations
as they occur — both structural events and continuous-capture ticks share
it. Because it is written continuously, "what just happened?" is
answerable *without capturing anything at query time*.

| Tier | What it holds | Bounded by |
|---|---|---|
| **Hot** | Every accepted observation, unconditionally — the high-frequency short buffer fine-grained motion/before-after queries need. | Count + a short age window (not user-configurable — sizing detail, not policy) |
| **Warm** | A thinned, longer-range subset — promoted on a time bucket, or immediately for a significant enough change. Structural, low-density. | `eyesHistorySeconds` |
| **Keyframes** | Only observations that both carry pixels and clear a salience floor — the moments actually worth a model's attention, retained longest. | `eyesMaxKeyframes` |

A query merges and deduplicates across all three. Pixels are bounded by
ONE shared count-and-byte budget scanned across every tier that might be
holding a reference (not just the "obvious" ones — a frame that ages out
of hot but is still referenced by warm has to be found there too, or it
would silently outlive its intended bound). Under pressure, the budget
strips pixels from the **oldest** frame-bearing samples first, keeping
their structural record: losing pixels costs detail, losing the timeline
would cost correctness.

Nothing in this buffer is ever written to disk, and `stop()` clears it
entirely.

## Continuous capture: attention governs retention, not whether capture happens

An earlier version of this subsystem captured a pixel only reactively —
when a structural event looked significant, it triggered a one-shot
`captureFrame()` call. That was gated by attention, but it was still
fundamentally *screenshot-on-event*. **That model has been removed.**

Now, whenever `eyesMode` is `structural_plus_visual`, real pixels flow
continuously and independently of structural events for as long as Eyes
is running (subject to the capture/processing rates above). Attention and
significance decide which continuously-captured observations get
promoted into `VisualHistory`'s longer-range tiers — never whether
capture happens at all. `structural_only` (the default) never starts the
continuous capture stream, so zero pixels are ever obtained.

Starting continuous capture is best-effort and never blocks or fails
structural startup: a platform that doesn't support it, or a runtime
failure (no GPU adapter, an unsupported session), degrades to
structural-only rather than crashing or substituting a screenshot loop —
reported honestly via `VisualPerceptionEngine.isCapturingContinuously`.

## Model independence: capability-aware transport

`ModelCapabilities.visionCapabilities` declares what a model's API
*actually* accepts — `imageInput`, `videoInput`, `realtimeVision`,
`realtimeAudio`, `temporalImageContext`, `videoUpload`, plus rate and count
ceilings. These are declarations we can check, never aspirations; a
provider must not claim a transport its endpoint does not serve.

| Provider | Declared | Transport |
|---|---|---|
| **OpenAI** (chat models) | images, temporal sequences | `temporal_image_set` — a small set of labelled keyframes selected around what changed, with a tight per-detail budget (1/3/5 images) because each image costs a meaningful share of a 128k context. |
| **Anthropic** | images, temporal sequences | `temporal_image_set` — a wider budget (1/4/8) and a *bookended* selection that always protects the oldest "before" frame and the newest "after" frame, filling the middle by salience. |
| **Gemini** standard | images + video (inline and Files API) | `temporal_image_set`, or `video_upload` when a clip source is registered. |
| **Gemini** Live models | realtime visual + audio session | `realtime_stream` — frames flow over the live session at the negotiated rate; the request references the session rather than re-embedding imagery. |
| **Anything else / non-vision** | — | `text_only` — the structural summary still goes, so a text-only model is still visually aware. |

Gemini's rate is **negotiated, not assumed**: `negotiateRealtimeVisual()`
takes the minimum of the model's declared ceiling
(`GEMINI_REALTIME_VISUAL_FPS`, default 1), any requested rate, and any
server-accepted rate. There is no hard-coded "Gemini = 1 fps" anywhere; the
default is a configurable declared ceiling an operator can raise.

**Local Eyes fps is not cloud transport fps.** The engine observes at
whatever rate the OS reports events. `PacedRealtimeVisualFeed` is the only
place those two rates meet, and it resolves the mismatch by dropping and
coalescing — never by slowing perception to the cloud's rate.

Adding a provider (including a future local vision model) means writing one
adapter and one capability declaration. The Eyes engine, attention model,
temporal buffer and orchestrator are untouched.

## The temporal context API

A model asks a *question*, not for "n frames":

| Purpose | Answers | Default window |
|---|---|---|
| `current_state` | "What am I looking at?" | 5s, 1 observation |
| `what_changed` | "What changed?" — pairs the peak change with the frame before it | 60s |
| `what_just_happened` | "What just happened?" | 30s |
| `inspect_region` | A specific area | 5s |
| `understand_scene` | Overall context | 10s |
| `follow_visual_activity` | "Tell me when something important changes" | 15s |

Selection is attention- and change-driven, spreads across time to avoid
near-duplicates, and prefers observations that carry pixels when a transport
can use them. Under a tight budget a change question keeps the before/after
pair ahead of the newest frame — "here's the latest image" does not answer
"what changed".

Exposed to the model as `eyes_query_visual_history`; the answer is also
what the orchestrator hands to the transport adapter.

## Latency and backpressure

- `ingestEvent` is synchronous and does no I/O.
- Subscribers are invoked without being awaited and are exception-isolated.
- `coalesceLatest()` keeps at most one in-flight call and one pending
  sample per consumer; while it is busy, newer samples overwrite the
  pending slot, so a consumer resumes on the *freshest* observation instead
  of replaying a stale backlog.
- The realtime feed drops by rate and by busy-state, and a failed cloud
  send never propagates into the event path.

`tests/eyes.visualStream.test.ts` dispatches 50 events into a handler that
never returns and asserts the event path stays under 200ms with all 50
recorded — a slow model demonstrably cannot block Eyes.

## Security

- **Two permissions**: `computer.eyes.read` (structural/semantic awareness,
  scored LOW) and `computer.eyes.capture` (pixels, scored HIGH — a screen
  can show anything). Asking for imagery escalates the required permission,
  whether the frame is captured fresh or already held in memory.
- **No provider gets visual data by default**: `eyesAllowedProviders` is
  empty out of the box and gates *all* visual context, text summaries
  included — "which providers may know what's on my screen" is a privacy
  decision, not a pixels-only one.
- **Capability-gated**: imagery only reaches a model whose capabilities
  declare it can use it.
- **No retention**: `VisualState` and `VisualHistory` are process memory
  only; nothing visual is written to the database, and a captured frame is
  never handed to `conversationService.appendMessage`. Verified in
  `tests/eyes.perceptionIndependence.test.ts`, which captures a frame with a
  known marker and asserts it appears in no persisted table.
- **Never logged**: frame payloads are never written to logs, including by
  the Gemini Live sink.
- **Fully disableable**: `eyesEnabled: false` (the default) means the engine
  never starts and no OS hooks are ever registered.
- **On-screen text is untrusted**: window titles and notification bodies are
  attacker-influenceable like a fetched web page, so the ambient summary is
  wrapped in `<external_content trust="untrusted">` and the temporal query
  tool marks its output untrusted.

## Settings

| Field | Default | Meaning |
|---|---|---|
| `eyesEnabled` | `false` | Master switch. Off means no engine, no OS hooks, no visual context anywhere. |
| `eyesMode` | `structural_only` | `structural_plus_visual` starts the continuous capture stream — real pixels flow continuously, not on-event. |
| `eyesAttentionMode` | `auto` | `auto` lets AttentionManager surface significant changes; `manual` reserved for user-driven focus. |
| `eyesUpdateLatencyPolicy` | `balanced` | `realtime` / `balanced` / `low_power` — scales structural-event throttle windows. |
| `eyesAllowedProviders` | `[]` | Provider ids allowed to receive any visual context. |
| `eyesHistorySeconds` | `120` | How far back the warm tier of the in-memory temporal buffer reaches. |
| `eyesMaxKeyframes` | `12` | How many keyframes the buffer may hold at once. |
| `eyesLocalCaptureFps` | `10` | Native continuous-capture rate ("local Eyes FPS"). Up to 60, independent of any cloud transport rate. |
| `eyesLocalProcessingFps` | `2` | How often a captured tick is worth fully materializing into pixels, independent of the capture rate. |
| `eyesMaxBufferedFrames` | `90` | Hot-tier capacity — how many recent continuous observations may be buffered at once. |

`PATCH /settings/eyes` applies every change to the running engine
immediately — without restarting it, so visual history built up so far
survives. Enabling on an unsupported platform surfaces the real error and
rolls `eyesEnabled` back rather than leaving a misleadingly-on setting.

## Audio/vision correlation

`VisualSample.atMs` and the voice pipeline's `voice.transcript`
`startedAtMs`/`endedAtMs` are stamped on the same epoch-ms clock, and the
utterance bounds are derived from audio length rather than STT completion
time. "What was on screen while I said that?" is therefore a time-range
intersection against `VisualHistory`. The realtime voice/barge-in pipeline
is otherwise unchanged.

## Tools

| Tool | Permission | Does |
|---|---|---|
| `eyes_get_visual_state` | `computer.eyes.read` (+ `computer.eyes.capture` when `includeVisual`) | Current structural awareness; optionally one on-demand freshly captured frame. |
| `eyes_query_visual_history` | same | Temporal question over the in-memory buffer — no capture at query time. |
| `computer_get_ui_tree` | `computer.read` | Full UI Automation tree for a window. |
| `computer_find_ui_element` | `computer.read` | Find controls by name/automation id/control type. |
| `computer_get_ui_element` | `computer.read` | Re-resolve one element's current state. |
| `computer_invoke_ui_element` | `computer.input` | Invoke/toggle/select — the semantic alternative to a coordinate click. |
| `computer_set_ui_value` | `computer.input` | Set a Value-pattern element directly. |
| `computer_focus_ui_element` | `computer.input` | Move keyboard focus semantically. |

All throw `NotConfiguredError` rather than guessing when Eyes isn't running.

## What is verified here vs. what needs Windows hardware or credentials

This development sandbox is a headless Linux container: no Windows host, no
GPU, no display server, no Gemini API key.

**Fully verified by tests in this environment:**
- Stream fan-out, unsubscribe, exception isolation, and the
  slow-consumer/coalescing behavior including the explicit proof that a
  hung consumer cannot block perception — for both structural events and
  continuous-capture ticks.
- Continuous capture lifecycle against a fake provider: disabled by
  default, starts/stops with the requested rates, degrades to
  structural-only when unsupported or when starting fails at runtime
  (without crashing engine startup), stops when the engine stops, and
  starts/stops live when the policy changes mid-session.
- `processingFps` enforcement: a tick arriving faster than the budget
  keeps its structural record but loses its pixels; a significant enough
  change bypasses the throttle; attention classification from
  `changeScore` matches the structural scale.
- Three-tier `VisualHistory`: independent hot/warm/keyframe bounds by
  count and age, promotion rules (time-bucket and significance-driven for
  warm, frame-and-salience-gated for keyframes), cross-tier
  merge-and-dedup on query, and — specifically — that the shared
  frame/byte budget still finds and strips a frame that has aged out of
  hot but is still referenced by warm, rather than letting it silently
  outlive its intended bound.
- Purpose-driven context building and attention/temporal selection,
  including before/after pairing and near-duplicate avoidance.
- Capability declarations read off the real provider implementations,
  including Live-vs-standard Gemini model detection.
- Adapter selection and provider isolation (an unknown provider falls to
  text-only, never to another provider's adapter), plus each adapter's
  own request shaping and budgets.
- Realtime negotiation (minimum of declared/requested/server-accepted),
  paced dropping, busy coalescing, failure isolation, and session-manager
  reuse/no-retry behavior.
- Perception continuing through: no AI provider at all, a hung consumer, a
  dead session mid-stream, a throwing transport, and capture failures.
- No `setInterval` anywhere in `src/eyes/`; no timers in the engine; the
  engine never imports an AI provider or the router.
- No raw frame reaches any persisted table, and visual memory dies on stop.
- Settings persistence, bounds validation, permission escalation for
  imagery, and the API surface.

**Implemented against documented APIs but NOT verified here — two
genuinely different risk tiers:**

*Lower risk (flat P/Invoke, same category this project has shipped
before):* the Win32 `SetWinEventHook` registrations and UI Automation
event handlers/tree walk in `eyesWatcher.ps1`, and the
`WindowsVisualProvider` IPC framing around them. Standards-based and
reviewed; never executed against a real Windows desktop.

*Materially higher risk — read this before trusting it:* the DXGI Desktop
Duplication continuous-capture addition to `eyesWatcher.ps1` hand-declares
COM interfaces via manually-ordered vtable method lists (`[ComImport]`).
Unlike the flat P/Invoke above, a single wrong slot position or ABI
mismatch here causes undefined behavior — a crash or memory corruption —
at the exact call site, not a clean compile or runtime error pointing at
the mistake. It has never been compiled, let alone executed, against a
real GPU. Specific things a Windows-capable reviewer should check before
relying on it: the vtable slot ordering for every declared interface
against current Windows SDK headers (`dxgi1_2.h`, `d3d11.h`), the
`DXGI_OUTDUPL_FRAME_INFO`/`D3D11_TEXTURE2D_DESC`/`D3D11_MAPPED_SUBRESOURCE`
struct layouts, and COM reference-counting correctness (not every
intermediate pointer is rigorously `Release()`d, which is a leak risk
over long runs even if the core logic is otherwise correct). Consider
replacing this hand-rolled interop with a maintained library (e.g.
Vortice.Windows) if you need this path production-solid rather than a
best-effort starting point. There is also one known functional gap: if
the duplication session dies mid-stream (display sleep, resolution
change, GPU driver reset), the capture thread exits quietly — nothing
currently tells the Node side capture actually stopped, so
`isCapturingContinuously` can read stale until the next explicit
start/stop.
- `GeminiLiveVisualSink` — re-checked in this revision against secondary
  sources (a live fetch of the primary reference was blocked by this
  environment's egress policy) and fixed one real discrepancy: a single
  video/image frame belongs in `realtimeInput.video: {mimeType, data}`,
  not the `realtimeInput.mediaChunks` array this file previously used
  (that shape is documented for audio, not confirmed for video). No API
  key and no outbound access to the endpoint exist here, so no real
  session has ever completed. Everything around it (negotiation, pacing,
  coalescing, fallback) is fully tested with a fake sink and does not
  depend on this class working.
- The Gemini `video_upload` pathway is reachable only when a
  `VideoClipSource` is registered. None ships: this build has no video
  encoder, so the pathway stays unreachable rather than being claimed
  falsely. Tested with a fake clip source.

Do not describe the Windows continuous-capture path, the rest of the
Windows watcher, or the Gemini Live path as verified.

## Extending to macOS/Linux

`UnsupportedVisualProvider` runs today on every non-Windows platform and is
deliberately honest rather than a quiet stub. A real implementation would
use macOS's Accessibility API (`AXObserver` notifications) or Linux's
AT-SPI2, implementing the same `VisualProvider` contract — nothing above
that seam would change.
