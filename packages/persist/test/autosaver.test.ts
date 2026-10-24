import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTOSAVE_INTERVAL_MS, Autosaver } from '../src/index.ts';

const INTERVAL = 1_000;

/** Lets every pending promise reaction run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A manual clock for the injected `setTimeout`/`clearTimeout`. */
class FakeTimers {
  now = 0;
  readonly delays: number[] = [];
  private nextId = 1;
  private readonly timers = new Map<number, { due: number; callback: () => void }>();

  readonly setTimeout = (callback: () => void, ms: number): number => {
    const id = this.nextId++;
    this.delays.push(ms);
    this.timers.set(id, { due: this.now + ms, callback });
    return id;
  };

  readonly clearTimeout = (handle: unknown): void => {
    if (typeof handle === 'number') this.timers.delete(handle);
  };

  get pending(): number {
    return this.timers.size;
  }

  /** Moves the clock forward, firing due timers in order and settling promises after each. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      let nextId = -1;
      let next: { due: number; callback: () => void } | undefined;
      for (const [id, timer] of this.timers) {
        if (timer.due <= end && (next === undefined || timer.due < next.due)) {
          nextId = id;
          next = timer;
        }
      }
      if (next === undefined) break;
      this.timers.delete(nextId);
      this.now = next.due;
      next.callback();
      await settle();
    }
    this.now = end;
    await settle();
  }
}

interface Call {
  resolve(): void;
  reject(err: unknown): void;
}

/** A save function whose calls stay pending until the test settles them. */
function controlledSave(): { fn: () => Promise<void>; calls: Call[]; maxActive: () => number } {
  const calls: Call[] = [];
  let active = 0;
  let maxActive = 0;
  const fn = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      active++;
      maxActive = Math.max(maxActive, active);
      const done = (): void => {
        active--;
      };
      calls.push({
        resolve: () => {
          done();
          resolve();
        },
        reject: (err) => {
          done();
          reject(err);
        },
      });
    });
  return { fn, calls, maxActive: () => maxActive };
}

function lastCall(calls: Call[]): Call {
  const call = calls.at(-1);
  if (call === undefined) throw new Error('fn was not called');
  return call;
}

