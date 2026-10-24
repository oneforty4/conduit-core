/** A frame's `dt` is clamped to this many seconds (tab throttling, breakpoints). */
export const MAX_FRAME_DT = 0.25;
/** Default interval of the interval driver: 60 Hz. */
export const DEFAULT_FRAME_INTERVAL_MS = 1000 / 60;

export interface FrameLoopTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface FrameLoopOptions {
  /** One frame: `nowMs` on the `now` time base, `dt` in seconds within `[0, MAX_FRAME_DT]`. */
  onFrame: (nowMs: number, dt: number) => void;
  /** Default `'raf'` where `requestAnimationFrame` exists, else `'interval'`. */
  mode?: 'raf' | 'interval';
  /** Interval driver period; default `DEFAULT_FRAME_INTERVAL_MS`. */
  intervalMs?: number;
  /** Milliseconds; default `performance.now`. */
  now?: () => number;
  /** Default the global `requestAnimationFrame` / `cancelAnimationFrame`. */
  raf?: (cb: (timeMs: number) => void) => number;
  caf?: (id: number) => void;
  /** Default the global timers. */
  timers?: FrameLoopTimers;
}

const globalTimers: FrameLoopTimers = {
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) =>
    globalThis.clearInterval(h as Parameters<typeof globalThis.clearInterval>[0]),
};

function clampDt(dt: number): number {
  return Number.isFinite(dt) ? Math.min(Math.max(dt, 0), MAX_FRAME_DT) : 0;
}

/**
 * Drives `onFrame` from `requestAnimationFrame` or an interval (docs/game.md 4). The interval driver
 * passes the nominal period as `dt`; the rAF driver and manual `tick(nowMs)` pass the time since
 * the previous frame (0 for the first). An exception from `onFrame` stops the loop and propagates.
 */
export class FrameLoop {
  private readonly onFrame: (nowMs: number, dt: number) => void;
  private readonly mode: 'raf' | 'interval';
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly raf: ((cb: (timeMs: number) => void) => number) | undefined;
  private readonly caf: ((id: number) => void) | undefined;
  private readonly timers: FrameLoopTimers;
  private handle: unknown = null;
  private rafId: number | null = null;
  private isRunning = false;
  private lastMs: number | null = null;

  constructor(opts: FrameLoopOptions) {
    const hasRaf = typeof globalThis.requestAnimationFrame === 'function';
    this.onFrame = opts.onFrame;
    this.mode = opts.mode ?? (opts.raf !== undefined || hasRaf ? 'raf' : 'interval');
    this.intervalMs = opts.intervalMs ?? DEFAULT_FRAME_INTERVAL_MS;
    if (!(Number.isFinite(this.intervalMs) && this.intervalMs > 0)) {
      throw new RangeError(`FrameLoop: intervalMs must be > 0, got ${this.intervalMs}`);
    }
    this.now = opts.now ?? (() => performance.now());
    this.raf = opts.raf ?? (hasRaf ? (cb) => globalThis.requestAnimationFrame(cb) : undefined);
    this.caf = opts.caf ?? (hasRaf ? (id) => globalThis.cancelAnimationFrame(id) : undefined);
    this.timers = opts.timers ?? globalTimers;
    if (this.mode === 'raf' && (this.raf === undefined || this.caf === undefined)) {
      throw new Error('FrameLoop: no requestAnimationFrame here; use mode: interval');
    }
  }

  get running(): boolean {
    return this.isRunning;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastMs = null;
    if (this.mode === 'interval') {
      const dt = this.intervalMs / 1000;
      this.handle = this.timers.setInterval(() => this.tick(this.now(), dt), this.intervalMs);
    } else {
      this.rafId = (this.raf as (cb: (timeMs: number) => void) => number)(this.rafFrame);
    }
  }

  stop(): void {
    this.isRunning = false;
    if (this.handle !== null) {
      this.timers.clearInterval(this.handle);
      this.handle = null;
    }
    if (this.rafId !== null) {
      (this.caf as (id: number) => void)(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * Runs one frame at `nowMs` (manual driving, or the drivers above). `dt` defaults to the time since
   * the previous frame and is clamped to `[0, MAX_FRAME_DT]`.
   */
  tick(nowMs: number, dt?: number): void {
    const elapsed = this.lastMs === null ? 0 : (nowMs - this.lastMs) / 1000;
    this.lastMs = nowMs;
    try {
      this.onFrame(nowMs, clampDt(dt ?? elapsed));
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  private readonly rafFrame = (timeMs?: number): void => {
    this.rafId = null;
    if (!this.isRunning) return;
    // The frame's own timestamp when the driver passes one, not `now()` read at this line: the
    // latter measures when the callback got its turn, and that jitter would end up in the render
    // clock as stutter (docs/game.md 4).
    this.tick(typeof timeMs === 'number' && Number.isFinite(timeMs) ? timeMs : this.now());
    if (this.isRunning && this.rafId === null) {
      this.rafId = (this.raf as (cb: (timeMs: number) => void) => number)(this.rafFrame);
    }
  };
}
