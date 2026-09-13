# Architecture

## Stack

- **Runtime**: Node.js 20+, TypeScript (strict mode), ESM throughout.
- **API**: Fastify, with `@fastify/websocket` for the real-time transport.
- **Database**: Prisma ORM. SQLite by default (zero-setup dev/test), one
  schema change away from Postgres in production (see DEVELOPMENT.md —
  Prisma fixes the provider per schema, it can't pick it from the URL at
  runtime, so this is a deliberate one-line migration step, not a bug).
- **AI providers**: direct REST calls via `undici`/native `fetch` to
  Anthropic, OpenAI, and Gemini — no vendor SDKs, so the normalized
  interface in `src/ai/types.ts` is the only shape the rest of the system
  ever sees.
- **Browser automation**: Playwright (real headless Chromium, not a stub).
- **Tests**: Vitest, hitting a real (SQLite) database and a real Fastify
  instance via `.inject()` — not mocked-out unit tests pretending to be
  integration tests.

## Why this stack

A personal-assistant backend's hard problems are orchestration,
permissions, and state — not framework choice. Fastify + Prisma + plain
REST calls to providers keeps the dependency graph small and every layer
inspectable, which matters more here than picking the trendiest SDK.
Undici/`fetch` instead of `@anthropic-ai/sdk`/`openai`/`@google/genai` was
a deliberate trade: three fewer large dependencies to track for security
advisories, at the cost of hand-rolling request/response shapes — worth it
because all three providers' chat APIs are simple enough that the
normalization layer (`src/ai/types.ts`) would have looked almost identical
either way.

## Layered request flow

```
Client (desktop/web/CLI/voice)
        │  HTTPS + WebSocket (Section 47)
        ▼
Fastify app (src/app.ts)
        │  requireAuth (JWT) → route handler
        ▼
Conversation / Task API (src/api/routes/*)
        │
        ▼
Agent Orchestrator (src/agent/orchestrator.ts)   ◄── the core loop
        │
   ┌────┼─────────────┬───────────────┬───────────────┐
   ▼    ▼              ▼               ▼               ▼
Memory  AI Provider   Tool Registry   Approval Engine  Event Bus
(src/    (src/ai/      (src/tools/*)   (src/approvals/) (src/events/)
memory)  router.ts)         │                                │
                            ▼                                ▼
                    Builtin / Plugin / MCP tools      WebSocket Gateway
                    (filesystem, browser, GitHub,      (src/realtime)
                     Shopify, email, calendar, Twilio)
```

Every arrow is a real, working call path today — the difference between
"builtin", "plugin", and "MCP" tools is only where `ToolDefinition` came
from (`src/tools/types.ts`); the orchestrator, permission check, and
approval gate treat them identically (Section 41: MCP tools cannot bypass
the security layer).

## The agent loop (`src/agent/orchestrator.ts`)

This is the part of the spec most likely to be built wrong as "call the
model once and return its answer," so it's worth being explicit about what
actually happens on every turn:

1. **Context assembly** — recent conversation history (`conversation/`) +
   relevant memory (`memory/memoryService.ts`, keyword+recency+importance
   scored, not "send everything") + tool descriptors + a structured system
   prompt (`context/instructions.ts` — core instructions, safety policy,
   and user preferences are separate sections, not one giant string).
2. **Model call** — `provider.chat(request)` against the normalized
   `AIProvider` interface.
3. **Tool calls, if any** — for each requested call:
   a. **Schema validation** (Zod) — a malformed call never reaches a tool.
   b. **Effective-permission resolution** (`tools/permissionResolution.ts`)
      — some tools (filesystem, browser) declare a baseline permission but
      the actual risk depends on the call's own arguments (`read` vs.
      `delete`); this step computes the real permission set for *this*
      call, not the tool's most permissive declared capability.
   c. **Permission check** against the caller's role
      (`security/permissionService.ts`) — a missing permission fails the
      call with an error the model can see and adapt to; it never silently
      no-ops.
   d. **Approval gate** — if the tool requires approval or the resolved
      risk level is high/critical, execution pauses and a real `Approval`
      row is created. The orchestrator waits, bounded by
      `AGENT_APPROVAL_WAIT_MS`, then returns `waiting_for_approval` to the
      caller rather than holding the HTTP request open indefinitely
      (Section 13). A separate `resume` endpoint re-enters the same loop
      once a human resolves it.
   e. **Execution**, with the tool's own result marked `untrusted` when it
      came from outside the trust boundary (web pages, files, emails) —
      that flag causes the message to be wrapped in
      `<external_content trust="untrusted">` before it ever reaches the
      model again (Section 66).
