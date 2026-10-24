import type { SimContext } from './context.ts';

export type Phase = 'input' | 'preSim' | 'sim' | 'postSim';

/** Execution order of phases; within a phase, systems run in registration order. */
export const PHASES: readonly Phase[] = Object.freeze(['input', 'preSim', 'sim', 'postSim']);

/**
 * A system holds no cross-tick state outside components: module-level constants are fine; mutable
 * module-level caches, closures over counters and `WeakMap`s keyed by entity are not. Per-tick
 * scratch buffers are reset at the start of `run`.
 */
export interface System {
  readonly name: string;
  readonly phase: Phase;
  run(ctx: SimContext): void;
}

export function defineSystem(name: string, phase: Phase, run: (ctx: SimContext) => void): System {
  if (typeof name !== 'string' || name.length === 0) {
    throw new RangeError('defineSystem: name must be a non-empty string');
  }
  if (!PHASES.includes(phase)) {
    throw new RangeError(`defineSystem ${name}: unknown phase ${JSON.stringify(phase)}`);
  }
  if (typeof run !== 'function')
    throw new TypeError(`defineSystem ${name}: run must be a function`);
  return Object.freeze({ name, phase, run });
}
