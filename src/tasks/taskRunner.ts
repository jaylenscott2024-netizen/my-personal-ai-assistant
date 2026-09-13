import { prisma } from "../database/client.js";
import { getTask, transitionTask } from "./taskService.js";
import { createConversation } from "../conversation/conversationService.js";
import { runAgent } from "../agent/orchestrator.js";
import { getDefaultProvider, defaultModelFor } from "../ai/router.js";
import { childLogger } from "../config/logger.js";

const log = childLogger("taskRunner");

// This is the piece that was missing between the Task state machine
// (tasks/taskService.ts) and the agent orchestrator: creating a Task and
// flipping its status to "running" made it LOOK like something was
// happening, but nothing ever actually called runAgent against it —
// POST /tasks/:id/start only transitioned status, and the scheduler
// transitioned a freshly created task to "planning" and stopped there.
// A scheduled task would tell the user "Scheduled task started" and then
// genuinely never run. This is what actually runs one.
//
// Deliberately does NOT introduce a second execution architecture: it
// creates/reuses the task's own conversation and calls runAgent() with
// the task's goal as the user message and taskId threaded through, the
// exact same call shape a live chat turn uses — so approvals, tool
// permissions, memory, and Eyes context all apply identically to a
// scheduled/background task as to one the user typed themselves.
export async function runTask(userId: string, role: string, taskId: string): Promise<void> {
  const task = await getTask(userId, taskId);

  let conversationId = task.conversationId;
  if (!conversationId) {
    const conversation = await createConversation(userId, task.title);
    conversationId = conversation.id;
    await prisma.task.update({ where: { id: taskId }, data: { conversationId } });
  }

  await transitionTask(taskId, "running", userId);

  const provider = getDefaultProvider();
  try {
    const outcome = await runAgent({
      userId,
      role,
      conversationId,
      providerId: provider.id,
      model: defaultModelFor(provider.id),
      userMessage: task.goal,
      taskId,
    });

    if (outcome.status === "completed") {
      await transitionTask(taskId, "completed", userId);
    } else if (outcome.status === "waiting_for_approval") {
      // Not a terminal state — a human resolving the approval resumes the
      // underlying AgentRun (agent/orchestrator.ts's resumeAgentRun), the
      // same path a live chat's pending approval already uses.
      await transitionTask(taskId, "waiting_for_approval", userId);
    } else {
      await transitionTask(taskId, "failed", userId);
    }
  } catch (err) {
    log.error({ err, taskId }, "task execution failed");
    await transitionTask(taskId, "failed", userId).catch((transitionErr) => {
      log.error({ err: transitionErr, taskId }, "failed to record task failure");
    });
  }
}
