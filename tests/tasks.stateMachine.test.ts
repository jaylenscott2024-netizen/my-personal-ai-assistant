import { describe, it, expect } from "vitest";
import { registerUser } from "../src/auth/authService.js";
import { createTask, transitionTask, getTask } from "../src/tasks/taskService.js";
import { ValidationError } from "../src/utils/errors.js";

async function makeUser() {
  const email = `task-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { user } = await registerUser(email, "a-strong-password");
  return user.id;
}

describe("task state machine", () => {
  it("starts in queued and allows the documented forward transitions", async () => {
    const userId = await makeUser();
    const task = await createTask(userId, "Research competitors", "Compare pricing of three competitors");
    expect(task.status).toBe("queued");

    await transitionTask(task.id, "planning");
    await transitionTask(task.id, "running");
    await transitionTask(task.id, "waiting_for_approval");
    await transitionTask(task.id, "running");
    await transitionTask(task.id, "completed");

    const finalTask = await getTask(userId, task.id);
    expect(finalTask.status).toBe("completed");
    expect(finalTask.completedAt).not.toBeNull();
  });

  it("rejects a transition that skips required states", async () => {
    const userId = await makeUser();
    const task = await createTask(userId, "t", "g");
    await expect(transitionTask(task.id, "completed")).rejects.toThrow(ValidationError);
  });

  it("never allows leaving a terminal state", async () => {
    const userId = await makeUser();
    const task = await createTask(userId, "t", "g");
    await transitionTask(task.id, "cancelled");
    await expect(transitionTask(task.id, "running")).rejects.toThrow(ValidationError);
  });

  it("is a no-op when transitioning to the current state", async () => {
    const userId = await makeUser();
    const task = await createTask(userId, "t", "g");
    await expect(transitionTask(task.id, "queued")).resolves.not.toThrow();
  });
});
