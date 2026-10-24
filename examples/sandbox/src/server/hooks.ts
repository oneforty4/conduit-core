import { Model, Name, Owner, Region, Transform } from '@conduit/game';
import type { PlayerInfo, ServerHooks } from '@conduit/game/server';
import type { EntityId, SimContext } from '@conduit/sim';
import type { RegionId } from '@conduit/world';
import { Vehicle } from '../shared/components.ts';
import { COLOURS, SPAWN_REGION, SPAWN_SPACING } from '../shared/constants.ts';
import type { SandboxInput } from '../shared/input.ts';
import { Chat, chatLine, type ChatMessage, Joins } from '../shared/messages.ts';

/** What `onSave` stores and `onLoad` restores. */
export interface SandboxSessionState {
  joins: number;
}

function joinsOf(saved: unknown): number | null {
  if (typeof saved !== 'object' || saved === null) return null;
  const joins = (saved as Partial<SandboxSessionState>).joins;
  return typeof joins === 'number' && Number.isInteger(joins) && joins >= 0 ? joins : null;
}

/** Creates `player`'s vehicle in `regionId` (default the spawn region), which must be active. */
export function spawnVehicle(
  player: PlayerInfo,
  ctx: SimContext,
  regionId: RegionId = SPAWN_REGION,
): EntityId {
  const { world } = ctx;
  const e = world.create();
  world.add(e, Transform, { pos: { x: SPAWN_SPACING * player.playerId, y: 0, z: 0 } });
  world.add(e, Region, { id: regionId });
  world.add(e, Model, { asset: 'vehicle', variant: 0 });
  world.add(e, Owner, { player: player.playerId });
  world.add(e, Name, { value: player.displayName });
  world.add(e, Vehicle, {
    throttle: 0,
    steer: 0,
    buttons: 0,
    colour: COLOURS[player.playerId % COLOURS.length] ?? 0xffffff,
  });
  return e;
}

/**
 * The sandbox's server hooks (PLAN.md "Sandbox content spec"). Each call returns a fresh hooks
 * object with its own join counter, so every session (and every server a test starts) keeps its
 * own state. The counter is the saved session state: `onSave` returns `{ joins }` and `onLoad`
 * restores it, so it continues across restarts on the same store.
 */
export function createHooks(): ServerHooks<SandboxInput> {
  let joins = 0;
  return {
    onInit() {
      joins = 0;
    },
    onSave(): SandboxSessionState {
      return { joins };
    },
    onLoad(ctx, saved) {
      const restored = joinsOf(saved);
      if (restored === null) ctx.log('warn', 'sandbox: ignoring a malformed saved session', saved);
      joins = restored ?? 0;
    },
    onPlayerJoin(player, ctx) {
      joins++;
      ctx.log('info', `sandbox: ${player.displayName} joined as player ${player.playerId}`, {
        joins,
      });
      // Every connected player, the new one included, shows the counter in the HUD.
      ctx.broadcast(Joins, { total: joins });
      return { regionId: SPAWN_REGION, spawn: (spawnCtx) => spawnVehicle(player, spawnCtx) };
    },
    onPlayerLeave(player, ctx) {
      // The core destroys player.entity after this hook returns.
      ctx.log('info', `sandbox: ${player.displayName} (player ${player.playerId}) left`);
    },
    relevance: () => true,
    onMessage: {
      /** Broadcasts `'<displayName>: <text>'` (clipped to `Chat.text`'s limit); blank text is dropped. */
      Chat(player, msg, ctx) {
        const text = (msg as ChatMessage).text.trim();
        if (text === '') return;
        ctx.broadcast(Chat, { text: chatLine(player.displayName, text) });
      },
    },
  };
}
