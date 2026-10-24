import type { EntityId } from '@conduit/protocol';
import { StaleEntity } from './errors.ts';

export { type EntityId, ENTITY_NONE } from '@conduit/protocol';

/** Low 20 bits of an id hold the slot. */
export const SLOT_BITS = 20;
export const SLOT_MASK = 0x000fffff;
export const GEN_SHIFT = 20;
/** 12 generation bits, bits 20..31. */
export const GEN_MASK = 0xfff;
/** Bit 31: set only on client-local ids. */
export const LOCAL_BIT = 0x80000000;
/** `1 << 20`. Slot 0 is reserved (`ENTITY_NONE`) and never allocated. */
export const MAX_SLOTS = 1_048_576;
/** Server generations wrap at 11 bits so bit 31 stays clear. */
export const SERVER_GEN_WRAP = 2048;
/** Local generations are `2048 | n`, so bit 31 is set. */
export const LOCAL_GEN_BASE = 2048;

export function slotOf(e: EntityId): number {
  return e & SLOT_MASK;
}

export function genOf(e: EntityId): number {
  return (e >>> GEN_SHIFT) & GEN_MASK;
}

export function makeId(slot: number, gen: number): EntityId {
  return (((gen & GEN_MASK) << GEN_SHIFT) | (slot & SLOT_MASK)) >>> 0;
}

export function isLocal(e: EntityId): boolean {
  return (e & LOCAL_BIT) !== 0;
}

/**
 * Allocator for client-local, view-only entities (particles and the like) used by
 * `@conduit/net-client` and `@conduit/render`. Local ids have bit 31 set, so they never collide
 * with server ids, and `World` rejects them. Never replicated, never persisted.
 */
export class LocalIdAllocator {
  private nextSlot = 1;
  /** Per slot: the generation (0..2047) the next id for that slot gets. */
  private readonly gens: number[] = [];
  /** Per slot: true while an id for the slot is allocated. */
  private readonly live: boolean[] = [];
  /** LIFO stack of released slots. */
  private readonly free: number[] = [];

  alloc(): EntityId {
    let slot = this.free.pop();
    if (slot === undefined) {
      if (this.nextSlot > SLOT_MASK) throw new RangeError('LocalIdAllocator: all slots in use');
      slot = this.nextSlot++;
      this.gens[slot] = 0;
    }
    this.live[slot] = true;
    return makeId(slot, LOCAL_GEN_BASE | ((this.gens[slot] ?? 0) & (SERVER_GEN_WRAP - 1)));
  }

  /**
   * Bumps the slot's generation (mod 2048) and pushes the slot onto the free list. Throws
   * `StaleEntity` for an id this allocator did not hand out or that was already released.
   */
  release(e: EntityId): void {
    const slot = slotOf(e);
    const gen = this.gens[slot];
    if (
      !isLocal(e) ||
      e >>> 0 !== e ||
      this.live[slot] !== true ||
      gen === undefined ||
      (genOf(e) & (SERVER_GEN_WRAP - 1)) !== gen
    ) {
      throw new StaleEntity(e);
    }
    this.gens[slot] = (gen + 1) % SERVER_GEN_WRAP;
    this.live[slot] = false;
    this.free.push(slot);
  }
}
