import { describe, expect, it } from 'vitest';
import { decomposeMat4, q, Rng, v3, type Quat, type Vec3 } from '../src/index.ts';

/** Column-major T * R * S, as glTF `node.matrix` stores it. */
function compose(t: Vec3, r: Quat, s: Vec3): number[] {
  const cx = q.rotateVec3(r, { x: s.x, y: 0, z: 0 });
  const cy = q.rotateVec3(r, { x: 0, y: s.y, z: 0 });
  const cz = q.rotateVec3(r, { x: 0, y: 0, z: s.z });
  return [cx.x, cx.y, cx.z, 0, cy.x, cy.y, cy.z, 0, cz.x, cz.y, cz.z, 0, t.x, t.y, t.z, 1];
}

function decompose(m: ArrayLike<number>): { t: Vec3; r: Quat; s: Vec3 } {
  const t = v3.create(9, 9, 9);
  const r = q.create(9, 9, 9, 9);
  const s = v3.create(9, 9, 9);
  decomposeMat4(m, t, r, s);
  return { t, r, s };
}

describe('decomposeMat4', () => {
  it('decomposes the identity', () => {
    const { t, r, s } = decompose([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(t).toEqual({ x: 0, y: 0, z: 0 });
    expect(r).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(s).toEqual({ x: 1, y: 1, z: 1 });
  });

  it('reads translation from m[12..14] and scale from column lengths', () => {
    // 90 degrees about +Z: column 0 = (0, 1, 0), column 1 = (-1, 0, 0); scale (2, 3, 4)
    const m = Float32Array.of(0, 2, 0, 0, -3, 0, 0, 0, 0, 0, 4, 0, 10, -20, 30, 1);
    const { t, r, s } = decompose(m);
    expect(t).toEqual({ x: 10, y: -20, z: 30 });
    expect(s).toEqual({ x: 2, y: 3, z: 4 });
    expect(q.equals(r, q.fromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI / 2))).toBe(true);
  });

  it('round-trips random TRS matrices, including every quaternion branch', () => {
    const rng = new Rng(4242);
    const rotations: Quat[] = [
      q.fromAxisAngle({ x: 1, y: 0, z: 0 }, Math.PI), // trace -1, x largest
      q.fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI), // y largest
      q.fromAxisAngle({ x: 0, y: 0, z: 1 }, Math.PI), // z largest
      q.fromAxisAngle(v3.normalize({ x: 1, y: 1, z: 0 }), 3),
    ];
    for (let i = 0; i < 200; i++) {
      rotations.push(
        q.normalize(
          q.create(rng.float() - 0.5, rng.float() - 0.5, rng.float() - 0.5, rng.float() - 0.5),
        ),
      );
    }
    for (const rot of rotations) {
      const tIn = v3.create(rng.float() * 100 - 50, rng.float() * 100 - 50, rng.float() * 100 - 50);
      const sIn = v3.create(0.1 + rng.float() * 5, 0.1 + rng.float() * 5, 0.1 + rng.float() * 5);
      const { t, r, s } = decompose(compose(tIn, rot, sIn));
      expect(v3.equals(t, tIn, 1e-12)).toBe(true);
      expect(v3.equals(s, sIn, 1e-9)).toBe(true);
      expect(q.equals(r, rot, 1e-9)).toBe(true);
      expect(q.length(r)).toBeCloseTo(1, 12);
    }
  });

  it('negates the x scale when the determinant is negative', () => {
    const rot = q.fromEuler(0.4, -0.2, 1.1);
    const { r, s } = decompose(compose({ x: 1, y: 2, z: 3 }, rot, { x: -2, y: 3, z: 0.5 }));
    expect(s.x).toBeCloseTo(-2, 12);
    expect(s.y).toBeCloseTo(3, 12);
    expect(s.z).toBeCloseTo(0.5, 12);
    expect(q.equals(r, rot, 1e-9)).toBe(true);

    // A mirror on y is reported on x instead; the recomposed matrix is unchanged.
    const m = compose({ x: 0, y: 0, z: 0 }, q.identity(), { x: 1, y: -1, z: 1 });
    const d = decompose(m);
    expect(d.s.x).toBeCloseTo(-1, 12);
    const back = compose(d.t, d.r, d.s);
    back.forEach((v, i) => expect(v).toBeCloseTo(m[i] as number, 12));
  });

  it('returns identity rotation for a degenerate (zero) scale', () => {
    const { r, s } = decompose([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1]);
    expect(s).toEqual({ x: 0, y: 1, z: 1 });
    expect(r).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });

  it('rejects arrays shorter than 16', () => {
    expect(() => decompose([1, 0, 0])).toThrow(RangeError);
  });
});
