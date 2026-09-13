import { prisma } from "../database/client.js";
import { eventBus } from "../events/eventBus.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";

// Section 12: Task Execution Engine — explicit state machine. Valid
// transitions are enforced here so nothing downstream (scheduler, API,
// orchestrator) can push a task into an inconsistent state.
export type TaskStatus =
  | "queued"
  | "planning"
  | "running"
  | "waiting_for_approval"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  queued: ["planning", "running", "cancelled"],
  planning: ["running", "failed", "cancelled"],
  running: ["waiting_for_approval", "paused", "completed", "failed", "cancelled"],
  waiting_for_approval: ["running", "cancelled", "failed"],
  paused: ["running", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export async function createTask(userId: string, title: string, goal: string, conversationId?: string) {
  const task = await prisma.task.create({
    data: { userId, title, goal, status: "queued", conversationId },
  });
  eventBus.emitEvent("task.created", { taskId: task.id, title }, userId);
  return task;
}

export async function setPlan(taskId: string, steps: string[]): Promise<void> {
  await prisma.task.update({ where: { id: taskId }, data: { plan: JSON.stringify(steps), status: "planning" } });
  await prisma.taskStep.createMany({
    data: steps.map((description, index) => ({ taskId, index, description, status: "pending" })),
  });
}

export async function transitionTask(taskId: string, next: TaskStatus, userId?: string): Promise<void> {
  const task = await prisma.task.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError("Task not found.");

  const current = task.status as TaskStatus;
  if (current === next) return;
  if (!ALLOWED_TRANSITIONS[current]?.includes(next)) {
    throw new ValidationError(`Cannot transition task from "${current}" to "${next}".`);
  }

  await prisma.task.update({
    where: { id: taskId },
    data: { status: next, completedAt: ["completed", "failed", "cancelled"].includes(next) ? new Date() : undefined },
  });

  const eventMap: Partial<Record<TaskStatus, "task.started" | "task.completed" | "task.failed" | "task.cancelled">> = {
    running: "task.started",
    completed: "task.completed",
    failed: "task.failed",
    cancelled: "task.cancelled",
  };
  eventBus.emitEvent(eventMap[next] ?? "task.updated", { taskId, status: next }, userId ?? task.userId);
}

export async function updateStep(
  stepId: string,
  updates: { status?: string; tool?: string; input?: unknown; output?: unknown; error?: string },
): Promise<void> {
  await prisma.taskStep.update({
    where: { id: stepId },
    data: {
      status: updates.status,
      tool: updates.tool,
      input: updates.input !== undefined ? JSON.stringify(updates.input) : undefined,
      output: updates.output !== undefined ? JSON.stringify(updates.output) : undefined,
      error: updates.error,
    },
  });
}

export async function getTask(userId: string, taskId: string) {
  const task = await prisma.task.findFirst({ where: { id: taskId, userId }, include: { steps: true } });
  if (!task) throw new NotFoundError("Task not found.");
  return task;
}

export async function listTasks(userId: string) {
  return prisma.task.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, include: { steps: true } });
}

// Section 14: Cancellation. Each active run keeps an AbortController here so
// cancellation can propagate into an in-flight provider call or tool
// execution (browser, network fetch) rather than merely flipping a DB flag.
const activeControllers = new Map<string, AbortController>();

export function registerCancellation(taskId: string): AbortController {
  const controller = new AbortController();
  activeControllers.set(taskId, controller);
  return controller;
}

export function clearCancellation(taskId: string): void {
  activeControllers.delete(taskId);
}

// Generic cancellation by id — the same map backs both Task cancellation
// (cancelTask below) and AgentRun cancellation (agent/orchestrator.ts
// registers under the run's own id), since both are just "an id with an
// AbortController while work is in flight." Used by the realtime voice
// pipeline for barge-in: interrupting Jarvis mid-response aborts whatever
// agent run is currently speaking.
export function abortById(id: string): boolean {
  const controller = activeControllers.get(id);
  if (!controller) return false;
  controller.abort();
  return true;
}

export async function cancelTask(userId: string, taskId: string): Promise<void> {
  const task = await getTask(userId, taskId);
  activeControllers.get(task.id)?.abort();
  await transitionTask(task.id, "cancelled", userId);
}
