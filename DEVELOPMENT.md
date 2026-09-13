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
  agent/         the orchestrator loop
  api/           Fastify routes, error handling
  approvals/     approval request lifecycle
  auth/          JWT auth, password hashing, middleware
  activation/    wake-word event handling + real clap-detection DSP
  browser/       Playwright session management
  config/        env validation (zod), logger
  context/       system-prompt assembly
  conversation/  conversation + message persistence
  database/      Prisma client singleton
  events/        typed event bus
  integrations/  GitHub, Shopify, email, Twilio, Google Calendar clients
  mcp/           MCP client manager
  memory/        memory CRUD + relevance-scored retrieval
  notifications/ notification delivery
  plugins/       dynamic local plugin loader
  realtime/      WebSocket gateway
  scheduler/     cron-driven scheduled tasks
  security/      permission catalog, credential encryption, audit log
  tasks/         task/step state machine
  tools/         tool registry + builtin tools
  voice/         voice provider abstraction (ElevenLabs, OpenAI Whisper)
tests/           vitest suite (mirrors src/ layout roughly)
prisma/          schema + migrations
```

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
  `GET /voice/providers/elevenlabs/voices`).

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

See PROJECT_REQUIREMENTS.md's "Explicit non-goals" section — computer
control, OAuth consent flows, wake-word DSP, and plugin sandboxing are
architected (permissions, interfaces, config) but not fully implemented.
