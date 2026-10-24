import { Rng, v3, type Vec3 } from '@conduit/math';
import { MemoryStore } from '@conduit/persist';
import { SchemaRegistry, defineInput, f } from '@conduit/protocol';
import {
  CORE_COMPONENTS,
  Owner,
  Region,
  RegionChanged,
  Transform,
  UnknownComponent,
  World,
  defineSystem,
  slotOf,
  type EntityId,
  type RegionsApi,
  type SimContext,
} from '@conduit/sim';
import { describe, expect, it } from 'vitest';
import {
  CLAMP_EPS,
  GridWorld,
  InterestPolicy,
  InvariantViolation,
  RegionManager,
  RegionNotActive,
  contains,
  decodeBlob,
  stringCompare,
  toWorld,
  type RegionBlob,
  type RegionDef,
  type RegionId,
  type RegionMembership,
  type WorldGraph,
} from '../src/index.ts';
import {
  CELL,
  ControlledStore,
  Crate,
  at,
  defOf,
  expectRecordsMatchWorld,
  place,
  registry,
  rig,
  settle,
  type Rig,
  type RigOpts,
} from './rig.ts';

// docs/world.md §10 `test/regionManager.test.ts`: records and membership between active regions,
// migrate, determinism, and every transition of the §5.1 table driven by scripted players and
// pending regions against a RegionStore that settles on demand.

const sortedIds = (ids: readonly RegionId[]): RegionId[] => [...new Set(ids)].sort(stringCompare);

