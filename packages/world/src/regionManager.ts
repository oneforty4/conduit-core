import { Rng, v3, type Vec3 } from '@conduit/math';
import type { SchemaRegistry } from '@conduit/protocol';
import {
  Region,
  RegionChanged,
  SLOT_MASK,
  Transform,
  type ComponentStore,
  type EntityId,
  type EventBus,
  type RegionsApi,
  type SimContext,
  type System,
  type World,
  type WorldCheckpoint,
  cloneExactState,
} from '@conduit/sim';
import {
  BLOB_NAMESPACE,
  createEntities,
  decodeBlob,
  encodeBlob,
  resolveEntities,
  serializeEntity,
  type RegionBlob,
  type ResolvedEntity,
  type SerializedEntity,
} from './blob.ts';
import { clampToBounds, contains, rebase } from './coords.ts';
import { createMembershipSystem } from './membership.ts';
import { insertSorted, removeSorted, stringCompare } from './sorted.ts';
import type { RegionDef, RegionId, RegionStore, WorldGraph } from './types.ts';

/*
 * Region streaming (docs/world.md §5, §6, §7): regions load from the store when wanted, activate on
 * an `update` boundary, linger when no longer wanted, then save and evict. Entities crossing into an
 * inactive region wait in its inbox.
 */

/** How long a region nobody wants stays active before it is saved and evicted. */
export const LINGER_MS = 10_000;

/** Delay before a failed region load is retried. */
export const RETRY_MS = 5_000;

export type RegionState = 'inactive' | 'loading' | 'active' | 'saving';

/** Outcome of `RegionManager.migrate` (docs/world.md §6.2). */
export type MigrateResult =
  'moved' | 'inboxed' | 'deferred' | 'same' | 'unknownRegion' | 'notMember' | 'outOfBounds';

/** Game content of regions (docs/world.md §5.3). */
export interface RegionLoader {
  /**
   * Called when the region activates, after the manager restored `blob.entities` (each with
   * `Region { id }`; already listed in `entitiesIn`). `blob` is the saved state, or `null` for a
   * fresh region: create the procedural content then, each entity with `Region { id: region.id }`
   * and, in a bounded region, a `Transform`. The region is already active: `ctx.regionRng(region.id)`
   * is its stream, restored from the blob.
   */
  populate(region: RegionDef, blob: RegionBlob | null, ctx: SimContext): void;
  /**
   * Called when the region is saved (evicted, or flushed by `flushAll` while it stays active); the
   * return value is stored as `blob.gameData`. Must not change the ECS.
   */
  onDeactivate?(region: RegionDef, ctx: SimContext): unknown;
}

export interface RegionManagerOpts {
  graph: WorldGraph;
  /** Its registry must hold `Region`, `Transform` and `RegionChanged` (as `defineGame`'s does). */
  world: World;
  loader: RegionLoader;
  /** Region blobs, a `BlobStore` (docs/persist.md 1.2). */
  store: RegionStore;
  /** Ticks per second; > 0. */
  tickRate: number;
  /** How long a region nobody wants lingers; finite, >= 0; default `LINGER_MS`. */
  lingerMs?: number | undefined;
  /** Store failures are logged at `'error'`. Default: no-op. */
  log?: ((level: 'warn' | 'error', msg: string, err?: unknown) => void) | undefined;
  /** Called after a bounded entity that left the world was clamped back inside its region. */
  onWorldEdge?: ((e: EntityId, ctx: SimContext) => void) | undefined;
}

/** `regionRng(id)` of a region that is not active. */
export class RegionNotActive extends Error {
  override readonly name = 'RegionNotActive';
  readonly regionId: RegionId;

  constructor(regionId: RegionId) {
    super(`region '${regionId}' is not active`);
    this.regionId = regionId;
  }
}

/** A region id the world graph does not know. */
export class UnknownRegion extends Error {
  override readonly name = 'UnknownRegion';
  readonly regionId: RegionId;

  constructor(regionId: RegionId) {
    super(`region '${regionId}' is not in the world graph`);
    this.regionId = regionId;
  }
}

/** A broken player invariant (docs/world.md §6.3): a player entity where it can never be. */
export class InvariantViolation extends Error {
  override readonly name = 'InvariantViolation';
  readonly regionId: RegionId;
  readonly entity: EntityId;

  constructor(regionId: RegionId, entity: EntityId, detail: string) {
    super(`player invariant broken (entity ${entity}, region '${regionId}'): ${detail}`);
    this.regionId = regionId;
    this.entity = entity;
  }
}

/**
 * Internal: one region's state (docs/world.md §5 `RegionRec`). Not exported by the package.
 */
export interface RegionRecord {
  readonly id: RegionId;
  readonly def: RegionDef;
  state: RegionState;
  /**
   * Entities whose `Region.id` is this region, ascending, while active; `[]` otherwise. Changed only
   * through `RegionManager`'s record/unrecord so that its `recordedIn` lookup stays in step.
   */
  entities: EntityId[];
  /** The region's stream while active. */
  rng: Rng | null;
  /** Tick at which a lingering region is saved; `Infinity` when not lingering. */
  lingerUntil: number;
  /** Tick before which a failed load is not retried; 0 when none. */
  retryAt: number;
  /**
   * The region's content while it is not active, when known in memory: the blob last loaded, saved,
   * or merged with inbox arrivals by `flushAll`. Every activation restores from it.
   */
  blob: RegionBlob | null;
  /** The save of the last eviction, until it settles. */
  saving: Promise<void> | null;
  /** `blob` holds content the store may not have (a save not yet confirmed). */
  unsaved: boolean;
}

/**
 * Internal: what `createMembershipSystem` (membership.ts) needs from its manager. Not exported by
 * the package.
 */
