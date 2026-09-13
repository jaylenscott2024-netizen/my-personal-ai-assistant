import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { registerUser, loginUser, revokeSession } from "../../auth/authService.js";
import { requireAuth } from "../../auth/middleware.js";

const registerSchema = z.object({ email: z.string().email(), password: z.string(), displayName: z.string().optional() });
const loginSchema = z.object({ email: z.string().email(), password: z.string() });

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/register", async (request, reply) => {
    const body = registerSchema.parse(request.body);
    const result = await registerUser(body.email, body.password, body.displayName, {
      userAgent: request.headers["user-agent"],
      ipAddress: request.ip,
    });
    reply.status(201).send(result);
  });

  app.post("/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);
    const result = await loginUser(body.email, body.password, {
      userAgent: request.headers["user-agent"],
      ipAddress: request.ip,
    });
    reply.send(result);
  });

  app.post("/auth/logout", { preHandler: requireAuth }, async (request, reply) => {
    await revokeSession(request.user!.sessionId);
    reply.status(204).send();
  });

  app.get("/auth/me", { preHandler: requireAuth }, async (request, reply) => {
    reply.send({ user: request.user });
  });
}
