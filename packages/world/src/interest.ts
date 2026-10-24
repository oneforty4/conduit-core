import type { EntityId } from '@conduit/protocol';
import { intersectSorted } from './sorted.ts';
import type { RegionId, WorldGraph } from './types.ts';

/**
 * Region membership as `InterestPolicy` reads it: the `regionOf`/`entitiesIn` subset of
 * `RegionManager` (docs/world.md §5). `RegionManager` and `SimContext.regions` satisfy it
 * structurally.
 */
export interface RegionMembership {
  /** `Region.id` of `e`, or `undefined` when it has none (not placed yet). */
  regionOf(e: EntityId): RegionId | undefined;
  /** Entities in region `id`, ascending; `[]` when the region is not active. */
  entitiesIn(id: RegionId): readonly EntityId[];
}

/** One client's region view, as passed to `InterestPolicy.visible`. */
export interface InterestClient {
  /** The client's player entity: whose view this is (`visible` does not filter by it). */
  player: EntityId;
  /** Regions the server wants the client to have; ascending (`stringCompare`), no duplicates. */
  wanted: readonly RegionId[];
  /** Regions the client reports loaded (`RegionLoadState`); ascending, no duplicates. */
  reported: readonly RegionId[];
}

/**
 * Which regions a client loads and which entities its region view covers (docs/world.md §9).
 * Per-entity relevance is not part of it: the Session applies its `relevance` hook while building
 * each snapshot from `wanted ∩ reported` (docs/net.md A.8).
 */
export class InterestPolicy {
  private readonly graph: WorldGraph;
  private readonly regions: RegionMembership;

  constructor(opts: { graph: WorldGraph; regions: RegionMembership }) {
    this.graph = opts.graph;
    this.regions = opts.regions;
  }

  /** Regions a client in region `r` must load: `graph.wanted(r)` (self first, graph order). */
  wantedForRegion(r: RegionId): RegionId[] {
    return this.graph.wanted(r);
  }

  /**
   * The ring just outside `wantedForRegion(r)`: `graph.wanted(r, graph.wantedDepth + 1)` without
   * the regions of `wantedForRegion(r)`, in graph order.
   */
  prefetchForRegion(r: RegionId): RegionId[] {
    const wanted = this.graph.wanted(r);
    return this.graph.wanted(r, this.graph.wantedDepth + 1).filter((id) => !wanted.includes(id));
  }

  /** `wantedForRegion` of the player's region; `[]` while the player is not placed. */
  wantedFor(playerEntity: EntityId): RegionId[] {
    const r = this.regions.regionOf(playerEntity);
    return r === undefined ? [] : this.wantedForRegion(r);
  }

  /** `prefetchForRegion` of the player's region; `[]` while the player is not placed. */
  prefetchFor(playerEntity: EntityId): RegionId[] {
    const r = this.regions.regionOf(playerEntity);
    return r === undefined ? [] : this.prefetchForRegion(r);
  }

  /**
   * Clears `out`, fills it with the entities of the regions in both `client.wanted` and
   * `client.reported`, in ascending id order, and returns it.
   */
  visible(client: InterestClient, out: EntityId[]): EntityId[] {
    out.length = 0;
    for (const id of intersectSorted(client.wanted, client.reported)) {
      for (const e of this.regions.entitiesIn(id)) out.push(e);
    }
    // Regions are disjoint and each list is ascending: sorting merges the runs into id order.
    return out.sort((a, b) => a - b);
  }
}
