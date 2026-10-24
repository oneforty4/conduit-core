import { fnv1a32, Rng, TAU } from '@conduit/math';
import { defineInput, f, type Infer } from '@conduit/protocol';
import { describe, expect, it } from 'vitest';
import {
  CORE_COMPONENTS,
  defineComponent,
  defineEvent,
  defineSystem,
  type EntityId,
  Owner,
  Region,
  RegionChanged,
  type RegionId,
  type ReplicatedEvent,
  type SimContext,
  Simulation,
  Transform,
  World,
} from '../src/index.ts';
import { noRegions, noSpatial, registryOf } from './helpers.ts';

// A toy game exercising inputs, both RNG streams, create/destroy with slot reuse, queries,
// replicated and local events, a non-replicated store and a postSim tail.

const InputFields = { tick: f.u32, throttle: f.i8, steer: f.i8, buttons: f.u8 };
const Input = defineInput(InputFields);
type Frame = Infer<typeof InputFields>;

const Mover = defineComponent('Mover', { heading: f.angle16(), speed: f.fixed16(0.01) });
const Life = defineComponent('Life', { ttl: f.u16 });
const Score = defineComponent('Score', { points: f.u32, hits: f.u16 });
const Memo = defineComponent('Memo', { seen: f.u32 }, { replicate: false });
const Spawned = defineEvent('Spawned', { entity: f.entity(), kind: f.u8 });
const Hit = defineEvent('Hit', { player: f.u8, target: f.entity() }, { replicate: false });

const registry = registryOf(
  [...CORE_COMPONENTS, Mover, Life, Score, Memo],
  [Spawned, Hit, RegionChanged],
  Input,
);

const REGIONS: readonly RegionId[] = ['cell/0_0', 'cell/0_1', 'cell/1_0'];
const REGION_SIZE = 64;
const PLAYERS = 3;
const TICKS = 600;
const FIRE = 1;

// Per-tick scratch, reset by queryInto at the start of each use.
const scratch: EntityId[] = [];
const players: EntityId[] = [];

function spawnMover(ctx: SimContext, region: RegionId, kind: number, ttl: number): EntityId {
  const { world } = ctx;
  const regionRng = ctx.regionRng(region);
  const e = world.create();
  world.add(e, Region, { id: region });
  world.add(e, Transform, {
    pos: { x: regionRng.float() * REGION_SIZE, y: 0, z: regionRng.float() * REGION_SIZE },
  });
  world.add(e, Mover, { heading: ctx.rng.float() * TAU, speed: 1 + ctx.rng.float() * 9 });
  world.add(e, Life, { ttl });
  ctx.events.emit(Spawned, { entity: e, kind }, region);
  return e;
}

const playerInput = defineSystem('playerInput', 'input', (ctx) => {
  const { world } = ctx;
  for (const e of world.queryInto(scratch, Owner, Mover, Transform)) {
    const frame = ctx.inputs(world.get(e, Owner).player) as Frame | undefined;
    if (frame === undefined) continue;
    const mover = world.write(e, Mover);
    mover.speed = (frame.throttle / 127) * 20;
    mover.heading += (frame.steer / 127) * 1.5 * ctx.dt;
    if ((frame.buttons & FIRE) !== 0) {
      const shot = spawnMover(ctx, world.get(e, Region).id, 1, 20 + ctx.rng.int(0, 20));
      world.write(shot, Transform).pos = { ...world.get(e, Transform).pos };
    }
  }
});

const spawner = defineSystem('spawner', 'preSim', (ctx) => {
  if (ctx.tick % 5 !== 1) return;
  const region = ctx.rng.pick(REGIONS) as RegionId;
  spawnMover(ctx, region, 0, ctx.rng.int(20, 120));
});

const integrate = defineSystem('integrate', 'sim', (ctx) => {
  const { world, dt } = ctx;
  for (const e of world.query(Transform, Mover)) {
    const { heading, speed } = world.get(e, Mover);
    const t = world.write(e, Transform);
    t.vel.x = Math.cos(heading) * speed;
    t.vel.z = Math.sin(heading) * speed;
    t.pos.x += t.vel.x * dt;
    t.pos.z += t.vel.z * dt;
  }
});

const collide = defineSystem('collide', 'sim', (ctx) => {
  const { world } = ctx;
  for (const p of world.queryInto(scratch, Owner, Transform)) {
    const pos = world.get(p, Transform).pos;
    const region = world.get(p, Region).id;
    for (const e of world.query(Life, Transform)) {
      if (world.get(e, Region).id !== region) continue;
      const q = world.get(e, Transform).pos;
      if ((q.x - pos.x) ** 2 + (q.z - pos.z) ** 2 < 36) {
        ctx.events.emit(Hit, { player: world.get(p, Owner).player, target: e });
      }
    }
  }
});

const reaper = defineSystem('reaper', 'postSim', (ctx) => {
  const { world } = ctx;
  for (const hit of ctx.events.consume(Hit)) {
    const target = hit.payload.target;
    if (world.alive(target) && world.destroyedThisTick().indexOf(target) < 0) {
      world.destroy(target);
      const score = world.write(players[hit.payload.player]!, Score);
      score.hits++;
      score.points += world.get(target, Life).ttl;
    }
  }
  for (const e of world.queryInto(scratch, Life)) {
    const life = world.write(e, Life);
    life.ttl = Math.max(0, life.ttl - 1);
    if (life.ttl === 0 || ctx.rng.chance(0.003)) world.destroy(e);
  }
  const memo = world.write(players[0]!, Memo);
  memo.seen += ctx.events.consume(Spawned).length;
});

