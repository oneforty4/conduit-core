import type { CompatibilityDeclaration } from '@conduit/protocol';
// The host tests' game module (docs/host.md 23): the worker imports it by URL and reads the test
// flags from `workerData.extra`. Loaded on the main thread too (the CLI checks its exports), where
// there are no flags.
import { workerData } from 'node:worker_threads';
import {
  defineGame,
  defineInput,
  defineMessage,
  defineSystem,
  f,
  GridWorld,
  Owner,
  Region,
  Transform,
} from '@conduit/game';
import { defineSessionFactory, type ServerContext } from '@conduit/game/server';

/** Test flags, from `HostOptions.workerExtra`. */
export interface FixtureFlags {
  /** Deliberately ignores worker config for capacity mismatch regression. */
  capacityOverride?: number;
  compatibility?: CompatibilityDeclaration;
  /**
   * Crash the worker (an exception that escapes the Session) at the first tick >= this one on which
   * `crashWithPlayers` players are in the session, after a save; only in a session that started
   * fresh, so the worker started after the crash loads that save and keeps running.
   */
  crashAtTick?: number;
  /** Players the crash waits for; default 0. */
  crashWithPlayers?: number;
  /** Block `onInit`/`onLoad` for this many ms (a slow load). */
  slowLoad?: number;
  /** Ignore `shutdown`: `process.exit` does nothing in this worker, so it has to be terminated. */
  ignoreShutdown?: boolean;
}

export const FIXTURE_GAME_ID = 'host-fixture';
export const SPAWN_REGION = 'cell/1_1';
/** Metres per second at full throttle. */
export const SPEED = 8;

export const Input = defineInput({ tick: f.u32, throttle: f.i8 });
export type FixtureInput = ReturnType<typeof Input.create>;
/** Sent by a client; the server broadcasts `'<name>: <text>'` to every player. */
export const Chat = defineMessage('Chat', 'both', { text: f.str(200) });

const flags: FixtureFlags =
  (workerData as { extra?: FixtureFlags } | null | undefined)?.extra ?? {};

if (flags.ignoreShutdown === true) {
  process.exit = (() => undefined) as unknown as typeof process.exit;
}

/** The session state `onSave` stores: how many saves this session made, across workers. */
interface Saved {
  saves: number;
}

const state = { saves: 0, fresh: false, crashing: false };
let hostContext: ServerContext<FixtureInput> | null = null;

function blockFor(ms: number | undefined): void {
  if (ms === undefined || ms <= 0) return;
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // A busy wait: `worker.terminate()` still interrupts it.
  }
}

const drive = defineSystem('drive', 'sim', (ctx) => {
  for (const e of ctx.world.query(Owner, Transform)) {
    const frame = ctx.inputs(ctx.world.get(e, Owner).player) as FixtureInput | undefined;
    const throttle = frame?.throttle ?? 0;
    if (throttle !== 0) ctx.world.write(e, Transform).pos.x += (throttle / 127) * SPEED * ctx.dt;
  }
});

const crash = defineSystem('crash', 'sim', (ctx) => {
  const at = flags.crashAtTick;
  if (at === undefined || state.crashing || !state.fresh || ctx.tick < at) return;
  const session = hostContext?.session;
  if (session === undefined || session.players().length < (flags.crashWithPlayers ?? 0)) return;
  state.crashing = true;
  const crashNow = (): void => {
    setImmediate(() => {
      throw new Error(`fixture crash at tick ${ctx.tick}`);
    });
  };
  // Crash whether or not the save worked (a failed save shows in the test's saves check).
  session.flushAll().then(crashNow, crashNow);
});

export const game = defineGame({
  id: FIXTURE_GAME_ID,
  name: 'Host fixture',
  protocolVersion: 1,
  compatibility: flags.compatibility,
  tickRate: 60,
  snapshotEvery: 3,
  seed: 7,
  components: [],
  messages: [Chat],
  events: [],
  input: Input,
  systems: [drive, crash],
  world: (seed) =>
    new GridWorld({ cellSize: 64, cols: 3, rows: 3, wantedDepth: 1, worldSeed: seed }),
});

export const sessionFactory = defineSessionFactory(game, () => ({
  ...(flags.capacityOverride === undefined ? {} : { maxPlayers: flags.capacityOverride }),
  regionLoader: { populate() {} },
  hooks: {
    onInit(ctx) {
      blockFor(flags.slowLoad);
      hostContext = ctx;
      state.fresh = true;
    },
    onLoad(ctx, saved) {
      blockFor(flags.slowLoad);
      hostContext = ctx;
      state.saves = (saved as Saved | null)?.saves ?? 0;
    },
    onSave(): Saved {
      state.saves++;
      return { saves: state.saves };
    },
    onPlayerJoin(player, ctx) {
      // Through the worker's log: the host logger receives it as `[session <id>] fixture: ...`.
      ctx.log('info', `fixture: ${player.displayName} joined`);
      return {
        regionId: SPAWN_REGION,
        spawn(ctx) {
          const e = ctx.world.create();
          ctx.world.add(e, Region, { id: SPAWN_REGION });
          ctx.world.add(e, Transform, { pos: { x: 20 + 4 * player.playerId, y: 0, z: 32 } });
          ctx.world.add(e, Owner, { player: player.playerId });
          return e;
        },
      };
    },
    onMessage: {
      Chat(player, msg, ctx) {
        ctx.broadcast(Chat, { text: `${player.displayName}: ${(msg as { text: string }).text}` });
      },
    },
  },
}));
