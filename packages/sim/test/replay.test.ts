import { Rng } from '@conduit/math';
import { defineInput, f, type Infer } from '@conduit/protocol';
import { describe, expect, it } from 'vitest';
import {
  type Checkpoint,
  CORE_COMPONENTS,
  defineComponent,
  defineSystem,
  type EntityId,
  type InputFrame,
  type InputLog,
  type InputLogEntry,
  type LifecycleEntry,
  type LifecycleEvent,
  MAX_PLAYERS,
  Owner,
  record,
  recordInputs,
  replay,
  type ReplayableGame,
  type ReplayRun,
  Simulation,
  type SkipEntry,
  World,
} from '../src/index.ts';
import { noRegions, noSpatial, registryOf } from './helpers.ts';

// A toy ReplayableGame: a player joins as an Owner entity, spawns a Body that its input moves, and
// leaves by destroying the entity. The world stream makes the state depend on the seed.

const InputFields = { tick: f.u32, dx: f.i8, boost: f.fixed16(0.01) };
const Input = defineInput(InputFields);
type Frame = Infer<typeof InputFields>;
const fr = (tick: number, dx = 0, boost = 0): Frame => ({ tick, dx, boost });

const Body = defineComponent('Body', { x: f.fixed32(0.001), z: f.fixed32(0.001), stamina: f.u16 });
const registry = registryOf([...CORE_COMPONENTS, Body], [], Input);

const move = defineSystem('move', 'sim', (ctx) => {
  const { world } = ctx;
  for (const e of world.query(Owner, Body)) {
    const frame = ctx.inputs(world.get(e, Owner).player) as Frame | undefined;
    const body = world.write(e, Body);
    if (frame === undefined) {
      body.stamina = Math.min(1000, body.stamina + 1);
      continue;
    }
    body.x += (frame.dx / 127) * (1 + frame.boost) * 5 * ctx.dt;
    body.z += (ctx.rng.float() - 0.5) * 0.1;
    body.stamina = Math.max(0, body.stamina - (Math.abs(frame.dx) % 3));
  }
});

class ToyRun implements ReplayRun {
  readonly world = new World(registry);
  readonly sim: Simulation;
  /** `setInput`/`lifecycle` calls in order, as `<kind>:<player>@<tick>`. */
  readonly calls: string[] = [];
  private readonly held: (InputFrame | undefined)[] = [];
  private readonly players: (EntityId | undefined)[] = [];
  private queued: [number, LifecycleEvent][] = [];

  constructor(seed: number, tickRate: number) {
    this.sim = new Simulation({
      world: this.world,
      seed,
      tickRate,
      regionRng: () => new Rng(seed),
      regions: noRegions,
      spatial: noSpatial,
    });
    this.sim.register(move);
  }

  setInput(player: number, frame: InputFrame | null): void {
    this.calls.push(`input:${player}@${this.world.tick + 1}`);
    this.held[player] = frame ?? undefined;
  }

  lifecycle(player: number, event: LifecycleEvent): void {
    this.calls.push(`${event.type}:${player}@${this.world.tick + 1}`);
    this.queued.push([player, event]);
  }

  skip(count: number): void {
    this.calls.push(`skip:${count}@${this.world.tick + 1}`);
    this.sim.skip(count);
  }

  async step(tick: number): Promise<void> {
    const { world } = this;
    for (const [player, event] of this.queued.splice(0)) {
      const e = this.players[player];
      if (event.type === 'join') {
        const created = world.create();
        world.add(created, Owner, { player });
        this.players[player] = created;
      } else if (event.type === 'spawn') {
        if (e !== undefined) world.add(e, Body, { stamina: 500 });
      } else {
        if (e !== undefined) world.destroy(e);
        this.players[player] = undefined;
        this.held[player] = undefined;
      }
    }
    for (let p = 0; p < MAX_PLAYERS; p++) this.sim.inputFrames[p] = this.held[p];
    this.sim.step(tick);
    await Promise.resolve();
  }

  hash(): number {
    return this.world.hash();
  }
}

function toyGame(): ReplayableGame & { runs: ToyRun[] } {
  const runs: ToyRun[] = [];
  return {
    runs,
    createRun(seed, tickRate) {
      const run = new ToyRun(seed, tickRate);
      runs.push(run);
      return Promise.resolve(run);
    },
  };
}

const join = (name: string): LifecycleEvent => ({
  type: 'join',
  accountId: `acct:${name}`,
  displayName: name,
});

