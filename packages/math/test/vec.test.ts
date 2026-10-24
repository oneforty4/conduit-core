import { describe, expect, it } from 'vitest';
import { EPS, v2, v3, type Vec2, type Vec3 } from '../src/index.ts';

describe('v2', () => {
  const a: Vec2 = { x: 1, y: 2 };
  const b: Vec2 = { x: -3, y: 5 };

  it('create, copy and set', () => {
    expect(v2.create()).toEqual({ x: 0, y: 0 });
    expect(v2.create(1, -2)).toEqual({ x: 1, y: -2 });
    const c = v2.copy(a);
    expect(c).toEqual(a);
    expect(c).not.toBe(a);
    const out = { x: 9, y: 9 };
    expect(v2.set(out, 4, 5)).toBe(out);
    expect(out).toEqual({ x: 4, y: 5 });
  });

  it('arithmetic', () => {
    expect(v2.add(a, b)).toEqual({ x: -2, y: 7 });
    expect(v2.sub(a, b)).toEqual({ x: 4, y: -3 });
    expect(v2.scale(a, -2)).toEqual({ x: -2, y: -4 });
    expect(v2.dot(a, b)).toBe(7);
    expect(v2.cross(a, b)).toBe(1 * 5 - 2 * -3);
    expect(v2.cross({ x: 1, y: 0 }, { x: 0, y: 1 })).toBe(1);
    expect(v2.length({ x: 3, y: 4 })).toBe(5);
    expect(v2.lengthSq({ x: 3, y: 4 })).toBe(25);
    expect(v2.distance(a, b)).toBe(5);
    expect(v2.distanceSq(a, b)).toBe(25);
    expect(v2.lerp(a, b, 0)).toEqual(a);
    expect(v2.lerp(a, b, 1)).toEqual(b);
    expect(v2.lerp(a, b, 0.5)).toEqual({ x: -1, y: 3.5 });
    expect(v2.lerp(a, b, 2)).toEqual({ x: -7, y: 8 }); // t is not clamped
  });

  it('normalize', () => {
    const n = v2.normalize({ x: 3, y: -4 });
    expect(n.x).toBeCloseTo(0.6, 12);
    expect(n.y).toBeCloseTo(-0.8, 12);
    expect(v2.length(n)).toBeCloseTo(1, 12);
    expect(v2.normalize({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(v2.normalize({ x: EPS / 4, y: 0 })).toEqual({ x: 0, y: 0 });
  });

  it('equals uses a per-component tolerance', () => {
    expect(v2.equals(a, { x: 1 + EPS / 2, y: 2 - EPS / 2 })).toBe(true);
    expect(v2.equals(a, { x: 1 + 1e-3, y: 2 })).toBe(false);
    expect(v2.equals(a, { x: 1.05, y: 2 }, 0.1)).toBe(true);
  });

  it('writes into out when given and allocates when omitted', () => {
    const out = { x: 0, y: 0 };
    expect(v2.add(a, b, out)).toBe(out);
    expect(out).toEqual({ x: -2, y: 7 });
    const r1 = v2.add(a, b);
    const r2 = v2.add(a, b);
    expect(r1).not.toBe(r2);
    expect(r1).not.toBe(a);
    expect(v2.normalize({ x: 0, y: 0 }, out)).toBe(out);
    expect(out).toEqual({ x: 0, y: 0 });
  });

  it('is correct when out aliases an input', () => {
    const p = { x: 1, y: 2 };
    v2.add(p, p, p);
    expect(p).toEqual({ x: 2, y: 4 });
    const s = { x: 1, y: 2 };
    v2.sub(b, s, s);
    expect(s).toEqual({ x: -4, y: 3 });
    const l = { x: 1, y: 2 };
    v2.lerp(l, b, 0.5, l);
    expect(l).toEqual({ x: -1, y: 3.5 });
    const n = { x: 3, y: 4 };
    v2.normalize(n, n);
    expect(n.x).toBeCloseTo(0.6, 12);
    expect(n.y).toBeCloseTo(0.8, 12);
    const c = { x: 1, y: 2 };
    v2.scale(c, 3, c);
    expect(c).toEqual({ x: 3, y: 6 });
  });
});

describe('v3', () => {
  const a: Vec3 = { x: 1, y: 2, z: 3 };
  const b: Vec3 = { x: -2, y: 0, z: 5 };

  it('create, copy and set', () => {
    expect(v3.create()).toEqual({ x: 0, y: 0, z: 0 });
    expect(v3.create(1, 2, 3)).toEqual(a);
    const c = v3.copy(a);
    expect(c).toEqual(a);
    expect(c).not.toBe(a);
    const out = v3.create();
    expect(v3.set(out, 7, 8, 9)).toBe(out);
    expect(out).toEqual({ x: 7, y: 8, z: 9 });
  });

  it('arithmetic', () => {
    expect(v3.add(a, b)).toEqual({ x: -1, y: 2, z: 8 });
    expect(v3.sub(a, b)).toEqual({ x: 3, y: 2, z: -2 });
    expect(v3.scale(a, 0.5)).toEqual({ x: 0.5, y: 1, z: 1.5 });
    expect(v3.dot(a, b)).toBe(13);
    expect(v3.length({ x: 2, y: 3, z: 6 })).toBe(7);
    expect(v3.lengthSq({ x: 2, y: 3, z: 6 })).toBe(49);
    expect(v3.distance({ x: 1, y: 1, z: 1 }, { x: 3, y: 4, z: 7 })).toBe(7);
    expect(v3.distanceSq({ x: 1, y: 1, z: 1 }, { x: 3, y: 4, z: 7 })).toBe(49);
    expect(v3.lerp(a, b, 0)).toEqual(a);
    expect(v3.lerp(a, b, 1)).toEqual(b);
    expect(v3.lerp(a, b, 0.5)).toEqual({ x: -0.5, y: 1, z: 4 });
    expect(v3.lerp(a, b, -1)).toEqual({ x: 4, y: 4, z: 1 });
  });

  it('cross follows the right-hand rule', () => {
    expect(v3.cross({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })).toEqual({ x: 0, y: 0, z: 1 });
    expect(v3.cross({ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 })).toEqual({ x: 1, y: 0, z: 0 });
    expect(v3.cross({ x: 0, y: 0, z: 1 }, { x: 1, y: 0, z: 0 })).toEqual({ x: 0, y: 1, z: 0 });
    // (2*5 - 3*0, 3*-2 - 1*5, 1*0 - 2*-2)
    expect(v3.cross(a, b)).toEqual({ x: 10, y: -11, z: 4 });
  });

  it('normalize', () => {
    const n = v3.normalize({ x: 2, y: -3, z: 6 });
    expect(n.x).toBeCloseTo(2 / 7, 12);
    expect(n.y).toBeCloseTo(-3 / 7, 12);
    expect(n.z).toBeCloseTo(6 / 7, 12);
    expect(v3.normalize({ x: 0, y: 0, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
    expect(v3.normalize({ x: 0, y: EPS / 10, z: 0 })).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('equals uses a per-component tolerance', () => {
    expect(v3.equals(a, { x: 1, y: 2, z: 3 + EPS / 2 })).toBe(true);
    expect(v3.equals(a, { x: 1, y: 2, z: 3.001 })).toBe(false);
  });

  it('writes into out when given and allocates when omitted', () => {
    const out = v3.create();
    expect(v3.cross(a, b, out)).toBe(out);
    expect(out).toEqual({ x: 10, y: -11, z: 4 });
    expect(v3.sub(a, b)).not.toBe(v3.sub(a, b));
    expect(v3.copy(a, out)).toBe(out);
    expect(out).toEqual(a);
  });

  it('is correct when out aliases an input', () => {
    const c1 = { x: 1, y: 2, z: 3 };
    v3.cross(c1, b, c1);
    expect(c1).toEqual({ x: 10, y: -11, z: 4 });
    const c2 = { x: -2, y: 0, z: 5 };
    v3.cross(a, c2, c2);
    expect(c2).toEqual({ x: 10, y: -11, z: 4 });
    const s = { x: 1, y: 2, z: 3 };
    v3.add(s, s, s);
    expect(s).toEqual({ x: 2, y: 4, z: 6 });
    const l = { x: -2, y: 0, z: 5 };
    v3.lerp(a, l, 0.5, l);
    expect(l).toEqual({ x: -0.5, y: 1, z: 4 });
    const n = { x: 0, y: 0, z: 9 };
    v3.normalize(n, n);
    expect(n).toEqual({ x: 0, y: 0, z: 1 });
  });
});
