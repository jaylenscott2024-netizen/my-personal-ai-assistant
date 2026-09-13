import { PrismaClient } from "@prisma/client";
import { env } from "../config/env.js";

// Singleton Prisma client (Section 56/96: modular database access). In tests
// and dev, `tsx` may re-import this module across hot reloads, so we stash
// the instance on globalThis to avoid exhausting SQLite file handles.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
