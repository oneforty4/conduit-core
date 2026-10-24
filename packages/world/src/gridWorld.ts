import { fnv1a32, type Vec3 } from '@conduit/math';
import {
  WorldGraphError,
  type AssetId,
  type RegionBounds,
  type RegionDef,
  type RegionId,
  type WorldGraph,
  type WorldGraphJson,
} from './types.ts';

/** Default `GridWorldOpts.wantedDepth`: the 3 x 3 block of cells around a cell. */
export const DEFAULT_WANTED_DEPTH = 1;

export interface GridWorldOpts {
  /** Cell edge length in metres; finite and > 0. */
  cellSize: number;
  /** Grid width in cells; an integer >= 1. */
  cols: number;
  /** Grid height in cells; an integer >= 1. */
  rows: number;
  /** Default `'xz'`. */
  plane?: 'xz' | 'xy';
  /** `RegionDef.kind` and id prefix; non-empty; default `'cell'`. */
  kind?: string;
  /**
   * World origin of cell `(ix, iy)`; must be grid-consistent. Default: `(ix, iy) * cellSize` on the
   * plane axes and `0` on the third.
   */
  originOf?: (ix: number, iy: number) => Vec3;
  /** Default `() => []`. */
  assetsFor?: (ix: number, iy: number) => AssetId[];
  /** Default: no `data`. */
  dataFor?: (ix: number, iy: number) => unknown;
  /** Default `depth` of `wanted`; an integer >= 0; default `DEFAULT_WANTED_DEPTH`. */
  wantedDepth?: number;
  /** u32. Region seeds are `fnv1a32(id, worldSeed)`. */
  worldSeed: number;
}

type CellFn<T> = (ix: number, iy: number) => T;

/**
 * A `cols` x `rows` grid of square `aabb2` cells (docs/world.md §2): sea cells, terrain chunks.
 * Region ids are `${kind}/${ix}_${iy}`. Defs are built on first use and cached; callers must not
 * mutate them.
 */
export class GridWorld implements WorldGraph {
  readonly cellSize: number;
  readonly cols: number;
  readonly rows: number;
  readonly plane: 'xz' | 'xy';
  readonly wantedDepth: number;
  private readonly kind: string;
  private readonly worldSeed: number;
  /** `${kind}/`. */
  private readonly prefix: string;
  /** `originOf(0, 0)`; `locate` relies on it. */
  private readonly base: Vec3;
  private readonly originOf: CellFn<Vec3>;
  private readonly assetsFor: CellFn<AssetId[]> | undefined;
  private readonly dataFor: CellFn<unknown> | undefined;
  /** Built defs by id. Lookup only; never iterated. */
  private readonly defs = new Map<RegionId, RegionDef>();

