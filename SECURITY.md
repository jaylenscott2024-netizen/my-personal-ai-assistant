# Security Model

## Threat model

This backend acts on a user's behalf against real external systems
(email, calendar, a store, a phone line, arbitrary web pages) under
instructions that ultimately come from an LLM. The three things that have
to hold for that to be safe:

1. The model's output is never trusted as authorization by itself.
2. Content the model reads from the outside world is never trusted as
   instructions.
3. Secrets never reach the model, logs, or API responses.

Everything below exists to enforce one of those three.

## Authentication

- Password auth with bcrypt (cost factor 12), minimum 10-character
  passwords enforced server-side (`auth/authService.ts`).
- Sessions are JWTs signed with `JWT_SECRET`; the app refuses to start in
  production with the shipped placeholder value.
- Only a *hash* of each issued token is stored (`Session.tokenHash`) —
  a database read alone can't be used to forge a session.
- Sessions are individually revocable (logout) and time-bounded
  (`JWT_EXPIRES_IN`); every authenticated request re-checks the session
  is neither revoked nor expired, not just that the JWT signature is
  valid.

## Authorization

- Every route that touches user data checks resource ownership, not just
  "is this request authenticated" (`auth/middleware.ts`'s
  `assertOwnsResource`, and ownership-scoped Prisma queries throughout —
  e.g. `getConversation(userId, id)` looks up `{id, userId}` together, so
  a wrong user gets a 404, not a 403 — no existence leak).
- Roles (`owner`, `admin`, `member`) are evaluated per permission, per
  call, in `security/permissionService.ts` — not cached into a session
  once at login.
- `tests/api.authorization.test.ts` exercises the ownership boundary
  directly: one user cannot read another user's conversation.

## Least-privilege tool permissions

- `security/permissions.ts` defines a fixed catalog of permission strings
  (`filesystem.read/write/delete`, `browser.read/interact`,
  `computer.read/control/input/files.read/files.write/files.delete/execute`,
  `computer.eyes.read/capture` (Jarvis Eyes — see EYES.md), `email.read/send`,
  `calendar.read/write`, `shopify.read/write`, `github.read/write`,
  `phone.call`, `network.fetch`, `admin`).
- Every tool declares the permissions it needs. Some tools' real risk
  depends on the specific call (`filesystem` read vs. delete, `browser`
  read vs. click/type) — `tools/permissionResolution.ts` computes the
  *effective* permission for that call's actual arguments, so a tool never
  gets to hide a write behind a read-shaped declaration.
- A missing permission fails the call with a message the model can see
  and adapt to (e.g. try a smaller-scoped action) — it is never silently
  dropped, and it is always audited (`security/audit.ts`).

## Approval engine

Holding a permission is **necessary but not sufficient** for a risky
action. `agent/orchestrator.ts` computes a risk level
(`security/permissions.ts::riskLevelForPermissions`) for every tool call's
resolved permissions; anything `high` or `critical` (delete, send email,
place a call, admin) — or any tool that explicitly declares
`requiresApproval: true` — pauses and creates a real `Approval` row before
executing anything, regardless of the caller's role. This holds for the
account owner too: nothing about being `owner` skips the approval gate,
only the permission check.

The orchestrator waits briefly (`AGENT_APPROVAL_WAIT_MS`) for a decision
before handing control back to the caller as `waiting_for_approval` —
covered end-to-end in `tests/agent.orchestrator.test.ts`, including the
resume-after-approval and resume-after-denial paths.

## Secret isolation

- Third-party credentials a user configures through the API
  (`POST /integrations/credentials`) are encrypted at rest with
  AES-256-GCM (`security/credentials.ts`); the encryption key is derived
  from `CREDENTIAL_ENCRYPTION_KEY`, which must be overridden in production.
- Decrypted secrets are only ever handed to the specific integration
  client that needs them (`integrations/*.ts`) — the model calls
  `shopify_read`, it never sees a Shopify access token.
