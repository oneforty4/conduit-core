import { describe, expect, it } from 'vitest';
import { FrameLoop, MAX_FRAME_DT } from '../src/frame.ts';

describe('FrameLoop', () => {
  it('interval driver passes the nominal period as dt and stops cleanly', () => {
    const calls: [number, number][] = [];
    let fire: (() => void) | null = null;
    let now = 1000;
    const loop = new FrameLoop({
      mode: 'interval',
      intervalMs: 20,
      now: () => now,
      timers: {
        setInterval: (fn, ms) => {
          expect(ms).toBe(20);
          fire = fn;
          return 7;
        },
        clearInterval: (handle) => {
          expect(handle).toBe(7);
          fire = null;
        },
      },
      onFrame: (nowMs, dt) => calls.push([nowMs, dt]),
    });
    loop.start();
    expect(loop.running).toBe(true);
    now = 1023;
    (fire as unknown as () => void)();
    expect(calls).toEqual([[1023, 0.02]]);
    loop.stop();
    expect(loop.running).toBe(false);
    expect(fire).toBeNull();
  });

  it('rAF driver passes elapsed time, clamped, and cancels on stop', () => {
    const calls: number[] = [];
    const pending = new Map<number, (t: number) => void>();
    let nextId = 1;
    let now = 0;
    const loop = new FrameLoop({
      mode: 'raf',
      now: () => now,
      raf: (cb) => {
        pending.set(nextId, cb);
        return nextId++;
      },
      caf: (id) => pending.delete(id),
      onFrame: (_nowMs, dt) => calls.push(dt),
    });
    const step = (ms: number): void => {
      now += ms;
      const [id, cb] = [...pending][0] as [number, (t: number) => void];
      pending.delete(id);
      cb(now);
    };
    loop.start();
    step(16);
    step(16);
    step(10_000);
    expect(calls).toEqual([0, 0.016, MAX_FRAME_DT]);
    expect(pending.size).toBe(1);
    loop.stop();
    expect(pending.size).toBe(0);
  });

  it('rAF driver times the frame from the callback timestamp, not the clock read inside it', () => {
    // The timestamp is the frame's own time, the same for everything that runs in it; reading the
    // clock here instead measures when this callback got its turn, which varies with whatever ran
    // before it. That difference ends up in the render clock as stutter (docs/game.md §4).
    const times: number[] = [];
    const dts: number[] = [];
    const pending = new Map<number, (t: number) => void>();
    let nextId = 1;
    let now = 1000;
    const loop = new FrameLoop({
      mode: 'raf',
      now: () => now,
      raf: (cb) => {
        pending.set(nextId, cb);
        return nextId++;
      },
      caf: (id) => pending.delete(id),
      onFrame: (nowMs, dt) => {
        times.push(nowMs);
        dts.push(dt);
      },
    });
    /** A frame at `frameMs` whose callback ran `lag` ms into it. */
    const step = (frameMs: number, lag: number): void => {
      now = frameMs + lag;
      const [id, cb] = [...pending][0] as [number, (t: number) => void];
      pending.delete(id);
      cb(frameMs);
    };
    loop.start();
    step(1000, 2);
    step(1016, 9); // 16 ms of frames, but 23 ms of wall clock between the two callbacks
    step(1032, 1); // 16 ms of frames, but 8 ms of wall clock
    expect(times).toEqual([1000, 1016, 1032]);
    expect(dts).toEqual([0, 0.016, 0.016]);
    loop.stop();
  });

  it('manual tick computes dt from the previous tick; a throwing frame stops the loop', () => {
    const dts: number[] = [];
    const loop = new FrameLoop({
      mode: 'interval',
      timers: { setInterval: () => 1, clearInterval: () => {} },
      onFrame: (_nowMs, dt) => {
        if (dts.push(dt) === 3) throw new Error('boom');
      },
    });
    loop.start();
    loop.tick(500);
    loop.tick(550);
    expect(() => loop.tick(560)).toThrow('boom');
    expect(dts).toEqual([0, 0.05, 0.01]);
    expect(loop.running).toBe(false);
  });
});
