import { MemoryStore } from '@conduit/persist';
import {
  Model,
  Name,
  Owner,
  Region,
  Transform,
  type EntityId,
  type SimContext,
} from '@conduit/sim';
import { describe, expect, it } from 'vitest';
import {
  GridWorld,
  decodeBlob,
  toWorld,
  type MigrateResult,
  type RegionBlob,
  type RegionDef,
} from '../src/index.ts';
import {
  CELL,
  ControlledStore,
  Crate,
  Tag,
  at,
  defOf,
  expectRecordsMatchWorld,
  place,
  rig,
  settle,
  type Rig,
} from './rig.ts';

// docs/world.md §10 `test/inbox.test.ts`.

/** One crate (n = 1) at the centre of every fresh region. */
function oneCrate(region: RegionDef, ctx: SimContext, blob: RegionBlob | null): void {
  if (blob !== null) return;
  ctx.world.add(place(ctx.world, region.id, at(50, 50)), Crate, { n: 1 });
}

/** Crate numbers in region `id`, ascending. */
function cratesIn(h: Rig, id: string): number[] {
  return h.regions
    .entitiesIn(id)
    .filter((e) => h.world.has(e, Crate))
    .map((e) => h.world.get(e, Crate).n)
    .sort((a, b) => a - b);
}

function crateNumbered(h: Rig, id: string, n: number): EntityId {
  const e = h.regions.entitiesIn(id).find((c) => h.world.tryGet(c, Crate)?.n === n);
  if (e === undefined) throw new Error(`no crate ${n} in ${id}`);
  return e;
}

const HOME = ['cell/0_0']; // keeps cell/0_0, cell/0_1, cell/1_0 and cell/1_1 active

