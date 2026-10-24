// @conduit/net-client is isomorphic and its sources name DOM event types; type-checking them
// from this Node package needs the DOM lib.
/// <reference lib="dom" />
import { Rng } from '@conduit/math';
import { ReplicaWorld } from '@conduit/net-client';
import {
  ByteReader,
  ByteWriter,
  decodeSnapshot,
  defineInput,
  EncodeError,
  encodeSnapshot,
  type EntityId,
  f,
  MAX_REGION_TABLE,
  REGION_ID_MAX,
  REGION_IDX_NONE,
  SchemaRegistry,
  SNAPSHOT_FLAG_FULL,
  SNAPSHOT_FLAG_MASKED,
  type SnapshotData,
} from '@conduit/protocol';
import { CORE_COMPONENTS, defineComponent, SLOT_MASK } from '@conduit/sim';
import { describe, expect, it } from 'vitest';
import { SNAPSHOT_SOFT_LIMIT_BYTES } from '../src/constants.ts';
import {
  buildSnapshot,
  commitSnapshot,
  encodeSnapshotBounded,
  type ReplicationState,
  type SnapshotSource,
} from '../src/snapshot-builder.ts';
import {
  loadTimeline,
  newReplicationState,
  recordTimeline,
  runTimeline,
  ScriptedWorld,
  type SnapshotTimeline,
  timelineHeader,
  timelineRegistry,
  type TimelineOp,
} from './fixtures/scripted-world.ts';

const registry = timelineRegistry();
const ID = {
  Model: registry.componentId('Model'),
  Name: registry.componentId('Name'),
  Owner: registry.componentId('Owner'),
  Region: registry.componentId('Region'),
  Transform: registry.componentId('Transform'),
};
const HDR = { serverTimeMs: 1234, lastInputSeq: 7, lastInputTick: 99 };

function transform(x: number, z: number) {
  return { pos: { x, y: 0, z }, rot: { x: 0, y: 0, z: 0, w: 1 }, vel: { x: 0, y: 0, z: 0 } };
}

function spawn(entity: EntityId, region: string, extra: Record<string, unknown> = {}): TimelineOp {
  return {
    op: 'spawn',
    entity,
    components: { Region: { id: region }, Transform: transform(entity, 1), ...extra },
  };
}

function encode(data: SnapshotData, limit = Number.POSITIVE_INFINITY): Uint8Array {
  const w = new ByteWriter();
  encodeSnapshotBounded(w, registry, data, limit);
  return w.finish();
}

function wire(data: SnapshotData): SnapshotData {
  return decodeSnapshot(new ByteReader(encode(data)), registry);
}

interface RefEntity {
  region: string | null;
  latest: Map<number, unknown>;
  destroyedTick: number | null;
}

/**
 * The client-side apply rules of docs/net.md B.5, strict about what a correct server never sends
 * (a create for a live entity, an update or destroy for an unknown one).
 */
class RefReplica {
  readonly entities = new Map<EntityId, RefEntity>();

  apply(s: SnapshotData): void {
    const tick = s.header.serverTick;
    if ((s.header.flags & SNAPSHOT_FLAG_FULL) !== 0) this.entities.clear();
    for (const c of s.creates) {
      const existing = this.entities.get(c.entity);
      if (existing !== undefined && existing.destroyedTick === null) {
        throw new Error(`tick ${tick}: duplicate create of ${c.entity}`);
      }
      const region = c.regionIdx === REGION_IDX_NONE ? null : (s.regions[c.regionIdx] ?? null);
      const ent: RefEntity = { region, latest: new Map(), destroyedTick: null };
      this.entities.set(c.entity, ent);
      for (const comp of c.components) this.set(ent, comp.id, comp.value);
    }
    for (const u of s.updates) {
      const ent = this.entities.get(u.entity);
      if (ent === undefined || ent.destroyedTick !== null) {
        throw new Error(`tick ${tick}: update for unknown ${u.entity}`);
      }
      for (const comp of u.components) this.set(ent, comp.id, comp.value);
      for (const id of u.removed) ent.latest.delete(id);
    }
    for (const e of s.destroys) {
      const ent = this.entities.get(e);
      if (ent === undefined || ent.destroyedTick !== null) {
        throw new Error(`tick ${tick}: destroy for unknown ${e}`);
      }
      ent.destroyedTick = tick;
    }
  }

