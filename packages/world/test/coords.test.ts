import { Rng, v3, type Vec3 } from '@conduit/math';
import { describe, expect, it } from 'vitest';
import {
  CLAMP_EPS,
  GridWorld,
  clampToBounds,
  contains,
  rebase,
  toLocal,
  toWorld,
  type RegionBounds,
  type RegionDef,
} from '../src/index.ts';

function region(id: string, bounds: RegionBounds): RegionDef {
  return { id, kind: 'test', bounds, neighbors: [], assets: [], seed: 0 };
}

const planeXZ = region('xz', {
  kind: 'aabb2',
  origin: { x: 1000, y: 5, z: -2000 },
  min: { x: 0, y: 0 },
  max: { x: 256, y: 256 },
  plane: 'xz',
});
const planeXY = region('xy', {
  kind: 'aabb2',
  origin: { x: -300, y: 40, z: 7 },
  min: { x: -50, y: -25 },
  max: { x: 50, y: 25 },
  plane: 'xy',
});
const box = region('box', {
  kind: 'aabb3',
  origin: { x: 1, y: 2, z: 3 },
  min: { x: -10, y: -5, z: 0 },
  max: { x: 10, y: 5, z: 20 },
});
const node = region('node', { kind: 'node', origin: { x: 1e6, y: 0, z: -1e6 } });

const ALL = [planeXZ, planeXY, box, node];
const BOUNDED = [planeXZ, planeXY, box];

const vec = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

function randomVec(rng: Rng, span: number): Vec3 {
  return vec(
    (rng.float() * 2 - 1) * span,
    (rng.float() * 2 - 1) * span,
    (rng.float() * 2 - 1) * span,
  );
}

/** Absolute tolerance for positions around 1e6 m built from two additions. */
const TOL = 1e-9 * 1e3;

