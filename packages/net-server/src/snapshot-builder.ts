import {
  ByteWriter,
  EncodeError,
  type EntityId,
  MAX_REGION_TABLE,
  REGION_ID_MAX,
  REGION_IDX_NONE,
  type SchemaRegistry,
  SNAPSHOT_FLAG_FULL,
  SNAPSHOT_FLAG_MASKED,
  type SnapshotComponent,
  type SnapshotCreate,
  type SnapshotData,
  type SnapshotHeader,
  type SnapshotUpdate,
  writeSnapshotHeader,
} from '@conduit/protocol';
import type { RegionId } from '@conduit/world';

/** The part of a `ComponentStore` the builder reads. `version`/`removedAt` are read on every use. */
export interface SnapshotStore {
  has(e: EntityId): boolean;
  read(e: EntityId): unknown;
  /** Per slot: tick of the last write while present. */
  readonly version: Uint32Array;
  /** Per slot: tick of the last remove. */
  readonly removedAt: Uint32Array;
}

/** Everything `buildSnapshot` reads, so it is testable without a Session or a FixedLoop (A.8). */
export interface SnapshotSource {
  readonly registry: SchemaRegistry;
  /** `regions.entitiesIn`; ascending ids. */
  entitiesIn(region: RegionId): Iterable<EntityId>;
  regionOf(e: EntityId): RegionId | null | undefined;
  /** Optional lifetime check for stale dependency declarations after an entity is destroyed. */
  entityAlive?(e: EntityId): boolean;
  /** The store of component `compId`. */
  store(compId: number): SnapshotStore;
  /** Index into `version`/`removedAt` (docs/sim.md 2.1). */
  slot(e: EntityId): number;
  /** Bound to (player, ctx); entities it rejects are not in interest. */
  relevance?: ((e: EntityId) => boolean) | undefined;
}

/** A client's replication state; `ClientConn` satisfies it. */
export interface ReplicationState {
  known: Set<EntityId>;
  /** Tick of the last snapshot sent; 0 = none. */
  baselineTick: number;
  /** The next snapshot is FULL (and `known` counts as empty). */
  fullNext: boolean;
}

export type SnapshotHeaderFields = Omit<SnapshotHeader, 'baselineTick' | 'flags' | 'serverTick'>;

const EMPTY_KNOWN: ReadonlySet<EntityId> = new Set();
const replicatedIdCache = new WeakMap<SchemaRegistry, readonly number[]>();

function ascending(a: number, b: number): number {
  return a - b;
}

/** Ids of the registry's replicated components, ascending. */
function replicatedIds(registry: SchemaRegistry): readonly number[] {
  let ids = replicatedIdCache.get(registry);
  if (ids === undefined) {
    ids = registry.replicated.map((c) => registry.componentId(c));
    replicatedIdCache.set(registry, ids);
  }
  return ids;
}

/**
 * One client's snapshot for `tick` (docs/net.md A.8): interest = entities of `interestRegions`
 * passing `relevance`; creates for interest not known (every replicated component), updates for
 * known entities with a component written (`version > baselineTick`) or removed
 * (`removedAt > baselineTick`) since the baseline, destroys for known entities that left interest.
 * With `fullNext` the snapshot is FULL: `known` counts as empty, `baselineTick` is 0. Records and
 * components are ascending by id; the region table is in first-use order. Nothing is committed:
 * call `commitSnapshot` once the snapshot was sent.
 */
export function buildSnapshot(
  src: SnapshotSource,
  rs: ReplicationState,
  interestRegions: Iterable<RegionId>,
  tick: number,
  header: SnapshotHeaderFields,
): SnapshotData {
  const interest = new Set<EntityId>();
  const relevance = src.relevance;
  for (const region of interestRegions) {
    for (const e of src.entitiesIn(region)) {
      if (relevance !== undefined && !relevance(e)) continue;
      interest.add(e);
    }
  }

  const full = rs.fullNext;
  const known = full ? EMPTY_KNOWN : rs.known;
  const baseline = rs.baselineTick;
  const replicated = replicatedIds(src.registry);
  const regions: string[] = [];
  const regionIdx = new Map<RegionId, number>();
  const creates: SnapshotCreate[] = [];
  const updates: SnapshotUpdate[] = [];
  const destroys: EntityId[] = [];

  const ordered = Array.from(interest).sort(ascending);
  for (const e of ordered) {
    if (!known.has(e)) {
      const components: SnapshotComponent[] = [];
      for (const id of replicated) {
        const store = src.store(id);
        if (store.has(e)) components.push({ id, value: store.read(e) });
      }
      const region = src.regionOf(e);
      let idx: number = REGION_IDX_NONE;
      if (region !== null && region !== undefined) {
        const existing = regionIdx.get(region);
        if (existing === undefined) {
          idx = regions.push(region) - 1;
          regionIdx.set(region, idx);
        } else {
          idx = existing;
        }
      }
      creates.push({ entity: e, regionIdx: idx, components });
      continue;
    }
    const slot = src.slot(e);
    let changed: SnapshotComponent[] | null = null;
    let removed: number[] | null = null;
    for (const id of replicated) {
      const store = src.store(id);
      if (store.has(e)) {
        if ((store.version[slot] ?? 0) > baseline) {
          (changed ??= []).push({ id, value: store.read(e) });
        }
      } else if ((store.removedAt[slot] ?? 0) > baseline) {
        (removed ??= []).push(id);
      }
    }
    if (changed !== null || removed !== null) {
      updates.push({ entity: e, components: changed ?? [], removed: removed ?? [] });
    }
  }

  if (!full) {
    const knownOrdered = Array.from(rs.known).sort(ascending);
    for (const e of knownOrdered) if (!interest.has(e)) destroys.push(e);
  }

  return {
    header: {
      serverTick: tick,
      serverTimeMs: header.serverTimeMs,
      baselineTick: full ? 0 : baseline,
      lastInputSeq: header.lastInputSeq,
      lastInputTick: header.lastInputTick,
      flags: full ? SNAPSHOT_FLAG_FULL : 0,
    },
    regions,
    creates,
    updates,
    destroys,
  };
}

