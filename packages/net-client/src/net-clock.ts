import {
  CLOCK_WINDOW,
  FRAME_ALPHA,
  FRAME_RESET_MS,
  JITTER_ALPHA,
  JITTER_MAX_MS,
  JITTER_MIN_MS,
  RTT_ALPHA,
  SLEW_DEADBAND_MS,
  SLEW_RATE,
  SNAP_THRESHOLD_MS,
} from './constants.ts';

export interface NetClockOptions {
  now: () => number;
  /** Maximum supported input lead; default 32 ticks. */
  maxInputLeadTicks?: number | undefined;
}

/** Tolerance, in ticks, for flooring and ceiling tick counts computed through floating point. */
const TICK_EPSILON = 1e-6;

/** `ms` truncated to an integer and wrapped to u32, as sent in `Ping.clientTimeMs`. */
export function toU32Ms(ms: number): number {
  return Math.floor(ms) >>> 0;
}

/** `recvMs - sentU32` over u32 wrap (docs/protocol.md 9.9), keeping `recvMs`'s fraction. */
function elapsedSinceU32(recvMs: number, sentU32: number): number {
  const whole = Math.floor(recvMs);
  return (((whole >>> 0) - sentU32) | 0) + (recvMs - whole);
}

/**
 * The client's estimate of server time and ticks, and the slewed render clock that trails it by
 * the interpolation delay (docs/net.md B.4). Each kind of sample is biased one way only, so its
 * extreme is the least-biased observation. A delay -- the network's, the server's in sending, the
 * client's main thread handling a message late -- only lowers what a sample sees of the offset: the
 * offset is the highest of the last `CLOCK_WINDOW`, plus half the RTT (the way back, which even
 * the promptest took), with the RTT as it is now -- not as it was when each sample came, so one
 * mismeasured RTT is undone by the next. A late tick start only raises an epoch sample, and the
 * server's ticks keep to one grid (docs/sim.md 2.10): the epoch is the lowest since `reset()`.
 */
export class NetClock {
  private readonly now: () => number;
  private readonly maxInputLead: number;
  private rate = 60;
  private every = 3;
  /**
   * The last `CLOCK_WINDOW` offset samples (docs/net.md B.4 `s`): `serverTimeMs - clientRecvMs`,
   * server ms minus client ms, less however long each took to be handled -- the way back, and
   * anything that held it up.
   */
  private readonly window: number[] = [];
  private windowNext = 0;
  /** The window's highest sample. */
  private seen = 0;
  /** The lowest epoch sample (B.4 `e`) since `reset()`; 0 before the first. */
  private epoch = 0;
  private rtt = 0;
  private rttMeasured = false;
  private jitterRaw = 0;
  private jitter = 0;
  private lastSnapshotRecvMs: number | null = null;
  private renderMs: number | null = null;
  /** Smoothed frame interval the render clock advances by; null before the second `update`. */
  private frameMs: number | null = null;
  private lastUpdateMs = 0;
  private maxServerTick = 0;
  private snapCount = 0;

  constructor(opts: NetClockOptions) {
    this.now = opts.now;
    this.maxInputLead = opts.maxInputLeadTicks ?? 32;
    if (!Number.isInteger(this.maxInputLead) || this.maxInputLead < 1 || this.maxInputLead > 256) {
      throw new RangeError('NetClock: maxInputLeadTicks must be an integer in 1..256');
    }
  }

  /** `tickMs = 1000 / tickRate`; `snapshotIntervalMs = tickMs × snapshotEvery`. Default 60 / 3. */
  configure(tickRate: number, snapshotEvery: number): void {
    if (!(Number.isFinite(tickRate) && tickRate > 0)) {
      throw new RangeError(`NetClock: tickRate must be a positive number, got ${tickRate}`);
    }
    if (!Number.isInteger(snapshotEvery) || snapshotEvery < 1) {
      throw new RangeError(`NetClock: snapshotEvery must be an integer >= 1, got ${snapshotEvery}`);
    }
    this.rate = tickRate;
    this.every = snapshotEvery;
  }

  get tickRate(): number {
    return this.rate;
  }

  get snapshotEvery(): number {
    return this.every;
  }

  get tickMs(): number {
    return 1000 / this.rate;
  }

  get snapshotIntervalMs(): number {
    return (1000 * this.every) / this.rate;
  }

