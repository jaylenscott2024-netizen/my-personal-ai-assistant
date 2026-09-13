import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { AppError } from "../utils/errors.js";
import { childLogger } from "../config/logger.js";

const log = childLogger("api");

// Section 46: consistent validation and error responses across every route.
export function handleError(err: FastifyError | Error, request: FastifyRequest, reply: FastifyReply): void {
  if (err instanceof ZodError) {
    reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: err.issues.map((i) => i.message).join("; ") } });
    return;
  }
  if (err instanceof AppError) {
    if (err.statusCode >= 500) log.error({ err, path: request.url }, "request failed");
    reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    return;
  }
  log.error({ err, path: request.url }, "unhandled error");
  reply.status(500).send({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } });
}
