import { describe, expect, it } from 'vitest';
import { FixedLoop, type FixedLoopOpts, MAX_CATCH_UP_TICKS } from '../src/index.ts';

interface VirtualTimer {
  at: number;
  seq: number;
  fn: () => void;
  cancelled: boolean;
}

/** A virtual millisecond clock and timer queue drained in deadline order (then arming order). */
class VirtualTimers {
  now = 0;
  /** Maps the requested delay to the actual one (jitter); default exact. */
  delayFor: (ms: number) => number = (ms) => ms;
  private seq = 0;
  private timers: VirtualTimer[] = [];

  readonly setTimeout = (fn: () => void, ms: number): unknown => {
    const timer = {
      at: this.now + Math.max(0, this.delayFor(ms)),
      seq: this.seq++,
      fn,
      cancelled: false,
    };
    this.timers.push(timer);
    return timer;
  };

  readonly clearTimeout = (h: unknown): void => {
    (h as VirtualTimer).cancelled = true;
  };

  pending(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }

  /** Fires every timer due by `end`; bodies may push `now` past a timer's deadline. */
  advanceTo(end: number): void {
    for (;;) {
      this.timers = this.timers.filter((t) => !t.cancelled);
      let next: VirtualTimer | undefined;
      for (const t of this.timers) {
        if (next === undefined || t.at < next.at || (t.at === next.at && t.seq < next.seq))
          next = t;
      }
      if (next === undefined || next.at > end) break;
      this.timers.splice(this.timers.indexOf(next), 1);
      if (next.at > this.now) this.now = next.at;
      next.fn();
    }
    if (this.now < end) this.now = end;
  }
}

function virtualLoop(
  timers: VirtualTimers,
  opts: Partial<FixedLoopOpts> & { bodyMs?: number } = {},
): { loop: FixedLoop; ticks: number[]; overruns: number[]; wakeTicks: number[] } {
  const ticks: number[] = [];
  const overruns: number[] = [];
  const wakeTicks: number[] = [];
  const { bodyMs = 0, ...rest } = opts;
  const loop: FixedLoop = new FixedLoop({
    tickRate: 60,
    ...rest,
    onTick: (t) => {
      ticks.push(t);
      timers.now += bodyMs;
    },
    onOverrun: (n) => overruns.push(n),
    now: () => timers.now,
    // Wraps each wake to record how many ticks it ran.
    setTimeout: (fn, ms) =>
      timers.setTimeout(() => {
        const before = loop.stats().ticks;
        fn();
        wakeTicks.push(loop.stats().ticks - before);
      }, ms),
    clearTimeout: timers.clearTimeout,
  });
  return { loop, ticks, overruns, wakeTicks };
}

