const DEFAULT_LIMIT = 10;
const DEFAULT_WINDOW_MS = 60_000;
const SWEEP_EVERY_CALLS = 1000;
const IDLE_WINDOWS = 10;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * A token bucket per key (docs/host.md section 9): `limit` tokens, refilled continuously at
 * `limit` per `windowMs`. The lobby keys it by client IP for register and login.
 */
export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, Bucket>();
  private calls = 0;

  constructor(opts: { limit?: number; windowMs?: number; now?: () => number } = {}) {
    this.limit = opts.limit ?? DEFAULT_LIMIT;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.now = opts.now ?? Date.now;
    if (!Number.isInteger(this.limit) || this.limit < 1) {
      throw new RangeError(`rate limit must be a positive integer, got ${this.limit}`);
    }
    if (!(this.windowMs > 0) || !Number.isFinite(this.windowMs)) {
      throw new RangeError(`rate limit window must be a positive number, got ${this.windowMs}`);
    }
  }

  /** Spends one token for `key`: true when allowed, false when the bucket is empty. */
  take(key: string): boolean {
    const now = this.now();
    this.calls++;
    if (this.calls % SWEEP_EVERY_CALLS === 0) this.sweep(now);
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens: this.limit, updatedAt: now };
      this.buckets.set(key, bucket);
    } else if (now > bucket.updatedAt) {
      const refill = ((now - bucket.updatedAt) * this.limit) / this.windowMs;
      bucket.tokens = Math.min(this.limit, bucket.tokens + refill);
      bucket.updatedAt = now;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  /** Forgets every key. */
  reset(): void {
    this.buckets.clear();
    this.calls = 0;
  }

  /** Drops buckets untouched for more than 10 windows (they would be full again anyway). */
  private sweep(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt > IDLE_WINDOWS * this.windowMs) this.buckets.delete(key);
    }
  }
}
