export interface FixedLoopOpts {
  tickRate: number;
  onTick(tick: number): void;
  /**
   * A wake found more ticks due than `maxCatchUpTicks`: `droppedTicks` of them never run, and their
   * numbers are skipped, so tick numbers keep to the clock (docs/sim.md 2.10). Called before the
   * wake's ticks run, which are the latest due.
   */
  onOverrun(droppedTicks: number): void;
  /** Milliseconds; default `performance.now`. */
  now?: (() => number) | undefined;
  /**
   * Default: Node timers compensated for their slack, which never fire early (docs/sim.md 2.10).
   * An injected timer gets the exact fractional delay; the loop re-arms if it fires early.
   */
  setTimeout?: ((fn: () => void, ms: number) => unknown) | undefined;
  /** Default: cancels a default timer, or a `globalThis.setTimeout` handle. */
  clearTimeout?: ((h: unknown) => void) | undefined;
  /** Default `MAX_CATCH_UP_TICKS`. */
  maxCatchUpTicks?: number | undefined;
}

/** Most ticks one wake runs; the loop drops any more that are due (their numbers skipped). */
export const MAX_CATCH_UP_TICKS = 5;

// FixedLoop is the driver the Session runs the sim with, not sim code: it is the only module in
// packages/sim/src that reads the wall clock or arms timers (docs/sim.md 2.10). `defaultNow` and
// `DefaultTimers` below hold the only such references; everything else goes through the injected
// functions.
function defaultNow(): number {
  // eslint-disable-next-line no-restricted-globals, no-restricted-properties -- FixedLoop's default wall clock (docs/sim.md 2.10)
  return performance.now();
}

/** Remainders shorter than this are polled with setImmediate: a Node timer waits at least 1 ms. */
const POLL_BELOW_MS = 1;
/** The learned lead starts here; the cap bounds how early a wait is armed if timers turn erratic. */
const INITIAL_LEAD_MS = 1;
const MAX_LEAD_MS = 4;
/** Unequal steps make the lead settle where 3 in 4 timers overshoot by no more than it. */
const LEAD_STEP_UP_MS = 0.15;
const LEAD_STEP_DOWN_MS = 0.05;

/** A pending default wait: at most one of the two Node handles is set. */
class DefaultTimer {
  timeout: ReturnType<typeof globalThis.setTimeout> | undefined = undefined;
  immediate: ReturnType<typeof globalThis.setImmediate> | undefined = undefined;
}

/**
 * FixedLoop's default timers (docs/sim.md 2.10). Node's `setTimeout(fn, k)` waits whole
 * milliseconds and the OS adds slack on top (macOS timer coalescing: about `min(k / 4, 2)` ms), so
 * a plain 12-16 ms timer lands 1-2 ms late. Each wait here arms a Node timer `leadMs` early,
 * rounded to whole ms, where `leadMs` tracks that overshoot; a remainder of at least 1 ms gets
 * another timer, a shorter one is polled with `setImmediate`. The callback never runs before `ms`
 * has elapsed on `performance.now`.
 */
class DefaultTimers {
  private leadMs = INITIAL_LEAD_MS;

  readonly setTimeout = (fn: () => void, ms: number): DefaultTimer => {
    const timer = new DefaultTimer();
    const due = defaultNow() + ms;
    let first = true;
    const check = (): void => {
      timer.timeout = undefined;
      timer.immediate = undefined;
      const left = due - defaultNow();
      if (left <= 0) fn();
      else wait(left);
    };
    const wait = (left: number): void => {
      if (left < POLL_BELOW_MS) {
        // eslint-disable-next-line no-restricted-syntax -- FixedLoop's default timer (docs/sim.md 2.10)
        timer.immediate = globalThis.setImmediate(check);
        return;
      }
      const k = Math.max(1, Math.round(left - this.leadMs));
      const learn = first;
      first = false;
      const armedAt = defaultNow();
      // eslint-disable-next-line no-restricted-syntax -- FixedLoop's default timer (docs/sim.md 2.10)
      timer.timeout = globalThis.setTimeout(() => {
        // Learn from the first timer of each wait only: follow-up timers are short, and macOS
        // gives short timers less slack.
        if (learn) this.learn(defaultNow() - armedAt - k);
        check();
      }, k);
    };
    wait(ms);
    return timer;
  };

  readonly clearTimeout = (h: unknown): void => {
    if (h instanceof DefaultTimer) {
      globalThis.clearTimeout(h.timeout);
      globalThis.clearImmediate(h.immediate);
      h.timeout = undefined;
      h.immediate = undefined;
    } else {
      globalThis.clearTimeout(h as Parameters<typeof globalThis.clearTimeout>[0]);
    }
  };

  private learn(overshootMs: number): void {
    const step = overshootMs > this.leadMs ? LEAD_STEP_UP_MS : -LEAD_STEP_DOWN_MS;
    this.leadMs = Math.min(MAX_LEAD_MS, Math.max(0, this.leadMs + step));
  }
}

