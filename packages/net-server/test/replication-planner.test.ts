import { PredictionDriver, ReplicaWorld, type ReconcileView } from '@conduit/net-client';
import {
  ByteReader,
  ByteWriter,
  decodeSnapshot,
  defineInput,
  encodeSnapshot,
  f,
  SchemaRegistry,
  SNAPSHOT_FLAG_MASKED,
  type SnapshotData,
} from '@conduit/protocol';
import { defineComponent, World, type ComponentType } from '@conduit/sim';
import { describe, expect, it } from 'vitest';
import { ReplicationPlanner, type ReplicationGroup } from '../src/replication-planner.ts';
import type { ReplicationState, SnapshotSource } from '../src/snapshot-builder.ts';
import { EgressBudget } from '../src/egress-budget.ts';

const Value = defineComponent('Value', { x: f.fixed16(0.1), n: f.u16 });
function setup(count = 3, component: ComponentType<unknown> = Value) {
  const registry = new SchemaRegistry({
    components: [component],
    messages: [],
    events: [],
    input: defineInput({ tick: f.u32 }),
  });
  const world = new World(registry);
  const entities = Array.from({ length: count }, () => {
    const entity = world.create();
    world.add(entity, component);
    return entity;
  });
  const source: SnapshotSource = {
    registry,
    entitiesIn: () => world.query(),
    regionOf: () => null,
    entityAlive: (entity) => world.alive(entity),
    store: (id) => world.stores()[id]!,
    slot: (entity) => entity & 0xfffff,
  };
  const state: ReplicationState = { known: new Set(), baselineTick: 0, fullNext: true };
  world.tick = 1;
  return { world, entities, source, state };
}
const header = { serverTimeMs: 0, lastInputSeq: 0, lastInputTick: 0 };
const update = (snapshot: SnapshotData, entity: number) =>
  snapshot.updates.find((record) => record.entity === entity);

describe('withheld components in the planner (docs/net.md A.8.4)', () => {
  const Secret = defineComponent('Secret', { aim: f.u16 });
  function twoComponents() {
    const registry = new SchemaRegistry({
      components: [Value, Secret],
      messages: [],
      events: [],
      input: defineInput({ tick: f.u32 }),
    });
    const world = new World(registry);
    const [mine, theirs] = [world.create(), world.create()] as [number, number];
    for (const entity of [mine, theirs]) {
      world.add(entity, Value);
      world.add(entity, Secret, { aim: entity });
    }
    let hidden = true;
    const secretId = registry.componentId(Secret);
    const source: SnapshotSource = {
      registry,
      entitiesIn: () => world.query(),
      regionOf: () => null,
      entityAlive: (entity) => world.alive(entity),
      store: (id) => world.stores()[id]!,
      slot: (entity) => entity & 0xfffff,
      withheld: (entity) => (entity === theirs && hidden ? new Set([secretId]) : undefined),
    };
    const state: ReplicationState = { known: new Set(), baselineTick: 0, fullNext: true };
    const replica = new ReplicaWorld(registry, [Value, Secret], { tickRate: 60, snapshotEvery: 1 });
    const send = (data: SnapshotData): SnapshotData => {
      const w = new ByteWriter();
      encodeSnapshot(w, registry, data);
      const decoded = decodeSnapshot(new ByteReader(w.view()), registry);
      replica.applySnapshot(decoded);
      return decoded;
    };
    world.tick = 1;
    return {
      world,
      mine,
      theirs,
      source,
      state,
      replica,
      send,
      secretId,
      reveal: (value: boolean) => (hidden = !value),
    };
  }

  it('leaves it out, removes it when it becomes withheld and sends it whole when it stops', () => {
    const t = twoComponents();
    const planner = new ReplicationPlanner({ heartbeatTicks: 1000 });
    let prepared = planner.prepare(t.source, t.state, ['r'], 1, header, 1000, 10000);
    const first = t.send(prepared.data);
    prepared.commit();
    const valueId = t.source.registry.componentId(Value);
    expect(first.creates.map((c) => [c.entity, c.components.map((x) => x.id)])).toEqual([
      [t.mine, [t.secretId, valueId].sort((a, b) => a - b)],
      [t.theirs, [valueId]],
    ]);
    // A replica that never gets it reads nothing, now or as of any tick.
    expect(t.replica.read(t.theirs, Secret)).toBeUndefined();
    expect(t.replica.readAt(t.theirs, Secret, 1)).toBeUndefined();
    expect(t.replica.read(t.mine, Secret)).toEqual({ aim: t.mine });
    // Written while withheld: no record at all.
    t.world.mutate(t.theirs, Secret, (v) => {
      v.aim = 77;
    });
    prepared = planner.prepare(t.source, t.state, ['r'], 2, header, 1000, 10000);
    expect(prepared.data.updates).toEqual([]);
    t.send(prepared.data);
    prepared.commit();
    // Given back: whole (no mask), though the client has no baseline for it.
    t.reveal(true);
    prepared = planner.prepare(t.source, t.state, ['r'], 3, header, 1000, 10000);
    expect(update(prepared.data, t.theirs)?.components).toEqual([
      { id: t.secretId, value: { aim: 77 } },
    ]);
    t.send(prepared.data);
    prepared.commit();
    expect(t.replica.read(t.theirs, Secret)).toEqual({ aim: 77 });
    // Withheld again: removed, and a coherent read before then still has it.
    t.reveal(false);
    prepared = planner.prepare(t.source, t.state, ['r'], 4, header, 1000, 10000);
    expect(update(prepared.data, t.theirs)?.removed).toEqual([t.secretId]);
    t.send(prepared.data);
    prepared.commit();
    expect(t.replica.read(t.theirs, Secret)).toBeUndefined();
    expect(t.replica.readAt(t.theirs, Secret, 3)).toEqual({ aim: 77 });
    expect(t.replica.readAt(t.theirs, Secret, 4)).toBeUndefined();
    expect(t.replica.authoritativeTick(t.theirs)).toBe(4);
    prepared = planner.prepare(t.source, t.state, ['r'], 5, header, 1000, 10000);
    expect(prepared.data.updates).toEqual([]);
  });

  it('orders records by entity whatever order the groups are chosen in', () => {
    const t = twoComponents();
    const planner = new ReplicationPlanner({ heartbeatTicks: 1000 });
    const prepared = planner.prepare(t.source, t.state, ['r'], 1, header, 1000, 10000, {
      groups: [
        { key: 'b', entities: [t.theirs] },
        { key: 'a', entities: [t.mine] },
      ],
      priority: (group) => (group.key === 'b' ? 10 : 0),
    });
    expect(prepared.data.creates.map((c) => c.entity)).toEqual([t.mine, t.theirs]);
  });
});

