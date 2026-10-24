import type { EntityId } from '@conduit/protocol';

// errors.ts has no runtime imports so every module can import it without a cycle; the slot and
// generation masks below are the literal values of SLOT_MASK / GEN_SHIFT / GEN_MASK (entity.ts).
function describeEntity(e: EntityId): string {
  return `${e} (slot ${e & 0xfffff}, generation ${(e >>> 20) & 0xfff})`;
}

/**
 * An entity id that is not alive in this World: destroyed and applied, never allocated, a reused
 * slot with an older generation, or a client-local id (docs/sim.md 2.1, 2.2).
 */
export class StaleEntity extends Error {
  override readonly name = 'StaleEntity';
  readonly entity: EntityId;

  constructor(entity: EntityId) {
    super(`stale entity ${describeEntity(entity)}`);
    this.entity = entity;
  }
}

/** `read`/`write`/`set` on an alive entity that does not have the component. */
export class MissingComponent extends Error {
  override readonly name = 'MissingComponent';
  readonly component: string;
  readonly entity: EntityId;

  constructor(component: string, entity: EntityId) {
    super(`entity ${describeEntity(entity)} has no ${component}`);
    this.component = component;
    this.entity = entity;
  }
}

/** `add` on an entity that already has the component. */
export class AlreadyPresent extends Error {
  override readonly name = 'AlreadyPresent';
  readonly component: string;
  readonly entity: EntityId;

  constructor(component: string, entity: EntityId) {
    super(`entity ${describeEntity(entity)} already has ${component}`);
    this.component = component;
    this.entity = entity;
  }
}

/** A component type that is not one of the World registry's components. */
export class UnknownComponent extends Error {
  override readonly name = 'UnknownComponent';
  readonly component: string;

  constructor(component: string) {
    super(`component ${component} is not in this World's registry`);
    this.component = component;
  }
}

/** `Simulation.register` with a system name that is already registered. */
export class DuplicateSystem extends Error {
  override readonly name = 'DuplicateSystem';
  readonly system: string;

  constructor(system: string) {
    super(`system ${system} is already registered`);
    this.system = system;
  }
}

/** `Simulation.step(tick)` where `tick !== world.tick + 1`. */
export class TickOrder extends Error {
  override readonly name = 'TickOrder';
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number) {
    super(`step(${actual}) out of order: expected tick ${expected}`);
    this.expected = expected;
    this.actual = actual;
  }
}
