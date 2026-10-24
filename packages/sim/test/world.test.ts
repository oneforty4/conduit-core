import { Rng } from '@conduit/math';
import { defineSchema, f, SchemaRegistry } from '@conduit/protocol';
import { describe, expect, it } from 'vitest';
import {
  CORE_COMPONENTS,
  defineComponent,
  type EntityId,
  genOf,
  MAX_SLOTS,
  slotOf,
  StaleEntity,
  Transform,
  UnknownComponent,
  World,
} from '../src/index.ts';
import { registryOf, TestInput } from './helpers.ts';

const Health = defineComponent('Health', { hp: f.u16 });
const Label = defineComponent('Label', { text: f.str(16) });
const Stray = defineComponent('Stray', { n: f.u8 });

function setup(capacity?: number): World {
  const registry = registryOf([...CORE_COMPONENTS, Health, Label]);
  return capacity === undefined ? new World(registry) : new World(registry, { capacity });
}

describe('World entity lifecycle', () => {
  it('destroy is deferred: the entity stays alive with its components until applyDestroys', () => {
    const world = setup();
    const e = world.create();
    world.add(e, Health, { hp: 5 });
    world.destroy(e);
    expect(world.alive(e)).toBe(true);
    expect(world.has(e, Health)).toBe(true);
    expect(world.get(e, Health).hp).toBe(5);
    expect([...world.query(Health)]).toEqual([e]);
    world.write(e, Health).hp = 6;
    world.applyDestroys();
    expect(world.alive(e)).toBe(false);
    expect(world.has(e, Health)).toBe(false);
    expect(world.tryGet(e, Health)).toBeUndefined();
    expect(world.store(Health).size).toBe(0);
    expect([...world.query(Health)]).toEqual([]);
  });

  it('a stale id throws StaleEntity on add/get/write/remove/destroy', () => {
    const world = setup();
    const e = world.create();
    world.add(e, Health);
    world.destroy(e);
    world.applyDestroys();
    expect(world.alive(e)).toBe(false);
    expect(() => world.add(e, Label)).toThrow(StaleEntity);
    expect(() => world.get(e, Health)).toThrow(StaleEntity);
    expect(() => world.write(e, Health)).toThrow(StaleEntity);
    expect(() => world.remove(e, Health)).toThrow(StaleEntity);
    expect(() => world.destroy(e)).toThrow(StaleEntity);
    // The slot is reused, but the old id stays stale.
    const reused = world.create();
    expect(slotOf(reused)).toBe(slotOf(e));
    expect(world.alive(e)).toBe(false);
    expect(() => world.get(e, Health)).toThrow(StaleEntity);
    expect(() => world.destroy(e)).toThrow(StaleEntity);
  });

  it('applyDestroys removes every component, stamping removedAt with the tick', () => {
    const world = setup();
    const e = world.create();
    world.add(e, Health);
    world.add(e, Transform);
    world.tick = 8;
    world.stepping = true; // applyDestroys runs inside Simulation.step
    world.destroy(e);
    world.applyDestroys();
    expect(world.store(Health).removedAt[slotOf(e)]).toBe(8);
    expect(world.store(Transform).removedAt[slotOf(e)]).toBe(8);
    expect(world.store(Label).removedAt[slotOf(e)]).toBe(0);
    const reused = world.create();
    expect(world.has(reused, Health)).toBe(false);
    expect(world.has(reused, Transform)).toBe(false);
  });

  it('slot reuse bumps the generation and the free list is LIFO', () => {
    const world = setup();
    const a = world.create();
    const b = world.create();
    const c = world.create();
    expect([a, b, c].map(slotOf)).toEqual([1, 2, 3]);
    expect([a, b, c].map(genOf)).toEqual([0, 0, 0]);
    world.destroy(a);
    world.destroy(c);
    world.applyDestroys();
    const c2 = world.create();
    const a2 = world.create();
    const d = world.create();
    expect(slotOf(c2)).toBe(slotOf(c));
    expect(slotOf(a2)).toBe(slotOf(a));
    expect(slotOf(d)).toBe(4);
    expect(genOf(c2)).toBe(1);
    expect(genOf(a2)).toBe(1);
    expect(c2).not.toBe(c);
    expect(world.alive(c)).toBe(false);
    expect(world.alive(c2)).toBe(true);
  });

  it('double destroy is idempotent', () => {
    const world = setup();
    const e = world.create();
    const other = world.create();
    world.destroy(e);
    world.destroy(e);
    expect(world.destroyedThisTick()).toEqual([e]);
    world.applyDestroys();
    expect(world.count()).toBe(1);
    const reused = world.create();
    expect(slotOf(reused)).toBe(slotOf(e));
    expect(genOf(reused)).toBe(1);
    expect(world.create()).toBe(3);
    expect(world.alive(other)).toBe(true);
  });

  it('destroyedThisTick lists destroys in call order and empties at applyDestroys', () => {
    const world = setup();
    const ids = [world.create(), world.create(), world.create(), world.create()];
    world.destroy(ids[2]!);
    world.destroy(ids[0]!);
    world.destroy(ids[3]!);
    world.destroy(ids[0]!);
    expect(world.destroyedThisTick()).toEqual([ids[2], ids[0], ids[3]]);
    world.applyDestroys();
    expect(world.destroyedThisTick()).toEqual([]);
    // LIFO: the last destroyed slot comes back first.
    expect(slotOf(world.create())).toBe(slotOf(ids[3]!));
    expect(slotOf(world.create())).toBe(slotOf(ids[0]!));
    expect(slotOf(world.create())).toBe(slotOf(ids[2]!));
  });

  it('count() tracks allocated entities', () => {
    const world = setup();
    expect(world.count()).toBe(0);
    const ids = [world.create(), world.create(), world.create()];
    expect(world.count()).toBe(3);
    world.destroy(ids[1]!);
    expect(world.count()).toBe(3);
    world.applyDestroys();
    expect(world.count()).toBe(2);
    world.create();
    expect(world.count()).toBe(3);
  });

  it('capacity growth keeps every store consistent', () => {
    const world = setup(2);
    const rng = new Rng(99);
    const expected = new Map<EntityId, { hp?: number; text?: string; x?: number }>();
    const alive: EntityId[] = [];
    for (let i = 0; i < 3000; i++) {
      world.tick = i + 1;
      const e = world.create();
      alive.push(e);
      const rec: { hp?: number; text?: string; x?: number } = {};
      if (rng.chance(0.6)) world.add(e, Health, { hp: (rec.hp = rng.int(0, 65535)) });
      if (rng.chance(0.3)) world.add(e, Label, { text: (rec.text = `e${i}`) });
      if (rng.chance(0.5)) {
        world.add(e, Transform).pos.x = rec.x = rng.int(-1000, 1000);
      }
      expected.set(e, rec);
      if (i % 7 === 3) {
        const victim = alive.splice(rng.int(0, alive.length - 1), 1)[0]!;
        world.destroy(victim);
        world.applyDestroys();
        expected.delete(victim);
      }
    }
    expect(world.count()).toBe(alive.length);
    for (const [e, rec] of expected) {
      expect(world.alive(e)).toBe(true);
      expect(world.tryGet(e, Health)?.hp).toBe(rec.hp);
      expect(world.tryGet(e, Label)?.text).toBe(rec.text);
      expect(world.tryGet(e, Transform)?.pos.x).toBe(rec.x);
      if (rec.hp !== undefined) {
        expect(world.store(Health).version[slotOf(e)]).toBeGreaterThan(0);
      }
    }
    for (const store of world.stores()) {
      expect(store.version.length).toBeGreaterThanOrEqual(3000);
      expect(store.removedAt.length).toBe(store.version.length);
    }
    const withHealth = [...expected].filter(([, r]) => r.hp !== undefined).map(([e]) => e);
    expect([...world.query(Health)]).toEqual(withHealth.sort((a, b) => slotOf(a) - slotOf(b)));
  });
});

