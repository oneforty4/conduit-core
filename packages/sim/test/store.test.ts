import { Rng } from '@conduit/math';
import { f } from '@conduit/protocol';
import { describe, expect, it } from 'vitest';
import {
  AlreadyPresent,
  defineComponent,
  type EntityId,
  genOf,
  MissingComponent,
  slotOf,
  StaleEntity,
  World,
} from '../src/index.ts';
import { registryOf } from './helpers.ts';

const Body = defineComponent('Body', { pos: f.vec3(f.f32), vel: f.vec2(f.f32), hp: f.u16 });
const Bag = defineComponent('Bag', {
  items: f.array(f.u16, 8),
  label: f.optional(f.str(8)),
  inner: f.struct({ a: f.u8, v: f.vec2(f.f32) }),
});
const Tag = defineComponent('Tag', { n: f.u32 });

function setup(): World {
  return new World(registryOf([Body, Bag, Tag]));
}

function isAscendingBySlot(ids: ArrayLike<EntityId>): boolean {
  for (let i = 1; i < ids.length; i++) {
    if (slotOf(ids[i - 1] as EntityId) >= slotOf(ids[i] as EntityId)) return false;
  }
  return true;
}

describe('ComponentStore stamps', () => {
  // Inside Simulation.step (world.stepping) writes stamp world.tick; see the last case for between steps.
  it('add stamps version with the tick and leaves removedAt untouched; read does not stamp', () => {
    const world = setup();
    world.stepping = true;
    const store = world.store(Body);
    const e = world.create();
    const s = slotOf(e);
    world.tick = 5;
    const obj = store.add(e, { hp: 7 });
    expect(store.version[s]).toBe(5);
    expect(store.removedAt[s]).toBe(0);
    expect(store.size).toBe(1);
    expect(store.has(e)).toBe(true);
    world.tick = 6;
    expect(store.read(e)).toBe(obj);
    expect(store.tryRead(e)).toBe(obj);
    expect(store.read(e).hp).toBe(7);
    expect(store.version[s]).toBe(5);
  });

  it('write and set stamp version; both mutate the live object', () => {
    const world = setup();
    world.stepping = true;
    const store = world.store(Body);
    const e = world.create();
    const s = slotOf(e);
    world.tick = 1;
    const obj = store.add(e);
    world.tick = 7;
    const w = store.write(e);
    expect(w).toBe(obj);
    w.hp = 3;
    expect(store.version[s]).toBe(7);
    world.tick = 9;
    store.set(e, { pos: { x: 1, y: 2, z: 3 }, vel: { x: 4, y: 5 }, hp: 6 });
    expect(store.version[s]).toBe(9);
    expect(store.read(e)).toBe(obj);
    expect(obj).toEqual({ pos: { x: 1, y: 2, z: 3 }, vel: { x: 4, y: 5 }, hp: 6 });
  });

  it('remove clears version and stamps removedAt; a re-add stamps a fresh version', () => {
    const world = setup();
    world.stepping = true;
    const store = world.store(Body);
    const e = world.create();
    const s = slotOf(e);
    world.tick = 3;
    store.add(e);
    world.tick = 11;
    expect(store.remove(e)).toBe(true);
    expect(store.version[s]).toBe(0);
    expect(store.removedAt[s]).toBe(11);
    expect(store.has(e)).toBe(false);
    expect(store.size).toBe(0);
    expect(store.remove(e)).toBe(false);
    expect(store.removedAt[s]).toBe(11);
    world.tick = 12;
    store.add(e);
    expect(store.version[s]).toBe(12);
    expect(store.removedAt[s]).toBe(11);
  });

  it('clear removes every entity and stamps each', () => {
    const world = setup();
    world.stepping = true;
    const store = world.store(Tag);
    const ids = [world.create(), world.create(), world.create()];
    world.tick = 2;
    for (const e of ids) store.add(e, { n: e });
    world.tick = 4;
    store.clear();
    expect(store.size).toBe(0);
    expect(store.entitiesArray().length).toBe(0);
    for (const e of ids) {
      expect(store.has(e)).toBe(false);
      expect(store.removedAt[slotOf(e)]).toBe(4);
      expect(store.version[slotOf(e)]).toBe(0);
    }
    store.add(ids[1]!, { n: 9 });
    expect([...store.entities()]).toEqual([ids[1]]);
  });

  it('between steps, writes are stamped with the coming tick', () => {
    const world = setup();
    const store = world.store(Tag);
    const e = world.create();
    const s = slotOf(e);
    expect(world.stepping).toBe(false);
    store.add(e); // before the first step: belongs to tick 1
    expect(store.version[s]).toBe(1);
    world.tick = 6; // after step 6, before step 7 (Session lifecycle, hooks, regions.update)
    store.write(e);
    expect(store.version[s]).toBe(7);
    store.set(e, { n: 1 });
    expect(store.version[s]).toBe(7);
    store.remove(e);
    expect(store.removedAt[s]).toBe(7);
    // A snapshot built after step 6 has baselineTick 6, so both changes stay visible to the next one.
    expect(store.removedAt[s]).toBeGreaterThan(6);
  });
});