  /** Smoothed round-trip time from Pongs; 0 until the first Pong. */
  get rttMs(): number {
    return this.rtt;
  }

  /** Smoothed deviation of snapshot inter-arrival times, clamped to `JITTER_MIN_MS..JITTER_MAX_MS`. */
  get jitterMs(): number {
    return this.jitter;
  }

  /**
   * Server ms minus client ms: the window's least delayed sample, plus half the RTT; 0 before the
   * first sample.
   */
  get offsetMs(): number {
    return this.synced ? this.seen + this.rtt / 2 : 0;
  }

  /** Server ms at which tick 0 started: the earliest sample since `reset()`; 0 before the first. */
  get tickEpochMs(): number {
    return this.epoch;
  }

  /** At least one sample. */
  get synced(): boolean {
    return this.window.length > 0;
  }

  /** Times `update` snapped the render clock instead of slewing it. */
  get snaps(): number {
    return this.snapCount;
  }

  /** The render clock in server ms; `null` until the first `update` after a sample. */
  get renderTimeMs(): number | null {
    return this.renderMs;
  }

  /** `2 × snapshotIntervalMs + jitterMs`. */
  get interpDelayMs(): number {
    return 2 * this.snapshotIntervalMs + this.jitter;
  }

  /** `interpDelayMs` rounded up to whole ticks. */
  get interpDelayTicks(): number {
    return Math.ceil((this.interpDelayMs * this.rate) / 1000 - TICK_EPSILON);
  }

  /** Ticks ahead of the server tick that inputs target: `ceil((rttMs / 2) / tickMs) + 1`. */
  get inputLead(): number {
    return Math.min(
      this.maxInputLead,
      Math.ceil(((this.rtt / 2) * this.rate) / 1000 - TICK_EPSILON) + 1,
    );
  }

  /** The window's offset samples, oldest first. */
  samples(): number[] {
    const n = this.window.length;
    const out: number[] = [];
    const start = n < CLOCK_WINDOW ? 0 : this.windowNext;
    for (let i = 0; i < n; i++) out.push(this.window[(start + i) % n] as number);
    return out;
  }

  addSample(serverTimeMs: number, serverTick: number, clientRecvMs: number): void {
    const seenMs = serverTimeMs - clientRecvMs;
    const epochMs = serverTimeMs - (serverTick * 1000) / this.rate;
    if (!Number.isFinite(seenMs) || !Number.isFinite(epochMs)) return;
    if (this.window.length === 0 || epochMs < this.epoch) this.epoch = epochMs;
    if (this.window.length < CLOCK_WINDOW) this.window.push(seenMs);
    else this.window[this.windowNext] = seenMs;
    this.windowNext = (this.windowNext + 1) % CLOCK_WINDOW;
    let seen = -Infinity;
    for (const s of this.window) if (s > seen) seen = s;
    this.seen = seen;
  }

  /**
   * A Pong for a Ping sent with `clientTimeMs = toU32Ms(now())`, received at `recvMs`: an RTT sample,
   * and a clock sample.
   *
   * Delays only ever add to a sample (a Pong handled late because the page was busy, e.g. building
   * the renderer right after Welcome), so the estimate falls to a lower sample at once and rises by
   * `RTT_ALPHA`: one stalled Pong must not hold `inputLead` up for tens of seconds, which pushes
   * every input frame beyond the server's input queue.
   */
  onPong(clientTimeMs: number, serverTimeMs: number, serverTick: number, recvMs: number): void {
    const sample = elapsedSinceU32(recvMs, clientTimeMs);
    if (!(sample >= 0)) return; // not a Pong for one of our Pings
    if (!this.rttMeasured || sample < this.rtt) this.rtt = sample;
    else this.rtt += RTT_ALPHA * (sample - this.rtt);
    this.rttMeasured = true;
    this.addSample(serverTimeMs, serverTick, recvMs);
  }

  /** A snapshot header's `serverTimeMs`/`serverTick`, received at `recvMs`. */
  onSnapshotArrival(serverTimeMs: number, serverTick: number, recvMs: number): void {
    this.addSample(serverTimeMs, serverTick, recvMs);
    if (this.lastSnapshotRecvMs !== null) {
      const deviation = Math.abs(recvMs - this.lastSnapshotRecvMs - this.snapshotIntervalMs);
      this.jitterRaw += JITTER_ALPHA * (deviation - this.jitterRaw);
      this.jitter = Math.min(Math.max(this.jitterRaw, JITTER_MIN_MS), JITTER_MAX_MS);
    }
    this.lastSnapshotRecvMs = recvMs;
  }

