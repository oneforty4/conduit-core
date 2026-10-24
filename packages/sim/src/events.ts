import { cloneExactState } from './checkpoint.ts';
import { assertFiniteData, guardView, type DeepReadonly } from './readonly.ts';
import {
  assertName,
  defineSchema,
  type EventDef,
  f,
  type FieldMap,
  type Infer,
  type Schema,
  type SchemaRegistry,
} from '@conduit/protocol';
import { buildCopy, buildCreate } from './component.ts';
import type { RegionId } from './context.ts';

export interface EventOpts {
  /** Default `true` (unlike protocol's `defineEvent`, whose default is `false`). */
  replicate?: boolean;
}

/** An event definition. Structurally a protocol `EventDef`, so it can go in `RegistryInput.events`. */
export interface EventType<T> {
  readonly name: string;
  readonly schema: Schema<T>;
  readonly replicate: boolean;
  create(): T;
  copy(dst: T, src: DeepReadonly<T>): T;
}

export function defineEvent<F extends FieldMap>(
  name: string,
  fields: F,
  opts: EventOpts = {},
): EventType<Infer<F>> {
  assertName(name);
  let schema: Schema<Infer<F>>;
  try {
    schema = defineSchema(fields);
  } catch (err) {
    if (err instanceof RangeError) throw new RangeError(`event ${name}: ${err.message}`);
    throw err;
  }
  return Object.freeze({
    name,
    schema,
    replicate: opts.replicate ?? true,
    create: buildCreate(schema),
    copy: buildCopy(schema),
  });
}

export interface Emitted<T> {
  readonly tick: number;
  readonly regionId: RegionId | undefined;
  readonly payload: DeepReadonly<T>;
}

export interface ReplicatedEvent {
  typeId: number;
  tick: number;
  regionId: RegionId | undefined;
  payload: unknown;
}

/** Most replicated events the outbox holds between drains; older ones are dropped and counted. */
export const MAX_OUTBOX = 4096;

/** Core local event emitted by region membership and migration (docs/world.md 6). */
export const RegionChanged = defineEvent(
  'RegionChanged',
  { entity: f.entity(), from: f.str(64), to: f.str(64) },
  { replicate: false },
);

/**
 * Per-tick event lists plus the replicated outbox (docs/sim.md 2.8). Event ids are the registry's
 * ids; `emit` stamps `source.tick` (the World's tick).
 */
export class EventBus {
  private readonly source: { readonly tick: number; readonly mutationGuards?: boolean };
  /** Index = event id: this tick's events, in emit order. */
  private readonly perType: Emitted<unknown>[][] = [];
  private readonly replicated: boolean[] = [];
  private readonly registry: SchemaRegistry;
  private readonly readViews = new WeakMap<object, object>();
  private outbox: ReplicatedEvent[] = [];
  private dropped = 0;

  /**
   * One list per registry event. Definitions remain immutable and IDs belong to the registry.
   */
  constructor(source: {
    readonly tick: number;
    readonly registry: SchemaRegistry;
    readonly mutationGuards?: boolean;
  }) {
    this.source = source;
    const defs = source.registry.events;
    this.registry = source.registry;
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i] as EventDef;
      this.perType.push([]);
      this.replicated.push(def.replicate === true);
    }
  }

  /** Events dropped from the outbox because it exceeded `MAX_OUTBOX`. */
  get droppedEvents(): number {
    return this.dropped;
  }

  /** Copies `payload` by value and appends it to this tick's list for `type`. */
  emit<T>(type: EventType<T>, payload: T | DeepReadonly<T>, regionId?: RegionId): void {
    const list = this.perType[this.idOf(type)] as Emitted<T>[];
    assertFiniteData(payload, `event ${type.name}`);
    const copied = type.copy(type.create(), payload as DeepReadonly<T>);
    list.push({
      tick: this.source.tick,
      regionId,
      payload: (this.source.mutationGuards
        ? guardView(copied, () => {}, false)
        : copied) as DeepReadonly<T>,
    });
  }

  /**
   * Everything emitted for `type` so far this tick (including earlier in the same phase and system),
   * in emit order. Entries are not removed; every consumer sees the same list until `endTick`.
   */
  consume<T>(type: EventType<T>): ReadonlyArray<Emitted<T>> {
    const list = this.perType[this.idOf(type)] as Emitted<T>[];
    return this.source.mutationGuards ? guardView(list, () => {}, false, this.readViews) : list;
  }

  /**
   * Pipeline step 5: appends replicated events to the outbox (event id order, then emit order),
   * drops the oldest beyond `MAX_OUTBOX`, then clears every per-type list.
   */
  endTick(): void {
    const outbox = this.outbox;
    for (let id = 0; id < this.perType.length; id++) {
      const list = this.perType[id] as Emitted<unknown>[];
      if (list.length === 0) continue;
      if (this.replicated[id] === true) {
        for (let i = 0; i < list.length; i++) {
          const ev = list[i] as Emitted<unknown>;
          outbox.push({ typeId: id, tick: ev.tick, regionId: ev.regionId, payload: ev.payload });
        }
      }
      list.length = 0;
    }
    const excess = outbox.length - MAX_OUTBOX;
    if (excess > 0) {
      outbox.splice(0, excess);
      this.dropped += excess;
    }
  }

  /** Returns the outbox and replaces it with an empty one. */
  drainOutbox(): ReplicatedEvent[] {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  captureCheckpoint(): EventCheckpoint {
    return cloneExactState({
      version: 1,
      names: this.registry.events.map((def) => def.name),
      perType: this.perType,
      outbox: this.outbox,
      dropped: this.dropped,
    });
  }

  validateCheckpoint(state: EventCheckpoint): void {
    if (
      state.version !== 1 ||
      state.names.length !== this.registry.events.length ||
      state.perType.length !== this.registry.events.length ||
      state.names.some((name, index) => name !== this.registry.events[index]?.name) ||
      !Number.isSafeInteger(state.dropped) ||
      state.dropped < 0 ||
      state.outbox.length > MAX_OUTBOX
    )
      throw new TypeError('Invalid event checkpoint');
    for (const event of state.outbox)
      if (
        !Number.isInteger(event.typeId) ||
        this.registry.events[event.typeId] === undefined ||
        !Number.isSafeInteger(event.tick) ||
        event.tick < 0
      )
        throw new TypeError('Invalid event checkpoint outbox');
    cloneExactState(state);
  }

  restoreCheckpoint(input: EventCheckpoint): void {
    const state = cloneExactState(input);
    this.validateCheckpoint(state);
    for (let i = 0; i < state.perType.length; i++) this.perType[i] = [...state.perType[i]!];
    this.outbox = [...state.outbox];
    this.dropped = state.dropped;
  }

  private idOf(type: EventType<unknown>): number {
    return this.registry.eventId(type);
  }
}

export interface EventCheckpoint {
  readonly version: 1;
  readonly names: readonly string[];
  readonly perType: readonly (readonly Emitted<unknown>[])[];
  readonly outbox: readonly ReplicatedEvent[];
  readonly dropped: number;
}
