/**
 * The Session's time base (docs/net.md A.11). Server time is milliseconds since `start()`, as a u32
 * (`>>> 0`; it wraps after 49.7 days, longer than any session lives). `serverTimeMs()` is the value
 * sampled at the start of the latest tick, which Welcome and Snapshot headers carry; `nowMs()` is the
 * current server time, which Pong carries.
 */
export class ServerClock {
  private readonly now: () => number;
  private startMs = 0;
  private tickStartMs = 0;

  constructor(now: () => number) {
    this.now = now;
  }

  /** `sessionStartMs = now()`; the tick-start time is reset to the session start. */
  start(): void {
    this.startMs = this.now();
    this.tickStartMs = this.startMs;
  }

  /** Pipeline step 1: samples `now()` as the tick start and returns it (raw, not server time). */
  tickStart(): number {
    this.tickStartMs = this.now();
    return this.tickStartMs;
  }

  /** Current server time, u32 ms since `start()`. */
  nowMs(): number {
    return (this.now() - this.startMs) >>> 0;
  }

  /** Server time at the start of the latest tick, u32 ms since `start()`. */
  serverTimeMs(): number {
    return (this.tickStartMs - this.startMs) >>> 0;
  }
}
