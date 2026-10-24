import { Rng, fnv1a32, type Vec3 } from '@conduit/math';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WANTED_DEPTH,
  GridWorld,
  NodeWorld,
  WorldGraphError,
  fromJson,
  validateGraphJson,
  type GridWorldOpts,
  type RegionDef,
  type WorldGraphJson,
} from '../src/index.ts';

const CELL = 256;

/** The sandbox layout: 16 x 16 cells of 256 m on plane xz. */
function sandbox(extra: Partial<GridWorldOpts> = {}): GridWorld {
  return new GridWorld({ cellSize: CELL, cols: 16, rows: 16, worldSeed: 42, ...extra });
}

const at = (x: number, z: number, y = 0): Vec3 => ({ x, y, z });

/** Deep copy through JSON, as a file written by tooling would read back. */
const reparse = (json: WorldGraphJson): WorldGraphJson =>
  JSON.parse(JSON.stringify(json)) as WorldGraphJson;

/** Row-major cell ids within Chebyshev distance `depth` of `(ix, iy)`, self first. */
function expectedWanted(grid: GridWorld, ix: number, iy: number, depth: number): string[] {
  const out = [grid.idAt(ix, iy)];
  for (let dy = -depth; dy <= depth; dy++) {
    for (let dx = -depth; dx <= depth; dx++) {
      const x = ix + dx;
      const y = iy + dy;
      if ((dx !== 0 || dy !== 0) && x >= 0 && x < grid.cols && y >= 0 && y < grid.rows) {
        out.push(grid.idAt(x, y));
      }
    }
  }
  return out;
}

describe('GridWorld construction', () => {
  it('applies the documented defaults', () => {
    const grid = sandbox();
    expect(grid.plane).toBe('xz');
    expect(grid.wantedDepth).toBe(DEFAULT_WANTED_DEPTH);
    expect(DEFAULT_WANTED_DEPTH).toBe(1);
    expect([grid.cellSize, grid.cols, grid.rows]).toEqual([CELL, 16, 16]);
    expect(grid.get('cell/3_7')).toStrictEqual({
      id: 'cell/3_7',
      kind: 'cell',
      bounds: {
        kind: 'aabb2',
        origin: { x: 3 * CELL, y: 0, z: 7 * CELL },
        min: { x: 0, y: 0 },
        max: { x: CELL, y: CELL },
        plane: 'xz',
      },
      neighbors: grid.wanted('cell/3_7', 1).slice(1),
      assets: [],
      seed: fnv1a32('cell/3_7', 42),
    });
  });

  it('places default origins on plane xy', () => {
    const grid = new GridWorld({ cellSize: 10, cols: 4, rows: 4, plane: 'xy', worldSeed: 1 });
    expect(grid.get('cell/2_3')?.bounds).toStrictEqual({
      kind: 'aabb2',
      origin: { x: 20, y: 30, z: 0 },
      min: { x: 0, y: 0 },
      max: { x: 10, y: 10 },
      plane: 'xy',
    });
  });

  it('throws WorldGraphError for a custom originOf that is not grid-consistent', () => {
    const inconsistent: [string, (ix: number, iy: number) => Vec3, ('xz' | 'xy')?][] = [
      ['wrong spacing', (ix, iy) => ({ x: ix * 200, y: 0, z: iy * CELL })],
      ['moves on the third axis', (ix, iy) => ({ x: ix * CELL, y: ix, z: iy * CELL })],
      ['spans the xy plane', (ix, iy) => ({ x: ix * CELL, y: iy * CELL, z: 0 })],
      ['spans the xz plane', (ix, iy) => ({ x: ix * CELL, y: 0, z: iy * CELL }), 'xy'],
    ];
    for (const [label, originOf, plane] of inconsistent) {
      const opts = plane === undefined ? { originOf } : { originOf, plane };
      expect(() => sandbox(opts), label).toThrow(WorldGraphError);
      expect(() => sandbox(opts), label).toThrow(/grid-consistent/);
    }
  });

  it('accepts a grid-consistent custom originOf with an offset base', () => {
    const grid = sandbox({
      originOf: (ix, iy) => ({ x: (ix - 8) * CELL, y: 3, z: (iy - 8) * CELL }),
    });
    expect(grid.get('cell/8_8')?.bounds.origin).toStrictEqual({ x: 0, y: 3, z: 0 });
    expect(grid.get('cell/0_15')?.bounds.origin).toStrictEqual({ x: -2048, y: 3, z: 1792 });
  });

  it('copies origins so later changes to the returned object do not leak in', () => {
    const shared = { x: 0, y: 0, z: 0 };
    const grid = sandbox({
      originOf: (ix, iy) => {
        shared.x = ix * CELL;
        shared.z = iy * CELL;
        return shared;
      },
    });
    const def = grid.get('cell/2_2');
    shared.x = 12345;
    expect(def?.bounds.origin).toStrictEqual({ x: 512, y: 0, z: 512 });
  });

  it('rejects invalid options with WorldGraphError', () => {
    const bad: Partial<GridWorldOpts>[] = [
      { cellSize: 0 },
      { cellSize: -1 },
      { cellSize: Number.NaN },
      { cellSize: Number.POSITIVE_INFINITY },
      { cols: 0 },
      { cols: 1.5 },
      { rows: 0 },
      { rows: Number.NaN },
      { kind: '' },
      { plane: 'yz' as 'xz' },
      { wantedDepth: -1 },
      { wantedDepth: 0.5 },
      { worldSeed: -1 },
      { worldSeed: 2 ** 32 },
      { worldSeed: 1.5 },
    ];
    for (const opts of bad) {
      expect(() => sandbox(opts), JSON.stringify(opts)).toThrow(WorldGraphError);
    }
    expect(() =>
      sandbox({ wantedDepth: 0, cols: 1, rows: 1, worldSeed: 0xffffffff }),
    ).not.toThrow();
  });
});

