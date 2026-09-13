# Development Guide

## Prerequisites

- Node.js 20+
- npm

That's it for local development — SQLite is the default database, no
Postgres/Redis/Docker required to get started.

## First-time setup

```bash
npm install
cp .env.example .env
npx prisma generate
npx prisma migrate dev --name init   # creates prisma/dev.db
npm run dev
```

The server starts on `http://localhost:4000`. With no AI provider API keys
set, `DEFAULT_AI_PROVIDER=mock` is used automatically — the mock provider
is fully deterministic and lets you exercise the entire agent loop (tool
calls, approvals, task state) with zero external credentials.

## Verifying a change

Run all of these before considering a change done — they're also what CI
should run:

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run build       # tsc -p tsconfig.build.json
npm test            # vitest, against prisma/test.db (auto-migrated by `pretest`)
```

All four are green as of this commit.

## Project layout

```
src/
  ai/            provider abstraction, router, retry/backoff, per-provider REST clients
  agent/         the orchestrator loop (non-streaming and streaming)
  api/           Fastify routes, error handling
  approvals/     approval request lifecycle
  auth/          JWT auth, password hashing, middleware
  activation/    wake-word event handling + real clap-detection DSP
  browser/       Playwright session management
  computer/      cross-platform computer control (apps, windows, files, input, screenshot, allowlisted commands)
  config/        env validation (zod), logger
  context/       system-prompt assembly (assistant identity lives here)
  conversation/  conversation + message persistence
  database/      Prisma client singleton
  events/        typed event bus
  eyes/          Jarvis Eyes visual-perception engine, attention management, Windows UI Automation/watcher, provider-neutral visual context adapter
  integrations/  GitHub, Shopify, email, Twilio, Google Calendar clients
  mcp/           MCP client manager
  memory/        memory CRUD + relevance-scored retrieval
  notifications/ notification delivery
  plugins/       dynamic local plugin loader
  realtime/      WebSocket gateway (general activity stream)
  scheduler/     cron-driven scheduled tasks
  security/      permission catalog, credential encryption, audit log
  settings/      persistent per-user identity/activation/voice settings
  tasks/         task/step state machine
  tools/         tool registry + builtin tools
  voice/         VAD, realtime session, activation gate, voice provider abstraction (ElevenLabs, OpenAI Whisper)
