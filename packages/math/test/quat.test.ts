import { describe, expect, it } from 'vitest';
import { EPS, HALF_PI, PI, q, Rng, TAU, v3, type Quat, type Vec3 } from '../src/index.ts';

function randomUnitQuat(rng: Rng): Quat {
  // Rejection-free: normalize a random 4-vector away from the origin.
  for (;;) {
    const r = q.create(
      rng.float() * 2 - 1,
      rng.float() * 2 - 1,
      rng.float() * 2 - 1,
      rng.float() * 2 - 1,
    );
    if (q.length(r) > 0.1) return q.normalize(r);
  }
}

function expectQuatClose(actual: Quat, expected: Quat, digits = 12): void {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.z).toBeCloseTo(expected.z, digits);
  expect(actual.w).toBeCloseTo(expected.w, digits);
}

function expectVecClose(actual: Vec3, expected: Vec3, eps = EPS): void {
  expect(Math.abs(actual.x - expected.x)).toBeLessThanOrEqual(eps);
  expect(Math.abs(actual.y - expected.y)).toBeLessThanOrEqual(eps);
  expect(Math.abs(actual.z - expected.z)).toBeLessThanOrEqual(eps);
}

const X: Vec3 = { x: 1, y: 0, z: 0 };
const Y: Vec3 = { x: 0, y: 1, z: 0 };
const Z: Vec3 = { x: 0, y: 0, z: 1 };

describe('q basics', () => {
  it('identity, create, copy, set', () => {
    expect(q.identity()).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(q.create()).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    const out = q.create(1, 2, 3, 4);
    expect(q.identity(out)).toBe(out);
    expect(out).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(q.set(out, 1, 2, 3, 4)).toEqual({ x: 1, y: 2, z: 3, w: 4 });
    const c = q.copy(out);
    expect(c).toEqual(out);
    expect(c).not.toBe(out);
  });

  it('dot, length, normalize', () => {
    expect(q.dot(q.create(1, 2, 3, 4), q.create(5, 6, 7, 8))).toBe(70);
    expect(q.length(q.create(1, 1, 1, 1))).toBe(2);
    expect(q.normalize(q.create(0, 0, 0, 2))).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(q.normalize(q.create(0, 0, 0, 0))).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    const n = q.normalize(q.create(1, 1, 1, 1));
    expectQuatClose(n, { x: 0.5, y: 0.5, z: 0.5, w: 0.5 });
  });

  it('equals treats q and -q as the same rotation', () => {
    const r = q.fromAxisAngle(Y, 0.7);
    expect(q.equals(r, q.create(-r.x, -r.y, -r.z, -r.w))).toBe(true);
    expect(q.equals(r, q.fromAxisAngle(Y, 0.8))).toBe(false);
  });
});

describe('q.multiply', () => {
  it('has identity on both sides', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 50; i++) {
      const a = randomUnitQuat(rng);
      expect(q.multiply(a, q.identity())).toEqual(a);
      expect(q.multiply(q.identity(), a)).toEqual(a);
    }
  });

  it('is associative', () => {
    const rng = new Rng(11);
    for (let i = 0; i < 100; i++) {
      const a = randomUnitQuat(rng);
      const b = randomUnitQuat(rng);
      const c = randomUnitQuat(rng);
      expectQuatClose(q.multiply(q.multiply(a, b), c), q.multiply(a, q.multiply(b, c)));
    }
  });

  it('applies b first, then a', () => {
    const a = q.fromAxisAngle(Z, HALF_PI);
    const b = q.fromAxisAngle(Y, HALF_PI);
    // b rotates +X to -Z; a (about Z) leaves -Z alone.
    expectVecClose(q.rotateVec3(q.multiply(a, b), X), { x: 0, y: 0, z: -1 });
    // a rotates +X to +Y; b (about Y) leaves +Y alone.
    expectVecClose(q.rotateVec3(q.multiply(b, a), X), { x: 0, y: 1, z: 0 });
  });

  it('is correct when out aliases an input', () => {
    const rng = new Rng(3);
    const a = randomUnitQuat(rng);
    const b = randomUnitQuat(rng);
    const expected = q.multiply(a, b);
    const a2 = q.copy(a);
    expect(q.multiply(a2, b, a2)).toBe(a2);
    expect(a2).toEqual(expected);
    const b2 = q.copy(b);
    q.multiply(a, b2, b2);
    expect(b2).toEqual(expected);
  });
});

