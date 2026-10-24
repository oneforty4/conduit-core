import { devVerifier } from '@conduit/auth';
import { Rng } from '@conduit/math';
import { QueuedLinkBase, Session } from '@conduit/net-server';
import type { BlobStore } from '@conduit/persist';
import {
  ByteReader,
  ByteWriter,
  CoreKind,
  decodeWith,
  encodeWith,
  ENTITY_NONE,
  FrameWriter,
  type MessageDef,
  PlayerState,
  readFrame,
  RegionSetSchema,
  SpawnedSchema,
  WelcomeSchema,
} from '@conduit/protocol';
import {
  type Checkpoint,
  type InputLog,
  type InputLogEntry,
  type LifecycleEntry,
  type LifecycleEvent,
  record,
  replay,
  type ReplayableGame,
  type SkipEntry,
  TickOrder,
} from '@conduit/sim';
import type { RegionLoader } from '@conduit/world';
import { beforeAll, describe, expect, it } from 'vitest';
import { createHooks } from '../../../examples/sandbox/src/server/hooks.ts';
import { SandboxLoader } from '../../../examples/sandbox/src/server/loader.ts';
import { Vehicle } from '../../../examples/sandbox/src/shared/components.ts';
import { SPAWN_REGION } from '../../../examples/sandbox/src/shared/constants.ts';
import { game } from '../../../examples/sandbox/src/shared/game.ts';
import { BUTTON_HORN, type SandboxInput } from '../../../examples/sandbox/src/shared/input.ts';
import { Name } from '../src/index.ts';
import {
  createReplayRun,
  DEV_SESSION_ID,
  type GameReplayRun,
  MemoryStore,
  type ServerHooks,
  type ServerLog,
} from '../src/server.ts';
import { adaptHooks } from '../src/serverContext.ts';

// Replay as a regression test (docs/game.md 2 and 6, docs/sim.md 2.11) on the sandbox game: a
// scripted two-player log recorded and replayed through createReplayRun, and a live Session with
// scripted clients whose recordLog replays to the checkpoints it produced.

const EVERY = 60;
const TICKS = 600;
/** The ticks the live session skips (docs/sim.md 2.10): from 200, thirteen. */
const SKIPPED: SkipEntry = [200, 13];
/** Byte offset of `throttle` in an encoded `InputFrame`: after `tick: u32`. */
const THROTTLE_BYTE = 4;

interface LogLine {
  level: string;
  msg: string;
}

function collectingLog(): { log: ServerLog; lines: LogLine[] } {
  const lines: LogLine[] = [];
  return { log: (level, msg) => lines.push({ level, msg }), lines };
}

const problems = (lines: readonly LogLine[]): string[] =>
  lines.filter((line) => line.level !== 'info').map((line) => `${line.level}: ${line.msg}`);

const join = (name: string): LifecycleEvent => ({
  type: 'join',
  accountId: `dev:${name.toLowerCase()}`,
  displayName: name,
});

/** Resolves on a later macrotask, once every promise callback queued so far has run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * The sandbox hooks, except that a join of `Y` creates an entity and then throws, so the Session
 * kicks `Y` in the same lifecycle pass.
 */
function sandboxHooks(): ServerHooks<SandboxInput> {
  const hooks = createHooks();
  return {
    ...hooks,
    onPlayerJoin(player, ctx) {
      if (player.displayName === 'Y') {
        ctx.world.add(ctx.world.create(), Name, { value: 'Y was here' });
        throw new Error('Y is not welcome');
      }
      return hooks.onPlayerJoin(player, ctx);
    },
  };
}

/** A MemoryStore whose reads answer only after many promise hops, all within one macrotask. */
class HoppingStore extends MemoryStore {
  override async get(ns: string, key: string): Promise<Uint8Array | null> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    return super.get(ns, key);
  }
}

