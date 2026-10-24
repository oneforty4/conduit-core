import { cloneExactState, type WorldCheckpoint } from './checkpoint.ts';
import type { DeepReadonly } from './readonly.ts';
import { ByteWriter, type ComponentLike, type SchemaRegistry } from '@conduit/protocol';
import type { ComponentType } from './component.ts';
import {
  type EntityId,
  genOf,
  LOCAL_BIT,
  makeId,
  MAX_SLOTS,
  SERVER_GEN_WRAP,
  SLOT_MASK,
} from './entity.ts';
import { StaleEntity, UnknownComponent } from './errors.ts';
import { hashWorld } from './hash.ts';
import { ComponentStore } from './store.ts';

const DEFAULT_CAPACITY = 1024;

function isComponentType(c: ComponentLike | undefined): c is ComponentType<unknown> {
  const t = c as Partial<ComponentType<unknown>> | undefined;
  return (
    t !== undefined &&
    typeof t.create === 'function' &&
    typeof t.copy === 'function' &&
    typeof t.copyField === 'function'
  );
}

/**
 * The entity table plus one `ComponentStore` per registry component (docs/sim.md 2.2, 2.6).
 * Destroys are deferred to `applyDestroys` (pipeline step 4).
 */
export class World {
  /** 0 until the first step; advanced by `Simulation.step`. */
  tick = 0;
  /**
   * True while `Simulation.step` runs (set by the Simulation). Store writes are stamped with `tick`
   * while stepping and with `tick + 1` between steps: a write made between steps (Session lifecycle,
   * hooks, `regions.update`) belongs to the coming tick (docs/sim.md 2.3).
   */
  stepping = false;
  readonly registry: SchemaRegistry;
  readonly mutationGuards: boolean;

  private capacity: number;
  /** Highest allocated slot + 1; slot 0 is reserved. */
  private highWater = 1;
  private generation: Uint16Array;
  private allocated: Uint8Array;
  private pendingFlag: Uint8Array;
  /** LIFO stack of released slots. */
  private readonly freeList: number[] = [];
  /** Entity ids queued this tick, in call order. */
  private readonly pendingDestroy: EntityId[] = [];
  private live = 0;
  /** Index = component id. */
  private readonly storeList: ComponentStore<unknown>[] = [];
  /** Registry-local resolution cache; canonical definitions are preloaded. */
  private readonly storeIndex = new Map<ComponentType<unknown>, number>();
  /** Scratch for `queryInto`, reset on every call. */
  private readonly queryStores: ComponentStore<unknown>[] = [];
  /** The single reusable writer `hash()` encodes into. */
  private readonly hashWriter = new ByteWriter(256);

