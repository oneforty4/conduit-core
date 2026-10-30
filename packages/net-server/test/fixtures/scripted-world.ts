import { readFileSync } from 'node:fs';
import {
  defineInput,
  type EntityId,
  f,
  SchemaRegistry,
  type SnapshotData,
} from '@conduit/protocol';
import { CORE_COMPONENTS, SLOT_MASK } from '@conduit/sim';
import {
  buildSnapshot,
  commitSnapshot,
  type ReplicationState,
  type SnapshotSource,
  type SnapshotStore,
} from '../../src/snapshot-builder.ts';

/**
 * Snapshot timeline fixtures (`*.json` in this directory), shared with
 * `packages/net-client/test/replica-world.test.ts`.
 *
 * A timeline scripts one server world tick by tick. The registry is `CORE_COMPONENTS`
 * (`Model`, `Name`, `Owner`, `Region`, `Transform`: ids 0..4 by sorted name, all replicated) and the
 * input schema `{ tick: u32 }`. Ops listed under tick T are stamped T (`version` on a write,
 * `removedAt` on a remove). An entity belongs to the region named by its `Region` component. After
 * the ops of a tick with `tick % snapshotEvery === 0`, one delta snapshot (a client that has
 * received every earlier snapshot of the timeline) and one FULL snapshot (a fresh client) are built
 * over the current `interest` regions. The recorded builds are in `<name>.expected.snap` (JSON).
 */
export interface SnapshotTimeline {
  description: string;
  snapshotEvery: number;
  /** The client's interest regions (wanted ∩ reported) from tick 1. */
  interest: string[];
  /** Ascending ticks; ticks with nothing to do are omitted. */
  ticks: TimelineTick[];
  /** Last tick to run; default the last listed tick. */
  lastTick?: number;
}

export interface TimelineTick {
  tick: number;
  /** Replaces the interest regions from this tick on (before its snapshot). */
  interest?: string[];
  ops?: TimelineOp[];
}

export type TimelineOp =
  /** A new entity with these components (component name -> value). */
  | { op: 'spawn'; entity: EntityId; components: Record<string, unknown> }
  /** Adds the component, or overwrites it when present. */
  | { op: 'set'; entity: EntityId; component: string; value: unknown }
  | { op: 'remove'; entity: EntityId; component: string }
  /** Removes every component; the id is never alive again (a reused slot gets a new generation). */
  | { op: 'destroy'; entity: EntityId };

/** One recorded snapshot tick of a timeline. */
export interface TimelineStep {
  tick: number;
  interest: string[];
  /** What a client that received every earlier snapshot gets. */
  delta: SnapshotData;
  /** What a fresh client gets (FULL). */
  full: SnapshotData;
}

export interface TimelineRecording {
  description: string;
  /** Component names by id. */
  components: string[];
  steps: TimelineStep[];
}

export const TimelineInput = defineInput({ tick: f.u32 });

export function timelineRegistry(): SchemaRegistry {
  return new SchemaRegistry({
    components: CORE_COMPONENTS,
    messages: [],
    events: [],
    input: TimelineInput,
  });
}