/** A `ReplayableGame` over the sandbox: a fresh loader, hooks and store for every run. */
function sandbox(log: ServerLog, runs: GameReplayRun[] = []): ReplayableGame {
  return {
    async createRun(seed, tickRate) {
      const run = await createReplayRun(game, {
        regionLoader: new SandboxLoader(),
        hooks: sandboxHooks(),
        seed,
        tickRate,
        log,
      });
      runs.push(run);
      return run;
    },
  };
}

/**
 * Two players, A and B, join and spawn at tick 1; every tick each gets a new frame with probability
 * 0.2 (held otherwise). A always reverses, so it crosses into the next cells and new regions load
 * while the run goes on.
 */
function scriptedLog(): InputLog {
  const rng = new Rng(0x5eed);
  const lifecycle: LifecycleEntry[] = [
    [1, 0, join('A')],
    [1, 1, join('B')],
    [1, 0, { type: 'spawn' }],
    [1, 1, { type: 'spawn' }],
  ];
  const entries: InputLogEntry[] = [];
  for (let tick = 1; tick <= TICKS; tick++) {
    for (let player = 0; player < 2; player++) {
      if (tick !== 1 && tick !== TICKS && !rng.chance(0.2)) continue;
      const frame: SandboxInput = {
        tick,
        throttle: player === 0 ? -rng.int(60, 127) : rng.int(-127, 127),
        steer: rng.int(-127, 127),
        buttons: rng.chance(0.1) ? BUTTON_HORN : 0,
      };
      entries.push([tick, player, frame]);
    }
  }
  return { version: 1, seed: game.seed, tickRate: game.tickRate, entries, lifecycle };
}