describe('GridWorld ids', () => {
  it('formats ids as `${kind}/${ix}_${iy}`', () => {
    expect(sandbox().idAt(3, 7)).toBe('cell/3_7');
    expect(sandbox({ kind: 'chunk' }).idAt(12, 0)).toBe('chunk/12_0');
  });

  it('parses every id back to its cell', () => {
    const grid = sandbox();
    for (let iy = 0; iy < grid.rows; iy++) {
      for (let ix = 0; ix < grid.cols; ix++) {
        const id = grid.idAt(ix, iy);
        expect(grid.indexOf(id)).toStrictEqual({ ix, iy });
        expect(grid.get(id)?.id).toBe(id);
      }
    }
  });

  it('rejects malformed, foreign-kind and out-of-grid ids', () => {
    const grid = sandbox();
    const rejected = [
      '',
      'cell',
      'cell/',
      'cell/3',
      'cell/3_',
      'cell/_7',
      'cell/3_7_1',
      'cell/03_7',
      'cell/3_07',
      'cell/-1_0',
      'cell/+1_0',
      'cell/1.5_2',
      'cell/1e1_2',
      'cell/ 3_7',
      'cell/3_7 ',
      'cell/16_0',
      'cell/0_16',
      'cell/99999999999999999999_0',
      'tile/3_7',
      'Cell/3_7',
      'xcell/3_7',
    ];
    for (const id of rejected) {
      expect(grid.indexOf(id), id).toBeUndefined();
      expect(grid.get(id), id).toBeUndefined();
    }
  });

  it('parses ids whose kind contains separators', () => {
    const grid = sandbox({ kind: 'sea_1/deep' });
    expect(grid.idAt(3, 7)).toBe('sea_1/deep/3_7');
    expect(grid.indexOf('sea_1/deep/3_7')).toStrictEqual({ ix: 3, iy: 7 });
    expect(grid.get('sea_1/deep/0_0')?.kind).toBe('sea_1/deep');
    expect(grid.get('cell/0_0')).toBeUndefined();
  });

  it('caches defs', () => {
    const grid = sandbox();
    expect(grid.get('cell/4_4')).toBe(grid.get('cell/4_4'));
  });
});