describe('RegionManager', () => {
  it('satisfies RegionsApi and RegionMembership, with nothing active before the first update', async () => {
    const { regions, graph } = rig();
    const api: RegionsApi = regions;
    const membership: RegionMembership = regions;
    expect(api.active()).toEqual([]);
    expect(membership.entitiesIn('cell/1_1')).toEqual([]);
    expect(regions.state('cell/1_1')).toBe('inactive');
    expect(regions.state('nowhere')).toBe('inactive');
    expect(regions.def('cell/1_1')).toBe(graph.get('cell/1_1'));
    expect(regions.def('nowhere')).toBeUndefined();
    expect(regions.lingering('cell/1_1')).toBe(false);
    expect(regions.inboxSize('cell/1_1')).toBe(0);
    expect(() => regions.regionRng('cell/1_1')).toThrow(RegionNotActive);
    expect(regions.membershipSystem.phase).toBe('postSim');
    await expect(regions.flushAll()).resolves.toBeUndefined();
  });

  it('the constructor rejects bad options and a registry without Region, Transform or RegionChanged', () => {
    const base = {
      graph: new GridWorld({ cellSize: CELL, cols: 2, rows: 2, worldSeed: 1 }),
      world: new World(registry),
      loader: { populate: () => {} },
      store: new MemoryStore(),
      tickRate: 60,
    };
    expect(() => new RegionManager({ ...base, tickRate: 0 })).toThrow(RangeError);
    expect(() => new RegionManager({ ...base, lingerMs: -1 })).toThrow(RangeError);
    expect(() => new RegionManager({ ...base, lingerMs: Number.NaN })).toThrow(RangeError);
    expect(() => new RegionManager({ ...base, lingerMs: undefined, log: undefined })).not.toThrow();
    const worldOf = (components: typeof CORE_COMPONENTS | [typeof Region], withEvent: boolean) =>
      new World(
        new SchemaRegistry({
          components,
          messages: [],
          events: withEvent ? [RegionChanged] : [],
          input: defineInput({ tick: f.u32 }),
        }),
      );
    expect(() => new RegionManager({ ...base, world: worldOf([Region], true) })).toThrow(
      UnknownComponent,
    );
    expect(() => new RegionManager({ ...base, world: worldOf(CORE_COMPONENTS, false) })).toThrow(
      /RegionChanged/,
    );
  });

  it('resolves equivalent RegionChanged definitions through its registry and rejects conflicts', () => {
    const construct = (event: typeof RegionChanged) =>
      new RegionManager({
        graph: new GridWorld({ cellSize: CELL, cols: 2, rows: 2, worldSeed: 1 }),
        world: new World(
          new SchemaRegistry({
            components: CORE_COMPONENTS,
            messages: [],
            events: [event],
            input: defineInput({ tick: f.u32 }),
          }),
        ),
        loader: { populate() {} },
        store: new MemoryStore(),
        tickRate: 60,
      });
    // A separately bundled definition has a distinct object identity but equal metadata/schema.
    const equivalent = Object.freeze({ ...RegionChanged });
    expect(equivalent).not.toBe(RegionChanged);
    expect(() => construct(equivalent)).not.toThrow();
    expect(() =>
      construct(Object.freeze({ ...RegionChanged, replicate: !RegionChanged.replicate })),
    ).toThrow(/RegionChanged/);
  });

  it('a wanted region starts loading at the update that wants it and activates at the next update', async () => {
    const h = rig();
    const player = place(h.world, 'cell/1_1', at(50, 50));
    const wanted = sortedIds(h.graph.wanted('cell/1_1'));
    expect(wanted).toHaveLength(9);

    await h.tick([player]);
    for (const id of wanted) expect(h.regions.state(id), id).toBe('loading');
    expect(h.regions.active()).toEqual([]);
    expect(h.populated).toEqual([]);
    expect(h.regions.entitiesIn('cell/1_1')).toEqual([]);
    expect(() => h.regions.regionRng('cell/1_1')).toThrow(RegionNotActive);

    await h.tick([player]);
    expect(h.regions.active()).toEqual(wanted);
    for (const id of wanted) expect(h.regions.state(id), id).toBe('active');
    expect(h.regions.state('cell/3_3')).toBe('inactive');
    expect(h.populated.map((p) => p.region)).toEqual(wanted); // activated in id order
    expect(h.populated.every((p) => p.tick === 1)).toBe(true); // update before step(2)
    expect(h.regions.entitiesIn('cell/1_1')).toEqual([player]);
    expect(h.regions.regionOf(player)).toBe('cell/1_1');

    // Crossing into cell/2_1 makes column 3 wanted: loading at the next update, active one later.
    const t = h.world.write(player, Transform);
    t.pos.x = 99.5;
    t.vel.x = 1;
    await h.tick([player]);
    expect(h.regions.regionOf(player)).toBe('cell/2_1');
    expect(h.regions.state('cell/3_1')).toBe('inactive');
    h.world.write(player, Transform).vel.x = 0;
    await h.tick([player]);
    for (const id of ['cell/3_0', 'cell/3_1', 'cell/3_2']) {
      expect(h.regions.state(id), id).toBe('loading');
    }
    await h.tick([player]);
    expect(h.regions.active()).toEqual(sortedIds([...wanted, ...h.graph.wanted('cell/2_1')]));
    expect(h.populated).toHaveLength(12);
  });

  it('a pending spawn region activates, with its neighbourhood, without any player entity', async () => {
    const h = rig();
    await h.tick([], ['cell/3_3']);
    expect(h.regions.state('cell/3_3')).toBe('loading');
    await h.tick([], ['cell/3_3']);
    const spawnArea = sortedIds(h.graph.wanted('cell/3_3'));
    expect(spawnArea).toEqual(['cell/2_2', 'cell/2_3', 'cell/3_2', 'cell/3_3']);
    expect(h.regions.active()).toEqual(spawnArea);
    expect(h.world.count()).toBe(0);

    // Players and pending regions together: the union, each region populated once.
    const player = place(h.world, 'cell/0_0', at(50, 50));
    for (let i = 0; i < 4; i++) await h.tick([player], ['cell/3_3', 'cell/3_3']);
    const union = sortedIds([...spawnArea, ...h.graph.wanted('cell/0_0')]);
    expect(h.regions.active()).toEqual(union);
    expect(h.populated.map((p) => p.region).sort(stringCompare)).toEqual(union);

    // A pending region the graph does not know wants nothing.
    await h.tick([player], ['nowhere']);
    expect(h.regions.active()).toEqual(union);
    expect(h.regions.state('nowhere')).toBe('inactive');
  });

  it("populate runs once per activation with a null blob and the region's seeded regionRng", async () => {
    const crates = 3;
    const h: Rig = rig({
      content(region, ctx) {
        const rng = ctx.regionRng(region.id);
        expect(rng).toBe(h.regions.regionRng(region.id));
        expect(h.regions.active()).toContain(region.id);
        for (let n = 0; n < crates; n++) {
          const e = place(ctx.world, region.id, at(rng.float() * CELL, rng.float() * CELL));
          ctx.world.add(e, Crate, { n });
        }
      },
    });
    const player = place(h.world, 'cell/1_2', at(50, 50));
    for (let i = 0; i < 10; i++) await h.tick([player]);

    const wanted = sortedIds(h.graph.wanted('cell/1_2'));
    expect(h.populated.map((p) => p.region)).toEqual(wanted);
    for (const p of h.populated) {
      const def = defOf(h.graph, p.region);
      expect(p.blob).toBeNull();
      expect(p.restored).toEqual([]);
      expect(p.rngState).toBe(def.seed >>> 0); // a fresh stream: new Rng(def.seed)
    }

    for (const id of wanted) {
      // Crates are listed in creation order (fresh ascending ids) at positions replayed from the seed.
      const replay = new Rng(defOf(h.graph, id).seed);
      const expected = Array.from({ length: crates }, () =>
        at(replay.float() * CELL, replay.float() * CELL),
      );
      const listed = h.regions.entitiesIn(id).filter((e) => h.world.has(e, Crate));
      expect(listed.map((e) => h.world.get(e, Transform).pos)).toEqual(expected);
      // The stream is the same instance on every call and continues where populate left it.
      const rng = h.regions.regionRng(id);
      expect(h.regions.regionRng(id)).toBe(rng);
      expect(h.sim.ctx.regionRng(id)).toBe(rng);
      expect(rng.state()).toBe(replay.state());
    }

    // InterestPolicy reads the manager directly.
    const interest = new InterestPolicy({ graph: h.graph, regions: h.regions });
    const all = h.world.queryInto([], Region).sort((a, b) => a - b);
    expect(interest.visible({ player, wanted, reported: wanted }, [])).toEqual(all);
    expect(all).toHaveLength(1 + crates * wanted.length);
  });

  it('entitiesIn and regionOf track creates by populate, hooks and systems, and drop destroyed entities', async () => {
    const script = {
      spawn: [] as RegionId[],
      /** Created and destroyed in the same system call. */
      ephemeral: [] as RegionId[],
      kill: [] as EntityId[],
      spawned: [] as EntityId[],
    };
    const lifecycle = defineSystem('lifecycle', 'preSim', (ctx) => {
      for (const id of script.spawn.splice(0)) {
        script.spawned.push(place(ctx.world, id, at(20, 20)));
      }
      for (const id of script.ephemeral.splice(0)) {
        const e = place(ctx.world, id, at(20, 20));
        script.spawned.push(e);
        ctx.world.destroy(e);
      }
      for (const e of script.kill.splice(0)) ctx.world.destroy(e);
    });
    const h = rig({
      systems: [lifecycle],
      content(region, ctx) {
        for (let n = 0; n < 2; n++)
          ctx.world.add(place(ctx.world, region.id, at(10 + n, 10)), Crate, { n });
      },
    });
    const player = place(h.world, 'cell/1_1', at(50, 50));
    await h.tick([player]);
    await h.tick([player]);
    const [crateA, crateB] = h.regions.entitiesIn('cell/1_1').filter((e) => e !== player);
    if (crateA === undefined || crateB === undefined) throw new Error('populate made no crates');
    expect(h.regions.entitiesIn('cell/1_1')).toEqual(
      [player, crateA, crateB].sort((a, b) => a - b),
    );
    expectRecordsMatchWorld(h);

    // Created by a hook between steps: listed by the next update, before the step's systems run.
    const hooked = place(h.world, 'cell/2_2', at(30, 30));
    expect(h.regions.regionOf(hooked)).toBe('cell/2_2');
    h.regions.update([player], h.sim.ctx);
    expect(h.regions.entitiesIn('cell/2_2')).toContain(hooked);
    h.sim.step(h.world.tick + 1);
    expectRecordsMatchWorld(h);

    // Created by a system during the step: listed by that step's membership pass.
    script.spawn.push('cell/1_2');
    await h.tick([player]);
    const spawned = script.spawned[0] as EntityId;
    expect(h.regions.entitiesIn('cell/1_2')).toContain(spawned);
    expectRecordsMatchWorld(h);

    // Created in a region that is not active: not listed until the region activates.
    const far = place(h.world, 'cell/3_3', at(40, 40));
    await h.tick([player]);
    expect(h.regions.entitiesIn('cell/3_3')).toEqual([]);
    expect(h.regions.regionOf(far)).toBe('cell/3_3');
    await h.tick([player], ['cell/3_3']);
    await h.tick([player], ['cell/3_3']);
    expect(h.regions.state('cell/3_3')).toBe('active');
    expect(h.regions.entitiesIn('cell/3_3')).toContain(far);
    expectRecordsMatchWorld(h);

    // Destroyed by a system, and by a hook between steps: gone once the step has applied destroys.
    script.kill.push(crateA, hooked);
    h.world.destroy(crateB);
    await h.tick([player], ['cell/3_3']);
    for (const e of [crateA, crateB, hooked]) {
      expect(h.world.alive(e)).toBe(false);
      expect(h.regions.regionOf(e)).toBeUndefined();
    }
    expect(h.regions.entitiesIn('cell/1_1')).toEqual([player]);
    expect(h.regions.entitiesIn('cell/2_2')).not.toContain(hooked);
    expectRecordsMatchWorld(h);

    // Reused slots carry a higher generation, so larger ids: lists stay ascending by id.
    const reused = [
      place(h.world, 'cell/1_1', at(1, 1)),
      place(h.world, 'cell/1_1', at(2, 2)),
      place(h.world, 'cell/1_1', at(3, 3)),
    ];
    expect(reused.map(slotOf).sort((a, b) => a - b)).toEqual(
      [crateA, crateB, hooked].map(slotOf).sort((a, b) => a - b),
    );
    await h.tick([player], ['cell/3_3']);
    const list = h.regions.entitiesIn('cell/1_1');
    expect(list).toEqual([...list].sort((a, b) => a - b));
    expect(list).toEqual([player, ...reused].sort((a, b) => a - b));

    // Created and destroyed within one tick: never listed, then or later.
    script.ephemeral.push('cell/1_1');
    await h.tick([player], ['cell/3_3']);
    const ephemeral = script.spawned[1] as EntityId;
    expect(h.world.alive(ephemeral)).toBe(false);
    await h.tick([player], ['cell/3_3']);
    expect(h.regions.entitiesIn('cell/1_1')).toEqual([player, ...reused].sort((a, b) => a - b));
    expectRecordsMatchWorld(h);

    // A Region.id written directly (games should call migrate) still moves the record.
    const moved = reused[0] as EntityId;
    h.world.write(moved, Region).id = 'cell/2_1';
    await h.tick([player], ['cell/3_3']);
    expect(h.regions.entitiesIn('cell/1_1')).not.toContain(moved);
    expect(h.regions.entitiesIn('cell/2_1')).toContain(moved);
    expectRecordsMatchWorld(h);
  });

  it('a throwing populate propagates, and the regions queued behind it activate at the next update', async () => {
    const h = rig({
      content(region) {
        if (region.id === 'cell/0_0') throw new Error('populate failed');
      },
    });
    await h.tick([], ['cell/0_0']);
    expect(() => h.regions.update([], h.sim.ctx, ['cell/0_0'])).toThrow('populate failed');
    expect(h.regions.state('cell/0_0')).toBe('active');
    expect(h.regions.state('cell/1_1')).toBe('loading');
    h.sim.step(h.world.tick + 1);
    await h.tick([], ['cell/0_0']);
    const area = ['cell/0_0', 'cell/0_1', 'cell/1_0', 'cell/1_1'];
    expect(h.regions.active()).toEqual(area);
    expect(h.populated.map((p) => p.region)).toEqual(area);
  });

  it('update refuses to run inside a step', async () => {
    const h: Rig = rig({
      systems: [defineSystem('meddler', 'sim', (ctx) => h.regions.update([], ctx))],
    });
    await expect(h.tick()).rejects.toThrow(/between steps/);
  });
});

