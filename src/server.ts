import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { disconnectDatabase } from "./database/client.js";
import { browserManager } from "./browser/browserManager.js";
import { restoreScheduledJobs } from "./scheduler/scheduler.js";

async function main(): Promise<void> {
  const app = await buildApp();

  const restoredCount = await restoreScheduledJobs();
  logger.info({ restoredCount }, "restored scheduled tasks");

  await app.listen({ port: env.PORT, host: env.HOST });
  logger.info({ port: env.PORT }, "Voltic Lane AI backend listening");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    await app.close();
    await browserManager.shutdown();
    await disconnectDatabase();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});