/** Stands in for the membership system: moves entities that left their region to the next one. */
function membership(ctx: SimContext): void {
  const { world } = ctx;
  for (const e of world.queryInto(scratch, Region, Transform)) {
    const t = world.get(e, Transform);
    if (t.pos.x >= 0 && t.pos.x < REGION_SIZE && t.pos.z >= 0 && t.pos.z < REGION_SIZE) continue;
    const from = world.get(e, Region).id;
    const to = REGIONS[(REGIONS.indexOf(from) + 1) % REGIONS.length] as RegionId;
    const pos = world.write(e, Transform).pos;
    pos.x = ((pos.x % REGION_SIZE) + REGION_SIZE) % REGION_SIZE;
    pos.z = ((pos.z % REGION_SIZE) + REGION_SIZE) % REGION_SIZE;
    world.write(e, Region).id = to;
    ctx.events.emit(RegionChanged, { entity: e, from, to }, from);
  }
}

type LogEntry = [tick: number, player: number, frame: Frame];

function scriptedLog(seed: number): LogEntry[] {
  const rng = new Rng(seed);
  const entries: LogEntry[] = [];
  for (let tick = 1; tick <= TICKS; tick++) {
    for (let player = 0; player < PLAYERS; player++) {
      if (!rng.chance(0.12)) continue;
      entries.push([
        tick,
        player,
        {
          tick,
          throttle: rng.int(-127, 127),
          steer: rng.int(-127, 127),
          buttons: rng.chance(0.25) ? FIRE : 0,
        },
      ]);
    }
  }
  return entries;
}

interface RunResult {
  world: World;
  hashes: number[];
  events: ReplicatedEvent[];
  maxAlive: number;
}

function run(seed: number, log: readonly LogEntry[]): RunResult {
  const world = new World(registry);
  const streams = new Map<RegionId, Rng>(); // lookup only
  const sim = new Simulation({
    world,
    seed,
    regionRng: (id) => {
      let rng = streams.get(id);
      if (rng === undefined) streams.set(id, (rng = new Rng(fnv1a32(id, seed))));
      return rng;
    },
    regions: noRegions,
    spatial: noSpatial,
  });
  for (const system of [reaper, integrate, playerInput, collide, spawner]) sim.register(system);
  sim.tail.push(membership);

  players.length = 0;
  for (let p = 0; p < PLAYERS; p++) {
    const e = world.create();
    world.add(e, Owner, { player: p });
    world.add(e, Region, { id: REGIONS[p % REGIONS.length]! });
    world.add(e, Transform, { pos: { x: 16 + p * 8, y: 0, z: 32 } });
    world.add(e, Mover);
    world.add(e, Score);
    world.add(e, Memo);
    players.push(e);
  }

  const result: RunResult = { world, hashes: [], events: [], maxAlive: 0 };
  let next = 0;
  for (let tick = 1; tick <= TICKS; tick++) {
    while (next < log.length && log[next]![0] === tick) {
      const [, player, frame] = log[next++]!;
      sim.inputFrames[player] = { ...frame };
    }
    sim.step(tick);
    result.maxAlive = Math.max(result.maxAlive, world.count());
    result.events.push(...sim.events.drainOutbox());
    result.hashes.push(world.hash());
  }
  return result;
}

describe('determinism', () => {
  const log = scriptedLog(0xdecade);

  it('two Simulations with the same seed and input log hash identically every tick', () => {
    const a = run(1234, log);
    const b = run(1234, log);
    expect(log.length).toBeGreaterThan(100);
    expect(a.hashes).toHaveLength(TICKS);
    expect(b.hashes).toEqual(a.hashes);
    expect(b.events).toEqual(a.events);

    // The scenario is not trivial: state changes, entities churn and slots are reused.
    expect(new Set(a.hashes).size).toBeGreaterThan(TICKS / 2);
    expect(a.events.length).toBeGreaterThan(100);
    const spawnedIds = a.events.map((ev) => (ev.payload as { entity: EntityId }).entity);
    expect(new Set(spawnedIds).size).toBe(spawnedIds.length);
    expect(Math.max(...spawnedIds.map((e) => e & 0xfffff))).toBeLessThan(spawnedIds.length);
    expect(a.world.get(players[0]!, Memo).seen).toBeGreaterThan(0);
    expect(a.maxAlive).toBeGreaterThan(PLAYERS + 5);
  });

  it('a different seed diverges by tick 2', () => {
    const a = run(1234, log);
    const c = run(1235, log);
    expect(c.hashes.slice(0, 2)).not.toEqual(a.hashes.slice(0, 2));
    expect(c.hashes).not.toEqual(a.hashes);
  });

  it('a store mutated through write changes the hash and read does not', () => {
    const { world } = run(99, log);
    const e = [...world.query(Life, Transform)][0]!;
    const h = world.hash();
    const tick = world.tick;
    const store = world.store(Transform);
    const x =
      store.read(e).pos.x + world.get(e, Transform).pos.x + world.tryGet(e, Transform)!.pos.x;
    expect(Number.isFinite(x)).toBe(true);
    expect([...world.query(Transform)]).toContain(e);
    expect(world.hash()).toBe(h);
    world.write(e, Transform).pos.y += 1;
    expect(store.version[e & 0xfffff]).toBe(tick + 1); // between steps: the coming tick
    expect(world.hash()).not.toBe(h);
  });
});
