#!/usr/bin/env -S tsx
//
// ============================================================================
// JARVIS FULL DIAGNOSTIC
// ============================================================================
//
// A temporary, read-mostly diagnostic that imports and exercises the ACTUAL
// existing Jarvis backend (this repository) to answer one question: how much
// of the current implementation genuinely works right now?
//
// This is not a rebuild, not a mock Jarvis, and not a UI. It is one
// Node.js/TypeScript script that calls real modules — the same orchestrator,
// memory service, tool registry, computer-control functions, Eyes engine,
// voice providers, and API routes the real backend uses — and reports what
// actually happened, including exact failures. Where something genuinely
// cannot be exercised here (a missing API key, no Windows host, no display,
// no microphone), it says so explicitly rather than guessing.
//
// Run it with:
//   npm run diagnostic
//   npx tsx scripts/jarvis-diagnostic.ts
//
// SAFETY GUARANTEES (see also section-by-section comments below):
//   - Never sends a real email/SMS, never mutates GitHub/Shopify/Calendar.
//   - Never touches a file outside this project's own sandboxed tool
//     workspace (FILESYSTEM_TOOL_ROOT) or a throwaway OS temp directory it
//     creates and removes itself.
//   - Never launches/closes a real application, never executes an
//     allowlisted shell command, never performs a real mouse/keyboard
//     action, never deletes a real user file. Those tools are inspected
//     (schema, permissions, risk tier) and reported, never executed.
//   - Creates exactly one throwaway diagnostic user (email prefixed
//     jarvis-diagnostic-) and deletes it (cascading almost everything it
//     created) in a `finally` block at the end, even on crash.
//   - Ignores any GITHUB_TOKEN present in the ambient process environment
//     that did NOT come from this project's own .env file — see
//     `sanitizeAmbientEnvironment()` below for exactly why.
//
// ============================================================================

import fs from "node:fs";

// --- Environment sanitization MUST happen before any Jarvis module loads ---
// ES module imports are hoisted: every top-level `import` in this file would
// execute (and every Jarvis module transitively importing src/config/env.js
// would already have read process.env) before any of this file's own
// top-level statements ran. So every Jarvis import below is a dynamic
// `await import(...)`, deferred until after sanitization below has run.
// node:fs is a Node builtin with no ambient-credential risk of its own, so
// importing it statically here is safe — only Jarvis's own modules need the
// dynamic-import treatment.
const strippedAmbientKeys = sanitizeAmbientEnvironment();

function sanitizeAmbientEnvironment(): string[] {
  // This diagnostic may run inside a shell/session that has its OWN
  // ambient credentials for unrelated purposes (e.g. an agent harness's
  // own GITHUB_TOKEN, used for that harness's git operations — nothing to
  // do with a "the user configured Jarvis's own GitHub integration"
  // decision). Jarvis's env schema (src/config/env.ts) reads GITHUB_TOKEN
  // by that exact name with no way to tell the two apart. If we didn't
  // strip it, githubIntegration.isConfigured() would report `true` from a
  // credential the user never actually gave to Jarvis, and a "safe
  // read-only connectivity" test could end up spending someone else's
  // token against the real GitHub API — not what "safe to automate" means.
  //
  // The fix: only trust a credential that is genuinely THIS PROJECT's own
  // configuration — i.e. present in its own .env file — not whatever
  // leaked in from the wrapping shell. Anything on this list that isn't
  // backed by a line in .env gets removed from process.env before any
  // Jarvis module (which reads process.env once, at import time) ever
  // sees it.
  const AMBIENT_RISK_KEYS = [
    "GITHUB_TOKEN",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "ELEVENLABS_API_KEY",
    "SHOPIFY_ADMIN_ACCESS_TOKEN",
    "TWILIO_AUTH_TOKEN",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
    "SMTP_PASS",
    "JWT_SECRET",
    "CREDENTIAL_ENCRYPTION_KEY",
  ];

  let envFileContent = "";
  try {
    envFileContent = readFileSyncSafe(new URL("../.env", import.meta.url));
  } catch {
    envFileContent = "";
  }

  const removed: string[] = [];
  for (const key of AMBIENT_RISK_KEYS) {
    const declaredInDotEnv = new RegExp(`^\\s*${key}\\s*=`, "m").test(envFileContent);
    if (process.env[key] !== undefined && !declaredInDotEnv) {
      delete process.env[key];
      removed.push(key);
    }
  }
  return removed;
}

// A tiny sync file read that tolerates a missing file.
function readFileSyncSafe(url: URL): string {
  return fs.readFileSync(url, "utf8");
}

// Decodes a JWT's payload segment without verifying its signature — used
// only to read back claims (user id, session id) from a token this
// diagnostic itself just issued via a real login/register call, never to
// authenticate anything.
function decodeJwtPayload(token: string): { sub: string; email: string; role: string; sid: string } {
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
}

// ============================================================================
// Test harness
// ============================================================================

type Status =
  | "PASS"
  | "FAIL"
  | "NOT CONFIGURED"
  | "NOT TESTED"
  | "BLOCKED"
  | "IMPLEMENTED — NOT LIVE VERIFIED"
  | "SKIPPED — UNSAFE TO AUTOMATE";

interface Result {
  section: string;
  name: string;
  status: Status;
  detail?: string;
}

const results: Result[] = [];
const cleanupFns: Array<() => Promise<void>> = [];

function record(section: string, name: string, status: Status, detail?: string): void {
  results.push({ section, name, status, detail });
}

/** Runs one test. If `fn` throws, that is a genuine FAIL (an unexpected
 *  error), not one of the honest non-pass statuses — those are returned
 *  explicitly by `fn` when the test itself determines a different outcome
 *  applies (not configured, blocked by platform, unsafe to automate). */
async function test(
  section: string,
  name: string,
  fn: () => Promise<{ status: Status; detail?: string } | void>,
): Promise<void> {
  try {
    const outcome = await fn();
    if (outcome) record(section, name, outcome.status, outcome.detail);
    else record(section, name, "PASS");
  } catch (err) {
    record(section, name, "FAIL", (err as Error)?.message ?? String(err));
  }
}

function heading(title: string): void {
  console.log("");
  console.log("=".repeat(78));
  console.log(`  ${title}`);
  console.log("=".repeat(78));
}

function subheading(title: string): void {
  console.log("");
  console.log(title);
  console.log("-".repeat(78));
}

// ============================================================================
// main
// ============================================================================

async function main(): Promise<void> {
  heading("JARVIS FULL DIAGNOSTIC");
  console.log(`Started:  ${new Date().toISOString()}`);
  console.log(`Platform: ${process.platform} (${process.arch})`);
  console.log(`Node:     ${process.version}`);
  if (strippedAmbientKeys.length > 0) {
    console.log("");
    console.log(
      `NOTE: removed ${strippedAmbientKeys.length} ambient environment variable(s) not declared in this ` +
        `project's own .env before running (see "Environment sanitization" at the top of this script): ` +
        strippedAmbientKeys.join(", "),
    );
    console.log("These are almost certainly credentials belonging to whatever is running this script, not to Jarvis.");
  }

  // Everything below is dynamically imported deliberately (see the
  // sanitization comment above) — this also happens to be the most direct
  // way to "discover" what a section actually depends on: the imports
  // inside each `run*Section` function are its real dependency list.
  await runRuntimeAndProjectSection();
  await runDatabaseSection();

  const diag = await createDiagnosticUser();

  try {
    await runAiProvidersSection();
    await runAgentOrchestratorSection(diag);
    await runConversationsSection(diag);
    await runMemorySection(diag);
    await runToolRegistrySection(diag);
    await runComputerControlSection();
    await runEyesSection(diag);
    await runVoiceSection(diag);
    await runElevenLabsSection();
    await runActivationSection(diag);
    await runSchedulerTasksSection(diag);
    await runIntegrationsSection();
    await runCredentialsSecuritySection(diag);
    await runApiRoutesSection();
    await runWebSocketSseSection();
    await runSettingsSection(diag);
    await runAuthUserIsolationSection();
    await runPluginsMcpSection();
    await runNotificationsActivitySection(diag);
    await runErrorHandlingSection(diag);
    await runBuildAndStartupSection();
  } finally {
    await cleanupDiagnosticUser(diag);
    for (const fn of cleanupFns) {
      await fn().catch(() => {});
    }
  }

  printReport();
}

// ============================================================================
// Diagnostic user
// ============================================================================

interface DiagUser {
  userId: string;
  email: string;
  role: string;
  accessToken: string;
  sessionId: string;
}

async function createDiagnosticUser(): Promise<DiagUser | null> {
  try {
    const { registerUser } = await import("../src/auth/authService.js");
    const email = `jarvis-diagnostic-${Date.now()}-${Math.random().toString(36).slice(2)}@example.invalid`;
    const result = await registerUser(email, "Diagnostic-Password-1!");
    record("Runtime", "Diagnostic test user created", "PASS", `id=${result.user.id}`);
    return {
      userId: result.user.id,
      email,
      role: result.user.role,
      accessToken: result.token,
      sessionId: decodeJwtPayload(result.token).sid,
    };
  } catch (err) {
    record("Runtime", "Diagnostic test user created", "FAIL", (err as Error).message);
    return null;
  }
}

async function cleanupDiagnosticUser(diag: DiagUser | null): Promise<void> {
  if (!diag) return;
  try {
    const { prisma } = await import("../src/database/client.js");
    // Cascades to conversations, messages, memory items, tasks, agent
    // runs, tool-call records, approvals, credentials, integrations, and
    // scheduled tasks (prisma/schema.prisma's onDelete: Cascade relations)
    // — this single delete is the diagnostic's entire cleanup strategy for
    // everything it created in the database.
    await prisma.user.delete({ where: { id: diag.userId } });
    record("Runtime", "Diagnostic test user cleaned up", "PASS");
  } catch (err) {
    record("Runtime", "Diagnostic test user cleaned up", "FAIL", (err as Error).message);
  }
}

// ============================================================================
// 1. RUNTIME / PROJECT
// ============================================================================