export interface MembershipAccess {
  readonly world: World;
  readonly graph: WorldGraph;
  /**
   * Starts a membership pass: records entities whose `Region` was added or written since the last
   * pass, then prunes this tick's destroyed entities from every record.
   */
  syncRecords(ctx: SimContext): void;
  /** The record of `id`, if the region was ever wanted or targeted. */
  record(id: RegionId): RegionRecord | undefined;
  /** The record of `id`, created `inactive` on first use. Throws `UnknownRegion`. */
  getOrCreate(id: RegionId): RegionRecord;
  /** Whether the last `update` wanted `id`. */
  wanted(id: RegionId): boolean;
  /**
   * Moves `e` from region `from` into the active region `to`: copies `localPos` into
   * `Transform.pos` (unless `null`), writes `Region.id`, updates the records and emits
   * `RegionChanged`.
   */
  relocate(
    e: EntityId,
    from: RegionId,
    to: RegionRecord,
    localPos: Readonly<Vec3> | null,
    events: EventBus,
  ): void;
  /**
   * Moves `e`, which left bounded region `from`, into the inbox of the inactive region `to`: its
   * persisted components with `Transform.pos` rebased onto `to`, if it has any; then destroys it.
   * Throws `InvariantViolation` for a player entity.
   */
  inbox(e: EntityId, from: RegionDef, to: RegionRecord): void;
  /** Clamps `e` back inside its region `def` and calls `onWorldEdge`. */
  worldEdge(e: EntityId, def: RegionDef, ctx: SimContext): void;
}

/** What `flushAll` writes for one region's inbox. */
interface Arrivals {
  rec: RegionRecord;
  /** The live inbox array when the flush started. */
  items: SerializedEntity[];
  /** A copy of its elements then: the ones this flush writes. */
  written: SerializedEntity[];
  /** `rec.blob` when the flush started; `null`: read the stored blob. */
  base: RegionBlob | null;
}

export interface RegionSaveCapture {
  completedTick: number;
  writes: { id: RegionId; bytes: Uint8Array }[];
  arrivals: { id: RegionId; entities: SerializedEntity[]; base: RegionBlob | null; seed: number }[];
  /** Acknowledge only this captured prefix; newer live changes retain their identity. */
  acknowledge(merged: ReadonlyMap<RegionId, RegionBlob>): void;
}

export interface RegionActivationDecision {
  kind: 'region-load-result' | 'region-save-result';
  regionId: RegionId;
  observedTick: number;
  outcome: 'loaded' | 'failed';
  blob: RegionBlob | null;
  error?: string;
  fatal?: boolean;
}
export interface RegionCheckpoint {
  version: 1;
  completedTick: number;
  records: {
    id: RegionId;
    state: RegionState;
    entities: EntityId[];
    rngState: number | null;
    lingerUntil: number | null;
    retryAt: number;
    blob: RegionBlob | null;
    unsaved: boolean;
  }[];
  pendingActivations: RegionId[];
  pendingDecisions: RegionActivationDecision[];
  inboxes: { id: RegionId; entities: SerializedEntity[] }[];
  players: EntityId[];
  wanted: RegionId[];
  scanFrom: number;
}

type RegionValue = ReturnType<typeof Region.create>;

const NO_ENTITIES: readonly EntityId[] = Object.freeze([]);
const NO_REGIONS: readonly RegionId[] = Object.freeze([]);

function noLog(): void {}

/**
 * Activates the regions players need, tracks which entities are in each active region, saves and
 * evicts regions nobody wants, and moves entities between regions (docs/world.md §5, §6). Driven by
 * the Session every tick: `update` before `Simulation.step`, `membershipSystem.run` first in
 * `Simulation.tail`. Satisfies sim's `RegionsApi` and `InterestPolicy`'s `RegionMembership`.
 */
export class RegionManager implements RegionsApi {
  /**
   * Region membership (docs/world.md §6.1), phase `postSim`: push `membershipSystem.run` onto
   * `Simulation.tail` before `spatial.rebuild` (docs/sim.md 2.9). `run` does not use `this`.
   */
  readonly membershipSystem: System;
  /** Internal: state access for `createMembershipSystem`. Not API. */
  readonly _membership: MembershipAccess;

  private readonly graph: WorldGraph;
  private readonly world: World;
  private readonly registry: SchemaRegistry;
  private readonly loader: RegionLoader;
  /** Region ids of entities, and their version stamps. */
  private readonly regionStore: ComponentStore<RegionValue>;
  private readonly store: RegionStore;
  private readonly log: (level: 'warn' | 'error', msg: string, err?: unknown) => void;
  private readonly onWorldEdge: ((e: EntityId, ctx: SimContext) => void) | undefined;
  private readonly lingerTicks: number;
  private readonly retryTicks: number;

  /** Every region ever wanted or targeted, by id. Lookup only. */
  private readonly recs = new Map<RegionId, RegionRecord>();
  /** Ids of the active regions, ascending. */
  private readonly activeIds: RegionId[] = [];
  /** The record listing each recorded entity. Lookup only. */
  private readonly recordedIn = new Map<EntityId, RegionRecord>();
  /** Regions whose load or failed save completed: they activate at the start of the next `update`. */
  private readonly pendingActivations: RegionId[] = [];
  /** Serialized entities waiting for their inactive region, in arrival order. Lookup only. */
  private readonly inboxes = new Map<RegionId, SerializedEntity[]>();
  /** The players passed to the last `update`. Lookup only. */
  private playerSet: ReadonlySet<EntityId> = new Set();
  /** The regions the last `update` wanted. Lookup only. */
  private wantedSet: ReadonlySet<RegionId> = new Set();
  /** `Region` versions stamped at least this have not been recorded yet (`track`). */
  private scanFrom = 0;
  /** The context of the last `update` or membership pass; `migrate` and `flushAll` use it. */
  private ctx: SimContext | null = null;
  private replayExternal = false;
  private loadEpoch = 0;
  private pendingDecisions: RegionActivationDecision[] = [];
  private appliedDecisions: RegionActivationDecision[] = [];
  private decisionOverflow = false;
  /** Called at the update boundary where an external load result becomes authoritative. */
  onActivationDecision: ((decision: RegionActivationDecision) => void) | undefined;

