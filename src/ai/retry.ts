import { ProviderError, RateLimitError } from "../utils/errors.js";
import { childLogger } from "../config/logger.js";

const log = childLogger("ai.retry");

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
}

// Section 52: rate limiting / retry / backoff. Bounded exponential backoff
// so a flaky or rate-limited provider never turns into a runaway retry
// loop that could rack up cost (Section 53/65).
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) {
      throw new ProviderError("Request cancelled.", false);
    }
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const recoverable = err instanceof RateLimitError || (err instanceof ProviderError && err.recoverable);
      if (!recoverable || attempt === maxAttempts) break;

      const retryAfter = err instanceof RateLimitError ? err.retryAfterMs : undefined;
      const delay = retryAfter ?? baseDelayMs * 2 ** (attempt - 1);
      log.warn({ attempt, delay, err: (err as Error).message }, "retrying provider call after failure");
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}
