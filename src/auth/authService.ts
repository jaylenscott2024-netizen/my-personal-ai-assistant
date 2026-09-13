import crypto from "node:crypto";
import { prisma } from "../database/client.js";
import { hashPassword, verifyPassword } from "./passwords.js";
import { hashToken, signAccessToken } from "./tokens.js";
import { AuthenticationError, ConflictError, ValidationError } from "../utils/errors.js";
import { env } from "../config/env.js";
import { audit } from "../security/audit.js";

function parseExpiry(expiresIn: string): Date {
  const match = /^(\d+)([smhd])$/.exec(expiresIn);
  const now = Date.now();
  if (!match) return new Date(now + 12 * 60 * 60 * 1000);
  const value = Number(match[1]);
  const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "s" | "m" | "h" | "d"];
  return new Date(now + value * unitMs);
}

export interface AuthResult {
  user: { id: string; email: string; displayName: string | null; role: string };
  token: string;
  expiresAt: string;
}

export async function registerUser(
  email: string,
  password: string,
  displayName?: string,
  meta?: { userAgent?: string; ipAddress?: string },
): Promise<AuthResult> {
  if (password.length < 10) {
    throw new ValidationError("Password must be at least 10 characters.");
  }
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw new ConflictError("An account with this email already exists.");
  }

  const passwordHash = await hashPassword(password);
  // First registered user becomes the owner; this is a single-tenant
  // personal-assistant deployment by default (Section 1: personal AI).
  const userCount = await prisma.user.count();
  const role = userCount === 0 ? "owner" : "member";

  const user = await prisma.user.create({
    data: { email, passwordHash, displayName: displayName ?? null, role },
  });

  audit({ userId: user.id, action: "register", resource: "user", outcome: "allowed" });
  return createSession(user, meta);
}

export async function loginUser(
  email: string,
  password: string,
  meta?: { userAgent?: string; ipAddress?: string },
): Promise<AuthResult> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new AuthenticationError("Invalid email or password.");

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    audit({ userId: user.id, action: "login", resource: "user", outcome: "denied" });
    throw new AuthenticationError("Invalid email or password.");
  }

  audit({ userId: user.id, action: "login", resource: "user", outcome: "allowed" });
  return createSession(user, meta);
}

async function createSession(
  user: { id: string; email: string; displayName: string | null; role: string },
  meta?: { userAgent?: string; ipAddress?: string },
): Promise<AuthResult> {
  const expiresAt = parseExpiry(env.JWT_EXPIRES_IN);

  // The session id is generated up front (rather than letting Prisma's
  // @default(cuid()) assign one on insert) so the token can be signed and
  // its hash computed before the row is ever written — a single insert
  // with the real tokenHash already set. The previous create-with-a-
  // placeholder-then-update approach briefly inserted every new session
  // with the same empty-string tokenHash, which violated the column's
  // unique constraint under any concurrent registration/login.
  const sessionId = crypto.randomUUID();
  const token = signAccessToken({ sub: user.id, email: user.email, role: user.role, sid: sessionId });

  await prisma.session.create({
    data: {
      id: sessionId,
      userId: user.id,
      tokenHash: hashToken(token),
      userAgent: meta?.userAgent,
      ipAddress: meta?.ipAddress,
      expiresAt,
    },
  });

  return {
    user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
    token,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
}

export async function isSessionActive(sessionId: string): Promise<boolean> {
  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) return false;
  if (session.revokedAt) return false;
  if (session.expiresAt.getTime() < Date.now()) return false;
  return true;
}