  /**
   * Throws `RangeError` for a bad `tickRate` or `lingerMs` or a registry without the
   * `RegionChanged` event, and `UnknownComponent` unless the registry holds `Region` and
   * `Transform`.
   */
  constructor(opts: RegionManagerOpts) {
    const { graph, world, tickRate } = opts;
    if (!(Number.isFinite(tickRate) && tickRate > 0)) {
      throw new RangeError(`RegionManager: tickRate must be a positive number, got ${tickRate}`);
    }
    const lingerMs = opts.lingerMs ?? LINGER_MS;
    if (!(Number.isFinite(lingerMs) && lingerMs >= 0)) {
      throw new RangeError(`RegionManager: lingerMs must be finite and >= 0, got ${lingerMs}`);
    }
    this.graph = graph;
    this.world = world;
    this.registry = world.registry;
    this.loader = opts.loader;
    // Membership queries Transform and emits RegionChanged: fail here rather than mid-tick.
    this.regionStore = world.store(Region);
    world.store(Transform);
    try {
      world.registry.eventId(RegionChanged);
    } catch (cause) {
      throw new RangeError(
        'RegionManager: the registry must include a compatible RegionChanged event (defineGame adds it)',
        { cause },
      );
    }
    this.store = opts.store;
    this.log = opts.log ?? noLog;
    this.onWorldEdge = opts.onWorldEdge;
    this.lingerTicks = Math.round((lingerMs * tickRate) / 1000);
    this.retryTicks = Math.round((RETRY_MS * tickRate) / 1000);

    this._membership = {
      world,
      graph,
      syncRecords: (ctx) => {
        this.ctx = ctx;
        this.track();
        const destroyed = world.destroyedThisTick();
        for (let i = 0; i < destroyed.length; i++) this.unrecord(destroyed[i] as EntityId);
      },
      record: (id) => this.recs.get(id),
      getOrCreate: (id) => this.getOrCreate(id),
      wanted: (id) => this.wantedSet.has(id),
      relocate: (e, from, to, localPos, events) => this.relocate(e, from, to, localPos, events),
      inbox: (e, from, to) => {
        if (this.playerSet.has(e)) {
          throw new InvariantViolation(to.id, e, 'a player entity cannot enter an inactive region');
        }
        const s = serializeEntity(world, e);
        if (s !== null) {
          const t = transformOf(s);
          if (t !== undefined) rebase(from, to.def, t.pos, t.pos);
          this.inboxOf(to.id).push(s);
        }
        this.unrecord(e);
        world.destroy(e);
      },
      worldEdge: (e, def, ctx) => {
        const t = world.write(e, Transform);
        clampToBounds(def, t.pos, t.pos);
        this.onWorldEdge?.(e, ctx);
      },
    };
    this.membershipSystem = createMembershipSystem(this);
  }

  /**
   * Runs every tick before `Simulation.step` (docs/world.md §5.2), never during it: activates the
   * regions whose load (or failed save) completed, in id order; records entities hooks created
   * since the last pass; then applies the §5.1 transitions to the regions in `graph.wanted` of each
   * player's region and of each `pending` region (spawn regions of joined players that have no
   * entity yet, docs/net.md A.6): wanted inactive regions start loading, wanted lingering regions
   * stop lingering, active regions nobody wants linger and, once the linger expires, are saved and
   * evicted. A throwing `populate` propagates (regions queued behind it activate at the next
   * `update`), as does a throwing eviction (see `deactivate`).
   */
  update(
    players: readonly EntityId[],
    ctx: SimContext,
    pending: readonly RegionId[] = NO_REGIONS,
  ): void {
    if (this.world.stepping) {
      throw new Error('RegionManager.update must run between steps, not inside Simulation.step');
    }
    const tick = ctx.tick + 1; // the tick about to be simulated
    this.ctx = ctx;
    this.playerSet = new Set(players);
    if (this.decisionOverflow) throw new Error('RegionManager: pending decision limit exceeded');
    this.appliedDecisions = [];
    const ready = this.pendingDecisions.filter((decision) => decision.observedTick <= tick);
    this.pendingDecisions = this.pendingDecisions.filter(
      (decision) => decision.observedTick > tick,
    );
    for (const decision of ready) {
      const rec = this.getOrCreate(decision.regionId);
      if (
        rec.state !== 'loading' &&
        !(decision.kind === 'region-save-result' && rec.state === 'saving')
      )
        continue;
      const applied = cloneExactState({ ...decision, observedTick: tick });
      this.appliedDecisions.push(applied);
      this.onActivationDecision?.(cloneExactState(applied));
      if (decision.fatal)
        throw new Error(
          `RegionManager: invalid stored region '${rec.id}': ${decision.error ?? 'unsupported format'}`,
        );
      if (decision.kind === 'region-save-result') {
        if (decision.outcome === 'loaded') {
          rec.unsaved = false;
          if (rec.state === 'loading') this.pendingActivations.push(rec.id);
          else rec.state = 'inactive';
        } else {
          this.log(
            'error',
            `region '${rec.id}' failed to save; reactivating it from memory`,
            new Error(decision.error ?? 'recorded save failure'),
          );
          this.pendingActivations.push(rec.id);
        }
        continue;
      }
      if (decision.outcome === 'failed')
        this.loadFailed(rec, new Error(decision.error ?? 'recorded load failure'));
      else {
        if (rec.blob === null) rec.blob = cloneExactState(decision.blob);
        this.pendingActivations.push(rec.id);
      }
    }

    // 1. Activations, in id order so that regions ready at the same boundary activate in order.
    const batch = this.pendingActivations.splice(0).sort(stringCompare);
    for (let i = 0; i < batch.length; i++) {
      const rec = this.recs.get(batch[i] as RegionId);
      if (rec === undefined || (rec.state !== 'loading' && rec.state !== 'saving')) continue;
      try {
        this.activate(rec, ctx);
      } catch (err) {
        // Keep the rest of the batch queued rather than stranding it in 'loading'.
        for (let j = i + 1; j < batch.length; j++) {
          this.pendingActivations.push(batch[j] as RegionId);
        }
        throw err;
      }
    }

    // 2. Entities created or moved by hooks since the last pass, so an eviction below saves them.
    this.track();

    // 3. Wanted regions: the neighbourhood of every placed player, plus pending spawn regions.
    const wanted: RegionId[] = [];
    for (const p of players) {
      const r = this.regionOf(p);
      if (r !== undefined) for (const id of this.graph.wanted(r)) wanted.push(id);
    }
    for (const r of pending) for (const id of this.graph.wanted(r)) wanted.push(id);
    wanted.sort(stringCompare);
    this.wantedSet = new Set(wanted);

    // 4. Transitions (docs/world.md §5.1).
    let previous: RegionId | undefined;
    for (const id of wanted) {
      if (id === previous) continue;
      previous = id;
      const rec = this.getOrCreate(id);
      switch (rec.state) {
        case 'inactive':
          if (tick >= rec.retryAt) this.startLoad(rec);
          break;
        case 'active':
          rec.lingerUntil = Infinity;
          break;
        case 'saving':
          // Wanted again: activates from memory once the put settles. A failed put already queued it.
          if (rec.saving !== null || this.replayExternal) rec.state = 'loading';
          break;
        case 'loading':
          break;
      }
    }
    for (const id of this.activeIds.slice()) {
      if (this.wantedSet.has(id)) continue;
      const rec = this.recs.get(id) as RegionRecord;
      if (rec.lingerUntil === Infinity) rec.lingerUntil = tick + this.lingerTicks;
      else if (tick >= rec.lingerUntil) this.deactivate(rec, ctx, tick);
    }
  }