/** 400 ticks: A and B from tick 1, C from tick 100, B leaves at 300; frames change now and then. */
function scriptedLog(): InputLog {
  const lifecycle: LifecycleEntry[] = [
    [1, 0, join('A')],
    [1, 1, join('B')],
    [2, 0, { type: 'spawn' }],
    [2, 1, { type: 'spawn' }],
    [100, 2, join('C')],
    [101, 2, { type: 'spawn' }],
    [300, 1, { type: 'leave' }],
  ];
  const rng = new Rng(0x1234);
  const entries: InputLogEntry[] = [];
  for (let tick = 1; tick <= 400; tick++) {
    for (let player = 0; player < 3; player++) {
      if (player === 2 && tick < 100) continue;
      if (player === 1 && tick >= 300) {
        if (tick === 300) entries.push([tick, player, null]);
        continue;
      }
      if (tick !== 1 && tick !== 400 && !rng.chance(0.3)) continue;
      entries.push([tick, player, fr(tick, rng.int(-127, 127), rng.int(0, 100) * 0.01)]);
    }
  }
  return { version: 1, seed: 99, tickRate: 30, entries, lifecycle };
}

function plainSim(maxPlayers = 2): Simulation {
  return new Simulation({
    world: new World(registry),
    seed: 1,
    regionRng: () => new Rng(1),
    regions: noRegions,
    spatial: noSpatial,
    maxPlayers,
  });
}

