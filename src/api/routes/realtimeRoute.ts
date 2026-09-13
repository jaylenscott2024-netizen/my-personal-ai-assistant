import type { FastifyInstance } from "fastify";
import { verifyAccessToken } from "../../auth/tokens.js";
import { isSessionActive } from "../../auth/authService.js";
import { realtimeGateway } from "../../realtime/gateway.js";
import { activationManager } from "../../activation/activationManager.js";
import { childLogger } from "../../config/logger.js";

const log = childLogger("ws");

// Section 47: WebSocket transport for the real-time API. Browsers cannot
// attach an Authorization header to a WS upgrade request, so the access
// token travels as a query parameter here instead — same JWT, same
// validation as every REST call.
export async function realtimeRoute(app: FastifyInstance): Promise<void> {
  app.get("/ws", { websocket: true }, async (socket, request) => {
    const token = (request.query as { token?: string }).token;
    if (!token) {
      socket.close(4001, "Missing token");
      return;
    }

    let userId: string;
    try {
      const claims = verifyAccessToken(token);
      if (!(await isSessionActive(claims.sid))) throw new Error("session inactive");
      userId = claims.sub;
    } catch {
      socket.close(4001, "Invalid or expired token");
      return;
    }

    realtimeGateway.register(userId, socket);
    socket.send(JSON.stringify({ kind: "connected", userId }));

    socket.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) {
        // Raw PCM16 audio for clap detection (Section 32).
        activationManager.feedAudioChunk(userId, raw);
        return;
      }
      try {
        const msg = JSON.parse(raw.toString("utf8"));
        if (msg.type === "wake_word_detected" && typeof msg.phrase === "string") {
          activationManager.reportWakeWordDetected(userId, msg.phrase);
        }
      } catch (err) {
        log.debug({ err }, "ignored malformed ws text message");
      }
    });
  });
}