describe('FixedLoop (virtual clock)', () => {
  it('holds 3600 +/- 1 ticks per minute at 60 Hz with a 2 ms body', () => {
    const timers = new VirtualTimers();
    const { loop, ticks, wakeTicks } = virtualLoop(timers, { bodyMs: 2 });
    loop.start();
    timers.advanceTo(60_000);
    const s = loop.stats();
    expect(s.ticks).toBeGreaterThanOrEqual(3599);
    expect(s.ticks).toBeLessThanOrEqual(3601);
    expect(s.overruns).toBe(0);
    expect(s.droppedTicks).toBe(0);
    expect(s.maxTicksPerWake).toBe(1);
    expect(s.wakes).toBe(wakeTicks.length);
    expect(ticks).toEqual(Array.from({ length: s.ticks }, (_, i) => i + 1));
    expect(loop.tick).toBe(s.ticks);
    expect(loop.running).toBe(true);
    loop.stop();
  });

  it('caps a 20 ms body at 60 Hz to 5 ticks per wake and drops the rest', () => {
    const timers = new VirtualTimers();
    const { loop, overruns, wakeTicks } = virtualLoop(timers, { bodyMs: 20 });
    loop.start();
    timers.advanceTo(10_000);
    const s = loop.stats();
    expect(Math.max(...wakeTicks)).toBeLessThanOrEqual(MAX_CATCH_UP_TICKS);
    expect(wakeTicks).toContain(MAX_CATCH_UP_TICKS);
    expect(s.maxTicksPerWake).toBe(MAX_CATCH_UP_TICKS);
    expect(s.droppedTicks).toBeGreaterThan(0);
    expect(s.overruns).toBe(overruns.length);
    expect(overruns.reduce((a, b) => a + b, 0)).toBe(s.droppedTicks);
    // Every due deadline is either run or dropped; a resync may skip less than one tick each.
    const due = Math.floor(10_000 / (1000 / 60));
    expect(s.ticks + s.droppedTicks).toBeLessThanOrEqual(due + 1);
    expect(s.ticks + s.droppedTicks).toBeGreaterThanOrEqual(due - s.overruns - 1);
    loop.stop();
  });

  it('honours maxCatchUpTicks', () => {
    const timers = new VirtualTimers();
    const { loop, wakeTicks } = virtualLoop(timers, { bodyMs: 40, maxCatchUpTicks: 2 });
    loop.start();
    timers.advanceTo(5_000);
    expect(Math.max(...wakeTicks)).toBe(2);
    expect(loop.stats().droppedTicks).toBeGreaterThan(0);
  });

  it('skips the numbers of the ticks it drops: tick k keeps to its deadline, start + k ticks', () => {
    const timers = new VirtualTimers();
    const tickMs = 1000 / 60;
    const ran: [tick: number, at: number][] = [];
    const overruns: number[] = [];
    const loop = new FixedLoop({
      tickRate: 60,
      onTick: (tick) => ran.push([tick, timers.now]),
      onOverrun: (n) => {
        // Told before the wake's ticks run.
        expect(ran.at(-1)?.[0]).toBe(60);
        overruns.push(n);
      },
      now: () => timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    loop.start();
    timers.advanceTo(1005);
    expect(ran.at(-1)?.[0]).toBe(60);
    // The process stalls for 300 ms: no timer fires, then the late one does.
    timers.now = 1305;
    timers.advanceTo(1305);
    // Due by then, ticks 61 to 78: the latest five run, the thirteen before them are dropped.
    expect(overruns).toEqual([13]);
    expect(ran.slice(60).map(([tick]) => tick)).toEqual([74, 75, 76, 77, 78]);
    expect(loop.tick).toBe(78);
    timers.advanceTo(2005);
    // On the grid throughout: no tick starts before its deadline, and none after the stall late.
    for (const [tick, at] of ran) {
      expect(at).toBeGreaterThanOrEqual(tick * tickMs - 1e-6);
      if (tick > 78) expect(at).toBeLessThan((tick + 1) * tickMs);
    }
    expect(ran.at(-1)?.[0]).toBe(120);
    const s = loop.stats();
    expect(s.ticks).toBe(107);
    expect(s.ticks + s.droppedTicks).toBe(120);
    loop.stop();
  });

  it('stop cancels the pending timer', () => {
    const timers = new VirtualTimers();
    const { loop, ticks } = virtualLoop(timers);
    loop.start();
    loop.start(); // no-op while running
    expect(timers.pending()).toBe(1);
    timers.advanceTo(51);
    expect(ticks).toEqual([1, 2, 3]);
    loop.stop();
    expect(loop.running).toBe(false);
    expect(timers.pending()).toBe(0);
    timers.advanceTo(1_000);
    expect(ticks).toEqual([1, 2, 3]);
    loop.stop(); // idempotent

    loop.start(); // restarts from tick 0 on a fresh deadline grid
    timers.advanceTo(1_020);
    expect(ticks).toEqual([1, 2, 3, 1]);
    loop.stop();
    expect(timers.pending()).toBe(0);
  });

  it('stop inside onTick runs no further tick of that wake and does not re-arm', () => {
    const timers = new VirtualTimers();
    const ticks: number[] = [];
    const loop: FixedLoop = new FixedLoop({
      tickRate: 60,
      onTick: (t) => {
        ticks.push(t);
        if (t === 2) loop.stop();
      },
      onOverrun: () => {},
      now: () => timers.now,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    loop.start();
    timers.now = 60; // three deadlines are due at the first wake
    timers.advanceTo(60);
    expect(loop.stats().maxTicksPerWake).toBe(3);
    expect(ticks).toEqual([1, 2]);
    expect(timers.pending()).toBe(0);
    timers.advanceTo(1_000);
    expect(ticks).toEqual([1, 2]);
  });

  it('keeps an absolute deadline: late timers do not accumulate drift', () => {
    const timers = new VirtualTimers();
    let n = 0;
    timers.delayFor = (ms) => ms + ((n++ * 7) % 4); // 0..3 ms late
    const { loop } = virtualLoop(timers, { bodyMs: 2 });
    loop.start();
    timers.advanceTo(60_000);
    const s = loop.stats();
    expect(s.ticks).toBeGreaterThanOrEqual(3599);
    expect(s.ticks).toBeLessThanOrEqual(3601);
    expect(s.overruns).toBe(0);
  });

  it('an early wake runs no tick, records negative lateness and re-arms', () => {
    const timers = new VirtualTimers();
    timers.delayFor = (ms) => (ms > 1 ? ms - 1 : ms); // Node can fire up to 1 ms early
    const { loop, wakeTicks } = virtualLoop(timers, { bodyMs: 2 });
    const late: number[] = [];
    loop.start();
    for (let t = 1; t <= 1_000; t++) {
      timers.advanceTo(t);
      late.push(loop.stats().lastLateMs);
    }
    const s = loop.stats();
    expect(s.ticks).toBeGreaterThanOrEqual(59);
    expect(s.ticks).toBeLessThanOrEqual(60);
    expect(wakeTicks.filter((n) => n === 0).length).toBeGreaterThan(0);
    expect(s.wakes).toBeGreaterThan(s.ticks);
    expect(Math.min(...late)).toBeLessThan(0);
    expect(s.maxTicksPerWake).toBe(1);
  });

  it('validates its options', () => {
    const base = { onTick: () => {}, onOverrun: () => {} };
    expect(() => new FixedLoop({ ...base, tickRate: 0 })).toThrow(RangeError);
    expect(() => new FixedLoop({ ...base, tickRate: Number.NaN })).toThrow(RangeError);
    expect(() => new FixedLoop({ ...base, tickRate: 60, maxCatchUpTicks: 0 })).toThrow(RangeError);
    expect(MAX_CATCH_UP_TICKS).toBe(5);
    const loop = new FixedLoop({ ...base, tickRate: 60 });
    expect(loop.running).toBe(false);
    expect(loop.tick).toBe(0);
    expect(loop.stats()).toEqual({
      wakes: 0,
      ticks: 0,
      overruns: 0,
      droppedTicks: 0,
      maxTicksPerWake: 0,
      lastLateMs: 0,
    });
  });
});

describe('FixedLoop (real timers)', () => {
  it('runs about 2 s at 60 Hz on the default clock and timers', async () => {
    let ticks = 0;
    const loop = new FixedLoop({ tickRate: 60, onTick: () => ticks++, onOverrun: () => {} });
    const t0 = performance.now();
    loop.start();
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    loop.stop();
    const elapsed = performance.now() - t0;
    const s = loop.stats();
    expect(s.ticks).toBe(ticks);
    expect(loop.tick).toBe(ticks);
    // Loose: absolute deadlines never run ahead of the wall clock; a loaded machine may lag.
    expect(ticks).toBeLessThanOrEqual(Math.floor(elapsed / (1000 / 60)) + 1);
    expect(ticks).toBeGreaterThanOrEqual(60);
    expect(s.maxTicksPerWake).toBeLessThanOrEqual(MAX_CATCH_UP_TICKS);
    // The default timers never fire before the deadline, so every wake runs at least one tick.
    expect(s.wakes).toBeLessThanOrEqual(s.ticks);
  }, 10_000);
});

// Spike 2a (PLAN.md): 10 minutes of real timers with a 2 ms synthetic body. Opt in with
// CONDUIT_SLOW=1; CONDUIT_SLOW_SECONDS shortens the run for sampling. Pass: p99 lateness < 2 ms
// and no dropped ticks.
describe.runIf(process.env.CONDUIT_SLOW === '1')('FixedLoop Spike 2a (CONDUIT_SLOW=1)', () => {
  const SECONDS = Number(process.env.CONDUIT_SLOW_SECONDS ?? 600);
  const DURATION_MS = SECONDS * 1000;
  const BUCKETS = 64;
  const BUCKET_MS = 0.25;

  it(
    `buckets per-wake lateness over ${SECONDS} s at 60 Hz with a 2 ms body`,
    async () => {
      expect(DURATION_MS, 'CONDUIT_SLOW_SECONDS must be a positive number').toBeGreaterThan(0);
      const histogram = new Array<number>(BUCKETS).fill(0);
      const lateness: number[] = [];
      let lastWakes = 0;
      let spins = 0;
      const loop: FixedLoop = new FixedLoop({
        tickRate: 60,
        // Samples stats() at the first tick of each wake, so the default timers are measured as
        // the Session uses them. The histogram and percentiles cover wakes that ran ticks; wakes
        // that ran none (early wakes, which re-arm) are the difference from stats().wakes.
        onTick: () => {
          const s = loop.stats();
          if (s.wakes !== lastWakes) {
            lastWakes = s.wakes;
            lateness.push(s.lastLateMs);
            const b = Math.min(BUCKETS - 1, Math.max(0, Math.floor(s.lastLateMs / BUCKET_MS)));
            histogram[b] = (histogram[b] ?? 0) + 1;
          }
          const end = performance.now() + 2;
          while (performance.now() < end) spins++;
        },
        onOverrun: (n) => console.warn(`FixedLoop dropped ${n} ticks`),
      });

      const cpu0 = process.cpuUsage();
      const t0 = performance.now();
      loop.start();
      await new Promise((resolve) => setTimeout(resolve, DURATION_MS));
      loop.stop();
      const cpu = process.cpuUsage(cpu0);
      const cpuPct = (cpu.user + cpu.system) / 10 / (performance.now() - t0);

      const s = loop.stats();
      const sorted = Float64Array.from(lateness).sort();
      const pick = (p: number): number => sorted[Math.floor(p * (sorted.length - 1))] ?? Number.NaN;
      const p50 = pick(0.5);
      const p99 = pick(0.99);
      const max = sorted[sorted.length - 1] ?? Number.NaN;
      const lines = histogram.flatMap((count, i) =>
        count === 0
          ? []
          : [
              `  [${(i * BUCKET_MS).toFixed(2)}, ${i === BUCKETS - 1 ? 'inf' : ((i + 1) * BUCKET_MS).toFixed(2)}) ms: ${count}`,
            ],
      );
      console.log(
        [
          `Spike 2a: FixedLoop 60 Hz, 2 ms body, ${SECONDS} s`,
          `  ticks=${s.ticks} (grid ${Math.floor(DURATION_MS / (1000 / 60))}) wakes=${s.wakes} tickWakes=${lateness.length} earlyWakes=${s.wakes - lateness.length} bodySpins=${spins}`,
          `  lateness ms: p50=${p50.toFixed(3)} p99=${p99.toFixed(3)} max=${max.toFixed(3)}`,
          `  overruns=${s.overruns} droppedTicks=${s.droppedTicks} maxTicksPerWake=${s.maxTicksPerWake}`,
          `  cpu=${cpuPct.toFixed(2)}% of one core, including the 2 ms body (about 12%)`,
          `  histogram (${BUCKETS} buckets of ${BUCKET_MS} ms, tick-running wakes):`,
          ...lines,
        ].join('\n'),
      );

      expect(p99).toBeLessThan(2);
      expect(s.droppedTicks).toBe(0);
    },
    (Number.isFinite(DURATION_MS) ? Math.max(0, DURATION_MS) : 0) + 60_000,
  );
});