describe('membershipSystem', () => {
  it('moves an entity across a border into an active neighbour, rebased, with RegionChanged', async () => {
    const h = rig();
    const player = place(h.world, 'cell/1_1', at(50, 50));
    const mover = place(h.world, 'cell/1_1', at(99.5, 40, 2));
    await h.tick([player]);
    await h.tick([player]);
    const from = defOf(h.graph, 'cell/1_1');
    const to = defOf(h.graph, 'cell/2_1');
    expect(toWorld(from, at(100, 40, 2))).toEqual(at(200, 140, 2));

    h.world.write(mover, Transform).vel.x = 0.25;
    await h.tick([player]); // 99.75: still inside
    expect(h.changes).toEqual([]);
    await h.tick([player]); // 100: across the border
    expect(h.regions.regionOf(mover)).toBe('cell/2_1');
    const pos = h.world.get(mover, Transform).pos;
    expect(pos).toEqual(at(0, 40, 2));
    expect(toWorld(to, pos)).toEqual(at(200, 140, 2)); // world position continuous
    expect(h.regions.entitiesIn('cell/1_1')).toEqual([player]);
    expect(h.regions.entitiesIn('cell/2_1')).toEqual([mover]);
    expect(h.changes).toEqual([{ tick: 4, entity: mover, from: 'cell/1_1', to: 'cell/2_1' }]);
    // Written during step 4, so the snapshot for tick 4 replicates both (docs/sim.md 2.3).
    expect(h.world.store(Region).version[slotOf(mover)]).toBe(4);
    expect(h.world.store(Transform).version[slotOf(mover)]).toBe(4);

    h.world.write(mover, Transform).vel.x = 0;
    await h.tick([player]);
    expect(h.changes).toHaveLength(1);
  });

  it('rebases exactly in every direction, including diagonals, in ascending slot order', async () => {
    const h = rig();
    const player = place(h.world, 'cell/1_1', at(50, 50));
    await h.tick([player]);
    await h.tick([player]);
    const cases: { start: Vec3; vel: Vec3; to: RegionId; local: Vec3 }[] = [
      { start: at(99.75, 99.75), vel: at(0.25, 0.25), to: 'cell/2_2', local: at(0, 0) },
      { start: at(0, 50, 5), vel: at(-0.25, 0), to: 'cell/0_1', local: at(99.75, 50, 5) },
      { start: at(10, 0), vel: at(0, -0.5), to: 'cell/1_0', local: at(10, 99.5) },
      { start: at(0.125, 0.125), vel: at(-0.25, -0.25), to: 'cell/0_0', local: at(99.875, 99.875) },
      { start: at(50, 99.5), vel: at(0, 0.5), to: 'cell/1_2', local: at(50, 0) },
    ];
    const movers = cases.map((c) => place(h.world, 'cell/1_1', c.start, c.vel));
    await h.tick([player]);
    cases.forEach((c, i) => {
      const e = movers[i] as EntityId;
      expect(h.regions.regionOf(e), c.to).toBe(c.to);
      expect(h.world.get(e, Transform).pos, c.to).toEqual(c.local);
      expect(h.regions.entitiesIn(c.to), c.to).toEqual([e]);
    });
    expect(h.changes.map((c) => c.entity)).toEqual(movers);
    expect(h.regions.entitiesIn('cell/1_1')).toEqual([player]);
    expectRecordsMatchWorld(h);
  });

  it('an entity heading into a loading region, or an inactive one being retried, waits at the border', async () => {
    const store = new ControlledStore();
    const h = rig({ store });
    const area = ['cell/0_0', 'cell/0_1', 'cell/1_0', 'cell/1_1'];
    await h.tick([], ['cell/0_0']);
    for (const id of area) store.resolveGet(id, null);
    await settle();
    await h.tick([], ['cell/0_0']);
    expect(h.regions.active()).toEqual(area);
    const inbound = place(h.world, 'cell/1_1', at(99.5, 50), at(1, 0));

    // cell/2_1 is wanted and loading: the entity waits outside its region, still listed there.
    await h.tick([], ['cell/0_0', 'cell/2_1']);
    for (const id of ['cell/2_0', 'cell/2_1', 'cell/2_2', 'cell/1_2', 'cell/3_1']) {
      expect(h.regions.state(id), id).toBe('loading');
    }
    expect(h.regions.regionOf(inbound)).toBe('cell/1_1');
    expect(h.world.get(inbound, Transform).pos).toEqual(at(100.5, 50));
    expect(h.regions.entitiesIn('cell/1_1')).toEqual([inbound]);

    // Its load fails: inactive until the retry, but still wanted, so the entity keeps waiting.
    store.rejectGet('cell/2_1');
    await settle();
    expect(h.regions.state('cell/2_1')).toBe('loading'); // failures apply at an update boundary
    await h.tick([], ['cell/0_0', 'cell/2_1']);
    expect(h.regions.state('cell/2_1')).toBe('inactive');
    await h.tick([], ['cell/0_0', 'cell/2_1']);
    expect(h.regions.regionOf(inbound)).toBe('cell/1_1');
    expect(h.regions.inboxSize('cell/2_1')).toBe(0);
    expect(h.world.alive(inbound)).toBe(true);
    expect(h.changes).toEqual([]);
    expect(h.logs.map((l) => l.level)).toEqual(['error']);
  });

  it('an entity leaving the world is clamped back inside its region and onWorldEdge is called', async () => {
    const h = rig();
    await h.tick([], ['cell/0_0', 'cell/3_3']);
    await h.tick([], ['cell/0_0', 'cell/3_3']);
    const west = place(h.world, 'cell/0_0', at(0.5, 50), at(-1, 0));
    const north = place(h.world, 'cell/1_0', at(50, 0.25, 7), at(0, -0.5));
    const east = place(h.world, 'cell/3_3', at(99.5, 20), at(1, 0.5));
    await h.tick([], ['cell/0_0', 'cell/3_3']); // tick 3: west x -0.5, north z -0.25, east x 100.5
    expect(h.world.get(west, Transform).pos).toEqual(at(0, 50));
    expect(h.world.get(north, Transform).pos).toEqual(at(50, 0, 7));
    expect(h.world.get(east, Transform).pos).toEqual(at(100 - CLAMP_EPS, 20.5));
    await h.tick([], ['cell/0_0', 'cell/3_3']); // tick 4: pushed out again, clamped again
    expect(h.world.get(west, Transform).pos).toEqual(at(0, 50));
    expect(h.world.get(north, Transform).pos).toEqual(at(50, 0, 7));
    expect(h.world.get(east, Transform).pos).toEqual(at(100 - CLAMP_EPS, 21));
    for (const [e, id] of [
      [west, 'cell/0_0'],
      [north, 'cell/1_0'],
      [east, 'cell/3_3'],
    ] as const) {
      expect(h.regions.regionOf(e), id).toBe(id);
      expect(contains(defOf(h.graph, id), h.world.get(e, Transform).pos), id).toBe(true);
      expect(h.world.store(Transform).version[slotOf(e)]).toBe(h.world.tick);
    }
    expect(h.changes).toEqual([]);
    for (const e of [west, north, east]) {
      expect(h.edges.filter((edge) => edge.entity === e).map((edge) => edge.tick)).toEqual([3, 4]);
    }
    expectRecordsMatchWorld(h);
  });

  it('float noise at a border never moves an entity into its own region', async () => {
    const h = rig();
    const player = place(h.world, 'cell/2_2', at(50, 50));
    await h.tick([player]);
    await h.tick([player]);
    const def = defOf(h.graph, 'cell/2_2');
    const edge = place(h.world, 'cell/2_2', at(-1e-14, 50));
    // Outside by contains(), yet its world position rounds onto the region's own origin.
    const pos = h.world.get(edge, Transform).pos;
    expect(contains(def, pos)).toBe(false);
    const worldPos = toWorld(def, pos);
    expect(worldPos.x).toBe(def.bounds.origin.x);
    expect(h.graph.locate(worldPos, 'cell/2_2')).toBe('cell/2_2');

    await h.tick([player]); // tick 3 records it; no pass rewrites it afterwards
    await h.tick([player]);
    expect(h.regions.regionOf(edge)).toBe('cell/2_2');
    expect(h.world.get(edge, Transform).pos.x).toBe(-1e-14);
    expect(h.world.store(Region).version[slotOf(edge)]).toBe(3);
    expect(h.regions.entitiesIn('cell/2_2')).toEqual([player, edge]);
    expect(h.changes).toEqual([]);
  });

  it('an entity destroyed this tick is pruned from its region and never relocated', async () => {
    const doomed: EntityId[] = [];
    const reaper = defineSystem('reaper', 'postSim', (ctx) => {
      for (const e of doomed.splice(0)) ctx.world.destroy(e);
    });
    const h = rig({ systems: [reaper] });
    const player = place(h.world, 'cell/1_1', at(50, 50));
    await h.tick([player]);
    await h.tick([player]);
    // Doomed while crossing into an active region, or into an inactive unwanted one (cell/3_1):
    // neither moved nor inboxed.
    const crossing = place(h.world, 'cell/1_1', at(99.5, 50), at(1, 0));
    const leaving = place(h.world, 'cell/1_1', at(2 * CELL + 50.5, 50));
    doomed.push(crossing, leaving);
    await h.tick([player]);
    expect(h.world.alive(crossing)).toBe(false);
    expect(h.world.alive(leaving)).toBe(false);
    expect(h.changes).toEqual([]);
    expect(h.regions.inboxSize('cell/3_1')).toBe(0);
    expect(h.regions.entitiesIn('cell/1_1')).toEqual([player]);
    expect(h.regions.entitiesIn('cell/2_1')).toEqual([]);
    expectRecordsMatchWorld(h);
  });
});

