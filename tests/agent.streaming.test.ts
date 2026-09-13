import { describe, it, expect, beforeAll } from "vitest";
import { registerUser } from "../src/auth/authService.js";
import { createConversation } from "../src/conversation/conversationService.js";
import { runAgent } from "../src/agent/orchestrator.js";
import { registerBuiltinTools } from "../src/tools/builtinIndex.js";
import { eventBus, type AgentEvent } from "../src/events/eventBus.js";

beforeAll(() => {
  registerBuiltinTools();
});

async function makeUserAndConversation() {
  const email = `stream-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { user } = await registerUser(email, "a-strong-password");
  const conversation = await createConversation(user.id, "stream-test", "mock", "mock-1");
  return { userId: user.id, role: "owner" as const, conversationId: conversation.id };
}

describe("agent orchestrator streaming (Section 14)", () => {
  it("emits incremental message.delta events while the model responds", async () => {
    const { userId, role, conversationId } = await makeUserAndConversation();

    const deltas: string[] = [];
    const unsubscribe = eventBus.onEvent((event: AgentEvent) => {
      if (event.type === "message.delta" && event.userId === userId) {
        deltas.push((event.payload as { delta: string }).delta);
      }
    });

    const outcome = await runAgent({
      userId,
      role,
      conversationId,
      providerId: "mock",
      model: "mock-1",
      userMessage: "Tell me something interesting.",
      stream: true,
    });
    unsubscribe();

    expect(outcome.status).toBe("completed");
    expect(deltas.length).toBeGreaterThan(1); // more than one chunk — genuinely incremental
    expect(deltas.join("").trim()).toBe(outcome.finalMessage?.trim());
  });

  it("does not emit deltas when streaming is not requested", async () => {
    const { userId, role, conversationId } = await makeUserAndConversation();

    const deltas: string[] = [];
    const unsubscribe = eventBus.onEvent((event: AgentEvent) => {
      if (event.type === "message.delta" && event.userId === userId) deltas.push("x");
    });

    const outcome = await runAgent({
      userId,
      role,
      conversationId,
      providerId: "mock",
      model: "mock-1",
      userMessage: "Tell me something interesting.",
      stream: false,
    });
    unsubscribe();

    expect(outcome.status).toBe("completed");
    expect(deltas.length).toBe(0);
  });

  it("still executes tool calls correctly when streaming is enabled", async () => {
    const { userId, role, conversationId } = await makeUserAndConversation();
    const outcome = await runAgent({
      userId,
      role,
      conversationId,
      providerId: "mock",
      model: "mock-1",
      userMessage: 'TOOL_CALL:calculator:{"expression":"3*3"}',
      stream: true,
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.finalMessage).toMatch(/9/);
  });
});
