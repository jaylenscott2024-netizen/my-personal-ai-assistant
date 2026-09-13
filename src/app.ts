import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { logger } from "./config/logger.js";
import { handleError } from "./api/errorHandler.js";
import { authRoutes } from "./api/routes/authRoutes.js";
import { conversationRoutes } from "./api/routes/conversationRoutes.js";
import { providerRoutes } from "./api/routes/providerRoutes.js";
import { memoryRoutes } from "./api/routes/memoryRoutes.js";
import { toolRoutes } from "./api/routes/toolRoutes.js";
import { taskRoutes } from "./api/routes/taskRoutes.js";
import { approvalRoutes } from "./api/routes/approvalRoutes.js";
import { integrationRoutes } from "./api/routes/integrationRoutes.js";
import { voiceRoutes } from "./api/routes/voiceRoutes.js";
import { settingsRoutes } from "./api/routes/settingsRoutes.js";
import { activityRoutes } from "./api/routes/activityRoutes.js";
import { healthRoutes } from "./api/routes/healthRoutes.js";
import { realtimeRoute } from "./api/routes/realtimeRoute.js";
import { realtimeVoiceRoute } from "./api/routes/realtimeVoiceRoute.js";
import { registerBuiltinTools } from "./tools/builtinIndex.js";

// Section 46/96: the backend is authoritative and framework-agnostic from
// the frontend's point of view — every capability described in the
// architecture is reachable purely through this HTTP/WebSocket API
// (Section 73: frontend independence).
export async function buildApp() {
  const app = Fastify({ loggerInstance: logger, trustProxy: true });

  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.setErrorHandler(handleError);

  registerBuiltinTools();

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(conversationRoutes);
  await app.register(providerRoutes);
  await app.register(memoryRoutes);
  await app.register(toolRoutes);
  await app.register(taskRoutes);
  await app.register(approvalRoutes);
  await app.register(integrationRoutes);
  await app.register(voiceRoutes);
  await app.register(settingsRoutes);
  await app.register(activityRoutes);
  await app.register(realtimeRoute);
  await app.register(realtimeVoiceRoute);

  return app;
}
