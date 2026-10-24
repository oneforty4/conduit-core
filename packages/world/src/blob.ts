import { utf8Decode, utf8Encode, type SchemaRegistry } from '@conduit/protocol';
import { Region, type ComponentType, type EntityId, type World } from '@conduit/sim';
import type { RegionDef, RegionId } from './types.ts';

/*
 * Region blobs (docs/world.md §5.6): the saved state of a region, stored as UTF-8 JSON through a
 * `BlobStore` in namespace `region` under key `regionId`. Entity ids are never persisted.
 */

/** `BlobStore` namespace of region blobs. */
export const BLOB_NAMESPACE = 'region';

/** `RegionBlob.version`. */
export const BLOB_VERSION = 1;

/** A persisted entity: its `persist: true` components in component-id order, as plain values. */
export interface SerializedEntity {
  components: [name: string, value: unknown][];
}

/** A region's saved state. */
export interface RegionBlob {
  version: 1;
  /** `world.tick` when the blob was taken. */
  savedTick: number;
  entities: SerializedEntity[];
  /** u32 `Rng.state()` of the region's stream. */
  rngState: number;
  /** What `RegionLoader.onDeactivate` returned; JSON-serializable. */
  gameData?: unknown;
  /**
   * Set by `flushAll` on a blob it writes for a region that was never saved: `entities` are only
   * arrivals from the region's inbox. The region activates as fresh (`populate` gets `null`) and the
   * arrivals are merged like inbox items (docs/world.md §5.5).
   */
  inboxOnly?: true;
}

/** A region blob that cannot be decoded or restored. */
export class BlobError extends Error {
  override readonly name = 'BlobError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** A blob with nothing in it: `{ version: 1, savedTick: 0, entities: [], rngState: def.seed }`. */
export function emptyBlob(def: RegionDef): RegionBlob {
  return { version: 1, savedTick: 0, entities: [], rngState: def.seed >>> 0 };
}

/**
 * The `persist: true` components of `e`, in component-id order, as deep copies; `null` when `e` has
 * none (or is not alive).
 */
export function serializeEntity(world: World, e: EntityId): SerializedEntity | null {
  const stores = world.stores();
  let components: [string, unknown][] | null = null;
  for (let id = 0; id < stores.length; id++) {
    const store = stores[id];
    if (store === undefined || !store.type.persist) continue;
    const value = store.tryRead(e);
    if (value === undefined) continue;
    const type = store.type;
    (components ??= []).push([type.name, type.copy(type.create(), value)]);
  }
  return components === null ? null : { components };
}

/** The component types of one serialized entity, parallel to its `components`. */
export type ResolvedEntity = readonly ComponentType<unknown>[];

/**
 * Resolves the component types of `entities` without creating anything. Throws `BlobError` for a
 * component the registry (or this World) does not know, a component listed twice in one entity,
 * `Region` (which the region itself supplies) or a value that is not an object.
 */
export function resolveEntities(
  world: World,
  registry: SchemaRegistry,
  entities: readonly SerializedEntity[],
): ResolvedEntity[] {
  const stores = world.stores();
  const out: ResolvedEntity[] = [];
  for (const entity of entities) {
    const types: ComponentType<unknown>[] = [];
    for (const [name, value] of entity.components) {
      let id: number;
      try {
        id = registry.componentId(name);
      } catch (err) {
        throw new BlobError(`unknown component '${name}' in a region blob`, { cause: err });
      }
      const type = stores[id]?.type;
      if (type === undefined || type.name !== name) {
        throw new BlobError(`component '${name}' is not in this World's registry`);
      }
      if (name === Region.name) {
        throw new BlobError('a serialized entity cannot carry Region; its region supplies it');
      }
      if (types.includes(type)) {
        throw new BlobError(`component '${name}' is listed twice in one serialized entity`);
      }
      if (typeof value !== 'object' || value === null) {
        throw new BlobError(`component '${name}' of a serialized entity is not an object`);
      }
      types.push(type);
    }
    out.push(types);
  }
  return out;
}

/**
 * Creates one entity per serialized entity, in order, with its components and
 * `Region { id: regionId }`; `resolved` comes from `resolveEntities(…, entities)`.
 */
export function createEntities(
  world: World,
  entities: readonly SerializedEntity[],
  resolved: readonly ResolvedEntity[],
  regionId: RegionId,
): EntityId[] {
  const ids: EntityId[] = [];
  for (let i = 0; i < entities.length; i++) {
    const { components } = entities[i] as SerializedEntity;
    const types = resolved[i] as ResolvedEntity;
    const e = world.create();
    for (let j = 0; j < components.length; j++) {
      const value = (components[j] as [string, unknown])[1] as Partial<unknown>;
      world.add(e, types[j] as ComponentType<unknown>, value);
    }
    world.add(e, Region, { id: regionId });
    ids.push(e);
  }
  return ids;
}

/**
 * Re-creates `entities` in region `regionId` and returns their ids in creation order: for each, a
 * new entity with its components (by value) and `Region { id: regionId }`. Every entity is resolved
 * before any is created, so a `BlobError` (see `resolveEntities`) creates nothing.
 */
export function deserializeEntities(
  world: World,
  registry: SchemaRegistry,
  entities: readonly SerializedEntity[],
  regionId: RegionId,
): EntityId[] {
  return createEntities(world, entities, resolveEntities(world, registry, entities), regionId);
}

/** `utf8(JSON.stringify(b))`. Throws `BlobError` when the blob is not JSON-serializable. */
export function encodeBlob(b: RegionBlob): Uint8Array {
  let text: string;
  try {
    text = JSON.stringify(b);
  } catch (err) {
    throw new BlobError(`region blob is not JSON-serializable`, { cause: err });
  }
  return utf8Encode(text);
}

/**
 * Parses a stored blob; `null` for `null`. Throws `BlobError` for bytes that are not UTF-8 JSON, a
 * `version` other than 1, or a shape mismatch (`savedTick` an integer >= 0, `rngState` a u32,
 * `entities` an array of `{ components: [name, value][] }`, `inboxOnly` absent or `true`).
 */
export function decodeBlob(bytes: Uint8Array | null): RegionBlob | null {
  if (bytes === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(utf8Decode(bytes));
  } catch (err) {
    throw new BlobError('region blob is not UTF-8 JSON', { cause: err });
  }
  if (!isRecord(value)) throw new BlobError('region blob is not a JSON object');
  if (value['version'] !== BLOB_VERSION) {
    throw new BlobError(`unsupported region blob version ${JSON.stringify(value['version'])}`);
  }
  const { savedTick, rngState, entities, inboxOnly } = value;
  if (!(Number.isSafeInteger(savedTick) && (savedTick as number) >= 0)) {
    throw new BlobError('region blob savedTick must be an integer >= 0');
  }
  if (!(
    Number.isInteger(rngState) &&
    (rngState as number) >= 0 &&
    (rngState as number) <= 0xffffffff
  )) {
    throw new BlobError('region blob rngState must be a u32');
  }
  if (!Array.isArray(entities) || !entities.every(isSerializedEntity)) {
    throw new BlobError('region blob entities must be an array of { components: [name, value][] }');
  }
  if (inboxOnly !== undefined && inboxOnly !== true) {
    throw new BlobError('region blob inboxOnly must be true when present');
  }
  return value as unknown as RegionBlob;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isSerializedEntity(v: unknown): boolean {
  if (!isRecord(v)) return false;
  const components = v['components'];
  return (
    Array.isArray(components) &&
    components.every((c) => Array.isArray(c) && c.length === 2 && typeof c[0] === 'string')
  );
}
