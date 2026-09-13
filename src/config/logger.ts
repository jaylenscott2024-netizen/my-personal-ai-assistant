import pino from "pino";
import { env } from "./env.js";

// Structured logging (Section 51 Observability). Redact anything that could
// carry a secret even if a call site mistakenly logs a whole object.
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      "*.password",
      "*.passwordHash",
      "*.token",
      "*.apiKey",
      "*.api_key",
      "*.secret",
      "*.secretEnc",
      "*.authorization",
      "*.Authorization",
      "req.headers.authorization",
    ],
    censor: "[REDACTED]",
  },
  transport:
    env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
      : undefined,
});

export function childLogger(component: string) {
  return logger.child({ component });
}
