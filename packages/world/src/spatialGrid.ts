import type { Vec3 } from '@conduit/math';
import type { EntityId } from '@conduit/sim';

const INITIAL_CAPACITY = 64;

/** Cell offset that makes the 16-bit cell index of `ix` and `iy` wrap symmetrically around 0. */
const CELL_BIAS = 0x8000;

/**
 * Walks spanning more cells than this per axis would visit an aliased key twice (keys keep 16 bits
 * per axis), so such queries scan every point instead.
 */
const MAX_WALK_SPAN = 0xffff;

/** Map key of cell `(ix, iy)`: 16 bits per axis, so cells more than 32 768 apart share a key. */
function cellKey(ix: number, iy: number): number {
  return ((ix + CELL_BIAS) & 0xffff) | (((iy + CELL_BIAS) & 0xffff) << 16);
}

function ascending(a: number, b: number): number {
  return a - b;
}

/** Sorts `out[start..]` ascending in place, leaving `out[0, start)` untouched. */
function sortTail(out: EntityId[], start: number): void {
  const n = out.length - start;
  if (n < 2) return;
  if (n <= 32) {
    for (let i = start + 1; i < out.length; i++) {
      const v = out[i] as EntityId;
      let j = i - 1;
      while (j >= start && (out[j] as EntityId) > v) {
        out[j + 1] = out[j] as EntityId;
        j--;
      }
      out[j + 1] = v;
    }
    return;
  }
  const tail = out.slice(start).sort(ascending);
  for (let i = 0; i < n; i++) out[start + i] = tail[i] as EntityId;
}

/**
 * A uniform 2D grid over one region's local positions, projected onto `plane` (`(x, z)` for `'xz'`,
 * `(x, y)` for `'xy'`; the third axis is ignored), rebuilt every tick (docs/world.md §8.1). Points
 * live in dense insertion-order arrays; cells hold dense indices. Every query appends its matches to
 * `out` ascending by entity id, whatever the cell size or insertion order.
 */
export class SpatialGrid {
  readonly cellSize: number;
  readonly plane: 'xz' | 'xy';
  private ids = new Uint32Array(INITIAL_CAPACITY);
  private px = new Float64Array(INITIAL_CAPACITY);
  private py = new Float64Array(INITIAL_CAPACITY);
  private count = 0;
  /** Cell key -> dense indices. Lookup only; never iterated. */
  private readonly cells = new Map<number, number[]>();
  /** `nearest` scratch: the best candidate so far and its squared distance. */
  private bestId: EntityId | undefined = undefined;
  private bestD2 = 0;

  /** Throws `RangeError` unless `cellSize` is finite and > 0 and `plane` is `'xz'` or `'xy'`. */
  constructor(cellSize: number, plane: 'xz' | 'xy') {
    if (!(Number.isFinite(cellSize) && cellSize > 0)) {
      throw new RangeError(`SpatialGrid: cellSize must be finite and > 0, got ${cellSize}`);
    }
    if (plane !== 'xz' && plane !== 'xy') {
      throw new RangeError(`SpatialGrid: plane must be 'xz' or 'xy', got ${String(plane)}`);
    }
    this.cellSize = cellSize;
    this.plane = plane;
  }

  /** Points inserted since the last `clear`. */
  get size(): number {
    return this.count;
  }

  clear(): void {
    this.count = 0;
    this.cells.clear();
  }

  /** Adds `e` at `pos` (copied). Inserting an entity twice lists it twice. */
  insert(e: EntityId, pos: Vec3): void {
    const i = this.count;
    if (i === this.ids.length) this.grow();
    const x = pos.x;
    const y = this.plane === 'xz' ? pos.z : pos.y;
    this.ids[i] = e;
    this.px[i] = x;
    this.py[i] = y;
    this.count = i + 1;
    const key = cellKey(this.cellOf(x), this.cellOf(y));
    const list = this.cells.get(key);
    if (list === undefined) this.cells.set(key, [i]);
    else list.push(i);
  }

