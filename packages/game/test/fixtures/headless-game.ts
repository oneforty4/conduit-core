// The headless integration suite's game module (docs/game.md 6): the sandbox game with extra crates
// in the spawn cell and a far-away spawn for the player named C. `createServer` runs its parts
// in-process; under `createHost` a session worker imports this file (`game`, `sessionFactory`) and
// reports what the suite checks on the server over a BroadcastChannel (`PROBE_CHANNEL`).
import { BroadcastChannel } from 'node:worker_threads';
import type { Session } from '@conduit/net-server';
import type { EntityId, SimContext } from '@conduit/sim';
import type { RegionBlob, RegionDef, RegionId, RegionLoader } from '@conduit/world';
import { createHooks, spawnVehicle } from '../../../../examples/sandbox/src/server/hooks.ts';
import { SandboxLoader } from '../../../../examples/sandbox/src/server/loader.ts';
import { Crate, Vehicle } from '../../../../examples/sandbox/src/shared/components.ts';
import {
  CRATES_PER_REGION,
  SPAWN_REGION,
} from '../../../../examples/sandbox/src/shared/constants.ts';
import { game } from '../../../../examples/sandbox/src/shared/game.ts';
import type { SandboxInput } from '../../../../examples/sandbox/src/shared/input.ts';
import { randomGroundPoint } from '../../../../examples/sandbox/src/shared/systems.ts';
import { Model, Region, Transform } from '../../src/index.ts';
import { defineSessionFactory, type ServerContext, type ServerHooks } from '../../src/server.ts';

export { game };

/** Crates in the nine cells around the spawn cell (Spike 1 measures bandwidth with 300 in view). */
export const CRATES_IN_VIEW = 300;
/** C's spawn cell: its region set shares no cell with the spawn cell's. */
export const FAR_REGION = 'cell/2_2';

/** Test-only content: the sandbox's regions, plus extra crates in the spawn cell. */
export class CrowdedLoader implements RegionLoader {
  private readonly sandbox = new SandboxLoader();
  private readonly extra: number;

  constructor() {
    const wanted = game.world(game.seed).wanted(SPAWN_REGION).length;
    this.extra = CRATES_IN_VIEW - wanted * CRATES_PER_REGION;
  }

  populate(region: RegionDef, blob: RegionBlob | null, ctx: SimContext): void {
    this.sandbox.populate(region, blob, ctx);
    if (region.id !== SPAWN_REGION || blob !== null) return;
    const rng = ctx.regionRng(region.id);
    for (let i = 0; i < this.extra; i++) {
      const e = ctx.world.create();
      ctx.world.add(e, Transform, { pos: randomGroundPoint(rng, { x: 0, y: 0, z: 0 }) });
      ctx.world.add(e, Region, { id: region.id });
      ctx.world.add(e, Model, { asset: 'crate', variant: 0 });
      ctx.world.add(e, Crate, {});
    }
  }
}

/** The sandbox hooks, except that the player named C spawns in `FAR_REGION`. */
export function hooksWithDistantC(): ServerHooks<SandboxInput> {
  const hooks = createHooks();
  return {
    ...hooks,
    onPlayerJoin(player, ctx) {
      const spawn = hooks.onPlayerJoin(player, ctx);
      if (player.displayName !== 'C') return spawn;
      return {
        regionId: FAR_REGION,
        spawn: (spawnCtx) => spawnVehicle(player, spawnCtx, FAR_REGION),
      };
    },
  };
}

/** What a session reports about itself: every tick, and the world hash on snapshot ticks. */
export type ServerReport =
  | {
      t: 'tick';
      tick: number;
      /** Display names in ascending `playerId`. */
      players: string[];
      active: RegionId[];
      /** Vehicles alive once this tick's destroys apply. */
      vehicles: EntityId[];
    }
  | { t: 'hash'; tick: number; hash: number; count: number };

/** Worker → test: a report, or the answer to a `sync` request. */
export type ProbeMessage =
  (ServerReport & { sessionId: string }) | { t: 'synced'; sessionId: string; id: number };
/** Test → worker. */
export interface ProbeRequest {
  t: 'sync';
  id: number;
}

export const PROBE_CHANNEL = 'conduit-game-headless-probe';

/**
 * A tail step (it runs after membership and the spatial rebuild; nothing writes the world between it
 * and the snapshot of the same tick) that reports the tick, and on snapshot ticks without a pending
 * destroy (the tail runs before destroys apply) `world.hash()` and the entity count: the state each
 * client's snapshot of that tick describes.
 */
export function reportingTail(
  session: Session,
  report: (msg: ServerReport) => void,
): (ctx: SimContext) => void {
  return (ctx) => {
    const destroyed = ctx.world.destroyedThisTick();
    report({
      t: 'tick',
      tick: ctx.tick,
      players: session.players().map((p) => p.displayName),
      active: [...session.regions.active()],
      vehicles: [...ctx.world.query(Vehicle)].filter((e) => !destroyed.includes(e)),
    });
    if (ctx.tick % game.snapshotEvery !== 0 || destroyed.length > 0) return;
    report({ t: 'hash', tick: ctx.tick, hash: ctx.world.hash(), count: ctx.world.count() });
  };
}

/** `hooks` plus, once the session loaded, the reporting tail and `sync` answers on the channel. */
function reporting(hooks: ServerHooks<SandboxInput>, sessionId: string): ServerHooks<SandboxInput> {
  let channel: BroadcastChannel | null = null;
  const install = (ctx: ServerContext<SandboxInput>): void => {
    if (channel !== null) return;
    const open = new BroadcastChannel(PROBE_CHANNEL);
    channel = open;
    const post = (msg: ProbeMessage): void => open.postMessage(msg);
    open.onmessage = (event) => {
      const request = event.data as ProbeRequest | null;
      if (request?.t === 'sync') post({ t: 'synced', sessionId, id: request.id });
    };
    ctx.sim.tail.push(reportingTail(ctx.session, (msg) => post({ ...msg, sessionId })));
  };
  return {
    ...hooks,
    onInit(ctx) {
      install(ctx);
      hooks.onInit?.(ctx);
    },
    onLoad(ctx, saved) {
      install(ctx);
      hooks.onLoad?.(ctx, saved);
    },
  };
}

export const sessionFactory = defineSessionFactory(game, (sessionId) => ({
  regionLoader: new CrowdedLoader(),
  hooks: reporting(hooksWithDistantC(), sessionId),
}));