tests/           vitest suite (mirrors src/ layout roughly)
prisma/          schema + migrations
```

See also VOICE.md (realtime speech-to-speech pipeline), COMPUTER_CONTROL.md
(cross-platform desktop control), and EYES.md (visual perception + Windows
UI Automation) for deep dives into those subsystems, including exactly
what's verified in this sandbox versus what needs real hardware.

## Database

Prisma's `provider` is fixed per schema file — it can't be chosen from
`DATABASE_URL` at runtime. `prisma/schema.prisma` ships targeting SQLite.

**To switch to Postgres for production:**

1. Edit `prisma/schema.prisma`: change `provider = "sqlite"` to
   `provider = "postgresql"` under `datasource db`.
2. Delete `prisma/migrations/` (SQLite and Postgres migration SQL are not
   interchangeable) and run `npx prisma migrate dev --name init` against a
   real Postgres `DATABASE_URL` to generate a fresh migration history.
3. Commit the new `prisma/migrations/` directory.
4. In production, run `npx prisma migrate deploy` (the Docker entrypoint
   already does this automatically on container start).

## Adding a tool

Tools live in `src/tools/builtin/*.ts` and implement `ToolDefinition`
(`src/tools/types.ts`). Minimal shape:

```ts
export const myTool: ToolDefinition<z.infer<typeof inputSchema>> = {
  name: "my_tool",
  description: "...",
  version: "1.0.0",
  inputSchema,                 // zod schema — validated before execute() runs
  jsonSchema: zodToJsonSchema(inputSchema, "my_tool"),
  requiredPermissions: ["some.permission"],
  requiresApproval: false,     // true for anything consequential
  source: "builtin",
  async execute(input, ctx) {
    return { output: {...}, untrusted: false };
  },
};
```

Register it in `src/tools/builtinIndex.ts`. If the tool's risk depends on
its arguments (like `filesystem`'s read/write/delete), add a case to
`tools/permissionResolution.ts` rather than over-declaring the tool's
baseline permission.

## Adding an AI provider

Implement `AIProvider` (`src/ai/types.ts`) — `chat`, `chatStream`,
`getCapabilities`, `listModels`, `checkHealth`, `isConfigured`. Register it
in `src/ai/router.ts`'s `providers` map. The orchestrator and every route
only ever talk to the `AIProvider` interface, so nothing else needs to
change.

## Setting up optional integrations

- **Anthropic/OpenAI/Gemini**: set the corresponding `*_API_KEY` in `.env`.
- **GitHub**: a personal access token in `GITHUB_TOKEN` with the scopes
  your intended operations need (repo read, or repo write for
  issue creation).
- **Shopify**: create a custom app in your store admin, grant it the
  Admin API scopes you need, and set `SHOPIFY_SHOP_DOMAIN` (e.g.
  `your-store.myshopify.com`) and `SHOPIFY_ADMIN_ACCESS_TOKEN`.
- **Email**: any SMTP account (`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/
  `SMTP_PASS`). Gmail requires an app password, not your login password.
- **Twilio**: `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/
  `TWILIO_FROM_NUMBER` from the Twilio console. Outbound calls need a
  `twimlUrl` you host that returns TwiML — this backend places the call,
  it doesn't host the TwiML.
- **Google Calendar**: this backend does not implement an OAuth consent
  screen. Obtain a refresh token once, out-of-band — e.g. via
  [Google's OAuth Playground](https://developers.google.com/oauthplayground)
  with the `https://www.googleapis.com/auth/calendar` scope, using your
  own OAuth client — and set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/
  `GOOGLE_REFRESH_TOKEN`.
- **ElevenLabs**: `ELEVENLABS_API_KEY`, and optionally
  `ELEVENLABS_DEFAULT_VOICE_ID` (list available voices via
  `GET /voice/providers/elevenlabs/voices`). Prefer configuring it via
  `POST /integrations/credentials` (user-scoped, encrypted) over the env
  var for anything beyond a single-operator dev setup — see VOICE.md.
- **Computer control**: works with zero configuration for the LOW/MEDIUM/
  HIGH-risk tools. `computer_run_command` additionally requires
  `COMPUTER_COMMAND_ALLOWLIST` (comma-separated bare executable names) —
  empty by default, so nothing runs until you explicitly opt executables
  in. See COMPUTER_CONTROL.md, including how to run the backend on your
  own Windows/macOS/Linux machine so computer control actually controls
  *your* desktop.
- **Jarvis Eyes**: `PATCH /settings/eyes {"eyesEnabled": true}` on a
  Windows host running this backend starts real event-driven visual
  perception; every other platform reports `NotConfiguredError`
  honestly instead of a fake fallback. No AI provider receives any
  visual data until it's added to `eyesAllowedProviders` in the same
  settings call. See EYES.md.

Anything left unset reports `not_configured` via `/health` and
`/integrations` rather than silently pretending to work.

## Running with Docker

```bash
export JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
export CREDENTIAL_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
docker compose up --build
```

This runs the backend with the bundled SQLite database persisted to a
named volume. **Note**: the Dockerfile and compose file are written to be
correct (multi-stage build, Playwright system deps, migrations run at
container start) but have not been build-verified in this development
environment, which has no Docker daemon available. Build and smoke-test it
before relying on it in production.

## Known limitations to design around

See PROJECT_REQUIREMENTS.md's "Explicit non-goals" section, and VOICE.md/
COMPUTER_CONTROL.md/EYES.md for the detailed per-feature breakdown —
Windows/macOS computer control and any keyboard/mouse/screenshot
automation are real, standard code paths that this headless Linux
sandbox can't execute to verify; OAuth consent flows, wake-word DSP, a
Windows mouse-click native shim, plugin sandboxing, and the entire
Windows Eyes/UI-Automation watcher process are architected but not fully
verified in this environment, each for a specific documented reason
rather than being simply unfinished.
