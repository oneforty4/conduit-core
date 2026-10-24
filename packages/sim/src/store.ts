import { cloneExactState, firstStateDifference, type StoreCheckpoint } from './checkpoint.ts';
import { compileFiniteDataCheck, guardView, type DeepReadonly } from './readonly.ts';
import type { ComponentType } from './component.ts';
import { type EntityId, SLOT_MASK } from './entity.ts';
import { AlreadyPresent, MissingComponent, StaleEntity } from './errors.ts';

/** The part of `World` a store needs: the tick and step flag for stamps, and the liveness check. */
interface StoreHost {
  readonly tick: number;
  readonly stepping: boolean;
  readonly mutationGuards?: boolean;
  alive(e: EntityId): boolean;
}

const INITIAL_DENSE = 16;
const EMPTY_ORDER = new Uint32Array(0);

function ascending(a: number, b: number): number {
  return a - b;
}

/**
 * Sparse-set storage for one component type (docs/sim.md 2.3). Created by `World` only, one per
 * registry component. `version`, `removedAt` and `sparse` are per slot and are reallocated when the
 * World grows, so read them through the store each time rather than caching the arrays.
 */
export class ComponentStore<T> {
  readonly type: ComponentType<T>;
  private readonly host: StoreHost;
  /** Entity ids, unordered (swap-remove). */
  private dense: Uint32Array;
  /** Parallel to `dense`. */
  private readonly values: T[] = [];
  /** Slot -> dense index, -1 when absent. */
  private sparse: Int32Array;
  private versions: Uint32Array;
  private removed: Uint32Array;
  private count = 0;
  private readonly validateValue: (value: unknown) => void;
  private readonly readCache = new WeakMap<object, object>();
  /** Ascending-slot copy of `dense[0, count)`, rebuilt lazily. */
  private order: Uint32Array = EMPTY_ORDER;
  private orderDirty = false;

  /** `capacity` is the World's current entity capacity (the length of every per-slot array). */
  constructor(host: StoreHost, type: ComponentType<T>, capacity: number) {
    this.host = host;
    this.type = type;
    this.validateValue = compileFiniteDataCheck(type.name, type.fields);
    this.dense = new Uint32Array(INITIAL_DENSE);
    this.sparse = new Int32Array(capacity).fill(-1);
    this.versions = new Uint32Array(capacity);
    this.removed = new Uint32Array(capacity);
  }

  /** Per slot: tick of the last write while present (monotonic while present); 0 when absent. */
  get version(): Uint32Array {
    return this.versions;
  }

  /** Per slot: tick of the last remove; monotonic, never cleared. */
  get removedAt(): Uint32Array {
    return this.removed;
  }

  get size(): number {
    return this.count;
  }

  has(e: EntityId): boolean {
    return this.host.alive(e) && (this.sparse[e & SLOT_MASK] as number) >= 0;
  }

  /** The stamp for a write now: `tick` inside `Simulation.step`, `tick + 1` between steps. */
  private stamp(): number {
    const host = this.host;
    return host.stepping ? host.tick : host.tick + 1;
  }

  /** Dense index of `e`, or -1 when absent. Throws `StaleEntity` if `e` is not alive. */
  private indexOf(e: EntityId): number {
    if (!this.host.alive(e)) throw new StaleEntity(e);
    return this.sparse[e & SLOT_MASK] as number;
  }

  /** The live object, typed read-only; no stamp. */
  read(e: EntityId): DeepReadonly<T> {
    const i = this.indexOf(e);
    if (i < 0) throw new MissingComponent(this.type.name, e);
    return this.view(this.values[i] as T);
  }

  tryRead(e: EntityId): DeepReadonly<T> | undefined {
    if (!this.host.alive(e)) return undefined;
    const i = this.sparse[e & SLOT_MASK] as number;
    return i < 0 ? undefined : this.view(this.values[i] as T);
  }

  private view(value: T): DeepReadonly<T> {
    return (
      this.host.mutationGuards ? guardView(value, () => {}, false, this.readCache) : value
    ) as DeepReadonly<T>;
  }