describe('RegionManager.migrate', () => {
  it('moves into active regions, defers loading ones, inboxes into inactive ones and rejects bad targets', async () => {
    const h = rig();
    const player = place(h.world, 'cell/1_1', at(50, 50));
    const crate = place(h.world, 'cell/1_1', at(10, 10, 1));
    const other = place(h.world, 'cell/1_1', at(20, 20, 1));
    h.world.add(other, Crate, { n: 9 });
    const bare = h.world.create();
    await h.tick([player]);
    expect(h.regions.migrate(crate, 'cell/2_2', at(5, 5))).toBe('deferred'); // loading
    await h.tick([player]);

    expect(h.regions.migrate(bare, 'cell/2_2')).toBe('notMember');
    expect(h.regions.migrate(crate, 'cell/1_1')).toBe('same');
    expect(h.regions.migrate(crate, 'cell/9_9')).toBe('unknownRegion');
    expect(h.regions.migrate(crate, 'cell/2_2')).toBe('outOfBounds'); // rebased to (-90, 1, -90)
    expect(h.regions.migrate(crate, 'cell/2_2', at(100, 5))).toBe('outOfBounds');
    expect(h.regions.regionOf(crate)).toBe('cell/1_1');

    expect(h.regions.migrate(crate, 'cell/2_2', at(5, 5))).toBe('moved');
    expect(h.regions.regionOf(crate)).toBe('cell/2_2');
    expect(h.world.get(crate, Transform).pos).toEqual(at(5, 5));
    expect(h.regions.entitiesIn('cell/2_2')).toEqual([crate]);
    expect(h.regions.entitiesIn('cell/1_1')).toEqual([player, other]);

    // Without newLocalPos the position is rebased, keeping the world position.
    h.world.write(crate, Transform).pos.x = -0.5;
    expect(h.regions.migrate(crate, 'cell/1_2')).toBe('moved');
    expect(h.world.get(crate, Transform).pos).toEqual(at(99.5, 5));

    // RegionChanged goes on the bus: the next step's systems and tail see both moves.
    await h.tick([player]);
    expect(h.changes.map((c) => [c.entity, c.from, c.to])).toEqual([
      [crate, 'cell/1_1', 'cell/2_2'],
      [crate, 'cell/2_2', 'cell/1_2'],
    ]);
    expectRecordsMatchWorld(h);

    // Into an inactive region: persisted components to its inbox at the new position, entity gone.
    expect(h.regions.state('cell/3_3')).toBe('inactive');
    expect(h.regions.migrate(other, 'cell/3_3', at(1, 2, 3))).toBe('inboxed');
    expect(h.regions.inboxSize('cell/3_3')).toBe(1);
    expect(h.regions.entitiesIn('cell/1_1')).toEqual([player]);
    expect(() => h.regions.migrate(player, 'cell/3_3', at(1, 1))).toThrow(InvariantViolation);
    await h.tick([player]);
    expect(h.world.alive(other)).toBe(false);
    expect(h.changes).toHaveLength(2);

    // An entity destroyed and then migrated in the same tick is still dropped from every record, and
    // is not resurrected through an inbox.
    h.world.destroy(crate);
    expect(h.regions.migrate(crate, 'cell/0_0', at(1, 1))).toBe('moved');
    const doomed = place(h.world, 'cell/1_1', at(3, 3));
    h.world.add(doomed, Crate, { n: 1 });
    h.regions.update([player], h.sim.ctx);
    h.world.destroy(doomed);
    expect(h.regions.migrate(doomed, 'cell/3_3', at(1, 1))).toBe('inboxed');
    expect(h.regions.inboxSize('cell/3_3')).toBe(1);
    h.sim.step(h.world.tick + 1);
    await settle();
    expect(h.world.alive(crate)).toBe(false);
    expect(h.world.alive(doomed)).toBe(false);
    for (const id of h.regions.active()) expect(h.regions.entitiesIn(id), id).not.toContain(crate);
    expectRecordsMatchWorld(h);
  });
});

