// A small typed error hierarchy so API handlers can map failures to correct
// HTTP status codes without string-matching messages, and so the agent loop
// can distinguish recoverable errors from ones that must stop execution
// (Section 54: Failure Recovery).

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly recoverable: boolean;

  constructor(message: string, statusCode: number, code: string, recoverable = false) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.recoverable = recoverable;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, "VALIDATION_ERROR", false);
  }
}

export class AuthenticationError extends AppError {
  constructor(message = "Authentication required") {
    super(message, 401, "AUTHENTICATION_ERROR", false);
  }
}

export class AuthorizationError extends AppError {
  constructor(message = "Not authorized to access this resource") {
    super(message, 403, "AUTHORIZATION_ERROR", false);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(message, 404, "NOT_FOUND", false);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, "CONFLICT", false);
  }
}

export class NotConfiguredError extends AppError {
  constructor(what: string) {
    super(`${what} is not configured. Provide the required credentials before use.`, 412, "NOT_CONFIGURED", false);
  }
}

export class ApprovalRequiredError extends AppError {
  readonly approvalId: string;
  constructor(approvalId: string) {
    super("This action requires user approval before it can proceed.", 202, "APPROVAL_REQUIRED", true);
    this.approvalId = approvalId;
  }
}

export class ProviderError extends AppError {
  constructor(message: string, recoverable = true) {
    super(message, 502, "PROVIDER_ERROR", recoverable);
  }
}

export class RateLimitError extends AppError {
  readonly retryAfterMs?: number;
  constructor(message = "Rate limit exceeded", retryAfterMs?: number) {
    super(message, 429, "RATE_LIMITED", true);
    this.retryAfterMs = retryAfterMs;
  }
}

export class AgentLoopLimitError extends AppError {
  constructor(message: string) {
    super(message, 400, "AGENT_LOOP_LIMIT", false);
  }
}
