import { describe, it, expect, beforeAll } from "vitest";
import { registerUser } from "../src/auth/authService.js";
import { createTask, getTask } from "../src/tasks/taskService.js";
import { runTask } from "../src/tasks/taskRunner.js";
import { registerScheduledTask, fireScheduledTask } from "../src/scheduler/scheduler.js";
import { registerBuiltinTools } from "../src/tools/builtinIndex.js";
import { prisma } from "../src/database/client.js";

// Regression coverage for a real bug found in review: creating a Task and
// transitioning it to "running"/"planning" made it LOOK like something
// was happening, but nothing in the codebase ever actually called
// runAgent() against it. POST /tasks/:id/start only flipped a status
// field, and the scheduler told the user "Scheduled task started" and
// then genuinely never ran anything. These tests prove a task now
// actually executes and reaches a real terminal state.

async function makeUser() {
  const email = `taskrunner-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { user } = await registerUser(email, "a-strong-password");
  return user.id;
}

beforeAll(() => {
  registerBuiltinTools();
});

describe("runTask — a task now actually runs the agent, not just changes status", () => {
  it("creates a conversation for a task that has none and completes it via the agent", async () => {
    const userId = await makeUser();
    const task = await createTask(userId, "Say hello", "Just say hello back, no tools needed.");
    expect(task.conversationId).toBeNull();

    await runTask(userId, "owner", task.id);

    const finished = await getTask(userId, task.id);
    expect(finished.status).toBe("completed");
    expect(finished.conversationId).not.toBeNull();
    expect(finished.completedAt).not.toBeNull();
  });

  it("actually invokes a tool referenced in the goal, proving the agent really ran", async () => {
    const userId = await makeUser();
    // The mock provider (src/ai/providers/mockProvider.ts) recognizes this
    // exact convention and requests a real calculator tool call — this is
    // not a canned "it worked" response, it's the same tool-execution path
    // a live chat turn goes through.
    const task = await createTask(userId, "Compute", 'TOOL_CALL:calculator:{"expression":"6*7"}');

    await runTask(userId, "owner", task.id);

    const finished = await getTask(userId, task.id);
    expect(finished.status).toBe("completed");
    const conversation = await prisma.conversation.findUnique({ where: { id: finished.conversationId! }, include: { messages: true } });
    expect(conversation!.messages.some((m) => m.role === "tool" && m.content.includes("42"))).toBe(true);
  });

  it("rejects for a nonexistent task rather than silently no-oping", async () => {
    const userId = await makeUser();
    await expect(runTask(userId, "owner", "not-a-real-task-id")).rejects.toThrow();
  });

  it("leaves other tasks unaffected by a failed runTask call", async () => {
    const userId = await makeUser();
    const task = await createTask(userId, "Unrelated task", "Just say hello back, no tools needed.");
    await expect(runTask(userId, "owner", "not-a-real-task-id")).rejects.toThrow();

    await runTask(userId, "owner", task.id);
    expect((await getTask(userId, task.id)).status).toBe("completed");
  });
});

describe("Scheduled tasks actually execute (not just create a queued row)", () => {
  it("fires, runs the agent, and reaches a real terminal status", async () => {
    const userId = await makeUser();
    const scheduled = await registerScheduledTask(userId, "daily-greeting", "0 9 * * *", {
      title: "Daily greeting",
      goal: "Just say hello back, no tools needed.",
    });

    await fireScheduledTask(scheduled.id);

    const tasksForUser = await prisma.task.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
    expect(tasksForUser.length).toBeGreaterThan(0);
    const fired = tasksForUser[0]!;
    expect(fired.status).toBe("completed"); // not stuck in "planning" forever
    expect(fired.conversationId).not.toBeNull();

    const updatedSchedule = await prisma.scheduledTask.findUnique({ where: { id: scheduled.id } });
    expect(updatedSchedule!.lastRunAt).not.toBeNull();
  });
});