  /** Live entities as comparable data: ascending ids, components ascending. */
  live(): [EntityId, string | null, [number, unknown][]][] {
    const out: [EntityId, string | null, [number, unknown][]][] = [];
    for (const [e, ent] of this.entities) {
      if (ent.destroyedTick !== null) continue;
      const comps = [...ent.latest].sort((a, b) => a[0] - b[0]);
      out.push([e, ent.region, comps]);
    }
    return out.sort((a, b) => a[0] - b[0]);
  }

  private set(ent: RefEntity, id: number, value: unknown): void {
    ent.latest.set(id, value);
    if (id === ID.Region) ent.region = (value as { id: string }).id;
  }
}

/** Server truth for `interest`, quantized through the wire codec like the replica's values. */
function truth(world: ScriptedWorld, interest: string[]): ReturnType<RefReplica['live']> {
  const out: ReturnType<RefReplica['live']> = [];
  const entities = interest.flatMap((r) => world.entitiesIn(r)).sort((a, b) => a - b);
  for (const e of entities) {
    const comps: [number, unknown][] = [];
    for (const def of registry.replicated) {
      const id = registry.componentId(def);
      const store = world.store(id);
      if (!store.has(e)) continue;
      const w = new ByteWriter();
      def.schema.encode(w, store.read(e));
      comps.push([id, def.schema.decode(new ByteReader(w.finish()))]);
    }
    out.push([e, world.regionOf(e), comps]);
  }
  return out;
}

type CreateShape = [entity: EntityId, region: string | null, comps: number[]];
type UpdateShape = [entity: EntityId, changed: number[], removed: number[]];
interface Shape {
  full: boolean;
  baseline: number;
  creates: CreateShape[];
  updates: UpdateShape[];
  destroys: EntityId[];
}

function shapeOf(s: SnapshotData): Shape {
  return {
    full: (s.header.flags & SNAPSHOT_FLAG_FULL) !== 0,
    baseline: s.header.baselineTick,
    creates: s.creates.map((c) => [
      c.entity,
      c.regionIdx === REGION_IDX_NONE ? null : (s.regions[c.regionIdx] ?? '?'),
      c.components.map((x) => x.id),
    ]),
    updates: s.updates.map((u) => [u.entity, u.components.map((x) => x.id), u.removed]),
    destroys: s.destroys,
  };
}

const { Model: M, Name: N, Owner: O, Region: R, Transform: T } = ID;
const B2 = (1 << 20) | 2;

