/// <reference lib="dom" />
import { devVerifier } from '@conduit/auth';
import { Session, executionStateOfCheckpoint } from '@conduit/net-server';
import { MemoryStore } from '@conduit/persist';
import { defineInput, f, PlayerState } from '@conduit/protocol';
import {
  type Checkpoint,
  createCommandJournal,
  defineComponent,
  defineSystem,
  firstStateDifference,
  type InputLog,
  replay,
  type ReplayableGame,
} from '@conduit/sim';
import { GridWorld, type RegionId, type RegionLoader } from '@conduit/world';
import { beforeAll, describe, expect, it } from 'vitest';
import { FakeLink } from '../../net-server/test/fake-link.ts';
import { TestClient, payloadOf } from '../../net-server/test/harness.ts';
import { defineGame, Owner, Region, Transform } from '../src/index.ts';
import { createJournalReplayRun, createReplayRun, type GameReplayRun } from '../src/replayRun.ts';
import { adaptHooks } from '../src/serverContext.ts';
import type { ServerHooks } from '../src/types.ts';

// ServerHooks.simulationInterest under replay (docs/game.md 2): a drone no player is near flies
// along row 0 of an 8 x 3 grid, kept simulated by the regions the hook names. A live Session
// records it; createReplayRun (input log) and createJournalReplayRun (command journal) reproduce
// the interest-driven loads, activations, crossings and evictions.

const COLS = 8;
const CELL = 64;
const TICKS = 900;
const EVERY = 60;
/** The interest region the drone launches from, wanted until the drone exists or tick 60. */
const PAD = 'cell/0_0';
/** The player spawns far from the drone's path: its neighbourhood is columns 6-7 of rows 1-2. */
const PLAYER_REGION = 'cell/7_2';

const Drone = defineComponent('InterestDrone', { n: f.u8 }, { persist: true });
/** One per fresh region, placed from the region's stream: region activations change the hash. */
const Rock = defineComponent('InterestRock', { size: f.u8 }, { persist: true });
const Input = defineInput({ tick: f.u32 });

const game = defineGame({
  id: 'interest-game',
  name: 'Interest game',
  protocolVersion: 3,
  compatibility: { simulationRevision: 'interest-v1', gameplayDigests: { rules: 'drone-v1' } },
  seed: 0x1d7e,
  tickRate: 60,
  snapshotEvery: 3,
  components: [Drone, Rock],
  messages: [],
  events: [],
  input: Input,
  systems: [
    defineSystem('drone-flight', 'sim', (ctx) => {
      for (const e of ctx.world.query(Drone, Transform)) {
        const t = ctx.world.write(e, Transform);
        t.pos.x += t.vel.x;
      }
    }),
  ],
  world: (seed) =>
    new GridWorld({ cellSize: CELL, cols: COLS, rows: 3, wantedDepth: 1, worldSeed: seed }),
});

function loader(): RegionLoader {
  return {
    populate(region, blob, ctx) {
      if (blob !== null) return;
      const rng = ctx.regionRng(region.id);
      const rock = ctx.world.create();
      ctx.world.add(rock, Region, { id: region.id });
      ctx.world.add(rock, Transform, { pos: { x: rng.int(1, CELL - 1), y: 0, z: 8 } });
      ctx.world.add(rock, Rock, { size: rng.int(1, 9) });
      if (region.id !== PAD) return;
      const drone = ctx.world.create();
      ctx.world.add(drone, Region, { id: PAD });
      ctx.world.add(drone, Transform, { pos: { x: 10, y: 0, z: 32 }, vel: { x: 0.5, y: 0, z: 0 } });
      ctx.world.add(drone, Drone, { n: 1 });
    },
  };
}

/**
 * The drone's region and the next one along its path; the launch pad while no drone exists (only
 * during the first second). A deterministic function of simulation state.
 */
function droneInterest(ctx: Parameters<NonNullable<ServerHooks['simulationInterest']>>[0]) {
  const out: RegionId[] = [];
  for (const e of ctx.world.query(Drone, Region)) {
    const id = ctx.world.get(e, Region).id;
    const [col, row] = id.slice('cell/'.length).split('_').map(Number) as [number, number];
    out.push(id);
    if (col + 1 < COLS) out.push(`cell/${col + 1}_${row}`);
  }
  if (out.length === 0 && ctx.tick < 60) out.push(PAD);
  return out;
}

