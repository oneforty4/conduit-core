import { describe, expect, it } from 'vitest';
import { fnv1a32, Rng } from '../src/index.ts';

function draws(rng: Rng, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(rng.next());
  return out;
}

describe('Rng', () => {
  it('matches the seed-1 known-answer vector', () => {
    const rng = new Rng(1);
    expect(draws(rng, 5)).toEqual([2693262067, 11749833, 2265367787, 4213581821, 4159151403]);
  });

  it('gives identical 10 000-draw sequences for the same seed', () => {
    const a = draws(new Rng(123456789), 10_000);
    const b = draws(new Rng(123456789), 10_000);
    expect(a).toEqual(b);
    expect(draws(new Rng(123456790), 10_000)).not.toEqual(a);
    expect(a.every((v) => Number.isInteger(v) && v >= 0 && v < 2 ** 32)).toBe(true);
  });

  it('coerces the seed with >>> 0', () => {
    expect(draws(new Rng(-1), 3)).toEqual(draws(new Rng(0xffffffff), 3));
    expect(draws(new Rng(2 ** 32 + 1), 3)).toEqual(draws(new Rng(1), 3));
    expect(new Rng(-1).state()).toBe(0xffffffff);
  });

  it('float is next() / 2^32, in [0, 1)', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    let mismatches = 0;
    for (let i = 0; i < 1000; i++) {
      const f = a.float();
      if (f !== b.next() / 4294967296 || !(f >= 0 && f < 1)) mismatches++;
    }
    expect(mismatches).toBe(0);
  });

  it('int(lo, hi) stays inclusive over 100 000 draws', () => {
    const rng = new Rng(9);
    const counts = new Map<number, number>();
    let outOfRange = 0;
    for (let i = 0; i < 100_000; i++) {
      const v = rng.int(-3, 3);
      if (!Number.isInteger(v) || v < -3 || v > 3) outOfRange++;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    expect(outOfRange).toBe(0);
    // both ends are reachable, and every value gets roughly 1/7 of the draws
    for (let v = -3; v <= 3; v++) expect(counts.get(v) ?? 0).toBeGreaterThan(13_000);
    expect(rng.int(5, 5)).toBe(5);
    let top = 0;
    for (let i = 0; i < 100_000; i++) if (rng.int(0, 1) === 1) top++;
    expect(top).toBeGreaterThan(45_000);
    expect(top).toBeLessThan(55_000);
  });

  it('int follows lo + floor(float() * (hi - lo + 1)) and rejects lo > hi', () => {
    const a = new Rng(77);
    const b = new Rng(77);
    for (let i = 0; i < 100; i++) {
      expect(a.int(10, 20)).toBe(10 + Math.floor(b.float() * 11));
    }
    expect(() => a.int(2, 1)).toThrow(RangeError);
    expect(() => a.int(Number.NaN, 1)).toThrow(RangeError);
  });

  it('chance and pick', () => {
    const rng = new Rng(5);
    expect(rng.chance(0)).toBe(false);
    expect(rng.chance(1)).toBe(true);
    const before = rng.state();
    expect(rng.pick([])).toBeUndefined();
    expect(rng.state()).toBe(before); // empty pick does not draw
    const items = ['a', 'b', 'c'] as const;
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const p = rng.pick(items);
      expect(p).toBeDefined();
      seen.add(p as string);
    }
    expect([...seen].sort((x, y) => (x < y ? -1 : 1))).toEqual(['a', 'b', 'c']);
  });

  it("fork('a') twice differs and advances the parent by one draw", () => {
    const parent = new Rng(1000);
    const mirror = new Rng(1000);
    const f1 = parent.fork('a');
    const f2 = parent.fork('a');
    expect(draws(f1, 20)).not.toEqual(draws(f2, 20));
    const salt1 = mirror.next();
    const salt2 = mirror.next();
    expect(parent.state()).toBe(mirror.state());
    expect(draws(parent.fork('a'), 1)).toEqual(draws(new Rng(fnv1a32('a', mirror.next())), 1));
    expect(draws(new Rng(fnv1a32('a', salt1)), 5)).toEqual(draws(new Rng(1000).fork('a'), 5));
    expect(salt2).not.toBe(salt1);
  });

  it('fork is reproducible after restore', () => {
    const rng = new Rng(31337);
    draws(rng, 17);
    const s = rng.state();
    const first = draws(rng.fork('region:3'), 50);
    const firstOther = draws(rng.fork('b'), 50);
    rng.restore(s);
    expect(draws(rng.fork('region:3'), 50)).toEqual(first);
    expect(draws(rng.fork('b'), 50)).toEqual(firstOther);
  });

  it('state/restore round-trips mid-stream', () => {
    const rng = new Rng(8);
    draws(rng, 1234);
    const s = rng.state();
    expect(Number.isInteger(s) && s >= 0 && s < 2 ** 32).toBe(true);
    const tail = draws(rng, 100);
    rng.restore(s);
    expect(draws(rng, 100)).toEqual(tail);
    const other = new Rng(0);
    other.restore(s);
    expect(draws(other, 100)).toEqual(tail);
  });
});
