/** Cumulative Session counters named in docs/net.md Part A. */
export interface SessionStats {
  /** Messages not accepted in the conn's state (A.6 acceptance table). */
  ignoredMessages: number;
  /** Incoming envelope seq did not follow the previous one. */
  seqGaps: number;
  /** Messages of a kind the registry does not know, skipped. */
  unknownKinds: number;
  /** Frames discarded for a `DecodeError`. */
  badFrames: number;
  /** Input messages with no frames, a wrong `firstTick` or ticks not strictly ascending (A.7). */
  badInput: number;
  /** Input frames dropped from the front of a full queue. */
  inputOverflow: number;
  /** Queued frames whose tick passed before they were applied. */
  staleInputs: number;
  /** Playing ticks with no frame for the tick (the held frame was reused). */
  missingInputs: number;
  /** c2s game messages dropped beyond `MAX_GAME_MESSAGES_PER_TICK`. */
  gameMessagesDropped: number;
  /** Snapshots sent. */
  snapshotsSent: number;
  /** Snapshots skipped because the link's buffer exceeded `BACKPRESSURE_SKIP_BYTES` (A.10). */
  skipped: number;
  /** Snapshots whose payload exceeded `MAX_PAYLOAD_BYTES` (A.8.1); nothing was committed. */
  snapshotsTooLarge: number;
  /** Replicated events dropped beyond `PENDING_EVENTS_MAX` (A.8.3). */
  eventsDropped: number;
  /** Clients kicked for `ACK_TIMEOUT_MS` without an Ack (A.10). */
  ackTimeouts: number;
  /** Exceptions caught in the tick pipeline or a hook, logged with `log('error')`. */
  tickErrors: number;
}

export function createStats(): SessionStats {
  return {
    ignoredMessages: 0,
    seqGaps: 0,
    unknownKinds: 0,
    badFrames: 0,
    badInput: 0,
    inputOverflow: 0,
    staleInputs: 0,
    missingInputs: 0,
    gameMessagesDropped: 0,
    snapshotsSent: 0,
    skipped: 0,
    snapshotsTooLarge: 0,
    eventsDropped: 0,
    ackTimeouts: 0,
    tickErrors: 0,
  };
}

/** Bytes per second over consecutive windows of at least `windowMs`. */
export class RateMeter {
  private readonly windowMs: number;
  private windowStart: number | null = null;
  private windowBytes = 0;
  private rate = 0;

  constructor(windowMs = 1000) {
    this.windowMs = windowMs;
  }

  add(bytes: number, nowMs: number): void {
    this.roll(nowMs);
    this.windowBytes += bytes;
  }

  /** The rate of the last completed window (0 before one completes). */
  perSecond(nowMs: number): number {
    this.roll(nowMs);
    return this.rate;
  }

  private roll(nowMs: number): void {
    if (this.windowStart === null) {
      this.windowStart = nowMs;
      return;
    }
    const elapsed = nowMs - this.windowStart;
    if (elapsed < this.windowMs) return;
    // A window with no traffic at all reads as 0, however long it lasted.
    this.rate = (this.windowBytes * 1000) / elapsed;
    this.windowStart = nowMs;
    this.windowBytes = 0;
  }
}

/** Average and maximum of the last `capacity` tick durations. */
export class TickTimes {
  private readonly samples: Float64Array;
  private next = 0;
  private count = 0;

  constructor(capacity = 64) {
    this.samples = new Float64Array(capacity);
  }

  record(ms: number): void {
    this.samples[this.next] = ms;
    this.next = (this.next + 1) % this.samples.length;
    if (this.count < this.samples.length) this.count++;
  }

  average(): number {
    if (this.count === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this.count; i++) sum += this.samples[i] as number;
    return sum / this.count;
  }

  max(): number {
    let max = 0;
    for (let i = 0; i < this.count; i++) max = Math.max(max, this.samples[i] as number);
    return max;
  }
}

/** `TickStats.wakeLateness` (docs/net.md A.5): how late the FixedLoop woke, since `start()`. */
export interface WakeLatenessStats {
  /** Wakes recorded. */
  wakes: number;
  /** Bucket-resolution upper bounds: the true quantile is at most this. */
  p50Ms: number;
  p99Ms: number;
  /** Exact. */
  maxMs: number;
  bucketMs: number;
  /**
   * Cumulative wake counts: `histogram[i]` counts lateness in `[i * bucketMs, (i + 1) * bucketMs)`;
   * the first bucket also counts early (negative) wakes, the last one everything beyond it.
   */
  histogram: number[];
}

/**
 * Cumulative histogram of wake lateness in ms (FixedLoop `stats().lastLateMs`, docs/sim.md 2.10),
 * 64 buckets of 0.25 ms by default as in Spike 2a. `quantile(q)` is the upper edge of the bucket
 * holding the nearest-rank q-quantile, capped at the exact maximum (the maximum itself in the last,
 * open bucket); 0 before the first sample.
 */
export class LatenessHistogram {
  private readonly counts: number[];
  private readonly bucketMs: number;
  private total = 0;
  private max = 0;

  constructor(buckets = 64, bucketMs = 0.25) {
    this.counts = new Array<number>(buckets).fill(0);
    this.bucketMs = bucketMs;
  }

  record(ms: number): void {
    const i = Math.min(this.counts.length - 1, Math.max(0, Math.floor(ms / this.bucketMs)));
    this.counts[i] = (this.counts[i] as number) + 1;
    this.max = this.total === 0 ? ms : Math.max(this.max, ms);
    this.total++;
  }

  quantile(q: number): number {
    const rank = Math.max(1, Math.ceil(q * this.total));
    let seen = 0;
    for (let i = 0; i < this.counts.length - 1; i++) {
      seen += this.counts[i] as number;
      if (seen >= rank) return Math.min((i + 1) * this.bucketMs, this.max);
    }
    return this.max;
  }

  stats(): WakeLatenessStats {
    return {
      wakes: this.total,
      p50Ms: this.quantile(0.5),
      p99Ms: this.quantile(0.99),
      maxMs: this.max,
      bucketMs: this.bucketMs,
      histogram: [...this.counts],
    };
  }
}
