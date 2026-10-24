import {
  type ComponentLike,
  REGION_IDX_NONE,
  type SchemaRegistry,
  SNAPSHOT_FLAG_FULL,
  SNAPSHOT_FLAG_STATE_TICKS,
  type SnapshotData,
} from '@conduit/protocol';
import { type ComponentType, type DeepReadonly, type EntityId, Region } from '@conduit/sim';
import type { RegionId } from '@conduit/world';
import { consoleLog, type LogFn } from './constants.ts';
import { REMOVED, sampleComponent, type SampleTiming, valueAt } from './interpolate.ts';
import { SampleRing, type SampleRingReader } from './sample-ring.ts';
import { freezeOwned, readonlyMapView } from './readonly-view.ts';

/** A replicated entity as the client knows it (docs/net.md B.5). */
export interface ReplicaEntity {
  readonly id: EntityId;
  /** From the create's region table entry, then from the `Region` component. */
  readonly regionId: RegionId | null;
  /** Server tick of the snapshot that created it. */
  readonly createdTick: number;
  /** Server tick of the snapshot that destroyed it; `null` while alive. */
  readonly destroyedTick: number | null;
  /** compId → newest decoded value (owned by the entity, treated as immutable). */
  readonly latest: ReadonlyMap<number, unknown>;
  /**
   * compId → its last values by tick, and `REMOVED` at the tick it went: every component it has had
   * while held, as of any recent tick (`ReplicaWorld.readAt`, `sample`).
   */
  readonly samples: ReadonlyMap<number, SampleRingReader>;
}

interface MutableReplicaEntity {
  readonly id: EntityId;
  /** From the create's region table entry, then from the `Region` component. */
  regionId: RegionId | null;
  /** Server tick of the snapshot that created it. */
  createdTick: number;
  /** Server tick of the snapshot that destroyed it; `null` while alive. */
  destroyedTick: number | null;
  /** compId → newest decoded value (owned by the entity, treated as immutable). */
  readonly latest: Map<number, unknown>;
  /**
   * compId → its last values by tick, and `REMOVED` at the tick it went: every component it has had
   * while held, as of any recent tick (`ReplicaWorld.readAt`, `sample`).
   */
  readonly samples: Map<number, SampleRing>;
}

/**
 * What reads replicated components (docs/net.md B.5): the newest of each (`ReplicaWorld`), or each
 * as it was at one tick (`ReplicaAt`).
 */
export interface ReplicaReader {
  /** Last complete authoritative tick proved for this entity; may lag latestTick under budgets. */
  authoritativeTick?(entity: EntityId): number | undefined;
  read<T>(e: EntityId, c: ComponentType<T>): DeepReadonly<T> | undefined;
  sample<T>(e: EntityId, c: ComponentType<T>, renderTick: number, out: T): T | undefined;
}

export interface ReplicaWorldOptions extends SampleTiming {
  log?: LogFn;
}

/**
 * The client's mirror of the replicated stores, built from snapshots (docs/net.md B.5). Keeps the
 * newest value of every component, its last values by tick (a `SampleRing`) and the tick it was
 * removed, and entity lifetimes as ticks, so render can show exactly the entities alive at its
 * render tick, each component as it was then.
 */
export class ReplicaWorld implements ReplicaReader {
  readonly registry: SchemaRegistry;
  private readonly regionComponentId: number;
  private readonly entityMap = new Map<EntityId, MutableReplicaEntity>();
  private readonly stateTicks = new Map<EntityId, number>();
  private readonly timing: {
    tickRate: number;
    snapshotEvery: number;
    extrapolation?: SampleTiming['extrapolation'];
  };
  private readonly log: LogFn;
  private lastTick = 0;
  private readonly entityViews = new WeakMap<MutableReplicaEntity, ReplicaEntity>();
  private readonly ringViews = new WeakMap<SampleRing, SampleRingReader>();

  /**
   * `components` are the game's component types (`interpolate` and `extrapolateWith` are the
   * caller's to give `sample`). Throws `RangeError` for a component that is not in the registry.
   */
  constructor(
    registry: SchemaRegistry,
    components: readonly ComponentType<unknown>[],
    opts: ReplicaWorldOptions,
  ) {
    this.registry = registry;
    if (
      opts.extrapolation !== undefined &&
      (!Number.isFinite(opts.extrapolation.horizonMs) ||
        opts.extrapolation.horizonMs < 0 ||
        opts.extrapolation.horizonMs > 10000)
    )
      throw new RangeError('ReplicaWorld: extrapolation horizonMs must be in 0..10000');
    this.timing = {
      tickRate: 1,
      snapshotEvery: 1,
      extrapolation:
        opts.extrapolation === undefined ? undefined : Object.freeze({ ...opts.extrapolation }),
    };
    this.configure(opts.tickRate, opts.snapshotEvery);
    this.log = opts.log ?? consoleLog;
    for (const c of components) {
      registry.componentId(c); // throws for a component the registry lacks
    }
    this.regionComponentId = registry.components.some((c) => c.name === Region.name)
      ? registry.componentId(Region)
      : -1;
  }