  /**
   * Moves `e` into region `to` (docs/world.md §6.2). `newLocalPos` defaults to the entity's
   * position rebased onto `to` (bounded regions with a `Transform`), else the origin; it must lie
   * inside a bounded `to` (`'outOfBounds'`). Into an active region the entity moves now and
   * `RegionChanged` is emitted (`'moved'`); into a loading or saving region nothing happens
   * (`'deferred'`); into an inactive region its persisted components (with `Transform.pos` set to the
   * new position) go to the region's inbox and the entity is destroyed (`'inboxed'`); a player entity
   * throws `InvariantViolation` instead.
   */
  migrate(e: EntityId, to: RegionId, newLocalPos?: Vec3): MigrateResult {
    const region = this.regionStore.tryRead(e);
    if (region === undefined) return 'notMember';
    const current = region.id;
    if (current === to) return 'same';
    const tdef = this.graph.get(to);
    if (tdef === undefined) return 'unknownRegion';
    const trec = this.getOrCreate(to);
    const world = this.world;
    const transform = world.tryGet(e, Transform);
    const cdef = this.graph.get(current);
    let pos: Vec3;
    if (newLocalPos !== undefined) {
      pos = v3.copy(newLocalPos);
    } else if (
      transform !== undefined &&
      cdef !== undefined &&
      cdef.bounds.kind !== 'node' &&
      tdef.bounds.kind !== 'node'
    ) {
      pos = rebase(cdef, tdef, transform.pos);
    } else {
      pos = v3.create();
    }
    if (tdef.bounds.kind !== 'node' && !contains(tdef, pos)) return 'outOfBounds';
    switch (trec.state) {
      case 'active':
        this.relocate(e, current, trec, transform === undefined ? null : pos, this.events());
        return 'moved';
      case 'loading':
      case 'saving':
        return 'deferred';
      case 'inactive': {
        if (this.playerSet.has(e)) {
          throw new InvariantViolation(to, e, 'a player entity cannot enter an inactive region');
        }
        // An entity already destroyed this tick stays destroyed: inboxing it would resurrect it.
        const s = world.destroyedThisTick().includes(e) ? null : serializeEntity(world, e);
        if (s !== null) {
          const t = transformOf(s);
          if (t !== undefined) v3.copy(pos, t.pos);
          this.inboxOf(to).push(s);
        }
        this.unrecord(e);
        world.destroy(e);
        return 'inboxed';
      }
    }
  }

  /**
   * Entities of an active region, ascending by id; `[]` for any other region. The array is live:
   * `update`, membership passes and `migrate` change it in place, so copy it before migrating the
   * entities it lists. Entities created with `Region` are listed from the next `update` or
   * membership pass; destroyed ones are dropped by the membership pass of their tick.
   */
  entitiesIn(id: RegionId): readonly EntityId[] {
    const rec = this.recs.get(id);
    return rec !== undefined && rec.state === 'active' ? rec.entities : NO_ENTITIES;
  }

  /** `Region.id` of `e`, or `undefined` when it has none or is not alive. */
  regionOf(e: EntityId): RegionId | undefined {
    return this.regionStore.tryRead(e)?.id;
  }

  /** Ids of the active regions, ascending (`stringCompare`). The array is live. */
  active(): readonly RegionId[] {
    return this.activeIds;
  }

  /** `'inactive'` for regions never wanted, including ids the graph does not know. */
  state(id: RegionId): RegionState {
    return this.recs.get(id)?.state ?? 'inactive';
  }

  /** The graph's definition of `id`, whatever its state. */
  def(id: RegionId): RegionDef | undefined {
    return this.graph.get(id);
  }

  /** Whether `id` is active but no longer wanted, waiting for its linger to expire. */
  lingering(id: RegionId): boolean {
    const rec = this.recs.get(id);
    return rec !== undefined && rec.state === 'active' && rec.lingerUntil !== Infinity;
  }

  /**
   * The active region's own stream (docs/world.md §7): `new Rng(def.seed)` for a fresh region,
   * restored from `blob.rngState` for a saved one; the same instance until the region deactivates.
   * `ctx.regionRng` is bound to this. Throws `RegionNotActive` for a region that is not active.
   */
  regionRng(id: RegionId): Rng {
    const rec = this.recs.get(id);
    if (rec === undefined || rec.state !== 'active' || rec.rng === null) {
      throw new RegionNotActive(id);
    }
    return rec.rng;
  }

  drainDecisions(): RegionActivationDecision[] {
    return cloneExactState(this.appliedDecisions.splice(0));
  }

  injectDecision(decision: RegionActivationDecision): void {
    if (!this.replayExternal)
      throw new Error('RegionManager: decision injection requires replayExternal');
    this.validateDecision(decision);
    if (this.pendingDecisions.length >= 100_000)
      throw new Error('RegionManager: pending decision limit exceeded');
    if (
      !this.pendingDecisions.some(
        (item) =>
          item.kind === decision.kind &&
          item.regionId === decision.regionId &&
          item.observedTick === decision.observedTick,
      )
    )
      this.pendingDecisions.push(cloneExactState(decision));
  }

  async waitForSaves(): Promise<void> {
    const saves = [...this.recs.values()].flatMap((rec) =>
      rec.saving === null ? [] : [rec.saving],
    );
    await Promise.all(saves);
  }