/**
 * Commits a snapshot that was sent with its first `createsWritten` creates (A.8.1):
 * `known = (known - destroys) + those creates` (everything when FULL: the creates only), so deferred
 * creates stay unknown and are created by the next build; `baselineTick = serverTick`;
 * `fullNext = false`.
 */
export function commitSnapshot(
  rs: ReplicationState,
  data: SnapshotData,
  createsWritten: number,
): void {
  if (rs.fullNext) rs.known.clear();
  else for (const e of data.destroys) rs.known.delete(e);
  const n = Math.min(createsWritten, data.creates.length);
  for (let i = 0; i < n; i++) rs.known.add((data.creates[i] as SnapshotCreate).entity);
  rs.baselineTick = data.header.serverTick;
  rs.fullNext = false;
}

let tailScratch: ByteWriter | null = null;

/**
 * Encodes `s` exactly as `encodeSnapshot` does (docs/protocol.md 9.11), except that creates stop
 * being added once the payload so far plus the updates and destroys (always written in full) reaches
 * `softLimitBytes`. Returns, and reports through `onCreatesWritten`, how many creates were written.
 * It writes whole records only: `SNAPSHOT_FLAG_MASKED` or a component `mask` (9.11.1) is
 * `EncodeError('range')` until the builder produces masks. On a throw the writer is truncated back
 * to where the snapshot started.
 */
export function encodeSnapshotBounded(
  w: ByteWriter,
  registry: SchemaRegistry,
  s: SnapshotData,
  softLimitBytes: number,
  onCreatesWritten?: (n: number) => void,
): number {
  const start = w.length;
  const tail = (tailScratch ??= new ByteWriter(4096));
  tail.reset();
  let written = 0;
  try {
    if ((s.header.flags & SNAPSHOT_FLAG_MASKED) !== 0) {
      throw new EncodeError(
        'range',
        'SNAPSHOT_FLAG_MASKED: the bounded encoder writes whole records',
      );
    }
    writeUpdates(tail, registry, s.updates);
    writeCount16(tail, s.destroys.length, 'destroys');
    for (const e of s.destroys) tail.u32(e);

    writeSnapshotHeader(w, s.header);
    const regionCount = s.regions.length;
    if (regionCount > MAX_REGION_TABLE) {
      throw new EncodeError('count', `${regionCount} regions > MAX_REGION_TABLE`);
    }
    w.u8(regionCount);
    for (const id of s.regions) w.utf8(id, REGION_ID_MAX);
    if (s.creates.length > 65535)
      throw new EncodeError('count', `${s.creates.length} creates > 65535`);
    const countOffset = w.reserveU16();
    for (const c of s.creates) {
      if (w.length - start + tail.length >= softLimitBytes) break;
      w.u32(c.entity);
      if (c.regionIdx !== REGION_IDX_NONE && !(c.regionIdx >= 0 && c.regionIdx < regionCount)) {
        throw new EncodeError('range', `regionIdx ${c.regionIdx} outside the region table`);
      }
      w.u8(c.regionIdx);
      writeComponents(w, registry, c.components);
      written++;
    }
    w.patchU16(countOffset, written);
    w.bytes(tail.view());
  } catch (err) {
    if (w.length >= start) w.truncate(start);
    throw err;
  } finally {
    tail.reset();
  }
  onCreatesWritten?.(written);
  return written;
}

function writeCount16(w: ByteWriter, n: number, what: string): void {
  if (n > 65535) throw new EncodeError('count', `${n} ${what} > 65535`);
  w.u16(n);
}

function replicatedComponent(registry: SchemaRegistry, id: number) {
  const def = registry.component(id);
  if (def === undefined || def.replicate !== true) {
    throw new EncodeError('range', `component id ${id} is not a replicated component`);
  }
  return def;
}

function writeComponents(
  w: ByteWriter,
  registry: SchemaRegistry,
  comps: SnapshotComponent[],
): void {
  if (comps.length > 255) throw new EncodeError('count', `${comps.length} components > 255`);
  w.u8(comps.length);
  for (const c of comps) {
    const def = replicatedComponent(registry, c.id);
    if (c.mask !== undefined) {
      throw new EncodeError(
        'range',
        `component ${c.id}: the bounded encoder writes no field masks`,
      );
    }
    w.u8(c.id);
    def.schema.type.encode(w, c.value);
  }
}

function writeUpdates(w: ByteWriter, registry: SchemaRegistry, updates: SnapshotUpdate[]): void {
  writeCount16(w, updates.length, 'updates');
  for (const u of updates) {
    w.u32(u.entity);
    writeComponents(w, registry, u.components);
    if (u.removed.length > 255) throw new EncodeError('count', `${u.removed.length} removed > 255`);
    w.u8(u.removed.length);
    for (const id of u.removed) {
      replicatedComponent(registry, id);
      w.u8(id);
    }
  }
}
