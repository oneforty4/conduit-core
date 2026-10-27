import type { HookContext, PlayerSpawn, SessionHooks } from '@conduit/net-server';
import type { KickReason, MessageDef } from '@conduit/protocol';
import type { InputFrame } from '@conduit/sim';
import type { Game, ServerContext, ServerHooks, ServerLog } from './types.ts';

/** The console-backed default `ServerContext.log`. */
export const consoleServerLog: ServerLog = (level, msg, data) => {
  const line = msg.startsWith('[') ? msg : `[conduit/game] ${msg}`;
  const args: unknown[] = data === undefined ? [line] : [line, data];
  if (level === 'error') console.error(...args);
  else if (level === 'warn') console.warn(...args);
  // eslint-disable-next-line no-console -- info is part of the console-backed default log
  else console.info(...args);
};

/**
 * A `ServerContext` over the Session's `HookContext` (docs/game.md 2): its prototype is `ctx`, so
 * `tick`, `dt`, `rng`, `inputs`, ... stay live, and the added members delegate to `ctx.session`.
 */
export function buildServerContext<I extends InputFrame>(
  ctx: HookContext,
  game: Game<I>,
  log: ServerLog = consoleServerLog,
): ServerContext<I> {
  const session = ctx.session;
  const members: PropertyDescriptorMap = {
    game: { value: game, enumerable: true },
    sim: { value: session.simulation, enumerable: true },
    regionManager: { value: session.regions, enumerable: true },
    spatialIndex: { value: session.spatial, enumerable: true },
    players: { get: () => session.players(), enumerable: true },
    send: {
      value: (player: number, type: MessageDef<unknown>, msg: unknown): void =>
        session.send(player, type, msg),
    },
    broadcast: {
      value: (type: MessageDef<unknown>, msg: unknown): void => session.broadcast(type, msg),
    },
    enqueueExternalCommand: { value: session.enqueueExternalCommand.bind(session) },
    kick: { value: (player: number, reason: KickReason): void => session.kick(player, reason) },
    log: { value: log },
  };
  return Object.create(ctx, members) as ServerContext<I>;
}

/** net-server's `SessionHooks` built from a game's `ServerHooks`, plus a dispatch counter. */
export interface AdaptedHooks extends SessionHooks {
  /** c2s/both game messages that arrived with no `ServerHooks.onMessage` handler for their name. */
  readonly unhandledMessages: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** `onSave`'s value as JSON bytes; `undefined` (not representable in JSON) is stored as `null`. */
function encodeSaved(value: unknown): Uint8Array {
  const json = JSON.stringify(value) as string | undefined;
  return encoder.encode(json ?? 'null');
}

function decodeSaved(blob: Uint8Array | null): unknown {
  return blob === null ? null : (JSON.parse(decoder.decode(blob)) as unknown);
}

/**
 * Adapts a game's hooks to the Session (docs/game.md 2): each entry calls the game's hook with a
 * `ServerContext` built on first use (and rebuilt only if the Session hands over a different
 * context); `onSave`/`onLoad` go through JSON; `onMessage` dispatches by `def.name`, ignoring and
 * counting names without a handler; `PlayerSpawn.spawn` receives the `ServerContext`. Hooks the game
 * leaves out stay unset, so the Session skips them. Throws `TypeError` without `onPlayerJoin`.
 */
export function adaptHooks<I extends InputFrame>(
  hooks: ServerHooks<I>,
  game: Game<I>,
  log: ServerLog = consoleServerLog,
): AdaptedHooks {
  if (typeof hooks?.onPlayerJoin !== 'function') {
    throw new TypeError('ServerHooks.onPlayerJoin is required');
  }
  let cachedFor: HookContext | null = null;
  let cached: ServerContext<I> | null = null;
  const serverContext = (ctx: HookContext): ServerContext<I> => {
    if (cached === null || cachedFor !== ctx) {
      cached = buildServerContext(ctx, game, log);
      cachedFor = ctx;
    }
    return cached;
  };

  let unhandled = 0;
  const { onInit, onLoad, onSave, onPlayerJoin, onPlayerLeave, onWorldEdge, relevance } = hooks;
  const handlers = hooks.onMessage;

  const adapted: SessionHooks & { readonly unhandledMessages: number } = {
    get unhandledMessages(): number {
      return unhandled;
    },
    onPlayerJoin(player, ctx): PlayerSpawn {
      const plan = onPlayerJoin.call(hooks, player, serverContext(ctx));
      // Anything but a PlayerSpawn is passed through for the Session to reject with its own message.
      if (plan === null || typeof plan !== 'object' || typeof plan.spawn !== 'function')
        return plan;
      return { regionId: plan.regionId, spawn: (spawnCtx) => plan.spawn(serverContext(spawnCtx)) };
    },
    onMessage(player, def, payload, ctx): void {
      const handler =
        handlers !== undefined && Object.hasOwn(handlers, def.name)
          ? handlers[def.name]
          : undefined;
      if (handler === undefined) {
        unhandled++;
        return;
      }
      handler.call(handlers, player, payload, serverContext(ctx));
    },
  };
  if (onInit !== undefined) adapted.onInit = (ctx) => onInit.call(hooks, serverContext(ctx));
  if (onLoad !== undefined) {
    adapted.onLoad = (ctx, blob) => onLoad.call(hooks, serverContext(ctx), decodeSaved(blob));
  }
  if (onSave !== undefined) {
    adapted.onSave = (ctx) => encodeSaved(onSave.call(hooks, serverContext(ctx)));
  }
  if (onPlayerLeave !== undefined) {
    adapted.onPlayerLeave = (player, ctx) => onPlayerLeave.call(hooks, player, serverContext(ctx));
  }
  if (onWorldEdge !== undefined) {
    adapted.onWorldEdge = (entity, ctx) => onWorldEdge.call(hooks, entity, serverContext(ctx));
  }
  if (relevance !== undefined) {
    adapted.relevance = (player, entity, ctx) =>
      relevance.call(hooks, player, entity, serverContext(ctx));
  }
  if (hooks.replicationGroups !== undefined)
    adapted.replicationGroups = (player, ctx) =>
      hooks.replicationGroups!(player, serverContext(ctx));
  if (hooks.replicationPriority !== undefined)
    adapted.replicationPriority = (player, group, ctx) =>
      hooks.replicationPriority!(player, group, serverContext(ctx));
  if (hooks.eventDependencies !== undefined)
    adapted.eventDependencies = (player, event, ctx) =>
      hooks.eventDependencies!(player, event, serverContext(ctx));
  const { simulationInterest } = hooks;
  if (simulationInterest !== undefined) {
    adapted.simulationInterest = (ctx) => simulationInterest.call(hooks, serverContext(ctx));
  }
  return adapted;
}