// ---------------------------------------------------------------------------------------------
// §5.1 transition table

const LINGER_TICKS = 30; // lingerMs 500 at 60 Hz
const RETRY_TICKS = 300; // RETRY_MS 5000 at 60 Hz

/** A 4 x 4 grid whose regions want only themselves, so each transition involves one region. */
function soloGrid(): GridWorld {
  return new GridWorld({ cellSize: CELL, cols: 4, rows: 4, worldSeed: 77, wantedDepth: 0 });
}

/** Two crates from the region stream in a fresh region; nothing extra for a saved one. */
function crates(region: RegionDef, ctx: SimContext, blob: RegionBlob | null): void {
  if (blob !== null) return;
  const rng = ctx.regionRng(region.id);
  for (let n = 0; n < 2; n++) {
    const e = place(ctx.world, region.id, at(rng.int(1, 99), rng.int(1, 99)));
    ctx.world.add(e, Crate, { n });
  }
}

/** The crates among `entities` as `{ crate, pos }`, ordered by crate number. */
function byCrate(h: Rig, entities: readonly EntityId[]): { crate: number; pos: Vec3 }[] {
  return entities
    .filter((e) => h.world.has(e, Crate))
    .map((e) => ({ crate: h.world.get(e, Crate).n, pos: v3.copy(h.world.get(e, Transform).pos) }))
    .sort((a, b) => a.crate - b.crate);
}

interface Machine extends Rig {
  store: ControlledStore;
}

function machine(opts: RigOpts = {}): Machine {
  const store = new ControlledStore();
  const h = rig({
    graph: soloGrid(),
    store,
    lingerMs: 500,
    content: crates,
    gameData: (region, ctx) => ({ region: region.id, tick: ctx.tick }),
    ...opts,
  });
  return { ...h, store };
}

/** Wants `id` until it is active (its get resolved with `bytes`). */
async function activate(h: Machine, id: RegionId, bytes: Uint8Array | null = null): Promise<void> {
  await h.tick([], [id]);
  expect(h.regions.state(id)).toBe('loading');
  h.store.resolveGet(id, bytes);
  await settle();
  await h.tick([], [id]);
  expect(h.regions.state(id)).toBe('active');
}

/** Ticks without wanting anything until `id` starts saving; returns the tick it did. */
async function evict(h: Machine, id: RegionId): Promise<number> {
  for (let i = 0; i <= LINGER_TICKS + 1; i++) {
    await h.tick([], []);
    if (h.regions.state(id) === 'saving') return h.world.tick;
  }
  throw new Error(`${id} never started saving`);
}