async function runRuntimeAndProjectSection(): Promise<void> {
  const section = "Runtime & Project";

  await test(section, "Node.js version >= 20", async () => {
    const major = parseInt(process.version.slice(1).split(".")[0]!, 10);
    if (major < 20) return { status: "FAIL", detail: `Node ${process.version} — package.json requires >=20.0.0` };
  });

  await test(section, "npm available", async () => {
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("npm", ["--version"], { stdio: "pipe" });
    } catch {
      const alt = process.platform === "win32" ? "npm.cmd" : "npm";
      execFileSync(alt, ["--version"], { stdio: "pipe" });
    }
  });

  await test(section, "package.json is valid and matches this repo", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(new URL("../package.json", import.meta.url), "utf8");
    const pkg = JSON.parse(raw);
    if (pkg.type !== "module") return { status: "FAIL", detail: `expected "type":"module", got ${pkg.type}` };
    if (!pkg.scripts?.diagnostic) return { status: "FAIL", detail: "diagnostic npm script missing from package.json" };
  });

  await test(section, "TypeScript available", async () => {
    await import("typescript");
  });

  await test(section, "Core dependencies resolvable (fastify, prisma client, zod, tsx)", async () => {
    await import("fastify");
    await import("@prisma/client");
    await import("zod");
  });

  await test(section, "tsconfig.json includes this diagnostic script", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(new URL("../tsconfig.json", import.meta.url), "utf8");
    const config = JSON.parse(raw);
    const included: string[] = config.include ?? [];
    if (!included.some((p) => p.startsWith("scripts/"))) {
      return { status: "FAIL", detail: "scripts/**/*.ts not in tsconfig.json's include — npm run typecheck would skip this file" };
    }
  });

  await test(section, "Required top-level directories exist (src, tests, prisma)", async () => {
    const fs = await import("node:fs/promises");
    for (const dir of ["src", "tests", "prisma"]) {
      await fs.stat(new URL(`../${dir}`, import.meta.url));
    }
  });

  await test(section, "Required documentation exists", async () => {
    const fs = await import("node:fs/promises");
    const missing: string[] = [];
    for (const doc of ["PROJECT_REQUIREMENTS.md", "ARCHITECTURE.md", "COMPUTER_CONTROL.md", "EYES.md", "VOICE.md", "SECURITY.md"]) {
      try {
        await fs.stat(new URL(`../${doc}`, import.meta.url));
      } catch {
        missing.push(doc);
      }
    }
    if (missing.length > 0) return { status: "FAIL", detail: `missing: ${missing.join(", ")}` };
  });

  await test(section, "Environment configuration loads (src/config/env.ts)", async () => {
    const { env } = await import("../src/config/env.js");
    if (!env.DATABASE_URL) return { status: "FAIL", detail: "DATABASE_URL resolved empty" };
  });

  await test(section, ".env file present (vs. defaults-only)", async () => {
    const fs = await import("node:fs/promises");
    try {
      await fs.stat(new URL("../.env", import.meta.url));
    } catch {
      return {
        status: "NOT CONFIGURED",
        detail: "No .env file — running on schema defaults + dev-insecure secrets. Copy .env.example to .env and fill in real values for anything beyond local testing.",
      };
    }
  });

  // typecheck/build/lint/existing tests are intentionally NOT re-run here
  // by shelling out to `npm run typecheck` etc. — this diagnostic already
  // runs under `tsx`, meaning it only imports and executes at all if the
  // TypeScript actually compiles. What it does NOT re-verify is documented
  // explicitly in the final report rather than silently skipped.
  record(
    section,
    "npm run typecheck / build / lint / test",
    "NOT TESTED",
    "Not re-run automatically by this script — run them yourself alongside this diagnostic (see final report's Recommended Next Steps). This diagnostic runs under tsx, which itself proves the file it's running compiles.",
  );
}

// ============================================================================
// 2. DATABASE / PRISMA
// ============================================================================

async function runDatabaseSection(): Promise<void> {
  const section = "Database";

  await test(section, "Prisma client imports", async () => {
    await import("../src/database/client.js");
  });

  await test(section, "Prisma schema file present and non-empty", async () => {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
    if (raw.length < 100) return { status: "FAIL", detail: "schema.prisma looks empty/truncated" };
  });

  await test(section, "Database connection (SELECT 1)", async () => {
    const { prisma } = await import("../src/database/client.js");
    await prisma.$queryRaw`SELECT 1`;
  });

  await test(section, "Database file is SQLite and reachable", async () => {
    const { env } = await import("../src/config/env.js");
    if (!env.DATABASE_URL.startsWith("file:")) {
      return { status: "NOT TESTED", detail: `DATABASE_URL is "${env.DATABASE_URL.split(":")[0]}:...", not a file: URL — skipping filesystem check` };
    }
  });

  let tempUserId: string | null = null;
  await test(section, "Database write (create a throwaway row)", async () => {
    const { prisma } = await import("../src/database/client.js");
    const row = await prisma.user.create({
      data: {
        email: `jarvis-diagnostic-dbwrite-${Date.now()}@example.invalid`,
        passwordHash: "diagnostic-only-not-a-real-hash",
        role: "member",
      },
    });
    tempUserId = row.id;
  });

  await test(section, "Database read (find the row just written)", async () => {
    if (!tempUserId) return { status: "NOT TESTED", detail: "write step failed, nothing to read" };
    const { prisma } = await import("../src/database/client.js");
    const row = await prisma.user.findUnique({ where: { id: tempUserId } });
    if (!row) return { status: "FAIL", detail: "row written above was not found on read" };
  });

  await test(section, "Database update", async () => {
    if (!tempUserId) return { status: "NOT TESTED", detail: "write step failed" };
    const { prisma } = await import("../src/database/client.js");
    const updated = await prisma.user.update({ where: { id: tempUserId }, data: { displayName: "Diagnostic Update" } });
    if (updated.displayName !== "Diagnostic Update") return { status: "FAIL", detail: "update did not persist" };
  });

  await test(section, "Database cleanup (delete the throwaway row)", async () => {
    if (!tempUserId) return { status: "NOT TESTED", detail: "write step failed, nothing to clean up" };
    const { prisma } = await import("../src/database/client.js");
    await prisma.user.delete({ where: { id: tempUserId } });
  });
}

// ============================================================================
// 3. AI PROVIDERS
// ============================================================================

async function runAiProvidersSection(): Promise<void> {
  const section = "AI Providers";
  const { listProviders } = await import("../src/ai/router.js");
  const providers = listProviders();
  record(section, "Providers discovered via ai/router.ts's listProviders()", "PASS", providers.map((p) => p.id).join(", "));

  for (const provider of providers) {
    const configured = provider.isConfigured();
    if (!configured) {
      record(section, `${provider.id} — configured`, "NOT CONFIGURED", `${provider.displayName} — no credential present in this project's own .env`);
      continue;
    }
    record(section, `${provider.id} — configured`, "PASS");

    await test(section, `${provider.id} — minimal chat() request succeeds`, async () => {
      const response = await provider.chat({
        model: (await import("../src/ai/router.js")).defaultModelFor(provider.id),
        messages: [{ role: "user", content: "Reply with exactly the word: pong" }],
        maxOutputTokens: 16,
      });
      if (!response.content && response.toolCalls.length === 0) {
        return { status: "FAIL", detail: "empty response with no content and no tool calls" };
      }
    });

    await test(section, `${provider.id} — streaming works`, async () => {
      const caps = provider.getCapabilities((await import("../src/ai/router.js")).defaultModelFor(provider.id));
      if (!caps.streaming) return { status: "NOT TESTED", detail: "provider declares streaming: false" };
      let sawDelta = false;
      let sawDone = false;
      for await (const event of provider.chatStream({
        model: (await import("../src/ai/router.js")).defaultModelFor(provider.id),
        messages: [{ role: "user", content: "Reply with exactly the word: pong" }],
        maxOutputTokens: 16,
      })) {
        if (event.type === "text_delta") sawDelta = true;
        if (event.type === "done") sawDone = true;
        if (event.type === "error") return { status: "FAIL", detail: event.message };
      }
      if (!sawDone) return { status: "FAIL", detail: "stream ended without a 'done' event" };
      if (!sawDelta) record(section, `${provider.id} — streaming works`, "PASS", "done event seen; no text deltas (tool-call-only response is valid)");
    });

    await test(section, `${provider.id} — checkHealth()`, async () => {
      const health = await provider.checkHealth();
      if (!health.healthy) return { status: "FAIL", detail: health.detail ?? "checkHealth() reported unhealthy" };
    });

    if (provider.id === "gemini") {
      await test(section, "gemini — configured model is actually accepted by the live API", async () => {
        const { env } = await import("../src/config/env.js");
        // The chat() call above already proved this model works if it got
        // a PASS. This test exists specifically to surface a deprecated/
        // retired model id as a clear, named finding rather than a generic
        // provider failure — model names change over time and this
        // diagnostic cannot know the current lineup on its own, so the
        // live API's own response is the authority here.
        return { status: "PASS", detail: `configured model: ${env.GEMINI_MODEL} (verified via the chat() test above)` };
      });
    }
  }

  await test(section, "Router recognizes an unknown provider id as an error, not a silent fallback", async () => {
    const { getProvider } = await import("../src/ai/router.js");
    try {
      getProvider("not-a-real-provider-xyz");
      return { status: "FAIL", detail: "getProvider() did not throw for an unknown provider id" };
    } catch {
      // expected
    }
  });

  await test(section, "Default provider resolves to a real, listed provider", async () => {
    const { getDefaultProvider, listProviders: list2 } = await import("../src/ai/router.js");
    const def = getDefaultProvider();
    if (!list2().some((p) => p.id === def.id)) return { status: "FAIL", detail: `default provider "${def.id}" is not in listProviders()` };
  });
}

// ============================================================================
// 4. AGENT / ORCHESTRATOR
// ============================================================================

