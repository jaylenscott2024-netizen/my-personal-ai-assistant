# Jarvis Eyes — Visual Perception

## What this is

**Jarvis has an Eyes visual-perception subsystem that is independent of
the selected AI model.** It is a distinct architectural layer — Computer
display → Eyes Engine → persistent low-latency visual state →
provider-specific visual adapter → whichever AI model is configured
(Anthropic/OpenAI/Gemini/mock, or a future/local model) → Jarvis
reasoning → computer control. Switching AI providers never removes or
degrades the Eyes subsystem, and disabling Eyes never touches which AI
provider is configured.

**Screenshots are NOT the computer-perception mechanism, and are NOT used
as an automatic fallback.** There is no screenshot-polling loop anywhere
in this subsystem — no periodic capture, no "capture → send to model →
analyze → repeat," no coordinate-guessing from a still image. If a
platform can't support real event-driven perception, Jarvis reports that
limitation honestly (`NotConfiguredError`) instead of silently
substituting a screenshot loop. See "No screenshot fallback, ever" below.

## The four things this document keeps distinct

It's easy to conflate these; they are deliberately separate subsystems
that happen to cooperate:

| Layer | What it is | Where |
|---|---|---|
| **Eyes / visual perception** | Continuous, event-driven awareness of *what's happening on screen* — window/focus changes, UI structure changes, notifications — plus on-demand pixel capture. Answers "what changed, and where should attention be." | `src/eyes/*` |
| **Windows UI Automation** | Structured, semantic control data — this is a button named "Save", automation id `btnSave`, enabled, focused, supports Invoke. Answers "what specific control do I interact with." | `src/eyes/providers/windows/*`, `tools/builtin/uiAutomationTools.ts` |
| **Computer control** | Actually *doing* something — launching an app, typing, clicking, invoking a UI element. Prefers UI Automation (semantic) over raw coordinates. | `tools/builtin/computerTools.ts`, `tools/builtin/uiAutomationTools.ts` |
| **AI model reasoning / realtime voice** | The LLM that decides what to do, and (separately) the speech pipeline. Neither owns any visual state — they consume what Eyes hands them. | `agent/orchestrator.ts`, `ai/*`, VOICE.md |

UI Automation is not a replacement for Eyes, and neither is a
replacement for computer control. A model can have rich UI Automation
data (a whole tree of buttons and fields) and still have no idea a
notification just popped up in the corner of the screen, or that the user
just alt-tabbed to a different application — that's what the Eyes side
of `VisualState` is for.

## Architecture

```
Computer display (Win32 events, UI Automation events)
        │  event-driven — SetWinEventHook + UI Automation event handlers,
        │  NOT a poll loop (see "How this is actually continuous" below)
        ▼
VisualProvider (src/eyes/visualProvider.ts)          — the OS-specific seam
        │  WindowsVisualProvider today; UnsupportedVisualProvider
        │  everywhere else, reporting the real limitation honestly
        ▼
AttentionManager (src/eyes/attentionManager.ts)      — significance scoring,
        │  primary vs. peripheral classification, per-event-type throttling
        ▼
VisualPerceptionEngine (src/eyes/visualPerceptionEngine.ts)
        │  the persistent, low-latency VisualState — foreground window,
        │  window list, primary focus, a bounded recent-events trail
        ▼
   ┌────┴─────────────────────────┐
   ▼                              ▼
VisualContextAdapter          eyes_get_visual_state /
(src/eyes/                    computer_*_ui_* tools
visualContextAdapter.ts)      (tools/builtin/eyesTools.ts,
   │  ambient TEXT summary       uiAutomationTools.ts)
   │  injected into the          │  on-demand structural query,
   │  system prompt              │  optionally + one captured frame
   ▼                              ▼
Agent orchestrator (agent/orchestrator.ts)
   │  decides, per turn, whether the active provider/model can and may
   │  actually receive any of this (capability + allowlist gate)
   ▼
AI model (Anthropic / OpenAI / Gemini / mock / future/local)
```

Nothing above the `VisualProvider` line is Windows-specific, and nothing
below the `VisualPerceptionEngine` line is AI-provider-specific — those
are the two independences the spec asks for.

## How this is actually continuous (not a screenshot loop)