describe('createReplayRun on the sandbox game', () => {
  const LOG = scriptedLog();
  const { log, lines } = collectingLog();
  const runs: GameReplayRun[] = [];
  let checkpoints: Checkpoint[] = [];

  beforeAll(async () => {
    checkpoints = await record(sandbox(log, runs), LOG, EVERY);
  }, 60_000);

  it('records 600 ticks of two scripted players with checkpoints every 60, and replay passes', async () => {
    expect(checkpoints.map(([tick]) => tick)).toEqual(
      Array.from({ length: TICKS / EVERY }, (_, i) => (i + 1) * EVERY),
    );
    expect(new Set(checkpoints.map(([, hash]) => hash)).size).toBe(checkpoints.length);
    const session = (runs[0] as GameReplayRun).session;
    expect(session.tick).toBe(TICKS);
    const vehicles = [...session.world.query(Vehicle)];
    expect(vehicles).toHaveLength(2);
    expect(session.players().map((p) => [p.displayName, p.state, p.entity])).toEqual([
      ['A', PlayerState.Playing, vehicles[0]],
      ['B', PlayerState.Playing, vehicles[1]],
    ]);
    // A drove out of the spawn cell's neighbourhood: regions loaded while the run went on.
    expect(session.regions.active().length).toBeGreaterThan(9);

    expect(await replay(sandbox(log, runs), LOG, checkpoints)).toEqual({ ok: true });
    expect((runs[1] as GameReplayRun).hash()).toBe((runs[0] as GameReplayRun).hash());
    expect(problems(lines)).toEqual([]);
  }, 60_000);

  it('flipping one input byte fails at the first checkpoint after it', async () => {
    const index = LOG.entries.findIndex(
      ([tick, player]) => player === 1 && tick > 200 && tick % EVERY !== 0,
    );
    const [tick, , frame] = LOG.entries[index] as InputLogEntry;
    const original = frame as SandboxInput;
    const writer = new ByteWriter(16);
    encodeWith(writer, game.input, original);
    const bytes = writer.finish();
    bytes[THROTTLE_BYTE] = (bytes[THROTTLE_BYTE] as number) ^ 0xff;
    const flipped = decodeWith(new ByteReader(bytes), game.input);
    expect(flipped.throttle).not.toBe(original.throttle);
    expect({ ...flipped, throttle: original.throttle }).toEqual(original);

    const corrupted = structuredClone(LOG);
    corrupted.entries[index] = [tick, 1, flipped];
    const firstAfter = Math.ceil(tick / EVERY) * EVERY;
    const result = await replay(sandbox(log), corrupted, checkpoints);
    expect(result).toEqual({
      ok: false,
      tick: firstAfter,
      expected: (checkpoints[firstAfter / EVERY - 1] as Checkpoint)[1],
      actual: expect.any(Number),
    });
    expect(result.ok === false && result.actual !== result.expected).toBe(true);
    expect(problems(lines)).toEqual([]);
  }, 60_000);

  it.each([
    ['a MemoryStore', (): BlobStore => new MemoryStore()],
    ['a store answering after 20 promise hops', (): BlobStore => new HoppingStore()],
  ])(
    'with %s, a region a step started loading activates at the next step, as between live ticks',
    async (_name, store) => {
      const run = await createReplayRun(game, {
        regionLoader: new SandboxLoader(),
        hooks: createHooks(),
        store: store(),
        log,
      });
      const { regions, world } = run.session;
      run.lifecycle(0, join('A'));
      run.lifecycle(0, { type: 'spawn' });
      expect(run.session.players()).toMatchObject([
        { displayName: 'A', state: PlayerState.Joined },
      ]);
      await run.step(1); // the join: its spawn region is wanted and starts loading
      expect(regions.state(SPAWN_REGION)).toBe('loading');
      expect(run.session.players()).toMatchObject([{ playerId: 0, state: PlayerState.Ready }]);
      await run.step(2); // the load settled after step 1: this update activates the cells
      expect(regions.state(SPAWN_REGION)).toBe('active');
      expect(regions.active()).toHaveLength(9);
      expect([...world.query(Vehicle)]).toEqual([]); // the lifecycle ran before the activation
      await run.step(3);
      const [vehicle] = [...world.query(Vehicle)];
      expect(vehicle).toBeDefined();
      expect(run.session.players()).toMatchObject([
        { accountId: 'dev:a', state: PlayerState.Playing, entity: vehicle },
      ]);
      expect(problems(lines)).toEqual([]);
    },
  );

  it('builds the world of the seed it is given', async () => {
    const hashAfter3 = async (seed?: number): Promise<number> => {
      const run = await createReplayRun(game, {
        regionLoader: new SandboxLoader(),
        hooks: createHooks(),
        seed,
        log,
      });
      run.lifecycle(0, join('A'));
      run.lifecycle(0, { type: 'spawn' });
      for (let tick = 1; tick <= 3; tick++) await run.step(tick);
      expect([...run.session.world.query(Vehicle)]).toHaveLength(1);
      return run.hash();
    };
    expect(await hashAfter3(game.seed)).toBe(await hashAfter3());
    expect(await hashAfter3(7)).not.toBe(await hashAfter3());
  });

  it('validates its options, players, lifecycle steps and tick order', async () => {
    // The sandbox hooks, counting the spawns their plans perform.
    let spawns = 0;
    const base = createHooks();
    const hooks: ServerHooks<SandboxInput> = {
      ...base,
      onPlayerJoin(player, ctx) {
        const plan = base.onPlayerJoin(player, ctx);
        return {
          regionId: plan.regionId,
          spawn: (spawnCtx) => {
            spawns++;
            return plan.spawn(spawnCtx);
          },
        };
      },
    };
    const opts = { regionLoader: new SandboxLoader(), hooks, log };
    await expect(
      createReplayRun(game, { ...opts, regionLoader: {} as RegionLoader }),
    ).rejects.toThrow(TypeError);
    await expect(
      createReplayRun(game, { ...opts, hooks: {} as ServerHooks<SandboxInput> }),
    ).rejects.toThrow(TypeError);
    await expect(createReplayRun(game, { ...opts, seed: -1 })).rejects.toThrow(RangeError);
    await expect(createReplayRun(game, { ...opts, tickRate: 0 })).rejects.toThrow(RangeError);
    await expect(createReplayRun(game, { ...opts, maxPlayers: 9 })).rejects.toThrow(RangeError);

    const run = await createReplayRun(game, { ...opts, maxPlayers: 2 });
    await expect(run.step(2)).rejects.toThrow(TickOrder);
    expect(() => run.setInput(2, null)).toThrow(RangeError);
    expect(() => run.setInput(-1, null)).toThrow(RangeError);
    expect(() => run.lifecycle(0, { type: 'spawn' })).toThrow(RangeError);
    run.lifecycle(1, { type: 'leave' }); // never joined: nothing to do
    run.lifecycle(0, join('A'));
    expect(() => run.lifecycle(0, join('A'))).toThrow(RangeError);
    expect(() => run.lifecycle(0, { type: 'dance' } as unknown as LifecycleEvent)).toThrow(
      RangeError,
    );
    const step = run.step(1);
    await expect(run.step(2)).rejects.toThrow(/previous step/);
    await step;
    expect(run.session.tick).toBe(1);

    // A spawn still waiting for its region is cancelled by a later leave: it never runs.
    run.lifecycle(0, { type: 'spawn' });
    await run.step(2); // the region activates in this step's update, after the lifecycle
    expect(run.session.regions.state(SPAWN_REGION)).toBe('active');
    run.lifecycle(0, { type: 'leave' });
    await run.step(3);
    await run.step(4);
    expect(spawns).toBe(0);
    expect(run.session.players()).toEqual([]);

    // A spawn delivered with the leave of the same step still runs first, as the Session ran it.
    run.lifecycle(1, join('B'));
    await run.step(5);
    run.lifecycle(1, { type: 'spawn' });
    run.lifecycle(1, { type: 'leave' });
    await run.step(6);
    expect(spawns).toBe(1);
    expect([...run.session.world.query(Vehicle)]).toEqual([]); // destroyed by the leave
    expect(run.session.players()).toEqual([]);
    expect(problems(lines)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// A live Session with scripted clients

let nextLinkId = 1;

/** An in-memory `ClientLink`: frames from the Session queue in `inbox`; closes report from a microtask. */
class MemoryLink extends QueuedLinkBase {
  readonly inbox: Uint8Array[] = [];

  send(buf: Uint8Array): void {
    if (!this.closed) this.inbox.push(buf);
  }

  bufferedAmount(): number {
    return 0;
  }

  protected closeTransport(code: number, reason: string): void {
    queueMicrotask(() => this.handleClosed(code, reason));
  }
}

const frames = new FrameWriter();

/**
 * A client speaking the core protocol by hand (docs/net.md A.6): Hello and Ready, a RegionLoadState
 * for every RegionSet, and once spawned a frame for most ticks, a new one now and then.
 */
class ScriptedClient {
  readonly name: string;
  link: MemoryLink | null = null;
  playerId = -1;
  reconnectToken = '';
  entity = ENTITY_NONE;
  private seq = 0;
  private regionSet: string[] | null = null;
  private readonly rng: Rng;
  private frame: SandboxInput = { tick: 0, throttle: 0, steer: 0, buttons: 0 };

  constructor(name: string, seed: number) {
    this.name = name;
    this.rng = new Rng(seed);
  }

  /** Attaches a new link: a fresh join, or a reconnect once a Welcome gave a token. */
  connect(session: Session): void {
    const link = new MemoryLink(nextLinkId++);
    this.link = link;
    this.seq = 0;
    session.attach(link);
    this.send(CoreKind.Hello, {
      protocolVersion: game.protocolVersion,
      registryHash: game.registryHash,
      sessionToken: 'dev',
      reconnectToken: this.reconnectToken,
      displayName: this.name,
    });
    if (this.reconnectToken === '') this.send(CoreKind.Ready, {});
  }

  /** The connection drops (1006). */
  drop(): void {
    this.link?.handleClosed(1006, 'dropped');
    this.link = null;
  }

  leave(): void {
    this.send(CoreKind.Leave, {});
    this.link = null;
  }

  /** Before step `tick`. */
  act(tick: number): void {
    if (this.link === null) return;
    if (this.regionSet !== null) {
      this.send(CoreKind.RegionLoadState, { loaded: this.regionSet, loading: [] });
      this.regionSet = null;
    }
    if (this.entity === ENTITY_NONE) return;
    if (this.rng.chance(0.1)) return; // lost: the Session holds the previous frame
    if (this.rng.chance(0.25)) {
      this.frame = {
        tick,
        throttle: this.rng.int(-127, 127),
        steer: this.rng.int(-127, 127),
        buttons: this.rng.chance(0.2) ? BUTTON_HORN : 0,
      };
    }
    this.send(CoreKind.Input, { firstTick: tick, frames: [{ ...this.frame, tick }] });
  }

  /** After a step: Welcome, RegionSet and the own Spawned; snapshots and the rest are ignored. */
  receive(): void {
    const link = this.link;
    if (link === null) return;
    for (const buf of link.inbox.splice(0)) {
      readFrame(buf, (header, payload) => {
        if (header.kind === CoreKind.Welcome) {
          const welcome = decodeWith(payload, WelcomeSchema);
          this.playerId = welcome.playerId;
          this.reconnectToken = welcome.reconnectToken;
        } else if (header.kind === CoreKind.RegionSet) {
          this.regionSet = decodeWith(payload, RegionSetSchema).active;
        } else if (header.kind === CoreKind.Spawned) {
          const spawned = decodeWith(payload, SpawnedSchema);
          if (spawned.playerId === this.playerId) this.entity = spawned.entity;
        }
      });
    }
  }

  private send(kind: number, payload: unknown): void {
    const def = game.registry.message(kind) as MessageDef;
    frames.begin();
    frames.message(kind, 0, this.seq, (w) => encodeWith(w, def.schema, payload));
    this.seq = (this.seq + 1) % 65536;
    this.link?.deliver(frames.finish());
  }
}

interface LiveRecording {
  log: InputLog;
  checkpoints: Checkpoint[];
  session: Session;
  lines: LogLine[];
}

/**
 * 600 ticks of a manual-loop Session recording into a log: A joins at once; B at tick 40; Y at 100,
 * whose join fails; Z at 150, who drops before its join runs; ticks 200 to 212 are skipped, as a
 * loop held up drops them; A drops at 250 and reconnects at 310; B leaves at 400; C joins at 430
 * into B's slot. A macrotask turn separates the ticks, as the wakes of a live loop do.
 */
async function liveSession(): Promise<LiveRecording> {
  const log: InputLog = { version: 1, seed: game.seed, tickRate: game.tickRate, entries: [] };
  const { log: serverLog, lines } = collectingLog();
  let nowMs = 1000;
  const session = new Session(game, {
    store: new MemoryStore(),
    regionLoader: new SandboxLoader(),
    hooks: adaptHooks(sandboxHooks(), game, serverLog),
    verifier: devVerifier({ warn: () => {} }),
    sessionId: DEV_SESSION_ID,
    manualLoop: true,
    now: () => nowMs,
    ackTimeoutMs: 3_600_000, // the scripted clients never Ack
    log: serverLog,
    recordLog: log,
  });
  await session.start();
  const a = new ScriptedClient('A', 1);
  const b = new ScriptedClient('B', 2);
  const c = new ScriptedClient('C', 3);
  const z = new ScriptedClient('Z', 5);
  const clients = [a, b, c, z];
  const checkpoints: Checkpoint[] = [];
  a.connect(session);
  for (let tick = 1; tick <= TICKS; tick++) {
    if (tick === SKIPPED[0]) {
      session.skip(SKIPPED[1]);
      nowMs += (SKIPPED[1] * 1000) / game.tickRate;
      tick += SKIPPED[1];
    }
    if (tick === 40) b.connect(session);
    if (tick === 150) {
      z.connect(session);
      z.drop();
    }
    if (tick === 250) a.drop();
    if (tick === 310) a.connect(session);
    if (tick === 400) b.leave();
    if (tick === 430) c.connect(session);
    for (const client of clients) client.act(tick);
    session.step();
    if (tick % EVERY === 0) checkpoints.push([tick, session.world.hash()]);
    nowMs += 1000 / game.tickRate;
    await settle();
    for (const client of clients) client.receive();
  }
  return { log, checkpoints, session, lines };
}

describe('replay authoritative fault isolation', () => {
  it('rejects a mutating failed lifecycle and never resumes the partial run', async () => {
    const run = await createReplayRun(game, {
      regionLoader: new SandboxLoader(),
      hooks: sandboxHooks(),
    });
    run.lifecycle(0, join('Y'));
    await expect(run.step(1)).rejects.toMatchObject({ system: 'onPlayerJoin', phase: 'hook' });
    await expect(run.step(1)).rejects.toThrow('Y is not welcome');
  });
});

describe('a recorded live Session replays through createReplayRun', () => {
  let live: LiveRecording;

  beforeAll(async () => {
    live = await liveSession();
  }, 60_000);

  it('records the lifecycle and the consumed frames of joins, drops, a reconnect and leaves', () => {
    const { log, session } = live;
    expect(log.lifecycle).toEqual([
      [1, 0, join('A')],
      [3, 0, { type: 'spawn' }],
      [40, 1, join('B')],
      [41, 1, { type: 'spawn' }],
      [150, 2, { type: 'leave' }],
      [400, 1, { type: 'leave' }],
      [430, 1, join('C')],
      [431, 1, { type: 'spawn' }],
    ]);
    const framesOf = (player: number, from: number, to: number): InputLogEntry[] =>
      log.entries.filter(([tick, p]) => p === player && tick >= from && tick <= to);
    expect(framesOf(0, 1, 3)).toEqual([]);
    expect(framesOf(0, 4, 249).length).toBeGreaterThan(150); // the tick field changes every tick
    expect(framesOf(0, 250, 309)).toEqual([[250, 0, null]]); // away
    expect(framesOf(0, 310, 310)).toHaveLength(1); // the reconnected client's first frame
    expect(framesOf(1, 400, 431)).toEqual([[400, 1, null]]); // B left, C not yet playing
    expect(framesOf(2, 1, TICKS)).toEqual([]);
    expect(log.skips).toEqual([SKIPPED]);
    expect(framesOf(0, 200, 212)).toEqual([]); // none consumed: none ran
    expect(session.players().map((p) => p.displayName)).toEqual(['A', 'C']);
    expect(session.regions.active().length).toBeGreaterThanOrEqual(9);
    expect(problems(live.lines)).toEqual([]);
    expect(JSON.parse(JSON.stringify(log))).toEqual(log);
  });

  it('replays to identical checkpoints; without its lifecycle it fails at the first', async () => {
    const { log, checkpoints, session } = live;
    const { log: replayLog, lines } = collectingLog();
    const runs: GameReplayRun[] = [];
    expect(checkpoints).toHaveLength(TICKS / EVERY);
    expect(await replay(sandbox(replayLog, runs), log, checkpoints)).toEqual({ ok: true });
    const run = runs[0] as GameReplayRun;
    expect(run.hash()).toBe(session.world.hash());
    expect(run.session.players().map((p) => [p.playerId, p.displayName])).toEqual([
      [0, 'A'],
      [1, 'C'],
    ]);
    expect([...run.session.regions.active()]).toEqual([...session.regions.active()]);
    expect(problems(lines)).toEqual([]);

    expect(await replay(sandbox(replayLog), { ...log, lifecycle: [] }, checkpoints)).toMatchObject({
      ok: false,
      tick: EVERY,
    });
    // Without its skips the replay runs ticks the session never did: wrong from the next checkpoint.
    const { skips: _, ...unskipped } = log;
    expect(await replay(sandbox(replayLog), unskipped, checkpoints)).toMatchObject({
      ok: false,
      tick: 240,
    });
  }, 60_000);
});