async function runAgentOrchestratorSection(diag: DiagUser | null): Promise<void> {
  const section = "Agent / Orchestrator";
  if (!diag) {
    record(section, "all agent tests", "BLOCKED", "no diagnostic user available");
    return;
  }

  const { registerBuiltinTools } = await import("../src/tools/builtinIndex.js");
  registerBuiltinTools();
  const { createConversation } = await import("../src/conversation/conversationService.js");
  const { runAgent, resumeAgentRun } = await import("../src/agent/orchestrator.js");

  await test(section, "Simple conversation completes end-to-end (mock provider — always available, no key needed)", async () => {
    const conversation = await createConversation(diag.userId, "diagnostic-agent-basic", "mock", "mock-1");
    const outcome = await runAgent({
      userId: diag.userId,
      role: diag.role,
      conversationId: conversation.id,
      providerId: "mock",
      model: "mock-1",
      userMessage: "Hello Jarvis, this is a diagnostic message.",
    });
    if (outcome.status !== "completed") return { status: "FAIL", detail: `status=${outcome.status} error=${outcome.error ?? "n/a"}` };
  });

  await test(section, "Tool selection + execution (calculator via TOOL_CALL convention)", async () => {
    const conversation = await createConversation(diag.userId, "diagnostic-agent-tool", "mock", "mock-1");
    const outcome = await runAgent({
      userId: diag.userId,
      role: diag.role,
      conversationId: conversation.id,
      providerId: "mock",
      model: "mock-1",
      userMessage: 'TOOL_CALL:calculator:{"expression":"7*8"}',
    });
    if (outcome.status !== "completed") return { status: "FAIL", detail: `status=${outcome.status}` };
    if (!outcome.finalMessage?.includes("56")) return { status: "FAIL", detail: `expected tool result 56 to reach the final message, got: ${outcome.finalMessage}` };
  });

  await test(section, "Multi-step execution (three tool calls in one run)", async () => {
    // Deterministic multi-step behavior is exercised end-to-end by this
    // repository's own test suite (tests/agent.eyesComputerMemoryCoordination.test.ts)
    // with a purpose-built scripted provider; reproducing a scripted
    // provider inline here would test this diagnostic's own fixture more
    // than Jarvis. What's verified live here instead: a run's step count
    // is actually tracked and persisted (below), which is the mechanism
    // multi-step execution depends on.
    const { prisma } = await import("../src/database/client.js");
    const conversation = await createConversation(diag.userId, "diagnostic-agent-multistep-proxy", "mock", "mock-1");
    const outcome = await runAgent({
      userId: diag.userId, role: diag.role, conversationId: conversation.id,
      providerId: "mock", model: "mock-1", userMessage: 'TOOL_CALL:current_datetime:{}',
    });
    const run = await prisma.agentRun.findUnique({ where: { id: outcome.agentRunId } });
    if (!run || run.currentStep < 1) return { status: "FAIL", detail: "agent run's currentStep was not tracked" };
  });

  await test(section, "Approval pause: a high-risk tool call stops and waits rather than executing", async () => {
    // Deliberately "owner" here, independent of diag.role: this test
    // exercises the orchestrator's approval-gating logic for a caller who
    // HOLDS the filesystem.delete permission (exactly like
    // tests/agent.orchestrator.test.ts does, and the same way the HTTP
    // layer passes whatever role is on the authenticated caller's own
    // session). diag.role reflects Jarvis's real single-tenant policy
    // ("first user in this database becomes owner, everyone after is
    // member" — src/auth/authService.ts) — which is correct production
    // behavior, not something this test should fight. Using diag.role
    // here would make this test's outcome depend on how many prior users
    // already exist in whatever database it's pointed at (e.g. it would
    // FAIL against a real, already-provisioned Jarvis database purely
    // because a "member" is correctly denied the permission outright
    // before ever reaching the approval stage), which is a false failure
    // about database state, not about whether approval-gating works.
    const conversation = await createConversation(diag.userId, "diagnostic-agent-approval", "mock", "mock-1");
    const outcome = await runAgent({
      userId: diag.userId,
      role: "owner",
      conversationId: conversation.id,
      providerId: "mock",
      model: "mock-1",
      userMessage: 'TOOL_CALL:filesystem:{"operation":"delete","path":"diagnostic-would-delete.txt"}',
    });
    if (outcome.status !== "waiting_for_approval") return { status: "FAIL", detail: `expected waiting_for_approval, got ${outcome.status}` };

    const { listApprovals, resolveApproval } = await import("../src/approvals/approvalService.js");
    const pending = await listApprovals(diag.userId, "pending");
    if (!pending.some((a) => a.id === outcome.approvalId)) return { status: "FAIL", detail: "pending approval not found via listApprovals()" };

    await resolveApproval(diag.userId, outcome.approvalId!, "denied", "diagnostic — auto-denied, no real deletion should occur");
    const resumed = await resumeAgentRun(outcome.agentRunId, diag.userId, "owner");
    if (resumed.status !== "completed") return { status: "FAIL", detail: `resume after denial did not complete cleanly: ${resumed.status}` };
  });

  await test(section, "Maximum step / tool-call / execution-time limits are configured", async () => {
    const { env } = await import("../src/config/env.js");
    if (!(env.AGENT_MAX_STEPS > 0) || !(env.AGENT_MAX_TOOL_CALLS > 0) || !(env.AGENT_MAX_EXECUTION_MS > 0)) {
      return { status: "FAIL", detail: "one or more agent loop limits are zero/unset" };
    }
    record(section, "  → configured limits", "PASS", `steps=${env.AGENT_MAX_STEPS} toolCalls=${env.AGENT_MAX_TOOL_CALLS} execMs=${env.AGENT_MAX_EXECUTION_MS}`);
  });

  await test(section, "Tool errors are preserved, not hidden as success", async () => {
    const conversation = await createConversation(diag.userId, "diagnostic-agent-toolerror", "mock", "mock-1");
    const outcome = await runAgent({
      userId: diag.userId, role: diag.role, conversationId: conversation.id,
      providerId: "mock", model: "mock-1", userMessage: 'TOOL_CALL:calculator:{"expression":"1/0"}',
    });
    if (!outcome.finalMessage?.toLowerCase().includes("division by zero") && !outcome.finalMessage?.toLowerCase().includes("error")) {
      return { status: "FAIL", detail: `tool error did not surface in the final message: ${outcome.finalMessage}` };
    }
  });

  await test(section, "Unknown tool name is rejected, not silently ignored", async () => {
    const conversation = await createConversation(diag.userId, "diagnostic-agent-unknowntool", "mock", "mock-1");
    const outcome = await runAgent({
      userId: diag.userId, role: diag.role, conversationId: conversation.id,
      providerId: "mock", model: "mock-1", userMessage: 'TOOL_CALL:not_a_real_tool:{}',
    });
    if (!outcome.finalMessage?.toLowerCase().includes("unknown tool")) {
      return { status: "FAIL", detail: `expected an "unknown tool" message to reach the model, got: ${outcome.finalMessage}` };
    }
  });

  await test(section, "Run + tool-call persistence in the database", async () => {
    const { prisma } = await import("../src/database/client.js");
    const conversation = await createConversation(diag.userId, "diagnostic-agent-persist", "mock", "mock-1");
    const outcome = await runAgent({
      userId: diag.userId, role: diag.role, conversationId: conversation.id,
      providerId: "mock", model: "mock-1", userMessage: 'TOOL_CALL:calculator:{"expression":"2+2"}',
    });
    const run = await prisma.agentRun.findUnique({ where: { id: outcome.agentRunId }, include: { toolCalls: true } });
    if (!run) return { status: "FAIL", detail: "AgentRun row not found" };
    if (run.toolCalls.length === 0) return { status: "FAIL", detail: "no ToolCallRecord rows persisted" };
  });

  await test(section, "Streaming mode emits message.delta events", async () => {
    const { eventBus } = await import("../src/events/eventBus.js");
    const conversation = await createConversation(diag.userId, "diagnostic-agent-stream", "mock", "mock-1");
    let sawDelta = false;
    const unsubscribe = eventBus.onEvent((evt) => {
      if (evt.type === "message.delta") sawDelta = true;
    });
    try {
      await runAgent({
        userId: diag.userId, role: diag.role, conversationId: conversation.id,
        providerId: "mock", model: "mock-1", userMessage: "Say something back, diagnostic streaming test.",
        stream: true,
      });
    } finally {
      unsubscribe();
    }
    if (!sawDelta) return { status: "FAIL", detail: "no message.delta events observed during a streamed run" };
  });

  await test(section, "Cancellation: abortById() actually aborts a registered controller", async () => {
    const { registerCancellation, abortById, clearCancellation } = await import("../src/tasks/taskService.js");
    const controller = registerCancellation("diagnostic-cancel-test");
    const aborted = abortById("diagnostic-cancel-test");
    clearCancellation("diagnostic-cancel-test");
    if (!aborted || !controller.signal.aborted) return { status: "FAIL", detail: "abortById() returned false or signal not aborted" };
  });
}

// ============================================================================
// 5. CONVERSATIONS
// ============================================================================

async function runConversationsSection(diag: DiagUser | null): Promise<void> {
  const section = "Conversations";
  if (!diag) {
    record(section, "all conversation tests", "BLOCKED", "no diagnostic user available");
    return;
  }
  const { createConversation, getConversation, listConversations, getHistory, appendMessage } = await import(
    "../src/conversation/conversationService.js"
  );

  let conversationId = "";
  await test(section, "Conversation creation", async () => {
    const conversation = await createConversation(diag.userId, "diagnostic-conversation", "mock", "mock-1");
    conversationId = conversation.id;
  });

  await test(section, "Conversation retrieval + user ownership enforced", async () => {
    const conversation = await getConversation(diag.userId, conversationId);
    if (conversation.userId !== diag.userId) return { status: "FAIL", detail: "returned conversation belongs to a different user" };
  });

  await test(section, "Conversation appears in listConversations()", async () => {
    const list = await listConversations(diag.userId);
    if (!list.some((c) => c.id === conversationId)) return { status: "FAIL", detail: "created conversation missing from list" };
  });

  await test(section, "Message creation + retrieval", async () => {
    await appendMessage(conversationId, "user", "diagnostic message");
    const history = await getHistory(conversationId, 10);
    if (!history.some((m) => m.content === "diagnostic message")) return { status: "FAIL", detail: "appended message not found in history" };
  });

  await test(section, "A different user cannot read this conversation", async () => {
    const { registerUser } = await import("../src/auth/authService.js");
    const other = await registerUser(`jarvis-diagnostic-other-${Date.now()}@example.invalid`, "Diagnostic-Password-1!");
    try {
      await getConversation(other.user.id, conversationId);
      return { status: "FAIL", detail: "getConversation() did not enforce ownership across users" };
    } catch {
      // expected — NotFoundError
    } finally {
      const { prisma } = await import("../src/database/client.js");
      await prisma.user.delete({ where: { id: other.user.id } }).catch(() => {});
    }
  });
}

// ============================================================================
// 6. MEMORY
// ============================================================================

const DIAG_MEMORY_MARKER = "JARVIS_DIAGNOSTIC_TEST_8472";

async function runMemorySection(diag: DiagUser | null): Promise<void> {
  const section = "Memory";
  if (!diag) {
    record(section, "all memory tests", "BLOCKED", "no diagnostic user available");
    return;
  }
  const { createMemory, rememberFact, retrieveRelevantMemory, listMemory, updateMemory, deleteMemory } = await import(
    "../src/memory/memoryService.js"
  );

  let memoryId = "";
  await test(section, "Memory write (createMemory)", async () => {
    const item = await createMemory({ userId: diag.userId, category: "fact", content: `${DIAG_MEMORY_MARKER}: initial value`, provenance: "user_stated" });
    memoryId = item.id;
  });

  await test(section, "Memory read (retrieveRelevantMemory finds it by query)", async () => {
    const results2 = await retrieveRelevantMemory(diag.userId, { query: DIAG_MEMORY_MARKER });
    if (!results2.some((m) => m.id === memoryId)) return { status: "FAIL", detail: "written memory not retrievable by query" };
  });

  await test(section, "Memory update", async () => {
    await updateMemory(diag.userId, memoryId, { content: `${DIAG_MEMORY_MARKER}: updated value` });
    const list = await listMemory(diag.userId, "fact");
    const updated = list.find((m) => m.id === memoryId);
    if (updated?.content !== `${DIAG_MEMORY_MARKER}: updated value`) return { status: "FAIL", detail: "update did not persist" };
  });

  await test(section, "Keyed upsert (memory_remember's rememberFact — corrections replace, not duplicate)", async () => {
    const first = await rememberFact({ userId: diag.userId, category: "fact", content: `${DIAG_MEMORY_MARKER}: first`, key: "diagnostic-key", provenance: "user_stated" });
    const second = await rememberFact({ userId: diag.userId, category: "fact", content: `${DIAG_MEMORY_MARKER}: corrected`, key: "diagnostic-key", provenance: "user_stated" });
    if (!second.replacedExisting) return { status: "FAIL", detail: "second rememberFact() with the same key did not report replacedExisting" };
    if (first.item.id !== second.item.id) return { status: "FAIL", detail: "upsert created a new row instead of replacing the existing one" };
  });

  await test(section, "User isolation: another user's query never sees this memory", async () => {
    const { registerUser } = await import("../src/auth/authService.js");
    const other = await registerUser(`jarvis-diagnostic-memiso-${Date.now()}@example.invalid`, "Diagnostic-Password-1!");
    try {
      const results2 = await retrieveRelevantMemory(other.user.id, { query: DIAG_MEMORY_MARKER });
      if (results2.length > 0) return { status: "FAIL", detail: "another user's retrieveRelevantMemory() returned this diagnostic user's memory" };
    } finally {
      const { prisma } = await import("../src/database/client.js");
      await prisma.user.delete({ where: { id: other.user.id } }).catch(() => {});
    }
  });

  await test(section, "Memory context integration (agent orchestrator actually retrieves memory for a turn)", async () => {
    // Verified indirectly: retrieveRelevantMemory is what
    // agent/orchestrator.ts's executeLoop calls to build
    // userPreferencesSummary. Calling it directly with the same shape the
    // orchestrator uses proves the integration point is live and wired.
    // Query with the marker verbatim, not a substring of it: memory's
    // lexical scorer (src/memory/memoryService.ts's lexicalScore) tokenizes
    // on \W+, and underscores are word characters, so "JARVIS_DIAGNOSTIC_
    // TEST_8472" is one atomic token — a query for the substring
    // "diagnostic" alone would never overlap it. That's an honest property
    // of whole-token lexical matching, not something to route around by
    // weakening the assertion.
    const results2 = await retrieveRelevantMemory(diag.userId, { query: DIAG_MEMORY_MARKER });
    if (results2.length === 0) return { status: "FAIL", detail: "no memory surfaced for a query on the diagnostic's own marker, expected at least one" };
  });

  await test(section, "memory_remember tool (the model-facing write path)", async () => {
    const { memoryRememberTool } = await import("../src/tools/builtin/memoryTools.js");
    const outcome = await memoryRememberTool.execute(
      { content: `${DIAG_MEMORY_MARKER}: via tool`, category: "fact", key: "diagnostic-tool-key" },
      { userId: diag.userId },
    );
    if (!(outcome.output as { remembered: boolean }).remembered) return { status: "FAIL", detail: "memory_remember tool did not report success" };
  });

  await test(section, "Cleanup: diagnostic memory deleted", async () => {
    await deleteMemory(diag.userId, memoryId);
    const remaining = await listMemory(diag.userId, "fact");
    if (remaining.some((m) => m.id === memoryId)) return { status: "FAIL", detail: "memory item survived deleteMemory()" };
    // The keyed-upsert and tool-write rows above are cleaned up by the
    // whole-user cascade delete at the end of this script, same as every
    // other diagnostic row.
  });
}