- `tests/api.authorization.test.ts` asserts a submitted credential secret
  never appears in the API response.
- Logging (`config/logger.ts`) redacts common secret-shaped field names by
  path, and the event bus / audit log (`events/eventBus.ts`,
  `security/audit.ts`) independently strip anything matching
  `password|secret|token|apiKey|authorization` before persisting or
  broadcasting an event — defense in depth in case a call site ever
  accidentally includes one.

## Prompt-injection defense

Content retrieved from outside the trust boundary (a fetched web page, a
file read from the filesystem sandbox, an email, MCP tool output) is
marked `untrusted: true` on its way back into the conversation
(`tools/types.ts::ToolExecutionResult`). Every provider's message
converter (`toAnthropicMessages`/`toOpenAIMessages`/`toGeminiContents`)
wraps such content in `<external_content trust="untrusted">` tags before
it reaches the model, and the core system prompt
(`context/instructions.ts`) explicitly instructs the model never to treat
that tag's contents as instructions, even if they claim to be from the
user or the system. `tests/promptInjection.test.ts` verifies the wrapping
happens.

This is a mitigation, not a guarantee — a sufficiently capable model can
still be manipulated by adversarial content. The approval engine is the
actual backstop: even a successfully-injected instruction to (say) send an
email or delete a file still has to pass the same permission check and
approval gate as a legitimate request.

## Filesystem and browser sandboxing

- The filesystem tool resolves every path against `FILESYSTEM_TOOL_ROOT`
  and verifies the resolved real path stays inside it before touching
  disk — `../../etc/passwd`-style traversal is rejected, not just
  string-matched (`tools/builtin/filesystemTool.ts`).
- The browser tool blocks navigation to loopback/link-local addresses
  (SSRF guard) and gives each `(user, task)` its own isolated Playwright
  `BrowserContext` — no shared cookies/storage across users or tasks
  (`browser/browserManager.ts`).
- Idle browser sessions are torn down automatically after 10 minutes.

## Computer-control-specific security

Computer control (`tools/builtin/computerTools.ts`) has the widest reach
of any tool category in this codebase — real applications, real files
outside any sandbox root, real keyboard/mouse input — so it gets two
extra layers beyond the standard permission/approval gate:

- **Risk tiers match the spec's own categorization exactly**
  (`security/permissions.ts` documents the mapping; verified in
  `tests/computer.permissionTiers.test.ts`): opening/closing/focusing an
  app, listing, and screenshots are LOW; typing, clicking, and file
  creation/move/copy are MEDIUM; file deletion is HIGH (approval
  required); running a command is scored as CRITICAL — deliberately
  stricter than the spec's literal "HIGH," since arbitrary command
  execution is functionally equivalent to admin access.
- **`computer_run_command` is allowlisted, not just approved**
  (`computer/commandRunner.ts`): `COMPUTER_COMMAND_ALLOWLIST` names exact,
  bare executable names an operator has explicitly opted in — empty by
  default. A path (`/bin/sh`) is rejected even if its basename would
  otherwise match, and the allowlist check happens independently of, not
  instead of, the mandatory approval step. Both must pass.
- **Desktop file operations block a fixed list of OS-critical paths**
  (`computer/fileOps.ts`) — `/usr`, `/etc`, `C:\Windows`,
  `C:\Program Files`, `/System`, `/Library`, and similar — rather than
  restricting to one allowed root, since a real desktop assistant needs
  to reach the user's actual Downloads/Desktop/Documents folders.

## Jarvis Eyes: visual data is treated as maximally sensitive

Full detail in EYES.md; the security-relevant points:

- **Two separate, differently-scored permissions**: `computer.eyes.read`
  (structural/event awareness — window titles, UI Automation data, no
  pixels) scores LOW like other read operations; `computer.eyes.capture`
  (actual on-demand pixel frame capture) scores as HIGH (`"delete"`
  tier) — because a screen can show literally anything (a password
  manager, private messages, financial data), it is deliberately not
  treated as a routine read.
