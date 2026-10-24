import { Rng, v3, type Vec3 } from '@conduit/math';
import { Region, Transform, World, defineSystem, type EntityId } from '@conduit/sim';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NODE_CELL,
  GridWorld,
  NodeWorld,
  RegionNotActive,
  SpatialGrid,
  SpatialIndex,
  rebase,
  type RegionDef,
} from '../src/index.ts';
import { CELL, at, defOf, place, registry, rig } from './rig.ts';

// docs/world.md §10 `test/spatial.test.ts`.

interface Point {
  id: EntityId;
  pos: Vec3;
}

/** `(a, b)` on the grid's plane. */
function project(plane: 'xz' | 'xy', p: Vec3): [number, number] {
  return plane === 'xz' ? [p.x, p.z] : [p.x, p.y];
}

/** 2000 points with distinct, shuffled ids, some on exact cell boundaries and some coincident. */
function points(rng: Rng, cellSize: number): Point[] {
  const out: Point[] = [];
  const ids = new Set<EntityId>();
  while (out.length < 2000) {
    const id = rng.int(1, 0x7fffffff);
    if (ids.has(id)) continue;
    ids.add(id);
    const kind = rng.int(0, 9);
    const coord = (): number =>
      kind === 0 ? rng.int(-20, 20) * cellSize : (rng.float() * 2 - 1) * 600;
    out.push({ id, pos: { x: coord(), y: coord(), z: coord() } });
  }
  // Coincident points, to exercise tie-breaking.
  for (let i = 0; i < 50; i++) {
    const src = out[rng.int(0, out.length - 1)] as Point;
    (out[rng.int(0, out.length - 1)] as Point).pos = v3.copy(src.pos);
  }
  return out;
}

function randomPos(rng: Rng): Vec3 {
  return {
    x: (rng.float() * 2 - 1) * 700,
    y: (rng.float() * 2 - 1) * 700,
    z: (rng.float() * 2 - 1) * 700,
  };
}

