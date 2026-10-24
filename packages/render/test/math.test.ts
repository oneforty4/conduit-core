import { q, type Quat, type Vec3 } from '@conduit/math';
import { Quaternion, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { fromThreeQuat, fromThreeVec3, toThreeQuat, toThreeVec3 } from '../src/index.ts';

describe('math conversions', () => {
  it('toThreeVec3 / fromThreeVec3 round-trip and write into out', () => {
    const v: Vec3 = { x: 1.5, y: -2.25, z: 2_000_000.125 };
    const out = new Vector3(9, 9, 9);
    expect(toThreeVec3(v, out)).toBe(out);
    expect(out.toArray()).toEqual([1.5, -2.25, 2_000_000.125]);

    const back: Vec3 = { x: 0, y: 0, z: 0 };
    expect(fromThreeVec3(out, back)).toBe(back);
    expect(back).toEqual(v);
  });

  it('toThreeQuat / fromThreeQuat round-trip (w last) and write into out', () => {
    const src = q.fromEuler(0.3, -0.7, 1.1);
    const out = new Quaternion(1, 2, 3, 4);
    expect(toThreeQuat(src, out)).toBe(out);
    expect(out.toArray()).toEqual([src.x, src.y, src.z, src.w]);

    const back: Quat = { x: 0, y: 0, z: 0, w: 0 };
    expect(fromThreeQuat(out, back)).toBe(back);
    expect(back).toEqual(src);
  });

  it('allocates a fresh object when out is omitted', () => {
    const a = toThreeVec3({ x: 1, y: 2, z: 3 });
    const b = toThreeVec3({ x: 1, y: 2, z: 3 });
    expect(a).toBeInstanceOf(Vector3);
    expect(a).not.toBe(b);
    expect(toThreeQuat({ x: 0, y: 0, z: 0, w: 1 })).toBeInstanceOf(Quaternion);
    expect(fromThreeVec3(new Vector3(4, 5, 6))).toEqual({ x: 4, y: 5, z: 6 });
    expect(fromThreeQuat(new Quaternion())).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });

  it('a converted quaternion rotates vectors exactly as @conduit/math does', () => {
    const r = q.fromEuler(1.2, 0.4, -0.25);
    const v: Vec3 = { x: 3, y: -1, z: 7 };
    const ours = q.rotateVec3(r, v);
    const theirs = toThreeVec3(v).applyQuaternion(toThreeQuat(r));
    expect(theirs.x).toBeCloseTo(ours.x, 12);
    expect(theirs.y).toBeCloseTo(ours.y, 12);
    expect(theirs.z).toBeCloseTo(ours.z, 12);
  });
});