  /**
   * Advances the render clock to `nowMs`: jumps to the target on the first call; otherwise advances
   * by the smoothed frame interval and compares with the target at the same instant, snapping when
   * more than `SNAP_THRESHOLD_MS` off and else correcting by at most `SLEW_RATE × dt` (never past
   * the target) outside the `SLEW_DEADBAND_MS` deadband. No-op until synced.
   *
   * It advances by `frameMs` -- the interval smoothed by `FRAME_ALPHA`, reset outright by a change
   * of `FRAME_RESET_MS` or more -- rather than by the raw elapsed time, because frame timestamps
   * are noisy by a millisecond or two even at a steady frame rate and that noise would otherwise
   * land directly in rendered motion. The correction budget stays on the raw `dt`: it is a real
   * time allowance, and smoothing loses nothing, since the slew is what holds the clock on the
   * target in the long run.
   */
  update(nowMs: number): void {
    if (!this.synced) return;
    const target = nowMs + this.offsetMs - (this.interpDelayTicks * 1000) / this.rate;
    if (this.renderMs === null) {
      this.renderMs = target;
      this.lastUpdateMs = nowMs;
      this.frameMs = null;
      return;
    }
    const dt = Math.max(0, nowMs - this.lastUpdateMs);
    this.lastUpdateMs = nowMs;
    if (this.frameMs === null || Math.abs(dt - this.frameMs) >= FRAME_RESET_MS) this.frameMs = dt;
    else this.frameMs += FRAME_ALPHA * (dt - this.frameMs);
    const advanced = this.renderMs + this.frameMs;
    const err = target - advanced;
    const absErr = Math.abs(err);
    if (absErr > SNAP_THRESHOLD_MS) {
      this.renderMs = target;
      this.snapCount++;
      return;
    }
    let correction = 0;
    if (absErr > SLEW_DEADBAND_MS) correction = Math.sign(err) * Math.min(dt * SLEW_RATE, absErr);
    this.renderMs = advanced + correction;
  }

  /** Estimated server ms now. */
  serverTimeNow(): number {
    return this.now() + this.offsetMs;
  }

  /**
   * Estimated server tick now (floor); 0 until synced. Never decreases, even when the window's
   * least delayed sample leaves it and the offset estimate falls, until `reset()`.
   */
  serverTickNow(): number {
    if (!this.synced) return 0;
    const ticks = ((this.serverTimeNow() - this.epoch) * this.rate) / 1000;
    const tick = Math.floor(ticks + TICK_EPSILON);
    if (tick > this.maxServerTick) this.maxServerTick = tick;
    return this.maxServerTick;
  }

  /** Fractional tick the render clock is at; 0 before the first `update`. */
  renderTick(): number {
    if (this.renderMs === null) return 0;
    return ((this.renderMs - this.epoch) * this.rate) / 1000;
  }

  /** The tick an input sent now should carry: `serverTickNow() + inputLead`. */
  inputTick(): number {
    return this.serverTickNow() + this.inputLead;
  }

  /** Absolute local deadline at which the input target can advance, including clock corrections. */
  nextInputDeadline(lastTick: number): number {
    return this.epoch + ((lastTick + 1 - this.inputLead) * 1000) / this.rate - this.offsetMs;
  }

  /** Forgets jitter history; the offset window and RTT survive (same server, docs/net.md B.4). */
  resetJitter(): void {
    this.jitterRaw = 0;
    this.jitter = 0;
    this.lastSnapshotRecvMs = null;
  }

  /** Forgets everything but the configured rates (a connection to a new session). */
  reset(): void {
    this.window.length = 0;
    this.windowNext = 0;
    this.seen = 0;
    this.epoch = 0;
    this.rtt = 0;
    this.rttMeasured = false;
    this.resetJitter();
    this.renderMs = null;
    this.frameMs = null;
    this.lastUpdateMs = 0;
    this.maxServerTick = 0;
    this.snapCount = 0;
  }
}
