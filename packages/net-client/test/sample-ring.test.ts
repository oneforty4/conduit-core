import { describe, expect, it } from 'vitest';
import { SAMPLE_RING, SampleRing } from '../src/index.ts';

function ticks(ring: SampleRing): number[] {
  const out: number[] = [];
  for (let i = 0; i < ring.length; i++) out.push(ring.at(i).tick);
  return out;
}

describe('SampleRing', () => {
  it(`has capacity ${SAMPLE_RING} by default and evicts the oldest sample`, () => {
    const ring = new SampleRing();
    expect(ring.capacity).toBe(8);
    for (let t = 1; t <= 10; t++) ring.push(t * 3, { v: t });
    expect(ring.length).toBe(8);
    expect(ticks(ring)).toEqual([9, 12, 15, 18, 21, 24, 27, 30]);
    expect(ring.oldest()).toEqual({ tick: 9, value: { v: 3 } });
    expect(ring.newest()).toEqual({ tick: 30, value: { v: 10 } });
  });

  it('is complete until a full ring lets its oldest sample go, and again after clear', () => {
    const ring = new SampleRing(2);
    expect(ring.complete).toBe(true);
    ring.push(1, 'a');
    ring.push(2, 'b');
    expect(ring.complete).toBe(true);
    ring.push(3, 'c');
    expect(ring.complete).toBe(false);
    ring.clear();
    expect(ring.complete).toBe(true);
  });

  it('ignores ticks older than the newest; an equal tick replaces the newest value', () => {
    const ring = new SampleRing(4);
    ring.push(10, 'a');
    ring.push(20, 'b');
    ring.push(15, 'late');
    ring.push(5, 'older');
    expect(ticks(ring)).toEqual([10, 20]);
    ring.push(20, 'b2');
    expect(ring.length).toBe(2);
    expect(ring.newest()).toEqual({ tick: 20, value: 'b2' });
  });

  it('bracket: exact ticks, between samples, before the oldest and after the newest', () => {
    const ring = new SampleRing();
    expect(ring.bracket(10)).toBeNull();
    for (const t of [10, 13, 16, 19]) ring.push(t, t);
    expect(ring.bracket(10)).toEqual({ a: 0, b: 0 });
    expect(ring.bracket(16)).toEqual({ a: 2, b: 2 });
    expect(ring.bracket(19)).toEqual({ a: 3, b: 3 });
    expect(ring.bracket(10.5)).toEqual({ a: 0, b: 1 });
    expect(ring.bracket(14)).toEqual({ a: 1, b: 2 });
    expect(ring.bracket(18.999)).toEqual({ a: 2, b: 3 });
    expect(ring.bracket(9.999)).toBeNull();
    expect(ring.bracket(19.001)).toBeNull();
  });

  it('bracket works across the wrap of the physical storage', () => {
    const ring = new SampleRing(3);
    for (const t of [1, 2, 3, 4, 5]) ring.push(t * 10, t);
    expect(ticks(ring)).toEqual([30, 40, 50]);
    expect(ring.bracket(45)).toEqual({ a: 1, b: 2 });
    expect(ring.at(ring.bracket(45)!.b).value).toBe(5);
    expect(ring.indexAtOrBefore(29)).toBe(-1);
    expect(ring.indexAtOrBefore(1000)).toBe(2);
  });

  it('a single sample brackets only its own tick', () => {
    const ring = new SampleRing();
    ring.push(7, 'only');
    expect(ring.bracket(7)).toEqual({ a: 0, b: 0 });
    expect(ring.bracket(6)).toBeNull();
    expect(ring.bracket(8)).toBeNull();
  });

  it('at() rejects indices outside the ring; clear() empties it', () => {
    const ring = new SampleRing(2);
    expect(() => ring.at(0)).toThrow(RangeError);
    ring.push(1, 'x');
    expect(() => ring.at(1)).toThrow(RangeError);
    expect(() => ring.at(-1)).toThrow(RangeError);
    ring.clear();
    expect(ring.length).toBe(0);
    expect(ring.newest()).toBeUndefined();
    ring.push(4, 'y');
    expect(ticks(ring)).toEqual([4]);
    expect(() => new SampleRing(0)).toThrow(RangeError);
  });
});