describe('record and replay', () => {
  it('record then replay on a toy game passes, with checkpoints through the last entry', async () => {
    const game = toyGame();
    const log = scriptedLog();
    const checkpoints = await record(game, log, 50);
    expect(checkpoints.map(([tick]) => tick)).toEqual([50, 100, 150, 200, 250, 300, 350, 400]);
    expect(new Set(checkpoints.map(([, hash]) => hash)).size).toBe(checkpoints.length);
    const run = game.runs[0] as ToyRun;
    expect(run.world.tick).toBe(400);
    expect(run.sim.ctx.dt).toBe(1 / 30); // the log's tick rate
    expect([...run.world.query(Owner)]).toHaveLength(2); // A and C; B left

    expect(await replay(game, log, checkpoints)).toEqual({ ok: true });
    expect(game.runs).toHaveLength(2);
    expect((game.runs[1] as ToyRun).world.tick).toBe(400);

    // record stops at the first multiple of `every` at or after the last tick.
    expect((await record(game, log, 150)).map(([tick]) => tick)).toEqual([150, 300, 450]);
    expect(await record(game, { ...log, entries: [], lifecycle: [] }, 10)).toEqual([]);
  });

  it('corrupting one input entry fails at the first checkpoint after it, with the right tick', async () => {
    const game = toyGame();
    const log = scriptedLog();
    const checkpoints = await record(game, log, 50);

    const corrupt = (tick: number): InputLog => {
      const copy = structuredClone(log);
      const entry = copy.entries.find(([at, player]) => at === tick && player === 0);
      if (entry === undefined) throw new Error(`no entry of player 0 at tick ${tick}`);
      const frame = entry[2] as Frame;
      frame.dx = frame.dx === 100 ? 101 : 100;
      return copy;
    };

    const at = log.entries.find(([tick, player]) => tick > 120 && tick < 150 && player === 0);
    expect(at).toBeDefined();
    const result = await replay(game, corrupt((at as InputLogEntry)[0]), checkpoints);
    expect(result).toEqual({
      ok: false,
      tick: 150,
      expected: (checkpoints[2] as Checkpoint)[1],
      actual: expect.any(Number),
    });
    if (result.ok) throw new Error('unreachable');
    expect(result.actual).not.toBe(result.expected);

    // An entry on a checkpoint tick fails at that tick; the original log still passes.
    expect(await replay(game, corrupt(400), checkpoints)).toMatchObject({ ok: false, tick: 400 });
    expect(await replay(game, log, checkpoints)).toEqual({ ok: true });

    // Another seed diverges at the first checkpoint.
    expect(await replay(game, { ...log, seed: 100 }, checkpoints)).toMatchObject({
      ok: false,
      tick: 50,
    });
  });

  it('replays past the log up to the last checkpoint, in checkpoint tick order', async () => {
    const game = toyGame();
    const log = scriptedLog();
    const checkpoints = await record(game, log, 50);
    const run = game.runs[0] as ToyRun;
    for (let tick = 401; tick <= 450; tick++) await run.step(tick);
    const late: Checkpoint = [450, run.hash()];
    expect(await replay(game, log, [late, ...checkpoints.slice().reverse()])).toEqual({ ok: true });
    expect((game.runs[1] as ToyRun).world.tick).toBe(450);
    expect(await replay(game, log, [[450, (late[1] + 1) >>> 0]])).toMatchObject({
      ok: false,
      tick: 450,
    });
  });

  it('feeds each tick lifecycle steps first, then frames, in log order', async () => {
    const game = toyGame();
    const log: InputLog = {
      version: 1,
      seed: 5,
      tickRate: 60,
      entries: [
        [1, 0, fr(1)],
        [2, 0, fr(2)],
        [2, 1, null],
      ],
      lifecycle: [
        [1, 1, join('B')],
        [1, 0, join('A')],
        [2, 1, { type: 'leave' }],
        [4, 0, { type: 'spawn' }],
      ],
    };
    expect(await record(game, log, 2)).toHaveLength(2);
    expect((game.runs[0] as ToyRun).calls).toEqual([
      'join:1@1',
      'join:0@1',
      'input:0@1',
      'leave:1@2',
      'input:0@2',
      'input:1@2',
      'spawn:0@4',
    ]);

    const withoutLifecycle: ReplayableGame = {
      createRun: () =>
        Promise.resolve({ setInput: () => {}, step: () => Promise.resolve(), hash: () => 0 }),
    };
    await expect(replay(withoutLifecycle, log, [])).rejects.toThrow(TypeError);
    await expect(record(withoutLifecycle, log, 1)).rejects.toThrow(TypeError);
    const inputsOnly = { ...log, lifecycle: [] };
    expect(await replay(withoutLifecycle, inputsOnly, [[2, 0]])).toEqual({ ok: true });
  });

  it('skips what the log skips: no step, no checkpoint; without its skips a log fails after them', async () => {
    const game = toyGame();
    const driver = (await game.createRun(7, 60)) as ToyRun;
    const lifecycle: LifecycleEntry[] = [];
    const skips: SkipEntry[] = [];
    const log: InputLog = { version: 1, seed: 7, tickRate: 60, entries: [], lifecycle, skips };
    recordInputs(driver.sim, log);
    const rng = new Rng(9);
    const checkpoints: Checkpoint[] = [];
    for (let tick = 1; tick <= 240; tick++) {
      if (tick === 1) {
        lifecycle.push([1, 0, join('A')]);
        driver.lifecycle(0, join('A'));
      }
      if (tick === 2) {
        lifecycle.push([2, 0, { type: 'spawn' }]);
        driver.lifecycle(0, { type: 'spawn' });
      }
      if (tick === 100) {
        // The session's loop fell behind and dropped thirteen ticks (docs/sim.md 2.10).
        skips.push([100, 13]);
        driver.skip(13);
        tick += 13;
      }
      if (rng.chance(0.4)) driver.setInput(0, fr(tick, rng.int(-127, 127)));
      await driver.step(tick);
      if (tick % 20 === 0) checkpoints.push([tick, driver.hash()]);
    }
    expect(checkpoints.map(([tick]) => tick)).not.toContain(100);
    expect(await replay(game, log, checkpoints)).toEqual({ ok: true });
    const replayed = game.runs.at(-1) as ToyRun;
    expect(replayed.calls).toContain('skip:13@100');
    expect(replayed.world.tick).toBe(240);
    const recorded = await record(game, log, 20);
    expect(recorded.length).toBeGreaterThan(5);
    expect(checkpoints.slice(0, recorded.length)).toEqual(recorded);
    const { skips: _, ...without } = log;
    expect(await replay(game, without, checkpoints)).toMatchObject({ ok: false, tick: 120 });
  });

  it('rejects skips out of shape, order or place; a run without skip() is a TypeError', async () => {
    const game = toyGame();
    const log: InputLog = {
      version: 1,
      seed: 1,
      tickRate: 60,
      entries: [
        [1, 0, fr(1)],
        [30, 0, fr(30)],
      ],
      lifecycle: [
        [1, 0, join('A')],
        [2, 0, { type: 'spawn' }],
      ],
    };
    const bad = (skips: unknown): InputLog => ({ ...log, skips }) as InputLog;
    for (const broken of [
      bad({}),
      bad([[0, 1]]),
      bad([[5, 0]]),
      bad([[5, 1.5]]),
      bad([[5]]),
      bad([
        [10, 3],
        [12, 1],
      ]),
      bad([
        [10, 1],
        [5, 1],
      ]),
      bad([[29, 2]]), // over an entry
      bad([[2, 1]]), // over a lifecycle step
    ]) {
      await expect(record(game, broken, 10)).rejects.toThrow(RangeError);
      await expect(replay(game, broken, [])).rejects.toThrow(RangeError);
    }
    await expect(replay(game, { ...log, skips: [[5, 3]] }, [[6, 0]])).rejects.toThrow(RangeError);
    expect(game.runs).toHaveLength(0); // validation happens before a run is created
    // Skips one after another, and one at the end of the log.
    const fine: InputLog = {
      ...log,
      skips: [
        [5, 3],
        [8, 2],
        [31, 4],
      ],
    };
    const checkpoints = await record(game, fine, 10);
    expect(checkpoints.map(([tick]) => tick)).toEqual([10, 20, 30, 40]);
    expect(await replay(game, fine, checkpoints)).toEqual({ ok: true });
    const bare: ReplayableGame = {
      createRun(seed, tickRate) {
        const run = new ToyRun(seed, tickRate);
        return Promise.resolve({
          setInput: (player: number, frame: InputFrame | null) => run.setInput(player, frame),
          lifecycle: (player: number, event: LifecycleEvent) => run.lifecycle(player, event),
          step: (tick: number) => run.step(tick),
          hash: () => run.hash(),
        });
      },
    };
    await expect(record(bare, fine, 10)).rejects.toThrow(TypeError);
    await expect(replay(bare, fine, checkpoints)).rejects.toThrow(TypeError);
  });

  it('rejects malformed logs, checkpoints and intervals with RangeError', async () => {
    const game = toyGame();
    const log = scriptedLog();
    const bad = (patch: Partial<Record<keyof InputLog, unknown>>): InputLog =>
      ({ ...log, ...patch }) as InputLog;
    for (const broken of [
      bad({ version: 2 }),
      bad({ seed: -1 }),
      bad({ seed: 2 ** 32 }),
      bad({ tickRate: 0 }),
      bad({ entries: {} }),
      bad({ entries: [[0, 0, null]] }),
      bad({ entries: [[1, -1, null]] }),
      bad({ entries: [[1, 0, 5]] }),
      bad({ entries: [[1, 0]] }),
      bad({
        entries: [
          [2, 0, null],
          [1, 0, null],
        ],
      }),
      bad({
        entries: [
          [1, 1, null],
          [1, 0, null],
        ],
      }),
      bad({ lifecycle: [[1, 0, { type: 'dance' }]] }),
      bad({ lifecycle: [[1, 0, { type: 'join', displayName: 'A' }]] }),
      bad({
        lifecycle: [
          [3, 0, { type: 'spawn' }],
          [2, 0, { type: 'leave' }],
        ],
      }),
    ]) {
      await expect(replay(game, broken, [])).rejects.toThrow(RangeError);
      await expect(record(game, broken, 10)).rejects.toThrow(RangeError);
    }
    await expect(replay(game, log, [[0, 1]])).rejects.toThrow(RangeError);
    await expect(replay(game, log, [[1.5, 1]])).rejects.toThrow(RangeError);
    await expect(replay(game, log, [[1, '1']] as unknown as Checkpoint[])).rejects.toThrow(
      RangeError,
    );
    await expect(record(game, log, 0)).rejects.toThrow(RangeError);
    await expect(record(game, log, 2.5)).rejects.toThrow(RangeError);
    expect(game.runs).toHaveLength(0); // validation happens before a run is created
    // A log survives JSON.
    const checkpoints = await record(game, log, 100);
    const parsed = JSON.parse(JSON.stringify(log)) as InputLog;
    expect(await replay(game, parsed, checkpoints)).toEqual({ ok: true });
  });
});

