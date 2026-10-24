/** Default autosave period: at most this much play is lost when a session crashes (docs/host.md). */
export const AUTOSAVE_INTERVAL_MS = 60_000;

/** Longest delay `setTimeout` honours; Node fires longer ones after 1 ms. */
const MAX_INTERVAL_MS = 2_147_483_647;

export interface AutosaverOptions {
  /** Receives every error from `fn` (default `console.error`); also rethrown to `flush()`/`stop()`. */
  onError?: (err: unknown) => void;
  /** Injectable for tests; defaults to the global. A returned handle with `unref()` is unref'd. */
  setTimeout?(callback: () => void, ms: number): unknown;
  /** Injectable for tests; defaults to the global. Receives handles from `setTimeout`. */
  clearTimeout?(handle: unknown): void;
}

function ignore(): void {}

/**
 * Calls an async save function every `intervalMs` and on demand (docs/persist.md 1.8). Saves never
 * overlap: the next timer is armed after a timed save settles, a timer that fires during a save is
 * skipped, and `flush()` during a save queues one follow-up save shared by every caller.
 */
export class Autosaver {
  private readonly fn: () => Promise<void>;
  private readonly intervalMs: number;
  private readonly onError: (err: unknown) => void;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private timer: { handle: unknown } | null = null;
  private isRunning = false;
  /** The save calling `fn` right now. */
  private current: Promise<void> | null = null;
  /** The follow-up save requested by `flush()` during `current`; null once it has started. */
  private queued: Promise<void> | null = null;
  /** The final save of `stop()`, returned again by later `stop()` calls until `start()`. */
  private stopping: Promise<void> | null = null;
  private savedAt: number | null = null;
  private error: unknown = undefined;

  constructor(
    fn: () => Promise<void>,
    intervalMs = AUTOSAVE_INTERVAL_MS,
    opts: AutosaverOptions = {},
  ) {
    if (!(intervalMs > 0 && intervalMs <= MAX_INTERVAL_MS)) {
      throw new RangeError(`intervalMs must be in (0, ${MAX_INTERVAL_MS}] ms, got ${intervalMs}`);
    }
    this.fn = fn;
    this.intervalMs = intervalMs;
    this.onError = opts.onError ?? ((err) => console.error('Autosaver: save failed', err));
    this.setTimer = opts.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer =
      opts.clearTimeout ?? ((handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
  }

  /** `start()` was called and `stop()` has not been called since. */
  get running(): boolean {
    return this.isRunning;
  }

  /** A call to `fn` is pending. */
  get inFlight(): boolean {
    return this.current !== null;
  }

  /** `Date.now()` when the last successful save finished, or null. */
  get lastSavedAt(): number | null {
    return this.savedAt;
  }

  /** The most recent error from `fn` (not cleared by later successes), or undefined. */
  get lastError(): unknown {
    return this.error;
  }

  /** Arms the interval timer; idempotent. */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.stopping = null;
    this.arm();
  }

  /**
   * Cancels the timer and performs one final save (coalesced with a save in flight); resolves or
   * rejects with that save. Works without `start()`. Idempotent: later calls return the same
   * promise until `start()` is called again.
   */
  stop(): Promise<void> {
    if (this.stopping !== null) return this.stopping;
    this.isRunning = false;
    this.disarm();
    this.stopping = this.flush();
    return this.stopping;
  }

  /**
   * Saves now. When a save is in flight, waits for it and then runs `fn` once more; concurrent
   * callers share that follow-up. Once this resolves, every write made before the call has gone
   * through a complete `fn` call that started after it.
   */
  flush(): Promise<void> {
    // A follow-up that has not started yet covers this caller too. Checked before `current`:
    // between the end of one save and the start of the follow-up, both are clear of `current`.
    if (this.queued !== null) return this.queued;
    if (this.current === null) return this.run();
    const queued = this.current.catch(ignore).then(() => {
      if (this.queued === queued) this.queued = null;
      return this.run();
    });
    this.queued = queued;
    return queued;
  }

  private run(): Promise<void> {
    const fn = this.fn;
    let result: Promise<void>;
    try {
      result = Promise.resolve(fn());
    } catch (err) {
      result = Promise.reject(err); // a synchronous throw counts as a failed save
    }
    const save = result
      .then(
        () => {
          this.savedAt = Date.now();
        },
        (err: unknown) => {
          this.error = err;
          this.onError(err);
          throw err;
        },
      )
      .finally(() => {
        if (this.current === save) this.current = null;
      });
    this.current = save;
    return save;
  }

  private tick(): void {
    this.timer = null;
    if (!this.isRunning) return;
    if (this.current !== null || this.queued !== null) {
      this.arm(); // skipped, not queued: the save in flight covers this interval
      return;
    }
    this.run()
      .catch(ignore) // reported through onError; the timer keeps running
      .then(() => {
        if (this.isRunning) this.arm();
      });
  }

  private arm(): void {
    this.disarm();
    const handle = this.setTimer(() => this.tick(), this.intervalMs);
    if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
      if (typeof handle.unref === 'function') handle.unref();
    }
    this.timer = { handle };
  }

  private disarm(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer.handle);
    this.timer = null;
  }
}
