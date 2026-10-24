import type { DeepReadonly } from './readonly.ts';
import type { Rng, Vec3 } from '@conduit/math';
import type { InputFrameBase } from '@conduit/protocol';
import type { EntityId } from './entity.ts';
import type { EventBus } from './events.ts';
import type { World } from './world.ts';

/** Region id; the same alias `@conduit/world` exports. */
export type RegionId = string;

/** An input frame: the schema from protocol's `defineInput`, whose first field is `tick: f.u32`. */
export type InputFrame = InputFrameBase;

/**
 * The part of `@conduit/world`'s `RegionDef` the sim sees. Every `RegionBounds` variant has a
 * `kind` and a region `origin`; narrow with `@conduit/world`'s types for the extent.
 */
export interface RegionDefLike {
  readonly id: RegionId;
  readonly kind: string;
  readonly bounds: { readonly kind: string; readonly origin: Vec3 };
  readonly seed: number;
  readonly data?: unknown;
}

/** Implemented structurally by `@conduit/world`'s `RegionManager` (docs/world.md 5). */
export interface RegionsApi {
  regionOf(e: EntityId): RegionId | undefined;
  /** Ascending id order. */
  entitiesIn(id: RegionId): readonly EntityId[];
  /** Sorted. */
  active(): readonly RegionId[];
  def(id: RegionId): RegionDefLike | undefined;
  /** A `MigrateResult` (docs/world.md 6.2). */
  migrate(e: EntityId, to: RegionId, newLocalPos?: Vec3): string;
}

/** Implemented structurally by `@conduit/world`'s `SpatialIndex` (docs/world.md 8.2). */
export interface SpatialApi {
  queryRadius(regionId: RegionId, pos: Vec3, r: number, out: EntityId[]): EntityId[];
  queryAABB(regionId: RegionId, min: Vec3, max: Vec3, out: EntityId[]): EntityId[];
  queryRadiusAcross(
    regionId: RegionId,
    pos: Vec3,
    r: number,
    out: EntityId[],
    outRegions?: RegionId[],
  ): EntityId[];
  nearest(regionId: RegionId, pos: Vec3, maxR: number, exclude?: EntityId): EntityId | undefined;
}

/** What systems (and the Session's hooks) see each tick. */
export interface SimContext {
  readonly world: World;
  readonly tick: number;
  /** `1 / tickRate` seconds. */
  readonly dt: number;
  /** World stream, seeded from `game.seed`. */
  readonly rng: Rng;
  /** Per-region stream (docs/world.md 7). */
  regionRng(id: RegionId): Rng;
  readonly regions: RegionsApi;
  readonly spatial: SpatialApi;
  readonly events: EventBus;
  inputs(player: number): DeepReadonly<InputFrame> | undefined;
}