  /** Mutable access lasts only for the synchronous callback. */
  mutate(e: EntityId, update: (value: T) => void): void {
    const i = this.indexOf(e);
    if (i < 0) throw new MissingComponent(this.type.name, e);
    this.versions[e & SLOT_MASK] = this.stamp();
    const value = this.values[i] as T;
    if (this.host.mutationGuards) this.guardedMutate(value, update);
    else {
      const result: unknown = update(value);
      if (result !== undefined)
        throw new TypeError('mutate callback must be synchronous and return void');
      this.validateValue(value);
    }
  }

  private guardedMutate(value: T, update: (value: T) => void): void {
    let active = true;
    const guarded = guardView(
      value,
      () => {
        if (!active) throw new TypeError(`${this.type.name}: mutable scope expired`);
      },
      true,
    );
    try {
      const result: unknown = update(guarded);
      if (result !== undefined)
        throw new TypeError('mutate callback must be synchronous and return void');
      this.validateValue(value);
    } finally {
      active = false;
    }
  }

  /** Stamps `version` and returns the live object. */
  write(e: EntityId): T {
    const i = this.indexOf(e);
    if (i < 0) throw new MissingComponent(this.type.name, e);
    this.versions[e & SLOT_MASK] = this.stamp();
    const value = this.values[i] as T;
    return this.host.mutationGuards ? this.guardedWrite(e, value) : value;
  }

  private guardedWrite(e: EntityId, value: T): T {
    const tick = this.host.tick;
    return guardView(
      value,
      () => {
        if (this.host.tick !== tick || !this.has(e) || this.values[this.indexOf(e)] !== value)
          throw new TypeError(`${this.type.name}: mutable reference expired; call write again`);
      },
      true,
    );
  }

  /** Validate tracked writes at the simulation commit boundary, including legacy write(). */
  validateWrites(): void {
    for (let i = 0; i < this.count; i++) {
      if (this.versions[this.dense[i]! & SLOT_MASK] === this.host.tick)
        this.validateValue(this.values[i]);
    }
  }

  /** Deep-copies `v` into the live object (`type.copy`) and stamps `version`. */
  set(e: EntityId, v: DeepReadonly<T>): void {
    const i = this.indexOf(e);
    if (i < 0) throw new MissingComponent(this.type.name, e);
    this.validateValue(v);
    this.type.copy(this.values[i] as T, v);
    this.versions[e & SLOT_MASK] = this.stamp();
  }

  /**
   * Adds the component with schema defaults, then copies by value every field `v` has as an own
   * property (walked in field declaration order; other keys are ignored). Stamps `version`;
   * `removedAt` is untouched.
   */
  add(e: EntityId, v?: Partial<T>): T {
    if (this.indexOf(e) >= 0) throw new AlreadyPresent(this.type.name, e);
    const type = this.type;
    const obj = type.create();
    if (v !== undefined) {
      for (const name of type.schema.fieldNames) {
        if (Object.hasOwn(v, name)) type.copyField(name as keyof T, obj, v);
      }
    }
    this.validateValue(obj);
    const i = this.count;
    if (i === this.dense.length) {
      const grown = new Uint32Array(this.dense.length * 2);
      grown.set(this.dense);
      this.dense = grown;
    }
    const slot = e & SLOT_MASK;
    this.dense[i] = e;
    this.values.push(obj);
    this.sparse[slot] = i;
    this.count = i + 1;
    this.versions[slot] = this.stamp();
    this.orderDirty = true;
    return this.host.mutationGuards ? this.write(e) : obj;
  }

  /** Swap-remove. Returns `false` if absent; stamps `removedAt` and clears `version`. */
  remove(e: EntityId): boolean {
    const i = this.indexOf(e);
    if (i < 0) return false;
    const last = this.count - 1;
    if (i !== last) {
      const moved = this.dense[last] as number;
      this.dense[i] = moved;
      this.values[i] = this.values[last] as T;
      this.sparse[moved & SLOT_MASK] = i;
    }
    this.values.length = last;
    this.count = last;
    const slot = e & SLOT_MASK;
    this.sparse[slot] = -1;
    this.removed[slot] = this.stamp();
    this.versions[slot] = 0;
    this.orderDirty = true;
    return true;
  }

