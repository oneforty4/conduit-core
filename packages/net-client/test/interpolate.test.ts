import { type Quat, q } from '@conduit/math';
import { f } from '@conduit/protocol';
import { defineComponent, Transform } from '@conduit/sim';
import { describe, expect, it } from 'vitest';
import { extrapolateComponent, SampleRing, sampleComponent } from '../src/index.ts';

const timing = { tickRate: 60, snapshotEvery: 3 };

const Mixed = defineComponent(
  'Mixed',
  {
    fx: f.fixed32(0.001),
    fl: f.f32,
    v2: f.vec2(f.f32),
    v3: f.vec3(f.fixed32(0.001)),
    n: f.u16,
    flag: f.bool,
    label: f.str(8),
    who: f.entity(),
  },
  { interpolate: ['fx', 'fl', 'v2', 'v3'] },
);
type MixedValue = ReturnType<typeof Mixed.create>;

const Rot = defineComponent('Rot', { q: f.quat() }, { interpolate: ['q'] });
const Heading = defineComponent('Heading', { a: f.angle16() }, { interpolate: ['a'] });
const Plain = defineComponent('Plain', { pos: f.vec3(f.f32) }, { interpolate: ['pos'] });

function ringOf(...samples: [number, unknown][]): SampleRing {
  const ring = new SampleRing();
  for (const [tick, value] of samples) ring.push(tick, value);
  return ring;
}

function mixed(over: Partial<MixedValue>): MixedValue {
  return { ...Mixed.create(), ...over };
}

describe('sampleComponent', () => {
  const A = mixed({
    fx: 1,
    fl: -2,
    v2: { x: 0, y: 10 },
    v3: { x: 1, y: 2, z: 3 },
    n: 5,
    flag: true,
    label: 'a',
    who: 11,
  });
  const B = mixed({
    fx: 3,
    fl: 2,
    v2: { x: 4, y: -10 },
    v3: { x: 3, y: 6, z: -3 },
    n: 9,
    flag: false,
    label: 'b',
    who: 22,
  });

  it('gives exact midpoints for fixed, f32, vec2 and vec3', () => {
    const out = sampleComponent(Mixed, ringOf([10, A], [20, B]), B, 15, Mixed.create(), timing);
    expect(out.fx).toBe(2);
    expect(out.fl).toBe(0);
    expect(out.v2).toEqual({ x: 2, y: 0 });
    expect(out.v3).toEqual({ x: 2, y: 4, z: 0 });
  });

  it('takes non-interpolated and non-numeric fields from the earlier sample', () => {
    const out = sampleComponent(Mixed, ringOf([10, A], [20, B]), B, 19, Mixed.create(), timing);
    expect(out.n).toBe(5);
    expect(out.flag).toBe(true);
    expect(out.label).toBe('a');
    expect(out.who).toBe(11);
    expect(out.fx).toBeCloseTo(2.8, 12);
  });

  it('writes into out without aliasing the samples', () => {
    const out = Mixed.create();
    const result = sampleComponent(Mixed, ringOf([10, A], [20, B]), B, 12, out, timing);
    expect(result).toBe(out);
    expect(out.v3).not.toBe(A.v3);
    expect(A.v3).toEqual({ x: 1, y: 2, z: 3 });
    expect(B.v3).toEqual({ x: 3, y: 6, z: -3 });
  });

  it('slerps quaternions along the shortest path: q and -q give the same result', () => {
    const identity: Quat = { x: 0, y: 0, z: 0, w: 1 };
    const quarter = q.fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2);
    const negated: Quat = { x: -quarter.x, y: -quarter.y, z: -quarter.z, w: -quarter.w };
    const a = sampleComponent(
      Rot,
      ringOf([0, { q: identity }], [10, { q: quarter }]),
      { q: quarter },
      5,
      Rot.create(),
      timing,
    );
    const b = sampleComponent(
      Rot,
      ringOf([0, { q: identity }], [10, { q: negated }]),
      { q: negated },
      5,
      Rot.create(),
      timing,
    );
    const eighth = q.fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 4);
    for (const key of ['x', 'y', 'z', 'w'] as const) {
      expect(a.q[key]).toBeCloseTo(eighth[key], 12);
      expect(b.q[key]).toBeCloseTo(eighth[key], 12);
    }
  });

  it('interpolates angle16 the short way across the 0/2π seam', () => {
    const deg = Math.PI / 180;
    const ring = ringOf([0, { a: 350 * deg }], [10, { a: 10 * deg }]);
    const mid = sampleComponent(Heading, ring, { a: 10 * deg }, 5, Heading.create(), timing);
    const distanceToZero = Math.min(mid.a, 2 * Math.PI - mid.a);
    expect(distanceToZero).toBeLessThan(1e-9);
    const quarter = sampleComponent(Heading, ring, { a: 10 * deg }, 2.5, Heading.create(), timing);
    expect(quarter.a).toBeCloseTo(355 * deg, 9);
  });

  it('returns the oldest sample for a render tick at or before it', () => {
    const ring = ringOf([10, A], [20, B]);
    expect(sampleComponent(Mixed, ring, B, 3, Mixed.create(), timing).fx).toBe(1);
    expect(sampleComponent(Mixed, ring, B, 10, Mixed.create(), timing).label).toBe('a');
  });

  it('returns a single sample as is (no extrapolateWith)', () => {
    const ring = ringOf([10, A]);
    expect(sampleComponent(Mixed, ring, A, 10, Mixed.create(), timing)).toEqual(A);
    expect(sampleComponent(Mixed, ring, A, 25, Mixed.create(), timing)).toEqual(A);
  });

  it('copies latest when there are no samples', () => {
    expect(sampleComponent(Mixed, undefined, B, 99, Mixed.create(), timing)).toEqual(B);
    expect(sampleComponent(Mixed, new SampleRing(), B, 99, Mixed.create(), timing)).toEqual(B);
  });

  it('blends exactly on a middle sample tick', () => {
    const C = mixed({ fx: 10 });
    const ring = ringOf([10, A], [20, B], [30, C]);
    expect(sampleComponent(Mixed, ring, C, 20, Mixed.create(), timing).fx).toBe(3);
    expect(sampleComponent(Mixed, ring, C, 25, Mixed.create(), timing).fx).toBe(6.5);
  });
});