  /** Detaches active state and inbox prefixes synchronously; no storage reads or promises. */
  captureSave(): RegionSaveCapture {
    if (this.world.stepping) throw new Error('RegionManager: capture requires a completed tick');
    const completedTick = this.world.tick;
    const dying = new Set(this.world.destroyedThisTick());
    const writes: RegionSaveCapture['writes'] = [];
    const written: { rec: RegionRecord; blob: RegionBlob }[] = [];
    for (const id of this.sortedRecordIds()) {
      const rec = this.recs.get(id)!;
      if (rec.saving !== null) throw new Error('RegionManager: await waitForSaves before capture');
      if (rec.state === 'active')
        writes.push({
          id,
          bytes: encodeBlob(this.snapshot(rec, this.context(), dying, completedTick)),
        });
      else if (rec.unsaved && rec.blob !== null) {
        writes.push({ id, bytes: encodeBlob(rec.blob) });
        written.push({ rec, blob: rec.blob });
      }
    }
    const captured: {
      rec: RegionRecord;
      items: SerializedEntity[];
      prefix: SerializedEntity[];
      base: RegionBlob | null;
    }[] = [];
    const arrivals: RegionSaveCapture['arrivals'] = [];
    for (const id of [...this.inboxes.keys()].sort(stringCompare)) {
      const items = this.inboxes.get(id)!;
      const rec = this.getOrCreate(id);
      if (items.length === 0 || rec.state === 'active') continue;
      captured.push({ rec, items, prefix: items.slice(), base: rec.blob });
      arrivals.push({
        id,
        entities: cloneExactState(items),
        base: cloneExactState(rec.blob),
        seed: rec.def.seed,
      });
    }
    return {
      completedTick,
      writes,
      arrivals,
      acknowledge: (merged) => {
        for (const { rec, blob } of written) if (rec.blob === blob) rec.unsaved = false;
        for (const capture of captured) {
          const { rec, items, prefix, base } = capture;
          if (
            this.inboxes.get(rec.id) !== items ||
            !prefix.every((item, index) => items[index] === item)
          )
            continue;
          items.splice(0, prefix.length);
          if (items.length === 0) this.inboxes.delete(rec.id);
          const published = merged.get(rec.id);
          if (published && rec.blob === base && rec.state !== 'active') {
            rec.blob = cloneExactState(published);
            rec.unsaved = false;
          }
        }
      },
    };
  }

  captureCheckpoint(): RegionCheckpoint {
    if (this.world.stepping)
      throw new Error('RegionManager: exact capture requires a completed tick');
    for (const rec of this.recs.values())
      if (rec.saving !== null)
        throw new Error('RegionManager: exact capture requires await waitForSaves');
    return cloneExactState({
      version: 1,
      completedTick: this.world.tick,
      records: this.sortedRecordIds().map((id) => {
        const rec = this.recs.get(id)!;
        return {
          id,
          state: rec.state,
          entities: [...rec.entities],
          rngState: rec.rng?.state() ?? null,
          lingerUntil: rec.lingerUntil === Infinity ? null : rec.lingerUntil,
          retryAt: rec.retryAt,
          blob: rec.blob,
          unsaved: rec.unsaved,
        };
      }),
      pendingActivations: [...this.pendingActivations],
      pendingDecisions: this.pendingDecisions,
      inboxes: [...this.inboxes.keys()]
        .sort(stringCompare)
        .map((id) => ({ id, entities: this.inboxes.get(id)! })),
      players: [...this.playerSet].sort((a, b) => a - b),
      wanted: [...this.wantedSet].sort(stringCompare),
      scanFrom: this.scanFrom,
    });
  }

  validateCheckpoint(checkpoint: RegionCheckpoint, expectedWorld?: WorldCheckpoint): void {
    cloneExactState(checkpoint);
    if (
      checkpoint.version !== 1 ||
      !Number.isSafeInteger(checkpoint.completedTick) ||
      checkpoint.completedTick < 0 ||
      !Number.isSafeInteger(checkpoint.scanFrom) ||
      checkpoint.scanFrom < 0 ||
      !Array.isArray(checkpoint.records) ||
      checkpoint.records.length > 100_000 ||
      !Array.isArray(checkpoint.pendingActivations) ||
      !Array.isArray(checkpoint.pendingDecisions) ||
      !Array.isArray(checkpoint.inboxes) ||
      !Array.isArray(checkpoint.players) ||
      !Array.isArray(checkpoint.wanted)
    )
      throw new Error('RegionManager: invalid checkpoint');
    const ids = new Set<string>();
    const members = new Map<number, string>();
    let previousId = '';
    for (const rec of checkpoint.records) {
      if (
        !this.graph.get(rec.id) ||
        ids.has(rec.id) ||
        !['inactive', 'loading', 'active', 'saving'].includes(rec.state) ||
        !Array.isArray(rec.entities) ||
        !rec.entities.every((id) => Number.isSafeInteger(id) && id > 0) ||
        (rec.rngState !== null &&
          (!Number.isInteger(rec.rngState) || rec.rngState < 0 || rec.rngState > 0xffffffff)) ||
        (rec.state === 'active') !== (rec.rngState !== null) ||
        (rec.lingerUntil !== null &&
          (!Number.isSafeInteger(rec.lingerUntil) || rec.lingerUntil < 0)) ||
        !Number.isSafeInteger(rec.retryAt) ||
        rec.retryAt < 0 ||
        typeof rec.unsaved !== 'boolean'
      )
        throw new Error('RegionManager: invalid checkpoint record');
      ids.add(rec.id);
      if (rec.id <= previousId || (rec.state !== 'active' && rec.entities.length > 0))
        throw new Error('RegionManager: unordered records or inactive membership');
      previousId = rec.id;
      let previousEntity = 0;
      for (const entity of rec.entities) {
        if (entity <= previousEntity || members.has(entity))
          throw new Error('RegionManager: duplicate or unordered entity membership');
        previousEntity = entity;
        members.set(entity, rec.id);
      }
      if (rec.blob !== null) {
        decodeBlob(encodeBlob(rec.blob));
        resolveEntities(this.world, this.registry, rec.blob.entities);
      }
    }
    for (const id of [...checkpoint.pendingActivations, ...checkpoint.wanted])
      if (!this.graph.get(id)) throw new Error('RegionManager: unknown checkpoint region');
    for (const inbox of checkpoint.inboxes) {
      if (!this.graph.get(inbox.id)) throw new Error('RegionManager: unknown inbox region');
      resolveEntities(this.world, this.registry, inbox.entities);
    }
    for (const decision of checkpoint.pendingDecisions) this.validateDecision(decision);
    for (const list of [
      checkpoint.pendingActivations,
      checkpoint.wanted,
      checkpoint.players,
      checkpoint.inboxes.map((inbox) => inbox.id),
    ])
      if (new Set<number | string>(list).size !== list.length)
        throw new Error('RegionManager: duplicate checkpoint IDs');
    if (!checkpoint.players.every((entity) => Number.isSafeInteger(entity) && entity > 0))
      throw new Error('RegionManager: invalid player ID');
    for (const id of checkpoint.pendingActivations)
      if (!ids.has(id)) throw new Error('RegionManager: pending activation has no record');
    if (expectedWorld !== undefined) {
      if (expectedWorld.tick !== checkpoint.completedTick)
        throw new Error('RegionManager: world/region checkpoint tick mismatch');
      const regionStore = expectedWorld.stores.find((store) => store.name === Region.name);
      const actual = new Map(
        regionStore?.entities.map((entity, index) => [
          entity,
          (regionStore.values[index] as { id?: unknown } | undefined)?.id,
        ]) ?? [],
      );
      for (const [entity, region] of members)
        if (actual.get(entity) !== region)
          throw new Error('RegionManager: membership disagrees with detached World checkpoint');
      for (const player of checkpoint.players) {
        const slot = player & SLOT_MASK;
        if (
          expectedWorld.allocated[slot] !== 1 ||
          expectedWorld.generations[slot] !== player >>> 20
        )
          throw new Error('RegionManager: player is not alive in detached World checkpoint');
      }
    }
  }