describe('inbox', () => {
  it('an entity walking into an inactive unwanted region is inboxed and removed; activating that region re-creates it, rebased', async () => {
    const h = rig({ content: oneCrate });
    await h.tick([], HOME);
    await h.tick([], HOME);
    expect(h.regions.active()).toEqual(['cell/0_0', 'cell/0_1', 'cell/1_0', 'cell/1_1']);
    const walker = place(h.world, 'cell/1_1', at(99.75, 40.5, 3), at(0.5, 0.25));
    h.world.add(walker, Crate, { n: 42 });
    h.world.add(walker, Name, { value: 'walker' });
    h.world.add(walker, Model, { asset: 'crate', variant: 2 });
    h.world.add(walker, Tag, { label: 'not persisted' });
    const crossing = toWorld(defOf(h.graph, 'cell/1_1'), at(100.25, 40.75, 3));

    await h.tick([], HOME); // moves to x 100.25: cell/2_1, inactive and unwanted
    expect(h.world.alive(walker)).toBe(false);
    expect(h.regions.state('cell/2_1')).toBe('inactive');
    expect(h.regions.inboxSize('cell/2_1')).toBe(1);
    expect(h.regions.entitiesIn('cell/1_1')).not.toContain(walker);
    expect(h.changes).toEqual([]);
    expectRecordsMatchWorld(h);
    for (let i = 0; i < 5; i++) await h.tick([], HOME);
    expect(h.regions.inboxSize('cell/2_1')).toBe(1);

    await h.tick([], [...HOME, 'cell/2_1']); // cell/2_1 and its neighbourhood load
    h.regions.update([], h.sim.ctx, [...HOME, 'cell/2_1']); // activation, before a step moves anything
    expect(h.regions.state('cell/2_1')).toBe('active');
    expect(h.regions.inboxSize('cell/2_1')).toBe(0);
    expect(h.populated.find((p) => p.region === 'cell/2_1')?.blob).toBeNull(); // fresh, then arrivals
    expect(cratesIn(h, 'cell/2_1')).toEqual([1, 42]);
    const arrival = crateNumbered(h, 'cell/2_1', 42);
    expect(h.world.get(arrival, Region).id).toBe('cell/2_1');
    const t = h.world.get(arrival, Transform);
    expect(t.pos).toEqual(at(0.25, 40.75, 3));
    expect(toWorld(defOf(h.graph, 'cell/2_1'), t.pos)).toEqual(crossing); // world position continuous
    expect(t.vel).toEqual(at(0.5, 0.25));
    expect(h.world.get(arrival, Name).value).toBe('walker');
    expect(h.world.get(arrival, Model)).toEqual({ asset: 'crate', variant: 2 });
    expect(h.world.has(arrival, Tag)).toBe(false);
    h.sim.step(h.world.tick + 1);
    await settle();
    expect(h.world.get(arrival, Transform).pos).toEqual(at(0.75, 41, 3));
    expectRecordsMatchWorld(h);
  });

  it('an entity without persisted components is destroyed, not inboxed', async () => {
    const h = rig();
    await h.tick([], HOME);
    await h.tick([], HOME);
    const ghost = h.world.create();
    h.world.add(ghost, Region, { id: 'cell/1_1' });
    h.world.add(ghost, Tag, { label: 'ghost' });
    h.world.add(ghost, Owner, { player: 2 });
    await h.tick([], HOME);
    expect(h.regions.entitiesIn('cell/1_1')).toEqual([ghost]);

    expect(h.regions.migrate(ghost, 'cell/3_3')).toBe('inboxed');
    expect(h.regions.inboxSize('cell/3_3')).toBe(0);
    expect(h.regions.entitiesIn('cell/1_1')).toEqual([]);
    await h.tick([], HOME);
    expect(h.world.alive(ghost)).toBe(false);
    await h.tick([], [...HOME, 'cell/3_3']);
    await h.tick([], [...HOME, 'cell/3_3']);
    expect(h.regions.state('cell/3_3')).toBe('active');
    expect(h.regions.entitiesIn('cell/3_3')).toEqual([]);
    expect(h.world.count()).toBe(0);
  });

  it('flushAll writes inbox items into the stored blobs, and a fresh manager loads them', async () => {
    const store = new MemoryStore();
    const h = rig({ store, lingerMs: 100, content: oneCrate }); // lingers 6 ticks
    // cell/3_3 is saved once first: wanted, active, then evicted.
    await h.tick([], [...HOME, 'cell/3_3']);
    await h.tick([], [...HOME, 'cell/3_3']);
    for (let i = 0; i < 10; i++) await h.tick([], HOME);
    expect(h.regions.state('cell/3_3')).toBe('inactive');
    expect(await store.get('region', 'cell/3_3')).not.toBeNull();
    expect(await store.get('region', 'cell/2_1')).toBeNull();

    // Arrivals: one walks into never-saved cell/2_1, one is migrated into saved cell/3_3.
    const walker = place(h.world, 'cell/1_1', at(99.75, 40.5), at(0.5, 0));
    h.world.add(walker, Crate, { n: 42 });
    const jumper = place(h.world, 'cell/1_1', at(10, 10));
    h.world.add(jumper, Crate, { n: 43 });
    await h.tick([], HOME);
    expect(h.regions.migrate(jumper, 'cell/3_3', at(5, 6))).toBe('inboxed');
    expect(h.regions.inboxSize('cell/2_1')).toBe(1);
    expect(h.regions.inboxSize('cell/3_3')).toBe(1);
    await h.tick([], HOME);

    await h.regions.flushAll();
    expect(h.regions.inboxSize('cell/2_1')).toBe(0);
    expect(h.regions.inboxSize('cell/3_3')).toBe(0);
    const arrivalsOnly = decodeBlob(await store.get('region', 'cell/2_1')) as RegionBlob;
    expect(arrivalsOnly).toMatchObject({
      inboxOnly: true,
      savedTick: h.world.tick,
      rngState: defOf(h.graph, 'cell/2_1').seed,
    });
    expect(arrivalsOnly.entities).toHaveLength(1);
    const merged = decodeBlob(await store.get('region', 'cell/3_3')) as RegionBlob;
    expect(merged.inboxOnly).toBeUndefined();
    expect(merged.entities.map((s) => s.components[0])).toEqual([
      ['Crate', { n: 1 }],
      ['Crate', { n: 43 }],
    ]);
    // Active regions are written too, and stay active.
    const home = decodeBlob(await store.get('region', 'cell/1_1')) as RegionBlob;
    expect(home.entities.map((s) => s.components[0])).toEqual([['Crate', { n: 1 }]]);
    expect(h.regions.state('cell/1_1')).toBe('active');

    // A fresh manager on the same store: cell/2_1 is populated as fresh and then gets its arrival;
    // cell/3_3 restores its crate and the arrival.
    const next = rig({ store, content: oneCrate });
    await next.tick([], ['cell/2_1', 'cell/3_3']);
    await next.tick([], ['cell/2_1', 'cell/3_3']);
    expect(next.populated.find((p) => p.region === 'cell/2_1')?.blob).toBeNull();
    expect(cratesIn(next, 'cell/2_1')).toEqual([1, 42]);
    expect(next.world.get(crateNumbered(next, 'cell/2_1', 42), Transform).pos).toEqual(
      at(0.75, 40.5),
    );
    const restored = next.populated.find((p) => p.region === 'cell/3_3');
    expect(restored?.blob?.entities).toHaveLength(2);
    expect(restored?.restored).toHaveLength(2);
    expect(cratesIn(next, 'cell/3_3')).toEqual([1, 43]);
    expect(next.world.get(crateNumbered(next, 'cell/3_3', 43), Transform).pos).toEqual(at(5, 6));

    // The original manager keeps running: its cell/2_1 gets the walker exactly once.
    await h.tick([], [...HOME, 'cell/2_1']);
    await h.tick([], [...HOME, 'cell/2_1']);
    expect(cratesIn(h, 'cell/2_1')).toEqual([1, 42]);
  });

  it('flushAll racing a load or an activation of the same region keeps its arrivals exactly once', async () => {
    const store = new ControlledStore();
    const graph = new GridWorld({
      cellSize: CELL,
      cols: 4,
      rows: 4,
      worldSeed: 77,
      wantedDepth: 0,
    });
    const h = rig({ graph, store, lingerMs: 100, content: oneCrate });
    const home = ['cell/1_1'];
    await h.tick([], home);
    store.resolveGet('cell/1_1', null);
    await settle();
    await h.tick([], home);
    const first = place(h.world, 'cell/1_1', at(5, 5));
    h.world.add(first, Crate, { n: 7 });
    const second = place(h.world, 'cell/1_1', at(6, 6));
    h.world.add(second, Crate, { n: 8 });
    await h.tick([], home);
    expect(h.regions.migrate(first, 'cell/3_3', at(1, 1))).toBe('inboxed');
    expect(h.regions.migrate(second, 'cell/3_0', at(2, 2))).toBe('inboxed');
    await h.tick([], home);

    // A: cell/3_3 activates from a load that read the store before the flush wrote its arrival.
    let flushing = h.regions.flushAll();
    await settle();
    expect(store.pendingPuts()).toEqual(['cell/1_1']); // the active region first
    await h.tick([], [...home, 'cell/3_3']); // cell/3_3 starts loading
    store.resolvePut('cell/1_1');
    await settle();
    // The load's get, then the flush reading the base of its first arrivals (id order: cell/3_0).
    expect(store.pendingGets()).toEqual(['cell/3_3', 'cell/3_0']);
    store.resolveGet('cell/3_3', null); // the flush has written nothing yet
    await settle();
    await h.tick([], [...home, 'cell/3_3']); // activates: its crate, then the arrival from the inbox
    expect(cratesIn(h, 'cell/3_3')).toEqual([1, 7]);
    store.resolveGet('cell/3_0', null);
    await settle();
    store.resolvePut('cell/3_0');
    await settle();
    store.resolveGet('cell/3_3', null); // the flush still writes what cell/3_3 held when it began
    await settle();
    store.resolvePut('cell/3_3');
    await flushing;
    expect(cratesIn(h, 'cell/3_3')).toEqual([1, 7]);
    expect(h.regions.inboxSize('cell/3_3')).toBe(0);
    expect(h.regions.inboxSize('cell/3_0')).toBe(0); // written as an arrivals-only blob

    // Evicted and reloaded from memory: still exactly one traveller.
    for (let i = 0; i < 7; i++) await h.tick([], home);
    expect(h.regions.state('cell/3_3')).toBe('saving');
    store.resolvePut('cell/3_3');
    await settle();
    await h.tick([], [...home, 'cell/3_3']);
    await h.tick([], [...home, 'cell/3_3']);
    expect(cratesIn(h, 'cell/3_3')).toEqual([1, 7]);

    // B: a later arrival for cell/3_0 is appended to its arrivals-only blob kept in memory; a load
    // started while that write is pending activates with both arrivals, once.
    const third = place(h.world, 'cell/1_1', at(7, 7));
    h.world.add(third, Crate, { n: 9 });
    await h.tick([], [...home, 'cell/3_3']);
    expect(h.regions.migrate(third, 'cell/3_0', at(3, 3))).toBe('inboxed');
    flushing = h.regions.flushAll();
    await settle();
    for (const id of ['cell/1_1', 'cell/3_3']) {
      expect(store.pendingPuts()).toEqual([id]);
      store.resolvePut(id);
      await settle();
    }
    expect(store.pendingPuts()).toEqual(['cell/3_0']); // appended to the arrivals-only blob in memory
    await h.tick([], [...home, 'cell/3_3', 'cell/3_0']); // loads from memory: no store.get
    expect(store.pendingGets()).toEqual([]);
    store.resolvePut('cell/3_0');
    await flushing;
    await h.tick([], [...home, 'cell/3_3', 'cell/3_0']);
    expect(h.regions.state('cell/3_0')).toBe('active');
    expect(h.populated.find((p) => p.region === 'cell/3_0')?.blob).toBeNull(); // fresh, plus arrivals
    expect(cratesIn(h, 'cell/3_0')).toEqual([1, 8, 9]);
    expect(decodeBlob(store.data.get('region/cell/3_0') ?? null)?.entities).toHaveLength(2);
  });

  it('a load that read the store before a flush wrote arrivals activates with the flushed arrivals', async () => {
    const store = new ControlledStore();
    const graph = new GridWorld({
      cellSize: CELL,
      cols: 4,
      rows: 4,
      worldSeed: 77,
      wantedDepth: 0,
    });
    const h = rig({ graph, store, content: oneCrate });
    await h.tick([], ['cell/1_1']);
    store.resolveGet('cell/1_1', null);
    await settle();
    await h.tick([], ['cell/1_1']);
    const traveller = place(h.world, 'cell/1_1', at(5, 5));
    h.world.add(traveller, Crate, { n: 7 });
    await h.tick([], ['cell/1_1']);
    expect(h.regions.migrate(traveller, 'cell/2_2', at(1, 1))).toBe('inboxed');
    await h.tick([], ['cell/1_1']);

    const flushing = h.regions.flushAll();
    await settle();
    store.resolvePut('cell/1_1');
    await settle();
    store.resolveGet('cell/2_2', null); // the flush's base
    await settle();
    expect(store.pendingPuts()).toEqual(['cell/2_2']);
    await h.tick([], ['cell/1_1', 'cell/2_2']); // starts loading while the write is pending
    expect(store.pendingGets()).toEqual(['cell/2_2']);
    store.resolvePut('cell/2_2');
    await flushing;
    expect(h.regions.inboxSize('cell/2_2')).toBe(0); // the arrival now lives in the flushed blob
    store.resolveGet('cell/2_2', null); // the load read the store before the write landed
    await settle();
    await h.tick([], ['cell/1_1', 'cell/2_2']);
    expect(h.regions.state('cell/2_2')).toBe('active');
    expect(cratesIn(h, 'cell/2_2')).toEqual([1, 7]);
  });

  it('arrivals are merged even when populate throws', async () => {
    let failing = true;
    const h = rig({
      content(region) {
        if (failing && region.id === 'cell/3_0') throw new Error('populate failed');
      },
    });
    await h.tick([], HOME);
    await h.tick([], HOME);
    const first = place(h.world, 'cell/1_0', at(1, 1));
    h.world.add(first, Crate, { n: 1 });
    const second = place(h.world, 'cell/1_0', at(2, 2));
    h.world.add(second, Crate, { n: 2 });
    await h.tick([], HOME);
    expect(h.regions.migrate(first, 'cell/3_0', at(10, 10))).toBe('inboxed');
    expect(h.regions.migrate(second, 'cell/3_0', at(20, 20))).toBe('inboxed');
    expect(h.regions.inboxSize('cell/3_0')).toBe(2);
    await h.tick([], [...HOME, 'cell/3_0']);
    await expect(h.tick([], [...HOME, 'cell/3_0'])).rejects.toThrow('populate failed');
    failing = false;
    expect(h.regions.state('cell/3_0')).toBe('active');
    expect(h.regions.inboxSize('cell/3_0')).toBe(0);
    expect(cratesIn(h, 'cell/3_0')).toEqual([1, 2]);
    await h.tick([], [...HOME, 'cell/3_0']);
    expectRecordsMatchWorld(h);
  });

  it('migrate returns each MigrateResult value under the matching setup', async () => {
    const h = rig({ lingerMs: 100, content: oneCrate });
    const seen = new Set<MigrateResult>();
    const expectResult = (result: MigrateResult, expected: MigrateResult): void => {
      expect(result).toBe(expected);
      seen.add(result);
    };
    const player = place(h.world, 'cell/0_0', at(50, 50));
    h.world.add(player, Owner, { player: 0 });
    const crate = place(h.world, 'cell/0_0', at(10, 10));
    h.world.add(crate, Crate, { n: 5 });
    const loose = h.world.create(); // no Region
    await h.tick([player]);
    await h.tick([player]);

    expectResult(h.regions.migrate(loose, 'cell/1_1'), 'notMember');
    expectResult(h.regions.migrate(crate, 'cell/0_0'), 'same');
    expectResult(h.regions.migrate(crate, 'cell/7_7'), 'unknownRegion');
    expectResult(h.regions.migrate(crate, 'cell/1_1'), 'outOfBounds'); // rebased to (-90, 0, -90)
    expectResult(h.regions.migrate(crate, 'cell/1_1', at(100, 0)), 'outOfBounds');
    expect(h.regions.regionOf(crate)).toBe('cell/0_0');
    expectResult(h.regions.migrate(crate, 'cell/1_1', at(1, 2)), 'moved');
    expect(h.regions.regionOf(crate)).toBe('cell/1_1');

    await h.tick([player], ['cell/3_3']);
    expect(h.regions.state('cell/3_3')).toBe('loading');
    expectResult(h.regions.migrate(crate, 'cell/3_3', at(1, 1)), 'deferred');
    await h.tick([player], ['cell/3_3']);
    expect(h.regions.state('cell/3_3')).toBe('active');
    for (let i = 0; i < 6; i++) await h.tick([player]); // cell/3_3 lingers until the next update
    h.regions.update([player], h.sim.ctx);
    expect(h.regions.state('cell/3_3')).toBe('saving');
    expectResult(h.regions.migrate(crate, 'cell/3_3', at(1, 1)), 'deferred');
    h.sim.step(h.world.tick + 1);
    await settle();
    await h.tick([player]); // save completion applies at the update boundary
    expect(h.regions.state('cell/3_3')).toBe('inactive');

    expect(() => h.regions.migrate(player, 'cell/3_0', at(1, 1))).toThrow(/player invariant/);
    expect(h.regions.regionOf(player)).toBe('cell/0_0');
    expectResult(h.regions.migrate(crate, 'cell/3_0', at(1, 1)), 'inboxed');
    expect(h.regions.inboxSize('cell/3_0')).toBe(1);

    const all: MigrateResult[] = [
      'moved',
      'inboxed',
      'deferred',
      'same',
      'unknownRegion',
      'notMember',
      'outOfBounds',
    ];
    expect([...seen].sort()).toEqual([...all].sort());
  });
});