describe('recordInputs', () => {
  it('records what each step consumes: changes only, null when a frame goes away, quantized copies', () => {
    const sim = plainSim();
    const log: InputLog = { version: 1, seed: 1, tickRate: 60, entries: [] };
    recordInputs(sim, log);

    const a: Frame = { tick: 1, dx: 5, boost: 0.014 };
    sim.inputFrames[0] = a;
    sim.step(1); // new frame
    sim.step(2); // held: nothing
    sim.inputFrames[0] = { ...a }; // same bytes: nothing
    sim.inputFrames[1] = fr(3, -1, 0);
    sim.step(3);
    a.dx = 6; // the same object, changed
    sim.inputFrames[0] = a;
    sim.step(4);
    sim.inputFrames[0] = undefined;
    sim.step(5); // gone
    sim.step(6); // still gone: nothing
    sim.inputFrames[0] = fr(7, 6, 0.01);
    sim.inputFrames[1] = fr(3, -1, 0.001); // quantizes to the recorded frame
    sim.step(7);
    a.dx = 100;

    expect(log.entries).toEqual([
      [1, 0, { tick: 1, dx: 5, boost: 0.01 }],
      [3, 1, { tick: 3, dx: -1, boost: 0 }],
      [4, 0, { tick: 1, dx: 6, boost: 0.01 }],
      [5, 0, null],
      [7, 0, { tick: 7, dx: 6, boost: 0.01 }],
    ]);
    expect(log.entries[0]?.[2]).not.toBe(a);
  });

  it('keeps the entries sorted by tick, then player, when reported out of order', () => {
    const sim = plainSim();
    const log: InputLog = { version: 1, seed: 1, tickRate: 60, entries: [] };
    recordInputs(sim, log);
    const hook = sim.onInputsPlaced as NonNullable<Simulation['onInputsPlaced']>;
    hook(2, 1, fr(2));
    hook(2, 0, fr(2));
    hook(1, 0, fr(1)); // new bytes for player 0
    hook(3, 1, undefined);
    expect(log.entries.map(([tick, player]) => `${tick}/${player}`)).toEqual([
      '1/0',
      '2/0',
      '2/1',
      '3/1',
    ]);
  });

  it('chains an installed hook; uninstall stops recording and restores it', () => {
    const sim = plainSim(1);
    const seen: string[] = [];
    const earlier = (tick: number, player: number): void => {
      seen.push(`${tick}:${player}`);
    };
    sim.onInputsPlaced = earlier;
    const log: InputLog = { version: 1, seed: 1, tickRate: 60, entries: [] };
    const stop = recordInputs(sim, log);
    sim.inputFrames[0] = fr(1);
    sim.step(1);
    expect(seen).toEqual(['1:0']);
    expect(log.entries).toHaveLength(1);
    stop();
    stop();
    expect(sim.onInputsPlaced).toBe(earlier);
    sim.inputFrames[0] = fr(2);
    sim.step(2);
    expect(seen).toEqual(['1:0', '2:0']);
    expect(log.entries).toHaveLength(1);

    // Uninstalling a recorder that is no longer the installed hook only stops it.
    const first: InputLog = { version: 1, seed: 1, tickRate: 60, entries: [] };
    const second: InputLog = { version: 1, seed: 1, tickRate: 60, entries: [] };
    const stopFirst = recordInputs(sim, first);
    const stopSecond = recordInputs(sim, second);
    const installed = sim.onInputsPlaced;
    stopFirst();
    expect(sim.onInputsPlaced).toBe(installed);
    sim.inputFrames[0] = fr(3);
    sim.step(3);
    expect(first.entries).toEqual([]);
    expect(second.entries).toEqual([[3, 0, fr(3)]]);
    expect(seen.at(-1)).toBe('3:0');
    stopSecond();
    expect(sim.onInputsPlaced).not.toBe(installed);
  });

  it('a log recorded while a driver plays replays to the driver hashes', async () => {
    const game = toyGame();
    const driver = (await game.createRun(7, 60)) as ToyRun;
    const lifecycle: LifecycleEntry[] = [];
    const log: InputLog = { version: 1, seed: 7, tickRate: 60, entries: [], lifecycle };
    recordInputs(driver.sim, log);
    const rng = new Rng(5);
    const checkpoints: Checkpoint[] = [];
    const step = (tick: number, player: number, event: LifecycleEvent): void => {
      lifecycle.push([tick, player, event]);
      driver.lifecycle(player, event);
    };
    for (let tick = 1; tick <= 300; tick++) {
      if (tick === 1) {
        step(tick, 0, join('A'));
        step(tick, 1, join('B'));
      }
      if (tick === 3) {
        step(tick, 0, { type: 'spawn' });
        step(tick, 1, { type: 'spawn' });
      }
      if (tick === 200) step(tick, 1, { type: 'leave' });
      for (let player = 0; player < 2; player++) {
        const roll = rng.float();
        if (roll < 0.5) continue; // held
        if (roll < 0.6) driver.setInput(player, null);
        else driver.setInput(player, fr(tick, rng.int(-127, 127), rng.int(0, 50) * 0.01));
      }
      await driver.step(tick);
      if (tick % 25 === 0) checkpoints.push([tick, driver.hash()]);
    }
    expect(log.entries.filter(([, , frame]) => frame === null).length).toBeGreaterThan(5);
    expect(log.entries.length).toBeLessThan(2 * 300 * 0.6);
    expect(await replay(game, log, checkpoints)).toEqual({ ok: true });
  });
});