  restoreCheckpoint(
    checkpoint: RegionCheckpoint,
    ctx: SimContext,
    options: { replayExternal?: boolean } = {},
  ): void {
    this.validateCheckpoint(checkpoint);
    if (this.world.tick !== checkpoint.completedTick)
      throw new Error('RegionManager: checkpoint tick differs from restored world');
    for (const rec of this.recs.values())
      if (rec.saving !== null) throw new Error('RegionManager: await waitForSaves before restore');
    const detached = cloneExactState(checkpoint);
    this.loadEpoch++;
    this.replayExternal = options.replayExternal ?? false;
    this.ctx = ctx;
    this.recs.clear();
    this.recordedIn.clear();
    this.activeIds.length = 0;
    this.inboxes.clear();
    for (const entry of detached.records) {
      const rec = this.getOrCreate(entry.id);
      Object.assign(rec, {
        state: entry.state,
        entities: entry.entities,
        rng: entry.rngState === null ? null : new Rng(entry.rngState),
        lingerUntil: entry.lingerUntil ?? Infinity,
        retryAt: entry.retryAt,
        blob: entry.blob,
        unsaved: entry.unsaved,
        saving: null,
      });
      if (entry.rngState !== null) rec.rng!.restore(entry.rngState);
      if (rec.state === 'active') {
        insertSorted(this.activeIds, rec.id);
        for (const entity of rec.entities) this.recordedIn.set(entity, rec);
      }
    }
    this.pendingActivations.splice(
      0,
      this.pendingActivations.length,
      ...detached.pendingActivations,
    );
    this.pendingDecisions = detached.pendingDecisions;
    this.appliedDecisions = [];
    this.decisionOverflow = false;
    for (const inbox of detached.inboxes) this.inboxes.set(inbox.id, inbox.entities);
    this.playerSet = new Set(detached.players);
    this.wantedSet = new Set(detached.wanted);
    this.scanFrom = detached.scanFrom;
    if (!this.replayExternal)
      for (const rec of this.recs.values())
        if (
          rec.state === 'loading' &&
          !this.pendingActivations.includes(rec.id) &&
          !this.pendingDecisions.some((item) => item.regionId === rec.id)
        )
          this.startLoad(rec);
  }

  private validateDecision(decision: RegionActivationDecision): void {
    if (
      !['region-load-result', 'region-save-result'].includes(decision.kind) ||
      !this.graph.get(decision.regionId) ||
      !Number.isSafeInteger(decision.observedTick) ||
      decision.observedTick < 0 ||
      !['loaded', 'failed'].includes(decision.outcome) ||
      (decision.error !== undefined && typeof decision.error !== 'string') ||
      (decision.fatal !== undefined && typeof decision.fatal !== 'boolean')
    )
      throw new Error('RegionManager: invalid activation decision');
    if (decision.blob !== null) decodeBlob(encodeBlob(decision.blob));
  }

  /**
   * Saves everything to the store (docs/world.md §5.5): waits for evictions in flight, then in one
   * store transaction writes a blob for every active region (which stays active), rewrites blobs
   * whose save failed, and appends each inbox to its region's stored blob. Everything written is
   * taken synchronously when the transaction starts, so regions and inboxes agree on one instant
   * even when ticks run while the writes are awaited. Rejects when the store does; nothing is lost
   * from memory then.
   */
  async flushAll(canCapture: () => boolean = () => true): Promise<void> {
    const saves: Promise<void>[] = [];
    for (const id of this.sortedRecordIds()) {
      const saving = this.recs.get(id)?.saving;
      if (saving !== null && saving !== undefined) saves.push(saving);
    }
    await Promise.all(saves);
    const written: { rec: RegionRecord; blob: RegionBlob }[] = [];
    await this.store.transaction(async (tx) => {
      written.length = 0;
      if (!canCapture()) throw new Error('RegionManager.flushAll: capture refused');
      const world = this.world;
      const dying = new Set(world.destroyedThisTick()); // lookup only
      const writes: { id: RegionId; bytes: Uint8Array }[] = [];
      for (const id of this.sortedRecordIds()) {
        const rec = this.recs.get(id) as RegionRecord;
        if (rec.state === 'active') {
          const blob = this.snapshot(rec, this.context(), dying, world.tick);
          rec.blob = blob;
          writes.push({ id, bytes: encodeBlob(blob) });
        } else if (rec.unsaved && rec.saving === null && rec.blob !== null) {
          writes.push({ id, bytes: encodeBlob(rec.blob) });
          written.push({ rec, blob: rec.blob });
        }
      }
      const arrivals: Arrivals[] = [];
      for (const id of [...this.inboxes.keys()].sort(stringCompare)) {
        const items = this.inboxes.get(id) as SerializedEntity[];
        const rec = this.getOrCreate(id);
        // Only inactive or loading regions have arrivals; an activation merges them.
        if (items.length > 0 && rec.state !== 'active') {
          arrivals.push({ rec, items, written: items.slice(), base: rec.blob });
        }
      }

      for (const w of writes) await tx.put(BLOB_NAMESPACE, w.id, w.bytes);
      for (const a of arrivals) {
        const { rec } = a;
        // The base as of the snapshot. Evictions save through the store mutex, so the stored blob
        // cannot change before this transaction ends; rec.blob can (a load or an eviction).
        let base = a.base;
        if (base === null) {
          const bytes = await tx.get(BLOB_NAMESPACE, rec.id);
          try {
            base = decodeBlob(bytes);
          } catch (err) {
            this.log(
              'error',
              `region '${rec.id}': stored blob is unreadable; its inbox stays in memory`,
              err,
            );
            continue;
          }
        }
        const merged: RegionBlob =
          base === null || base.inboxOnly === true
            ? {
                version: 1,
                savedTick: world.tick,
                entities: [...(base?.entities ?? []), ...a.written],
                rngState: rec.def.seed >>> 0,
                inboxOnly: true,
              }
            : { ...base, savedTick: world.tick, entities: [...base.entities, ...a.written] };
        await tx.put(BLOB_NAMESPACE, rec.id, encodeBlob(merged));
        // Unless an activation merged the inbox meanwhile, the region's content is now the merged
        // blob: later activations restore the arrivals from it instead of from the inbox.
        if (this.inboxes.get(rec.id) === a.items) {
          a.items.splice(0, a.written.length);
          if (a.items.length === 0) this.inboxes.delete(rec.id);
          rec.blob = merged;
          rec.unsaved = true;
          written.push({ rec, blob: merged });
        }
      }
    });
    for (const { rec, blob } of written) if (rec.blob === blob) rec.unsaved = false;
  }