  /**
   * Appends every entity whose projected distance to `pos` is `<= r` to `out`, ascending by id, and
   * returns `out`. A negative or NaN `r`, or a non-finite `pos`, matches nothing.
   */
  queryRadius(pos: Vec3, r: number, out: EntityId[]): EntityId[] {
    const x = pos.x;
    const y = this.plane === 'xz' ? pos.z : pos.y;
    if (!(r >= 0 && Number.isFinite(x) && Number.isFinite(y)) || this.count === 0) return out;
    const start = out.length;
    const r2 = r * r;
    const { ids, px, py, cells } = this;
    const ix0 = this.cellOf(x - r);
    const ix1 = this.cellOf(x + r);
    const iy0 = this.cellOf(y - r);
    const iy1 = this.cellOf(y + r);
    if (this.walkable(ix0, ix1, iy0, iy1)) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const list = cells.get(cellKey(ix, iy));
          if (list === undefined) continue;
          for (let k = 0; k < list.length; k++) {
            const i = list[k] as number;
            const dx = (px[i] as number) - x;
            const dy = (py[i] as number) - y;
            if (dx * dx + dy * dy <= r2) out.push(ids[i] as EntityId);
          }
        }
      }
    } else {
      for (let i = 0; i < this.count; i++) {
        const dx = (px[i] as number) - x;
        const dy = (py[i] as number) - y;
        if (dx * dx + dy * dy <= r2) out.push(ids[i] as EntityId);
      }
    }
    sortTail(out, start);
    return out;
  }

  /**
   * Appends every entity whose projected position lies in the box `min..max` (inclusive on both
   * ends) to `out`, ascending by id, and returns `out`.
   */
  queryAABB(min: Vec3, max: Vec3, out: EntityId[]): EntityId[] {
    const ax = min.x;
    const bx = max.x;
    const ay = this.plane === 'xz' ? min.z : min.y;
    const by = this.plane === 'xz' ? max.z : max.y;
    if (!(ax <= bx && ay <= by) || this.count === 0) return out;
    const start = out.length;
    const { ids, px, py, cells } = this;
    const ix0 = this.cellOf(ax);
    const ix1 = this.cellOf(bx);
    const iy0 = this.cellOf(ay);
    const iy1 = this.cellOf(by);
    if (this.walkable(ix0, ix1, iy0, iy1)) {
      for (let iy = iy0; iy <= iy1; iy++) {
        for (let ix = ix0; ix <= ix1; ix++) {
          const list = cells.get(cellKey(ix, iy));
          if (list === undefined) continue;
          for (let k = 0; k < list.length; k++) {
            const i = list[k] as number;
            const x = px[i] as number;
            const y = py[i] as number;
            if (ax <= x && x <= bx && ay <= y && y <= by) out.push(ids[i] as EntityId);
          }
        }
      }
    } else {
      for (let i = 0; i < this.count; i++) {
        const x = px[i] as number;
        const y = py[i] as number;
        if (ax <= x && x <= bx && ay <= y && y <= by) out.push(ids[i] as EntityId);
      }
    }
    sortTail(out, start);
    return out;
  }

  /**
   * The entity closest to `pos` (projected) within `maxR`, other than `exclude`; ties go to the
   * lowest id. `undefined` when there is none. Searches rings of cells outwards from the cell of
   * `pos` and stops once a ring cannot hold anything as close as the best so far.
   */
  nearest(pos: Vec3, maxR: number, exclude?: EntityId): EntityId | undefined {
    const x = pos.x;
    const y = this.plane === 'xz' ? pos.z : pos.y;
    if (!(maxR >= 0 && Number.isFinite(x) && Number.isFinite(y)) || this.count === 0) {
      return undefined;
    }
    this.bestId = undefined;
    this.bestD2 = maxR * maxR;
    const rings = Math.ceil(maxR / this.cellSize);
    const cx = this.cellOf(x);
    const cy = this.cellOf(y);
    if (!this.walkable(cx - rings, cx + rings, cy - rings, cy + rings)) {
      for (let i = 0; i < this.count; i++) this.consider(i, x, y, exclude);
      return this.bestId;
    }
    this.considerCell(cx, cy, x, y, exclude);
    for (let k = 1; k <= rings; k++) {
      // Every point of ring k is more than (k - 1) cells from pos along some axis.
      const inner = (k - 1) * this.cellSize;
      if (this.bestId !== undefined && inner * inner > this.bestD2) break;
      for (let ix = cx - k; ix <= cx + k; ix++) {
        this.considerCell(ix, cy - k, x, y, exclude);
        this.considerCell(ix, cy + k, x, y, exclude);
      }
      for (let iy = cy - k + 1; iy <= cy + k - 1; iy++) {
        this.considerCell(cx - k, iy, x, y, exclude);
        this.considerCell(cx + k, iy, x, y, exclude);
      }
    }
    return this.bestId;
  }

  private cellOf(v: number): number {
    return Math.floor(v / this.cellSize);
  }

  /**
   * Whether walking cells `[ix0, ix1] x [iy0, iy1]` is cheaper than scanning every point: it visits
   * no more cells than there are points, and no axis spans enough cells to revisit an aliased key.
   * False for non-finite bounds.
   */
  private walkable(ix0: number, ix1: number, iy0: number, iy1: number): boolean {
    const w = ix1 - ix0 + 1;
    const h = iy1 - iy0 + 1;
    return w <= MAX_WALK_SPAN && h <= MAX_WALK_SPAN && w * h <= this.count;
  }

  private considerCell(ix: number, iy: number, x: number, y: number, exclude?: EntityId): void {
    const list = this.cells.get(cellKey(ix, iy));
    if (list === undefined) return;
    for (let k = 0; k < list.length; k++) this.consider(list[k] as number, x, y, exclude);
  }

  /** `nearest` step: keeps point `i` when it is within `maxR` and closer (or as close, lower id). */
  private consider(i: number, x: number, y: number, exclude?: EntityId): void {
    const e = this.ids[i] as EntityId;
    if (e === exclude) return;
    const dx = (this.px[i] as number) - x;
    const dy = (this.py[i] as number) - y;
    const d2 = dx * dx + dy * dy;
    if (
      d2 < this.bestD2 ||
      (d2 === this.bestD2 && (this.bestId === undefined || e < this.bestId))
    ) {
      this.bestId = e;
      this.bestD2 = d2;
    }
  }

  private grow(): void {
    const capacity = this.ids.length * 2;
    const ids = new Uint32Array(capacity);
    ids.set(this.ids);
    this.ids = ids;
    const px = new Float64Array(capacity);
    px.set(this.px);
    this.px = px;
    const py = new Float64Array(capacity);
    py.set(this.py);
    this.py = py;
  }
}
