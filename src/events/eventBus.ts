import { EventEmitter } from "node:events";
import { prisma } from "../database/client.js";
import { childLogger } from "../config/logger.js";

const log = childLogger("eventBus");

// Section 45: Internal Event Architecture. This decouples the agent,
// task engine, tools, and voice subsystems from whoever is observing them
// (WebSocket clients today; future services later) without tight coupling.
export const EVENT_TYPES = [
  "conversation.created",
  "message.created",
  "agent.started",
  "agent.thinking",
  "agent.step",
  "agent.completed",
  "agent.failed",
  "message.delta",
  "voice.transcript",
  "voice.speaking",
  "voice.interrupted",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "approval.requested",
  "approval.granted",
  "approval.denied",
  "task.created",
  "task.started",
  "task.updated",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "voice.started",
  "voice.stopped",
  "activation.detected",
  "integration.updated",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface AgentEvent<T = unknown> {
  type: EventType;
  userId?: string;
  payload: T;
  at: string;
}

const SECRET_KEY_PATTERN = /(password|secret|token|apiKey|api_key|authorization)/i;

// Defense in depth: even though callers should never pass secrets into
// event payloads, we strip anything that looks like one before it is
// persisted to the activity log or broadcast to clients (Section 50, 89).
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

class EventBus extends EventEmitter {
  emitEvent<T>(type: EventType, payload: T, userId?: string): void {
    const sanitized = stripSecrets(payload);
    const event: AgentEvent = { type, userId, payload: sanitized, at: new Date().toISOString() };
    this.emit("event", event);
    this.emit(type, event);

    // Best-effort persistence to the activity stream. Never let logging
    // failures break the calling operation.
    prisma.activityEvent
      .create({
        data: {
          userId: userId ?? null,
          type,
          payload: JSON.stringify(sanitized),
        },
      })
      .catch((err) => log.warn({ err, type }, "failed to persist activity event"));
  }

  onEvent(handler: (event: AgentEvent) => void): () => void {
    this.on("event", handler);
    return () => this.off("event", handler);
  }
}

export const eventBus = new EventBus();
eventBus.setMaxListeners(100);