  /** Entities waiting in the inbox of `id` (docs/world.md §6.3). */
  inboxSize(id: RegionId): number {
    return this.inboxes.get(id)?.length ?? 0;
  }

  private getOrCreate(id: RegionId): RegionRecord {
    let rec = this.recs.get(id);
    if (rec === undefined) {
      const def = this.graph.get(id);
      if (def === undefined) throw new UnknownRegion(id);
      rec = {
        id,
        def,
        state: 'inactive',
        entities: [],
        rng: null,
        lingerUntil: Infinity,
        retryAt: 0,
        blob: null,
        saving: null,
        unsaved: false,
      };
      this.recs.set(id, rec);
    }
    return rec;
  }

  private sortedRecordIds(): RegionId[] {
    return [...this.recs.keys()].sort(stringCompare);
  }

  private inboxOf(id: RegionId): SerializedEntity[] {
    let items = this.inboxes.get(id);
    if (items === undefined) {
      items = [];
      this.inboxes.set(id, items);
    }
    return items;
  }

  /**
   * `inactive -> loading`. With the region's content in memory (a previous save), it activates at
   * the next `update` without touching the store; otherwise `store.get` runs and the region
   * activates at the first `update` after it resolves, or goes back to `inactive` until `retryAt`.
   */
  private startLoad(rec: RegionRecord): void {
    rec.state = 'loading';
    if (rec.blob !== null) {
      this.pendingActivations.push(rec.id);
      return;
    }
    if (this.replayExternal) return;
    const epoch = this.loadEpoch;
    const completed = (blob: RegionBlob | null, error?: unknown, fatal = false): void => {
      if (epoch !== this.loadEpoch || rec.state !== 'loading') return;
      const decision: RegionActivationDecision = {
        kind: 'region-load-result',
        regionId: rec.id,
        observedTick: this.world.tick + 1,
        outcome: error === undefined ? 'loaded' : 'failed',
        blob: cloneExactState(blob),
        ...(error === undefined ? {} : { error: String(error) }),
        ...(fatal ? { fatal: true } : {}),
      };
      if (this.pendingDecisions.length >= 100_000) {
        this.decisionOverflow = true;
        return;
      }
      this.pendingDecisions.push(decision);
    };
    let request: Promise<Uint8Array | null>;
    try {
      request = this.store.get(BLOB_NAMESPACE, rec.id);
    } catch (err) {
      request = Promise.reject(err);
    }
    request.then(
      (bytes) => {
        let blob: RegionBlob | null;
        try {
          blob = decodeBlob(bytes);
        } catch (err) {
          completed(null, err, true);
          return;
        }
        completed(blob);
      },
      (err: unknown) =>
        completed(
          null,
          err,
          typeof err === 'object' &&
            err !== null &&
            'unrecoverable' in err &&
            err.unrecoverable === true,
        ),
    );
  }

  /** `loading -> inactive` after a failed load: retried `retryTicks` after the next `update`. */
  private loadFailed(rec: RegionRecord, err: unknown): void {
    if (rec.state !== 'loading' && rec.state !== 'saving') return;
    rec.state = 'inactive';
    rec.retryAt = this.world.tick + 1 + this.retryTicks;
    this.log('error', `region '${rec.id}' failed to load; retrying in ${RETRY_MS} ms`, err);
  }

  /**
   * docs/world.md §5.3: restores `rec.blob` (checked against the registry first; a blob it cannot
   * restore fails like a load), calls `populate`, then merges arrivals: those a flush stored in an
   * `inboxOnly` blob, then the inbox. Arrivals merge even when `populate` throws.
   */
  private activate(rec: RegionRecord, ctx: SimContext): void {
    const { world, registry } = this;
    const blob = rec.blob;
    const queued = this.inboxes.get(rec.id);
    let restored: ResolvedEntity[];
    let arrived: ResolvedEntity[];
    try {
      restored = blob === null ? [] : resolveEntities(world, registry, blob.entities);
      arrived = queued === undefined ? [] : resolveEntities(world, registry, queued);
    } catch (err) {
      if (!rec.unsaved) rec.blob = null; // read the store again on retry
      this.loadFailed(rec, err);
      return;
    }
    const fresh = blob === null || blob.inboxOnly === true;

    rec.state = 'active';
    rec.lingerUntil = Infinity;
    rec.retryAt = 0;
    rec.unsaved = false;
    const rng = new Rng(rec.def.seed);
    if (blob !== null) rng.restore(blob.rngState);
    rec.rng = rng;
    insertSorted(this.activeIds, rec.id);
    if (queued !== undefined) this.inboxes.delete(rec.id);
    try {
      if (blob !== null && !fresh) {
        for (const e of createEntities(world, blob.entities, restored, rec.id)) this.record(rec, e);
      }
      this.loader.populate(rec.def, fresh ? null : blob, ctx);
    } finally {
      // Everything now in the region: what populate created, and anything created for the region
      // while it was not active.
      const store = this.regionStore;
      const ids = store.entitiesArray();
      for (let i = 0; i < ids.length; i++) {
        const e = ids[i] as EntityId;
        if (store.read(e).id === rec.id) this.record(rec, e);
      }
      // Arrivals (docs/world.md §6.3), in arrival order.
      if (blob !== null && fresh) {
        for (const e of createEntities(world, blob.entities, restored, rec.id)) this.record(rec, e);
      }
      if (queued !== undefined) {
        for (const e of createEntities(world, queued, arrived, rec.id)) this.record(rec, e);
      }
    }
  }

