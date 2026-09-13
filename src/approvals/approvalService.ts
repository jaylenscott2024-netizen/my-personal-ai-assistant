import { prisma } from "../database/client.js";
import { eventBus } from "../events/eventBus.js";
import { audit } from "../security/audit.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import type { Permission } from "../security/permissions.js";
import { riskLevelForPermissions } from "../security/permissions.js";

export interface RequestApprovalInput {
  userId: string;
  taskId?: string;
  stepId?: string;
  tool: string;
  action: string;
  parameters: Record<string, unknown>;
  permissions: Permission[];
}

// Section 17: Approval Engine. Sensitive tool calls pause here rather than
// executing; the agent orchestrator polls/awaits resolution before it may
// proceed (Section 65: agent loop protection also bounds how long it will
// wait). Every approval is tied to the specific tool + parameters that will
// actually run, never a generic "trust this tool forever" grant.
export async function requestApproval(input: RequestApprovalInput) {
  const riskLevel = riskLevelForPermissions(input.permissions);
  const approval = await prisma.approval.create({
    data: {
      userId: input.userId,
      taskId: input.taskId,
      stepId: input.stepId,
      tool: input.tool,
      action: input.action,
      parameters: JSON.stringify(input.parameters),
      riskLevel,
      status: "pending",
    },
  });

  audit({ userId: input.userId, action: "approval.requested", resource: input.tool, outcome: "allowed", detail: { approvalId: approval.id, riskLevel } });
  eventBus.emitEvent("approval.requested", { approvalId: approval.id, tool: input.tool, action: input.action, riskLevel }, input.userId);
  return approval;
}

export async function resolveApproval(userId: string, approvalId: string, decision: "approved" | "denied", reason?: string) {
  const approval = await prisma.approval.findFirst({ where: { id: approvalId, userId } });
  if (!approval) throw new NotFoundError("Approval request not found.");
  if (approval.status !== "pending") {
    throw new ValidationError(`Approval is already ${approval.status}.`);
  }

  const updated = await prisma.approval.update({
    where: { id: approvalId },
    data: { status: decision, resolvedAt: new Date(), resolvedBy: userId, reason },
  });

  audit({ userId, action: `approval.${decision}`, resource: approval.tool, outcome: decision === "approved" ? "allowed" : "denied", detail: { approvalId } });
  eventBus.emitEvent(decision === "approved" ? "approval.granted" : "approval.denied", { approvalId }, userId);
  return updated;
}

export async function getApproval(userId: string, approvalId: string) {
  const approval = await prisma.approval.findFirst({ where: { id: approvalId, userId } });
  if (!approval) throw new NotFoundError("Approval request not found.");
  return approval;
}

export async function listApprovals(userId: string, status?: string) {
  return prisma.approval.findMany({ where: { userId, status }, orderBy: { requestedAt: "desc" } });
}

// The orchestrator calls this to block, with a bound, while a human decides.
// It never blocks forever — the caller (agent loop) owns the max-wait budget.
export async function waitForApprovalResolution(approvalId: string, timeoutMs: number, pollMs = 250): Promise<"approved" | "denied" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const approval = await prisma.approval.findUnique({ where: { id: approvalId } });
    if (approval?.status === "approved") return "approved";
    if (approval?.status === "denied") return "denied";
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return "timeout";
}
