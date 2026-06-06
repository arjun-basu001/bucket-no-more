/**
 * @module common/retry
 *
 * Exponential backoff with full jitter for transient failures. Only retries
 * when the predicate says the error is retryable — never blindly, because
 * retrying a non-idempotent or permanent failure makes things worse.
 */

export interface RetryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Decide whether a thrown/returned error warrants another attempt. */
  readonly isRetryable?: (error: unknown) => boolean;
  /** Hook for observability / testing. */
  readonly onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Full-jitter backoff: random between 0 and the capped exponential ceiling. */
function backoffDelay(attempt: number, base: number, max: number): number {
  const ceiling = Math.min(max, base * 2 ** (attempt - 1));
  return Math.floor(Math.random() * ceiling);
}

/**
 * Execute `fn`, retrying on retryable errors with jittered exponential backoff.
 * Re-throws the last error once attempts are exhausted.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 100,
    maxDelayMs = 5_000,
    isRetryable = () => true,
    onRetry,
  } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !isRetryable(error)) break;
      const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs);
      onRetry?.(attempt, delay, error);
      await sleep(delay);
    }
  }
  throw lastError;
}