  /** Throws `WorldGraphError` for invalid options or an `originOf` that is not grid-consistent. */
  constructor(opts: GridWorldOpts) {
    const { cellSize, cols, rows, worldSeed } = opts;
    const plane = opts.plane ?? 'xz';
    const kind = opts.kind ?? 'cell';
    const wantedDepth = opts.wantedDepth ?? DEFAULT_WANTED_DEPTH;
    if (!(Number.isFinite(cellSize) && cellSize > 0)) {
      invalid(`cellSize must be finite and > 0, got ${cellSize}`);
    }
    if (!isCount(cols)) invalid(`cols must be an integer >= 1, got ${cols}`);
    if (!isCount(rows)) invalid(`rows must be an integer >= 1, got ${rows}`);
    if (plane !== 'xz' && plane !== 'xy') {
      invalid(`plane must be 'xz' or 'xy', got ${String(plane)}`);
    }
    if (typeof kind !== 'string' || kind === '') invalid('kind must be a non-empty string');
    if (!Number.isSafeInteger(wantedDepth) || wantedDepth < 0) {
      invalid(`wantedDepth must be an integer >= 0, got ${wantedDepth}`);
    }
    if (!Number.isInteger(worldSeed) || worldSeed < 0 || worldSeed > 0xffffffff) {
      invalid(`worldSeed must be a u32, got ${worldSeed}`);
    }

    const originOf = opts.originOf ?? ((ix, iy) => linearOrigin(ZERO, cellSize, plane, ix, iy));
    // Copied before the second call, in case originOf returns a reused object.
    const first = originOf(0, 0);
    const o00: Vec3 = { x: first.x, y: first.y, z: first.z };
    const o11 = originOf(1, 1);
    const dx = o11.x - o00.x;
    const dy = o11.y - o00.y;
    const dz = o11.z - o00.z;
    const consistent =
      plane === 'xz'
        ? dx === cellSize && dz === cellSize && dy === 0
        : dx === cellSize && dy === cellSize && dz === 0;
    if (!consistent) {
      const expected =
        plane === 'xz' ? `(${cellSize}, 0, ${cellSize})` : `(${cellSize}, ${cellSize}, 0)`;
      invalid(
        `originOf is not grid-consistent: originOf(1,1) - originOf(0,0) is (${dx}, ${dy}, ${dz}), expected ${expected}`,
      );
    }

    this.cellSize = cellSize;
    this.cols = cols;
    this.rows = rows;
    this.plane = plane;
    this.wantedDepth = wantedDepth;
    this.kind = kind;
    this.worldSeed = worldSeed;
    this.prefix = `${kind}/`;
    this.base = o00;
    this.originOf = originOf;
    this.assetsFor = opts.assetsFor;
    this.dataFor = opts.dataFor;
  }

  /**
   * Rebuilds a grid from `toJson` output: parameters from `grid`; origins, `assets` and `data` from
   * the stored defs, so the constructor's grid-consistency check runs on the stored origins and
   * `grid.base` must be the origin of cell `(0, 0)`. Throws `WorldGraphError` unless `regions` are
   * exactly the grid's `cols * rows` cells with the `kind`, bounds extent, `neighbors` and `seed`
   * the grid derives.
   */
  static fromJson(json: WorldGraphJson): GridWorld {
    if (json.version !== 1) {
      throw new WorldGraphError(`unsupported world graph version ${String(json.version)}`);
    }
    const g = json.grid;
    if (json.kind !== 'grid' || g === undefined) {
      throw new WorldGraphError(`GridWorld.fromJson needs kind 'grid' with a grid section`);
    }
    if (!Array.isArray(json.regions)) throw new WorldGraphError('regions must be an array');
    const stored = new Map<RegionId, RegionDef>(); // lookup only
    for (const def of json.regions) {
      if (stored.has(def.id)) throw new WorldGraphError(`duplicate region id '${def.id}'`);
      stored.set(def.id, def);
    }
    const cell = (ix: number, iy: number): RegionDef | undefined =>
      stored.get(`${g.kind}/${ix}_${iy}`);
    const grid = new GridWorld({
      cellSize: g.cellSize,
      cols: g.cols,
      rows: g.rows,
      plane: g.plane,
      kind: g.kind,
      wantedDepth: g.wantedDepth,
      worldSeed: g.worldSeed,
      // Stored origins are exactly what the source grid computed. A missing cell (only the
      // constructor's probe of (1, 1) on a one-cell-wide grid, if the JSON is valid) extrapolates.
      originOf: (ix, iy) =>
        cell(ix, iy)?.bounds.origin ?? linearOrigin(g.base, g.cellSize, g.plane, ix, iy),
      assetsFor: (ix, iy) => cell(ix, iy)?.assets ?? [],
      dataFor: (ix, iy) => cell(ix, iy)?.data,
    });

    const base = grid.base;
    if (base.x !== g.base.x || base.y !== g.base.y || base.z !== g.base.z) {
      throw new WorldGraphError(`grid.base is not the origin of region '${grid.idAt(0, 0)}'`);
    }
    const count = g.cols * g.rows;
    if (json.regions.length !== count) {
      throw new WorldGraphError(
        `a ${g.cols} x ${g.rows} grid has ${count} regions, got ${json.regions.length}`,
      );
    }
    for (const def of json.regions) {
      const derived = grid.get(def.id);
      if (derived === undefined) {
        throw new WorldGraphError(`region '${def.id}' is not a cell of the grid`);
      }
      if (!sameGridDef(def, derived)) {
        throw new WorldGraphError(
          `region '${def.id}' does not match the grid (kind, bounds, neighbors or seed)`,
        );
      }
    }
    return grid;
  }