  /** Session rates from `Welcome` (used by extrapolation). */
  configure(tickRate: number, snapshotEvery: number): void {
    if (!(Number.isFinite(tickRate) && tickRate > 0)) {
      throw new RangeError(`ReplicaWorld: tickRate must be a positive number, got ${tickRate}`);
    }
    if (!Number.isInteger(snapshotEvery) || snapshotEvery < 1) {
      throw new RangeError(
        `ReplicaWorld: snapshotEvery must be an integer >= 1, got ${snapshotEvery}`,
      );
    }
    this.timing.tickRate = tickRate;
    this.timing.snapshotEvery = snapshotEvery;
  }

  get tickRate(): number {
    return this.timing.tickRate;
  }

  get snapshotEvery(): number {
    return this.timing.snapshotEvery;
  }

  /** `serverTick` of the last applied snapshot; 0 after `reset`. */
  get latestTick(): number {
    return this.lastTick;
  }

  /** Entities held, including destroyed ones not yet collected by `gc`. */
  get size(): number {
    return this.entityMap.size;
  }

  applySnapshot(s: SnapshotData): void {
    const T = s.header.serverTick;
    const baselineTick = s.header.baselineTick;
    if ((s.header.flags & SNAPSHOT_FLAG_STATE_TICKS) !== 0) {
      for (const record of [...s.creates, ...s.updates]) {
        const tick = record.stateTick ?? T;
        if (
          !Number.isInteger(tick) ||
          tick < 0 ||
          tick > T ||
          ((s.header.flags & SNAPSHOT_FLAG_FULL) === 0 &&
            tick < (this.stateTicks.get(record.entity) ?? 0))
        )
          throw new RangeError('Snapshot authoritative entity tick regressed or is invalid');
      }
    }
    if ((s.header.flags & SNAPSHOT_FLAG_FULL) !== 0) this.reset();
    for (const c of s.creates) {
      this.stateTicks.set(c.entity, c.stateTick ?? T);
      const region = c.regionIdx === REGION_IDX_NONE ? null : (s.regions[c.regionIdx] ?? null);
      let ent = this.entityMap.get(c.entity);
      if (ent === undefined) {
        ent = {
          id: c.entity,
          regionId: region,
          createdTick: T,
          destroyedTick: null,
          latest: new Map(),
          samples: new Map(),
        };
        this.entityMap.set(c.entity, ent);
      } else {
        if (ent.destroyedTick === null) {
          this.log('warn', 'duplicate create', { entity: c.entity, tick: T });
        } else {
          // Back in the client's interest while still held -- not yet collected: its destroy not
          // rendered yet, or less than `GC_LAG_TICKS` ago. The same entity (an id carries its
          // slot's generation, so a new one would have another), kept as it was: a destroy not
          // yet rendered never shows, rather than it vanishing until this tick and its view being
          // made anew. What it lost meanwhile goes: the create carries all it has.
          ent.destroyedTick = null;
          for (const id of ent.latest.keys()) {
            if (!c.components.some((comp) => comp.id === id)) this.removeComponent(ent, id, T);
          }
        }
        if (region !== null) ent.regionId = region;
      }
      for (const comp of c.components)
        this.setComponent(
          ent,
          comp.id,
          comp.value,
          c.stateTick ?? T,
          Math.min(baselineTick, c.stateTick ?? T),
        );
    }
    for (const u of s.updates) {
      const ent = this.entityMap.get(u.entity);
      if (ent === undefined) {
        this.log('warn', 'update for unknown entity', { entity: u.entity, tick: T });
        continue;
      }
      this.stateTicks.set(u.entity, u.stateTick ?? T);
      for (const comp of u.components)
        this.setComponent(
          ent,
          comp.id,
          comp.value,
          u.stateTick ?? T,
          Math.min(baselineTick, u.stateTick ?? T),
          comp.mask,
        );
      for (const id of u.removed) this.removeComponent(ent, id, u.stateTick ?? T);
    }
    for (const e of s.destroys) {
      const ent = this.entityMap.get(e);
      if (ent !== undefined && ent.destroyedTick === null) ent.destroyedTick = T;
    }
    if ((s.header.flags & SNAPSHOT_FLAG_STATE_TICKS) === 0)
      for (const entity of this.entityMap.values())
        if (entity.destroyedTick === null) this.stateTicks.set(entity.id, T);
    this.lastTick = T;
  }