`VisualProvider.start(onEvent)` doesn't return until a real OS event
source is live, and after that, events arrive by callback — never by
Node polling anything on an interval:

- **Window/foreground awareness**: Win32 `SetWinEventHook` — a real
  kernel-brokered callback that fires only when a window is created,
  destroyed, gains foreground, or moves/resizes. No polling.
- **UI Automation awareness**: .NET
  `AddAutomationFocusChangedEventHandler` and structure/property-changed
  handlers — the same event-driven model. No re-walking the tree on a
  timer.
- **Delivery mechanism**: both of the above are Win32/COM callbacks, which
  require a live Win32 message loop to actually fire
  (`[System.Windows.Forms.Application]::Run()` in
  `eyesWatcher.ps1`) — that message pump is what "runs continuously"
  means here, not a `setInterval`.

`eyesWatcher.ps1` is a single **long-lived** PowerShell/.NET helper
process per user (spawned once by `WindowsVisualProvider`, not
respawned per query) — a deliberate departure from the one-shot
`execFile` pattern the rest of `computer/*.ts` uses, because a persistent
process is required to host the message loop and keep event callbacks
alive, and because one-shot UI Automation queries (`get_ui_tree`, etc.)
would otherwise pay a fresh-process cost on every call. It exposes a tiny
newline-delimited-JSON protocol over stdin/stdout: unsolicited
`{"kind":"event",...}` lines for the continuous stream, `{"kind":"response",...}`
lines answering one-shot commands. Reading already-buffered stdin
commands happens via a `System.Windows.Forms.Timer` tick **on the same
thread** as the message pump (UI Automation is STA/COM-affine — a second
thread calling into `AutomationElement` risks cross-thread COM failures);
this timer only drains commands already sitting in the pipe, it is not
how events are observed.

## No screenshot fallback, ever

Pixel capture (`captureFrame` / `computer_frame`) exists, but only as a
**secondary, on-demand, separately-gated** channel:

- It is never invoked on a timer, never invoked automatically, and never
  substituted in when the event-driven path is unavailable.
- It requires the `computer.eyes.capture` permission — a distinct,
  HIGH-risk tier from `computer.eyes.read` (structural/event awareness),
  because screen pixels can contain literally anything: a password
  manager window, a private message, financial data
  (`security/permissions.ts`).
- The only way a pixel frame ever reaches the model is
  `eyes_get_visual_state` with `includeVisual: true` — and even then only
  if the active model's `ModelCapabilities.vision` is true and the
  current provider is on the user's `eyesAllowedProviders` allowlist (see
  "Model independence" below).
- If a platform can't support the event-driven path at all
  (`UnsupportedVisualProvider` — every platform except Windows today),
  every method throws `NotConfiguredError` with a specific reason. It
  never silently substitutes a screenshot-polling loop as a fake "Eyes."

## Model independence: capability-aware visual delivery

Not every AI API accepts the same visual input shape, so nothing upstream
of the AI provider ever assumes one. `ChatMessage.images` (`ai/types.ts`)
is a provider-neutral
`Array<{mimeType, base64}>`; each provider's own message-conversion
function renders it into whatever that API actually expects:

| Provider | How an image is attached |
|---|---|
| Anthropic | An `image` content block appended inside the same `tool_result` (or user message) — Anthropic supports multi-block tool results natively. |
| OpenAI | The `tool`-role message itself stays a plain string (the Chat Completions API rejects array content there) — a synthetic follow-up `user` message carries the `image_url` content part instead. |
| Gemini | An `inlineData` part appended alongside the `functionResponse` part in the same content entry — Gemini allows multiple parts per turn. |

Two independent gates decide whether an image is ever actually sent, both
enforced centrally in `agent/orchestrator.ts` (never left to the tool or
the Eyes Engine to decide):

1. **Capability**: `provider.getCapabilities(model).vision` must be true.
   A non-vision model silently gets the text-only structural summary
   instead — never base64 noise it can't use.
2. **Explicit opt-in**: the active `providerId` must be in the user's
   `eyesAllowedProviders` setting (empty by default — **no provider
   receives any visual data until the user explicitly allows it**, per
   provider).

The *ambient* system-prompt summary (`visualContextAdapter.ts`) is
text-only by construction — it never carries pixels, so it only needs the
allowlist + permission gate, not the vision-capability check.

