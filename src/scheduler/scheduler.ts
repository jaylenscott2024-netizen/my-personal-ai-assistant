import cron from "node-cron";
import { prisma } from "../database/client.js";
import { createTask, transitionTask } from "../tasks/taskService.js";
import { childLogger } from "../config/logger.js";
import { notifyUser } from "../notifications/notificationService.js";

const log = childLogger("scheduler");

// Section 43: Scheduler. Deliberately thin — it creates a Task through the
// exact same task engine a user-initiated request would use (Section 43:
// "do not create a completely separate automation architecture"), then
// lets whatever drives tasks (today: a caller invoking the agent
// orchestrator against that task) take it from there.
interface ScheduledJobHandle {
  scheduledTaskId: string;
  cronJob: cron.ScheduledTask;
}

const activeJobs = new Map<string, ScheduledJobHandle>();

async function fireScheduledTask(scheduledTaskId: string): Promise<void> {
  const scheduled = await prisma.scheduledTask.findUnique({ where: { id: scheduledTaskId } });
  if (!scheduled || !scheduled.enabled) return;

  let template: { title: string; goal: string };
  try {
    template = JSON.parse(scheduled.taskTemplate);
  } catch {
    log.error({ scheduledTaskId }, "scheduled task has invalid taskTemplate JSON");
    return;
  }

  const task = await createTask(scheduled.userId, template.title, template.goal);
  await transitionTask(task.id, "planning", scheduled.userId);
  await prisma.scheduledTask.update({ where: { id: scheduledTaskId }, data: { lastRunAt: new Date() } });

  await notifyUser(scheduled.userId, "desktop", `Scheduled task started: ${template.title}`, `"${scheduled.name}" created task ${task.id}.`);
  log.info({ scheduledTaskId, taskId: task.id }, "fired scheduled task");
}

export async function registerScheduledTask(userId: string, name: string, cronExpression: string, template: { title: string; goal: string }) {
  if (!cron.validate(cronExpression)) {
    throw new Error(`Invalid cron expression: "${cronExpression}"`);
  }
  const record = await prisma.scheduledTask.create({
    data: { userId, name, cronExpression, taskTemplate: JSON.stringify(template), enabled: true },
  });
  scheduleJob(record.id, cronExpression);
  return record;
}

function scheduleJob(scheduledTaskId: string, cronExpression: string): void {
  const job = cron.schedule(cronExpression, () => {
    fireScheduledTask(scheduledTaskId).catch((err) => log.error({ err, scheduledTaskId }, "scheduled task run failed"));
  });
  activeJobs.set(scheduledTaskId, { scheduledTaskId, cronJob: job });
}

export async function unregisterScheduledTask(userId: string, scheduledTaskId: string): Promise<void> {
  const record = await prisma.scheduledTask.findFirst({ where: { id: scheduledTaskId, userId } });
  if (!record) return;
  activeJobs.get(scheduledTaskId)?.cronJob.stop();
  activeJobs.delete(scheduledTaskId);
  await prisma.scheduledTask.update({ where: { id: scheduledTaskId }, data: { enabled: false } });
}

// Called once at startup to re-arm every enabled scheduled task after a
// restart (cron jobs are in-memory only; the DB is the source of truth).
export async function restoreScheduledJobs(): Promise<number> {
  const all = await prisma.scheduledTask.findMany({ where: { enabled: true } });
  for (const task of all) {
    if (cron.validate(task.cronExpression)) scheduleJob(task.id, task.cronExpression);
  }
  return all.length;
}