describe('World stores', () => {
  it('creates one store per registry component without assigning definition IDs', () => {
    const Zeta = defineComponent('Zeta', { n: f.u8 });
    const Alpha = defineComponent('Alpha', { n: f.u8 });
    expect('id' in Zeta).toBe(false);
    const world = new World(registryOf([Zeta, Alpha]));
    expect(world.stores().map((s) => s.type.name)).toEqual(['Alpha', 'Zeta']);
    expect(world.registry.componentId(Alpha)).toBe(0);
    expect(world.registry.componentId(Zeta)).toBe(1);
    expect(world.store(Zeta)).toBe(world.stores()[1]);
  });

  it('resolves shared types independently in differently ordered registries', () => {
    const Beta = defineComponent('Beta', { n: f.u8 });
    const Aardvark = defineComponent('Aardvark', { n: f.u8 });
    const Gamma = defineComponent('Gamma', { n: f.u8 });
    const first = new World(registryOf([Beta, Gamma]));
    expect([Beta, Gamma].map((c) => first.registry.componentId(c))).toEqual([0, 1]);
    // Each registry owns its own IDs for these same immutable definitions.
    const second = new World(registryOf([Beta, Gamma, Aardvark]));
    expect([Aardvark, Beta, Gamma].map((c) => second.registry.componentId(c))).toEqual([0, 1, 2]);
    const e = second.create();
    second.add(e, Beta, { n: 3 });
    second.add(e, Gamma, { n: 4 });
    expect(second.store(Beta)).toBe(second.stores()[1]);
    expect(second.store(Gamma)).toBe(second.stores()[2]);
    expect(second.get(e, Beta).n).toBe(3);
    expect(second.get(e, Gamma).n).toBe(4);
    expect(second.has(e, Aardvark)).toBe(false);
    expect([...second.query(Gamma, Beta)]).toEqual([e]);
    expect(first.store(Beta).size).toBe(0);
  });

  it('store() throws UnknownComponent for a component outside the registry', () => {
    const world = setup();
    const e = world.create();
    expect(() => world.store(Stray)).toThrow(UnknownComponent);
    expect(() => world.add(e, Stray)).toThrow(UnknownComponent);
    expect(() => world.has(e, Stray)).toThrow(UnknownComponent);
    expect(() => world.query(Health, Stray)).toThrow(UnknownComponent);
  });

  it('rejects a bad capacity and registry components that are not ComponentTypes', () => {
    expect(() => setup(0)).toThrow(RangeError);
    expect(() => setup(1.5)).toThrow(RangeError);
    expect(() => setup(MAX_SLOTS + 1)).toThrow(RangeError);
    const plain = {
      name: 'Plain',
      schema: defineSchema({ n: f.u8 }),
      replicate: true,
      interpolate: [],
    };
    const registry = new SchemaRegistry({
      components: [plain],
      messages: [],
      events: [],
      input: TestInput,
    });
    expect(() => new World(registry)).toThrow(TypeError);
  });
});
