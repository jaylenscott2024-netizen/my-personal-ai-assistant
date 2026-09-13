import type { WebSocket } from "ws";
import { eventBus, type AgentEvent } from "../events/eventBus.js";
import { childLogger } from "../config/logger.js";

const log = childLogger("realtime");

// Section 47: Real-Time API. One WebSocket connection per authenticated
// session; every server-side event (agent progress, tool activity, task
// updates, approvals, activation, voice) reaches the client the same way,
// since it all flows through the single eventBus (Section 45).
class RealtimeGateway {
  private connectionsByUser = new Map<string, Set<WebSocket>>();

  constructor() {
    eventBus.onEvent((event) => this.broadcastToUser(event));
  }

  register(userId: string, socket: WebSocket): void {
    if (!this.connectionsByUser.has(userId)) this.connectionsByUser.set(userId, new Set());
    this.connectionsByUser.get(userId)!.add(socket);

    socket.on("close", () => {
      this.connectionsByUser.get(userId)?.delete(socket);
      if (this.connectionsByUser.get(userId)?.size === 0) this.connectionsByUser.delete(userId);
    });
  }

  private broadcastToUser(event: AgentEvent): void {
    if (!event.userId) return;
    const sockets = this.connectionsByUser.get(event.userId);
    if (!sockets) return;
    const payload = JSON.stringify({ kind: "event", event });
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) {
        socket.send(payload, (err) => {
          if (err) log.warn({ err }, "failed to send realtime event");
        });
      }
    }
  }

  sendToUser(userId: string, message: Record<string, unknown>): void {
    const sockets = this.connectionsByUser.get(userId);
    if (!sockets) return;
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  connectionCount(userId: string): number {
    return this.connectionsByUser.get(userId)?.size ?? 0;
  }
}

export const realtimeGateway = new RealtimeGateway();