describe('q.conjugate and rotateVec3', () => {
  it('rotates +Z by fromAxisAngle(+Y, PI/2) to +X within EPS', () => {
    const r = q.fromAxisAngle(Y, PI / 2);
    expectVecClose(q.rotateVec3(r, Z), X);
  });

  it('conjugate inverts a rotation', () => {
    const rng = new Rng(5);
    for (let i = 0; i < 100; i++) {
      const r = randomUnitQuat(rng);
      const v = v3.create(rng.float() * 10 - 5, rng.float() * 10 - 5, rng.float() * 10 - 5);
      const back = q.rotateVec3(q.conjugate(r), q.rotateVec3(r, v));
      expectVecClose(back, v, 1e-9);
      expect(q.equals(q.multiply(r, q.conjugate(r)), q.identity())).toBe(true);
    }
    expect(q.conjugate(q.create(1, 2, 3, 4))).toEqual({ x: -1, y: -2, z: -3, w: 4 });
  });

  it('rotateVec3 preserves length and supports out aliasing v', () => {
    const r = q.fromAxisAngle(v3.normalize({ x: 1, y: 2, z: 3 }), 1.3);
    const v = { x: 3, y: -1, z: 2 };
    const expected = q.rotateVec3(r, v);
    expect(v3.length(expected)).toBeCloseTo(v3.length(v), 12);
    expect(q.rotateVec3(r, v, v)).toBe(v);
    expect(v).toEqual(expected);
  });

  it('fromAxisAngle follows the right-hand rule', () => {
    expectVecClose(q.rotateVec3(q.fromAxisAngle(Z, HALF_PI), X), Y);
    expectVecClose(q.rotateVec3(q.fromAxisAngle(X, HALF_PI), Y), Z);
    const out = q.create();
    expect(q.fromAxisAngle(X, TAU, out)).toBe(out);
    expect(q.equals(out, q.identity())).toBe(true);
  });
});

describe('q.fromEuler', () => {
  it('equals the explicit product form for 100 seeded angle triples', () => {
    const rng = new Rng(2024);
    for (let i = 0; i < 100; i++) {
      const yaw = (rng.float() * 2 - 1) * TAU;
      const pitch = (rng.float() * 2 - 1) * TAU;
      const roll = (rng.float() * 2 - 1) * TAU;
      const qY = q.fromAxisAngle(Y, yaw);
      const qX = q.fromAxisAngle(X, pitch);
      const qZ = q.fromAxisAngle(Z, roll);
      const product = q.multiply(q.multiply(qY, qX), qZ);
      expectQuatClose(q.fromEuler(yaw, pitch, roll), product);
    }
  });

  it('yaw turns about +Y, pitch about +X, roll about +Z', () => {
    expectVecClose(q.rotateVec3(q.fromEuler(HALF_PI, 0, 0), Z), X);
    expectVecClose(q.rotateVec3(q.fromEuler(0, HALF_PI, 0), Y), Z);
    expectVecClose(q.rotateVec3(q.fromEuler(0, 0, HALF_PI), X), Y);
    const out = q.create(9, 9, 9, 9);
    expect(q.fromEuler(0, 0, 0, out)).toBe(out);
    expect(out).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });
});

describe('q.slerp', () => {
  it('returns the endpoints at t = 0 and t = 1', () => {
    const rng = new Rng(99);
    for (let i = 0; i < 50; i++) {
      const a = randomUnitQuat(rng);
      let b = randomUnitQuat(rng);
      if (q.dot(a, b) < 0) b = q.create(-b.x, -b.y, -b.z, -b.w);
      expectQuatClose(q.slerp(a, b, 0), a, 9);
      expectQuatClose(q.slerp(a, b, 1), b, 9);
    }
  });

  it('midpoint of a 90 degree turn is the 45 degree rotation', () => {
    const a = q.identity();
    const b = q.fromAxisAngle(Y, HALF_PI);
    const mid = q.slerp(a, b, 0.5);
    expectQuatClose(mid, q.fromAxisAngle(Y, PI / 4));
    expect(q.length(mid)).toBeCloseTo(1, 12);
  });

  it('takes the shortest arc when the inputs have a negative dot', () => {
    const a = q.identity();
    const b = q.fromAxisAngle(Y, HALF_PI);
    const negB = q.create(-b.x, -b.y, -b.z, -b.w);
    expect(q.dot(a, negB)).toBeLessThan(0);
    const mid = q.slerp(a, negB, 0.5);
    expectQuatClose(mid, q.fromAxisAngle(Y, PI / 4));
    expectQuatClose(q.slerp(a, negB, 1), b);
  });

  it('does not produce NaN for near-identical inputs', () => {
    const a = q.fromAxisAngle(Y, 0.3);
    const inputs = [q.copy(a), q.fromAxisAngle(Y, 0.3 + 1e-9), q.fromAxisAngle(Y, 0.3 + 1e-4)];
    for (const b of inputs) {
      for (const t of [0, 0.25, 0.5, 1]) {
        const r = q.slerp(a, b, t);
        expect(Number.isNaN(r.x + r.y + r.z + r.w)).toBe(false);
        expect(q.length(r)).toBeCloseTo(1, 9);
        expect(q.equals(r, a, 1e-6)).toBe(true);
      }
    }
    // Negated near-identical input takes the nlerp fallback without flipping the result.
    const r = q.slerp(a, q.create(-a.x, -a.y, -a.z, -a.w), 0.5);
    expectQuatClose(r, a);
  });

  it('is correct when out aliases an input', () => {
    const a = q.identity();
    const b = q.fromAxisAngle(X, 1);
    const expected = q.slerp(a, b, 0.3);
    q.slerp(a, b, 0.3, a);
    expect(a).toEqual(expected);
  });
});