  authoritativeTick(entity: EntityId): number | undefined {
    return this.stateTicks.get(entity);
  }

  /** Newest value of `c` on `e`; `undefined` when either is absent. Throws for an unknown `c`. */
  read<T>(e: EntityId, c: ComponentType<T>): DeepReadonly<T> | undefined {
    const ent = this.entityMap.get(e);
    if (ent === undefined) return undefined;
    return ent.latest.get(this.idOf(c)) as DeepReadonly<T> | undefined;
  }

  /**
   * `c` on `e` as it was at `tick` (docs/net.md B.5 `valueAt`): the value it came with at or before
   * then -- not there yet if it came later, still there if it went later. `undefined` when either
   * is absent then. Throws for an unknown `c`.
   */
  readAt<T>(e: EntityId, c: ComponentType<T>, tick: number): DeepReadonly<T> | undefined {
    const ent = this.entityMap.get(e);
    if (ent === undefined) return undefined;
    const ring = ent.samples.get(this.idOf(c));
    return ring === undefined ? undefined : (valueAt(ring, tick) as DeepReadonly<T> | undefined);
  }

  /**
   * `c` on `e` at fractional `renderTick`, written into `out` (docs/net.md B.5): interpolated
   * between samples, extrapolated by at most one snapshot interval past the newest (or the last
   * before it was removed). `undefined` when either is absent at `renderTick` (`readAt`).
   */
  sample<T>(e: EntityId, c: ComponentType<T>, renderTick: number, out: T): T | undefined {
    const ent = this.entityMap.get(e);
    if (ent === undefined) return undefined;
    const ring = ent.samples.get(this.idOf(c));
    const value = ring === undefined ? undefined : valueAt(ring, renderTick);
    if (value === undefined) return undefined;
    return sampleComponent(c, ring, value as T, renderTick, out, this.timing);
  }

  /** True while `e` is held (alive, or destroyed and not yet collected). */
  has(e: EntityId): boolean {
    return this.entityMap.has(e);
  }

  get(e: EntityId): ReplicaEntity | undefined {
    const value = this.entityMap.get(e);
    return value === undefined ? undefined : this.entityView(value);
  }

  /** Every held entity, in insertion (creation) order. */
  *entities(): IterableIterator<ReplicaEntity> {
    for (const entity of this.entityMap.values()) yield this.entityView(entity);
  }

  /** Entities with `createdTick <= renderTick < destroyedTick` (or not destroyed), insertion order. */
  *visibleAt(renderTick: number): Generator<ReplicaEntity, void, undefined> {
    for (const ent of this.entityMap.values())
      if (aliveAt(ent, renderTick)) yield this.entityView(ent);
  }