## Peripheral vision and attention (`AttentionManager`)

Every raw event is scored, not blindly forwarded — this is what keeps
the model from being flooded with irrelevant noise on every mouse
wiggle:

- **Significance scoring**: a base score per event type
  (`notification_appeared` highest, `window_moved_or_resized` lowest —
  see `eventMapping.ts`'s `significanceOf`), refined by context (e.g. a
  focus-changed event onto a window that's *already* foreground is
  downgraded to low-significance/peripheral rather than treated as a
  fresh, primary event).
- **Primary vs. peripheral**: significance ≥ 0.5 is `"primary"` (the
  ambient summary and event stream foreground it); below that is
  `"peripheral"` (still recorded, still visible in the recent-events
  trail, but not treated as something that just grabbed attention).
- **Throttling, scaled by latency policy**: each event type has a base
  throttle window (e.g. 300ms for focus changes, 800ms for move/resize,
  0 for notifications — never throttled), multiplied by the configured
  `eyesUpdateLatencyPolicy` (`realtime` = 0.5×, `balanced` = 1×,
  `low_power` = 3×). A burst of location-change events during a window
  drag collapses to the throttle window's cadence instead of flooding
  `VisualState.recentEvents` and the `eyes.event` bus with every single
  one.
- **Never redundant**: a throttled/duplicate event is dropped before it
  ever updates `VisualState` or reaches the event bus — the model is
  never asked to process the same "nothing new happened" state twice.

## Settings (`PATCH /settings/eyes`)

| Field | Default | Meaning |
|---|---|---|
| `eyesEnabled` | `false` | Master switch. Off means the engine never starts, no OS event hooks are ever registered, and no visual context of any kind reaches any prompt. **The user can fully disable Eyes at any time.** |
| `eyesMode` | `"structural_only"` | `"structural_only"` vs. `"structural_plus_visual"` — reserved for future UI to distinguish "never allow pixel capture at all" from "structural awareness is always on, pixel capture is available on request." |
| `eyesAttentionMode` | `"auto"` | `"auto"` (AttentionManager decides primary/peripheral) vs. `"manual"` (reserved for future user-driven focus control). |
| `eyesUpdateLatencyPolicy` | `"balanced"` | `"realtime"` / `"balanced"` / `"low_power"` — scales AttentionManager's throttle windows. |
| `eyesAllowedProviders` | `[]` (empty) | AI provider ids allowed to receive **any** visual context, ambient or tool-attached. Empty means no provider gets any, by design. |