function setup() {
  const timers = new FakeTimers();
  const save = controlledSave();
  const onError = vi.fn();
  const saver = new Autosaver(save.fn, INTERVAL, {
    onError,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  return { timers, save, onError, saver };
}

/** Tracks whether a promise has settled, without leaving a rejection unhandled. */
function track(promise: Promise<void>): { settled: () => boolean } {
  let settled = false;
  const markSettled = (): void => {
    settled = true;
  };
  promise.then(markSettled, markSettled);
  return { settled: () => settled };
}

describe('Autosaver', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('start() calls fn once per interval', async () => {
    const { timers, save, saver } = setup();
    expect(saver.running).toBe(false);
    saver.start();
    saver.start(); // idempotent: still one timer
    expect(saver.running).toBe(true);
    expect(timers.pending).toBe(1);

    await timers.advance(INTERVAL - 1);
    expect(save.calls).toHaveLength(0);
    await timers.advance(1);
    expect(save.calls).toHaveLength(1);
    expect(saver.inFlight).toBe(true);
    const before = Date.now();
    lastCall(save.calls).resolve();
    await settle();
    expect(saver.inFlight).toBe(false);
    expect(saver.lastSavedAt).toBeGreaterThanOrEqual(before);

    for (let n = 2; n <= 4; n++) {
      await timers.advance(INTERVAL);
      expect(save.calls).toHaveLength(n);
      lastCall(save.calls).resolve();
      await settle();
    }
    expect(timers.delays).toEqual([INTERVAL, INTERVAL, INTERVAL, INTERVAL, INTERVAL]);
  });

  it('a fn slower than the interval is never overlapped and the skipped tick is not queued', async () => {
    const { timers, save, saver } = setup();
    saver.start();
    await timers.advance(INTERVAL);
    expect(save.calls).toHaveLength(1);

    // The next timer is armed only after the save settles.
    await timers.advance(INTERVAL * 5);
    expect(save.calls).toHaveLength(1);
    expect(timers.pending).toBe(0);
    lastCall(save.calls).resolve();
    await settle();
    expect(save.calls).toHaveLength(1); // no catch-up save for the missed intervals
    await timers.advance(INTERVAL - 1);
    expect(save.calls).toHaveLength(1);
    await timers.advance(1);
    expect(save.calls).toHaveLength(2);
    lastCall(save.calls).resolve();
    await settle();

    // A tick that fires while a flush() save is in flight is skipped, not queued behind it.
    const flushed = saver.flush();
    expect(save.calls).toHaveLength(3);
    await timers.advance(INTERVAL);
    expect(save.calls).toHaveLength(3);
    lastCall(save.calls).resolve();
    await flushed;
    await settle();
    expect(save.calls).toHaveLength(3);
    await timers.advance(INTERVAL);
    expect(save.calls).toHaveLength(4);
    lastCall(save.calls).resolve();
    await settle();
    expect(save.maxActive()).toBe(1);
  });

  it('flush() during an in-flight save waits for it and runs fn exactly once more, shared by concurrent calls', async () => {
    const save = controlledSave();
    let writes = 0;
    const seenAtStart: number[] = [];
    const saver = new Autosaver(
      () => {
        seenAtStart.push(writes);
        return save.fn();
      },
      INTERVAL,
      { onError: () => {}, setTimeout: () => 0, clearTimeout: () => {} },
    );

    const first = saver.flush();
    expect(save.calls).toHaveLength(1);
    writes = 1; // made after the first save started: only a later save covers it
    const a = saver.flush();
    const b = saver.flush();
    const c = saver.flush();
    expect(b).toBe(a);
    expect(c).toBe(a);
    const tracked = track(a);
    await settle();
    expect(save.calls).toHaveLength(1); // waits for the save in flight
    expect(tracked.settled()).toBe(false);

    save.calls[0]?.resolve();
    await first;
    await settle();
    expect(save.calls).toHaveLength(2);
    expect(tracked.settled()).toBe(false);
    save.calls[1]?.resolve();
    await Promise.all([a, b, c]);
    await settle();
    expect(save.calls).toHaveLength(2);
    expect(seenAtStart).toEqual([0, 1]);
    expect(save.maxActive()).toBe(1);
  });

  it('a flush() or tick between the end of a save and the start of the queued one starts no extra save', async () => {
    const { timers, save, saver } = setup();
    saver.start();
    const first = saver.flush();
    const queued = saver.flush();
    // Runs after `first` settles but before the queued save has called fn.
    let lateFlush: Promise<void> | undefined;
    const gap = first.then(() => {
      expect(saver.inFlight).toBe(false);
      expect(save.calls).toHaveLength(1);
      lateFlush = saver.flush();
      return timers.advance(INTERVAL); // the timer fires synchronously in here: skipped
    });
    save.calls[0]?.resolve();
    await gap;
    expect(lateFlush).toBe(queued);
    expect(save.calls).toHaveLength(2);
    expect(save.maxActive()).toBe(1);
    expect(timers.pending).toBe(1); // the skipped tick re-armed
    save.calls[1]?.resolve();
    await queued;
    await settle();
    expect(save.calls).toHaveLength(2);
  });

  it('stop() cancels the timer and performs one final save', async () => {
    const { timers, save, saver } = setup();
    saver.start();
    await timers.advance(INTERVAL / 2);
    const stopped = saver.stop();
    expect(saver.running).toBe(false);
    expect(timers.pending).toBe(0);
    expect(save.calls).toHaveLength(1);
    expect(saver.stop()).toBe(stopped); // idempotent: no second final save
    const tracked = track(stopped);
    await settle();
    expect(tracked.settled()).toBe(false); // resolves after the save
    lastCall(save.calls).resolve();
    await stopped;
    await timers.advance(INTERVAL * 10);
    expect(save.calls).toHaveLength(1);
  });

  it('stop() during a timed save coalesces the final save behind it', async () => {
    const { timers, save, saver } = setup();
    saver.start();
    await timers.advance(INTERVAL);
    expect(save.calls).toHaveLength(1);
    const stopped = track(saver.stop());
    await settle();
    expect(save.calls).toHaveLength(1);
    save.calls[0]?.resolve();
    await settle();
    expect(save.calls).toHaveLength(2); // the final save starts after the timed one
    expect(timers.pending).toBe(0); // and the timed save did not re-arm the timer
    expect(stopped.settled()).toBe(false);
    save.calls[1]?.resolve();
    await settle();
    expect(stopped.settled()).toBe(true);
    expect(save.maxActive()).toBe(1);
  });

  it('fn rejection reaches onError, lastError and the flush() caller, and the next tick still runs', async () => {
    const { timers, save, onError, saver } = setup();
    saver.start();
    await timers.advance(INTERVAL);
    const timedErr = new Error('timed save failed');
    lastCall(save.calls).reject(timedErr);
    await settle();
    expect(onError).toHaveBeenCalledWith(timedErr);
    expect(saver.lastError).toBe(timedErr);
    expect(saver.lastSavedAt).toBeNull();
    expect(timers.pending).toBe(1); // re-armed after the failure

    const flushErr = new Error('flush failed');
    const flushed = saver.flush();
    lastCall(save.calls).reject(flushErr);
    await expect(flushed).rejects.toBe(flushErr);
    expect(onError).toHaveBeenLastCalledWith(flushErr);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(saver.lastError).toBe(flushErr);

    await timers.advance(INTERVAL);
    expect(save.calls).toHaveLength(3);
    lastCall(save.calls).resolve();
    await settle();
    expect(saver.lastSavedAt).not.toBeNull();
    expect(saver.lastError).toBe(flushErr); // the most recent error is kept

    // A queued follow-up that fails rejects every caller sharing it.
    const inFlight = saver.flush();
    const shared = [saver.flush(), saver.flush()];
    lastCall(save.calls).resolve();
    await inFlight;
    await settle();
    expect(save.calls).toHaveLength(5);
    const queuedErr = new Error('queued save failed');
    lastCall(save.calls).reject(queuedErr);
    for (const p of shared) await expect(p).rejects.toBe(queuedErr);
  });

  it('a synchronous throw from fn is a failed save, not a stuck one', async () => {
    const err = new Error('sync');
    const onError = vi.fn();
    let calls = 0;
    const saver = new Autosaver(
      () => {
        calls++;
        if (calls === 1) throw err;
        return Promise.resolve();
      },
      INTERVAL,
      { onError, setTimeout: () => 0, clearTimeout: () => {} },
    );
    await expect(saver.flush()).rejects.toBe(err);
    expect(onError).toHaveBeenCalledWith(err);
    expect(saver.inFlight).toBe(false);
    await saver.flush();
    expect(calls).toBe(2);
  });

  it('stop() without start() performs one save', async () => {
    const { timers, save, saver } = setup();
    const stopped = saver.stop();
    expect(save.calls).toHaveLength(1);
    lastCall(save.calls).resolve();
    await stopped;
    expect(saver.running).toBe(false);
    expect(timers.pending).toBe(0);
    expect(timers.delays).toEqual([]);
    expect(saver.lastSavedAt).not.toBeNull();
  });

  it('defaults: 60 s interval, unref() on the timer handle, console.error, and a valid interval', async () => {
    expect(AUTOSAVE_INTERVAL_MS).toBe(60_000);
    const unref = vi.fn();
    const handle = { unref };
    const delays: number[] = [];
    const cleared: unknown[] = [];
    const saver = new Autosaver(() => Promise.reject(new Error('default report')), undefined, {
      setTimeout: (_callback, ms) => {
        delays.push(ms);
        return handle;
      },
      clearTimeout: (h) => cleared.push(h),
    });
    saver.start();
    expect(delays).toEqual([AUTOSAVE_INTERVAL_MS]);
    expect(unref).toHaveBeenCalledTimes(1);

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(saver.stop()).rejects.toThrow('default report');
    expect(cleared).toEqual([handle]);
    expect(consoleError).toHaveBeenCalledTimes(1);

    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      expect(() => new Autosaver(() => Promise.resolve(), bad)).toThrow(RangeError);
    }
  });

  it('works with the global timers by default', async () => {
    let calls = 0;
    const saver = new Autosaver(async () => {
      calls++;
    }, 5);
    saver.start();
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2), { timeout: 2_000 });
    await saver.stop();
    const afterStop = calls;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(afterStop);
  });
});
