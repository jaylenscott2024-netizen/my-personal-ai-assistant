import { prisma } from "../database/client.js";
import { eventBus } from "../events/eventBus.js";

// Section 42: Integration Manager. Tracks the health/status of every
// external service the assistant can talk to. Status is derived from real
// configuration presence and a real health probe — never hard-coded to
// "connected" (Section 94: no fake features).
export type IntegrationProvider = "openai" | "anthropic" | "gemini" | "elevenlabs" | "shopify" | "github" | "twilio" | "google" | "microsoft";

export async function upsertIntegrationStatus(
  userId: string,
  provider: IntegrationProvider,
  status: "not_configured" | "configured" | "error" | "disabled",
  capabilities: string[] = [],
) {
  const record = await prisma.integration.upsert({
    where: { userId_provider: { userId, provider } },
    create: { userId, provider, status, capabilities: JSON.stringify(capabilities) },
    update: { status, capabilities: JSON.stringify(capabilities) },
  });
  eventBus.emitEvent("integration.updated", { provider, status }, userId);
  return record;
}

export async function recordHealthCheck(userId: string, provider: IntegrationProvider, healthy: boolean, detail?: string) {
  return prisma.integration.upsert({
    where: { userId_provider: { userId, provider } },
    create: {
      userId,
      provider,
      status: healthy ? "configured" : "error",
      lastHealthCheckAt: new Date(),
      lastHealthStatus: healthy ? "healthy" : detail ?? "unhealthy",
    },
    update: {
      status: healthy ? "configured" : "error",
      lastHealthCheckAt: new Date(),
      lastHealthStatus: healthy ? "healthy" : detail ?? "unhealthy",
    },
  });
}

export async function listIntegrations(userId: string) {
  return prisma.integration.findMany({ where: { userId } });
}