  /** Drops entities destroyed before `beforeTick`; returns how many. */
  gc(beforeTick: number): number {
    let removed = 0;
    for (const [id, ent] of this.entityMap) {
      if (ent.destroyedTick !== null && ent.destroyedTick < beforeTick) {
        this.entityMap.delete(id);
        this.stateTicks.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /** Forgets every entity and sample. */
  reset(): void {
    this.entityMap.clear();
    this.stateTicks.clear();
    this.lastTick = 0;
  }

  private entityView(entity: MutableReplicaEntity): ReplicaEntity {
    let view = this.entityViews.get(entity);
    if (view !== undefined) return view;
    view = Object.freeze({
      get id() {
        return entity.id;
      },
      get regionId() {
        return entity.regionId;
      },
      get createdTick() {
        return entity.createdTick;
      },
      get destroyedTick() {
        return entity.destroyedTick;
      },
      latest: readonlyMapView(entity.latest, (value) => value),
      samples: readonlyMapView(entity.samples, (ring) => this.ringView(ring)),
    });
    this.entityViews.set(entity, view);
    return view;
  }
  private ringView(ring: SampleRing): SampleRingReader {
    let view = this.ringViews.get(ring);
    if (view !== undefined) return view;
    const sample = (value: ReturnType<SampleRing['newest']>) =>
      value === undefined ? undefined : Object.freeze({ tick: value.tick, value: value.value });
    view = Object.freeze({
      get capacity() {
        return ring.capacity;
      },
      get length() {
        return ring.length;
      },
      get complete() {
        return ring.complete;
      },
      at: (i: number) => Object.freeze({ ...ring.at(i) }),
      tickAt: (i: number) => ring.tickAt(i),
      oldest: () => sample(ring.oldest()),
      newest: () => sample(ring.newest()),
      indexAtOrBefore: (tick: number) => ring.indexAtOrBefore(tick),
      bracket: (tick: number) => ring.bracket(tick),
    });
    this.ringViews.set(ring, view);
    return view;
  }

  private idOf(c: ComponentLike<unknown>): number {
    return this.registry.componentId(c);
  }

  private setComponent(
    ent: MutableReplicaEntity,
    id: number,
    value: unknown,
    T: number,
    baselineTick: number,
    mask?: number,
  ): void {
    const previous = ent.latest.get(id);
    const definition = this.registry.component(id);
    if (definition === undefined) throw new RangeError(`ReplicaWorld: unknown component ${id}`);
    if (mask === undefined) value = definition.schema.copy(value, definition.schema.create());
    else {
      const schema = definition.schema;
      if (previous === undefined && mask !== (1 << schema.fieldNames.length) - 1)
        throw new RangeError('ReplicaWorld: partial component has no admitted baseline');
      const merged = (
        previous === undefined ? schema.create() : schema.copy(previous, schema.create())
      ) as Record<string, unknown>;
      for (let index = 0; index < schema.fieldNames.length; index++) {
        if ((mask & (1 << index)) === 0) continue;
        const name = schema.fieldNames[index]!;
        const field = schema.fields[name]!;
        merged[name] = field.copy((value as Record<string, unknown>)[name], field.create());
      }
      value = merged;
    }
    freezeOwned(value);
    ent.latest.set(id, value); // decodeSnapshot allocated it; no copy
    // Every component's: what it was at a render tick behind the newest snapshot.
    let ring = ent.samples.get(id);
    if (ring === undefined) {
      ring = new SampleRing();
      ent.samples.set(id, ring);
    }
    // The client's view at the baseline snapshot was `previous`, so the component still had that
    // value at `baselineTick`: a hold sample there keeps a long-resting entity from sliding early.
    const newest = ring.newest();
    if (
      previous !== undefined &&
      newest !== undefined &&
      newest.tick < baselineTick &&
      baselineTick < T
    ) {
      ring.push(baselineTick, previous);
    }
    ring.push(T, value); // ring and latest share the object; both treat it as immutable
    if (id === this.regionComponentId) ent.regionId = (value as { id: RegionId }).id;
  }

  /**
   * Component `id` of `ent` gone at `T`: from its newest values at once, from its samples as of `T`
   * (a render tick behind it still has it).
   */
  private removeComponent(ent: MutableReplicaEntity, id: number, T: number): void {
    ent.latest.delete(id);
    ent.samples.get(id)?.push(T, REMOVED);
  }
}

/**
 * The replica as of one tick (docs/net.md B.5): each component as it was at `tick` -- not there yet
 * if it came after, still there if it went after -- and the entities alive then. What a frame reads
 * (`FrameContext.replica`), at its render tick: as the view shows them, not as the newest snapshot
 * has them, a little ahead.
 */
export class ReplicaAt implements ReplicaReader {
  readonly world: ReplicaWorld;
  /** The tick it reads at: fractional, a render tick. */
  tick: number;

  constructor(world: ReplicaWorld, tick = 0) {
    this.world = world;
    this.tick = tick;
  }

  /** `c` on `e` as it was at `tick` (`ReplicaWorld.readAt`). */
  read<T>(e: EntityId, c: ComponentType<T>): DeepReadonly<T> | undefined {
    return this.world.readAt(e, c, this.tick);
  }

  /** `ReplicaWorld.sample`. */
  sample<T>(e: EntityId, c: ComponentType<T>, renderTick: number, out: T): T | undefined {
    return this.world.sample(e, c, renderTick, out);
  }

  /** Entity `e` if it was alive at `tick` (`createdTick <= tick < destroyedTick`). */
  get(e: EntityId): ReplicaEntity | undefined {
    const ent = this.world.get(e);
    return ent !== undefined && aliveAt(ent, this.tick) ? ent : undefined;
  }

  has(e: EntityId): boolean {
    return this.get(e) !== undefined;
  }

  /** The entities alive at `tick`, in insertion (creation) order. */
  entities(): Generator<ReplicaEntity, void, undefined> {
    return this.world.visibleAt(this.tick);
  }

  /** `ReplicaWorld.visibleAt`. */
  visibleAt(renderTick: number): Generator<ReplicaEntity, void, undefined> {
    return this.world.visibleAt(renderTick);
  }
}

function aliveAt(ent: ReplicaEntity, tick: number): boolean {
  return ent.createdTick <= tick && (ent.destroyedTick === null || tick < ent.destroyedTick);
}