  /**
   * Cell of a region id of the form `${kind}/${ix}_${iy}`, with `ix`/`iy` in canonical decimal (no
   * sign or leading zeros) and inside the grid; `undefined` otherwise.
   */
  indexOf(id: RegionId): { ix: number; iy: number } | undefined {
    if (!id.startsWith(this.prefix)) return undefined;
    const start = this.prefix.length;
    const sep = id.indexOf('_', start);
    if (sep < 0) return undefined;
    const ix = parseIndex(id, start, sep);
    const iy = parseIndex(id, sep + 1, id.length);
    if (ix < 0 || iy < 0 || ix >= this.cols || iy >= this.rows) return undefined;
    return { ix, iy };
  }

  /** `${kind}/${ix}_${iy}`. Formats only: no range check. */
  idAt(ix: number, iy: number): RegionId {
    return `${this.kind}/${ix}_${iy}`;
  }

  get(id: RegionId): RegionDef | undefined {
    const cached = this.defs.get(id);
    if (cached !== undefined) return cached;
    const idx = this.indexOf(id);
    if (idx === undefined) return undefined;
    const def = this.build(id, idx.ix, idx.iy);
    this.defs.set(id, def);
    return def;
  }

  /** `wanted(id, 1)` without its first element: the clipped 8-neighbourhood, ascending `(iy, ix)`. */
  neighbors(id: RegionId): RegionId[] {
    const def = this.get(id);
    return def === undefined ? [] : def.neighbors.slice();
  }

  /**
   * Cell containing `worldPos` (floor division from `base`; a coordinate of exactly `cellSize`
   * belongs to the next cell), or `null` outside the grid. When `worldPos` lies inside `hint`, `hint`
   * is returned without dividing.
   */
  locate(worldPos: Vec3, hint?: RegionId): RegionId | null {
    const xz = this.plane === 'xz';
    const size = this.cellSize;
    const pa = worldPos.x;
    const pb = xz ? worldPos.z : worldPos.y;
    if (hint !== undefined) {
      const def = this.get(hint);
      if (def !== undefined) {
        const o = def.bounds.origin;
        const oa = o.x;
        const ob = xz ? o.z : o.y;
        if (oa <= pa && pa < oa + size && ob <= pb && pb < ob + size) return hint;
      }
    }
    const ix = Math.floor((pa - this.base.x) / size);
    const iy = Math.floor((pb - (xz ? this.base.z : this.base.y)) / size);
    // Negated so that NaN coordinates are rejected too.
    if (!(ix >= 0 && ix < this.cols && iy >= 0 && iy < this.rows)) return null;
    return this.idAt(ix, iy);
  }

  /**
   * `id` first, then every other cell within Chebyshev distance `depth`, clipped to the grid, in
   * row-major order (ascending `iy`, then `ix`). `[]` for an id that is not a cell of this grid.
   * Throws `RangeError` unless `depth` is an integer >= 0.
   */
  wanted(id: RegionId, depth: number = this.wantedDepth): RegionId[] {
    if (!Number.isSafeInteger(depth) || depth < 0) {
      throw new RangeError(`GridWorld.wanted: depth must be an integer >= 0, got ${depth}`);
    }
    const idx = this.indexOf(id);
    if (idx === undefined) return [];
    const { ix, iy } = idx;
    const out: RegionId[] = [id];
    const x1 = Math.min(this.cols - 1, ix + depth);
    const y1 = Math.min(this.rows - 1, iy + depth);
    for (let y = Math.max(0, iy - depth); y <= y1; y++) {
      for (let x = Math.max(0, ix - depth); x <= x1; x++) {
        if (x !== ix || y !== iy) out.push(this.idAt(x, y));
      }
    }
    return out;
  }