describe('GridWorld seeds', () => {
  it('seeds each region with fnv1a32(id, worldSeed)', () => {
    const grid = sandbox();
    expect(grid.get('cell/3_7')?.seed).toBe(fnv1a32('cell/3_7', 42));
  });

  it('seeds differ per cell and are stable', () => {
    const seedsOf = (grid: GridWorld): number[] => grid.toJson().regions.map((def) => def.seed);
    const seeds = seedsOf(sandbox());
    expect(new Set(seeds).size).toBe(256);
    for (const s of seeds) expect(Number.isInteger(s) && s >= 0 && s < 2 ** 32).toBe(true);
    expect(seedsOf(sandbox())).toEqual(seeds);
    const other = seedsOf(sandbox({ worldSeed: 43 }));
    other.forEach((s, i) => expect(s).not.toBe(seeds[i]));
  });
});

describe('GridWorld.locate', () => {
  it('uses floor division: a coordinate of exactly cellSize belongs to the next cell', () => {
    const grid = sandbox();
    const below = CELL - 2 ** -45; // largest double below 256
    expect(grid.locate(at(0, 0))).toBe('cell/0_0');
    expect(grid.locate(at(below, below))).toBe('cell/0_0');
    expect(grid.locate(at(CELL, 0))).toBe('cell/1_0');
    expect(grid.locate(at(0, CELL))).toBe('cell/0_1');
    expect(grid.locate(at(CELL, CELL))).toBe('cell/1_1');
    expect(grid.locate(at(3 * CELL + 17.5, 7 * CELL))).toBe('cell/3_7');
    expect(grid.locate(at(16 * CELL - 0.5, 16 * CELL - 0.5))).toBe('cell/15_15');
    expect(grid.locate(at(16 * CELL, 0))).toBeNull();
    expect(grid.locate(at(0, 16 * CELL))).toBeNull();
  });

  it('leaves the third axis unbounded', () => {
    const grid = sandbox();
    expect(grid.locate(at(10, 10, 1e9))).toBe('cell/0_0');
    expect(grid.locate(at(10, 10, -1e9))).toBe('cell/0_0');
  });

  it('returns null for negative and non-finite coordinates', () => {
    const grid = sandbox();
    expect(grid.locate(at(-0.001, 10))).toBeNull();
    expect(grid.locate(at(10, -0.001))).toBeNull();
    expect(grid.locate(at(-CELL, -CELL))).toBeNull();
    expect(grid.locate(at(-0, -0))).toBe('cell/0_0');
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(grid.locate(at(bad, 10))).toBeNull();
      expect(grid.locate(at(10, bad))).toBeNull();
      expect(grid.locate(at(bad, 10), 'cell/0_0')).toBeNull();
    }
  });

  it('bounds x and y on plane xy and ignores z', () => {
    const grid = new GridWorld({ cellSize: 10, cols: 4, rows: 4, plane: 'xy', worldSeed: 1 });
    expect(grid.locate({ x: 15, y: 25, z: 1e6 })).toBe('cell/1_2');
    expect(grid.locate({ x: 15, y: 40, z: 0 })).toBeNull();
    expect(grid.locate({ x: 15, y: 25, z: 0 }, 'cell/1_2')).toBe('cell/1_2');
  });

  it('locates relative to the base of a custom originOf', () => {
    const grid = sandbox({
      originOf: (ix, iy) => ({ x: (ix - 8) * CELL, y: 0, z: (iy - 8) * CELL }),
    });
    expect(grid.locate(at(0, 0))).toBe('cell/8_8');
    expect(grid.locate(at(-1, -1))).toBe('cell/7_7');
    expect(grid.locate(at(-2048, -2048))).toBe('cell/0_0');
    expect(grid.locate(at(2047.5, 2047.5))).toBe('cell/15_15');
    expect(grid.locate(at(-2048.5, 0))).toBeNull();
    expect(grid.locate(at(2048, 0))).toBeNull();
  });

  it('returns the hint without dividing when the position is inside it', () => {
    const grid = sandbox();
    grid.get('cell/3_7'); // build the def first: it computes neighbour ids
    const idAt = vi.spyOn(grid, 'idAt');
    expect(grid.locate(at(3 * CELL + 1, 7 * CELL + 1), 'cell/3_7')).toBe('cell/3_7');
    expect(grid.locate(at(3 * CELL, 7 * CELL), 'cell/3_7')).toBe('cell/3_7');
    expect(grid.locate(at(4 * CELL - 0.001, 8 * CELL - 0.001, 99), 'cell/3_7')).toBe('cell/3_7');
    expect(idAt).not.toHaveBeenCalled();
  });

  it('re-locates when the position is outside the hint', () => {
    const grid = sandbox();
    grid.get('cell/3_7');
    const idAt = vi.spyOn(grid, 'idAt');
    expect(grid.locate(at(4 * CELL + 1, 7 * CELL + 1), 'cell/3_7')).toBe('cell/4_7');
    expect(idAt).toHaveBeenCalledTimes(1);
    expect(grid.locate(at(4 * CELL, 7 * CELL), 'cell/3_7')).toBe('cell/4_7');
    expect(grid.locate(at(3 * CELL, 7 * CELL - 0.001), 'cell/3_7')).toBe('cell/3_6');
    expect(grid.locate(at(-1, 0), 'cell/0_0')).toBeNull();
  });

  it('ignores hints that are not cells of the grid', () => {
    const grid = sandbox();
    const p = at(5 * CELL + 3, 2 * CELL + 3);
    for (const hint of ['nope', 'tile/5_2', 'cell/99_2', 'cell/05_2', '']) {
      expect(grid.locate(p, hint), hint).toBe('cell/5_2');
    }
  });
});

