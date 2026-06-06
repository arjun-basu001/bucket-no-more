/**
 * @module auth/rate-limiter
 *
 * Token-bucket rate limiting, keyed per client/agent. Token bucket is the right
 * default for agent traffic because it allows short bursts (an agent fanning
 * out to many merchants at checkout) while bounding the sustained rate.
 *
 * The store is abstracted so the same logic runs against an in-memory map for a
 * single node or Redis for a cluster. The algorithm is "lazy refill": we don't
 * run timers; we compute how many tokens should have regenerated since the last
 * request based on elapsed time. This is O(1) per request and clock-cheap.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Tokens remaining after this request (floored at 0). */
  readonly remaining: number;
  /** Seconds until at least one token is available again. */
  readonly retryAfterSeconds: number;
  readonly limit: number;
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

/** Pluggable storage for bucket state (in-memory or Redis-backed). */
export interface BucketStore {
  get(key: string): Promise<BucketState | undefined>;
  set(key: string, state: BucketState, ttlMs: number): Promise<void>;
}

export class InMemoryBucketStore implements BucketStore {
  private readonly map = new Map<string, { state: BucketState; expiresAt: number }>();
  async get(key: string): Promise<BucketState | undefined> {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.state;
  }
  async set(key: string, state: BucketState, ttlMs: number): Promise<void> {
    this.map.set(key, { state, expiresAt: Date.now() + ttlMs });
  }
}

export interface RateLimitConfig {
  /** Maximum tokens in the bucket (burst capacity). */
  readonly capacity: number;
  /** Tokens regenerated per second (sustained rate). */
  readonly refillPerSecond: number;
}

export class TokenBucketRateLimiter {
  constructor(
    private readonly config: RateLimitConfig,
    private readonly store: BucketStore = new InMemoryBucketStore(),
  ) {
    if (config.capacity <= 0 || config.refillPerSecond <= 0) {
      throw new RangeError('Rate limit capacity and refill rate must be positive');
    }
  }

  /**
   * Attempt to consume `cost` tokens for `key`. Returns a decision describing
   * whether the request is allowed and when the caller may retry.
   */
  async consume(key: string, cost = 1): Promise<RateLimitDecision> {
    const now = Date.now();
    const existing = await this.store.get(key);
    const bucket: BucketState = existing ?? { tokens: this.config.capacity, lastRefillMs: now };

    // Lazy refill based on elapsed time since we last touched the bucket.
    const elapsedSeconds = Math.max(0, (now - bucket.lastRefillMs) / 1000);
    const refilled = Math.min(
      this.config.capacity,
      bucket.tokens + elapsedSeconds * this.config.refillPerSecond,
    );

    let allowed = false;
    let tokens = refilled;
    if (refilled >= cost) {
      tokens = refilled - cost;
      allowed = true;
    }

    const next: BucketState = { tokens, lastRefillMs: now };
    // TTL: time for a fully empty bucket to refill completely, plus a margin.
    const ttlMs = Math.ceil((this.config.capacity / this.config.refillPerSecond) * 1000) + 1000;
    await this.store.set(key, next, ttlMs);

    const deficit = allowed ? 0 : cost - refilled;
    const retryAfterSeconds = allowed ? 0 : Math.ceil(deficit / this.config.refillPerSecond);
    return {
      allowed,
      remaining: Math.floor(tokens),
      retryAfterSeconds,
      limit: this.config.capacity,
    };
  }
}