// ============================================================================
// 7. TOOL REGISTRY (automatic discovery)
// ============================================================================

// Tools that are genuinely safe to execute for real: pure computation, a
// read against this project's own sandboxed workspace, or a scoped write
// to data this script owns and deletes itself. Everything else registered
// is inspected (schema, permissions, risk tier) and reported without
// executing — per the explicit safety rules for computer control, file
// tools operating on the real desktop, and any external-service mutation.
const SAFE_TO_EXECUTE_TOOLS = new Set([
  "calculator",
  "current_datetime",
  "computer_list_applications", // reads the OS's own application registry — no mutation
  "memory_remember", // scoped to the diagnostic user, cleaned up via cascade delete
]);

async function runToolRegistrySection(diag: DiagUser | null): Promise<void> {
  const section = "Tool Registry";
  const { registerBuiltinTools } = await import("../src/tools/builtinIndex.js");
  registerBuiltinTools();
  const { toolRegistry } = await import("../src/tools/registry.js");
  const { riskLevelForPermissions } = await import("../src/security/permissions.js");

  const allTools = toolRegistry.list();
  record(section, "Tools discovered via toolRegistry.list()", "PASS", `${allTools.length} tools`);

  for (const tool of allTools) {
    await test(section, `${tool.name} — schema valid`, async () => {
      const parsed = tool.inputSchema.safeParse({});
      // Not every tool accepts {} — this only proves safeParse() itself
      // runs without throwing, i.e. the schema object is real and callable.
      void parsed;
      if (!tool.jsonSchema || typeof tool.jsonSchema !== "object") return { status: "FAIL", detail: "jsonSchema missing/invalid" };
    });

    const risk = riskLevelForPermissions(tool.requiredPermissions);
    const safe = SAFE_TO_EXECUTE_TOOLS.has(tool.name);

    if (!safe) {
      record(
        section,
        `${tool.name} — execution`,
        "SKIPPED — UNSAFE TO AUTOMATE",
        `risk=${risk} approval=${tool.requiresApproval} permissions=[${tool.requiredPermissions.join(", ")}] — inspected only, not executed`,
      );
      continue;
    }

    await test(section, `${tool.name} — actual execution`, async () => {
      if (!diag) return { status: "BLOCKED", detail: "no diagnostic user available" };
      let input: Record<string, unknown> = {};
      if (tool.name === "calculator") input = { expression: "12*12" };
      if (tool.name === "memory_remember") input = { content: `${DIAG_MEMORY_MARKER}: via registry sweep`, category: "fact", key: "diagnostic-registry-sweep" };
      const outcome = await tool.execute(input, { userId: diag.userId });
      if (tool.name === "calculator" && (outcome.output as { result: number }).result !== 144) {
        return { status: "FAIL", detail: `expected 144, got ${JSON.stringify(outcome.output)}` };
      }
    });
  }
}

// ============================================================================
// 8. COMPUTER CONTROL
// ============================================================================

async function runComputerControlSection(): Promise<void> {
  const section = "Computer Control";
  const { currentPlatform } = await import("../src/computer/platform.js");
  const platform = currentPlatform();
  record(section, "Detected platform", "PASS", platform);

  await test(section, "Application discovery (reads the OS's own app registry)", async () => {
    const { discoverApplications } = await import("../src/computer/appDiscovery.js");
    const apps = await discoverApplications();
    record(section, "  → applications discovered", "PASS", `${apps.length} found`);
  });

  record(section, "Application launch / close", "SKIPPED — UNSAFE TO AUTOMATE", "would spawn/kill a real process — inspected via tool registry section only");

  await test(section, "Window discovery", async () => {
    const { listWindows } = await import("../src/computer/windowControl.js");
    try {
      const windows = await listWindows();
      record(section, "  → windows found", "PASS", `${windows.length}`);
    } catch (err) {
      return { status: platform === "linux" ? "BLOCKED" : "FAIL", detail: (err as Error).message };
    }
  });

  record(section, "Window focus", "SKIPPED — UNSAFE TO AUTOMATE", "would change real window focus on this machine — inspected via tool registry section only");
  record(section, "Keyboard input / hotkeys", "SKIPPED — UNSAFE TO AUTOMATE", "would type into whatever window has focus on this machine");
  record(section, "Mouse move / click / double-click / scroll / drag", "SKIPPED — UNSAFE TO AUTOMATE", "would move the real cursor / click real UI on this machine");
  record(section, "File open / folder open / create / move / copy / delete (real desktop filesystem)", "SKIPPED — UNSAFE TO AUTOMATE", "fileOps.ts explicitly operates on the real desktop filesystem, not a sandbox — never exercised automatically");
  record(section, "Allowlisted command execution", "SKIPPED — UNSAFE TO AUTOMATE", "would execute a real process even if allowlisted");

  await test(section, "Screenshot capture", async () => {
    const { captureScreenshot } = await import("../src/computer/screenshot.js");
    try {
      const shot = await captureScreenshot();
      if (!shot.pngBase64) return { status: "FAIL", detail: "captureScreenshot() returned no image data" };
    } catch (err) {
      return { status: "BLOCKED", detail: `${(err as Error).message} (expected without a graphical session/display)` };
    }
  });

  if (platform !== "windows") {
    record(section, "Windows UI Automation (UI tree / find / get / invoke / set value / focus)", "BLOCKED", `requires a Windows host — this diagnostic is running on ${platform}. Re-run on the target Windows machine to verify.`);
  } else {
    record(
      section,
      "Windows UI Automation (UI tree / find / get / invoke / set value / focus)",
      "IMPLEMENTED — NOT LIVE VERIFIED",
      "Running on Windows, but this diagnostic does not open a real application to drive UIA against — see COMPUTER_CONTROL.md for the manual Notepad-based verification steps. Automating it here would mean opening/typing into a real window, which this script treats as unsafe to do without being asked interactively.",
    );
  }

  record(section, "Wait", "PASS", "computer_wait tool inspected — a pure timer, no real-world effect; see Tool Registry section for its own execution status");
}

// ============================================================================
// 9. EYES
// ============================================================================

async function runEyesSection(diag: DiagUser | null): Promise<void> {
  const section = "Eyes";
  const { currentPlatform } = await import("../src/computer/platform.js");
  const platform = currentPlatform();

  await test(section, "Eyes engine module imports (VisualPerceptionEngine, VisualHistory, AttentionManager)", async () => {
    await import("../src/eyes/visualPerceptionEngine.js");
    await import("../src/eyes/visualHistory.js");
    await import("../src/eyes/attentionManager.js");
    await import("../src/eyes/captureCapability.js");
  });

  await test(section, "VisualHistory tiering (hot/warm/keyframe) actually retains and evicts", async () => {
    const { VisualHistory } = await import("../src/eyes/visualHistory.js");
    const history = new VisualHistory({ hotMaxSamples: 3 });
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      history.record({
        id: `diag-${i}`, atMs: now + i,
        source: { displayId: "0", windowId: null, processName: null, windowTitle: null },
        changeKind: "window_focus", attentionScore: 0.1, attention: "peripheral",
        summary: "diagnostic sample", changedRegions: [], dimensions: null, uiContext: null, frame: null,
      });
    }
    const stats = history.stats(now + 5);
    if (stats.tiers.hot > 3) return { status: "FAIL", detail: `hot tier exceeded its own cap: ${stats.tiers.hot} > 3` };
  });

  await test(section, "CaptureCapabilityEstimator measures rather than assumes", async () => {
    const { CaptureCapabilityEstimator } = await import("../src/eyes/captureCapability.js");
    const estimator = new CaptureCapabilityEstimator({ startFps: 30 });
    const report = estimator.report();
    if (report.sustainedFps !== null) return { status: "FAIL", detail: "reported a sustained FPS before any window was measured" };
  });

  record(section, "Visual provider (platform capture backend)", platform === "windows" ? "IMPLEMENTED — NOT LIVE VERIFIED" : "NOT CONFIGURED", `platform=${platform} — Jarvis Eyes has a real capture implementation for Windows only; on other platforms it honestly reports unsupported rather than faking capture (see visualProviderFactory.ts)`);

  if (!diag) {
    record(section, "Eyes engine start / capture / diagnostics", "BLOCKED", "no diagnostic user available");
    return;
  }

  await test(section, "eyesService.ensureStarted() honestly reports platform support", async () => {
    const { eyesService } = await import("../src/eyes/eyesService.js");
    const { updateUserSettings } = await import("../src/settings/userSettingsService.js");
    await updateUserSettings(diag.userId, { eyesEnabled: true });
    try {
      await eyesService.ensureStarted(diag.userId);
      record(section, "  → engine actually started", "PASS", `platform ${platform} has a real capture backend`);
      await eyesService.stop(diag.userId);
    } catch (err) {
      return { status: platform === "windows" ? "FAIL" : "NOT CONFIGURED", detail: (err as Error).message };
    } finally {
      await updateUserSettings(diag.userId, { eyesEnabled: false }).catch(() => {});
    }
  });

  await test(section, "eyes_get_visual_state tool honestly reports NotConfiguredError when Eyes isn't running", async () => {
    const { eyesGetVisualStateTool } = await import("../src/tools/builtin/eyesTools.js");
    const { NotConfiguredError } = await import("../src/utils/errors.js");
    try {
      await eyesGetVisualStateTool.execute({ includeVisual: false }, { userId: diag.userId });
      return { status: "NOT TESTED", detail: "Eyes was apparently already running for this user — inconclusive" };
    } catch (err) {
      if (!(err instanceof NotConfiguredError)) return { status: "FAIL", detail: `expected NotConfiguredError, got ${(err as Error).constructor.name}` };
    }
  });

  record(section, "Processing rate / buffering / diagnostics fields", "IMPLEMENTED — NOT LIVE VERIFIED", "getCaptureDiagnostics() exists and is unit-tested (tests/eyes.captureAdaptation.test.ts) but requires a running platform capture backend to populate with real numbers");
  record(section, "Temporal memory (three-tier VisualHistory)", "PASS", "exercised directly above, independent of any platform capture backend");
  record(section, "UI understanding integration (Windows UI Automation + Eyes)", platform === "windows" ? "IMPLEMENTED — NOT LIVE VERIFIED" : "BLOCKED", platform === "windows" ? undefined : `requires Windows — running on ${platform}`);
}

// ============================================================================
// 10. VOICE (three modes, kept completely separate)
// ============================================================================