4. **Loop guards** — every iteration checks step count, wall-clock time,
   and total tool-call count against `AGENT_MAX_STEPS` /
   `AGENT_MAX_EXECUTION_MS` / `AGENT_MAX_TOOL_CALLS` and throws
   `AgentLoopLimitError` rather than looping forever. This is exercised
   directly in `tests/agent.orchestrator.test.ts` with a provider double
   that always requests another tool call.
5. **Completion** — once the model returns a plain text answer (no tool
   calls), the run is marked `completed` and the answer is persisted and
   returned.

State for all of this is persisted, not held only in memory: `AgentRun`
and `ToolCallRecord` rows mean a run's current step, tools used, and
outcome are queryable independent of the process that's handling it
(Section 10).

## Data model

See `prisma/schema.prisma` for the full schema. Highlights:

- `User` / `Session` / `Credential` — auth and encrypted third-party
  secrets. The first user ever registered becomes `owner`; later
  registrations default to `member` (least privilege by default for a
  personal/household assistant).
- `Conversation` / `Message` — chat history, including tool calls/results
  inline so a conversation transcript is a complete, replayable record.
- `MemoryItem` — one table for what the spec describes conceptually as
  ShortTerm/LongTerm/Preference/Project/Task memory, distinguished by a
  `category` column rather than five parallel tables (they share every
  other field, and category is exactly the dimension retrieval weights
  on).
- `Task` / `TaskStep` — the explicit state machine
  (`tasks/taskService.ts` enforces legal transitions only).
- `AgentRun` / `ToolCallRecord` — one row per orchestrator invocation and
  per tool call, independent of Task (a run can happen inside a chat
  message without ever becoming a formal Task).
- `Approval` — one row per paused consequential action, carrying the
  tool, action, parameters, and computed risk level.
- `Integration` / `ScheduledTask` / `ActivityEvent` / `Notification` —
  operational state for external services, cron-driven automation, the
  audit/activity stream, and delivered notifications.

## Event bus and real-time transport

`src/events/eventBus.ts` is a typed `EventEmitter` with a fixed catalog of
event types (Section 45). Every subsystem — the orchestrator, task engine,
tools, approvals, activation — emits into it; nothing downstream needs to
know who emitted an event, only its type. Two consumers exist today:

- **Activity log** — every event is persisted to `ActivityEvent` (secrets
  stripped by a shared redaction pass before storage).
- **WebSocket gateway** (`src/realtime/gateway.ts`) — broadcasts events to
  every socket a user has open, so a client can watch agent thinking, tool
  activity, and approval requests live.

## Security model (summary — full detail in SECURITY.md)

- **Least privilege**: `security/permissions.ts` defines the permission
  catalog (`filesystem.read/write/delete`, `browser.read/interact`,
  `email.send`, `shopify.write`, `phone.call`, …); role grants are
  evaluated per call, not cached per session.
- **Approval, independent of permission**: holding a permission is
  necessary but not sufficient for a risky action — the approval engine
  gates anything above "read" risk regardless of role, including the
  account owner.
- **Secret isolation**: credentials are AES-256-GCM encrypted at rest
  (`security/credentials.ts`); tools authenticate internally, so the model
  is never handed a raw API key or access token.
- **Prompt-injection boundary**: system instructions, user instructions,
  and external/tool-sourced content are kept structurally distinct
  (`context/instructions.ts`, the `untrusted` flag threaded through
  `ai/types.ts` and each provider's message-conversion function).

## What's stubbed vs. real (be honest about this when extending)

Real, working, end-to-end today: auth, conversations, memory, the full
agent loop (tested with both the mock provider and a live-shaped Anthropic/
OpenAI/Gemini REST client), tool registry + permission/approval gating,
task state machine, calculator/datetime/filesystem/browser/web-fetch
tools, GitHub/Shopify/email/Twilio/Google-Calendar clients, MCP client
connection, plugin loading, cron scheduler, WebSocket activity stream,
clap detection (real signal processing).

Architected with real interfaces and honest `NotConfiguredError`s, but
needing infrastructure this environment doesn't have to go further:
computer control, OAuth consent UI, wake-word DSP, plugin sandboxing — see
PROJECT_REQUIREMENTS.md's "Explicit non-goals" for why each one stops
where it does.
