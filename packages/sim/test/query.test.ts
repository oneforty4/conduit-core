import { Rng } from '@conduit/math';
import { f } from '@conduit/protocol';
import { describe, expect, it } from 'vitest';
import { type ComponentType, defineComponent, type EntityId, slotOf, World } from '../src/index.ts';
import { registryOf } from './helpers.ts';

const A = defineComponent('A', { n: f.u16 });
const B = defineComponent('B', { n: f.u16 });
const C = defineComponent('C', { n: f.u16 });

function setup(): World {
  return new World(registryOf([A, B, C]));
}

function shuffle<T>(rng: Rng, items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

const bySlot = (a: EntityId, b: EntityId): number => slotOf(a) - slotOf(b);

describe('World.query', () => {
  it('yields ascending slot order regardless of insertion order', () => {
    const world = setup();
    const rng = new Rng(3);
    const ids: EntityId[] = [];
    for (let i = 0; i < 60; i++) ids.push(world.create());
    // Churn some slots so generations (and therefore id order) differ from slot order.
    for (let i = 0; i < 10; i++) {
      const k = rng.int(0, ids.length - 1);
      world.destroy(ids[k]!);
      world.applyDestroys();
      ids[k] = world.create();
    }
    for (const e of shuffle(rng, [...ids])) world.add(e, A);
    for (const e of shuffle(rng, [...ids]).slice(0, 30)) world.add(e, B);
    const all = [...world.query(A)];
    expect(all).toEqual([...ids].sort(bySlot));
    const both = [...world.query(A, B)];
    expect(both).toEqual([...both].sort(bySlot));
    expect([...world.query(B, A)]).toEqual(both);
    expect(world.queryInto([], A, B)).toEqual(both);
  });

  it('smallest-store selection yields the same set as brute force', () => {
    const world = setup();
    const rng = new Rng(11);
    const ids: EntityId[] = [];
    for (let i = 0; i < 400; i++) ids.push(world.create());
    const sets: ComponentType<{ n: number }>[] = [A, B, C];
    const p = [0.7, 0.2, 0.45];
    for (let round = 0; round < 5; round++) {
      for (const e of ids) {
        sets.forEach((c, k) => {
          const want = rng.chance(p[(k + round) % 3]!);
          if (want && !world.has(e, c)) world.add(e, c);
          if (!want && world.has(e, c)) world.remove(e, c);
        });
      }
      const combos: ComponentType<unknown>[][] = [
        [A],
        [B],
        [C],
        [A, B],
        [B, C],
        [C, A],
        [A, B, C],
        [C, B, A],
        [A, A],
      ];
      const out: EntityId[] = [99];
      for (const combo of combos) {
        const brute = world
          .queryInto([])
          .filter((e) => combo.every((c) => world.has(e, c)))
          .sort(bySlot);
        expect([...world.query(...combo)]).toEqual(brute);
        expect(world.queryInto(out, ...combo)).toBe(out);
        expect(out).toEqual(brute);
      }
    }
  });

  it('entities removed mid-iteration are not yielded', () => {
    const world = setup();
    const ids: EntityId[] = [];
    for (let i = 0; i < 10; i++) {
      const e = world.create();
      ids.push(e);
      world.add(e, A);
      world.add(e, B);
    }
    // A has 10 entries and B has 10: A (lower id) is the primary. Remove from both kinds of store.
    const seen: EntityId[] = [];
    for (const e of world.query(A, B)) {
      seen.push(e);
      if (e === ids[0]) {
        world.remove(ids[3]!, A);
        world.remove(ids[5]!, B);
      }
    }
    expect(seen).toEqual(ids.filter((_, i) => i !== 3 && i !== 5));
  });

  it('components added mid-iteration are not visited', () => {
    const world = setup();
    const ids = [world.create(), world.create(), world.create(), world.create()];
    world.add(ids[1]!, A);
    world.add(ids[2]!, A);
    const seen: EntityId[] = [];
    for (const e of world.query(A)) {
      seen.push(e);
      if (!world.has(ids[0]!, A)) world.add(ids[0]!, A);
      if (!world.has(ids[3]!, A)) world.add(ids[3]!, A);
    }
    expect(seen).toEqual([ids[1], ids[2]]);
    expect([...world.query(A)]).toEqual(ids);
  });

  it('an empty query yields every alive entity in slot order', () => {
    const world = setup();
    const ids: EntityId[] = [];
    for (let i = 0; i < 8; i++) ids.push(world.create());
    world.add(ids[2]!, A);
    world.destroy(ids[1]!);
    world.destroy(ids[6]!);
    world.applyDestroys();
    const reused = world.create(); // slot of ids[6]
    const pending = ids[4]!;
    world.destroy(pending); // still alive until applyDestroys
    const expected = [ids[0], ids[2], ids[3], ids[4], ids[5], reused, ids[7]];
    expect([...world.query()]).toEqual(expected);
    expect(world.queryInto([1, 2, 3])).toEqual(expected);

    const seen: EntityId[] = [];
    for (const e of world.query()) {
      seen.push(e);
      if (seen.length === 1) world.create(); // reuses the free slot of ids[1]: not visited
    }
    expect(seen).toEqual(expected);
  });
});