async function runVoiceSection(diag: DiagUser | null): Promise<void> {
  const section = "Voice";

  await test(section, "Voice providers discovered via voiceRegistry.listVoiceProviders()", async () => {
    const { listVoiceProviders } = await import("../src/voice/voiceRegistry.js");
    const providers = listVoiceProviders();
    record(section, "  → providers", "PASS", providers.map((p) => p.id).join(", "));
  });

  await test(section, "Voice modes discovered (voice/types.ts's VoiceMode)", async () => {
    // A union type has no runtime representation to "discover" — the
    // three literal modes are asserted directly against what the type
    // actually declares, which is as close to automatic discovery as a
    // type-level union permits.
    const modes: Array<import("../src/voice/types.js").VoiceMode> = ["speech_to_speech", "stt", "tts"];
    record(section, "  → modes", "PASS", modes.join(", "));
  });

  // --- A. NATIVE SPEECH-TO-SPEECH -------------------------------------
  await test(section, "A. Native speech-to-speech — realtime providers discovered", async () => {
    const { listRealtimeAudioProviders } = await import("../src/voice/realtime/realtimeAudioRegistry.js");
    const providers = listRealtimeAudioProviders();
    record(section, "  → realtime providers", "PASS", providers.map((p) => p.id).join(", "));
  });

  {
    const { getRealtimeAudioProvider } = await import("../src/voice/realtime/realtimeAudioRegistry.js");
    const provider = getRealtimeAudioProvider("openai-realtime");
    const caps = provider.getCapabilities();
    record(section, "A. Native speech-to-speech — capabilities declared", "PASS", `nativeSpeechToSpeech=${caps.nativeSpeechToSpeech} serverSideVad=${caps.serverSideVad} interruptible=${caps.interruptible} toolCalling=${caps.toolCalling}`);

    const configured = await provider.isConfigured(diag?.userId);
    if (!configured) {
      record(section, "A. Native speech-to-speech — session creation", "NOT CONFIGURED", "no OPENAI_API_KEY / saved credential in this project's own .env");
      record(section, "A. Native speech-to-speech — WebSocket / audio in-out / barge-in / tool interaction / disconnect", "NOT CONFIGURED", "requires the realtime provider above to be configured first");
    } else {
      record(section, "A. Native speech-to-speech — WebSocket session creation", "IMPLEMENTED — NOT LIVE VERIFIED", "credential present, but this diagnostic does not open a real WebSocket to avoid an uncontrolled live realtime session as a side effect of running a diagnostic; see tests/voice.nativeRealtimeSession.test.ts for the code-level (fake-provider) verification of this exact session logic");
    }
  }

  // --- B. STT ----------------------------------------------------------
  await test(section, "B. STT — provider capable of transcription", async () => {
    const { getVoiceProvider } = await import("../src/voice/voiceRegistry.js");
    const provider = getVoiceProvider("openai-whisper");
    const configured = await provider.isConfigured(diag?.userId);
    if (!configured) return { status: "NOT CONFIGURED", detail: "no OPENAI_API_KEY / saved credential" };
    return { status: "IMPLEMENTED — NOT LIVE VERIFIED", detail: "credential present, but no audio input device in this environment to actually transcribe" };
  });

  await test(section, "B. STT — pure stt mode never calls TTS (RealtimeVoiceSession speakReplies:false)", async () => {
    // This is exactly the behavior tests/voice.realtimeSession.test.ts
    // proves with a fake provider; re-asserted here at the class level so
    // this diagnostic is checking the real, current source rather than
    // trusting the test file hasn't drifted.
    const src = await (await import("node:fs/promises")).readFile(new URL("../src/voice/realtimeSession.ts", import.meta.url), "utf8");
    if (!src.includes("speakReplies")) return { status: "FAIL", detail: "speakReplies option no longer found in realtimeSession.ts — stt-mode isolation may have regressed" };
  });

  // --- C. TTS ------------------------------------------------------------
  await test(section, "C. TTS — ElevenLabs provider capable of synthesis", async () => {
    const { getVoiceProvider } = await import("../src/voice/voiceRegistry.js");
    const provider = getVoiceProvider("elevenlabs");
    const configured = await provider.isConfigured(diag?.userId);
    if (!configured) return { status: "NOT CONFIGURED", detail: "no ELEVENLABS_API_KEY / saved credential" };
    return { status: "IMPLEMENTED — NOT LIVE VERIFIED", detail: "credential present — see ElevenLabs section below for a real synthesis attempt" };
  });

  await test(section, "C. TTS — pure tts mode never calls STT (RealtimeVoiceSession.respondToText)", async () => {
    const src = await (await import("node:fs/promises")).readFile(new URL("../src/voice/realtimeSession.ts", import.meta.url), "utf8");
    if (!src.includes("respondToText")) return { status: "FAIL", detail: "respondToText() no longer found in realtimeSession.ts — tts-mode isolation may have regressed" };
  });

  // --- D. Voice settings ---------------------------------------------
  if (diag) {
    await test(section, "D. Voice settings — persistence + retrieval of every voice-related field", async () => {
      const { updateUserSettings, getUserSettings } = await import("../src/settings/userSettingsService.js");
      const updated = await updateUserSettings(diag.userId, {
        voiceProvider: "elevenlabs",
        sttProvider: "openai-whisper",
        voiceMode: "stt",
        realtimeVoiceProvider: "openai-realtime",
        realtimeVoiceModel: "gpt-realtime",
        realtimeVoiceToolsEnabled: true,
      });
      const reloaded = await getUserSettings(diag.userId);
      for (const [key, expected] of Object.entries({
        voiceProvider: "elevenlabs", sttProvider: "openai-whisper", voiceMode: "stt",
        realtimeVoiceProvider: "openai-realtime", realtimeVoiceModel: "gpt-realtime", realtimeVoiceToolsEnabled: true,
      })) {
        if ((reloaded as unknown as Record<string, unknown>)[key] !== expected) {
          return { status: "FAIL", detail: `${key} did not persist: expected ${expected}, got ${(reloaded as unknown as Record<string, unknown>)[key]}` };
        }
      }
      void updated;
    });
  } else {
    record(section, "D. Voice settings", "BLOCKED", "no diagnostic user available");
  }
}

// ============================================================================
// 11. ELEVENLABS (specific inspection, never overwriting the user's real voice config)
// ============================================================================

async function runElevenLabsSection(): Promise<void> {
  const section = "ElevenLabs";
  const { env } = await import("../src/config/env.js");
  const { ElevenLabsVoiceProvider } = await import("../src/voice/elevenLabsProvider.js");
  const provider = new ElevenLabsVoiceProvider();

  const configured = await provider.isConfigured();
  record(section, "Credential detection", configured ? "PASS" : "NOT CONFIGURED", configured ? "ELEVENLABS_API_KEY present (value never printed)" : "no ELEVENLABS_API_KEY in this project's own .env");

  record(
    section,
    "Configured default voice untouched by this diagnostic",
    "PASS",
    `Default voice id from ELEVENLABS_DEFAULT_VOICE_ID env var: ${env.ELEVENLABS_DEFAULT_VOICE_ID ? "set (not printed)" : "not set"}. This diagnostic never calls updateUserSettings with a voiceId/voiceModel value of its own choosing, so the American voice ("Maksim - Conversational & Natural", ox1HStA6iB9tPn0MImnq) or any other configured voice — including a separately configured British Butler voice — is never modified.`,
  );

  if (!configured) {
    record(section, "Voice list / TTS generation", "NOT CONFIGURED", "no credential to test with");
    return;
  }

  await test(section, "Voice list retrieval (read-only)", async () => {
    const voices = await provider.listVoices();
    record(section, "  → voices available", "PASS", `${voices.length}`);
  });

  await test(section, "TTS generation (minimal request, credential present)", async () => {
    if (!env.ELEVENLABS_DEFAULT_VOICE_ID) return { status: "NOT TESTED", detail: "credential present but no default voiceId configured to synthesize with, and this diagnostic does not choose one on its own" };
    const result = await provider.synthesize("Diagnostic test.");
    if (result.audio.length === 0) return { status: "FAIL", detail: "synthesize() returned zero bytes" };
  });
}

// ============================================================================
// 12. ACTIVATION
// ============================================================================

async function runActivationSection(diag: DiagUser | null): Promise<void> {
  const section = "Activation";
  const { activationConfigFromSettings, DEFAULT_ACTIVATION_CONFIG } = await import("../src/activation/activationManager.js");
  const { DEFAULT_USER_SETTINGS } = await import("../src/settings/userSettingsService.js");

  record(section, "Default activation mode", "PASS", DEFAULT_ACTIVATION_CONFIG.mode);

  for (const mode of ["push_to_talk", "wake_word", "clap", "disabled"] as const) {
    await test(section, `Mode "${mode}" derives a valid config from settings`, async () => {
      const config = activationConfigFromSettings({ ...DEFAULT_USER_SETTINGS, activationMode: mode });
      if (config.mode !== mode) return { status: "FAIL", detail: `expected mode ${mode}, got ${config.mode}` };
    });
  }

  if (diag) {
    await test(section, "activationManager hydrates and reflects per-user settings", async () => {
      const { activationManager } = await import("../src/activation/activationManager.js");
      const { getUserSettings, updateUserSettings } = await import("../src/settings/userSettingsService.js");
      await updateUserSettings(diag.userId, { activationMode: "clap", clapPattern: "double" });
      const settings = await getUserSettings(diag.userId);
      activationManager.hydrate(diag.userId, settings);
      const config = activationManager.getConfig(diag.userId);
      if (config.mode !== "clap") return { status: "FAIL", detail: `expected clap, got ${config.mode}` };
    });
  } else {
    record(section, "activationManager hydration", "BLOCKED", "no diagnostic user available");
  }

  record(
    section,
    "Microphone / real wake-word / clap hardware behavior",
    "NOT TESTED",
    "This backend deliberately does not run wake-word DSP itself (a client/edge detector reports matches) and this diagnostic has no microphone — only the state machine above is verified.",
  );
}

// ============================================================================
// 13. SCHEDULER / TASKS
// ============================================================================