describe('GridWorld.wanted and neighbors', () => {
  it('gives a corner cell 4 entries: self first, then row-major', () => {
    const grid = sandbox();
    expect(grid.wanted('cell/0_0')).toEqual(['cell/0_0', 'cell/1_0', 'cell/0_1', 'cell/1_1']);
    expect(grid.wanted('cell/15_15')).toEqual([
      'cell/15_15',
      'cell/14_14',
      'cell/15_14',
      'cell/14_15',
    ]);
  });

  it('gives an interior cell 9 entries: self first, then row-major', () => {
    expect(sandbox().wanted('cell/5_5')).toEqual([
      'cell/5_5',
      'cell/4_4',
      'cell/5_4',
      'cell/6_4',
      'cell/4_5',
      'cell/6_5',
      'cell/4_6',
      'cell/5_6',
      'cell/6_6',
    ]);
  });

  it('gives an edge cell 6 entries', () => {
    expect(sandbox().wanted('cell/5_0')).toEqual([
      'cell/5_0',
      'cell/4_0',
      'cell/6_0',
      'cell/4_1',
      'cell/5_1',
      'cell/6_1',
    ]);
  });

  it('gives an interior cell 25 entries at depth 2, in row-major order', () => {
    const grid = sandbox();
    const wanted = grid.wanted('cell/7_9', 2);
    expect(wanted).toHaveLength(25);
    expect(wanted).toEqual(expectedWanted(grid, 7, 9, 2));
  });

  it('matches the reference enumeration for every cell and depths 0..3', () => {
    const grid = new GridWorld({ cellSize: 1, cols: 7, rows: 5, worldSeed: 3 });
    for (let depth = 0; depth <= 3; depth++) {
      for (let iy = 0; iy < grid.rows; iy++) {
        for (let ix = 0; ix < grid.cols; ix++) {
          expect(grid.wanted(grid.idAt(ix, iy), depth)).toEqual(
            expectedWanted(grid, ix, iy, depth),
          );
        }
      }
    }
  });

  it('defaults depth to wantedDepth', () => {
    expect(sandbox({ wantedDepth: 2 }).wanted('cell/5_5')).toHaveLength(25);
    expect(sandbox({ wantedDepth: 0 }).wanted('cell/5_5')).toEqual(['cell/5_5']);
    expect(sandbox().wanted('cell/5_5', 0)).toEqual(['cell/5_5']);
  });

  it('lists every cell once when depth exceeds the grid', () => {
    const grid = new GridWorld({ cellSize: 1, cols: 4, rows: 3, worldSeed: 3 });
    const wanted = grid.wanted('cell/1_1', 1000);
    expect(wanted).toHaveLength(12);
    expect(new Set(wanted).size).toBe(12);
    expect(wanted[0]).toBe('cell/1_1');
  });

  it('throws RangeError for a depth that is not an integer >= 0', () => {
    const grid = sandbox();
    for (const depth of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => grid.wanted('cell/5_5', depth), String(depth)).toThrow(RangeError);
    }
  });

  it('returns [] for ids that are not cells of the grid', () => {
    const grid = sandbox();
    for (const id of ['cell/99_0', 'tile/1_1', 'bogus']) {
      expect(grid.wanted(id)).toEqual([]);
      expect(grid.neighbors(id)).toEqual([]);
    }
  });

  it('neighbors (and RegionDef.neighbors) are wanted(id, 1) without self', () => {
    const grid = sandbox({ wantedDepth: 3 });
    for (let iy = 0; iy < grid.rows; iy++) {
      for (let ix = 0; ix < grid.cols; ix++) {
        const id = grid.idAt(ix, iy);
        const expected = grid.wanted(id, 1).slice(1);
        expect(grid.neighbors(id)).toEqual(expected);
        expect(grid.get(id)?.neighbors).toEqual(expected);
      }
    }
  });

  it('neighbors returns a copy', () => {
    const grid = sandbox();
    grid.neighbors('cell/1_1').push('cell/9_9');
    expect(grid.neighbors('cell/1_1')).toHaveLength(8);
    expect(grid.get('cell/1_1')?.neighbors).toHaveLength(8);
  });
});