`PATCH /settings/eyes` is where a change actually takes effect
immediately: enabling it starts the engine right there (surfacing
`NotConfiguredError` — e.g. an unsupported platform — as a real error and
rolling `eyesEnabled` back to `false` rather than leaving a
misleadingly-"on" setting with nothing running), disabling it stops the
engine, and a latency-policy change is pushed into the already-running
engine. `eyesService.restoreEnabledEngines()` runs once at server startup
(mirroring the scheduler's job restoration) so a user who had Eyes
enabled doesn't have to re-enable it after a restart; `stopAll()` runs on
graceful shutdown.

**Visual data retention: none by default, and none at all today.**
`VisualState` lives only in the `VisualPerceptionEngine` instance's
memory for as long as the process runs — nothing about it is written to
the database. An image attached to a tool result is held in memory only
for the current agent-loop turn (`ChatMessage.images` /
`ToolExecutionResult.images`) and is never passed to
`conversationService.appendMessage`, so it never enters persisted
conversation history.

## Tools

| Tool | Permission | Approval | Does |
|---|---|---|---|
| `eyes_get_visual_state` | `computer.eyes.read` (+ `computer.eyes.capture` only when `includeVisual: true`) | No (Yes when `includeVisual: true`, since that resolves to HIGH risk) | Structural summary (foreground window, windows, recent events) always; optionally one on-demand frame. |
| `computer_get_ui_tree` | `computer.read` | No | Full UI Automation tree for a window. |
| `computer_find_ui_element` | `computer.read` | No | Find elements by name/automation id/control type. |
| `computer_get_ui_element` | `computer.read` | No | Re-resolve one element's *current* state by its opaque ref, without re-walking the tree. |
| `computer_invoke_ui_element` | `computer.input` | No | Invoke/Toggle/Select an element — the semantic alternative to a coordinate click. |
| `computer_set_ui_value` | `computer.input` | No | Set a Value-pattern element's value directly. |
| `computer_focus_ui_element` | `computer.input` | No | Move keyboard focus to an element. |

All seven throw `NotConfiguredError` (never a silent empty result, never
a coordinate guess) when the Eyes engine isn't actually running for that
user.

## What's verified in this environment vs. what needs a real Windows host

This development sandbox is a headless Linux container: no Windows host,
no display server, no UI Automation runtime. Honest split:

**Fully verified (real logic, real assertions, `tests/eyes.*.test.ts`):**
- `VisualState`/`VisualEvent` data shapes and the `UnsupportedVisualProvider`
  (every method throws `NotConfiguredError` with a specific reason — this
  is what actually runs when this exact backend is deployed on Linux/macOS
  today).
- `AttentionManager`: significance scoring, primary/peripheral
  classification, and latency-policy-scaled throttling (including a
  fake-timer test proving the throttle window actually expires and
  re-admits an event).
- `mapRawEventToVisualEvent` — the pure parsing/mapping logic the Windows
  watcher's raw JSON goes through, tested directly with hand-built raw
  event payloads.
- `VisualPerceptionEngine`: state initialization, event ingestion +
  AttentionManager integration, throttled-event dropping, stop/start
  lifecycle, and delegation of UI Automation/frame-capture calls — all
  against a hand-rolled `FakeVisualProvider` test double.
- `eyesService`: enable/disable gating, idempotent start, engine
  lookup/stop, and honest failure propagation for an unsupported
  platform, plus startup-restore behavior.
- `VisualContextAdapter`: every gate (disabled, no permission, provider
  not allowlisted, empty allowlist, engine not running, engine running
  but uninitialized) independently verified to contribute nothing, and
  the rendered summary verified to be text-only, wrapped as untrusted
  external content, and never containing pixel data.
- `eyes_get_visual_state` and every `computer_*_ui_*` tool: declared
  permission/risk tier, the `includeVisual` permission-escalation rule in
  `permissionResolution.ts`, `NotConfiguredError` when Eyes isn't
  running, and correct delegation to a running (fake) engine.
- Provider-neutral image rendering: `toAnthropicMessages`,
  `toOpenAIMessages`, and `toGeminiContents` each tested with and without
  `ChatMessage.images`, confirming the no-image case is byte-for-byte
  unchanged and the image case matches each API's actual documented
  shape.
- `PATCH /settings/eyes` end-to-end via `app.inject()`: auth boundary,
  enabling starting a (faked) engine, an unsupported-platform failure
  reporting honestly and rolling the setting back, disabling stopping the
  engine, and input validation.

**Implemented against real, documented Win32/.NET APIs, but not
executable here (no Windows host in this sandbox) — `eyesWatcher.ps1`,
`windowsVisualProvider.ts`:**
- `SetWinEventHook` registration and callback delivery for
  foreground/create/destroy/location-change events.
- `AddAutomationFocusChangedEventHandler` and the UI Automation tree walk
  (`ConvertTo-UiElementNode`), including pattern detection
  (Invoke/Toggle/SelectionItem/Value) and element-reference resolution.
- The persistent process's stdin/stdout JSON protocol, spawn/ready
  handshake, and command timeout handling on the Node side
  (`WindowsVisualProvider`) — the IPC *logic* is reviewable and its
  message-mapping is unit-tested, but a real `powershell.exe` has never
  actually been spawned and exercised end-to-end.
- On-demand GDI screen capture (`CopyFromScreen`) for `capture_frame`.

Do not report Windows Eyes functionality as "verified" beyond this split
— it is standards-based, carefully reasoned code, not code that has run
against a real Windows desktop.

## Extending to macOS/Linux

`UnsupportedVisualProvider` is what runs today on any non-Windows
platform, and it's intentionally honest rather than a stub to quietly
replace: a real implementation would need macOS's Accessibility API
(`AXObserver` for structure/focus notifications, matching UI Automation's
role) or Linux's AT-SPI2 (the standard accessibility bus most desktop
toolkits already implement), following the exact same
`VisualProvider` contract — nothing above that seam would need to change.
