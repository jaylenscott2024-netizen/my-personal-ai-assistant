import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { env } from "../config/env.js";

export interface JwtClaims {
  sub: string; // user id
  email: string;
  role: string;
  sid: string; // session id
}

export function signAccessToken(claims: JwtClaims): string {
  return jwt.sign(claims, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"] });
}

export function verifyAccessToken(token: string): JwtClaims {
  return jwt.verify(token, env.JWT_SECRET) as JwtClaims;
}

// We never store raw session tokens; only a hash, so a database leak alone
// cannot be used to forge sessions (Section 48: proper authentication).
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}