  /**
   * Entities in ascending slot order. The iterable is the current order array: a later mutation
   * builds a new array, so an in-flight loop is never disturbed (adds are not visited; callers
   * re-probe `has` to skip removes, as `World.query` does).
   */
  entities(): Iterable<EntityId> {
    return this.entitiesArray();
  }

  /** The ascending-slot order array. Do not mutate; valid until the next mutation. */
  entitiesArray(): Uint32Array {
    if (this.orderDirty) {
      const n = this.count;
      const dense = this.dense;
      const out = n === 0 ? EMPTY_ORDER : new Uint32Array(n);
      // Sort the slots (unique within a store), then map each back to its id through `sparse`.
      // Sorting the ids themselves would order by generation first, not by slot.
      for (let i = 0; i < n; i++) out[i] = (dense[i] as number) & SLOT_MASK;
      out.sort(ascending);
      for (let i = 0; i < n; i++) out[i] = dense[this.sparse[out[i] as number] as number] as number;
      this.order = out;
      this.orderDirty = false;
    }
    return this.order;
  }

  /** Removes every entity, stamping `removedAt` for each. */
  clear(): void {
    const tick = this.stamp();
    for (let i = 0; i < this.count; i++) {
      const slot = (this.dense[i] as number) & SLOT_MASK;
      this.sparse[slot] = -1;
      this.removed[slot] = tick;
      this.versions[slot] = 0;
    }
    this.values.length = 0;
    if (this.count > 0) this.orderDirty = true;
    this.count = 0;
  }

  /** Exact continuation state, detached from the live store. */
  captureCheckpoint(): StoreCheckpoint {
    return cloneExactState({
      name: this.type.name,
      entities: Array.from(this.dense.subarray(0, this.count)),
      values: this.values,
      versions: Array.from(this.versions),
      removedAt: Array.from(this.removed),
    });
  }

  /** World validates allocator state first and restores into an isolated temporary World. */
  restoreCheckpoint(state: StoreCheckpoint): void {
    if (
      state.name !== this.type.name ||
      state.entities.length !== state.values.length ||
      state.versions.length !== state.removedAt.length
    )
      throw new TypeError(`Checkpoint store ${this.type.name} shape mismatch`);
    const seen = new Set<number>();
    for (const entity of state.entities) {
      if (!this.host.alive(entity) || seen.has(entity))
        throw new TypeError(`Checkpoint store ${this.type.name}: invalid entity ${entity}`);
      seen.add(entity);
    }
    for (const stamp of [...state.versions, ...state.removedAt])
      if (!Number.isInteger(stamp) || stamp < 0 || stamp > 0xffffffff)
        throw new TypeError(`Checkpoint store ${this.type.name}: invalid stamp`);
    this.dense = new Uint32Array(Math.max(INITIAL_DENSE, state.entities.length));
    this.dense.set(state.entities);
    this.values.length = 0;
    for (const value of state.values) {
      // Schema copying validates structural access while retaining raw numeric values.
      this.validateValue(value);
      const copied = this.type.copy(this.type.create(), value as DeepReadonly<T>);
      const difference = firstStateDifference(value, copied);
      if (difference !== null)
        throw new TypeError(
          `Checkpoint ${this.type.name}${difference.path}: schema shape mismatch`,
        );
      this.values.push(copied);
    }
    this.count = state.entities.length;
    this.sparse = new Int32Array(state.versions.length).fill(-1);
    for (let i = 0; i < this.count; i++) this.sparse[this.dense[i]! & SLOT_MASK] = i;
    this.versions = new Uint32Array(state.versions);
    this.removed = new Uint32Array(state.removedAt);
    this.orderDirty = true;
  }

  /** Called by `World` only: grows the per-slot arrays to `capacity`. */
  _grow(capacity: number): void {
    if (capacity <= this.sparse.length) return;
    const sparse = new Int32Array(capacity).fill(-1);
    sparse.set(this.sparse);
    this.sparse = sparse;
    const versions = new Uint32Array(capacity);
    versions.set(this.versions);
    this.versions = versions;
    const removed = new Uint32Array(capacity);
    removed.set(this.removed);
    this.removed = removed;
  }
}
