// Test helper: the sandbox game's World, RegionManager and Simulation wired the way the Session
// wires them (docs/net.md A.5), without networking. Not a test file (vitest includes *.test.ts).
import { ENTITY_NONE, PlayerState } from '@conduit/protocol';
import {
  type EntityId,
  type InputFrame,
  type SimContext,
  Simulation,
  type SpatialApi,
  World,
} from '@conduit/sim';
import {
  RegionManager,
  type RegionLoader,
  type RegionStore,
  type WorldGraph,
} from '@conduit/world';
import type { PlayerInfo } from '@conduit/game/server';
import { spawnVehicle } from '../src/server/hooks.ts';
import { SandboxLoader } from '../src/server/loader.ts';
import { SPAWN_REGION } from '../src/shared/constants.ts';
import { game } from '../src/shared/game.ts';
import type { SandboxInput } from '../src/shared/input.ts';

export const noSpatial: SpatialApi = {
  queryRadius: (_id, _pos, _r, out) => out,
  queryAABB: (_id, _min, _max, out) => out,
  queryRadiusAcross: (_id, _pos, _r, out) => out,
  nearest: () => undefined,
};

/** Nothing is ever stored: every region activates fresh. */
export const emptyStore: RegionStore = {
  get: () => Promise.resolve(null),
  put: () => Promise.resolve(),
  transaction: async (fn) => fn(emptyStore),
};

/** Resolves after a macrotask, once every settled promise's callbacks have run. */
export function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function player(playerId: number, displayName = `p${playerId}`): PlayerInfo {
  return {
    playerId,
    accountId: `dev:${displayName}`,
    displayName,
    state: PlayerState.Playing,
    entity: ENTITY_NONE,
  };
}

export function input(throttle: number, steer = 0, buttons = 0): SandboxInput {
  return { tick: 0, throttle, steer, buttons };
}

export interface SandboxSimOptions {
  /** World seed; default `game.seed`. */
  seed?: number;
  /** Default `new SandboxLoader()`. */
  loader?: RegionLoader;
}

/**
 * The sandbox sim stepped by hand: `regions.update` then `Simulation.step`, like a Session tick.
 * `step` is synchronous, so a region wanted during a run of steps only activates once the caller
 * yields a macrotask.
 */
export class SandboxSim {
  readonly world: World;
  readonly graph: WorldGraph;
  readonly regions: RegionManager;
  readonly sim: Simulation;
  /** Player vehicles by player id. */
  readonly vehicles: EntityId[] = [];

  constructor(opts: SandboxSimOptions = {}) {
    const seed = opts.seed ?? game.seed;
    this.world = new World(game.registry);
    this.graph = game.world(seed);
    const regions = new RegionManager({
      graph: this.graph,
      world: this.world,
      loader: opts.loader ?? new SandboxLoader(),
      store: emptyStore,
      tickRate: game.tickRate,
    });
    this.regions = regions;
    this.sim = new Simulation({
      world: this.world,
      tickRate: game.tickRate,
      seed,
      regionRng: (id) => regions.regionRng(id),
      regions,
      spatial: noSpatial,
    });
    for (const system of game.systems) this.sim.register(system);
    this.sim.tail.push((ctx) => regions.membershipSystem.run(ctx));
  }

  get ctx(): SimContext {
    return this.sim.ctx;
  }

  /**
   * Activates the spawn region and its neighbourhood. A region load awaits `store.get` (docs/world.md
   * 5.1), so the first update only starts the loads; the update after the next macrotask activates
   * them.
   */
  async activateSpawn(): Promise<void> {
    this.regions.update(this.vehicles, this.ctx, [SPAWN_REGION]);
    await nextTask();
    this.regions.update(this.vehicles, this.ctx, [SPAWN_REGION]);
    if (this.regions.state(SPAWN_REGION) !== 'active') {
      throw new Error(`activateSpawn: ${SPAWN_REGION} is ${this.regions.state(SPAWN_REGION)}`);
    }
  }

  /** Spawns `playerId`'s vehicle as the sandbox hooks do; the spawn region must be active. */
  spawn(playerId: number): EntityId {
    const e = spawnVehicle(player(playerId), this.ctx);
    this.vehicles[playerId] = e;
    return e;
  }

  /** One tick with `frames[playerId]` as each player's input (undefined: no input). */
  step(frames: readonly (SandboxInput | undefined)[] = []): void {
    for (let p = 0; p < this.sim.inputFrames.length; p++) {
      this.sim.inputFrames[p] = frames[p] as InputFrame | undefined;
    }
    this.regions.update(this.vehicles, this.ctx, [SPAWN_REGION]);
    this.sim.step(this.world.tick + 1);
  }
}