describe('buildSnapshot on the basic timeline fixture', () => {
  const timeline = loadTimeline('timeline-basic');

  it('uses the core component ids the fixture format documents', () => {
    expect(registry.components.map((c) => c.name)).toEqual([
      'Model',
      'Name',
      'Owner',
      'Region',
      'Transform',
    ]);
    expect([M, N, O, R, T]).toEqual([0, 1, 2, 3, 4]);
  });

  it('produces the expected delta at every snapshot tick', () => {
    const delta = (baseline: number, rest: Partial<Shape>): Shape => ({
      full: false,
      baseline,
      creates: [],
      updates: [],
      destroys: [],
      ...rest,
    });
    const expected = new Map<number, Shape>([
      [
        3,
        {
          full: true,
          baseline: 0,
          creates: [
            [1, 'cell/1_0', [M, N, R, T]], // creates on first sight
            [2, 'cell/0_0', [M, O, R, T]],
            [3, 'cell/0_0', [R, T]],
            [4, 'cell/1_0', [N, O, R, T]],
          ],
          updates: [],
          destroys: [],
        },
      ],
      [6, delta(3, { updates: [[1, [T], []]] })], // only version > baseline
      [9, delta(6, { updates: [[1, [], [N]]] })], // removed component
      [
        12,
        delta(9, {
          updates: [
            [1, [N], []],
            [2, [], [M]],
          ],
        }),
      ], // re-added shows as changed
      [15, delta(12, { destroys: [3] })], // Model of 2 not reported again; 3 died
      [18, delta(15, { destroys: [4] })], // left interest
      [21, delta(18, { creates: [[4, 'cell/1_0', [N, O, R, T]]] })], // re-entered: full record
      [24, delta(21, { destroys: [1, 4] })], // interest shrank
      [
        27,
        delta(24, {
          creates: [
            [1, 'cell/1_0', [M, N, R, T]],
            [4, 'cell/1_0', [N, O, R, T]],
          ],
        }),
      ],
      [30, delta(27, { creates: [[B2, 'cell/0_0', [M, R, T]]], destroys: [2] })], // reused slot
      [33, delta(30, { updates: [[1, [O, T], []]] })], // added component, two writes
      [36, delta(33, { updates: [[1, [R, T], []]] })], // region change inside interest
      [39, delta(36, {})],
      [42, delta(39, { creates: [[5, 'cell/1_0', [N, R, T]]], destroys: [1] })],
    ]);
    const seen: number[] = [];
    runTimeline(timeline, (step) => {
      seen.push(step.tick);
      expect(shapeOf(step.delta), `delta at tick ${step.tick}`).toEqual(expected.get(step.tick));
      expect(step.delta.header).toMatchObject({
        serverTick: step.tick,
        ...timelineHeader(step.tick),
      });
    });
    expect(seen).toEqual([...expected.keys()]);
  });

  it('FULL builds list every interest entity with every replicated component', () => {
    runTimeline(timeline, (step, world) => {
      const shape = shapeOf(step.full);
      expect(shape.full).toBe(true);
      expect(shape.baseline).toBe(0);
      expect(shape.updates).toEqual([]);
      expect(shape.destroys).toEqual([]);
      expect(shape.creates.map((c) => c[0])).toEqual(
        step.interest.flatMap((r) => world.entitiesIn(r)).sort((a, b) => a - b),
      );
    });
  });

  it('delta-equals-full: the replica fed deltas equals a FULL build at every tick', () => {
    const deltaReplica = new RefReplica();
    let steps = 0;
    const { rs } = runTimeline(timeline, (step, world) => {
      deltaReplica.apply(wire(step.delta));
      const fullReplica = new RefReplica();
      fullReplica.apply(wire(step.full));
      expect(deltaReplica.live(), `tick ${step.tick}`).toEqual(fullReplica.live());
      expect(fullReplica.live(), `tick ${step.tick}`).toEqual(truth(world, step.interest));
      steps++;
    });
    expect(steps).toBe(14);
    expect(rs.baselineTick).toBe(42);
    expect([...rs.known].sort((a, b) => a - b)).toEqual([4, 5, B2]);
  });

  it('encodes byte-identically to encodeSnapshot when nothing is deferred', () => {
    runTimeline(timeline, (step) => {
      for (const data of [step.delta, step.full]) {
        const w = new ByteWriter();
        encodeSnapshot(w, registry, data);
        expect(encode(data, SNAPSHOT_SOFT_LIMIT_BYTES)).toEqual(w.finish());
      }
    });
  });

  it('matches the recording shared with net-client', async () => {
    const recording = recordTimeline(timeline);
    await expect(`${JSON.stringify(recording, null, 2)}\n`).toMatchFileSnapshot(
      './fixtures/timeline-basic.expected.snap',
    );
  });
});