describe('extrapolateComponent', () => {
  const newest = {
    pos: { x: 1, y: 2, z: 3 },
    rot: { x: 0, y: 0, z: 0, w: 1 },
    vel: { x: 6, y: 0, z: -12 },
  };

  it('moves pos by vel × dt for up to snapshotEvery ticks, then holds', () => {
    const at = (renderTick: number) =>
      extrapolateComponent(Transform, 30, newest, renderTick, Transform.create(), timing);
    expect(at(30).pos).toEqual({ x: 1, y: 2, z: 3 });
    const one = at(31).pos;
    expect(one.x).toBeCloseTo(1.1, 12);
    expect(one.z).toBeCloseTo(2.8, 12);
    const three = at(33).pos;
    expect(three.x).toBeCloseTo(1.3, 12);
    expect(three.y).toBe(2);
    expect(three.z).toBeCloseTo(2.4, 12);
    expect(at(40).pos).toEqual(three);
    expect(at(40).rot).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(at(40).vel).toEqual(newest.vel);
    expect(newest.pos).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('is used by sampleComponent at and past the newest sample', () => {
    const older = { ...newest, pos: { x: 0, y: 2, z: 3 } };
    const ring = ringOf([27, older], [30, newest]);
    const out = sampleComponent(Transform, ring, newest, 31.5, Transform.create(), timing);
    expect(out.pos.x).toBeCloseTo(1 + 6 * (1.5 / 60), 12);
  });

  it('holds the newest value without extrapolateWith', () => {
    const value = { pos: { x: 5, y: 5, z: 5 } };
    const out = extrapolateComponent(Plain, 10, value, 12, Plain.create(), timing);
    expect(out).toEqual(value);
  });
});

it('uses an explicit millisecond horizon with hold/reset policy without advancing source state', () => {
  const source = Transform.create();
  source.pos.x = 10;
  source.vel.x = 20;
  const hold = extrapolateComponent(Transform, 30, source, 90, Transform.create(), {
    ...timing,
    extrapolation: { horizonMs: 100, onLimit: 'hold' },
  });
  const reset = extrapolateComponent(Transform, 30, source, 90, Transform.create(), {
    ...timing,
    extrapolation: { horizonMs: 100, onLimit: 'reset' },
  });
  expect(hold.pos.x).toBe(12);
  expect(reset.pos.x).toBe(10);
  expect(source.pos.x).toBe(10);
});