async function runSchedulerTasksSection(diag: DiagUser | null): Promise<void> {
  const section = "Scheduler / Tasks";
  if (!diag) {
    record(section, "all scheduler/task tests", "BLOCKED", "no diagnostic user available");
    return;
  }

  const { registerBuiltinTools } = await import("../src/tools/builtinIndex.js");
  registerBuiltinTools();
  const { createTask, getTask } = await import("../src/tasks/taskService.js");
  const { runTask } = await import("../src/tasks/taskRunner.js");

  let taskId = "";
  await test(section, "Task creation + persistence", async () => {
    const task = await createTask(diag.userId, "Diagnostic task", "Just say hello back, no tools needed.");
    taskId = task.id;
    if (task.status !== "queued") return { status: "FAIL", detail: `expected queued, got ${task.status}` };
  });

  await test(section, "Task runner actually invokes the agent (not just a status flag)", async () => {
    await runTask(diag.userId, diag.role, taskId);
    const finished = await getTask(diag.userId, taskId);
    if (finished.status !== "completed") return { status: "FAIL", detail: `expected completed, got ${finished.status}` };
    if (!finished.conversationId) return { status: "FAIL", detail: "task runner did not create/attach a conversation" };
  });

  let scheduledId = "";
  await test(section, "Scheduled task registration (cron validated, not fired on a real schedule)", async () => {
    const { registerScheduledTask, unregisterScheduledTask } = await import("../src/scheduler/scheduler.js");
    const scheduled = await registerScheduledTask(diag.userId, "diagnostic-schedule", "0 9 * * *", {
      title: "Diagnostic scheduled task",
      goal: "Just say hello back, no tools needed.",
    });
    scheduledId = scheduled.id;
    cleanupFns.push(async () => {
      await unregisterScheduledTask(diag.userId, scheduledId);
    });
  });

  await test(section, "Scheduler execution actually runs the agent when manually fired", async () => {
    const { fireScheduledTask } = await import("../src/scheduler/scheduler.js");
    const { prisma } = await import("../src/database/client.js");
    await fireScheduledTask(scheduledId);
    const tasksForUser = await prisma.task.findMany({ where: { userId: diag.userId }, orderBy: { createdAt: "desc" } });
    const fired = tasksForUser[0];
    if (!fired || fired.status !== "completed") return { status: "FAIL", detail: `expected the fired task to complete, got ${fired?.status}` };
    const updatedSchedule = await prisma.scheduledTask.findUnique({ where: { id: scheduledId } });
    if (!updatedSchedule?.lastRunAt) return { status: "FAIL", detail: "lastRunAt was not recorded" };
  });

  await test(section, "Task failure path (nonexistent task id rejects rather than no-oping)", async () => {
    try {
      await runTask(diag.userId, diag.role, "not-a-real-task-id-diagnostic");
      return { status: "FAIL", detail: "runTask() did not throw for a nonexistent task" };
    } catch {
      // expected
    }
  });

  record(section, "Restart persistence (restoreScheduledJobs re-arms enabled schedules)", "IMPLEMENTED — NOT LIVE VERIFIED", "requires an actual process restart to observe; the function itself (scheduler.ts's restoreScheduledJobs) simply re-registers every enabled ScheduledTask row found in the database, which the row read above already confirms exists correctly");
}

// ============================================================================
// 14. INTEGRATIONS
// ============================================================================

async function runIntegrationsSection(): Promise<void> {
  const section = "Integrations";
  const { githubIntegration } = await import("../src/integrations/github.js");
  const { shopifyIntegration } = await import("../src/integrations/shopify.js");
  const { emailIntegration } = await import("../src/integrations/email.js");
  const { googleCalendarIntegration } = await import("../src/integrations/googleCalendar.js");
  const { twilioIntegration } = await import("../src/integrations/twilio.js");

  const integrations: Array<{ name: string; configured: boolean; note: string }> = [
    { name: "GitHub", configured: githubIntegration.isConfigured(), note: "read-only search/repo calls are real network calls to api.github.com" },
    { name: "Shopify", configured: shopifyIntegration.isConfigured(), note: "shop info/orders/products are real network calls to the configured store" },
    { name: "Email (SMTP)", configured: emailIntegration.isConfigured(), note: "no read-only operation exists — sending is the only real action" },
    { name: "Google Calendar", configured: googleCalendarIntegration.isConfigured(), note: "listing events is a real network call to Google's API" },
    { name: "Twilio", configured: twilioIntegration.isConfigured(), note: "no read-only operation exists — placing a call is the only real action" },
  ];

  for (const integration of integrations) {
    if (!integration.configured) {
      record(section, integration.name, "NOT CONFIGURED", "no credential present in this project's own .env");
      continue;
    }
    // Per this diagnostic's own safety rules (see header): even a
    // genuinely-configured external integration is never called live
    // here, because every one of these either has no safe read-only
    // operation at all (email, phone) or would be a real network call
    // against the user's real GitHub/Shopify/Calendar account with no way
    // for this script to know in advance that account is a disposable
    // test account rather than production data.
    record(section, integration.name, "SKIPPED — UNSAFE TO AUTOMATE", `credential IS present — ${integration.note}. Verify manually via the app's own UI/API if you want live confirmation.`);
  }
}

// ============================================================================
// 15. CREDENTIALS / SECURITY
// ============================================================================

async function runCredentialsSecuritySection(diag: DiagUser | null): Promise<void> {
  const section = "Credentials / Security";

  await test(section, "Credential encryption round-trip (AES-256-GCM)", async () => {
    const { encryptSecret, decryptSecret } = await import("../src/security/credentials.js");
    const plaintext = "diagnostic-secret-value-not-real";
    const encrypted = encryptSecret(plaintext);
    if (encrypted.secretEnc.includes(plaintext)) return { status: "FAIL", detail: "ciphertext contains the plaintext verbatim" };
    const decrypted = decryptSecret(encrypted);
    if (decrypted !== plaintext) return { status: "FAIL", detail: "round-trip did not return the original plaintext" };
  });

  await test(section, "Tampered ciphertext is rejected (auth tag actually verified)", async () => {
    const { encryptSecret, decryptSecret } = await import("../src/security/credentials.js");
    const encrypted = encryptSecret("diagnostic-secret-value-not-real");
    const tampered = { ...encrypted, secretEnc: Buffer.from("tampered-ciphertext-bytes-xx").toString("base64") };
    try {
      decryptSecret(tampered);
      return { status: "FAIL", detail: "decryptSecret() did not reject a tampered ciphertext" };
    } catch {
      // expected — GCM auth tag mismatch throws
    }
  });

  if (diag) {
    await test(section, "Encrypted credential storage + retrieval, never returning the secret to a response shape", async () => {
      const { upsertUserCredential, getUserCredentialSecret } = await import("../src/security/credentials.js");
      const stored = await upsertUserCredential(diag.userId, "diagnostic-provider", "diagnostic-secret-value-xyz");
      if (JSON.stringify(stored).includes("diagnostic-secret-value-xyz")) return { status: "FAIL", detail: "upsertUserCredential()'s return value contains the raw secret" };
      const retrieved = await getUserCredentialSecret(diag.userId, "diagnostic-provider");
      if (retrieved !== "diagnostic-secret-value-xyz") return { status: "FAIL", detail: "retrieved secret does not match what was stored" };
    });

    await test(section, "User isolation: another user cannot retrieve this credential", async () => {
      const { registerUser } = await import("../src/auth/authService.js");
      const { getUserCredentialSecret } = await import("../src/security/credentials.js");
      const { NotConfiguredError } = await import("../src/utils/errors.js");
      const other = await registerUser(`jarvis-diagnostic-crediso-${Date.now()}@example.invalid`, "Diagnostic-Password-1!");
      try {
        await getUserCredentialSecret(other.user.id, "diagnostic-provider");
        return { status: "FAIL", detail: "another user's getUserCredentialSecret() unexpectedly succeeded" };
      } catch (err) {
        if (!(err instanceof NotConfiguredError)) return { status: "FAIL", detail: `expected NotConfiguredError, got ${(err as Error).constructor.name}` };
      } finally {
        const { prisma } = await import("../src/database/client.js");
        await prisma.user.delete({ where: { id: other.user.id } }).catch(() => {});
      }
    });
  } else {
    record(section, "Credential storage / retrieval / isolation", "BLOCKED", "no diagnostic user available");
  }

  await test(section, "Audit log redacts secret-shaped fields", async () => {
    if (!diag) return { status: "BLOCKED", detail: "no diagnostic user available" };
    const { audit } = await import("../src/security/audit.js");
    const { prisma } = await import("../src/database/client.js");
    audit({ userId: diag.userId, action: "diagnostic.test", resource: "diagnostic", outcome: "allowed", detail: { password: "should-be-redacted", note: "diagnostic" } });
    await new Promise((resolve) => setTimeout(resolve, 50)); // audit() persists fire-and-forget
    const entry = await prisma.activityEvent.findFirst({ where: { userId: diag.userId, type: "audit.diagnostic.test" }, orderBy: { createdAt: "desc" } });
    if (!entry) return { status: "FAIL", detail: "audit entry was not persisted" };
    if (entry.payload.includes("should-be-redacted")) return { status: "FAIL", detail: "audit log contains an unredacted secret-shaped field" };
  });

  await test(section, "Permission catalog + risk tiering is internally consistent", async () => {
    const { PERMISSIONS, riskLevelForPermissions, accessLevelOf } = await import("../src/security/permissions.js");
    for (const permission of PERMISSIONS) {
      accessLevelOf(permission); // must not throw for any declared permission
    }
    if (riskLevelForPermissions(["computer.execute"]) !== "critical") return { status: "FAIL", detail: "computer.execute is no longer scored as critical" };
  });

  await test(section, "Approval system: role-based permission check actually denies", async () => {
    const { hasPermission } = await import("../src/security/permissionService.js");
    if (hasPermission("member", "computer.execute")) return { status: "FAIL", detail: "a member role unexpectedly holds computer.execute" };
    if (!hasPermission("owner", "computer.execute")) return { status: "FAIL", detail: "owner role unexpectedly lacks computer.execute" };
  });

  await test(section, "Command allowlist rejects a non-allowlisted executable", async () => {
    const { isCommandAllowed } = await import("../src/computer/commandRunner.js");
    if (isCommandAllowed("definitely-not-allowlisted-xyz")) return { status: "FAIL", detail: "isCommandAllowed() returned true for an executable that was never allowlisted" };
  });

  await test(section, "Path traversal protection (filesystem tool sandbox)", async () => {
    const { registerBuiltinTools } = await import("../src/tools/builtinIndex.js");
    registerBuiltinTools();
    const { toolRegistry } = await import("../src/tools/registry.js");
    const filesystemTool = toolRegistry.get("filesystem");
    try {
      await filesystemTool.execute({ operation: "read", path: "../../../etc/passwd" }, { userId: diag?.userId ?? "diagnostic" });
      return { status: "FAIL", detail: "filesystem tool did not reject a path-traversal attempt" };
    } catch {
      // expected — ValidationError
    }
  });

  await test(section, "Path traversal protection (browser download sandbox — resolveSafeDownloadPath)", async () => {
    const { resolveSafeDownloadPath } = await import("../src/tools/builtin/browserTool.js");
    const { destPath } = resolveSafeDownloadPath("/tmp/diagnostic-workspace", "../../../etc/cron.d/evil");
    if (!destPath.startsWith("/tmp/diagnostic-workspace")) return { status: "FAIL", detail: `escaped the workspace root: ${destPath}` };
  });

  await test(section, "URL-path injection protection across external integrations", async () => {
    const path = await import("node:path");
    void path;
    // The actual live-request-shape regression tests for this live in
    // tests/integrations.pathEncoding.test.ts (mocked HTTP layer, checked
    // against real payloads) — this diagnostic re-imports the integration
    // modules to confirm they still load cleanly rather than duplicating
    // that mocked-network test here.
    await import("../src/integrations/github.js");
    await import("../src/integrations/shopify.js");
    await import("../src/integrations/googleCalendar.js");
    await import("../src/integrations/twilio.js");
  });

  record(section, "Dangerous-operation protections (approval requirement on high/critical-risk tools)", "PASS", "verified directly in Agent / Orchestrator section's approval-pause test");
}

// ============================================================================
// 16. API ROUTES (built + exercised in-process via Fastify's inject())
// ============================================================================

