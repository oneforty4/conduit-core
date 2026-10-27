// Test helper (not a test file): a RegionManager wired into a Simulation the way the Session wires
// them (docs/net.md A.5), plus a RegionStore whose operations settle on demand.
import { v3, type Vec3 } from '@conduit/math';
import { MemoryStore } from '@conduit/persist';
import { SchemaRegistry, defineInput, f } from '@conduit/protocol';
import {
  CORE_COMPONENTS,
  Region,
  RegionChanged,
  Simulation,
  Transform,
  World,
  defineComponent,
  defineSystem,
  type EntityId,
  type SimContext,
  type SpatialApi,
  type System,
} from '@conduit/sim';
import { expect } from 'vitest';
import {
  GridWorld,
  RegionManager,
  SpatialIndex,
  type RegionBlob,
  type RegionDef,
  type RegionId,
  type RegionLoader,
  type RegionStore,
  type WorldGraph,
} from '../src/index.ts';

export const CELL = 100;

/** A persisted game component. */
export const Crate = defineComponent('Crate', { n: f.u16 }, { persist: true });
/** A component that is not persisted. */
export const Tag = defineComponent('Tag', { label: f.str(16) }, { persist: false });

export const registry = new SchemaRegistry({
  components: [...CORE_COMPONENTS, Crate, Tag],
  messages: [],
  events: [RegionChanged],
  input: defineInput({ tick: f.u32 }),
});

export const noSpatial: SpatialApi = {
  queryRadius: (_id, _pos, _r, out) => out,
  queryAABB: (_id, _min, _max, out) => out,
  queryRadiusAcross: (_id, _pos, _r, out) => out,
  nearest: () => undefined,
};

/** Moves every entity by its `Transform.vel` each tick: a displacement per tick, exact in binary. */
export const drift = defineSystem('drift', 'sim', (ctx) => {
  const { world } = ctx;
  for (const e of world.query(Transform)) {
    const { vel } = world.get(e, Transform);
    if (vel.x === 0 && vel.y === 0 && vel.z === 0) continue;
    const t = world.write(e, Transform);
    v3.add(t.pos, t.vel, t.pos);
  }
});

export function place(
  world: World,
  region: RegionId,
  pos: Vec3,
  vel: Vec3 = v3.create(),
): EntityId {
  const e = world.create();
  world.add(e, Region, { id: region });
  world.add(e, Transform, { pos, vel });
  return e;
}

export const at = (x: number, z: number, y = 0): Vec3 => ({ x, y, z });

/** Resolves once every queued promise callback has run (a macrotask turn), as between real ticks. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Entities whose `Region.id` is `id`, ascending: what `entitiesIn(id)` lists for an active region. */
export function scan(world: World, id: RegionId): EntityId[] {
  const out: EntityId[] = [];
  for (const e of world.query(Region)) if (world.get(e, Region).id === id) out.push(e);
  return out.sort((a, b) => a - b);
}

export function defOf(graph: WorldGraph, id: RegionId): RegionDef {
  const def = graph.get(id);
  if (def === undefined) throw new Error(`no region ${id}`);
  return def;
}

interface Pending<T> {
  ns: string;
  key: string;
  bytes?: Uint8Array;
  resolve(value: T): void;
  reject(err: unknown): void;
}

/**
 * A `RegionStore` whose `get` and `put` stay pending until the test settles them. `data` is what a
 * resolved `put` stored; a `get` resolved without bytes returns `data`'s entry (or `null`).
 */
export class ControlledStore implements RegionStore {
  readonly data = new Map<string, Uint8Array>();
  readonly gets: Pending<Uint8Array | null>[] = [];
  readonly puts: Pending<void>[] = [];
  /** Every call, in order: `get ns/key` or `put ns/key`. */
  readonly calls: string[] = [];
  transactions = 0;
  private tail: Promise<void> = Promise.resolve();

  get(ns: string, key: string): Promise<Uint8Array | null> {
    this.calls.push(`get ${ns}/${key}`);
    return new Promise((resolve, reject) => this.gets.push({ ns, key, resolve, reject }));
  }

  put(ns: string, key: string, blob: Uint8Array): Promise<void> {
    this.calls.push(`put ${ns}/${key}`);
    return new Promise((resolve, reject) =>
      this.puts.push({
        ns,
        key,
        bytes: blob.slice(),
        resolve: () => {
          this.data.set(`${ns}/${key}`, blob.slice());
          resolve();
        },
        reject,
      }),
    );
  }

