import type { ReplicationOptions } from './replication-planner.ts';

interface Bucket {
  rate: number;
  capacity: number;
  tokens: number;
  at: number;
}
export interface EgressReservation {
  commit(): void;
  refund(): void;
}
/** Credits are reserved before queueing a frame, so one simulation tick cannot overspend. */
export class EgressBudget {
  private readonly data: Bucket;
  private readonly control: Bucket;
  readonly maxFrameBytes: number;
  readonly bytesPerSecond: number;
  readonly burstBytes: number;
  readonly controlMaxFrameBytes: number;
  constructor(options: ReplicationOptions = {}, now = 0) {
    this.bytesPerSecond = options.bytesPerSecond ?? Infinity;
    this.maxFrameBytes = options.maxFrameBytes ?? 65546;
    this.burstBytes =
      options.burstBytes ??
      Math.max(
        this.maxFrameBytes,
        Number.isFinite(this.bytesPerSecond) ? this.bytesPerSecond : this.maxFrameBytes,
      );
    const controlRate = options.controlBytesPerSecond ?? 4096;
    const controlBurst = options.controlBurstBytes ?? 8192;
    this.controlMaxFrameBytes = options.controlMaxFrameBytes ?? 4096;
    if (
      !Number.isSafeInteger(this.controlMaxFrameBytes) ||
      this.controlMaxFrameBytes < 64 ||
      this.controlMaxFrameBytes > 65546
    )
      throw new RangeError('Replication: invalid control frame bound');
    if (
      (this.bytesPerSecond !== Infinity &&
        (!Number.isFinite(this.bytesPerSecond) ||
          this.bytesPerSecond < 32 ||
          this.bytesPerSecond > 1024 * 1024 * 1024)) ||
      !Number.isInteger(this.maxFrameBytes) ||
      this.maxFrameBytes < 64 ||
      this.maxFrameBytes > 65546 ||
      !Number.isSafeInteger(this.burstBytes) ||
      this.burstBytes < 64 ||
      this.burstBytes > 16 * 1024 * 1024 ||
      !Number.isFinite(controlRate) ||
      controlRate < 1 ||
      controlRate > 1024 * 1024 ||
      !Number.isSafeInteger(controlBurst) ||
      controlBurst < 64 ||
      controlBurst > 1024 * 1024
    )
      throw new RangeError('Replication: invalid egress/frame/control budget');
    this.data = {
      rate: this.bytesPerSecond,
      capacity: this.burstBytes,
      tokens: this.burstBytes,
      at: now,
    };
    this.control = { rate: controlRate, capacity: controlBurst, tokens: controlBurst, at: now };
  }
  available(now: number): number {
    this.refill(this.data, now);
    return this.data.rate === Infinity ? Infinity : this.data.tokens;
  }
  reserve(bytes: number, now: number, control = false): EgressReservation | null {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new RangeError('Replication: invalid reservation size');
    const bucket = control ? this.control : this.data;
    this.refill(bucket, now);
    if (
      bytes >
        (control ? Math.min(this.maxFrameBytes, this.controlMaxFrameBytes) : this.maxFrameBytes) ||
      (bytes > bucket.capacity && bucket.rate !== Infinity) ||
      (bytes > bucket.tokens && bucket.rate !== Infinity)
    )
      return null;
    if (bucket.rate !== Infinity) bucket.tokens -= bytes;
    let pending = true;
    return {
      commit: () => {
        pending = false;
      },
      refund: () => {
        if (pending && bucket.rate !== Infinity)
          bucket.tokens = Math.min(bucket.capacity, bucket.tokens + bytes);
        pending = false;
      },
    };
  }
  canFinish(bytes: number, lifetimeMs: number): boolean {
    return (
      this.bytesPerSecond === Infinity ||
      bytes <= this.burstBytes + (this.bytesPerSecond * lifetimeMs) / 1000
    );
  }
  private refill(bucket: Bucket, now: number): void {
    if (!Number.isFinite(now)) throw new RangeError('Replication: invalid monotonic driver time');
    if (now > bucket.at) {
      bucket.tokens = Math.min(
        bucket.capacity,
        bucket.tokens + ((now - bucket.at) * bucket.rate) / 1000,
      );
      bucket.at = now;
    }
  }
}
