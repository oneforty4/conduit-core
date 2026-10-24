import { FNV_BASIS } from '@conduit/math';
import { f } from '@conduit/protocol';
import { describe, expect, it } from 'vitest';
import {
  CORE_COMPONENTS,
  defineComponent,
  type EntityId,
  hashWorld,
  Name,
  Transform,
  World,
} from '../src/index.ts';
import { registryOf } from './helpers.ts';

const Brain = defineComponent('Brain', { mood: f.u8, memory: f.f32 }, { replicate: false });
const Health = defineComponent('Health', { hp: f.u16 });

function setup(): World {
  return new World(registryOf([...CORE_COMPONENTS, Brain, Health]));
}

describe('World.hash', () => {
  it('mixes every replicated store even when empty and equals hashWorld with a fresh writer', () => {
    const world = setup();
    const empty = world.hash();
    expect(empty).not.toBe(FNV_BASIS);
    expect(setup().hash()).toBe(empty);
    expect(new World(registryOf([Brain])).hash()).toBe(FNV_BASIS);
    world.create();
    // Entities without replicated components do not enter the hash.
    expect(world.hash()).toBe(empty);
    const e = world.create();
    world.add(e, Health, { hp: 3 });
    expect(world.hash()).toBe(hashWorld(world));
    expect(world.hash()).not.toBe(empty);
  });

  it('ignores non-replicated stores', () => {
    const world = setup();
    const e = world.create();
    world.add(e, Health, { hp: 10 });
    const h = world.hash();
    world.add(e, Brain, { mood: 3, memory: 0.5 });
    expect(world.hash()).toBe(h);
    world.write(e, Brain).memory = 99;
    expect(world.hash()).toBe(h);
    const other = world.create();
    world.add(other, Brain);
    expect(world.hash()).toBe(h);
    world.write(e, Health).hp = 11;
    expect(world.hash()).not.toBe(h);
  });

  it('follows quantization: sub-quantum changes do not change the hash, a quantum does', () => {
    const world = setup();
    const e = world.create();
    world.add(e, Transform);
    const h = world.hash();
    world.write(e, Transform).pos.x = 0.0004;
    expect(world.hash()).toBe(h);
    world.write(e, Transform).pos.x = 0.001;
    const h2 = world.hash();
    expect(h2).not.toBe(h);
    world.write(e, Transform).vel.z = 1e-46; // f32: under its smallest step, rounds to 0
    expect(world.hash()).toBe(h2);
    world.write(e, Transform).vel.z = 0.01;
    expect(world.hash()).not.toBe(h2);
  });

  it('is independent of the order components were added in', () => {
    const build = (order: number[]): number => {
      const world = setup();
      const ids: EntityId[] = [];
      for (let i = 0; i < 6; i++) ids.push(world.create());
      for (const i of order) {
        const e = ids[i]!;
        world.add(e, Health, { hp: i * 10 });
        if (i % 2 === 0) world.add(e, Name, { value: `n${i}` });
        world.add(e, Transform, { pos: { x: i, y: -i, z: i / 2 } });
      }
      return world.hash();
    };
    const forward = build([0, 1, 2, 3, 4, 5]);
    expect(build([5, 4, 3, 2, 1, 0])).toBe(forward);
    expect(build([3, 0, 5, 1, 4, 2])).toBe(forward);
    expect(build([0, 1, 2, 3, 4])).not.toBe(forward);
  });

  it('covers entity ids, membership and values', () => {
    const world = setup();
    const a = world.create();
    const b = world.create();
    world.add(a, Health, { hp: 1 });
    const h = world.hash();

    world.remove(a, Health);
    world.add(b, Health, { hp: 1 });
    expect(world.hash()).not.toBe(h); // same value, different entity

    world.remove(b, Health);
    world.add(a, Health, { hp: 1 });
    expect(world.hash()).toBe(h);

    world.add(a, Name, { value: '' });
    expect(world.hash()).not.toBe(h); // presence of a default-valued component counts

    world.remove(a, Name);
    expect(world.hash()).toBe(h);
  });
});