describe('coords', () => {
  it('CLAMP_EPS is one millimetre', () => {
    expect(CLAMP_EPS).toBe(1e-3);
  });

  it('toWorld adds the origin and toLocal subtracts it', () => {
    expect(toWorld(planeXZ, vec(1, 2, 3))).toStrictEqual(vec(1001, 7, -1997));
    expect(toLocal(planeXZ, vec(1001, 7, -1997))).toStrictEqual(vec(1, 2, 3));
    expect(toWorld(node, vec(0, 0, 0))).toStrictEqual(node.bounds.origin);
    expect(toWorld(node, vec(0, 0, 0))).not.toBe(node.bounds.origin);
  });

  it('toWorld and toLocal are inverses', () => {
    const rng = new Rng(11);
    for (const def of ALL) {
      for (let i = 0; i < 1000; i++) {
        const p = randomVec(rng, 1e4);
        expect(v3.equals(toLocal(def, toWorld(def, p)), p, TOL)).toBe(true);
        expect(v3.equals(toWorld(def, toLocal(def, p)), p, TOL)).toBe(true);
        // Exact on integers (`+ 0` turns a rounded -0 into +0, which subtraction yields).
        const q = vec(Math.round(p.x) + 0, Math.round(p.y) + 0, Math.round(p.z) + 0);
        expect(toLocal(def, toWorld(def, q))).toStrictEqual(q);
      }
    }
  });

  it('writes into out, which may alias the input', () => {
    const p = vec(1, 2, 3);
    expect(toWorld(planeXZ, p, p)).toBe(p);
    expect(p).toStrictEqual(vec(1001, 7, -1997));
    expect(toLocal(planeXZ, p, p)).toBe(p);
    expect(p).toStrictEqual(vec(1, 2, 3));
    expect(rebase(planeXZ, box, p, p)).toBe(p);
    expect(p).toStrictEqual(vec(1000, 5, -2000));
    expect(clampToBounds(box, p, p)).toBe(p);
    expect(p).toStrictEqual(vec(10 - CLAMP_EPS, 5 - CLAMP_EPS, 0));
    const input = vec(1, 1, 1);
    expect(rebase(box, box, input)).not.toBe(input);
    expect(clampToBounds(node, input)).not.toBe(input);
  });

  it('rebase preserves the world position across two regions', () => {
    const rng = new Rng(12);
    for (const from of ALL) {
      for (const to of ALL) {
        for (let i = 0; i < 250; i++) {
          const p = randomVec(rng, 1e4);
          const moved = rebase(from, to, p);
          expect(v3.equals(toWorld(to, moved), toWorld(from, p), TOL)).toBe(true);
        }
      }
    }
  });

  it('rebase between grid neighbours is exact', () => {
    const grid = new GridWorld({ cellSize: 256, cols: 16, rows: 16, worldSeed: 1 });
    const cell = (id: string): RegionDef => grid.get(id) as RegionDef;
    const p = vec(300, 4, 10); // past the +x edge of cell/1_1
    expect(rebase(cell('cell/1_1'), cell('cell/2_1'), p)).toStrictEqual(vec(44, 4, 10));
    expect(rebase(cell('cell/1_1'), cell('cell/1_0'), p)).toStrictEqual(vec(300, 4, 266));
    expect(toWorld(cell('cell/2_1'), vec(44, 4, 10))).toStrictEqual(toWorld(cell('cell/1_1'), p));
    expect(rebase(cell('cell/1_1'), cell('cell/1_1'), p)).toStrictEqual(p);
  });

  it('contains is half-open on both bounded axes of an xz region', () => {
    const inside = [vec(0, 0, 0), vec(255.999, 0, 255.999), vec(0, 1e12, 0), vec(10, -1e12, 10)];
    const outside = [
      vec(256, 0, 0),
      vec(0, 0, 256),
      vec(-0.001, 0, 0),
      vec(0, 0, -0.001),
      vec(Number.NaN, 0, 0),
      vec(0, 0, Number.POSITIVE_INFINITY),
    ];
    for (const p of inside) expect(contains(planeXZ, p), JSON.stringify(p)).toBe(true);
    for (const p of outside) expect(contains(planeXZ, p), JSON.stringify(p)).toBe(false);
    expect(contains(planeXZ, vec(0, Number.NaN, 0))).toBe(true); // y is unbounded on xz
  });

  it('contains bounds x and y on an xy region and leaves z unbounded', () => {
    expect(contains(planeXY, vec(-50, -25, 0))).toBe(true);
    expect(contains(planeXY, vec(49.999, 24.999, 1e9))).toBe(true);
    expect(contains(planeXY, vec(50, 0, 0))).toBe(false);
    expect(contains(planeXY, vec(0, 25, 0))).toBe(false);
    expect(contains(planeXY, vec(0, -25.001, 0))).toBe(false);
    expect(contains(planeXY, vec(-50.001, 0, 0))).toBe(false);
  });

  it('contains is half-open on all three axes of an aabb3 region', () => {
    expect(contains(box, vec(-10, -5, 0))).toBe(true);
    expect(contains(box, vec(9.999, 4.999, 19.999))).toBe(true);
    expect(contains(box, vec(10, 0, 10))).toBe(false);
    expect(contains(box, vec(0, 5, 10))).toBe(false);
    expect(contains(box, vec(0, 0, 20))).toBe(false);
    expect(contains(box, vec(0, -5.001, 10))).toBe(false);
    expect(contains(box, vec(0, 0, -0.001))).toBe(false);
  });

  it('node regions contain every position', () => {
    for (const p of [vec(0, 0, 0), vec(1e12, -1e12, 3), vec(Number.NaN, 0, 0)]) {
      expect(contains(node, p)).toBe(true);
    }
  });

  it('clampToBounds result is contained', () => {
    const rng = new Rng(13);
    const special = [
      0,
      -0,
      1e-3,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
    ];
    for (const def of BOUNDED) {
      const b = def.bounds as Extract<RegionBounds, { min: unknown }>;
      const edges = [b.min.x, b.min.y, b.max.x, b.max.y, ...special];
      for (let i = 0; i < 2000; i++) {
        const p = rng.chance(0.2)
          ? vec(rng.pick(edges) ?? 0, rng.pick(edges) ?? 0, rng.pick(edges) ?? 0)
          : randomVec(rng, 1000);
        expect(contains(def, clampToBounds(def, p)), `${def.id} ${JSON.stringify(p)}`).toBe(true);
      }
    }
  });

  it('clampToBounds clamps bounded axes to [min, max - CLAMP_EPS] and nothing else', () => {
    expect(clampToBounds(planeXZ, vec(500, 1e9, -3))).toStrictEqual(vec(256 - CLAMP_EPS, 1e9, 0));
    expect(clampToBounds(planeXY, vec(-51, 99, -1e9))).toStrictEqual(
      vec(-50, 25 - CLAMP_EPS, -1e9),
    );
    expect(clampToBounds(box, vec(100, -100, 100))).toStrictEqual(
      vec(10 - CLAMP_EPS, -5, 20 - CLAMP_EPS),
    );
    expect(clampToBounds(box, vec(Number.NaN, Number.NaN, Number.NaN))).toStrictEqual(
      vec(-10, -5, 0),
    );
    expect(clampToBounds(node, vec(1e9, Number.NaN, -3))).toStrictEqual(vec(1e9, Number.NaN, -3));
  });

  it('clampToBounds leaves contained positions unchanged', () => {
    const rng = new Rng(14);
    for (const def of BOUNDED) {
      for (let i = 0; i < 500; i++) {
        const p = randomVec(rng, 60);
        if (contains(def, p)) expect(clampToBounds(def, p)).toStrictEqual(p);
      }
    }
  });

  it('clampToBounds keeps an extent narrower than CLAMP_EPS contained', () => {
    const thin = region('thin', {
      kind: 'aabb3',
      origin: vec(0, 0, 0),
      min: vec(0, 0, 0),
      max: vec(CLAMP_EPS / 2, 1, 1),
    });
    const clamped = clampToBounds(thin, vec(5, 5, 5));
    expect(clamped.x).toBe(0);
    expect(contains(thin, clamped)).toBe(true);
  });
});
