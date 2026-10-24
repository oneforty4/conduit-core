import { v3, type Vec3 } from '@conduit/math';
import {
  Region,
  Transform,
  type EntityId,
  type SimContext,
  type SpatialApi,
  type World,
} from '@conduit/sim';
import { rebase } from './coords.ts';
import { RegionNotActive, type RegionManager } from './regionManager.ts';
import { insertSorted } from './sorted.ts';
import { SpatialGrid } from './spatialGrid.ts';
import type { RegionDef, RegionId, WorldGraph } from './types.ts';

/** Cell size of the grid of a `node` region, in metres. */
export const DEFAULT_NODE_CELL = 64;

export interface SpatialIndexOpts {
  regions: RegionManager;
  world: World;
  graph: WorldGraph;
  /**
   * Grid cell size of a region; finite and > 0. Default: `(max.x - min.x) / 8` for bounded regions
   * (32 m for 256 m cells), `DEFAULT_NODE_CELL` for `node` regions.
   */
  cellSizeFor?: (def: RegionDef) => number;
}

function defaultCellSize(def: RegionDef): number {
  const b = def.bounds;
  return b.kind === 'node' ? DEFAULT_NODE_CELL : (b.max.x - b.min.x) / 8;
}

/**
 * Per-region `SpatialGrid`s over region-local `Transform.pos` (docs/world.md §8.2), rebuilt every
 * tick by `rebuild`, the second entry of `Simulation.tail`. A grid projects onto its region's plane:
 * the `aabb2` plane, `'xz'` for `aabb3` and `node` regions. Queries see positions as of the last
 * rebuild and return ids ascending within each region. Satisfies sim's `SpatialApi`.
 */
export class SpatialIndex implements SpatialApi {
  private readonly regions: RegionManager;
  private readonly world: World;
  private readonly graph: WorldGraph;
  private readonly cellSizeFor: (def: RegionDef) => number;
  /** Grids by region id. Lookup only. */
  private readonly grids = new Map<RegionId, SpatialGrid>();
  /** Ids with a grid, ascending. */
  private gridIds: RegionId[] = [];
  /** Per-call scratch. */
  private readonly entities: EntityId[] = [];
  private readonly dying = new Set<EntityId>(); // lookup only
  private readonly local: Vec3 = v3.create();

  constructor(opts: SpatialIndexOpts) {
    this.regions = opts.regions;
    this.world = opts.world;
    this.graph = opts.graph;
    this.cellSizeFor = opts.cellSizeFor ?? defaultCellSize;
  }

  /**
   * Refills the grid of every active region from the entities with `Transform` and `Region` in that
   * region, in ascending slot order, skipping entities destroyed this tick (they are gone once the
   * step applies destroys). Grids of regions no longer active are dropped.
   */
  rebuild(_ctx: SimContext): void {
    const { regions, grids, world } = this;
    const kept: RegionId[] = [];
    for (const id of this.gridIds) {
      if (regions.state(id) === 'active') kept.push(id);
      else grids.delete(id);
    }
    this.gridIds = kept;
    for (const id of regions.active()) this.grid(id).clear();

    const dying = this.dying;
    dying.clear();
    for (const e of world.destroyedThisTick()) dying.add(e);
    const regionStore = world.store(Region);
    const transformStore = world.store(Transform);
    const entities = world.queryInto(this.entities, Transform, Region);
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i] as EntityId;
      if (dying.has(e)) continue;
      // After the loops above, exactly the active regions have grids.
      const grid = grids.get(regionStore.read(e).id);
      if (grid !== undefined) grid.insert(e, transformStore.read(e).pos);
    }
    entities.length = 0;
  }

  /** The grid of an active region (empty until the next rebuild if it just activated). */
  region(id: RegionId): SpatialGrid {
    if (this.regions.state(id) !== 'active') throw new RegionNotActive(id);
    return this.grid(id);
  }

  /** `region(regionId).queryRadius(pos, r, out)`. Throws `RegionNotActive`. */
  queryRadius(regionId: RegionId, pos: Vec3, r: number, out: EntityId[]): EntityId[] {
    return this.region(regionId).queryRadius(pos, r, out);
  }

  /** `region(regionId).queryAABB(min, max, out)`. Throws `RegionNotActive`. */
  queryAABB(regionId: RegionId, min: Vec3, max: Vec3, out: EntityId[]): EntityId[] {
    return this.region(regionId).queryAABB(min, max, out);
  }

  /**
   * `queryRadius` in `regionId` (local `pos`), then in each active neighbour in graph order with
   * `pos` rebased onto the neighbour's origin. Ids are appended per region, each run ascending, and
   * are local to the region they were found in; when `outRegions` is given it gets that region's id
   * once per id appended to `out`. A `node` region has no borders: only it is searched.
   */
  queryRadiusAcross(
    regionId: RegionId,
    pos: Vec3,
    r: number,
    out: EntityId[],
    outRegions?: RegionId[],
  ): EntityId[] {
    const n0 = out.length;
    this.region(regionId).queryRadius(pos, r, out);
    if (outRegions !== undefined) for (let i = n0; i < out.length; i++) outRegions.push(regionId);
    const def = this.graph.get(regionId);
    if (def === undefined || def.bounds.kind === 'node') return out;
    for (const nid of def.neighbors) {
      if (this.regions.state(nid) !== 'active') continue;
      const ndef = this.graph.get(nid);
      if (ndef === undefined || ndef.bounds.kind === 'node') continue;
      const n = out.length;
      this.grid(nid).queryRadius(rebase(def, ndef, pos, this.local), r, out);
      if (outRegions !== undefined) for (let i = n; i < out.length; i++) outRegions.push(nid);
    }
    return out;
  }

  /** `region(regionId).nearest(pos, maxR, exclude)`. Throws `RegionNotActive`. */
  nearest(regionId: RegionId, pos: Vec3, maxR: number, exclude?: EntityId): EntityId | undefined {
    return this.region(regionId).nearest(pos, maxR, exclude);
  }

  /** The grid of `id`, created on first use. `id` must be a region of the graph. */
  private grid(id: RegionId): SpatialGrid {
    let grid = this.grids.get(id);
    if (grid === undefined) {
      const def = this.graph.get(id);
      if (def === undefined) throw new RegionNotActive(id);
      grid = new SpatialGrid(
        this.cellSizeFor(def),
        def.bounds.kind === 'aabb2' ? def.bounds.plane : 'xz',
      );
      this.grids.set(id, grid);
      insertSorted(this.gridIds, id);
    }
    return grid;
  }
}