describe('per-client coherent replication planning', () => {
  it('retains stopped deferred writes across newer global baselines and ages low priority units', () => {
    const { world, entities, source, state } = setup();
    const planner = new ReplicationPlanner({ fairnessEvery: 3, heartbeatTicks: 1000 });
    planner.prepare(source, state, ['r'], 1, header, 64, 10000).commit();
    for (const entity of entities)
      world.mutate(entity, Value, (value) => {
        value.n = 7;
      });
    const received = new Set<number>();
    for (let tick = 2; tick < 15; tick++) {
      world.tick = tick - 1;
      world.mutate(entities[0]!, Value, (value) => {
        value.n = tick;
      });
      const prepared = planner.prepare(source, state, ['r'], tick, header, 40, 10000, {
        priority: (group) => (group.entities.includes(entities[0]!) ? 1000 : 0),
      });
      for (const record of prepared.data.updates) received.add(record.entity);
      prepared.commit();
    }
    expect(received).toEqual(new Set(entities));
    expect(state.baselineTick).toBe(14);
  });
  it('prioritizes required groups over optional groups with omitted required flags', () => {
    const { world, entities, source, state } = setup(2);
    const [optional, required] = entities as [number, number];
    const planner = new ReplicationPlanner({ heartbeatTicks: 1000 });
    const groups = [{ key: 'required', entities: [required], required: true }];
    planner.prepare(source, state, ['r'], 1, header, 1000, 10000, { groups }).commit();
    for (const entity of entities)
      world.mutate(entity, Value, (value) => {
        value.n = 9;
      });
    const next = planner.prepare(source, state, ['r'], 2, header, 32, 10000, {
      groups,
      priority: (group) => (group.entities.includes(optional) ? 1000000 : 0),
    });
    expect(next.data.updates.map((record) => record.entity)).toEqual([required]);
    expect(next.deferred).toBe(1);
  });

  it('suppresses sub-quantum writes and emits only changed masked fields', () => {
    const { world, entities, source, state } = setup(1);
    const entity = entities[0]!;
    const planner = new ReplicationPlanner({ heartbeatTicks: 1000 });
    planner.prepare(source, state, ['r'], 1, header, 1000, 10000).commit();
    world.mutate(entity, Value, (value) => {
      value.x = 0.01;
    });
    const unchanged = planner.prepare(source, state, ['r'], 2, header, 1000, 10000);
    expect(unchanged.data.updates).toEqual([]);
    unchanged.commit();
    world.tick = 2;
    world.mutate(entity, Value, (value) => {
      value.n = 9;
    });
    const changed = planner.prepare(source, state, ['r'], 3, header, 1000, 10000);
    expect(changed.data.header.flags & SNAPSHOT_FLAG_MASKED).not.toBe(0);
    expect(update(changed.data, entity)?.components).toEqual([{ id: 0, mask: 2, value: { n: 9 } }]);
  });
  it('commits no cache state until transport handoff and rejects invalid group keys/metadata', () => {
    const { source, state, entities } = setup(2);
    const planner = new ReplicationPlanner();
    const prepared = planner.prepare(source, state, ['r'], 1, header, 100, 10000);
    expect(state.known.size).toBe(0);
    prepared.commit();
    expect(state.known.size).toBe(2);
    expect(() =>
      planner.prepare(source, state, ['r'], 2, header, 100, 10000, {
        groups: [{ key: 'entity/2', entities: [entities[0]!] }],
      }),
    ).toThrow('dependency group');
    expect(() =>
      planner.prepare(source, state, ['r'], 61, header, 100, 10000, { priority: () => Infinity }),
    ).toThrow('priority');
  });
  it('sends removal and the surviving dependency state together, when destroyed', () => {
    const { world, entities, source, state } = setup(3);
    const [a, b, c] = entities as [number, number, number];
    const groups: ReplicationGroup[] = [{ key: 'pair', entities: [a, b] }];
    const planner = new ReplicationPlanner({ heartbeatTicks: 1000 });
    planner.prepare(source, state, ['r'], 1, header, 1000, 10000, { groups }).commit();
    world.destroy(b);
    world.applyDestroys();
    world.mutate(a, Value, (value) => {
      value.n = 12;
    });
    world.mutate(c, Value, (value) => {
      value.n = 9;
    });
    const prepared = planner.prepare(source, state, ['r'], 2, header, 32, 64, {
      groups,
      priority: (group) => (group.entities.includes(c) ? 1000000 : 0),
    });
    expect(prepared.data.destroys).toContain(b);
    expect(update(prepared.data, a)?.stateTick).toBe(2);
    expect(update(prepared.data, a)?.components[0]?.value).toEqual({ n: 12 });
    prepared.commit();
    expect(state.known.has(b)).toBe(false);
  });
  it('keeps surviving dependency state coherent when relevance removes a live member', () => {
    const { world, entities, source, state } = setup(2);
    const [a, b] = entities as [number, number];
    const groups = [{ key: 'pair', entities: [a, b] }];
    const planner = new ReplicationPlanner();
    planner.prepare(source, state, ['r'], 1, header, 1000, 10000, { groups }).commit();
    source.relevance = (entity) => entity !== b;
    world.mutate(a, Value, (value) => {
      value.n = 13;
    });
    const next = planner.prepare(source, state, ['r'], 2, header, 32, 64, { groups });
    expect(world.alive(b)).toBe(true);
    expect(next.data.destroys).toEqual([b]);
    expect(update(next.data, a)?.stateTick).toBe(2);
    next.commit();
    expect(state.known.has(b)).toBe(false);
  });
  it('services an aged optional unit even when continuously dirty required units fill the hard limit', () => {
    const { world, entities, source, state } = setup(3);
    const [a, b, c] = entities as [number, number, number];
    const groups = [{ key: 'required', entities: [a, b], required: true }];
    const planner = new ReplicationPlanner({ fairnessEvery: 3, heartbeatTicks: 1000 });
    planner.prepare(source, state, ['r'], 1, header, 1000, 10000, { groups }).commit();
    world.mutate(c, Value, (value) => {
      value.n = 99;
    });
    let delivered = false;
    for (let tick = 2; tick < 12; tick++) {
      world.tick = tick;
      for (const entity of [a, b])
        world.mutate(entity, Value, (value) => {
          value.n = tick;
        });
      const next = planner.prepare(source, state, ['r'], tick, header, 64, 64, { groups });
      expect(next.bytes.length).toBeLessThanOrEqual(64);
      if (update(next.data, c)) delivered = true;
      next.commit();
    }
    expect(delivered).toBe(true);
  });
  it('reconciles prediction from a coherently deferred required group tick rather than the global snapshot', () => {
    const { world, entities, source, state } = setup(4);
    const [a, b, c, d] = entities as [number, number, number, number];
    const groups = [
      { key: 'predicted', entities: [a, b], required: true },
      { key: 'other', entities: [c, d], required: true },
    ];
    const planner = new ReplicationPlanner({ heartbeatTicks: 1000 });
    const replica = new ReplicaWorld(source.registry, [Value], { tickRate: 60, snapshotEvery: 1 });
    const initial = planner.prepare(source, state, ['r'], 1, header, 1000, 10000, { groups });
    replica.applySnapshot(initial.data);
    initial.commit();
    const inputSchema = defineInput({ tick: f.u32, throttle: f.i8 });
    const held = { ...inputSchema.create(), tick: 1, throttle: 60 };
    const driver = new PredictionDriver<
      { n: number },
      ReturnType<typeof inputSchema.create>,
      { n: number }
    >({
      inputSchema,
      tickRate: 60,
      capacity: 32,
      adapter: {
        createState: () => ({ n: 0 }),
        copyState: (from, out) => {
          out.n = from.n;
        },
        readAuthoritative: (view, out) => {
          out.n = view.replica.read(a, Value)!.n;
          const tick = view.replica.authoritativeTick!(a)!;
          return {
            coherent: tick === view.replica.authoritativeTick!(b),
            authoritativeTick: tick,
            boundaryKey: 'group',
            regionId: null,
            heldInput: held,
          };
        },
        step: (out, ctx) => {
          out.n += (ctx.input?.throttle ?? 0) * ctx.dt;
        },
        equals: (x, y) => x.n === y.n,
        sample: (_, current, __, out) => {
          out.n = current.n;
        },
      },
    });
    const view = (tick: number): ReconcileView => ({
      serverTick: tick,
      ackedTick: 0,
      ackedSeq: 0,
      entity: a,
      authoritative: replica.get(a),
      replica,
      pending: {
        length: 0,
        at() {
          throw Error('empty');
        },
      },
    });
    driver.reconcile(view(1));
    driver.recordInput({ ...held, tick: 2 });
    driver.recordInput({ ...held, tick: 5 });
    let deferred = false;
    for (let tick = 2; tick <= 5; tick++) {
      world.tick = tick;
      for (const entity of entities)
        world.mutate(entity, Value, (value) => {
          value.n = tick - 1;
        });
      const next = planner.prepare(source, state, ['r'], tick, header, 64, 64, { groups });
      replica.applySnapshot(next.data);
      next.commit();
      const groupTick = replica.authoritativeTick(a)!;
      expect(groupTick).toBe(replica.authoritativeTick(b));
      driver.reconcile(view(tick));
      expect(driver.stats().authoritativeTick).toBe(groupTick);
      if (groupTick < tick) {
        deferred = true;
        expect(driver.sample(5, { n: 0 })?.n).toBe(4);
      }
    }
    expect(deferred).toBe(true);
  });
  it('makes bounded progress through independent tombstones under a tiny transaction limit', () => {
    const { world, entities, source, state } = setup(100);
    const planner = new ReplicationPlanner();
    planner.prepare(source, state, ['r'], 1, header, 100000, 100000).commit();
    for (const entity of entities) world.destroy(entity);
    world.applyDestroys();
    for (let tick = 2; state.known.size > 0 && tick < 103; tick++) {
      const prepared = planner.prepare(source, state, ['r'], tick, header, 32, 64);
      expect(prepared.bytes.length).toBeLessThanOrEqual(64);
      expect(prepared.data.destroys.length).toBeGreaterThan(0);
      prepared.commit();
    }
    expect(state.known.size).toBe(0);
  });
});

it('reserves egress credits at queue time, refunds once, and bounds control frames', () => {
  const budget = new EgressBudget(
    {
      bytesPerSecond: 32,
      burstBytes: 64,
      maxFrameBytes: 64,
      controlMaxFrameBytes: 128,
      controlBurstBytes: 128,
    },
    0,
  );
  const reservation = budget.reserve(64, 0)!;
  expect(budget.reserve(1, 0)).toBeNull();
  reservation.refund();
  reservation.refund();
  expect(budget.available(0)).toBe(64);
  expect(budget.reserve(65, 0, true)).toBeNull();
  expect(budget.canFinish(100000, 120000)).toBe(false);
});