/** Live entities of a net-client `ReplicaWorld`, in the shape of `RefReplica.live()`. */
function replicaLive(world: ReplicaWorld): ReturnType<RefReplica['live']> {
  const out: ReturnType<RefReplica['live']> = [];
  for (const ent of world.entities()) {
    if (ent.destroyedTick !== null) continue;
    out.push([ent.id, ent.regionId, [...ent.latest].sort((a, b) => a[0] - b[0])]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

function newReplicaWorld(): ReplicaWorld {
  return new ReplicaWorld(registry, CORE_COMPONENTS, {
    tickRate: 60,
    snapshotEvery: 3,
    log: () => {},
  });
}

describe("delta-equals-full through net-client's ReplicaWorld", () => {
  it('on the basic timeline: deltas applied in order equal a FULL at every snapshot tick', () => {
    const deltas = newReplicaWorld();
    runTimeline(loadTimeline('timeline-basic'), (step, world) => {
      deltas.applySnapshot(wire(step.delta));
      const full = newReplicaWorld();
      full.applySnapshot(wire(step.full));
      expect(replicaLive(deltas), `tick ${step.tick}`).toEqual(replicaLive(full));
      expect(replicaLive(full), `tick ${step.tick}`).toEqual(truth(world, step.interest));
    });
  });
});

describe('delta-equals-full under seeded random churn', () => {
  function randomTimeline(seed: number, ticks: number): SnapshotTimeline {
    const rng = new Rng(seed);
    const regions = ['cell/0_0', 'cell/1_0', 'cell/0_1', 'cell/9_9'];
    const pick = <T>(xs: readonly T[]): T => xs[rng.int(0, xs.length - 1)] as T;
    const alive: EntityId[] = [];
    const gens = new Map<number, number>();
    let nextSlot = 1;
    const out: SnapshotTimeline = {
      description: `random churn seed ${seed}`,
      snapshotEvery: 3,
      interest: ['cell/0_0', 'cell/1_0', 'cell/0_1'],
      ticks: [],
    };
    for (let tick = 1; tick <= ticks; tick++) {
      const ops: TimelineOp[] = [];
      const touched = new Set<EntityId>();
      for (let i = rng.int(0, 6); i > 0; i--) {
        const roll = rng.int(0, 99);
        if (roll < 15 || alive.length === 0) {
          const slot = rng.int(0, 3) === 0 && gens.size > alive.length ? reuse() : nextSlot++;
          const gen = gens.get(slot) ?? 0;
          const e = ((gen << 20) | slot) >>> 0;
          gens.set(slot, gen);
          alive.push(e);
          touched.add(e);
          ops.push({
            op: 'spawn',
            entity: e,
            components: {
              Region: { id: pick(regions) },
              Transform: transform(rng.float() * 256, rng.float() * 256),
              ...(rng.int(0, 1) === 0 ? { Name: { value: `e${e}` } } : {}),
            },
          });
          continue;
        }
        const e = pick(alive);
        if (touched.has(e)) continue;
        if (roll < 25) {
          touched.add(e);
          alive.splice(alive.indexOf(e), 1);
          gens.set(e & SLOT_MASK, ((e >>> 20) + 1) & 0x7ff);
          ops.push({ op: 'destroy', entity: e });
        } else if (roll < 45) {
          ops.push({ op: 'set', entity: e, component: 'Region', value: { id: pick(regions) } });
        } else if (roll < 75) {
          const value = transform(rng.float() * 256, rng.float() * 256);
          ops.push({ op: 'set', entity: e, component: 'Transform', value });
        } else if (roll < 88) {
          const component = pick(['Name', 'Owner', 'Model']);
          const value =
            component === 'Name'
              ? { value: `n${rng.int(0, 99)}` }
              : component === 'Owner'
                ? { player: rng.int(0, 7) }
                : { asset: 'crate', variant: rng.int(0, 3) };
          ops.push({ op: 'set', entity: e, component, value });
        } else {
          ops.push({ op: 'remove', entity: e, component: pick(['Name', 'Owner', 'Model']) });
        }
      }
      const entry: SnapshotTimeline['ticks'][number] = { tick, ops };
      if (rng.int(0, 40) === 0) entry.interest = regions.filter(() => rng.int(0, 1) === 1);
      out.ticks.push(entry);
    }
    return out;

    function reuse(): number {
      for (const [slot] of gens) if (!alive.some((e) => (e & SLOT_MASK) === slot)) return slot;
      return nextSlot++;
    }
  }

  it.each([1, 2, 3])('seed %i: 600 ticks, compared at every snapshot tick', (seed) => {
    const timeline = randomTimeline(seed, 600);
    const replica = new RefReplica();
    const replicaWorld = newReplicaWorld();
    let compared = 0;
    runTimeline(timeline, (step, world) => {
      const decoded = wire(step.delta);
      replica.apply(decoded);
      replicaWorld.applySnapshot(decoded);
      const expected = truth(world, step.interest);
      expect(replica.live(), `seed ${seed} tick ${step.tick}`).toEqual(expected);
      expect(replicaLive(replicaWorld), `seed ${seed} tick ${step.tick}`).toEqual(expected);
      compared++;
    });
    expect(compared).toBe(200);
  });
});

describe('buildSnapshot rules', () => {
  function world(ops: TimelineOp[], tick = 1): ScriptedWorld {
    const w = new ScriptedWorld();
    for (const op of ops) w.apply(tick, op);
    return w;
  }

  it('filters interest through relevance; an entity that becomes irrelevant is destroyed', () => {
    const w = world([spawn(1, 'a'), spawn(2, 'a'), spawn(3, 'a')]);
    let hidden = new Set<EntityId>([2]);
    w.relevance = (e) => !hidden.has(e);
    const rs = newReplicationState();
    const first = buildSnapshot(w, rs, ['a'], 3, HDR);
    expect(first.creates.map((c) => c.entity)).toEqual([1, 3]);
    commitSnapshot(rs, first, first.creates.length);
    hidden = new Set([3]);
    const second = buildSnapshot(w, rs, ['a'], 6, HDR);
    expect(second.creates.map((c) => c.entity)).toEqual([2]);
    expect(second.destroys).toEqual([3]);
  });

  it('never replicates non-replicated components', () => {
    const Secret = defineComponent('Secret', { hp: f.u16 }, { replicate: false });
    const reg = new SchemaRegistry({
      components: [...CORE_COMPONENTS, Secret],
      messages: [],
      events: [],
      input: defineInput({ tick: f.u32 }),
    });
    const w = new ScriptedWorld(reg);
    w.apply(1, spawn(1, 'a', { Secret: { hp: 5 } }));
    const rs = newReplicationState();
    const first = buildSnapshot(w, rs, ['a'], 3, HDR);
    const secretId = reg.componentId('Secret');
    expect(first.creates[0]?.components.map((c) => c.id)).not.toContain(secretId);
    commitSnapshot(rs, first, 1);
    w.apply(4, { op: 'set', entity: 1, component: 'Secret', value: { hp: 6 } });
    w.apply(5, { op: 'remove', entity: 1, component: 'Secret' });
    expect(buildSnapshot(w, rs, ['a'], 6, HDR).updates).toEqual([]);
  });

  it('sets FULL, baselineTick 0 and ignores known entities when fullNext', () => {
    const w = world([spawn(1, 'a'), spawn(2, 'a')]);
    const rs: ReplicationState = { known: new Set([1, 77]), baselineTick: 30, fullNext: true };
    const data = buildSnapshot(w, rs, ['a'], 33, HDR);
    expect(data.header).toEqual({
      serverTick: 33,
      serverTimeMs: 1234,
      baselineTick: 0,
      lastInputSeq: 7,
      lastInputTick: 99,
      flags: SNAPSHOT_FLAG_FULL,
    });
    expect(data.creates.map((c) => c.entity)).toEqual([1, 2]);
    expect(data.updates).toEqual([]);
    expect(data.destroys).toEqual([]);
    commitSnapshot(rs, data, data.creates.length);
    expect(rs).toEqual({ known: new Set([1, 2]), baselineTick: 33, fullNext: false });
    expect(buildSnapshot(w, rs, ['a'], 36, HDR).header).toMatchObject({
      baselineTick: 33,
      flags: 0,
    });
  });

  it('orders records by entity id and components by id; the region table is first-use', () => {
    const w = world([
      spawn(9, 'zeta', { Name: { value: 'n' }, Owner: { player: 1 } }),
      spawn(4, 'beta'),
      spawn(1048577, 'alpha'), // slot 1, generation 1: largest id
      spawn(6, 'zeta', { Model: { asset: 'crate', variant: 1 } }),
    ]);
    const data = buildSnapshot(w, newReplicationState(), ['zeta', 'alpha', 'beta'], 3, HDR);
    expect(data.creates.map((c) => c.entity)).toEqual([4, 6, 9, 1048577]);
    expect(data.regions).toEqual(['beta', 'zeta', 'alpha']);
    expect(data.creates.map((c) => c.regionIdx)).toEqual([0, 1, 1, 2]);
    expect(data.creates.map((c) => c.components.map((x) => x.id))).toEqual([
      [R, T],
      [M, R, T],
      [N, O, R, T],
      [R, T],
    ]);
  });

  it('uses REGION_IDX_NONE for an entity without a region', () => {
    const w = world([spawn(1, 'a')]);
    const src: SnapshotSource = {
      registry,
      entitiesIn: () => [1],
      regionOf: () => null,
      store: (id) => w.store(id),
      slot: (e) => w.slot(e),
    };
    const data = buildSnapshot(src, newReplicationState(), ['x'], 3, HDR);
    expect(data.creates[0]?.regionIdx).toBe(REGION_IDX_NONE);
    expect(data.regions).toEqual([]);
  });
});

describe('encodeSnapshotBounded and deferred creates', () => {
  const name = { value: 'a name of thirty-two bytes....' };

  it('defers creates beyond the soft limit; they are not known and come in the next build', () => {
    const w = new ScriptedWorld();
    for (let e = 1; e <= 50; e++) w.apply(1, spawn(e, 'a', { Name: name }));
    const rs = newReplicationState();
    const replica = new RefReplica();
    const createdAt: number[] = [];
    for (let tick = 3; createdAt.length < 50; tick += 3) {
      const data = buildSnapshot(w, rs, ['a'], tick, HDR);
      expect(data.creates.map((c) => c.entity)).toEqual(
        Array.from({ length: 50 - createdAt.length }, (_, i) => createdAt.length + 1 + i),
      );
      const bw = new ByteWriter();
      let reported = -1;
      const n = encodeSnapshotBounded(bw, registry, data, 1000, (count) => (reported = count));
      const bytes = bw.finish();
      expect(reported).toBe(n);
      expect(n).toBeGreaterThan(0);
      expect(n).toBeLessThan(40);
      const decoded = decodeSnapshot(new ByteReader(bytes), registry);
      expect(decoded.creates.map((c) => c.entity)).toEqual(
        data.creates.slice(0, n).map((c) => c.entity),
      );
      replica.apply(decoded);
      commitSnapshot(rs, data, n);
      for (let i = 0; i < n; i++) createdAt.push(data.creates[i]?.entity as number);
      expect(rs.known.size).toBe(createdAt.length);
      for (const c of data.creates.slice(n)) expect(rs.known.has(c.entity)).toBe(false);
      expect(tick).toBeLessThan(60);
    }
    expect(createdAt).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    const full = new RefReplica();
    full.apply(buildSnapshot(w, newReplicationState(), ['a'], 99, HDR));
    expect(replica.live().map((x) => x[0])).toEqual(full.live().map((x) => x[0]));
  });

  it('counts updates and destroys against the limit and always writes them in full', () => {
    const w = new ScriptedWorld();
    for (let e = 1; e <= 30; e++) w.apply(1, spawn(e, 'a', { Name: name }));
    const rs = newReplicationState();
    const first = buildSnapshot(w, rs, ['a'], 3, HDR);
    commitSnapshot(rs, first, first.creates.length);
    for (let e = 1; e <= 30; e++) {
      w.apply(4, { op: 'set', entity: e, component: 'Name', value: { value: `renamed ${e}` } });
    }
    for (let e = 31; e <= 40; e++) w.apply(4, spawn(e, 'a', { Name: name }));
    w.apply(4, { op: 'destroy', entity: 30 });
    const data = buildSnapshot(w, rs, ['a'], 6, HDR);
    expect(data.updates).toHaveLength(29);
    expect(data.destroys).toEqual([30]);
    const unbounded = encode(data).byteLength;
    const createsOnly = encode({ ...data, updates: [], destroys: [] }).byteLength;
    // The creates alone fit under the limit, but not together with the updates.
    const limit = createsOnly + 1;
    expect(limit).toBeLessThan(unbounded);
    const bw = new ByteWriter();
    const n = encodeSnapshotBounded(bw, registry, data, limit);
    expect(n).toBeLessThan(data.creates.length);
    const decoded = decodeSnapshot(new ByteReader(bw.finish()), registry);
    expect(decoded.updates).toHaveLength(29);
    expect(decoded.destroys).toEqual([30]);
    expect(decoded.creates).toHaveLength(n);
  });

  it('truncates the writer back when encoding throws', () => {
    const w = new ScriptedWorld();
    w.apply(1, spawn(1, 'a'));
    const data = buildSnapshot(w, newReplicationState(), ['a'], 3, HDR);
    const bad: SnapshotData = { ...data, creates: [{ ...data.creates[0]!, regionIdx: 9 }] };
    const bw = new ByteWriter();
    bw.u8(42);
    expect(() => encodeSnapshotBounded(bw, registry, bad, SNAPSHOT_SOFT_LIMIT_BYTES)).toThrow(
      /regionIdx/,
    );
    expect(bw.length).toBe(1);
  });

  it("rejects SNAPSHOT_FLAG_MASKED and field masks with EncodeError('range'): it writes whole records only", () => {
    const w = new ScriptedWorld();
    w.apply(1, spawn(1, 'a'));
    const rs = newReplicationState();
    const first = buildSnapshot(w, rs, ['a'], 3, HDR);
    commitSnapshot(rs, first, first.creates.length);
    w.apply(4, { op: 'set', entity: 1, component: 'Transform', value: transform(2, 2) });
    const data = buildSnapshot(w, rs, ['a'], 6, HDR);
    expect(data.updates).toHaveLength(1);
    const update = data.updates[0]!;
    const flagged: SnapshotData = {
      ...data,
      header: { ...data.header, flags: data.header.flags | SNAPSHOT_FLAG_MASKED },
    };
    const partial = [{ ...update, components: update.components.map((c) => ({ ...c, mask: 1 })) }];
    // The codec writes both as the masked layout (docs/protocol.md 9.11.1), whose update records
    // the whole-record writer would get wrong.
    expect(() =>
      encodeSnapshot(new ByteWriter(), registry, { ...flagged, updates: partial }),
    ).not.toThrow();
    for (const bad of [flagged, { ...data, updates: partial }]) {
      const bw = new ByteWriter();
      bw.u8(42);
      let err: unknown;
      try {
        encodeSnapshotBounded(bw, registry, bad, SNAPSHOT_SOFT_LIMIT_BYTES);
      } catch (thrown) {
        err = thrown;
      }
      expect(err).toBeInstanceOf(EncodeError);
      expect((err as EncodeError).code).toBe('range');
      expect(bw.length).toBe(1);
    }
    expect(wire(data).updates).toHaveLength(1);
  });
});

describe('the region table', () => {
  function world(ops: TimelineOp[], tick = 1): ScriptedWorld {
    const w = new ScriptedWorld();
    for (const op of ops) w.apply(tick, op);
    return w;
  }

  /** `[entity, region]` of every create, resolved through the snapshot's own table. */
  function createdIn(s: SnapshotData): [EntityId, string | null][] {
    return s.creates.map((c) => [
      c.entity,
      c.regionIdx === REGION_IDX_NONE ? null : (s.regions[c.regionIdx] ?? '?'),
    ]);
  }

  function encodeError(fn: () => void): EncodeError {
    try {
      fn();
    } catch (err) {
      if (err instanceof EncodeError) return err;
      throw err;
    }
    throw new Error('expected an EncodeError');
  }

  it('is local to each snapshot: the regions of its creates only, in first-use order from index 0', () => {
    const w = world([spawn(5, 'cell/0_0'), spawn(2, 'cell/1_1'), spawn(9, 'cell/0_0')]);
    const interest = ['cell/0_0', 'cell/1_1', 'cell/2_2']; // wanted ∩ reported; cell/2_2 is empty
    const rs = newReplicationState();
    const first = buildSnapshot(w, rs, interest, 3, HDR);
    expect(first.regions).toEqual(['cell/1_1', 'cell/0_0']);
    expect(first.creates.map((c) => [c.entity, c.regionIdx])).toEqual([
      [2, 0],
      [5, 1],
      [9, 1],
    ]);
    commitSnapshot(rs, first, first.creates.length);

    w.apply(4, spawn(7, 'cell/2_2'));
    w.apply(4, { op: 'set', entity: 2, component: 'Transform', value: transform(3, 3) });
    const second = buildSnapshot(w, rs, interest, 6, HDR);
    expect(second.regions).toEqual(['cell/2_2']); // the update of 2 takes no entry
    expect(second.creates.map((c) => [c.entity, c.regionIdx])).toEqual([[7, 0]]);
    expect(second.updates.map((u) => u.entity)).toEqual([2]);
    commitSnapshot(rs, second, second.creates.length);

    w.apply(7, { op: 'destroy', entity: 5 });
    w.apply(7, { op: 'set', entity: 9, component: 'Transform', value: transform(4, 4) });
    const third = buildSnapshot(w, rs, interest, 9, HDR);
    expect(third.destroys).toEqual([5]);
    expect(third.updates.map((u) => u.entity)).toEqual([9]);
    expect(third.regions).toEqual([]);
    expect(wire(third).regions).toEqual([]);
  });

  it('a region change inside interest is an update of Region; entering interest from outside is a create in the new region', () => {
    const w = world([spawn(1, 'a'), spawn(2, 'outside')]);
    const rs = newReplicationState();
    const replica = newReplicaWorld();
    const send = (tick: number): SnapshotData => {
      const data = buildSnapshot(w, rs, ['a', 'b'], tick, HDR);
      replica.applySnapshot(wire(data));
      commitSnapshot(rs, data, data.creates.length);
      return data;
    };
    expect(createdIn(send(3))).toEqual([[1, 'a']]);

    w.apply(4, { op: 'set', entity: 1, component: 'Region', value: { id: 'b' } });
    w.apply(4, { op: 'set', entity: 2, component: 'Region', value: { id: 'b' } });
    const moved = send(6);
    expect(moved.regions).toEqual(['b']);
    expect(createdIn(moved)).toEqual([[2, 'b']]);
    expect(moved.updates).toEqual([
      { entity: 1, components: [{ id: R, value: { id: 'b' } }], removed: [] },
    ]);
    expect(replica.get(1)?.regionId).toBe('b');
    expect(replica.get(2)?.regionId).toBe('b');

    w.apply(7, { op: 'set', entity: 1, component: 'Region', value: { id: 'outside' } });
    const left = send(9);
    expect(left.destroys).toEqual([1]);
    expect(left.regions).toEqual([]);
  });

  it('does not depend on the order or repetition of the interest regions', () => {
    const w = world([spawn(3, 'b'), spawn(1, 'a'), spawn(2, 'c')]);
    const reference = buildSnapshot(w, newReplicationState(), ['a', 'b', 'c'], 3, HDR);
    expect(reference.regions).toEqual(['a', 'c', 'b']);
    const shuffled = buildSnapshot(w, newReplicationState(), ['c', 'b', 'a', 'c', 'a'], 3, HDR);
    expect(shuffled).toEqual(reference);
  });

  it('gives creates deferred past the soft limit their region in the table of the snapshot that carries them', () => {
    const name = { value: 'a name of thirty-two bytes....' };
    const regions = ['cell/0_0', 'cell/1_0', 'cell/2_0', 'cell/3_0'];
    const w = new ScriptedWorld();
    for (let e = 1; e <= 40; e++) w.apply(1, spawn(e, regions[e % 4] as string, { Name: name }));
    const rs = newReplicationState();
    const created: [EntityId, string | null][] = [];
    let snapshots = 0;
    for (let tick = 3; rs.known.size < 40; tick += 3) {
      const data = buildSnapshot(w, rs, regions, tick, HDR);
      const bw = new ByteWriter();
      const n = encodeSnapshotBounded(bw, registry, data, 600);
      const decoded = decodeSnapshot(new ByteReader(bw.finish()), registry);
      expect(decoded.regions).toEqual(data.regions);
      created.push(...createdIn(decoded));
      commitSnapshot(rs, data, n);
      snapshots++;
      expect(tick).toBeLessThan(60);
    }
    expect(snapshots).toBeGreaterThan(2);
    expect(created).toEqual(
      Array.from({ length: 40 }, (_, i): [EntityId, string] => [
        i + 1,
        regions[(i + 1) % 4] as string,
      ]),
    );
  });

  it(`holds ${MAX_REGION_TABLE} regions, indices below REGION_IDX_NONE; one more fails with EncodeError('count')`, () => {
    const regions = Array.from({ length: MAX_REGION_TABLE + 1 }, (_, i) => `cell/${i}_0`);
    const w = world(regions.map((r, i) => spawn(i + 1, r)));
    const fits = wire(buildSnapshot(w, newReplicationState(), regions.slice(0, -1), 3, HDR));
    expect(fits.regions).toEqual(regions.slice(0, -1));
    expect(Math.max(...fits.creates.map((c) => c.regionIdx))).toBe(MAX_REGION_TABLE - 1);
    expect(MAX_REGION_TABLE - 1).toBeLessThan(REGION_IDX_NONE);

    const over = buildSnapshot(w, newReplicationState(), regions, 3, HDR);
    const bw = new ByteWriter();
    bw.u8(42);
    const err = encodeError(() =>
      encodeSnapshotBounded(bw, registry, over, SNAPSHOT_SOFT_LIMIT_BYTES),
    );
    expect(err.code).toBe('count');
    expect(bw.length).toBe(1);
  });

  it(`encodes region ids of up to REGION_ID_MAX (${REGION_ID_MAX}) UTF-8 bytes; a longer one fails with EncodeError('length')`, () => {
    const longest = `cell/${'x'.repeat(REGION_ID_MAX - 5)}`;
    const w = world([spawn(1, longest), spawn(2, `${longest}y`)]);
    expect(wire(buildSnapshot(w, newReplicationState(), [longest], 3, HDR)).regions).toEqual([
      longest,
    ]);
    const tooLong = buildSnapshot(w, newReplicationState(), [longest, `${longest}y`], 3, HDR);
    const bw = new ByteWriter();
    const err = encodeError(() =>
      encodeSnapshotBounded(bw, registry, tooLong, SNAPSHOT_SOFT_LIMIT_BYTES),
    );
    expect(err.code).toBe('length');
    expect(bw.length).toBe(0);
  });
});