export function loadTimeline(name: string): SnapshotTimeline {
  const url = new URL(`./${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as SnapshotTimeline;
}

const CAPACITY = 1024;

class ScriptedStore implements SnapshotStore {
  readonly version = new Uint32Array(CAPACITY);
  readonly removedAt = new Uint32Array(CAPACITY);
  readonly values = new Map<EntityId, unknown>();

  has(e: EntityId): boolean {
    return this.values.has(e);
  }

  read(e: EntityId): unknown {
    if (!this.values.has(e)) throw new Error(`entity ${e} has no such component`);
    return this.values.get(e);
  }
}

/** A `SnapshotSource` over scripted stores; region membership follows each entity's `Region`. */
export class ScriptedWorld implements SnapshotSource {
  readonly registry: SchemaRegistry;
  relevance: ((e: EntityId) => boolean) | undefined = undefined;
  withheld: ((e: EntityId) => ReadonlySet<number> | undefined) | undefined = undefined;
  private readonly stores: ScriptedStore[];
  private readonly alive = new Set<EntityId>();
  private readonly dead = new Set<EntityId>();
  private readonly regionId: number;

  constructor(registry: SchemaRegistry = timelineRegistry()) {
    this.registry = registry;
    this.stores = registry.components.map(() => new ScriptedStore());
    this.regionId = registry.componentId('Region');
  }

  entitiesIn(region: string): EntityId[] {
    const out: EntityId[] = [];
    for (const e of this.alive) if (this.regionOf(e) === region) out.push(e);
    return out.sort((a, b) => a - b);
  }

  regionOf(e: EntityId): string | null {
    const region = this.stores[this.regionId]?.values.get(e) as { id: string } | undefined;
    return region?.id ?? null;
  }

  store(compId: number): SnapshotStore {
    const store = this.stores[compId];
    if (store === undefined) throw new Error(`no component ${compId}`);
    return store;
  }

  slot(e: EntityId): number {
    return e & SLOT_MASK;
  }

  apply(tick: number, op: TimelineOp): void {
    switch (op.op) {
      case 'spawn': {
        if (this.alive.has(op.entity) || this.dead.has(op.entity)) {
          throw new Error(`tick ${tick}: entity ${op.entity} was already spawned`);
        }
        this.alive.add(op.entity);
        for (const [name, value] of Object.entries(op.components)) {
          this.set(tick, op.entity, name, value);
        }
        return;
      }
      case 'set':
        this.set(tick, op.entity, op.component, op.value);
        return;
      case 'remove':
        this.remove(tick, op.entity, this.registry.componentId(op.component));
        return;
      case 'destroy':
        this.requireAlive(tick, op.entity);
        for (let id = 0; id < this.stores.length; id++) this.remove(tick, op.entity, id);
        this.alive.delete(op.entity);
        this.dead.add(op.entity);
        return;
    }
  }

  private set(tick: number, e: EntityId, name: string, value: unknown): void {
    this.requireAlive(tick, e);
    const store = this.stores[this.registry.componentId(name)] as ScriptedStore;
    store.values.set(e, structuredClone(value));
    store.version[this.slot(e)] = tick;
  }

  private remove(tick: number, e: EntityId, id: number): void {
    const store = this.stores[id] as ScriptedStore;
    if (!store.values.delete(e)) return;
    store.removedAt[this.slot(e)] = tick;
    store.version[this.slot(e)] = 0;
  }

  private requireAlive(tick: number, e: EntityId): void {
    if (!this.alive.has(e)) throw new Error(`tick ${tick}: entity ${e} is not alive`);
  }
}

export function newReplicationState(): ReplicationState {
  return { known: new Set(), baselineTick: 0, fullNext: true };
}

/** Header fields a timeline build uses: deterministic, so recordings are stable. */
export function timelineHeader(tick: number) {
  return { serverTimeMs: tick * 50, lastInputSeq: 0, lastInputTick: 0 };
}

/**
 * Runs `timeline`, calling `onSnapshot` on each snapshot tick with the delta and FULL builds, before
 * the delta is committed. `send` encodes/transmits the delta and returns how many of its creates
 * were written (default: all), which is what gets committed.
 */
export function runTimeline(
  timeline: SnapshotTimeline,
  onSnapshot: (step: TimelineStep, world: ScriptedWorld) => void,
  send: (delta: SnapshotData) => number = (delta) => delta.creates.length,
): { world: ScriptedWorld; rs: ReplicationState } {
  const world = new ScriptedWorld();
  const rs = newReplicationState();
  let interest = [...timeline.interest];
  const byTick = new Map(timeline.ticks.map((t) => [t.tick, t]));
  const lastTick = timeline.lastTick ?? timeline.ticks.at(-1)?.tick ?? 0;
  for (let tick = 1; tick <= lastTick; tick++) {
    const entry = byTick.get(tick);
    if (entry?.interest !== undefined) interest = [...entry.interest];
    for (const op of entry?.ops ?? []) world.apply(tick, op);
    if (tick % timeline.snapshotEvery !== 0) continue;
    const delta = buildSnapshot(world, rs, interest, tick, timelineHeader(tick));
    const full = buildSnapshot(world, newReplicationState(), interest, tick, timelineHeader(tick));
    onSnapshot({ tick, interest: [...interest], delta, full }, world);
    commitSnapshot(rs, delta, send(delta));
  }
  return { world, rs };
}

/** Records every snapshot tick of `timeline` (values deep-copied), as stored in `.expected.snap`. */
export function recordTimeline(timeline: SnapshotTimeline): TimelineRecording {
  const steps: TimelineStep[] = [];
  runTimeline(timeline, (step) => steps.push(structuredClone(step)));
  return {
    description: timeline.description,
    components: timelineRegistry().components.map((c) => c.name),
    steps,
  };
}