  /**
   * Every cell in row-major order. Returned objects are fresh copies; `data` is included as its
   * JSON round-trip, and omitted when `JSON.stringify` throws or yields nothing.
   */
  toJson(): WorldGraphJson {
    const regions: RegionDef[] = [];
    for (let iy = 0; iy < this.rows; iy++) {
      for (let ix = 0; ix < this.cols; ix++) {
        const id = this.idAt(ix, iy);
        const def = this.defs.get(id) ?? this.build(id, ix, iy);
        const out: RegionDef = {
          id,
          kind: def.kind,
          bounds: this.boundsAt(def.bounds.origin),
          neighbors: def.neighbors.slice(),
          assets: def.assets.slice(),
          seed: def.seed,
        };
        const data = jsonValue(def.data);
        if (data !== undefined) out.data = data;
        regions.push(out);
      }
    }
    const { base } = this;
    return {
      version: 1,
      kind: 'grid',
      grid: {
        cellSize: this.cellSize,
        cols: this.cols,
        rows: this.rows,
        plane: this.plane,
        kind: this.kind,
        wantedDepth: this.wantedDepth,
        base: { x: base.x, y: base.y, z: base.z },
        worldSeed: this.worldSeed,
      },
      regions,
    };
  }

  private build(id: RegionId, ix: number, iy: number): RegionDef {
    const def: RegionDef = {
      id,
      kind: this.kind,
      bounds: this.boundsAt(this.originOf(ix, iy)),
      neighbors: this.wanted(id, 1).slice(1),
      assets: this.assetsFor === undefined ? [] : this.assetsFor(ix, iy).slice(),
      seed: fnv1a32(id, this.worldSeed),
    };
    const data = this.dataFor?.(ix, iy);
    if (data !== undefined) def.data = data;
    return def;
  }

  private boundsAt(origin: Vec3): RegionBounds {
    const size = this.cellSize;
    return {
      kind: 'aabb2',
      origin: { x: origin.x, y: origin.y, z: origin.z },
      min: { x: 0, y: 0 },
      max: { x: size, y: size },
      plane: this.plane,
    };
  }
}

const ZERO: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 });

function invalid(message: string): never {
  throw new WorldGraphError(message);
}

function isCount(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 1;
}

/** Origin of cell `(ix, iy)` in a grid-consistent layout whose cell `(0, 0)` is at `base`. */
function linearOrigin(
  base: Vec3,
  cellSize: number,
  plane: 'xz' | 'xy',
  ix: number,
  iy: number,
): Vec3 {
  return plane === 'xz'
    ? { x: base.x + ix * cellSize, y: base.y, z: base.z + iy * cellSize }
    : { x: base.x + ix * cellSize, y: base.y + iy * cellSize, z: base.z };
}

/** `s[start, end)` as a canonical decimal index (digits, no leading zero), or -1. */
function parseIndex(s: string, start: number, end: number): number {
  const len = end - start;
  if (len < 1 || len > 15 || (len > 1 && s.charCodeAt(start) === 48)) return -1;
  let v = 0;
  for (let i = start; i < end; i++) {
    const d = s.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return -1;
    v = v * 10 + d;
  }
  return v;
}

/** `value` as it reads back from JSON; `undefined` when `JSON.stringify` throws or yields nothing. */
function jsonValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return undefined;
  }
  return text === undefined ? undefined : (JSON.parse(text) as unknown);
}

/**
 * Whether a stored def has the kind, bounds extent, neighbours and seed of the grid's derived def.
 * Origins are not compared: the derived def took its origin from the stored one.
 */
function sameGridDef(def: RegionDef, derived: RegionDef): boolean {
  const a = def.bounds;
  const b = derived.bounds;
  return (
    def.kind === derived.kind &&
    def.seed === derived.seed &&
    a.kind === 'aabb2' &&
    b.kind === 'aabb2' &&
    a.plane === b.plane &&
    a.min.x === b.min.x &&
    a.min.y === b.min.y &&
    a.max.x === b.max.x &&
    a.max.y === b.max.y &&
    def.neighbors.length === derived.neighbors.length &&
    def.neighbors.every((n, i) => n === derived.neighbors[i])
  );
}