- **No provider gets visual data by default**: `eyesAllowedProviders` is
  empty out of the box. Neither the ambient system-prompt summary
  (`VisualContextAdapter`) nor a tool-attached frame
  (`eyes_get_visual_state`) reaches a given AI provider unless that
  provider's id is explicitly added to this list — checked fresh on
  every turn in `agent/orchestrator.ts`, not cached.
- **Capability-gated, never forced**: an image is only ever forwarded to
  a model whose `ModelCapabilities.vision` is true for the model actually
  in use that turn; a non-vision model simply never receives one, rather
  than receiving unusable data or the request silently degrading in some
  other way.
- **No retention by default**: `VisualState` lives only in server memory
  for the life of the process; a captured frame lives only in memory for
  the current agent turn (`ChatMessage.images`) and is never handed to
  `conversationService.appendMessage`, so it never enters persisted
  conversation history.
- **The user can fully disable Eyes**: `eyesEnabled: false` (the default)
  means the engine never starts and no OS-level event hooks are ever
  registered — not merely "the model is told not to use it."
- **No screenshot fallback**: if a platform can't support the real
  event-driven implementation, every `VisualProvider` method throws
  `NotConfiguredError` with a specific reason. This is a security
  property as much as an honesty one — a silent fallback to a screenshot
  loop would be a much larger, much less visible attack surface (routine
  full-screen capture) than the code ever actually implements.

## Realtime voice and streaming: no security shortcuts for speed

Both the SSE streaming conversation endpoint and the realtime voice
pipeline (`voice/realtimeSession.ts`) call the exact same
`agent/orchestrator.ts` `runAgent()` function as the standard
request/response path — streaming only changes how *text* reaches the
caller (incremental `message.delta` events vs. one final string), not
whether a tool call still goes through schema validation, permission
checks, and the approval gate. A voice-triggered "delete that file" still
pauses for approval exactly like a typed one; the realtime pipeline speaks
a spoken notice ("I need your approval before I can continue with that")
rather than silently proceeding or silently failing.

Barge-in (interrupting Jarvis mid-response) only ever cancels *Jarvis's
own* in-flight work (the current TTS stream and agent run) via
`tasks/taskService.ts`'s `abortById` — it has no path to skip a pending
approval or grant one implicitly.

## Rate limiting and cost control

- All three AI provider clients use bounded exponential backoff
  (`ai/retry.ts`) on rate-limit/5xx responses — capped attempts, never an
  unbounded retry loop that could run up cost.
- The agent loop itself is bounded independently of any single provider
  call: `AGENT_MAX_STEPS`, `AGENT_MAX_EXECUTION_MS`, and
  `AGENT_MAX_TOOL_CALLS` all throw `AgentLoopLimitError` rather than
  allowing indefinite execution — verified in
  `tests/agent.orchestrator.test.ts` with a provider double that always
  requests another tool call.

## Audit logging

`security/audit.ts` records tool execution, permission denials, and
approval requests/decisions, independent of the general activity event
stream, specifically so security-relevant actions are easy to find without
wading through routine conversational events. Audit entries never include
raw secret values (same redaction pass as the event bus).

## Known gaps (tracked, not hidden)

- **Plugin sandboxing**: `plugins/pluginManager.ts` dynamically imports a
  local ES module and trusts it to behave — there is no process/container
  isolation yet. Only load plugins you've reviewed. This matches Section
  69's own requirement that arbitrary code execution needs sandboxing
  before it's exposed to untrusted plugin sources.
- **Permission grants are role-based, not per-integration**: an `owner`
  holds every permission a configured tool might declare. Finer-grained,
  per-integration consent (e.g. "this assistant may read but never send
  email") is a natural extension of `security/permissionService.ts` but
  isn't built yet.
- **No 2FA**: authentication is password + JWT only.