  /** Serialized like every BlobStore's (docs/persist.md 1.4): each waits for the previous one. */
  transaction<T>(fn: (tx: RegionStore) => T | Promise<T>): Promise<T> {
    this.transactions++;
    const run = this.tail.then(() => fn(this));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Settles the oldest pending `get` of `key`. */
  resolveGet(key: string, bytes?: Uint8Array | null): void {
    const op = this.take(this.gets, key);
    op.resolve(bytes === undefined ? (this.data.get(`${op.ns}/${key}`) ?? null) : bytes);
  }

  rejectGet(key: string, err: unknown = new Error(`get ${key} failed`)): void {
    this.take(this.gets, key).reject(err);
  }

  /** Settles the oldest pending `put` of `key`; returns the bytes it was given. */
  resolvePut(key: string): Uint8Array {
    const op = this.take(this.puts, key);
    op.resolve();
    return op.bytes as Uint8Array;
  }

  rejectPut(key: string, err: unknown = new Error(`put ${key} failed`)): Uint8Array {
    const op = this.take(this.puts, key);
    op.reject(err);
    return op.bytes as Uint8Array;
  }

  pendingGets(): string[] {
    return this.gets.map((op) => op.key);
  }

  pendingPuts(): string[] {
    return this.puts.map((op) => op.key);
  }

  private take<T>(list: Pending<T>[], key: string): Pending<T> {
    const i = list.findIndex((op) => op.key === key);
    if (i < 0) throw new Error(`no pending operation on ${key}`);
    return list.splice(i, 1)[0] as Pending<T>;
  }
}

export interface Populated {
  region: RegionId;
  tick: number;
  blob: RegionBlob | null;
  /** `ctx.regionRng(region.id).state()` when populate was called. */
  rngState: number;
  /** `entitiesIn(region.id)` when populate was called: the entities restored from the blob. */
  restored: EntityId[];
}

export interface Change {
  tick: number;
  entity: EntityId;
  from: string;
  to: string;
}

export interface LogEntry {
  level: 'warn' | 'error';
  msg: string;
  err: unknown;
}

export interface Rig {
  world: World;
  graph: WorldGraph;
  regions: RegionManager;
  sim: Simulation;
  store: RegionStore;
  spatial: SpatialIndex | null;
  populated: Populated[];
  /** Regions passed to `onDeactivate`, with the tick. */
  deactivated: { region: RegionId; tick: number }[];
  /** Every `RegionChanged`, read by a tail probe after the membership pass. */
  changes: Change[];
  /** Entities passed to `onWorldEdge`, with the tick. */
  edges: { entity: EntityId; tick: number }[];
  logs: LogEntry[];
  /**
   * One Session tick (docs/sim.md 2.9): `regions.update(players, ctx, pending, interest)`, then
   * `step`, then a macrotask turn so that store operations that completed land before the next tick.
   */
  tick(
    players?: readonly EntityId[],
    pending?: readonly RegionId[],
    interest?: readonly RegionId[],
  ): Promise<void>;
}

export interface RigOpts {
  graph?: WorldGraph;
  store?: RegionStore;
  world?: World;
  lingerMs?: number;
  /** Game content, run by `populate` after the call is logged. */
  content?: (region: RegionDef, ctx: SimContext, blob: RegionBlob | null) => void;
  /** `loader.onDeactivate` (after the call is logged); omitted when not given. */
  gameData?: (region: RegionDef, ctx: SimContext) => unknown;
  systems?: readonly System[];
  /** Wire a real SpatialIndex after the membership pass. */
  spatial?: boolean;
}

/** The Session's wiring of a RegionManager into a Simulation (docs/net.md A.5). */
export function rig(opts: RigOpts = {}): Rig {
  const world = opts.world ?? new World(registry);
  const graph = opts.graph ?? new GridWorld({ cellSize: CELL, cols: 4, rows: 4, worldSeed: 77 });
  const store = opts.store ?? new MemoryStore();
  const populated: Populated[] = [];
  const deactivated: { region: RegionId; tick: number }[] = [];
  const edges: { entity: EntityId; tick: number }[] = [];
  const logs: LogEntry[] = [];
  const loader: RegionLoader = {
    populate(region, blob, ctx) {
      populated.push({
        region: region.id,
        tick: ctx.tick,
        blob,
        rngState: ctx.regionRng(region.id).state(),
        restored: [...ctx.regions.entitiesIn(region.id)],
      });
      opts.content?.(region, ctx, blob);
    },
  };
  const gameData = opts.gameData;
  if (gameData !== undefined) {
    loader.onDeactivate = (region, ctx) => {
      deactivated.push({ region: region.id, tick: ctx.tick });
      return gameData(region, ctx);
    };
  }
  const manager = new RegionManager({
    graph,
    world,
    loader,
    store,
    tickRate: 60,
    lingerMs: opts.lingerMs,
    log: (level, msg, err) => logs.push({ level, msg, err }),
    onWorldEdge: (entity, ctx) => edges.push({ entity, tick: ctx.tick }),
  });
  const spatial =
    opts.spatial === true ? new SpatialIndex({ regions: manager, world, graph }) : null;
  const sim = new Simulation({
    world,
    seed: 5,
    regionRng: (id) => manager.regionRng(id),
    regions: manager,
    spatial: spatial ?? noSpatial,
  });
  sim.register(drift);
  for (const system of opts.systems ?? []) sim.register(system);
  const changes: Change[] = [];
  sim.tail.push(manager.membershipSystem.run);
  if (spatial !== null) sim.tail.push((ctx) => spatial.rebuild(ctx));
  sim.tail.push((ctx) => {
    for (const ev of ctx.events.consume(RegionChanged)) {
      changes.push({ tick: ev.tick, ...ev.payload });
    }
  });
  return {
    world,
    graph,
    regions: manager,
    sim,
    store,
    spatial,
    populated,
    deactivated,
    changes,
    edges,
    logs,
    async tick(players = [], pending, interest) {
      manager.update(players, sim.ctx, pending, interest);
      sim.step(world.tick + 1);
      await settle();
    },
  };
}

export function expectRecordsMatchWorld(h: Rig): void {
  for (const id of h.regions.active()) {
    expect(h.regions.entitiesIn(id), id).toEqual(scan(h.world, id));
  }
}