describe('ComponentStore values', () => {
  it('add copies the given fields by value and ignores unknown keys', () => {
    const world = setup();
    const e = world.create();
    const pos = { x: 1, y: 2, z: 3 };
    const body = world.add(e, Body, { pos });
    expect(body.pos).toEqual(pos);
    expect(body.pos).not.toBe(pos);
    expect(body.vel).toEqual({ x: 0, y: 0 });
    expect(body.hp).toBe(0);
    pos.x = 99;
    expect(world.get(e, Body).pos.x).toBe(1);

    const items = [1, 2, 3];
    const inner = { a: 4, v: { x: 5, y: 6 } };
    const extra = { items, inner, label: 'hi', bogus: 1 };
    const bag = world.add(e, Bag, extra);
    expect(bag).toEqual({ items: [1, 2, 3], label: 'hi', inner: { a: 4, v: { x: 5, y: 6 } } });
    expect(Object.hasOwn(bag, 'bogus')).toBe(false);
    expect(bag.items).not.toBe(items);
    expect(bag.inner).not.toBe(inner);
    expect(bag.inner.v).not.toBe(inner.v);
    items.push(4);
    inner.v.x = -1;
    expect(world.get(e, Bag).items).toEqual([1, 2, 3]);
    expect(world.get(e, Bag).inner.v.x).toBe(5);
  });

  it('add with an explicit undefined optional clears it; defaults come from the schema', () => {
    const world = setup();
    const e = world.create();
    const bag = world.add(e, Bag, { label: undefined });
    expect(bag).toEqual({ items: [], label: undefined, inner: { a: 0, v: { x: 0, y: 0 } } });
  });

  it('set deep-copies nested vec, struct and array fields into the live object', () => {
    const world = setup();
    const store = world.store(Bag);
    const e = world.create();
    const live = store.add(e, { items: [9, 9, 9, 9] });
    const liveInnerV = live.inner.v;
    const src = { items: [1, 2], label: 'x', inner: { a: 1, v: { x: 2, y: 3 } } };
    store.set(e, src);
    expect(store.read(e)).toBe(live);
    expect(live).toEqual(src);
    expect(live.inner.v).toBe(liveInnerV);
    expect(live.items).not.toBe(src.items);
    src.inner.v.y = 42;
    src.items[0] = 42;
    expect(live.inner.v.y).toBe(3);
    expect(live.items).toEqual([1, 2]);
    store.set(e, { items: [], label: undefined, inner: { a: 0, v: { x: 0, y: 0 } } });
    expect(live.items).toEqual([]);
    expect(live.label).toBeUndefined();
  });

  it('add on a present component throws AlreadyPresent; absent reads and writes throw MissingComponent', () => {
    const world = setup();
    const store = world.store(Tag);
    const e = world.create();
    store.add(e, { n: 1 });
    expect(() => store.add(e)).toThrow(AlreadyPresent);
    const other = world.create();
    expect(() => store.read(other)).toThrow(MissingComponent);
    expect(() => store.write(other)).toThrow(MissingComponent);
    expect(() => store.set(other, { n: 2 })).toThrow(MissingComponent);
    expect(store.tryRead(other)).toBeUndefined();
    expect(store.remove(other)).toBe(false);
    expect(store.has(other)).toBe(false);
  });

  it('every op except has/tryRead throws StaleEntity for a dead id', () => {
    const world = setup();
    const store = world.store(Tag);
    const e = world.create();
    store.add(e, { n: 1 });
    world.destroy(e);
    world.applyDestroys();
    expect(store.has(e)).toBe(false);
    expect(store.tryRead(e)).toBeUndefined();
    expect(() => store.read(e)).toThrow(StaleEntity);
    expect(() => store.write(e)).toThrow(StaleEntity);
    expect(() => store.set(e, { n: 1 })).toThrow(StaleEntity);
    expect(() => store.add(e)).toThrow(StaleEntity);
    expect(() => store.remove(e)).toThrow(StaleEntity);
  });
});