describe('RegionManager state machine (docs/world.md §5.1)', () => {
  it('inactive -> loading on wanted (store.get), loading -> active at the first update after it resolves', async () => {
    const h = machine();
    await h.tick([], ['cell/1_1']); // tick 1
    expect(h.regions.state('cell/1_1')).toBe('loading');
    expect(h.store.calls).toEqual(['get region/cell/1_1']);
    await h.tick([], ['cell/1_1']); // tick 2: still loading, no second get
    expect(h.regions.state('cell/1_1')).toBe('loading');
    expect(h.store.calls).toHaveLength(1);

    h.store.resolveGet('cell/1_1', null);
    await settle();
    expect(h.regions.state('cell/1_1')).toBe('loading'); // activation waits for the update boundary
    expect(h.populated).toEqual([]);

    await h.tick([], ['cell/1_1']); // tick 3
    expect(h.regions.state('cell/1_1')).toBe('active');
    expect(h.populated).toMatchObject([{ region: 'cell/1_1', tick: 2, blob: null }]);
    expect(h.regions.entitiesIn('cell/1_1')).toHaveLength(2);
    expect(h.regions.lingering('cell/1_1')).toBe(false);
  });

  it('a region that stops being wanted while loading still activates, then lingers', async () => {
    const h = machine();
    await h.tick([], ['cell/1_1']);
    await h.tick([], []);
    expect(h.regions.state('cell/1_1')).toBe('loading');
    h.store.resolveGet('cell/1_1', null);
    await settle();
    await h.tick([], []);
    expect(h.regions.state('cell/1_1')).toBe('active');
    expect(h.regions.lingering('cell/1_1')).toBe(true);
  });

  it('applies transient load failures at the next boundary, retries them, and rejects unknown save formats', async () => {
    const h = machine();
    await h.tick([], ['cell/1_1']); // tick 1: get #1
    h.store.rejectGet('cell/1_1');
    await settle();
    expect(h.regions.state('cell/1_1')).toBe('loading');
    await h.tick([], ['cell/1_1']);
    expect(h.regions.state('cell/1_1')).toBe('inactive');
    expect(h.logs).toEqual([
      { level: 'error', msg: expect.stringContaining("'cell/1_1'"), err: expect.any(Error) },
    ]);
    // The next update is tick 2: wanted from then on, it loads again at tick 2 + RETRY_TICKS.
    for (let t = 3; t < 2 + RETRY_TICKS; t++) await h.tick([], ['cell/1_1']);
    expect(h.regions.state('cell/1_1')).toBe('inactive');
    expect(h.store.calls).toHaveLength(1);
    await h.tick([], ['cell/1_1']); // tick 302
    expect(h.world.tick).toBe(2 + RETRY_TICKS);
    expect(h.regions.state('cell/1_1')).toBe('loading');
    expect(h.store.calls).toEqual(['get region/cell/1_1', 'get region/cell/1_1']);

    h.store.resolveGet('cell/1_1', new TextEncoder().encode('{"version":2}'));
    await settle();
    expect(h.regions.state('cell/1_1')).toBe('loading');
    await expect(h.tick([], ['cell/1_1'])).rejects.toThrow('invalid stored region');
    expect(h.store.calls).toHaveLength(2);
  });

  it('active -> lingering when not wanted, cancelled when wanted again, and saving after exactly lingerTicks', async () => {
    const h = machine();
    await activate(h, 'cell/1_1'); // ticks 1-2
    await h.tick([], []); // tick 3: linger starts
    expect(h.regions.lingering('cell/1_1')).toBe(true);
    expect(h.regions.state('cell/1_1')).toBe('active');
    await h.tick([], ['cell/1_1']); // tick 4: wanted again
    expect(h.regions.lingering('cell/1_1')).toBe(false);

    await h.tick([], []); // tick 5: a fresh linger, until tick 5 + LINGER_TICKS
    for (let t = 6; t < 5 + LINGER_TICKS; t++) {
      await h.tick([], []);
      expect(h.regions.state('cell/1_1'), `tick ${t}`).toBe('active');
    }
    expect(h.store.pendingPuts()).toEqual([]);
    await h.tick([], []);
    expect(h.world.tick).toBe(5 + LINGER_TICKS);
    expect(h.regions.state('cell/1_1')).toBe('saving');
  });

  it('lingering -> saving on expiry removes the entities and writes the blob; saving -> inactive when the put resolves', async () => {
    const h = machine();
    await activate(h, 'cell/1_1');
    const listed = [...h.regions.entitiesIn('cell/1_1')];
    const positions = listed.map((e) => v3.copy(h.world.get(e, Transform).pos));
    const rngState = h.regions.regionRng('cell/1_1').state();
    const tick = await evict(h, 'cell/1_1');

    expect(h.regions.state('cell/1_1')).toBe('saving');
    expect(h.regions.active()).toEqual([]);
    expect(h.regions.entitiesIn('cell/1_1')).toEqual([]);
    expect(h.regions.lingering('cell/1_1')).toBe(false);
    expect(() => h.regions.regionRng('cell/1_1')).toThrow(RegionNotActive);
    for (const e of listed) expect(h.world.alive(e)).toBe(false); // destroyed by that tick's step
    expect(h.deactivated).toEqual([{ region: 'cell/1_1', tick: tick - 1 }]);
    expect(h.store.pendingPuts()).toEqual(['cell/1_1']);

    const bytes = h.store.resolvePut('cell/1_1');
    const blob = decodeBlob(bytes) as RegionBlob;
    expect(blob).toEqual({
      version: 1,
      savedTick: tick - 1,
      entities: positions.map((pos, n) => ({
        components: [
          ['Crate', { n }],
          ['Transform', { pos, rot: { x: 0, y: 0, z: 0, w: 1 }, vel: at(0, 0) }],
        ],
      })),
      rngState,
      gameData: { region: 'cell/1_1', tick: tick - 1 },
    });
    expect(h.regions.state('cell/1_1')).toBe('saving'); // until the put's callback runs
    await settle();
    expect(h.regions.state('cell/1_1')).toBe('saving');
    await h.tick([], []); // completion becomes authoritative at this boundary
    expect(h.regions.state('cell/1_1')).toBe('inactive');
    expect(h.store.data.get('region/cell/1_1')).toEqual(bytes);
  });

  it('a saved region reloads from its in-memory blob without store.get, restoring entities, game data and the rng stream', async () => {
    const h = machine();
    await activate(h, 'cell/1_1');
    const rng = h.regions.regionRng('cell/1_1');
    for (let i = 0; i < 5; i++) rng.next();
    const expected = new Rng(0);
    expected.restore(rng.state());
    const saved = byCrate(h, h.regions.entitiesIn('cell/1_1'));
    await evict(h, 'cell/1_1');
    h.store.resolvePut('cell/1_1');
    await settle();
    expect(h.regions.state('cell/1_1')).toBe('saving');

    await h.tick([], ['cell/1_1']);
    expect(h.regions.state('cell/1_1')).toBe('loading');
    await h.tick([], ['cell/1_1']);
    expect(h.regions.state('cell/1_1')).toBe('active');
    expect(h.store.calls.filter((c) => c.startsWith('get'))).toHaveLength(1); // the first load only

    const reload = h.populated[1];
    expect(reload?.blob?.gameData).toEqual({ region: 'cell/1_1', tick: expect.any(Number) });
    expect(reload?.rngState).toBe(expected.state());
    expect(reload?.restored).toEqual(h.regions.entitiesIn('cell/1_1'));
    // Restored in blob order; freed slots are reused last-in first-out, so ids may come back in
    // another order.
    expect(byCrate(h, h.regions.entitiesIn('cell/1_1'))).toEqual(saved);
    for (const e of h.regions.entitiesIn('cell/1_1')) {
      expect(h.world.get(e, Region).id).toBe('cell/1_1');
    }
    const stream = h.regions.regionRng('cell/1_1');
    for (let i = 0; i < 100; i++) expect(stream.next()).toBe(expected.next());
  });

  it('saving -> active when the put rejects: re-activated from memory with a fresh linger timer, saved again at its expiry', async () => {
    const h = machine();
    await activate(h, 'cell/1_1');
    const saved = byCrate(h, h.regions.entitiesIn('cell/1_1'));
    await evict(h, 'cell/1_1');
    h.store.rejectPut('cell/1_1');
    await settle();
    expect(h.logs).toEqual([]);
    expect(h.regions.state('cell/1_1')).toBe('saving');
    await h.tick([], []); // external completion is applied here before activation
    expect(h.logs).toEqual([
      { level: 'error', msg: expect.stringContaining("'cell/1_1'"), err: expect.any(Error) },
    ]);
    const reactivatedAt = h.world.tick;
    expect(h.regions.state('cell/1_1')).toBe('active');
    expect(h.regions.lingering('cell/1_1')).toBe(true);
    expect(h.populated).toHaveLength(2);
    expect(h.populated[1]?.blob).not.toBeNull();
    expect(byCrate(h, h.regions.entitiesIn('cell/1_1'))).toEqual(saved);
    expect(h.store.calls.filter((c) => c.startsWith('get'))).toHaveLength(1);

    const again = await evict(h, 'cell/1_1');
    expect(again).toBe(reactivatedAt + LINGER_TICKS);
    expect(h.store.pendingPuts()).toEqual(['cell/1_1']);
  });

  it('saving -> loading when wanted while saving: activates from memory once the put settles, without store.get', async () => {
    const h = machine();
    await activate(h, 'cell/1_1');
    await evict(h, 'cell/1_1');
    await h.tick([], ['cell/1_1']);
    expect(h.regions.state('cell/1_1')).toBe('loading');
    await h.tick([], ['cell/1_1']);
    expect(h.regions.state('cell/1_1')).toBe('loading'); // the put is still pending
    h.store.resolvePut('cell/1_1');
    await settle();
    expect(h.regions.state('cell/1_1')).toBe('loading');
    await h.tick([], ['cell/1_1']);
    expect(h.regions.state('cell/1_1')).toBe('active');
    expect(h.regions.lingering('cell/1_1')).toBe(false);
    expect(h.store.calls).toEqual(['get region/cell/1_1', 'put region/cell/1_1']);
    expect(h.populated.map((p) => p.blob === null)).toEqual([true, false]);
    expect(h.regions.entitiesIn('cell/1_1')).toHaveLength(2);

    // Wanted while saving and the put fails: activates once all the same.
    await evict(h, 'cell/1_1');
    await h.tick([], ['cell/1_1']);
    h.store.rejectPut('cell/1_1');
    await settle();
    await h.tick([], ['cell/1_1']);
    expect(h.regions.state('cell/1_1')).toBe('active');
    expect(h.populated).toHaveLength(3);
    expect(h.regions.entitiesIn('cell/1_1')).toHaveLength(2);
  });

  it('a region listed in pending is loaded and kept active without any player entity', async () => {
    const h = machine();
    await activate(h, 'cell/2_2');
    for (let i = 0; i < 3 * LINGER_TICKS; i++) await h.tick([], ['cell/2_2']);
    expect(h.regions.state('cell/2_2')).toBe('active');
    expect(h.regions.lingering('cell/2_2')).toBe(false);
    expect(h.store.pendingPuts()).toEqual([]);
    expect(h.world.count()).toBe(2); // its crates, no player
    await evict(h, 'cell/2_2');
    expect(h.store.pendingPuts()).toEqual(['cell/2_2']);
  });

  it('eviction saves entities hooks created before the update, and not ones queued for destroy', async () => {
    const h = machine();
    await activate(h, 'cell/1_1');
    const [first, second] = h.regions.entitiesIn('cell/1_1');
    for (let i = 0; i < LINGER_TICKS; i++) await h.tick([], []);
    expect(h.regions.state('cell/1_1')).toBe('active'); // expires at the next update
    // Between steps, as Session hooks do: one crate is created, one destroyed.
    const hooked = place(h.world, 'cell/1_1', at(42, 43));
    h.world.add(hooked, Crate, { n: 7 });
    h.world.destroy(first as EntityId);
    await h.tick([], []);
    expect(h.regions.state('cell/1_1')).toBe('saving');
    for (const e of [first, second, hooked]) expect(h.world.alive(e as EntityId)).toBe(false);
    const blob = decodeBlob(h.store.resolvePut('cell/1_1')) as RegionBlob;
    expect(blob.entities.map((s) => s.components[0])).toEqual([
      ['Crate', { n: 1 }],
      ['Crate', { n: 7 }],
    ]);
  });

  it('deactivate with a player present throws InvariantViolation and keeps the region active', async () => {
    const base = soloGrid();
    const omitted = new Set<RegionId>();
    // A graph whose wanted can leave out a player's own region: the manager must still never evict it.
    const graph: WorldGraph = {
      wantedDepth: base.wantedDepth,
      get: (id) => base.get(id),
      neighbors: (id) => base.neighbors(id),
      locate: (pos, hint) => base.locate(pos, hint),
      wanted: (id, depth) => (omitted.has(id) ? [] : base.wanted(id, depth)),
      toJson: () => base.toJson(),
    };
    const h = machine({ graph });
    const player = place(h.world, 'cell/1_1', at(50, 50));
    h.world.add(player, Owner, { player: 0 });
    await h.tick([player]);
    h.store.resolveGet('cell/1_1', null);
    await settle();
    await h.tick([player]);
    expect(h.regions.entitiesIn('cell/1_1')).toContain(player);

    omitted.add('cell/1_1');
    for (let i = 0; i < LINGER_TICKS; i++) await h.tick([player]); // expires at the next update
    let caught: unknown;
    try {
      h.regions.update([player], h.sim.ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvariantViolation);
    expect(caught).toMatchObject({ regionId: 'cell/1_1', entity: player });
    expect(h.regions.state('cell/1_1')).toBe('active');
    expect(h.regions.lingering('cell/1_1')).toBe(true); // tried again when a fresh timer expires
    expect(h.regions.entitiesIn('cell/1_1')).toContain(player);
    expect(h.world.alive(player)).toBe(true);
    expect(h.store.pendingPuts()).toEqual([]);
    expect(() => h.regions.update([player], h.sim.ctx)).not.toThrow();
  });

  it('flushAll waits for saves in flight, writes active regions without evicting them and rewrites a failed save', async () => {
    const h = machine();
    await activate(h, 'cell/0_0');
    await evict(h, 'cell/0_0'); // put pending
    await activate(h, 'cell/3_3');
    expect(h.store.pendingPuts()).toEqual(['cell/0_0']);

    const evictions = h.store.transactions; // an eviction saves in a transaction of its own
    let flushed = false;
    const flushing = h.regions.flushAll().then(() => {
      flushed = true;
    });
    await settle();
    expect(h.store.transactions).toBe(evictions); // waiting for cell/0_0's put
    h.store.rejectPut('cell/0_0');
    await settle();
    expect(h.store.transactions).toBe(evictions + 1);
    // In id order: cell/0_0's blob again (its save failed), then the active cell/3_3.
    expect(h.store.pendingPuts()).toEqual(['cell/0_0']);
    h.store.resolvePut('cell/0_0');
    await settle();
    expect(h.store.pendingPuts()).toEqual(['cell/3_3']);
    const flushedBlob = decodeBlob(h.store.resolvePut('cell/3_3')) as RegionBlob;
    await flushing;
    expect(flushed).toBe(true);

    expect(h.regions.state('cell/3_3')).toBe('active');
    expect(flushedBlob.savedTick).toBe(h.world.tick);
    expect(flushedBlob.entities).toHaveLength(2);
    expect(flushedBlob.gameData).toEqual({ region: 'cell/3_3', tick: h.world.tick });
    for (const e of h.regions.entitiesIn('cell/3_3')) expect(h.world.alive(e)).toBe(true);
    expect(decodeBlob(h.store.data.get('region/cell/0_0') ?? null)?.entities).toHaveLength(2);
  });
});

/** A MemoryStore that counts region saves. */
class CountingStore extends MemoryStore {
  puts = 0;

  override put(ns: string, key: string, blob: Uint8Array): Promise<void> {
    if (ns === 'region') this.puts++;
    return super.put(ns, key, blob);
  }
}

describe('RegionManager.flushAll racing evictions', () => {
  it('an eviction during flushAll saves after the flush commits, and the flush writes only what it snapshotted', async () => {
    const h = machine();
    const crateNumbers = (id: RegionId): number[] =>
      h.regions
        .entitiesIn(id)
        .map((e) => h.world.get(e, Crate).n)
        .sort((a, b) => a - b);
    await activate(h, 'cell/1_1'); // ticks 1-2
    const traveller = place(h.world, 'cell/1_1', at(5, 5));
    h.world.add(traveller, Crate, { n: 7 });
    await h.tick([], ['cell/1_1']); // tick 3
    expect(h.regions.migrate(traveller, 'cell/2_2', at(1, 1))).toBe('inboxed');
    for (let t = 4; t < 4 + LINGER_TICKS; t++) await h.tick([], []); // cell/1_1 expires at tick 34

    const flushing = h.regions.flushAll();
    await settle();
    expect(h.store.pendingPuts()).toEqual(['cell/1_1']); // the flush's snapshot of the active region
    await h.tick([], ['cell/2_2']); // tick 34: cell/1_1 evicts; cell/2_2 starts loading
    expect(h.regions.state('cell/1_1')).toBe('saving');
    expect(h.store.pendingPuts()).toEqual(['cell/1_1']); // the eviction queues behind the flush
    h.store.resolveGet('cell/2_2', null);
    await settle();
    await h.tick([], ['cell/2_2']); // tick 35: cell/2_2 activates with its crates and the arrival
    expect(crateNumbers('cell/2_2')).toEqual([0, 1, 7]);
    for (let i = 0; i <= LINGER_TICKS; i++) await h.tick([], []); // and evicts at tick 66
    expect(h.regions.state('cell/2_2')).toBe('saving');

    const flushedHome = decodeBlob(h.store.resolvePut('cell/1_1')) as RegionBlob;
    expect(flushedHome.entities).toHaveLength(2);
    await settle();
    expect(h.store.pendingGets()).toEqual(['cell/2_2']); // the base of its arrivals, as snapshotted
    h.store.resolveGet('cell/2_2');
    await settle();
    const flushedArrivals = decodeBlob(h.store.resolvePut('cell/2_2')) as RegionBlob;
    expect(flushedArrivals.inboxOnly).toBe(true);
    expect(flushedArrivals.entities).toHaveLength(1); // the arrival once, not the eviction's blob too
    await flushing;
    await settle();

    // The evictions, queued behind the flush, write their newer blobs last.
    const evictedHome = decodeBlob(h.store.resolvePut('cell/1_1')) as RegionBlob;
    expect(evictedHome.savedTick).toBe(33);
    await settle();
    const evictedArrivals = decodeBlob(h.store.resolvePut('cell/2_2')) as RegionBlob;
    await settle();
    expect(evictedArrivals.entities).toHaveLength(3);
    expect(decodeBlob(h.store.data.get('region/cell/2_2') ?? null)).toEqual(evictedArrivals);
    expect(h.regions.state('cell/1_1')).toBe('saving');
    expect(h.regions.state('cell/2_2')).toBe('saving');
    await h.tick([], ['cell/2_2']);
    await h.tick([], ['cell/2_2']);
    expect(crateNumbers('cell/2_2')).toEqual([0, 1, 7]);
  });
});

describe('determinism', () => {
  const SMALL = 32;

  /**
   * A sandbox-like session on a 5 x 5 grid of 32 m cells with a 1 s linger: two players steered from
   * the world stream, three drifting crates per region from the region stream, system and hook
   * creates and destroys, migrations (some of entities destroyed the same tick), a pending spawn
   * region, and regions that save, evict, reload and receive inbox arrivals.
   */
  async function session(
    ticks: number,
    onTick?: (h: Rig) => void,
  ): Promise<{ hashes: number[]; h: Rig }> {
    const steer = defineSystem('steer', 'input', (ctx) => {
      if (ctx.tick % 20 !== 1) return;
      for (const e of ctx.world.query(Owner, Transform)) {
        const t = ctx.world.write(e, Transform);
        t.vel.x = ctx.rng.int(-8, 8) / 16;
        t.vel.z = ctx.rng.int(-8, 8) / 16;
      }
    });
    const churn = defineSystem('churn', 'preSim', (ctx) => {
      const { world, regions, rng } = ctx;
      const active = regions.active();
      const id = rng.pick(active);
      if (id === undefined) return;
      if (ctx.tick % 7 === 0) {
        const r = ctx.regionRng(id);
        const vel = at(r.int(-4, 4) / 16, r.int(-4, 4) / 16);
        world.add(place(world, id, at(r.float() * SMALL, r.float() * SMALL), vel), Crate, {
          n: ctx.tick,
        });
      }
      if (ctx.tick % 11 === 0) {
        const crate = regions.entitiesIn(id).find((e) => world.has(e, Crate));
        if (crate !== undefined) world.destroy(crate);
      }
      if (ctx.tick % 5 === 0) {
        const crate = rng.pick(world.queryInto([], Crate));
        const to = rng.pick(active);
        if (crate !== undefined && to !== undefined) {
          regions.migrate(crate, to, at(rng.float() * SMALL, rng.float() * SMALL));
        }
      }
      if (ctx.tick % 13 === 0) world.destroy(place(world, id, at(1, 1))); // lives for no tick
    });
    const h = rig({
      graph: new GridWorld({ cellSize: SMALL, cols: 5, rows: 5, worldSeed: 2024 }),
      store: new CountingStore(),
      lingerMs: 1000,
      systems: [steer, churn],
      content(region, ctx, blob) {
        if (blob !== null) return;
        const r = ctx.regionRng(region.id);
        for (let n = 0; n < 3; n++) {
          const pos = at(r.float() * SMALL, r.float() * SMALL);
          const vel = at(r.int(-4, 4) / 16, r.int(-4, 4) / 16);
          ctx.world.add(place(ctx.world, region.id, pos, vel), Crate, { n });
        }
      },
    });
    const players = [
      place(h.world, 'cell/1_1', at(16, 16)),
      place(h.world, 'cell/3_3', at(16, 16)),
    ];
    players.forEach((e, player) => h.world.add(e, Owner, { player }));
    const hooked: EntityId[] = [];
    const hashes: number[] = [];
    for (let t = 1; t <= ticks; t++) {
      // Session lifecycle between steps: a hook spawns next to player 0 and later removes it.
      const r = h.regions.regionOf(players[0] as EntityId);
      if (t % 9 === 0 && r !== undefined) hooked.push(place(h.world, r, at(8, 8)));
      if (t % 17 === 0 && hooked.length > 0) {
        const e = hooked.shift() as EntityId;
        if (h.world.alive(e)) h.world.destroy(e); // an evicted region took it along
      }
      await h.tick(players, t % 240 >= 30 && t % 240 < 90 ? ['cell/4_0'] : []);
      onTick?.(h);
      hashes.push(h.world.hash());
    }
    return { hashes, h };
  }

  it('entitiesIn matches a brute-force scan of Region.id after every tick of churn, evictions and reloads', async () => {
    let inboxed = 0;
    const { h } = await session(480, (rig) => {
      expectRecordsMatchWorld(rig);
      for (const id of rig.regions.active()) {
        for (const e of rig.regions.entitiesIn(id)) expect(rig.world.alive(e)).toBe(true);
      }
      for (const id of rig.graph.wanted('cell/2_2', 2)) inboxed += rig.regions.inboxSize(id);
    });
    expect(h.changes.length).toBeGreaterThan(20);
    expect(new Set(h.changes.map((c) => c.from)).size).toBeGreaterThan(3);
    expect((h.store as CountingStore).puts).toBeGreaterThan(5); // evictions
    expect(h.populated.filter((p) => p.blob !== null).length).toBeGreaterThan(0); // reloads
    expect(inboxed).toBeGreaterThan(0); // arrivals waiting in inactive regions
  });

  it('world.hash() is identical across two identical runs', async () => {
    const a = await session(480);
    const b = await session(480);
    expect(new Set(a.hashes).size).toBeGreaterThan(400); // the world changes nearly every tick
    expect(b.hashes).toEqual(a.hashes);
    expect(b.h.changes).toEqual(a.h.changes);
    expect(b.h.regions.active()).toEqual(a.h.regions.active());
    for (const id of a.h.regions.active()) {
      expect(b.h.regions.entitiesIn(id)).toEqual(a.h.regions.entitiesIn(id));
    }
  });
});