function hooks(interest = true): ServerHooks<ReturnType<typeof Input.create>> {
  return {
    onPlayerJoin: (player) => ({
      regionId: PLAYER_REGION,
      spawn(ctx) {
        const e = ctx.world.create();
        ctx.world.add(e, Region, { id: PLAYER_REGION });
        ctx.world.add(e, Transform, { pos: { x: 32, y: 0, z: 32 } });
        ctx.world.add(e, Owner, { player: player.playerId });
        return e;
      },
    }),
    ...(interest ? { simulationInterest: droneInterest } : {}),
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function replayable(interest = true, runs: GameReplayRun[] = []): ReplayableGame {
  return {
    async createRun(seed, tickRate) {
      const run = await createReplayRun(game, {
        regionLoader: loader(),
        hooks: hooks(interest),
        seed,
        tickRate,
      });
      runs.push(run);
      return run;
    },
  };
}

describe('simulation interest replays', () => {
  const log: InputLog = { version: 1, seed: game.seed, tickRate: game.tickRate, entries: [] };
  const journal = createCommandJournal({
    compatibility: game.compatibility,
    stateSchemaHash: game.registry.stateSchemaHash,
    capacity: 8,
    tickRate: game.tickRate,
    seed: game.seed,
    sessionEpoch: 'interest-epoch',
  });
  const checkpoints: Checkpoint[] = [];
  const crossings: { tick: number; region: RegionId }[] = [];
  let session: Session;

  beforeAll(async () => {
    session = new Session(game, {
      store: new MemoryStore(),
      regionLoader: loader(),
      hooks: adaptHooks(hooks(), game),
      verifier: devVerifier({ warn() {} }),
      sessionId: 'dev',
      manualLoop: true,
      ackTimeoutMs: 3_600_000, // the client never Acks
      recordLog: log,
      journal,
    });
    await session.start();
    const client = new TestClient(game.registry, new FakeLink(1));
    session.attach(client.link);
    client.hello({ compatibility: game.compatibility });
    let drone: number | undefined;
    for (let tick = 1; tick <= TICKS; tick++) {
      session.step();
      if (session.fault !== null) throw session.fault;
      if (tick % EVERY === 0) checkpoints.push([tick, session.world.hash()]);
      await settle();
      const got = client.take();
      if (got.some((m) => m.name === 'Welcome')) client.ready();
      if (got.some((m) => m.name === 'RegionSet')) {
        client.regionLoadState(payloadOf<{ active: string[] }>(got, 'RegionSet').active);
      }
      drone ??= [...session.world.query(Drone)][0];
      const region = drone === undefined ? undefined : session.regions.regionOf(drone);
      if (region !== undefined && region !== crossings.at(-1)?.region) {
        crossings.push({ tick, region });
      }
    }
  }, 60_000);

  it('the live session simulates the drone through regions only the hook keeps', () => {
    expect(session.players()).toMatchObject([{ playerId: 0, state: PlayerState.Playing }]);
    expect(crossings.map((c) => c.region)).toEqual(
      Array.from({ length: COLS }, (_, col) => `cell/${col}_0`),
    );
    expect(crossings[0]?.tick).toBe(2); // the pad activates at tick 2's update
    const drone = [...session.world.query(Drone)][0] as number;
    expect(session.world.get(drone, Transform).pos.x).toBe(10 + 0.5 * (TICKS - 1) - 7 * CELL);
    // The pad and the first column were left more than LINGER_MS (600 ticks) ago: saved and
    // evicted. The columns left since linger; the drone's region is wanted, as are the player's.
    expect(session.regions.state(PAD)).toBe('inactive');
    expect(session.regions.state('cell/1_0')).toBe('inactive');
    expect([...session.regions.active()]).toEqual([
      'cell/2_0',
      'cell/3_0',
      'cell/4_0',
      'cell/5_0',
      'cell/6_0',
      'cell/6_1',
      'cell/6_2',
      'cell/7_0',
      'cell/7_1',
      'cell/7_2',
    ]);
    for (const col of [2, 3, 4, 5, 6])
      expect(session.regions.lingering(`cell/${col}_0`)).toBe(true);
    expect(session.regions.lingering('cell/7_0')).toBe(false);
    expect(session.regions.state('cell/1_1')).toBe('inactive'); // interest is exact
    expect(new Set(checkpoints.map(([, hash]) => hash)).size).toBe(checkpoints.length);
  });

  it('replays from the input log through createReplayRun to identical checkpoints; without the hook it fails at the first', async () => {
    const runs: GameReplayRun[] = [];
    expect(await replay(replayable(true, runs), log, checkpoints)).toEqual({ ok: true });
    const run = runs[0] as GameReplayRun;
    expect(run.hash()).toBe(session.world.hash());
    expect([...run.session.regions.active()]).toEqual([...session.regions.active()]);
    expect(await replay(replayable(false), log, checkpoints)).toMatchObject({
      ok: false,
      tick: EVERY,
    });
  }, 60_000);

  it('replays from the command journal through createJournalReplayRun to the same state', async () => {
    const expected = executionStateOfCheckpoint(session.captureCheckpoint());
    const run = await createJournalReplayRun(game, journal, {
      regionLoader: loader(),
      hooks: () => hooks(),
    });
    for (const tick of journal.ticks) {
      if (tick.tick > run.session.tick + 1) run.skip(tick.tick - run.session.tick - 1);
      for (const entry of tick.records) run.apply(entry.action);
      await run.step(tick.tick);
    }
    expect(run.session.tick).toBe(TICKS);
    expect(firstStateDifference(expected, run.capture())).toBeNull();
    expect([...run.session.regions.active()]).toEqual([...session.regions.active()]);
    run.dispose();

    // Without the hook no drone or rock exists, so the player's entity id differs from the
    // recorded one: the replay rejects the journal instead of silently diverging.
    const without = await createJournalReplayRun(game, journal, {
      regionLoader: loader(),
      hooks: () => hooks(false),
    });
    const replayAll = async (): Promise<void> => {
      for (const tick of journal.ticks) {
        for (const entry of tick.records) without.apply(entry.action);
        await without.step(tick.tick);
      }
    };
    await expect(replayAll()).rejects.toThrow('Recorded connection entity differs');
    expect([...without.session.world.query(Drone)]).toEqual([]);
    without.dispose();
  }, 60_000);

  it('validates the interest the same way: an invalid result faults the replay step', async () => {
    const run = await createReplayRun(game, {
      regionLoader: loader(),
      hooks: { ...hooks(), simulationInterest: () => [PAD, 'cell/1_0', 'cell/2_0'] },
      maxSimulationInterestRegions: 2,
    });
    await expect(run.step(1)).rejects.toMatchObject({
      tick: 1,
      system: 'simulationInterest',
      phase: 'hook',
    });
    expect(run.session.regions.state(PAD)).toBe('inactive');
    await expect(
      createReplayRun(game, {
        regionLoader: loader(),
        hooks: hooks(),
        maxSimulationInterestRegions: -1,
      }),
    ).rejects.toThrow(RangeError);
  });
});
