import type { Vec2, Vec3 } from '@conduit/math';

/** Region identifier. `GridWorld` ids are `${kind}/${ix}_${iy}` (docs/world.md §2). */
export type RegionId = string;

/** Manifest asset id (docs/assets.md). */
export type AssetId = string;

/**
 * Extent of a region (docs/world.md §1). `origin` is world space; `min`/`max` are region-local
 * (relative to `origin`). For `aabb2`, `Vec2.x` is world `x` and `Vec2.y` is world `z` on plane
 * `'xz'` or world `y` on plane `'xy'`; the third axis is unbounded. Containment is half-open:
 * `min <= p < max` on each bounded axis. `node` regions have no extent.
 */
export type RegionBounds =
  | { kind: 'aabb2'; origin: Vec3; min: Vec2; max: Vec2; plane: 'xz' | 'xy' }
  | { kind: 'aabb3'; origin: Vec3; min: Vec3; max: Vec3 }
  | { kind: 'node'; origin: Vec3 };

export interface RegionDef {
  id: RegionId;
  kind: string;
  bounds: RegionBounds;
  /** Deterministic graph order: `GridWorld` ascending `(iy, ix)`, `NodeWorld` ascending by id. */
  neighbors: RegionId[];
  assets: AssetId[];
  /** u32 seed of the region's `Rng`. */
  seed: number;
  /** Game-defined; must be JSON-serializable to reach the client or the graph JSON. */
  data?: unknown;
}

/** Static region graph. Implementations never change after construction. */
export interface WorldGraph {
  /** Default `depth` of `wanted` (`GridWorld`: `opts.wantedDepth`; `NodeWorld`: 1). */
  readonly wantedDepth: number;
  /** The region's definition, or `undefined` for an unknown id. */
  get(id: RegionId): RegionDef | undefined;
  /** Neighbour ids in graph order; `[]` for an unknown id. */
  neighbors(id: RegionId): RegionId[];
  /** Region containing world position `worldPos`, or `null` outside the world. */
  locate(worldPos: Vec3, hint?: RegionId): RegionId | null;
  /** Regions to keep active around `id`: self first, then a deterministic order. */
  wanted(id: RegionId, depth?: number): RegionId[];
  toJson(): WorldGraphJson;
}

/**
 * Static JSON form of a graph (docs/world.md §1): used by tooling (`conduit-assets build --graph`)
 * and tests. It never crosses the wire.
 */
export interface WorldGraphJson {
  version: 1;
  kind: 'grid' | 'node';
  grid?: {
    cellSize: number;
    cols: number;
    rows: number;
    plane: 'xz' | 'xy';
    kind: string;
    wantedDepth: number;
    base: Vec3;
    worldSeed: number;
  };
  /** Every region; `data` only when it serializes to JSON. */
  regions: RegionDef[];
}

/** Thrown for an invalid graph definition or graph JSON. */
export class WorldGraphError extends Error {
  override readonly name = 'WorldGraphError';

  constructor(message: string) {
    super(message);
  }
}

/**
 * Structural subset of `BlobStore` (docs/persist.md 1.2) that region persistence needs; every
 * `BlobStore` satisfies it, so this package does not import `@conduit/persist`.
 */
export interface RegionStore {
  get(ns: string, key: string): Promise<Uint8Array | null>;
  put(ns: string, key: string, blob: Uint8Array): Promise<void>;
  transaction<T>(fn: (tx: RegionStore) => T | Promise<T>): Promise<T>;
}
