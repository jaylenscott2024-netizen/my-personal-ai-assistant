import { describe, it, expect, beforeAll } from "vitest";
import { registerUser } from "../src/auth/authService.js";
import { createConversation } from "../src/conversation/conversationService.js";
import { runAgent, resumeAgentRun } from "../src/agent/orchestrator.js";
import { registerBuiltinTools } from "../src/tools/builtinIndex.js";
import { listApprovals, resolveApproval } from "../src/approvals/approvalService.js";
import { __registerProviderForTesting } from "../src/ai/router.js";
import type { AIProvider, ChatRequest, ChatResponse } from "../src/ai/types.js";

// Note: `role` here is deliberately independent of the registered user's
// actual DB role (which depends on registration order — only the very
// first user ever created in a deployment is "owner", Section 1: personal
// AI). These are unit tests of the orchestrator's permission/approval
// logic given a role, exercised the same way the HTTP layer exercises it
// (request.user.role from the authenticated caller) — not a test of the
// registration-order policy itself, which auth.service.test.ts covers.
async function makeUserAndConversation(role: "owner" | "member" = "owner") {
  const email = `agent-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { user } = await registerUser(email, "a-strong-password");
  const conversation = await createConversation(user.id, "test", "mock", "mock-1");
  return { userId: user.id, role, conversationId: conversation.id };
}

beforeAll(() => {
  registerBuiltinTools();
});

describe("agent orchestrator (mock provider)", () => {
  it("executes a permission-free tool and returns a final answer", async () => {
    const { userId, role, conversationId } = await makeUserAndConversation();
    const outcome = await runAgent({
      userId,
      role,
      conversationId,
      providerId: "mock",
      model: "mock-1",
      userMessage: 'TOOL_CALL:calculator:{"expression":"6*7"}',
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.finalMessage).toMatch(/42/);
  });

  it("pauses a high-risk tool call for approval instead of executing it immediately", async () => {
    const { userId, role, conversationId } = await makeUserAndConversation();
    const outcome = await runAgent({
      userId,
      role,
      conversationId,
      providerId: "mock",
      model: "mock-1",
      userMessage: 'TOOL_CALL:filesystem:{"operation":"delete","path":"agent-test.txt"}',
    });

    expect(outcome.status).toBe("waiting_for_approval");
    expect(outcome.approvalId).toBeTypeOf("string");

    const approvals = await listApprovals(userId, "pending");
    expect(approvals.some((a) => a.id === outcome.approvalId)).toBe(true);
  });

  it("resumes and executes the tool once a human approves it", async () => {
    const { userId, role, conversationId } = await makeUserAndConversation();
    const outcome = await runAgent({
      userId,
      role,
      conversationId,
      providerId: "mock",
      model: "mock-1",
      userMessage: 'TOOL_CALL:filesystem:{"operation":"write","path":"agent-test-2.txt","content":"hi"}',
    });

    // filesystem.write is "medium" risk (no approval); delete is what needs
    // approval — use delete here to exercise the full pause/approve/resume path.
    const deleteOutcome = await runAgent({
      userId,
      role,
      conversationId: (await createConversation(userId, "t2", "mock", "mock-1")).id,
      providerId: "mock",
      model: "mock-1",
      userMessage: 'TOOL_CALL:filesystem:{"operation":"delete","path":"agent-test-2.txt"}',
    });
    expect(deleteOutcome.status).toBe("waiting_for_approval");

    await resolveApproval(userId, deleteOutcome.approvalId!, "approved");
    const resumed = await resumeAgentRun(deleteOutcome.agentRunId, userId, role);

    expect(resumed.status).toBe("completed");
    expect(resumed.finalMessage).toMatch(/deleted/);
    void outcome;
  });

  it("reports a tool error to the model instead of crashing on denied approval", async () => {
    const { userId, role, conversationId } = await makeUserAndConversation();
    const outcome = await runAgent({
      userId,
      role,
      conversationId,
      providerId: "mock",
      model: "mock-1",
      userMessage: 'TOOL_CALL:filesystem:{"operation":"delete","path":"denied.txt"}',
    });
    expect(outcome.status).toBe("waiting_for_approval");

    await resolveApproval(userId, outcome.approvalId!, "denied");
    const resumed = await resumeAgentRun(outcome.agentRunId, userId, role);

    expect(resumed.status).toBe("completed");
    expect(resumed.finalMessage).toMatch(/denied approval/i);
  });

  it("denies a tool call when the caller's role lacks the required permission", async () => {
    const { userId, role, conversationId } = await makeUserAndConversation("member");
    const outcome = await runAgent({
      userId,
      role, // members have no write/send/delete permissions by default
      conversationId,
      providerId: "mock",
      model: "mock-1",
      userMessage: 'TOOL_CALL:email_send:{"to":"someone@example.com","subject":"hi","body":"hi"}',
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.finalMessage).toMatch(/permission denied/i);
  });

  it("stops a runaway agent instead of looping forever (Section 65 loop protection)", async () => {
    const loopingProvider: AIProvider = {
      id: "test-looping",
      displayName: "Looping test double",
      isConfigured: () => true,
      getCapabilities: () => ({
        text: true,
        vision: false,
        audio: false,
        streaming: false,
        toolCalling: true,
        structuredOutput: false,
        reasoning: false,
        longContext: false,
        contextWindowTokens: 8000,
      }),
      listModels: () => [],
      checkHealth: async () => ({ provider: "test-looping", configured: true, healthy: true, checkedAt: new Date().toISOString() }),
      async chat(_req: ChatRequest): Promise<ChatResponse> {
        // Always asks for another calculator call — never terminates on its own.
        return {
          content: "",
          toolCalls: [{ id: `loop-${Math.random()}`, name: "calculator", arguments: { expression: "1+1" } }],
          finishReason: "tool_calls",
          usage: { promptTokens: 1, completionTokens: 1 },
          model: "test-loop-model",
          provider: "test-looping",
        };
      },
      async *chatStream() {
        yield { type: "error", message: "not implemented", recoverable: false };
      },
    };
    __registerProviderForTesting(loopingProvider);

    const { userId, role, conversationId } = await makeUserAndConversation();
    const outcome = await runAgent({
      userId,
      role,
      conversationId,
      providerId: "test-looping",
      model: "test-loop-model",
      userMessage: "start looping",
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatch(/exceeded the maximum/i);
  });
});
