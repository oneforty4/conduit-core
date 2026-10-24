import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  ByteReader,
  ByteWriter,
  decodeSnapshot,
  defineInput,
  encodeSnapshot,
  f,
  REGION_IDX_NONE,
  SchemaRegistry,
  SNAPSHOT_FLAG_FULL,
  type SnapshotComponent,
  type SnapshotData,
} from '@conduit/protocol';
import {
  CORE_COMPONENTS,
  defineComponent,
  type EntityId,
  Name,
  Region,
  Transform,
} from '@conduit/sim';
import { describe, expect, it } from 'vitest';
import type { LogLevel } from '../src/index.ts';
import { ReplicaAt, ReplicaWorld } from '../src/index.ts';
import { Tag, TEST_COMPONENTS, testRegistry } from './helpers.ts';

const registry = testRegistry();
const timing = { tickRate: 60, snapshotEvery: 3 };
const T_ID = registry.componentId(Transform);
const NAME_ID = registry.componentId(Name);
const REGION_ID = registry.componentId(Region);
const TAG_ID = registry.componentId(Tag);

function transform(x: number, vx = 0): SnapshotComponent {
  return {
    id: T_ID,
    value: { pos: { x, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, vel: { x: vx, y: 0, z: 0 } },
  };
}

function snap(
  tick: number,
  body: Partial<Omit<SnapshotData, 'header'>>,
  opts: { full?: boolean; baseline?: number } = {},
): SnapshotData {
  return {
    header: {
      serverTick: tick,
      serverTimeMs: tick * 50,
      baselineTick: opts.full === true ? 0 : (opts.baseline ?? Math.max(0, tick - 3)),
      lastInputSeq: 0,
      lastInputTick: 0,
      flags: opts.full === true ? SNAPSHOT_FLAG_FULL : 0,
    },
    regions: body.regions ?? [],
    creates: body.creates ?? [],
    updates: body.updates ?? [],
    destroys: body.destroys ?? [],
  };
}

function replica(): { world: ReplicaWorld; logs: [LogLevel, string][] } {
  const logs: [LogLevel, string][] = [];
  const world = new ReplicaWorld(registry, TEST_COMPONENTS, {
    ...timing,
    log: (level, msg) => logs.push([level, msg]),
  });
  return { world, logs };
}

function ids(it: Iterable<{ id: EntityId }>): EntityId[] {
  return [...it].map((e) => e.id);
}

describe('ReplicaWorld.applySnapshot', () => {
  it('applies creates, updates, removed components and destroys', () => {
    const { world } = replica();
    world.applySnapshot(
      snap(3, {
        regions: ['cell/0_0'],
        creates: [
          {
            entity: 5,
            regionIdx: 0,
            components: [
              { id: NAME_ID, value: { value: 'a' } },
              transform(1),
              { id: TAG_ID, value: { label: 't', n: 1 } },
            ],
          },
          {
            entity: 6,
            regionIdx: REGION_IDX_NONE,
            components: [{ id: TAG_ID, value: { label: 'u', n: 2 } }],
          },
        ],
      }),
    );
    expect(world.read(5, Name)).toEqual({ value: 'a' });
    expect(world.read(5, Tag)).toEqual({ label: 't', n: 1 });
    expect(world.get(5)).toMatchObject({
      regionId: 'cell/0_0',
      createdTick: 3,
      destroyedTick: null,
    });
    expect(world.get(6)?.regionId).toBeNull();
    expect(world.latestTick).toBe(3);

    world.applySnapshot(
      snap(6, {
        updates: [{ entity: 5, components: [transform(2)], removed: [NAME_ID] }],
        destroys: [6],
      }),
    );
    expect(world.read(5, Name)).toBeUndefined();
    expect(world.sample(5, Name, 6, Name.create())).toBeUndefined();
    expect(world.read(5, Transform)?.pos.x).toBe(2);
    expect(world.read(5, Tag)).toEqual({ label: 't', n: 1 });
    expect(world.get(6)?.destroyedTick).toBe(6);
    expect(world.has(6)).toBe(true);
    expect(world.read(6, Tag)).toEqual({ label: 'u', n: 2 });
    expect(world.get(5)?.samples.get(T_ID)?.length).toBe(2);
    expect(world.get(5)?.samples.get(TAG_ID)?.length).toBe(1); // every component's, interpolated or not
    expect(world.latestTick).toBe(6);
    expect(world.size).toBe(2);
  });

  it('FULL resets everything before re-creating', () => {
    const { world } = replica();
    world.applySnapshot(
      snap(3, { creates: [{ entity: 5, regionIdx: REGION_IDX_NONE, components: [transform(1)] }] }),
    );
    world.applySnapshot(
      snap(
        9,
        { creates: [{ entity: 7, regionIdx: REGION_IDX_NONE, components: [transform(3)] }] },
        { full: true },
      ),
    );
    expect(world.has(5)).toBe(false);
    expect(ids(world.entities())).toEqual([7]);
    expect(world.get(7)?.createdTick).toBe(9);
    world.reset();
    expect(world.size).toBe(0);
    expect(world.latestTick).toBe(0);
  });

  it('tolerates a duplicate create by treating it as an update of every component', () => {
    const { world, logs } = replica();
    world.applySnapshot(
      snap(3, { creates: [{ entity: 5, regionIdx: REGION_IDX_NONE, components: [transform(1)] }] }),
    );
    const first = world.get(5);
    world.applySnapshot(
      snap(6, {
        regions: ['cell/2_2'],
        creates: [
          {
            entity: 5,
            regionIdx: 0,
            components: [transform(4), { id: NAME_ID, value: { value: 'n' } }],
          },
        ],
      }),
    );
    expect(logs).toContainEqual(['warn', 'duplicate create']);
    expect(world.size).toBe(1);
    expect(world.get(5)).toBe(first);
    expect(world.get(5)).toMatchObject({ createdTick: 3, regionId: 'cell/2_2' });
    expect(world.read(5, Transform)?.pos.x).toBe(4);
    expect(world.read(5, Name)).toEqual({ value: 'n' });
    expect(world.get(5)?.samples.get(T_ID)?.length).toBe(2);
  });

  it('skips an update for an unknown entity with a warning', () => {
    const { world, logs } = replica();
    world.applySnapshot(
      snap(3, { updates: [{ entity: 9, components: [transform(1)], removed: [] }] }),
    );
    expect(world.has(9)).toBe(false);
    expect(logs).toContainEqual(['warn', 'update for unknown entity']);
  });

  it('revives an entity that left interest and came back while still held, drawn throughout', () => {
    // Regression: re-created, it was not visible until its new create tick -- the render tick
    // trails the snapshots -- so it vanished for a moment and its view was made anew.
    const { world } = replica();
    world.applySnapshot(
      snap(3, {
        creates: [
          {
            entity: 5,
            regionIdx: REGION_IDX_NONE,
            components: [transform(1), { id: TAG_ID, value: { label: 'a', n: 1 } }],
          },
          { entity: 8, regionIdx: REGION_IDX_NONE, components: [transform(8)] },
        ],
      }),
    );
    world.applySnapshot(snap(6, { destroys: [5] }));
    const old = world.get(5);
    world.applySnapshot(
      snap(9, { creates: [{ entity: 5, regionIdx: REGION_IDX_NONE, components: [transform(2)] }] }),
    );
    const again = world.get(5);
    expect(again).toBe(old);
    expect(again).toMatchObject({ createdTick: 3, destroyedTick: null });
    expect(ids(world.visibleAt(7))).toEqual([5, 8]);
    // Its samples go on from before: it moves from where it was to where it is.
    expect(again?.samples.get(T_ID)?.length).toBeGreaterThan(1);
    expect(world.sample(5, Transform, 9, Transform.create())?.pos.x).toBe(2);
    // What it lost while away (the create has all it has) is gone.
    expect(world.read(5, Tag)).toBeUndefined();
    // Once collected, it comes back as a new entity at the end.
    world.applySnapshot(snap(12, { destroys: [5] }));
    world.gc(13);
    world.applySnapshot(
      snap(15, {
        creates: [{ entity: 5, regionIdx: REGION_IDX_NONE, components: [transform(3)] }],
      }),
    );
    expect(world.get(5)).toMatchObject({ createdTick: 15 });
    expect(ids(world.entities())).toEqual([8, 5]);
  });

  it('tracks migrations through the Region component', () => {
    const { world } = replica();
    world.applySnapshot(
      snap(3, {
        regions: ['cell/0_0'],
        creates: [
          { entity: 5, regionIdx: 0, components: [{ id: REGION_ID, value: { id: 'cell/0_0' } }] },
        ],
      }),
    );
    expect(world.get(5)?.regionId).toBe('cell/0_0');
    world.applySnapshot(
      snap(6, {
        updates: [
          { entity: 5, components: [{ id: REGION_ID, value: { id: 'cell/1_0' } }], removed: [] },
        ],
      }),
    );
    expect(world.get(5)?.regionId).toBe('cell/1_0');
    expect(world.read(5, Region)).toEqual({ id: 'cell/1_0' });
  });
});

describe('ReplicaWorld lifetimes', () => {
  function lifetime(): ReplicaWorld {
    const { world } = replica();
    world.applySnapshot(
      snap(9, { creates: [{ entity: 1, regionIdx: REGION_IDX_NONE, components: [transform(0)] }] }),
    );
    world.applySnapshot(
      snap(10, {
        creates: [{ entity: 2, regionIdx: REGION_IDX_NONE, components: [transform(0)] }],
      }),
    );
    world.applySnapshot(snap(20, { destroys: [2] }));
    return world;
  }

  it('visibleAt: createdTick <= renderTick < destroyedTick, insertion order', () => {
    const world = lifetime();
    expect(ids(world.visibleAt(8.99))).toEqual([]);
    expect(ids(world.visibleAt(9))).toEqual([1]);
    expect(ids(world.visibleAt(9.99))).toEqual([1]);
    expect(ids(world.visibleAt(10))).toEqual([1, 2]);
    expect(ids(world.visibleAt(19.99))).toEqual([1, 2]);
    expect(ids(world.visibleAt(20))).toEqual([1]);
    expect(ids(world.visibleAt(1000))).toEqual([1]);
  });

  it('gc removes only entities destroyed before the given tick', () => {
    const world = lifetime();
    expect(world.gc(20)).toBe(0);
    expect(world.has(2)).toBe(true);
    expect(world.gc(21)).toBe(1);
    expect(world.has(2)).toBe(false);
    expect(world.gc(1_000_000)).toBe(0);
    expect(world.has(1)).toBe(true);
  });
});

describe('ReplicaWorld.sample and read', () => {
  it('interpolates between snapshots and extrapolates past the newest', () => {
    const { world } = replica();
    world.applySnapshot(
      snap(3, {
        creates: [{ entity: 5, regionIdx: REGION_IDX_NONE, components: [transform(0, 60)] }],
      }),
    );
    world.applySnapshot(
      snap(6, { updates: [{ entity: 5, components: [transform(3, 60)], removed: [] }] }),
    );
    const out = Transform.create();
    expect(world.sample(5, Transform, 4.5, out)).toBe(out);
    expect(out.pos.x).toBe(1.5);
    expect(world.sample(5, Transform, 7, Transform.create())?.pos.x).toBeCloseTo(4, 12);
    expect(world.sample(5, Transform, 100, Transform.create())?.pos.x).toBeCloseTo(6, 12);
    expect(world.sample(99, Transform, 4, Transform.create())).toBeUndefined();
    expect(world.read(99, Transform)).toBeUndefined();
  });

  it('holds a resting component at the baseline tick so it does not start moving early', () => {
    const { world } = replica();
    world.applySnapshot(
      snap(3, { creates: [{ entity: 5, regionIdx: REGION_IDX_NONE, components: [transform(0)] }] }),
    );
    for (let t = 6; t <= 27; t += 3) world.applySnapshot(snap(t, {}));
    world.applySnapshot(
      snap(
        30,
        { updates: [{ entity: 5, components: [transform(10)], removed: [] }] },
        { baseline: 27 },
      ),
    );
    const ring = world.get(5)?.samples.get(T_ID);
    expect(ring?.length).toBe(3);
    expect(ring?.at(1).tick).toBe(27);
    expect(world.sample(5, Transform, 20, Transform.create())?.pos.x).toBe(0);
    expect(world.sample(5, Transform, 27, Transform.create())?.pos.x).toBe(0);
    expect(world.sample(5, Transform, 28.5, Transform.create())?.pos.x).toBe(5);
  });

  it('reads a component as it was at a tick: not there before it came, there until it went', () => {
    const { world } = replica();
    world.applySnapshot(
      snap(3, { creates: [{ entity: 5, regionIdx: REGION_IDX_NONE, components: [transform(0)] }] }),
    );
    world.applySnapshot(
      snap(6, {
        updates: [{ entity: 5, components: [{ id: NAME_ID, value: { value: 'a' } }], removed: [] }],
      }),
    );
    world.applySnapshot(
      snap(9, {
        updates: [{ entity: 5, components: [{ id: NAME_ID, value: { value: 'b' } }], removed: [] }],
      }),
    );
    world.applySnapshot(snap(12, { updates: [{ entity: 5, components: [], removed: [NAME_ID] }] }));
    expect(world.read(5, Name)).toBeUndefined(); // the newest: gone at once
    expect(world.readAt(5, Name, 5.5)).toBeUndefined(); // not come yet
    expect(world.readAt(5, Name, 6)).toEqual({ value: 'a' });
    expect(world.readAt(5, Name, 8.9)).toEqual({ value: 'a' });
    expect(world.readAt(5, Name, 9)).toEqual({ value: 'b' });
    expect(world.readAt(5, Name, 11.9)).toEqual({ value: 'b' }); // still there
    expect(world.readAt(5, Name, 12)).toBeUndefined();
    expect(world.sample(5, Name, 10, Name.create())).toEqual({ value: 'b' });
    expect(world.sample(5, Name, 13, Name.create())).toBeUndefined();
    // Back again: from its tick.
    world.applySnapshot(
      snap(15, {
        updates: [{ entity: 5, components: [{ id: NAME_ID, value: { value: 'c' } }], removed: [] }],
      }),
    );
    expect(world.readAt(5, Name, 14)).toBeUndefined();
    expect(world.readAt(5, Name, 15)).toEqual({ value: 'c' });
    expect(world.readAt(99, Name, 15)).toBeUndefined();
  });

  it('samples an interpolated component up to the tick it went, and not after', () => {
    const { world } = replica();
    world.applySnapshot(
      snap(3, { creates: [{ entity: 5, regionIdx: REGION_IDX_NONE, components: [transform(0)] }] }),
    );
    world.applySnapshot(
      snap(6, { updates: [{ entity: 5, components: [transform(3)], removed: [] }] }),
    );
    world.applySnapshot(snap(9, { updates: [{ entity: 5, components: [], removed: [T_ID] }] }));
    expect(world.sample(5, Transform, 4.5, Transform.create())?.pos.x).toBe(1.5);
    expect(world.sample(5, Transform, 8, Transform.create())?.pos.x).toBe(3); // holds: no velocity
    expect(world.sample(5, Transform, 9, Transform.create())).toBeUndefined();
  });

  it('stands the oldest sample in before a ring that let older ones go', () => {
    const { world } = replica();
    world.applySnapshot(
      snap(3, { creates: [{ entity: 5, regionIdx: REGION_IDX_NONE, components: [transform(0)] }] }),
    );
    for (let t = 6; t <= 60; t += 3) {
      world.applySnapshot(
        snap(t, { updates: [{ entity: 5, components: [transform(t)], removed: [] }] }),
      );
    }
    // Eight samples held, 39 to 60: before them, the oldest is the nearest known.
    const ring = world.get(5)?.samples.get(T_ID);
    expect(ring?.complete).toBe(false);
    expect(ring?.at(0).tick).toBe(39);
    expect(world.readAt(5, Transform, 4)?.pos.x).toBe(39);
  });

  it('ReplicaAt reads every component as of its tick, and the entities alive then', () => {
    const { world } = replica();
    world.applySnapshot(
      snap(3, {
        creates: [
          { entity: 5, regionIdx: REGION_IDX_NONE, components: [transform(0)] },
          { entity: 6, regionIdx: REGION_IDX_NONE, components: [transform(1)] },
        ],
      }),
    );
    world.applySnapshot(
      snap(6, {
        updates: [{ entity: 5, components: [{ id: NAME_ID, value: { value: 'a' } }], removed: [] }],
        destroys: [6],
      }),
    );
    const at = new ReplicaAt(world, 4);
    expect(at.world).toBe(world);
    expect(at.read(5, Name)).toBeUndefined();
    expect(ids(at.entities())).toEqual([5, 6]);
    expect(at.has(6)).toBe(true);
    at.tick = 6;
    expect(at.read(5, Name)).toEqual({ value: 'a' });
    expect(ids(at.entities())).toEqual([5]);
    expect(at.get(6)).toBeUndefined();
    expect(at.get(5)?.id).toBe(5);
    expect(at.sample(5, Transform, 6, Transform.create())?.pos.x).toBe(0);
  });

  it('throws for a component the registry lacks', () => {
    const { world } = replica();
    const Stranger = defineComponent('Stranger', { v: f.u8 });
    expect(() => world.read(1, Stranger)).not.toThrow(); // no entity: nothing to look up
    world.applySnapshot(
      snap(3, { creates: [{ entity: 1, regionIdx: REGION_IDX_NONE, components: [transform(0)] }] }),
    );
    expect(() => world.read(1, Stranger)).toThrow(RangeError);
  });

  it('requires interpolation metadata to match the registry, with other types falling back to it', () => {
    const LerpTag = defineComponent('Tag', { label: f.str(16), n: f.u16 }, { interpolate: ['n'] });
    expect(() => new ReplicaWorld(registry, [LerpTag], timing)).toThrow('conflicting component');
    const matching = new SchemaRegistry({
      components: TEST_COMPONENTS.map((c) => (c.name === 'Tag' ? LerpTag : c)),
      events: [],
      messages: [],
      input: registry.input,
    });
    const world = new ReplicaWorld(matching, [LerpTag], timing);
    world.applySnapshot(
      snap(3, {
        creates: [
          {
            entity: 1,
            regionIdx: REGION_IDX_NONE,
            components: [{ id: TAG_ID, value: { label: 'x', n: 0 } }, transform(0)],
          },
        ],
      }),
    );
    world.applySnapshot(
      snap(6, {
        updates: [
          {
            entity: 1,
            components: [{ id: TAG_ID, value: { label: 'y', n: 30 } }, transform(3)],
            removed: [],
          },
        ],
      }),
    );
    expect(world.sample(1, LerpTag, 5, LerpTag.create())).toEqual({ label: 'x', n: 20 });
    expect(world.sample(1, Transform, 5, Transform.create())?.pos.x).toBe(2);
    expect(
      () => new ReplicaWorld(registry, [defineComponent('Nope', { v: f.u8 })], timing),
    ).toThrow(RangeError);
  });

  it('configure validates and updates the rates', () => {
    const { world } = replica();
    expect(() => world.configure(0, 3)).toThrow(RangeError);
    expect(() => world.configure(60, 0)).toThrow(RangeError);
    world.configure(30, 2);
    expect(world.tickRate).toBe(30);
    expect(world.snapshotEvery).toBe(2);
  });
});

/** Recorded builds of net-server's snapshot timelines (packages/net-server/test/fixtures). */
interface TimelineRecording {
  description: string;
  components: string[];
  steps: { tick: number; interest: string[]; delta: SnapshotData; full: SnapshotData }[];
}

const FIXTURES = new URL('../../net-server/test/fixtures/', import.meta.url);

function recordings(): [string, TimelineRecording][] {
  if (!existsSync(FIXTURES)) return [];
  return readdirSync(FIXTURES)
    .filter(
      (file) =>
        file.endsWith('.json') &&
        existsSync(new URL(file.replace(/\.json$/, '.expected.snap'), FIXTURES)),
    )
    .sort()
    .map((file) => {
      const text = readFileSync(
        new URL(file.replace(/\.json$/, '.expected.snap'), FIXTURES),
        'utf8',
      );
      return [file, JSON.parse(text) as TimelineRecording];
    });
}

/** Through the real codec, so values are quantized and freshly allocated as on the wire. */
function overTheWire(data: SnapshotData, reg: SchemaRegistry): SnapshotData {
  const w = new ByteWriter();
  encodeSnapshot(w, reg, data);
  return decodeSnapshot(new ByteReader(w.finish()), reg);
}

function aliveView(world: ReplicaWorld): unknown[] {
  return [...world.entities()]
    .filter((e) => e.destroyedTick === null)
    .sort((a, b) => a.id - b.id)
    .map((e) => ({
      id: e.id,
      regionId: e.regionId,
      latest: [...e.latest.entries()].sort((a, b) => a[0] - b[0]),
    }));
}

describe('ReplicaWorld delta-equals-full (shared net-server snapshot timelines)', () => {
  const found = recordings();

  it('finds the shared timeline fixtures', () => {
    expect(found.length).toBeGreaterThan(0);
  });

  it.each(found)(
    '%s: every delta applied in order equals a single FULL build',
    (_file, recording) => {
      const reg = new SchemaRegistry({
        components: CORE_COMPONENTS,
        messages: [],
        events: [],
        input: defineInput({ tick: f.u32 }),
      });
      expect(reg.components.map((c) => c.name)).toEqual(recording.components);
      const incremental = new ReplicaWorld(reg, CORE_COMPONENTS, timing);
      let deltas = 0;
      for (const step of recording.steps) {
        const delta = overTheWire(step.delta, reg);
        if ((delta.header.flags & SNAPSHOT_FLAG_FULL) === 0) deltas++;
        incremental.applySnapshot(delta);
        const fresh = new ReplicaWorld(reg, CORE_COMPONENTS, timing);
        fresh.applySnapshot(overTheWire(step.full, reg));
        expect(fresh.size).toBe(step.full.creates.length);
        expect(aliveView(incremental), `tick ${step.tick}`).toEqual(aliveView(fresh));
      }
      expect(deltas).toBeGreaterThan(0);
    },
  );
});

it('exposes immutable live entity/map/history views and preserves later authoritative updates', () => {
  const { world } = replica();
  world.applySnapshot(
    snap(3, { creates: [{ entity: 5, regionIdx: REGION_IDX_NONE, components: [transform(1)] }] }),
  );
  const entity = world.get(5)!;
  expect(Object.isFrozen(entity)).toBe(true);
  expect('set' in entity.latest).toBe(false);
  expect('clear' in entity.samples).toBe(false);
  const component = world.read(5, Transform)!;
  expect(Reflect.set(component.pos, 'x', 999)).toBe(false);
  const history = entity.samples.get(registry.componentId(Transform))!;
  expect('push' in history).toBe(false);
  expect(Reflect.set(history.at(0), 'tick', 999)).toBe(false);
  world.applySnapshot(
    snap(6, { updates: [{ entity: 5, components: [transform(2)], removed: [] }] }),
  );
  expect(world.get(5)).toBe(entity);
  expect(world.read(5, Transform)?.pos.x).toBe(2);
  expect(component.pos.x).toBe(1);
});
