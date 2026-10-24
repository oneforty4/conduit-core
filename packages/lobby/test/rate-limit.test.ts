import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/index.ts';

function clock(start = 1_000_000) {
  const state = { now: start };
  return { state, now: () => state.now };
}

describe('RateLimiter', () => {
  it('allows 10 per key and then denies within the window', () => {
    const { now } = clock();
    const limiter = new RateLimiter({ now });
    const results = Array.from({ length: 12 }, () => limiter.take('1.2.3.4'));
    expect(results).toEqual([...Array<boolean>(10).fill(true), false, false]);
  });

  it('refills continuously at limit per window, capped at the limit', () => {
    const { state, now } = clock();
    const limiter = new RateLimiter({ now });
    for (let i = 0; i < 10; i++) limiter.take('ip');
    expect(limiter.take('ip')).toBe(false);
    state.now += 5_999;
    expect(limiter.take('ip')).toBe(false);
    state.now += 1; // 6 s = one token at 10 per 60 s
    expect(limiter.take('ip')).toBe(true);
    expect(limiter.take('ip')).toBe(false);
    state.now += 10 * 60_000; // far more than a window: the bucket holds only 10
    const burst = Array.from({ length: 11 }, () => limiter.take('ip'));
    expect(burst.filter(Boolean)).toHaveLength(10);
    expect(burst[10]).toBe(false);
  });

  it('keeps keys isolated', () => {
    const { now } = clock();
    const limiter = new RateLimiter({ now });
    for (let i = 0; i < 10; i++) expect(limiter.take('a')).toBe(true);
    expect(limiter.take('a')).toBe(false);
    expect(limiter.take('b')).toBe(true);
    expect(limiter.take('unknown')).toBe(true);
    expect(limiter.take('a')).toBe(false);
  });

  it('honours custom limits and windows, and reset forgets every key', () => {
    const { state, now } = clock();
    const limiter = new RateLimiter({ limit: 2, windowMs: 1000, now });
    expect([limiter.take('k'), limiter.take('k'), limiter.take('k')]).toEqual([true, true, false]);
    state.now += 500;
    expect([limiter.take('k'), limiter.take('k')]).toEqual([true, false]);
    limiter.reset();
    expect([limiter.take('k'), limiter.take('k'), limiter.take('k')]).toEqual([true, true, false]);
  });

  it('does not refill when the clock goes backwards', () => {
    const { state, now } = clock();
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000, now });
    expect(limiter.take('k')).toBe(true);
    state.now -= 5000;
    expect(limiter.take('k')).toBe(false);
    state.now += 5000;
    expect(limiter.take('k')).toBe(false);
    state.now += 1000;
    expect(limiter.take('k')).toBe(true);
  });

  it('keeps working across the periodic sweep of idle keys', () => {
    const { state, now } = clock();
    const limiter = new RateLimiter({ limit: 1, windowMs: 100, now });
    expect(limiter.take('busy')).toBe(true);
    for (let i = 0; i < 999; i++) limiter.take(`idle-${i}`);
    state.now += 50;
    expect(limiter.take('busy')).toBe(false); // call 1001; nothing idle long enough yet
    state.now += 2000;
    for (let i = 0; i < 999; i++) limiter.take(`other-${i}`); // call 2000 sweeps the idle keys
    expect(limiter.take('busy')).toBe(true);
    expect(limiter.take('busy')).toBe(false);
  });

  it('uses the wall clock by default and rejects invalid options', () => {
    const limiter = new RateLimiter();
    for (let i = 0; i < 10; i++) expect(limiter.take('x')).toBe(true);
    expect(limiter.take('x')).toBe(false);
    expect(() => new RateLimiter({ limit: 0 })).toThrow(RangeError);
    expect(() => new RateLimiter({ limit: 1.5 })).toThrow(RangeError);
    expect(() => new RateLimiter({ windowMs: 0 })).toThrow(RangeError);
    expect(() => new RateLimiter({ windowMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });
});
