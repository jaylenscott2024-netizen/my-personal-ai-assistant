import type { FastifyReply, FastifyRequest } from "fastify";
import { verifyAccessToken } from "./tokens.js";
import { isSessionActive } from "./authService.js";
import { AuthenticationError, AuthorizationError } from "../utils/errors.js";

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: string;
  sessionId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

// Section 48/49: Authentication vs authorization are handled as separate,
// explicit steps. This only establishes *who* the caller is; route
// handlers are responsible for checking that the caller may access the
// specific resource requested (e.g. that a conversation belongs to them).
export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new AuthenticationError("Missing bearer token.");
  }
  const token = header.slice("Bearer ".length);

  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch {
    throw new AuthenticationError("Invalid or expired token.");
  }

  const active = await isSessionActive(claims.sid);
  if (!active) {
    throw new AuthenticationError("Session has been revoked or expired.");
  }

  request.user = { id: claims.sub, email: claims.email, role: claims.role, sessionId: claims.sid };
}

export function requireRole(...roles: string[]) {
  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!request.user) throw new AuthenticationError();
    if (!roles.includes(request.user.role)) {
      throw new AuthorizationError(`This action requires one of the following roles: ${roles.join(", ")}.`);
    }
  };
}

// Ownership check helper: throws unless the resource's owning userId
// matches the authenticated caller (or the caller is an admin/owner).
export function assertOwnsResource(request: FastifyRequest, resourceUserId: string): void {
  if (!request.user) throw new AuthenticationError();
  if (request.user.id !== resourceUserId && request.user.role !== "owner" && request.user.role !== "admin") {
    throw new AuthorizationError("You do not have access to this resource.");
  }
}