  /**
   * Creates every store eagerly, in component id order. Registry components must be
   * `defineComponent` types. Definition objects are never assigned a global ID.
   */
  constructor(
    registry: SchemaRegistry,
    opts: { capacity?: number; mutationGuards?: boolean } = {},
  ) {
    const capacity = opts.capacity ?? DEFAULT_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > MAX_SLOTS) {
      throw new RangeError(`World: capacity must be an integer in 1..${MAX_SLOTS}`);
    }
    this.registry = registry;
    this.mutationGuards = opts.mutationGuards ?? false;
    this.capacity = capacity;
    this.generation = new Uint16Array(capacity);
    this.allocated = new Uint8Array(capacity);
    this.pendingFlag = new Uint8Array(capacity);
    const components = registry.components;
    for (let i = 0; i < components.length; i++) {
      const c = components[i];
      if (!isComponentType(c)) {
        throw new TypeError(
          `World: registry component ${String(c?.name)} is not a ComponentType (use defineComponent)`,
        );
      }
      this.storeList.push(new ComponentStore(this, c, capacity));
      this.storeIndex.set(c, i);
    }
  }

  create(): EntityId {
    let slot = this.freeList.pop();
    if (slot === undefined) {
      if (this.highWater >= MAX_SLOTS) {
        throw new RangeError(`World: all ${MAX_SLOTS - 1} entity slots are in use`);
      }
      slot = this.highWater++;
      if (slot >= this.capacity) this.grow(Math.min(this.capacity * 2, MAX_SLOTS));
    }
    this.allocated[slot] = 1;
    this.live++;
    return makeId(slot, this.generation[slot] as number);
  }

  /** Deferred: the entity stays alive, with its components, until `applyDestroys`. Idempotent. */
  destroy(e: EntityId): void {
    if (!this.alive(e)) throw new StaleEntity(e);
    const slot = e & SLOT_MASK;
    if (this.pendingFlag[slot] === 1) return;
    this.pendingFlag[slot] = 1;
    this.pendingDestroy.push(e);
  }

  alive(e: EntityId): boolean {
    if (e >>> 0 !== e || (e & LOCAL_BIT) !== 0) return false;
    const slot = e & SLOT_MASK;
    return (
      slot < this.highWater && this.allocated[slot] === 1 && this.generation[slot] === genOf(e)
    );
  }

  /** Entities queued for destroy this tick, in call order; valid until `applyDestroys`. */
  destroyedThisTick(): readonly EntityId[] {
    return this.pendingDestroy;
  }

  /** Pipeline step 4: removes every component of each queued entity, then frees its slot. */
  applyDestroys(): void {
    const pending = this.pendingDestroy;
    const stores = this.storeList;
    for (let i = 0; i < pending.length; i++) {
      const e = pending[i] as EntityId;
      for (let k = 0; k < stores.length; k++) {
        const store = stores[k] as ComponentStore<unknown>;
        if (store.has(e)) store.remove(e);
      }
      const slot = e & SLOT_MASK;
      this.generation[slot] = ((this.generation[slot] as number) + 1) % SERVER_GEN_WRAP;
      this.allocated[slot] = 0;
      this.pendingFlag[slot] = 0;
      this.freeList.push(slot);
      this.live--;
    }
    pending.length = 0;
  }

  /** Throws `UnknownComponent` if `c` is not one of the registry's components. */
  store<T>(c: ComponentType<T>): ComponentStore<T> {
    return this.storeList[this.indexOf(c)] as ComponentStore<T>;
  }

  /** Component id order. */
  stores(): readonly ComponentStore<unknown>[] {
    return this.storeList;
  }

  add<T>(e: EntityId, c: ComponentType<T>, v?: Partial<T>): T {
    return this.store(c).add(e, v);
  }

  get<T>(e: EntityId, c: ComponentType<T>): DeepReadonly<T> {
    return this.store(c).read(e);
  }

  tryGet<T>(e: EntityId, c: ComponentType<T>): DeepReadonly<T> | undefined {
    return this.store(c).tryRead(e);
  }

  write<T>(e: EntityId, c: ComponentType<T>): T {
    return this.store(c).write(e);
  }

  mutate<T>(e: EntityId, c: ComponentType<T>, update: (value: T) => void): void {
    this.store(c).mutate(e, update);
  }

  has(e: EntityId, c: ComponentType<unknown>): boolean {
    return this.store(c).has(e);
  }

  remove(e: EntityId, c: ComponentType<unknown>): boolean {
    return this.store(c).remove(e);
  }

  /**
   * Entities having every component in `cs`, in ascending slot order. Iterates the smallest store
   * (ties: lowest component id) and re-probes every store before yielding, so entities that lose a
   * component mid-iteration are skipped and entities that gain one are not visited. With no
   * components: every alive entity at the time iteration starts.
   */
  query(...cs: ComponentType<unknown>[]): Iterable<EntityId> {
    if (cs.length === 0) return this.iterateAll();
    const stores = cs.map((c) => this.storeList[this.indexOf(c)] as ComponentStore<unknown>);
    return this.iterateStores(stores);
  }

  /** Like `query`, into `out` (its length is reset to 0 first); allocation-free. */
  queryInto(out: EntityId[], ...cs: ComponentType<unknown>[]): EntityId[] {
    out.length = 0;
    if (cs.length === 0) {
      const highWater = this.highWater;
      for (let slot = 1; slot < highWater; slot++) {
        if (this.allocated[slot] === 1) out.push(makeId(slot, this.generation[slot] as number));
      }
      return out;
    }
    const stores = this.queryStores;
    stores.length = 0;
    for (let k = 0; k < cs.length; k++) {
      stores.push(this.storeList[this.indexOf(cs[k] as ComponentType<unknown>)]!);
    }
    const order = primaryOf(stores).entitiesArray();
    for (let i = 0; i < order.length; i++) {
      const e = order[i] as EntityId;
      if (hasAll(stores, e)) out.push(e);
    }
    stores.length = 0;
    return out;
  }

  /** Allocated entities. */
  count(): number {
    return this.live;
  }

  /** `hashWorld(this)` using this World's reusable writer. */
  hash(): number {
    return hashWorld(this, this.hashWriter);
  }

  /** Full raw continuation state; application persist-only region saves are a different contract. */
  captureCheckpoint(): WorldCheckpoint {
    if (this.stepping) throw new Error('World.captureCheckpoint: requires completed tick boundary');
    return {
      version: 1,
      tick: this.tick,
      capacity: this.capacity,
      highWater: this.highWater,
      live: this.live,
      generations: Array.from(this.generation),
      allocated: Array.from(this.allocated),
      pendingFlags: Array.from(this.pendingFlag),
      freeList: [...this.freeList],
      pendingDestroy: [...this.pendingDestroy],
      stores: this.storeList.map((store) => store.captureCheckpoint()),
    };
  }

  /** Validates a detached image in isolation before changing this world. */
  restoreCheckpoint(input: WorldCheckpoint): void {
    if (this.stepping) throw new Error('World.restoreCheckpoint: not while stepping');
    const state = cloneExactState(input);
    if (
      state.version !== 1 ||
      !Number.isSafeInteger(state.tick) ||
      state.tick < 0 ||
      !Number.isInteger(state.capacity) ||
      state.capacity < 1 ||
      state.capacity > MAX_SLOTS ||
      !Number.isInteger(state.highWater) ||
      state.highWater < 1 ||
      state.highWater > state.capacity ||
      state.stores.length !== this.storeList.length
    )
      throw new TypeError('Invalid World checkpoint header');
    const restored = new World(this.registry, {
      capacity: state.capacity,
      mutationGuards: this.mutationGuards,
    });
    restored.tick = state.tick;
    restored.highWater = state.highWater;
    if (
      state.generations.length !== state.capacity ||
      state.allocated.length !== state.capacity ||
      state.pendingFlags.length !== state.capacity
    )
      throw new TypeError('Invalid World checkpoint allocator lengths');
    for (let slot = 0; slot < state.capacity; slot++) {
      const generation = state.generations[slot]!;
      if (
        !Number.isInteger(generation) ||
        generation < 0 ||
        generation >= SERVER_GEN_WRAP ||
        (state.allocated[slot] !== 0 && state.allocated[slot] !== 1) ||
        (state.pendingFlags[slot] !== 0 && state.pendingFlags[slot] !== 1) ||
        (slot >= state.highWater && (state.allocated[slot] !== 0 || state.pendingFlags[slot] !== 0))
      )
        throw new TypeError(`Invalid World checkpoint slot ${slot}`);
    }
    restored.generation.set(state.generations);
    restored.allocated.set(state.allocated);
    restored.pendingFlag.set(state.pendingFlags);
    restored.live = state.allocated.reduce((n, flag) => n + flag, 0);
    if (state.allocated[0] !== 0 || restored.live !== state.live)
      throw new TypeError('Invalid World checkpoint live count');
    const free = new Set<number>();
    for (const slot of state.freeList) {
      if (
        !Number.isInteger(slot) ||
        slot <= 0 ||
        slot >= state.highWater ||
        state.allocated[slot] !== 0 ||
        free.has(slot)
      )
        throw new TypeError('Invalid World checkpoint free-list');
      free.add(slot);
      restored.freeList.push(slot);
    }
    for (let slot = 1; slot < state.highWater; slot++)
      if (state.allocated[slot] === 0 && !free.has(slot))
        throw new TypeError('Incomplete World checkpoint free-list');
    const pending = new Set<number>();
    for (const entity of state.pendingDestroy) {
      if (
        !restored.alive(entity) ||
        pending.has(entity) ||
        state.pendingFlags[entity & SLOT_MASK] !== 1
      )
        throw new TypeError('Invalid World checkpoint pending destruction');
      pending.add(entity);
      restored.pendingDestroy.push(entity);
    }
    for (let slot = 1; slot < state.highWater; slot++)
      if (state.pendingFlags[slot] === 1 && !pending.has(makeId(slot, state.generations[slot]!)))
        throw new TypeError('Incomplete World checkpoint pending destruction');
    for (let i = 0; i < state.stores.length; i++) {
      if (
        state.stores[i]!.versions.length !== state.capacity ||
        state.stores[i]!.removedAt.length !== state.capacity
      )
        throw new TypeError('Invalid checkpoint store stamp lengths');
      restored.storeList[i]!.restoreCheckpoint(state.stores[i]!);
    }
    this.tick = restored.tick;
    this.capacity = restored.capacity;
    this.highWater = restored.highWater;
    this.generation = restored.generation;
    this.allocated = restored.allocated;
    this.pendingFlag = restored.pendingFlag;
    // These lists may contain up to MAX_SLOTS entries, beyond engine call-argument limits.
    this.freeList.length = 0;
    for (const slot of restored.freeList) this.freeList.push(slot);
    this.pendingDestroy.length = 0;
    for (const entity of restored.pendingDestroy) this.pendingDestroy.push(entity);
    this.live = restored.live;
    // Keep store identities used by systems/region managers while installing validated detached data.
    for (let i = 0; i < state.stores.length; i++) {
      this.storeList[i]!._grow(state.capacity);
      this.storeList[i]!.restoreCheckpoint(state.stores[i]!);
    }
  }

  private indexOf(c: ComponentType<unknown>): number {
    const cached = this.storeIndex.get(c);
    if (cached !== undefined) return cached;
    let index: number;
    try {
      index = this.registry.componentId(c);
    } catch (cause) {
      throw new UnknownComponent(`${String(c.name)}: ${String(cause)}`);
    }
    return index;
  }

  private *iterateAll(): Generator<EntityId, void, undefined> {
    const ids = this.queryInto([]);
    for (let i = 0; i < ids.length; i++) {
      const e = ids[i] as EntityId;
      if (this.alive(e)) yield e;
    }
  }

  private *iterateStores(stores: ComponentStore<unknown>[]): Generator<EntityId, void, undefined> {
    const order = primaryOf(stores).entitiesArray();
    for (let i = 0; i < order.length; i++) {
      const e = order[i] as EntityId;
      if (hasAll(stores, e)) yield e;
    }
  }

  private grow(capacity: number): void {
    const generation = new Uint16Array(capacity);
    generation.set(this.generation);
    this.generation = generation;
    const allocated = new Uint8Array(capacity);
    allocated.set(this.allocated);
    this.allocated = allocated;
    const pendingFlag = new Uint8Array(capacity);
    pendingFlag.set(this.pendingFlag);
    this.pendingFlag = pendingFlag;
    this.capacity = capacity;
    for (const store of this.storeList) store._grow(capacity);
  }
}

/** The store with the smallest size; ties go to the lowest component id. */
function primaryOf(stores: readonly ComponentStore<unknown>[]): ComponentStore<unknown> {
  let best = stores[0] as ComponentStore<unknown>;
  for (let k = 1; k < stores.length; k++) {
    const s = stores[k] as ComponentStore<unknown>;
    if (s.size < best.size || (s.size === best.size && s.type.name < best.type.name)) best = s;
  }
  return best;
}

function hasAll(stores: readonly ComponentStore<unknown>[], e: EntityId): boolean {
  for (let k = 0; k < stores.length; k++) {
    if (!(stores[k] as ComponentStore<unknown>).has(e)) return false;
  }
  return true;
}