  /**
   * docs/world.md §5.4: `active -> saving`. Serializes the region's entities (skipping ones destroyed
   * this tick) with `onDeactivate`'s game data and the rng state, destroys them, and starts the put
   * (in a store transaction). Everything that can throw (a player in the region, `onDeactivate`, a blob that is not
   * JSON) runs before anything changes and propagates, leaving the region active with a fresh linger
   * timer, so it is tried again when that expires.
   */
  private deactivate(rec: RegionRecord, ctx: SimContext, tick: number): void {
    rec.lingerUntil = tick + this.lingerTicks;
    const world = this.world;
    const entities = rec.entities.slice();
    for (const e of entities) {
      if (this.playerSet.has(e)) {
        throw new InvariantViolation(rec.id, e, 'a region holding a player cannot be evicted');
      }
    }
    const dying = new Set(world.destroyedThisTick()); // lookup only
    const blob = this.snapshot(rec, ctx, dying, tick - 1);
    const bytes = encodeBlob(blob);
    // Keep what a load would return, so reactivating from memory equals reactivating from the store.
    const saved = decodeBlob(bytes) as RegionBlob;

    for (const e of entities) if (world.alive(e)) world.destroy(e); // applied at the end of the step
    for (const e of entities) this.unrecord(e);
    removeSorted(this.activeIds, rec.id);
    rec.rng = null;
    rec.state = 'saving';
    rec.lingerUntil = Infinity;
    rec.blob = saved;
    rec.unsaved = true;

    if (this.replayExternal) return; // completion arrives only through the recorded decision

    // Through a transaction, so a save started while flushAll writes queues behind it on the store
    // mutex (docs/persist.md 1.4) and the newer blob lands last.
    const id = rec.id;
    const epoch = this.loadEpoch;
    let request: Promise<void>;
    try {
      request = this.store.transaction((tx) => tx.put(BLOB_NAMESPACE, id, bytes));
    } catch (err) {
      request = Promise.reject(err);
    }
    rec.saving = request.then(
      () => {
        if (epoch !== this.loadEpoch) return;
        rec.saving = null;
        if (this.pendingDecisions.length >= 100_000) {
          this.decisionOverflow = true;
          return;
        }
        this.pendingDecisions.push({
          kind: 'region-save-result',
          regionId: id,
          observedTick: this.world.tick + 1,
          outcome: 'loaded',
          blob: cloneExactState(saved),
        });
      },
      (err: unknown) => {
        if (epoch !== this.loadEpoch) return;
        rec.saving = null;
        if (this.pendingDecisions.length >= 100_000) {
          this.decisionOverflow = true;
          return;
        }
        this.pendingDecisions.push({
          kind: 'region-save-result',
          regionId: id,
          observedTick: this.world.tick + 1,
          outcome: 'failed',
          blob: cloneExactState(saved),
          error: String(err),
        });
      },
    );
  }

  /**
   * The blob of an active region now: its entities' persisted components (not players, not entities
   * in `dying`), `onDeactivate`'s game data and the rng state.
   */
  private snapshot(
    rec: RegionRecord,
    ctx: SimContext,
    dying: ReadonlySet<EntityId>,
    savedTick: number,
  ): RegionBlob {
    const entities: SerializedEntity[] = [];
    for (const e of rec.entities) {
      if (dying.has(e) || this.playerSet.has(e)) continue;
      const s = serializeEntity(this.world, e);
      if (s !== null) entities.push(s);
    }
    const blob: RegionBlob = {
      version: 1,
      savedTick,
      entities,
      rngState: (rec.rng as Rng).state(),
    };
    if (this.loader.onDeactivate !== undefined) {
      const gameData = this.loader.onDeactivate(rec.def, ctx);
      if (gameData !== undefined) blob.gameData = gameData;
    }
    return blob;
  }

  /**
   * Records every entity whose `Region` was added or written since the previous pass, found through
   * the store's version stamps (docs/sim.md 2.3): in the record of its region when that region is
   * active, else in none. This is how entities created by hooks and systems reach `entitiesIn`.
   */
  private track(): void {
    const world = this.world;
    const store = this.regionStore;
    const from = this.scanFrom;
    // Every write from now on is stamped at least the current stamp tick.
    this.scanFrom = world.stepping ? world.tick : world.tick + 1;
    const versions = store.version;
    const ids = store.entitiesArray();
    for (let i = 0; i < ids.length; i++) {
      const e = ids[i] as EntityId;
      if ((versions[e & SLOT_MASK] as number) < from) continue;
      const rec = this.recs.get(store.read(e).id);
      if (rec !== undefined && rec.state === 'active') this.record(rec, e);
      else this.unrecord(e);
    }
  }

  /** Lists `e` in `rec`, and in no other record. */
  private record(rec: RegionRecord, e: EntityId): void {
    const old = this.recordedIn.get(e);
    if (old !== undefined && old !== rec) removeSorted(old.entities, e);
    insertSorted(rec.entities, e);
    this.recordedIn.set(e, rec);
  }

  /** Removes `e` from the record listing it, if any. */
  private unrecord(e: EntityId): void {
    const old = this.recordedIn.get(e);
    if (old === undefined) return;
    removeSorted(old.entities, e);
    this.recordedIn.delete(e);
  }

  private relocate(
    e: EntityId,
    from: RegionId,
    to: RegionRecord,
    localPos: Readonly<Vec3> | null,
    events: EventBus,
  ): void {
    const world = this.world;
    if (localPos !== null) v3.copy(localPos, world.write(e, Transform).pos);
    world.write(e, Region).id = to.id; // a write, so it replicates
    this.record(to, e);
    events.emit(RegionChanged, { entity: e, from, to: to.id });
  }

  /** The last context seen. A region only becomes active inside `update`, which sets it. */
  private context(): SimContext {
    if (this.ctx === null) throw new Error('RegionManager: no SimContext yet; call update first');
    return this.ctx;
  }

  private events(): EventBus {
    return this.context().events;
  }
}

/** The `Transform` value of a serialized entity, if it has one. */
function transformOf(s: SerializedEntity): { pos: Vec3 } | undefined {
  for (const [name, value] of s.components) {
    if (name === Transform.name) return value as { pos: Vec3 };
  }
  return undefined;
}
