import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../../auth/middleware.js";
import { listIntegrations } from "../../integrations/integrationManager.js";
import { upsertUserCredential } from "../../security/credentials.js";
import { audit } from "../../security/audit.js";

const credentialSchema = z.object({
  provider: z.string(),
  secret: z.string().min(1),
  label: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export async function integrationRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", requireAuth);

  app.get("/integrations", async (request, reply) => {
    reply.send(await listIntegrations(request.user!.id));
  });

  // Section 19: store a user-configured credential encrypted at rest. The
  // response never echoes the secret back (Section 18: never return
  // secrets unnecessarily).
  app.post("/integrations/credentials", async (request, reply) => {
    const body = credentialSchema.parse(request.body);
    const result = await upsertUserCredential(request.user!.id, body.provider, body.secret, {
      label: body.label,
      metadata: body.metadata,
    });
    audit({ userId: request.user!.id, action: "credential.configured", resource: body.provider, outcome: "allowed" });
    reply.status(201).send(result);
  });
}