/**
 * Fixed-timestep driver with absolute deadlines (docs/sim.md 2.10): timer lateness does not
 * accumulate, and a wake runs at most `maxCatchUpTicks` ticks: the latest due. Any more due it drops
 * (`onOverrun`) rather than spiral -- skipping their numbers, with the deadlines kept on their grid,
 * so tick `k` always belongs to the same instant (`start` + `k` ticks), however long the loop was
 * held up. A client maps ticks onto the server's clock (docs/net.md B.4); were the dropped ticks
 * renumbered from where the loop left off, every tick after a stall would lag the clock by them for
 * good, and the clients would draw ahead of what they receive and send inputs for ticks that far
 * ahead of the server.
 */
export class FixedLoop {
  private readonly tickMs: number;
  private readonly maxCatchUp: number;
  private readonly onTick: (tick: number) => void;
  private readonly onOverrun: (droppedTicks: number) => void;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;

  private isRunning = false;
  private currentTick = 0;
  private nextDeadline = 0;
  private timer: unknown = undefined;
  private armed = false;
  /** Bumped by `start` and `stop`; a wake from an earlier run is ignored. */
  private epoch = 0;

  private wakes = 0;
  private ticks = 0;
  private overruns = 0;
  private droppedTicks = 0;
  private maxTicksPerWake = 0;
  private lastLateMs = 0;

  constructor(opts: FixedLoopOpts) {
    if (!(Number.isFinite(opts.tickRate) && opts.tickRate > 0)) {
      throw new RangeError(`FixedLoop: tickRate must be a positive number, got ${opts.tickRate}`);
    }
    const maxCatchUp = opts.maxCatchUpTicks ?? MAX_CATCH_UP_TICKS;
    if (!Number.isInteger(maxCatchUp) || maxCatchUp < 1) {
      throw new RangeError(`FixedLoop: maxCatchUpTicks must be an integer >= 1, got ${maxCatchUp}`);
    }
    this.tickMs = 1000 / opts.tickRate;
    this.maxCatchUp = maxCatchUp;
    this.onTick = (tick) => opts.onTick(tick);
    this.onOverrun = (dropped) => opts.onOverrun(dropped);
    this.now = opts.now ?? defaultNow;
    const timers = new DefaultTimers();
    this.setTimer = opts.setTimeout ?? timers.setTimeout;
    this.clearTimer = opts.clearTimeout ?? timers.clearTimeout;
  }

  get running(): boolean {
    return this.isRunning;
  }

  /** The last tick passed to `onTick`, or skipped since; reset to 0 by `start`. */
  get tick(): number {
    return this.currentTick;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.epoch++;
    this.currentTick = 0;
    this.nextDeadline = this.now() + this.tickMs;
    this.arm();
  }

  /** Cancels the pending timer. Safe to call from `onTick`: no further tick of this wake runs. */
  stop(): void {
    this.isRunning = false;
    this.epoch++;
    if (this.armed) {
      const h = this.timer;
      this.armed = false;
      this.timer = undefined;
      this.clearTimer(h);
    }
  }

  /**
   * Cumulative counters. `lastLateMs` is `now - deadline` at the start of the latest wake, where
   * `deadline` is the one the timer was armed for; negative for an early wake.
   */
  stats(): {
    wakes: number;
    ticks: number;
    overruns: number;
    droppedTicks: number;
    maxTicksPerWake: number;
    lastLateMs: number;
  } {
    return {
      wakes: this.wakes,
      ticks: this.ticks,
      overruns: this.overruns,
      droppedTicks: this.droppedTicks,
      maxTicksPerWake: this.maxTicksPerWake,
      lastLateMs: this.lastLateMs,
    };
  }

  private arm(): void {
    const epoch = this.epoch;
    const delay = Math.max(0, this.nextDeadline - this.now());
    this.armed = true;
    this.timer = this.setTimer(() => this.wake(epoch), delay);
  }

  private wake(epoch: number): void {
    if (!this.isRunning || epoch !== this.epoch) return;
    this.armed = false;
    this.timer = undefined;
    const t = this.now();
    const late = t - this.nextDeadline;
    let n = 0;
    while (this.nextDeadline <= t && n < this.maxCatchUp) {
      n++;
      this.nextDeadline += this.tickMs;
    }
    this.wakes++;
    this.lastLateMs = late;
    if (n > this.maxTicksPerWake) this.maxTicksPerWake = n;
    try {
      if (this.nextDeadline <= t) {
        // Still behind after the cap: the ticks due before the last `n` are dropped, numbers and
        // all, and the deadlines stay on their grid (the next is the first after `t`).
        const dropped = Math.floor((t - this.nextDeadline) / this.tickMs) + 1;
        this.nextDeadline += dropped * this.tickMs;
        this.currentTick += dropped;
        this.overruns++;
        this.droppedTicks += dropped;
        this.onOverrun(dropped);
      }
      for (let i = 0; i < n && this.isRunning && epoch === this.epoch; i++) {
        this.currentTick++;
        this.ticks++;
        this.onTick(this.currentTick);
      }
    } finally {
      if (this.isRunning && epoch === this.epoch) this.arm();
    }
  }
}