describe('GridWorld assets and data', () => {
  it('fills assets and data from assetsFor and dataFor', () => {
    const grid = sandbox({
      assetsFor: (ix, iy) => [`rock_${ix}`, `tree_${iy}`],
      dataFor: (ix, iy) => (ix === 0 ? undefined : { biome: iy }),
    });
    expect(grid.get('cell/2_3')?.assets).toEqual(['rock_2', 'tree_3']);
    expect(grid.get('cell/2_3')?.data).toEqual({ biome: 3 });
    const noData = grid.get('cell/0_3') as RegionDef;
    expect('data' in noData).toBe(false);
  });

  it('gives each def its own assets array', () => {
    const shared = ['crate'];
    const grid = sandbox({ assetsFor: () => shared });
    const a = grid.get('cell/0_0');
    shared.push('barrel');
    expect(a?.assets).toEqual(['crate']);
    expect(grid.get('cell/1_0')?.assets).toEqual(['crate', 'barrel']);
  });
});

describe('GridWorld toJson / fromJson', () => {
  it('lists every cell in row-major order with the grid parameters', () => {
    const grid = sandbox();
    const json = grid.toJson();
    expect(json.version).toBe(1);
    expect(json.kind).toBe('grid');
    expect(json.grid).toStrictEqual({
      cellSize: CELL,
      cols: 16,
      rows: 16,
      plane: 'xz',
      kind: 'cell',
      wantedDepth: 1,
      base: { x: 0, y: 0, z: 0 },
      worldSeed: 42,
    });
    expect(json.regions).toHaveLength(256);
    json.regions.forEach((def, i) => {
      expect(def.id).toBe(grid.idAt(i % 16, Math.floor(i / 16)));
      expect(def).toStrictEqual(grid.get(def.id));
    });
    expect(() => validateGraphJson(json)).not.toThrow();
  });

  it('is plain JSON and independent of the graph', () => {
    const grid = sandbox({ assetsFor: () => ['crate'], dataFor: (ix) => ({ ix }) });
    grid.get('cell/0_0'); // cached before toJson, so the JSON is built from the cached def
    const json = grid.toJson();
    expect(reparse(json)).toStrictEqual(json);
    const first = json.regions[0] as RegionDef;
    first.neighbors.push('cell/9_9');
    first.assets.push('barrel');
    first.bounds.origin.x = 99;
    expect(grid.get('cell/0_0')?.neighbors).toHaveLength(3);
    expect(grid.get('cell/0_0')?.assets).toEqual(['crate']);
    expect(grid.get('cell/0_0')?.bounds.origin.x).toBe(0);
  });

  it('includes data only when JSON.stringify succeeds on it', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const data: unknown[] = [{ a: 1 }, 10n, circular, () => 1, null, { nested: [1, 'x'] }];
    const grid = new GridWorld({
      cellSize: 1,
      cols: data.length,
      rows: 2,
      worldSeed: 5,
      dataFor: (ix, iy) => (iy === 0 ? data[ix] : undefined),
    });
    const regions = grid.toJson().regions;
    expect(regions[0]?.data).toEqual({ a: 1 });
    expect(regions[1]).not.toHaveProperty('data');
    expect(regions[2]).not.toHaveProperty('data');
    expect(regions[3]).not.toHaveProperty('data');
    expect(regions[4]).toHaveProperty('data', null);
    expect(regions[5]?.data).toEqual({ nested: [1, 'x'] });
    expect(regions[6]).not.toHaveProperty('data');
  });

  it('round-trips with identical locate and wanted for 1000 random points', () => {
    const grids: GridWorld[] = [
      sandbox(),
      new GridWorld({
        cellSize: 50,
        cols: 9,
        rows: 6,
        plane: 'xy',
        kind: 'chunk',
        wantedDepth: 2,
        worldSeed: 0xdeadbeef,
        originOf: (ix, iy) => ({ x: -1000 + ix * 50, y: 400 + iy * 50, z: -7 }),
        assetsFor: (ix, iy) => (ix === iy ? ['tower'] : []),
        dataFor: (ix, iy) => (ix % 2 === 0 ? { height: ix + iy } : undefined),
      }),
      // One column wide: the constructor's probe of cell (1, 1) is outside the stored regions.
      new GridWorld({
        cellSize: 0.25,
        cols: 1,
        rows: 12,
        worldSeed: 7,
        originOf: (ix, iy) => at(3 + ix / 4, iy / 4),
      }),
    ];
    const rng = new Rng(2024);
    for (const grid of grids) {
      const json = grid.toJson();
      const copy = fromJson(reparse(json));
      expect(copy).toBeInstanceOf(GridWorld);
      expect(GridWorld.fromJson(json).toJson()).toStrictEqual(json);
      expect(copy.toJson()).toStrictEqual(json);
      expect(copy.wantedDepth).toBe(grid.wantedDepth);

      const base = json.grid?.base as Vec3;
      const width = grid.cols * grid.cellSize;
      const height = grid.rows * grid.cellSize;
      const xz = grid.plane === 'xz';
      for (let i = 0; i < 1000; i++) {
        const a = base.x + (rng.float() * 1.2 - 0.1) * width;
        const b = (xz ? base.z : base.y) + (rng.float() * 1.2 - 0.1) * height;
        const third = (rng.float() - 0.5) * 1e4;
        const p = xz ? { x: a, y: third, z: b } : { x: a, y: b, z: third };
        const hint = rng.chance(0.5)
          ? grid.idAt(rng.int(0, grid.cols - 1), rng.int(0, grid.rows - 1))
          : undefined;
        const located = grid.locate(p, hint);
        expect(copy.locate(p, hint)).toBe(located);
        expect(copy.locate(p)).toBe(grid.locate(p));
        if (located !== null) {
          expect(copy.wanted(located)).toEqual(grid.wanted(located));
          expect(copy.wanted(located, 3)).toEqual(grid.wanted(located, 3));
          expect(copy.neighbors(located)).toEqual(grid.neighbors(located));
          expect(copy.get(located)).toStrictEqual(json.regions.find((d) => d.id === located));
        }
      }
    }
  });

  it('fromJson validates version, ids, neighbours and kind', () => {
    const json = (): WorldGraphJson => sandbox().toJson();

    const version = { ...json(), version: 2 } as unknown as WorldGraphJson;
    expect(() => fromJson(version)).toThrow(WorldGraphError);
    expect(() => GridWorld.fromJson(version)).toThrow(WorldGraphError);

    const duplicate = json();
    duplicate.regions.push({ ...(duplicate.regions[0] as RegionDef) });
    expect(() => validateGraphJson(duplicate)).toThrow(/duplicate/);
    expect(() => fromJson(duplicate)).toThrow(WorldGraphError);
    expect(() => GridWorld.fromJson(duplicate)).toThrow(WorldGraphError);

    const neighbour = json();
    neighbour.regions[5]?.neighbors.push('cell/99_99');
    expect(() => validateGraphJson(neighbour)).toThrow(/neighbour/);
    expect(() => fromJson(neighbour)).toThrow(WorldGraphError);

    const unknownKind = { ...json(), kind: 'hex' } as unknown as WorldGraphJson;
    expect(() => fromJson(unknownKind)).toThrow(WorldGraphError);

    const node: WorldGraphJson = {
      version: 1,
      kind: 'node',
      regions: [
        {
          id: 'sol',
          kind: 'system',
          bounds: { kind: 'node', origin: { x: 0, y: 0, z: 0 } },
          neighbors: [],
          assets: [],
          seed: 1,
        },
      ],
    };
    expect(() => validateGraphJson(node)).not.toThrow();
    expect(fromJson(node)).toBeInstanceOf(NodeWorld); // dispatched on kind
    expect(() => GridWorld.fromJson(node)).toThrow(WorldGraphError);
  });

  it('GridWorld.fromJson rejects regions that do not match the grid', () => {
    const tamper = (edit: (json: WorldGraphJson) => void): (() => GridWorld) => {
      const json = sandbox().toJson();
      edit(json);
      return () => GridWorld.fromJson(json);
    };
    const def = (json: WorldGraphJson, i: number): RegionDef => json.regions[i] as RegionDef;
    const grid = (json: WorldGraphJson): { cellSize: number; base: Vec3 } =>
      json.grid as { cellSize: number; base: Vec3 };
    const cases: [string, (json: WorldGraphJson) => void][] = [
      ['missing region', (json) => json.regions.splice(40, 1)],
      ['foreign id', (json) => (def(json, 255).id = 'cell/16_15')],
      ['seed', (json) => (def(json, 17).seed ^= 1)],
      ['neighbour order', (json) => def(json, 17).neighbors.reverse()],
      ['bounds extent', (json) => ((def(json, 17).bounds as { max: Vec3 }).max.x = 1)],
      ['bounds kind', (json) => (def(json, 3).bounds = { kind: 'node', origin: at(768, 0) })],
      ['kind', (json) => (def(json, 3).kind = 'tile')],
      // index 17 is cell (1, 1), which the constructor's grid-consistency check probes
      ['origin of cell 1_1', (json) => (def(json, 17).bounds.origin.x += 1)],
      ['base', (json) => (grid(json).base.y = 1)],
      ['cellSize', (json) => (grid(json).cellSize = 128)],
      ['grid section', (json) => delete json.grid],
    ];
    for (const [label, edit] of cases) {
      expect(tamper(edit), label).toThrow(WorldGraphError);
    }
    expect(tamper(() => undefined)).not.toThrow();
  });
});