describe('SpatialGrid', () => {
  for (const [plane, cellSize] of [
    ['xz', 32],
    ['xy', 7.5],
    ['xz', 1000],
  ] as const) {
    it(`queryRadius and queryAABB match brute force and return ascending ids (${plane}, ${cellSize} m cells)`, () => {
      const rng = new Rng(cellSize * 13 + plane.length);
      const pts = points(rng, cellSize);
      const grid = new SpatialGrid(cellSize, plane);
      for (const p of pts) grid.insert(p.id, p.pos);
      expect(grid.size).toBe(pts.length);

      for (let q = 0; q < 200; q++) {
        const pick = rng.int(0, 5);
        const center =
          pick === 0 ? v3.copy((pts[rng.int(0, pts.length - 1)] as Point).pos) : randomPos(rng);
        const r = pick === 1 ? 0 : pick === 2 ? rng.float() * 5000 : rng.float() * 150;
        const [cx, cy] = project(plane, center);
        const expected = pts
          .filter((p) => {
            const [x, y] = project(plane, p.pos);
            return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
          })
          .map((p) => p.id)
          .sort((a, b) => a - b);
        const out = [-1];
        expect(grid.queryRadius(center, r, out)).toBe(out);
        expect(out.slice(1), `radius query ${q}`).toEqual(expected);

        const a = randomPos(rng);
        const b =
          pick === 3
            ? v3.copy(a)
            : {
                x: a.x + rng.float() * 300,
                y: a.y + rng.float() * 300,
                z: a.z + rng.float() * 300,
              };
        const [ax, ay] = project(plane, a);
        const [bx, by] = project(plane, b);
        const inBox = pts
          .filter((p) => {
            const [x, y] = project(plane, p.pos);
            return ax <= x && x <= bx && ay <= y && y <= by;
          })
          .map((p) => p.id)
          .sort((m, n) => m - n);
        expect(grid.queryAABB(a, b, []), `box query ${q}`).toEqual(inBox);
      }
    });
  }

  it('nearest matches brute force, honours exclude and breaks ties by lowest id', () => {
    const rng = new Rng(99);
    for (const [plane, cellSize] of [
      ['xz', 16],
      ['xy', 64],
    ] as const) {
      const pts = points(rng, cellSize);
      const grid = new SpatialGrid(cellSize, plane);
      for (const p of pts) grid.insert(p.id, p.pos);
      const brute = (center: Vec3, maxR: number, exclude?: EntityId): EntityId | undefined => {
        const [cx, cy] = project(plane, center);
        let best: EntityId | undefined;
        let bestD = Infinity;
        for (const p of pts) {
          if (p.id === exclude) continue;
          const [x, y] = project(plane, p.pos);
          const d = (x - cx) ** 2 + (y - cy) ** 2;
          if (d > maxR * maxR) continue;
          if (d < bestD || (d === bestD && best !== undefined && p.id < best)) {
            best = p.id;
            bestD = d;
          }
        }
        return best;
      };
      for (let q = 0; q < 300; q++) {
        const onPoint = q % 3 === 0;
        const center = onPoint
          ? v3.copy((pts[rng.int(0, pts.length - 1)] as Point).pos)
          : randomPos(rng);
        const maxR = q % 10 === 0 ? 1e6 : rng.float() * 120;
        const found = grid.nearest(center, maxR);
        expect(found, `nearest ${q}`).toBe(brute(center, maxR));
        if (found !== undefined) {
          expect(grid.nearest(center, maxR, found), `exclude ${q}`).toBe(
            brute(center, maxR, found),
          );
        }
      }
    }
    // Ties: equal distances resolve to the lowest id, whatever the insertion order.
    const grid = new SpatialGrid(10, 'xz');
    grid.insert(30, at(5, 0));
    grid.insert(20, at(-5, 0));
    grid.insert(10, at(0, 5));
    grid.insert(40, at(0, 4.999));
    expect(grid.nearest(at(0, 0), 5)).toBe(40);
    expect(grid.nearest(at(0, 0), 5, 40)).toBe(10);
    expect(grid.nearest(at(0, 0), 4.9)).toBeUndefined();
  });

  it('handles degenerate queries, clears, and validates its options', () => {
    const grid = new SpatialGrid(8, 'xz');
    expect(grid.nearest(at(0, 0), 100)).toBeUndefined();
    expect(grid.queryRadius(at(0, 0), 100, [])).toEqual([]);
    for (let i = 1; i <= 100; i++) grid.insert(i, at(i, -i, i * 1000));
    expect(grid.queryRadius(at(0, 0), -1, [])).toEqual([]);
    expect(grid.queryRadius(at(0, 0), Number.NaN, [])).toEqual([]);
    expect(grid.queryRadius({ x: Number.NaN, y: 0, z: 0 }, 5, [])).toEqual([]);
    expect(grid.queryRadius(at(0, 0), Infinity, []).length).toBe(100);
    expect(grid.queryAABB(at(10, 0), at(0, 10), [])).toEqual([]); // inverted
    expect(grid.queryAABB(at(3, -3), at(3, -3), [])).toEqual([3]); // a point box
    expect(grid.queryAABB(at(-Infinity, -Infinity), at(Infinity, Infinity), []).length).toBe(100);
    expect(grid.nearest(at(0, 0), -1)).toBeUndefined();
    expect(grid.nearest(at(50.4, -50.4), Infinity)).toBe(50);
    // Far beyond the 16-bit cell keys: aliased cells never leak into results.
    grid.insert(500, at(8 * 65536 + 1, 1));
    expect(grid.queryRadius(at(1, -1), 2, [])).toEqual([1, 2]); // (1,-1) and (2,-2); (3,-3) is 2.83 away
    expect(grid.queryRadius(at(8 * 65536 + 1, 1), 3, [])).toEqual([500]);
    grid.clear();
    expect(grid.size).toBe(0);
    expect(grid.queryRadius(at(1, -1), 10, [])).toEqual([]);
    for (const bad of [0, -1, Number.NaN, Infinity]) {
      expect(() => new SpatialGrid(bad, 'xz')).toThrow(RangeError);
    }
    expect(() => new SpatialGrid(1, 'yz' as 'xz')).toThrow(RangeError);
  });
});

