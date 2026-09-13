import { prisma } from "../database/client.js";
import { childLogger } from "../config/logger.js";

const log = childLogger("audit");

// Section 50: Audit Log. Separate from the general activity event bus so
// call sites are explicit about logging a security-relevant action (tool
// execution, approvals, denials, integration/credential changes). Never
// pass secret values in `detail` — see security/credentials.ts for why
// secrets must never reach this layer in the first place.
export interface AuditEntry {
  userId: string;
  action: string;
  resource: string;
  outcome: "allowed" | "denied" | "error";
  detail?: Record<string, unknown>;
}

const SECRET_KEY_PATTERN = /(password|secret|token|apiKey|api_key|authorization)/i;

function stripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? "[REDACTED]" : stripSecrets(v);
    }
    return out;
  }
  return value;
}

export function audit(entry: AuditEntry): void {
  const safeDetail = entry.detail ? (stripSecrets(entry.detail) as Record<string, unknown>) : undefined;
  log.info({ action: entry.action, resource: entry.resource, outcome: entry.outcome, detail: safeDetail }, "audit");

  prisma.activityEvent
    .create({
      data: {
        userId: entry.userId,
        type: `audit.${entry.action}`,
        payload: JSON.stringify({ resource: entry.resource, outcome: entry.outcome, detail: safeDetail }),
      },
    })
    .catch((err) => log.warn({ err }, "failed to persist audit entry"));
}