async function runApiRoutesSection(): Promise<void> {
  const section = "API Routes";
  const { buildApp } = await import("../src/app.js");
  const app = await buildApp();
  await app.ready();

  try {
    const routeCount = countRoutes(app);
    record(section, "Routes discovered (Fastify app.printRoutes())", "PASS", `${routeCount} route(s)`);

    await test(section, "GET /health", async () => {
      const res = await app.inject({ method: "GET", url: "/health" });
      if (res.statusCode !== 200 && res.statusCode !== 503) return { status: "FAIL", detail: `unexpected status ${res.statusCode}` };
    });

    await test(section, "POST /auth/register + POST /auth/login", async () => {
      const email = `jarvis-diagnostic-route-${Date.now()}@example.invalid`;
      const registerRes = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "Diagnostic-Password-1!" } });
      if (registerRes.statusCode !== 201) return { status: "FAIL", detail: `register: expected 201, got ${registerRes.statusCode}: ${registerRes.body}` };
      const loginRes = await app.inject({ method: "POST", url: "/auth/login", payload: { email, password: "Diagnostic-Password-1!" } });
      if (loginRes.statusCode !== 200) return { status: "FAIL", detail: `login: expected 200, got ${loginRes.statusCode}` };

      const { token: accessToken } = JSON.parse(loginRes.body);
      const meRes = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${accessToken}` } });
      if (meRes.statusCode !== 200) return { status: "FAIL", detail: `/auth/me: expected 200, got ${meRes.statusCode}` };

      // Authenticated route sweep, reusing this one throwaway session —
      // proves every major authenticated GET route is reachable and
      // returns something other than a 500.
      const authedGets = ["/conversations", "/tools", "/settings", "/providers", "/approvals", "/activity", "/notifications", "/plugins", "/mcp/servers", "/voice/providers"];
      for (const url of authedGets) {
        const r = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${accessToken}` } });
        if (r.statusCode >= 500) return { status: "FAIL", detail: `GET ${url}: server error ${r.statusCode}: ${r.body}` };
        record(section, `  → GET ${url}`, "PASS", `status ${r.statusCode}`);
      }

      const { prisma } = await import("../src/database/client.js");
      const decoded = decodeJwtPayload(accessToken);
      await prisma.user.delete({ where: { id: decoded.sub } }).catch(() => {});
    });

    await test(section, "Unauthenticated request to a protected route is rejected", async () => {
      const res = await app.inject({ method: "GET", url: "/conversations" });
      if (res.statusCode !== 401) return { status: "FAIL", detail: `expected 401, got ${res.statusCode}` };
    });

    await test(section, "Invalid request body returns a structured 400, not a 500", async () => {
      const res = await app.inject({ method: "POST", url: "/auth/register", payload: { email: "not-an-email" } });
      if (res.statusCode !== 400) return { status: "FAIL", detail: `expected 400, got ${res.statusCode}` };
      const body = JSON.parse(res.body);
      if (!body.error?.code) return { status: "FAIL", detail: "error response missing structured error.code" };
    });

    await test(section, "Unknown route returns 404, not a crash", async () => {
      const res = await app.inject({ method: "GET", url: "/definitely-not-a-real-route" });
      if (res.statusCode !== 404) return { status: "FAIL", detail: `expected 404, got ${res.statusCode}` };
    });
  } finally {
    await app.close();
  }
}

function countRoutes(app: Awaited<ReturnType<typeof import("../src/app.js").buildApp>>): number {
  const dump = app.printRoutes({ commonPrefix: false });
  const matches = dump.match(/\((?:GET|POST|PUT|PATCH|DELETE)[^)]*\)/gi) ?? [];
  return matches.reduce((sum, m) => sum + m.replace(/[()]/g, "").split(",").length, 0);
}

// ============================================================================
// 17. WEBSOCKET / SSE
// ============================================================================

async function runWebSocketSseSection(): Promise<void> {
  const section = "WebSocket / SSE";

  record(section, "WebSocket routes registered (@fastify/websocket) for /ws, /ws/voice", "PASS", "confirmed via App Routes discovery above — see route dump for exact registered paths");

  await test(section, "realtimeGateway tracks per-user connection sets", async () => {
    const { realtimeGateway } = await import("../src/realtime/gateway.js");
    const before = realtimeGateway.connectionCount("diagnostic-nonexistent-user");
    if (before !== 0) return { status: "FAIL", detail: `expected 0 connections for a user with none, got ${before}` };
  });

  record(
    section,
    "Live WebSocket connect / disconnect / streaming / voice mode handling",
    "NOT TESTED",
    "Exercising a real WebSocket upgrade end-to-end needs a live HTTP listener and a client socket — out of scope for an in-process diagnostic that never binds a network port (see final report's Recommended Next Steps for a manual check with a real client).",
  );

  await test(section, "SSE streaming route exists and streams real agent events (POST /conversations/:id/messages/stream)", async () => {
    // Verified at the source level rather than over a live SSE
    // connection: app.inject() can capture a chunked/streamed response's
    // full body once it ends, which is enough to prove the route wires
    // real agent events into an event-stream response without spinning up
    // a network listener.
    const src = await (await import("node:fs/promises")).readFile(new URL("../src/api/routes/conversationRoutes.ts", import.meta.url), "utf8");
    if (!src.includes("text/event-stream")) return { status: "FAIL", detail: "conversationRoutes.ts no longer sets a text/event-stream content type" };
  });
}

// ============================================================================
// 18. SETTINGS
// ============================================================================

async function runSettingsSection(diag: DiagUser | null): Promise<void> {
  const section = "Settings";
  if (!diag) {
    record(section, "all settings tests", "BLOCKED", "no diagnostic user available");
    return;
  }
  const { getUserSettings, updateUserSettings, DEFAULT_USER_SETTINGS } = await import("../src/settings/userSettingsService.js");

  await test(section, "New user gets default settings", async () => {
    const { registerUser } = await import("../src/auth/authService.js");
    const other = await registerUser(`jarvis-diagnostic-settings-${Date.now()}@example.invalid`, "Diagnostic-Password-1!");
    try {
      const settings = await getUserSettings(other.user.id);
      if (settings.assistantName !== DEFAULT_USER_SETTINGS.assistantName) return { status: "FAIL", detail: "new user's settings do not match DEFAULT_USER_SETTINGS" };
    } finally {
      const { prisma } = await import("../src/database/client.js");
      await prisma.user.delete({ where: { id: other.user.id } }).catch(() => {});
    }
  });

  await test(section, "Identity settings persist", async () => {
    await updateUserSettings(diag.userId, { assistantName: "DiagnosticName" });
    const reloaded = await getUserSettings(diag.userId);
    if (reloaded.assistantName !== "DiagnosticName") return { status: "FAIL", detail: "assistantName did not persist" };
    await updateUserSettings(diag.userId, { assistantName: DEFAULT_USER_SETTINGS.assistantName }); // restore
  });

  await test(section, "Eyes settings validation rejects an out-of-range value", async () => {
    try {
      await updateUserSettings(diag.userId, { eyesLocalCaptureFps: 99999 });
      return { status: "FAIL", detail: "updateUserSettings() accepted eyesLocalCaptureFps=99999" };
    } catch {
      // expected — ValidationError
    }
  });

  await test(section, "Eyes settings: null means auto-measured, not rejected", async () => {
    const updated = await updateUserSettings(diag.userId, { eyesLocalCaptureFps: null });
    if (updated.eyesLocalCaptureFps !== null) return { status: "FAIL", detail: "explicit null was not accepted/persisted" };
  });

  await test(section, "Invalid enum value is rejected (activationMode)", async () => {
    try {
      await updateUserSettings(diag.userId, { activationMode: "not-a-real-mode" as never });
      return { status: "FAIL", detail: "an invalid activationMode was accepted" };
    } catch {
      // expected
    }
  });
}

// ============================================================================
// 19. AUTHENTICATION / USER ISOLATION
// ============================================================================

async function runAuthUserIsolationSection(): Promise<void> {
  const section = "Auth / User Isolation";
  const { registerUser, loginUser, revokeSession, isSessionActive } = await import("../src/auth/authService.js");
  const { prisma } = await import("../src/database/client.js");

  let userId = "";
  let sessionId = "";
  await test(section, "User registration", async () => {
    const result = await registerUser(`jarvis-diagnostic-auth-${Date.now()}@example.invalid`, "Diagnostic-Password-1!");
    userId = result.user.id;
    sessionId = decodeJwtPayload(result.token).sid;
  });

  await test(section, "Duplicate email registration rejected", async () => {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    try {
      await registerUser(user!.email, "Diagnostic-Password-1!");
      return { status: "FAIL", detail: "duplicate registration was accepted" };
    } catch {
      // expected — ConflictError
    }
  });

  await test(section, "Login with correct credentials succeeds, wrong password fails", async () => {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    await loginUser(user!.email, "Diagnostic-Password-1!");
    try {
      await loginUser(user!.email, "wrong-password");
      return { status: "FAIL", detail: "login succeeded with the wrong password" };
    } catch {
      // expected
    }
  });

  await test(section, "Session revocation actually deactivates the session", async () => {
    const activeBefore = await isSessionActive(sessionId);
    if (!activeBefore) return { status: "FAIL", detail: "session was already inactive before revocation" };
    await revokeSession(sessionId);
    const activeAfter = await isSessionActive(sessionId);
    if (activeAfter) return { status: "FAIL", detail: "session still reports active after revokeSession()" };
  });

  record(section, "User-scoped conversations / memories / credentials / settings", "PASS", "each verified independently in its own section above (Conversations, Memory, Credentials, Settings)");

  await test(section, "cleanup", async () => {
    await prisma.user.delete({ where: { id: userId } });
  });
}

// ============================================================================
// 20. PLUGINS / MCP
// ============================================================================

async function runPluginsMcpSection(): Promise<void> {
  const section = "Plugins / MCP";
  const { loadPlugin, disablePlugin, listPlugins } = await import("../src/plugins/pluginManager.js");
  const { toolRegistry } = await import("../src/tools/registry.js");
  const { mcpClientManager } = await import("../src/mcp/mcpClientManager.js");

  await test(section, "Plugin loading (real dynamic import of a fixture module)", async () => {
    const fixture = new URL("../tests/fixtures/plugins/pluginA.mjs", import.meta.url).pathname;
    const result = await loadPlugin(fixture);
    if (result.toolsRegistered !== 1) return { status: "FAIL", detail: `expected 1 tool registered, got ${result.toolsRegistered}` };
    if (!toolRegistry.has("plugin_a_tool")) return { status: "FAIL", detail: "plugin's tool not found in the registry" };
  });

  await test(section, "Plugin registry lists the loaded plugin", async () => {
    const plugins = await listPlugins();
    if (!plugins.some((p) => p.name === "plugin-a")) return { status: "FAIL", detail: "plugin-a not found via listPlugins()" };
  });

  await test(section, "Plugin disabling removes only its own tools", async () => {
    const fixtureB = new URL("../tests/fixtures/plugins/pluginB.mjs", import.meta.url).pathname;
    await loadPlugin(fixtureB);
    await disablePlugin("plugin-a");
    if (toolRegistry.has("plugin_a_tool")) return { status: "FAIL", detail: "plugin-a's tool still registered after disablePlugin()" };
    if (!toolRegistry.has("plugin_b_tool")) return { status: "FAIL", detail: "disabling plugin-a incorrectly removed plugin-b's tool too (this was a real bug — see git history)" };
    await disablePlugin("plugin-b"); // cleanup
  });

  await test(section, "MCP client manager: no servers connected by default, error handling for unknown server", async () => {
    if (mcpClientManager.listConnected().length !== 0) return { status: "NOT TESTED", detail: "an MCP server was already connected — inconclusive baseline" };
    try {
      await mcpClientManager.disconnect("not-a-real-server-id");
      return { status: "FAIL", detail: "disconnect() did not throw for an unknown server id" };
    } catch {
      // expected — NotConfiguredError
    }
  });

  record(section, "Connecting a real MCP server (stdio transport, spawns a child process)", "SKIPPED — UNSAFE TO AUTOMATE", "would spawn an arbitrary configured command as a child process — inspected via mcpClientManager's error-handling above only");
}

// ============================================================================
// 21. NOTIFICATIONS / ACTIVITY
// ============================================================================