describe('SpatialIndex', () => {
  it('queryRadiusAcross finds an entity 1 m across a border, rebased, with outRegions parallel to out', async () => {
    const h = rig({ spatial: true });
    const index = h.spatial as SpatialIndex;
    const here = place(h.world, 'cell/1_1', at(99.5, 99.5));
    const east = place(h.world, 'cell/2_1', at(0.5, 99.5)); // 1 m away
    const corner = place(h.world, 'cell/2_2', at(0.5, 0.5)); // sqrt(2) m away
    const south = place(h.world, 'cell/1_2', at(99.5, 1.5)); // 2 m away
    const far = place(h.world, 'cell/1_1', at(10, 10));
    await h.tick([], ['cell/0_0']); // cell/2_* stay inactive; cell/1_1 loads
    await h.tick([], ['cell/0_0']);

    const out: EntityId[] = [];
    const outRegions: string[] = [];
    index.queryRadiusAcross('cell/1_1', at(99.5, 99.5), 1.5, out, outRegions);
    expect(out).toEqual([here]); // the neighbours holding east and corner are not active
    expect(outRegions).toEqual(['cell/1_1']);

    await h.tick([], ['cell/2_2']);
    await h.tick([], ['cell/2_2']);
    expect(h.regions.active()).toEqual(
      expect.arrayContaining(['cell/1_1', 'cell/1_2', 'cell/2_1', 'cell/2_2']),
    );
    out.length = 0;
    outRegions.length = 0;
    const pos = at(99.5, 99.5);
    index.queryRadiusAcross('cell/1_1', pos, 1.5, out, outRegions);
    // Self first, then neighbours in graph order: cell/2_1 (iy 1), then cell/1_2 and cell/2_2 (iy 2).
    expect(out).toEqual([here, east, corner]);
    expect(outRegions).toEqual(['cell/1_1', 'cell/2_1', 'cell/2_2']);
    const from = defOf(h.graph, 'cell/1_1');
    for (let i = 0; i < out.length; i++) {
      const e = out[i] as EntityId;
      const region = defOf(h.graph, outRegions[i] as string);
      expect(h.world.get(e, Region).id).toBe(region.id);
      const local = rebase(region, from, h.world.get(e, Transform).pos); // into the query's frame
      expect(v3.distance(local, pos)).toBeLessThanOrEqual(1.5);
    }
    expect(
      v3.distance(rebase(defOf(h.graph, 'cell/2_1'), from, h.world.get(east, Transform).pos), pos),
    ).toBe(1);
    expect(index.queryRadiusAcross('cell/1_1', pos, 2, [])).toEqual([here, east, south, corner]);
    expect(index.queryRadius('cell/1_1', pos, 130, [])).toEqual([here, far].sort((a, b) => a - b));
  });

  it('grids rebuild each tick from moved positions, follow migrations and skip destroyed entities', async () => {
    const doomed: EntityId[] = [];
    const reaper = defineSystem('reaper', 'postSim', (ctx) => {
      for (const e of doomed.splice(0)) ctx.world.destroy(e);
    });
    const h = rig({ spatial: true, systems: [reaper] });
    const index = h.spatial as SpatialIndex;
    const mover = place(h.world, 'cell/1_1', at(40, 40), at(2, 0));
    const still = place(h.world, 'cell/1_1', at(60, 40));
    await h.tick([], ['cell/1_1']);
    expect(() => index.region('cell/1_1')).toThrow(RegionNotActive); // loading
    await h.tick([], ['cell/1_1']);
    expect(index.region('cell/1_1').size).toBe(2);
    const x = h.world.get(mover, Transform).pos.x; // 44 after two steps
    expect(index.queryRadius('cell/1_1', at(x, 40), 0, [])).toEqual([mover]);

    await h.tick([], ['cell/1_1']);
    expect(index.queryRadius('cell/1_1', at(x, 40), 0.5, [])).toEqual([]);
    expect(index.queryRadius('cell/1_1', at(x + 2, 40), 0, [])).toEqual([mover]);
    expect(index.nearest('cell/1_1', at(59, 40), 15)).toBe(still);
    expect(index.nearest('cell/1_1', at(59, 40), 15, still)).toBe(mover); // 13 m away
    expect(index.nearest('cell/1_1', at(59, 40), 12, still)).toBeUndefined();
    expect(index.queryAABB('cell/1_1', at(0, 0), at(100, 100), [])).toEqual([mover, still]);

    // Migrated into another active region: found there after the next rebuild, not in the old one.
    expect(h.regions.migrate(still, 'cell/2_2', at(5, 5))).toBe('moved');
    await h.tick([], ['cell/1_1']);
    expect(index.queryRadius('cell/1_1', at(60, 40), 1, [])).toEqual([]);
    expect(index.queryRadius('cell/2_2', at(5, 5), 0, [])).toEqual([still]);

    // Destroyed during a step: not in the grid rebuilt at the end of that step.
    doomed.push(mover);
    await h.tick([], ['cell/1_1']);
    expect(index.region('cell/1_1').size).toBe(0);
    expect(index.queryAABB('cell/1_1', at(0, 0), at(100, 100), [])).toEqual([]);

    // Evicted regions have no grid.
    expect(() => index.queryRadius('cell/3_3', at(1, 1), 1, [])).toThrow(RegionNotActive);
    expect(() => index.nearest('nowhere', at(1, 1), 1)).toThrow(RegionNotActive);
  });

  it('sizes grids from the region: an eighth of a bounded region, DEFAULT_NODE_CELL for a node, or cellSizeFor', async () => {
    const h = rig({ spatial: true });
    await h.tick([], ['cell/0_0']);
    await h.tick([], ['cell/0_0']);
    const index = h.spatial as SpatialIndex;
    expect(index.region('cell/0_0').cellSize).toBe(CELL / 8);
    expect(index.region('cell/0_0').plane).toBe('xz');
    const custom = new SpatialIndex({
      regions: h.regions,
      world: h.world,
      graph: h.graph,
      cellSizeFor: (def: RegionDef) => (def.id === 'cell/0_0' ? 3 : 5),
    });
    expect(custom.region('cell/0_0').cellSize).toBe(3);
    expect(custom.region('cell/1_1').cellSize).toBe(5);

    const xy = new GridWorld({ cellSize: 256, cols: 2, rows: 2, worldSeed: 1, plane: 'xy' });
    const flat = rig({ graph: xy, spatial: true });
    await flat.tick([], ['cell/0_0']);
    await flat.tick([], ['cell/0_0']);
    expect((flat.spatial as SpatialIndex).region('cell/1_1').cellSize).toBe(32);
    expect((flat.spatial as SpatialIndex).region('cell/1_1').plane).toBe('xy');
    expect(DEFAULT_NODE_CELL).toBe(64);
  });

  it('a node region has no borders: queryRadiusAcross searches only the region itself', async () => {
    const node = (id: string, neighbors: string[]): RegionDef => ({
      id,
      kind: 'system',
      bounds: { kind: 'node', origin: v3.create() },
      neighbors,
      assets: [],
      seed: 1,
    });
    const graph = new NodeWorld([node('sol', ['alpha']), node('alpha', ['sol'])]);
    const h = rig({ graph, spatial: true, world: new World(registry) });
    const a = place(h.world, 'sol', at(1000, -2000));
    const b = place(h.world, 'alpha', at(1000, -2000)); // same local position, another system
    await h.tick([], ['sol']);
    await h.tick([], ['sol']);
    const index = h.spatial as SpatialIndex;
    expect(h.regions.active()).toEqual(['alpha', 'sol']);
    expect(index.region('sol').cellSize).toBe(DEFAULT_NODE_CELL);
    const regions: string[] = [];
    expect(index.queryRadiusAcross('sol', at(1000, -2000), 10, [], regions)).toEqual([a]);
    expect(regions).toEqual(['sol']);
    expect(index.queryRadius('alpha', at(1000, -2000), 10, [])).toEqual([b]);
  });
});