describe('ComponentStore sparse set', () => {
  it('swap-remove keeps sparse consistent under 10 000 random ops against a reference Map', () => {
    const world = new World(registryOf([Body, Bag, Tag]), { capacity: 8 });
    world.stepping = true;
    const store = world.store(Tag);
    const rng = new Rng(0xc0ffee);
    const ref = new Map<EntityId, number>();
    const alive: EntityId[] = [];
    const dead: EntityId[] = [];
    let generationsBumped = false;

    const verify = (): void => {
      expect(store.size).toBe(ref.size);
      for (const e of alive) {
        expect(store.has(e)).toBe(ref.has(e));
        expect(store.tryRead(e)?.n).toBe(ref.get(e));
      }
      for (const e of dead.slice(-20)) expect(store.has(e)).toBe(false);
      const order = store.entitiesArray();
      expect(isAscendingBySlot(order)).toBe(true);
      const expected = [...ref.keys()].sort((a, b) => slotOf(a) - slotOf(b));
      expect([...order]).toEqual(expected);
      for (const e of order) {
        expect(store.version[slotOf(e)]).toBeGreaterThan(0);
        expect(store.read(e).n).toBe(ref.get(e));
      }
    };

    for (let op = 0; op < 10_000; op++) {
      world.tick = op + 1;
      const r = rng.int(0, 99);
      if (r < 12 || alive.length === 0) {
        if (alive.length < 200) alive.push(world.create());
      } else if (r < 20) {
        const i = rng.int(0, alive.length - 1);
        const e = alive[i]!;
        alive[i] = alive[alive.length - 1]!;
        alive.pop();
        const had = ref.delete(e);
        world.destroy(e);
        world.applyDestroys();
        dead.push(e);
        expect(store.has(e)).toBe(false);
        if (had) expect(store.removedAt[slotOf(e)]).toBe(world.tick);
      } else if (r < 50) {
        const e = alive[rng.int(0, alive.length - 1)]!;
        if (ref.has(e)) {
          expect(() => store.add(e)).toThrow(AlreadyPresent);
        } else {
          const n = rng.next();
          store.add(e, { n });
          ref.set(e, n);
          if (genOf(e) > 0) generationsBumped = true;
        }
      } else if (r < 70) {
        const e = alive[rng.int(0, alive.length - 1)]!;
        expect(store.remove(e)).toBe(ref.delete(e));
      } else if (r < 90) {
        const e = alive[rng.int(0, alive.length - 1)]!;
        const n = rng.next();
        if (ref.has(e)) {
          store.write(e).n = n;
          ref.set(e, n);
          expect(store.version[slotOf(e)]).toBe(world.tick);
        } else {
          expect(() => store.write(e)).toThrow(MissingComponent);
        }
      } else {
        const e = alive[rng.int(0, alive.length - 1)]!;
        expect(store.has(e)).toBe(ref.has(e));
        expect(store.tryRead(e)?.n).toBe(ref.get(e));
      }
      if (op % 250 === 249) verify();
    }
    verify();
    expect(generationsBumped).toBe(true);
    expect(dead.length).toBeGreaterThan(100);
  });

  it('entities() is ascending slot order, not id order, when generations differ', () => {
    const world = setup();
    const store = world.store(Tag);
    const first = world.create(); // slot 1
    const second = world.create(); // slot 2
    world.destroy(first);
    world.applyDestroys();
    const reused = world.create(); // slot 1, generation 1: a larger id than `second`
    expect(slotOf(reused)).toBe(1);
    expect(reused).toBeGreaterThan(second);
    store.add(second, { n: 2 });
    store.add(reused, { n: 1 });
    expect([...store.entities()]).toEqual([reused, second]);
  });

  it('entities() is ascending after random churn', () => {
    const world = setup();
    const store = world.store(Tag);
    const rng = new Rng(7);
    const ids: EntityId[] = [];
    for (let i = 0; i < 300; i++) ids.push(world.create());
    for (let round = 0; round < 20; round++) {
      for (let i = 0; i < 40; i++) {
        const e = ids[rng.int(0, ids.length - 1)]!;
        if (store.has(e)) store.remove(e);
        else store.add(e, { n: i });
      }
      for (let i = 0; i < 5; i++) {
        const k = rng.int(0, ids.length - 1);
        world.destroy(ids[k]!);
        world.applyDestroys();
        ids[k] = world.create();
      }
      const order = store.entitiesArray();
      expect(order.length).toBe(store.size);
      expect(isAscendingBySlot(order)).toBe(true);
      expect([...store.entities()]).toEqual([...order]);
    }
  });

  it('adds during iteration are not visited; the in-flight array is not disturbed', () => {
    const world = setup();
    const store = world.store(Tag);
    const initial = [world.create(), world.create(), world.create()];
    for (const e of initial) store.add(e, { n: 0 });
    const fresh = [world.create(), world.create()];
    const visited: EntityId[] = [];
    const before = store.entitiesArray();
    for (const e of store.entities()) {
      visited.push(e);
      const next = fresh.pop();
      if (next !== undefined) store.add(next, { n: 1 });
    }
    expect(visited).toEqual(initial);
    expect([...before]).toEqual(initial);
    expect(store.size).toBe(5);
    expect(store.entitiesArray()).not.toBe(before);
    expect(store.entitiesArray().length).toBe(5);
  });
});