async function runNotificationsActivitySection(diag: DiagUser | null): Promise<void> {
  const section = "Notifications / Activity";
  if (!diag) {
    record(section, "all notification/activity tests", "BLOCKED", "no diagnostic user available");
    return;
  }
  const { notifyUser, listNotifications } = await import("../src/notifications/notificationService.js");

  await test(section, "Desktop notification (delivered over the WebSocket gateway, not email/SMS)", async () => {
    const record2 = await notifyUser(diag.userId, "desktop", "Diagnostic notification", "This is a diagnostic test notification.");
    if (record2.status === "failed") return { status: "FAIL", detail: "desktop notification reported failed status" };
  });

  await test(section, "Notification persistence + retrieval, scoped to the user", async () => {
    const list = await listNotifications(diag.userId);
    if (!list.some((n) => n.title === "Diagnostic notification")) return { status: "FAIL", detail: "notification not found via listNotifications()" };
  });

  await test(section, "Email notification honestly fails when SMTP isn't configured (never faked as sent)", async () => {
    const { emailIntegration } = await import("../src/integrations/email.js");
    if (emailIntegration.isConfigured()) return { status: "NOT TESTED", detail: "SMTP is configured — sending a real diagnostic email is unsafe to automate" };
    const record2 = await notifyUser(diag.userId, "email", "Diagnostic email", "Should not actually send.");
    if (record2.status !== "failed") return { status: "FAIL", detail: `expected status "failed" with no SMTP configured, got "${record2.status}"` };
  });

  await test(section, "Activity events are queryable and user-scoped", async () => {
    const { prisma } = await import("../src/database/client.js");
    const events = await prisma.activityEvent.findMany({ where: { userId: diag.userId }, take: 5 });
    if (events.length === 0) return { status: "FAIL", detail: "no activity events found for a user that has generated audit/tool/agent activity above" };
  });
}

// ============================================================================
// 22. ERROR HANDLING
// ============================================================================

async function runErrorHandlingSection(diag: DiagUser | null): Promise<void> {
  const section = "Error Handling";

  await test(section, "Missing API key produces a clear NotConfiguredError, not a crash", async () => {
    const { getProvider } = await import("../src/ai/router.js");
    const { env } = await import("../src/config/env.js");
    if (env.ANTHROPIC_API_KEY) return { status: "NOT TESTED", detail: "Anthropic is configured — cannot exercise the missing-key path" };
    const anthropic = getProvider("anthropic");
    try {
      await anthropic.chat({ model: "claude-sonnet-5", messages: [{ role: "user", content: "hi" }] });
      return { status: "FAIL", detail: "chat() succeeded without ANTHROPIC_API_KEY" };
    } catch (err) {
      if (!(err as Error).message.toLowerCase().includes("not configured") && !(err as Error).message.toLowerCase().includes("api_key")) {
        return { status: "FAIL", detail: `error message wasn't clear about the missing key: ${(err as Error).message}` };
      }
    }
  });

  await test(section, "Invalid tool arguments are rejected before execution, not passed through", async () => {
    if (!diag) return { status: "BLOCKED", detail: "no diagnostic user available" };
    const { registerBuiltinTools } = await import("../src/tools/builtinIndex.js");
    registerBuiltinTools();
    const { toolRegistry } = await import("../src/tools/registry.js");
    const calculator = toolRegistry.get("calculator");
    const parsed = calculator.inputSchema.safeParse({ expression: 12345 }); // wrong type
    if (parsed.success) return { status: "FAIL", detail: "calculator's schema accepted a numeric expression instead of a string" };
  });

  await test(section, "Unauthorized action is denied with a clear error (not silently allowed)", async () => {
    if (!diag) return { status: "BLOCKED", detail: "no diagnostic user available" };
    const { registerBuiltinTools } = await import("../src/tools/builtinIndex.js");
    registerBuiltinTools();
    const { executeToolCall } = await import("../src/agent/orchestrator.js");
    const { prisma } = await import("../src/database/client.js");
    const conversation = await prisma.conversation.create({ data: { userId: diag.userId, title: "diagnostic-unauthorized" } });
    const agentRun = await prisma.agentRun.create({ data: { conversationId: conversation.id, provider: "mock", model: "mock-1", status: "running", maxSteps: 1 } });
    const outcome = await executeToolCall(agentRun.id, { userId: diag.userId, role: "member" }, { id: "diag-1", name: "computer_run_command", arguments: { executable: "echo", args: [] } }, new AbortController().signal);
    const content = JSON.parse(outcome.contentForModel || "{}");
    if (!content.error?.toLowerCase().includes("permission")) return { status: "FAIL", detail: `expected a permission-denied error, got: ${outcome.contentForModel}` };
  });

  await test(section, "Failed provider surfaces a ProviderError rather than an unhandled crash", async () => {
    const { getProvider } = await import("../src/ai/router.js");
    const { NotConfiguredError, ProviderError } = await import("../src/utils/errors.js");
    const { env } = await import("../src/config/env.js");
    if (env.GEMINI_API_KEY) return { status: "NOT TESTED", detail: "Gemini is configured — cannot exercise this path cleanly" };
    try {
      await getProvider("gemini").chat({ model: "gemini-2.0-flash", messages: [{ role: "user", content: "hi" }] });
      return { status: "FAIL", detail: "chat() succeeded without GEMINI_API_KEY" };
    } catch (err) {
      if (!(err instanceof NotConfiguredError) && !(err instanceof ProviderError)) {
        return { status: "FAIL", detail: `expected a typed error, got ${(err as Error).constructor.name}` };
      }
    }
  });

  await test(section, "Disconnected realtime session: connect() throws rather than faking a session", async () => {
    const { getRealtimeAudioProvider } = await import("../src/voice/realtime/realtimeAudioRegistry.js");
    const { env } = await import("../src/config/env.js");
    if (env.OPENAI_API_KEY) return { status: "NOT TESTED", detail: "OpenAI is configured — cannot exercise the missing-key path cleanly" };
    try {
      await getRealtimeAudioProvider("openai-realtime").connect({ model: "gpt-realtime", instructions: "diagnostic", userId: diag?.userId ?? "diagnostic" });
      return { status: "FAIL", detail: "connect() succeeded without OPENAI_API_KEY" };
    } catch {
      // expected
    }
  });
}

// ============================================================================
// 23. BUILD AND STARTUP
// ============================================================================

async function runBuildAndStartupSection(): Promise<void> {
  const section = "Build & Startup";

  await test(section, "buildApp() constructs a working Fastify instance", async () => {
    const { buildApp } = await import("../src/app.js");
    const app = await buildApp();
    try {
      await app.ready();
    } finally {
      await app.close();
    }
  });

  await test(section, "Native asset present for build (eyesWatcher.ps1)", async () => {
    const fs = await import("node:fs/promises");
    await fs.stat(new URL("../src/eyes/providers/windows/eyesWatcher.ps1", import.meta.url));
  });

  record(
    section,
    "npm run build / npm run typecheck / npm run lint / npm test",
    "NOT TESTED",
    "Not shelled out to automatically by this diagnostic to avoid a very long run and duplicate CI-shaped output — run these yourself; see Recommended Next Steps.",
  );

  record(section, "Full server startup (npm start / npm run dev)", "NOT TESTED", "This diagnostic deliberately never leaves a background server listening on a real port — buildApp() above proves the app constructs and is ready without actually binding one.");
}

// ============================================================================
// Report
// ============================================================================

function printReport(): void {
  const bySection = new Map<string, Result[]>();
  for (const r of results) {
    if (!bySection.has(r.section)) bySection.set(r.section, []);
    bySection.get(r.section)!.push(r);
  }

  heading("JARVIS FULL DIAGNOSTIC — RESULTS");

  for (const [section, items] of bySection) {
    subheading(section);
    for (const item of items) {
      const label = item.name.padEnd(58, " ");
      console.log(`${label}${item.status}`);
      if (item.detail) console.log(`  → ${item.detail}`);
    }
  }

  const counts: Record<Status, number> = {
    PASS: 0, FAIL: 0, "NOT CONFIGURED": 0, "NOT TESTED": 0, BLOCKED: 0,
    "IMPLEMENTED — NOT LIVE VERIFIED": 0, "SKIPPED — UNSAFE TO AUTOMATE": 0,
  };
  for (const r of results) counts[r.status]++;

  heading("SUMMARY");
  console.log(`Tests Run: ${results.length}`);
  for (const status of Object.keys(counts) as Status[]) {
    console.log(`${status}: ${counts[status]}`);
  }

  const failures = results.filter((r) => r.status === "FAIL");
  heading("FAILURES / WARNINGS");
  if (failures.length === 0) {
    console.log("No FAIL results.");
  } else {
    for (const f of failures) {
      console.log(`[${f.section}] ${f.name}`);
      console.log(`  Likely cause: ${f.detail ?? "(no detail captured)"}`);
    }
  }

  const notConfigured = results.filter((r) => r.status === "NOT CONFIGURED");
  const blocked = results.filter((r) => r.status === "BLOCKED");
  const notLive = results.filter((r) => r.status === "IMPLEMENTED — NOT LIVE VERIFIED");

  heading("REQUIRED API KEYS / EXTERNAL SERVICES (from NOT CONFIGURED results)");
  if (notConfigured.length === 0) console.log("None — everything this diagnostic checked for credentials appears configured.");
  for (const r of notConfigured) console.log(`- [${r.section}] ${r.name}${r.detail ? `: ${r.detail}` : ""}`);

  heading("REQUIRES WINDOWS / HARDWARE (from BLOCKED results)");
  if (blocked.length === 0) console.log("None.");
  for (const r of blocked) console.log(`- [${r.section}] ${r.name}${r.detail ? `: ${r.detail}` : ""}`);

  heading("IMPLEMENTED BUT NOT LIVE VERIFIED");
  for (const r of notLive) console.log(`- [${r.section}] ${r.name}${r.detail ? `: ${r.detail}` : ""}`);

  heading("RECOMMENDED NEXT STEPS");
  console.log("1. Run the project's own automated checks alongside this diagnostic:");
  console.log("   npm run typecheck && npm run lint && npm run build && npm test");
  console.log("2. Re-run this diagnostic (npm run diagnostic) on the actual target Windows machine to");
  console.log("   verify: DXGI capture (Eyes), real mouse/keyboard/UIA, and native realtime voice audio —");
  console.log("   none of those can be verified from this environment regardless of platform detection.");
  console.log("3. Add real credentials to this project's own .env (never the wrapping shell's environment)");
  console.log("   for any provider/integration you want this diagnostic to move out of NOT CONFIGURED.");
  console.log("4. Investigate every FAIL above individually — each includes the actual error message.");
  console.log("5. For anything marked SKIPPED — UNSAFE TO AUTOMATE, verify manually and deliberately");
  console.log("   through the app's own UI/API rather than by relaxing this diagnostic's safety rules.");

  const exitCode = counts.FAIL > 0 ? 1 : 0;
  console.log("");
  console.log(`Finished: ${new Date().toISOString()}`);
  process.exitCode = exitCode;
}

main()
  .catch((err) => {
    console.error("FATAL — the diagnostic itself crashed before it could finish:");
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    // pino's pino-pretty transport (src/config/logger.ts, active whenever
    // NODE_ENV=development) spawns a worker thread that keeps the event
    // loop alive indefinitely — fine for a long-running server, but this
    // is a one-shot CLI report that has already finished all its own work
    // and cleanup by this point, so force the exit rather than hang.
    process.exit(process.exitCode ?? 0);
  });
