import { f } from '@conduit/protocol';
import { describe, expect, it } from 'vitest';
import {
  defineComponent,
  ENTITY_NONE,
  GEN_MASK,
  GEN_SHIFT,
  genOf,
  isLocal,
  LOCAL_BIT,
  LOCAL_GEN_BASE,
  LocalIdAllocator,
  makeId,
  MAX_SLOTS,
  SERVER_GEN_WRAP,
  SLOT_BITS,
  SLOT_MASK,
  slotOf,
  StaleEntity,
  World,
} from '../src/index.ts';
import { registryOf } from './helpers.ts';

const Tag = defineComponent('Tag', { n: f.u8 });

describe('entity id layout', () => {
  it('has the documented constants', () => {
    expect(SLOT_BITS).toBe(20);
    expect(SLOT_MASK).toBe(0x000fffff);
    expect(GEN_SHIFT).toBe(20);
    expect(GEN_MASK).toBe(0xfff);
    expect(LOCAL_BIT).toBe(0x80000000);
    expect(MAX_SLOTS).toBe(1 << 20);
    expect(SERVER_GEN_WRAP).toBe(2048);
    expect(LOCAL_GEN_BASE).toBe(2048);
    expect(ENTITY_NONE).toBe(0);
  });

  it('makeId/slotOf/genOf round-trip at the bit boundaries', () => {
    for (const slot of [0, 1, 2, 0x7ffff, 0x80000, 0xffffe, 0xfffff]) {
      for (const gen of [0, 1, 2046, 2047, 2048, 2049, 4094, 4095]) {
        const id = makeId(slot, gen);
        expect(Number.isInteger(id)).toBe(true);
        expect(id).toBeGreaterThanOrEqual(0);
        expect(id).toBeLessThanOrEqual(0xffffffff);
        expect(slotOf(id)).toBe(slot);
        expect(genOf(id)).toBe(gen);
        expect(isLocal(id)).toBe(gen >= LOCAL_GEN_BASE);
      }
    }
    expect(makeId(0xfffff, 2047)).toBe(0x7fffffff);
    expect(makeId(0xfffff, 4095)).toBe(0xffffffff);
    expect(makeId(1, 0)).toBe(1);
    // Excess bits are masked off.
    expect(makeId(0x100001, 0)).toBe(1);
    expect(makeId(1, 0x1001)).toBe(makeId(1, 1));
  });
});

describe('LocalIdAllocator', () => {
  it('hands out local ids from slot 1 with bit 31 set', () => {
    const alloc = new LocalIdAllocator();
    const ids = [alloc.alloc(), alloc.alloc(), alloc.alloc()];
    expect(ids.map(slotOf)).toEqual([1, 2, 3]);
    for (const id of ids) {
      expect(isLocal(id)).toBe(true);
      expect(id >>> 0).toBe(id);
      expect(genOf(id)).toBe(LOCAL_GEN_BASE);
      expect(id).toBeGreaterThanOrEqual(2 ** 31);
    }
    expect(new Set(ids).size).toBe(3);
  });

  it('reuses released slots LIFO with a bumped generation', () => {
    const alloc = new LocalIdAllocator();
    const a = alloc.alloc();
    const b = alloc.alloc();
    alloc.release(a);
    alloc.release(b);
    const b2 = alloc.alloc();
    const a2 = alloc.alloc();
    expect(slotOf(b2)).toBe(slotOf(b));
    expect(slotOf(a2)).toBe(slotOf(a));
    expect(genOf(a2)).toBe(LOCAL_GEN_BASE | 1);
    expect(a2).not.toBe(a);
    expect(isLocal(a2)).toBe(true);
  });

  it('rejects a double release, a stale id and a server id', () => {
    const alloc = new LocalIdAllocator();
    const a = alloc.alloc();
    alloc.release(a);
    expect(() => alloc.release(a)).toThrow(StaleEntity);
    const a2 = alloc.alloc();
    expect(() => alloc.release(a)).toThrow(StaleEntity);
    expect(() => alloc.release(makeId(slotOf(a2), 1))).toThrow(StaleEntity);
    expect(() => alloc.release(makeId(99, LOCAL_GEN_BASE))).toThrow(StaleEntity);
    alloc.release(a2);
  });

  it('local generations wrap at 2048 and keep bit 31', () => {
    const alloc = new LocalIdAllocator();
    const seen: number[] = [];
    for (let i = 0; i < SERVER_GEN_WRAP + 3; i++) {
      const id = alloc.alloc();
      expect(slotOf(id)).toBe(1);
      expect(isLocal(id)).toBe(true);
      seen.push(genOf(id) & (SERVER_GEN_WRAP - 1));
      alloc.release(id);
    }
    expect(seen.slice(0, 3)).toEqual([0, 1, 2]);
    expect(seen[SERVER_GEN_WRAP - 1]).toBe(2047);
    expect(seen.slice(SERVER_GEN_WRAP)).toEqual([0, 1, 2]);
  });
});

describe('World and ids', () => {
  it('rejects local ids', () => {
    const world = new World(registryOf([Tag]));
    const server = world.create();
    world.add(server, Tag, { n: 1 });
    const local = new LocalIdAllocator().alloc();
    // Same slot as the live server entity; only the local generation differs.
    expect(slotOf(local)).toBe(slotOf(server));
    expect(world.alive(local)).toBe(false);
    expect(world.has(local, Tag)).toBe(false);
    expect(world.tryGet(local, Tag)).toBeUndefined();
    expect(() => world.destroy(local)).toThrow(StaleEntity);
    expect(() => world.add(local, Tag)).toThrow(StaleEntity);
    expect(() => world.get(local, Tag)).toThrow(StaleEntity);
    expect(() => world.write(local, Tag)).toThrow(StaleEntity);
    expect(() => world.remove(local, Tag)).toThrow(StaleEntity);
    expect(world.alive(server)).toBe(true);
  });

  it('never allocates slot 0 and rejects ENTITY_NONE and non-u32 ids', () => {
    const world = new World(registryOf([Tag]));
    const e = world.create();
    expect(slotOf(e)).toBe(1);
    expect(e).not.toBe(ENTITY_NONE);
    expect(world.alive(ENTITY_NONE)).toBe(false);
    expect(world.alive(e + 0.5)).toBe(false);
    expect(world.alive(-e)).toBe(false);
  });

  it('server generations wrap at SERVER_GEN_WRAP without setting bit 31', () => {
    const world = new World(registryOf([Tag]));
    const gens: number[] = [];
    for (let i = 0; i < 2 * SERVER_GEN_WRAP + 3; i++) {
      const e = world.create();
      expect(slotOf(e)).toBe(1);
      expect(isLocal(e)).toBe(false);
      expect(e & LOCAL_BIT).toBe(0);
      expect(e).toBeLessThan(2 ** 31);
      gens.push(genOf(e));
      world.add(e, Tag);
      world.destroy(e);
      world.applyDestroys();
      expect(world.alive(e)).toBe(false);
    }
    expect(gens.slice(0, 2)).toEqual([0, 1]);
    expect(gens[SERVER_GEN_WRAP - 1]).toBe(SERVER_GEN_WRAP - 1);
    expect(gens[SERVER_GEN_WRAP]).toBe(0);
    expect(gens[2 * SERVER_GEN_WRAP]).toBe(0);
    expect(Math.max(...gens)).toBe(SERVER_GEN_WRAP - 1);
  });
});
