// @conduit/net-client is isomorphic and its sources name DOM event types; type-checking them
// from this Node package needs the DOM lib.
/// <reference lib="dom" />
import { MessageChannel } from 'node:worker_threads';
import { ReplicaWorld } from '@conduit/net-client';
import { MemoryStore, openApplicationSave } from '@conduit/persist';
import {
  CoreKind,
  ENTITY_NONE,
  type EntityId,
  HelloSchema,
  type RegionSetPayload,
  type Schema,
  type SnapshotData,
} from '@conduit/protocol';
import {
  defineSystem,
  type InputLog,
  Owner,
  type Phase,
  PHASES,
  Region,
  type SimContext,
  type System,
  Transform,
} from '@conduit/sim';
import { SpatialIndex, stringCompare } from '@conduit/world';
import { describe, expect, it, vi } from 'vitest';
import { PortLink } from '../src/port-link.ts';
import type { HookContext, PlayerInfo, PlayerSpawn, SessionSpatial } from '../src/session.ts';
import { Session } from '../src/session.ts';
import { LatenessHistogram } from '../src/stats.ts';
import { FakeLink } from './fake-link.ts';
import {
  CELL,
  Crate,
  crateLoader,
  createHarness,
  defaultHooks,
  FakeClock,
  type Harness,
  joinAndSpawn,
  payloadOf,
  type ReceivedMessage,
  Shout,
  snapshotsOf,
  SPAWN_REGION,
  spawnPlayer,
  TestClient,
  testGame,
} from './harness.ts';

const HELLO_SCHEMA = HelloSchema as Schema<unknown>;
const HELLO = { protocolVersion: 3, sessionToken: '', reconnectToken: '' };

type Probe = { order: string[]; systems: System[] };

function probes(): Probe {
  const order: string[] = [];
  const systems = PHASES.map((phase: Phase) =>
    defineSystem(`probe-${phase}`, phase, (ctx) => {
      const frame = ctx.inputs(0) as { tick: number } | undefined;
      order.push(phase === 'input' ? `input(frame ${frame?.tick})` : phase);
    }),
  );
  return { order, systems };
}

describe('the tick pipeline (docs/sim.md 2.9)', () => {
  it('runs lifecycle, input, regions.update, phases, membership, spatial.rebuild, drainOutbox, snapshot', async () => {
    const { order, systems } = probes();
    const h = await createHarness({ systems });
    const a = h.client();
    await joinAndSpawn(h, a);
    await h.step(3);
    a.take();

    const { session } = h;
    const regions = session.regions;
    const update = regions.update.bind(regions);
    vi.spyOn(regions, 'update').mockImplementation((...args) => {
      order.push('regions.update');
      update(...args);
    });
    const membership = regions.membershipSystem;
    (regions as { membershipSystem: System }).membershipSystem = {
      ...membership,
      run: (ctx: SimContext) => {
        order.push('membership');
        membership.run(ctx);
      },
    };
    vi.spyOn(session.spatial, 'rebuild').mockImplementation(() => order.push('spatial.rebuild'));
    const drain = session.simulation.events.drainOutbox.bind(session.simulation.events);
    const drainSpy = vi
      .spyOn(session.simulation.events, 'drainOutbox')
      .mockImplementation(() => (order.push('drainOutbox'), drain()));
    const send = a.link.send.bind(a.link);
    vi.spyOn(a.link, 'send').mockImplementation((buf) => {
      order.push('send');
      send(buf);
    });
    h.hooks.onPlayerJoin.mockImplementation((player: PlayerInfo): PlayerSpawn => {
      order.push('lifecycle join');
      return { regionId: SPAWN_REGION, spawn: (ctx) => spawnPlayer(player, ctx) };
    });

    // Line up the next tick as a snapshot tick with a queued join and an input frame for it.
    while ((session.tick + 1) % 3 !== 0) await h.step();
    h.client().hello({ displayName: 'late' });
    const t = session.tick + 1;
    a.input([t]);
    order.length = 0;
    const calls = drainSpy.mock.calls.length;
    await h.step();

    expect(order).toEqual([
      'lifecycle join',
      'regions.update',
      `input(frame ${t})`,
      'preSim',
      'sim',
      'postSim',
      'membership',
      'spatial.rebuild',
      'drainOutbox',
      'send',
    ]);
    expect(drainSpy.mock.calls.length - calls).toBe(1);
    order.length = 0;
    await h.step();
    expect(order.filter((o) => o === 'drainOutbox')).toHaveLength(1);
    expect(order).not.toContain('send'); // not a snapshot tick
  });

  it('applies destroys before the snapshot: an entity destroyed in sim at T is a destroy at T', async () => {
    let victim: number | undefined;
    const destroyer = defineSystem('destroyer', 'sim', (ctx) => {
      if (victim !== undefined && ctx.tick % 3 === 0) {
        ctx.world.destroy(victim);
        victim = undefined;
      }
    });
    const h = await createHarness({ systems: [destroyer] });
    const a = h.client();
    await joinAndSpawn(h, a);
    await h.step(3);
    a.take();
    const crate = h.session.regions
      .entitiesIn(SPAWN_REGION)
      .find((e) => h.session.world.has(e, Crate));
    victim = crate;
    while (h.session.tick % 3 !== 2) await h.step();
    await h.step();
    const [snap] = snapshotsOf(a.take());
    expect(snap?.header.serverTick).toBe(h.session.tick);
    expect(snap?.destroys).toEqual([crate]);
    expect(h.session.world.alive(crate as number)).toBe(false);
    expect(h.session.regions.entitiesIn(SPAWN_REGION)).not.toContain(crate);
  });

  it('replicates writes made between steps at the next snapshot (stamped for the coming tick)', async () => {
    const h = await createHarness();
    const a = h.client();
    await joinAndSpawn(h, a);
    while (h.session.tick % 3 !== 0) await h.step();
    a.take();
    const entity = h.session.players()[0]?.entity as number;
    // Right after snapshot tick S, as a hook or onMessage handler would.
    h.session.world.write(entity, Transform).pos.x = 40;
    await h.step(3);
    const [snap] = snapshotsOf(a.take());
    const update = snap?.updates.find((u) => u.entity === entity);
    expect(update?.components.map((c) => c.id)).toEqual([h.game.registry.componentId('Transform')]);
  });

  it('dispatches onMessage with the hook context before the systems of the tick', async () => {
    const seen: string[] = [];
    const onMessage = vi.fn(
      (_p: PlayerInfo, _def: unknown, _payload: unknown, ctx: HookContext) => {
        seen.push(`message at world tick ${ctx.world.tick}, ctx.tick ${ctx.tick}`);
        expect(ctx.world.stepping).toBe(false);
      },
    );
    const sys = defineSystem('sys', 'input', (ctx) => seen.push(`system ${ctx.tick}`));
    const h = await createHarness({ hooks: { onMessage }, systems: [sys] });
    const a = h.client();
    await joinAndSpawn(h, a);
    seen.length = 0;
    a.sendMessage(Shout, { text: 'go' });
    await h.step();
    const t = h.session.tick;
    expect(seen).toEqual([`message at world tick ${t - 1}, ctx.tick ${t - 1}`, `system ${t}`]);
    expect(onMessage.mock.calls[0]?.[3]).toBe(h.session.ctx);
  });

  it('builds the hook context once: live tick, the session back-reference, inputs', async () => {
    const h = await createHarness();
    const ctx = h.session.ctx;
    expect(ctx.session).toBe(h.session);
    expect(ctx.world).toBe(h.session.world);
    expect(ctx.regions).toBe(h.session.regions);
    expect(ctx.spatial).toBe(h.session.spatial);
    await h.step(4);
    expect(ctx.tick).toBe(4);
    expect(h.session.tick).toBe(4);
    expect(h.session.ctx).toBe(ctx);
    const joinCtx = h.hooks.onPlayerJoin;
    const a = h.client();
    await joinAndSpawn(h, a);
    expect(joinCtx.mock.calls[0]?.[1]).toBe(ctx);
    const t = h.session.tick + 1;
    a.input([t], 42);
    await h.step();
    expect(ctx.inputs(0)).toEqual({ tick: t, throttle: 42 });
    await h.step();
    expect(ctx.inputs(0)).toEqual({ tick: t, throttle: 42 }); // held
    expect(ctx.inputs(1)).toBeUndefined();
  });

  it('stamps serverTimeMs at tick start, monotonic; Pong carries the current time', async () => {
    const h = await createHarness();
    const a = h.client();
    await joinAndSpawn(h, a);
    const snaps: SnapshotData[] = [];
    for (let i = 0; i < 60; i++) {
      await h.step();
      snaps.push(...snapshotsOf(a.take()));
    }
    expect(snaps).toHaveLength(20);
    for (let i = 1; i < snaps.length; i++) {
      const prev = snaps[i - 1] as SnapshotData;
      const cur = snaps[i] as SnapshotData;
      expect(cur.header.serverTimeMs).toBeGreaterThan(prev.header.serverTimeMs);
      expect(cur.header.serverTick - prev.header.serverTick).toBe(3);
    }
    // The fake clock starts at 1000 ms and advances 1000/60 ms after each step.
    const last = snaps.at(-1) as SnapshotData;
    expect(last.header.serverTimeMs).toBe(Math.floor(((last.header.serverTick - 1) * 1000) / 60));
    h.clock.advance(5);
    a.ping(77);
    const pong = payloadOf<{ serverTimeMs: number; serverTick: number }>(a.take(), 'Pong');
    expect(pong.serverTick).toBe(h.session.tick);
    expect(pong.serverTimeMs).toBe(Math.floor((h.session.tick * 1000) / 60 + 5));
  });

  it('faults a throwing session and prevents continuation', async () => {
    const boom = defineSystem('boom', 'sim', (ctx) => {
      if (ctx.tick === 2) throw new Error('kaput');
    });
    const h = await createHarness({ systems: [boom] });
    await h.step(2);
    expect(h.session.tick).toBe(2);
    expect(h.session.running).toBe(false);
    expect(() => h.session.step()).toThrow('faulted');
    expect(h.log).toHaveBeenCalledWith('error', 'session faulted', expect.any(Error));
    expect(h.session.stats.tickErrors).toBe(1);
  });

  it('runs onInit on a fresh store, and onLoad with what onSave stored after flushAll', async () => {
    const store = new MemoryStore();
    const make = (hooks: Record<string, unknown>) =>
      new Session(testGame(), {
        store,
        regionLoader: crateLoader(0),
        hooks: { ...defaultHooks(), ...hooks },
        verifier: undefined,
        manualLoop: true,
        log: () => {},
      });
    const onInit = vi.fn();
    const onLoad = vi.fn();
    const onSave = vi.fn(() => new Uint8Array([1, 2, 3]));
    const first = make({ onInit, onLoad, onSave });
    await first.start();
    expect(onInit).toHaveBeenCalledTimes(1);
    expect(onInit.mock.calls[0]?.[0]).toBe(first.ctx);
    expect(onLoad).not.toHaveBeenCalled();
    await first.flushAll();
    expect(await (await openApplicationSave(store)).get('session', 'state')).toEqual(
      new Uint8Array([1, 2, 3]),
    );

    const onInit2 = vi.fn();
    const onLoad2 = vi.fn();
    const second = make({ onInit: onInit2, onLoad: onLoad2 });
    await second.start();
    expect(onInit2).not.toHaveBeenCalled();
    expect(onLoad2).toHaveBeenCalledWith(second.ctx, new Uint8Array([1, 2, 3]));
  });

  it('reports tickStats', async () => {
    const h = await createHarness();
    const a = h.client();
    await joinAndSpawn(h, a);
    await h.step(60);
    const acked = snapshotsOf(a.take()).at(-1)?.header.serverTick as number;
    a.ack(acked);
    await h.step(30);
    a.link.buffered = 1234;
    const stats = h.session.tickStats();
    expect(stats).toMatchObject({
      tick: h.session.tick,
      players: 1,
      entities: 9 * 2 + 1,
      regionsActive: 9,
      dropped: 0,
      wakeLateness: expect.objectContaining({ wakes: 0, maxMs: 0 }), // manualLoop: no wakes
    });
    expect(stats.tickMsAvg).toBeGreaterThanOrEqual(0);
    expect(stats.tickMsMax).toBeGreaterThanOrEqual(stats.tickMsAvg);
    expect(stats.bytesOutPerSec).toBeGreaterThan(0);
    expect(stats.perClient).toEqual([
      expect.objectContaining({ playerId: 0, buffered: 1234, outstanding: 10 }),
    ]);
    expect(stats.counters.snapshotsSent).toBe(h.session.stats.snapshotsSent);
    expect(stats.counters.snapshotsSent).toBeGreaterThanOrEqual(30);
  });

  it('counts the bytes of frames a link takes ownership of (a PortLink transfers them)', async () => {
    const h = await createHarness({ verifier: null });
    const channel = new MessageChannel();
    const received: number[] = [];
    channel.port2.on('message', (msg: { t: string; buf?: ArrayBuffer }) => {
      if (msg.t === 'send' && msg.buf !== undefined) received.push(msg.buf.byteLength);
    });
    const link = new PortLink(424242, channel.port1);
    const posted: { buf: Uint8Array; bytes: number }[] = [];
    const send = link.send.bind(link);
    link.send = (buf) => {
      posted.push({ buf, bytes: buf.byteLength });
      send(buf);
    };
    const exp = Math.floor(Date.now() / 1000) + 600;
    h.session.attach(link, { accountId: 'acc-p', displayName: 'p', sessionId: 'dev', exp });
    const client = new TestClient(h.game.registry, new FakeLink(0));
    const hello = { ...HELLO, registryHash: h.game.registry.hash, displayName: 'p' };
    link.deliver(client.frame([{ kind: CoreKind.Hello, schema: HELLO_SCHEMA, payload: hello }]));
    await h.step(61); // past one RateMeter window
    await new Promise((resolve) => setImmediate(resolve));

    expect(posted.map((p) => p.buf.byteLength)).toEqual(posted.map(() => 0)); // detached here
    const bytes = posted.reduce((n, p) => n + p.bytes, 0);
    expect(posted.length).toBeGreaterThanOrEqual(2); // Welcome, SessionState
    expect(received.reduce((n, b) => n + b, 0)).toBe(bytes);
    const stats = h.session.tickStats();
    expect(stats.bytesOutPerSec).toBeGreaterThan(0);
    expect(stats.perClient).toEqual([
      expect.objectContaining({ bytesOutPerSec: stats.bytesOutPerSec }),
    ]);
    channel.port1.close();
  });

  it('drives ticks from sim FixedLoop when manualLoop is off', async () => {
    const clock = new FakeClock();
    const session = new Session(testGame(), {
      store: new MemoryStore(),
      regionLoader: crateLoader(1),
      hooks: defaultHooks(),
      verifier: undefined,
      now: clock.now,
      timers: clock,
      log: () => {},
    });
    expect(() => session.step()).toThrow(/manualLoop/);
    await session.start();
    clock.advance(1000);
    expect(session.tick).toBeGreaterThanOrEqual(59);
    expect(session.tick).toBeLessThanOrEqual(60);
    await session.stop();
    const stopped = session.tick;
    clock.advance(1000);
    expect(session.tick).toBe(stopped);
  });

  it('skips the ticks a stalled loop drops, keeping the tick to the clock, and records them', async () => {
    const clock = new FakeClock();
    const game = testGame();
    const recordLog: InputLog = {
      version: 1,
      seed: game.seed,
      tickRate: game.tickRate,
      entries: [],
    };
    const logged: unknown[][] = [];
    // The wake armed while `stall` is set comes that much late: the process held up.
    let stall = 0;
    const session = new Session(game, {
      store: new MemoryStore(),
      regionLoader: crateLoader(1),
      hooks: defaultHooks(),
      verifier: undefined,
      now: clock.now,
      timers: {
        setTimeout: (fn, ms) => {
          const late = stall;
          stall = 0;
          return clock.setTimeout(fn, ms + late);
        },
        clearTimeout: clock.clearTimeout,
      },
      log: (...line) => logged.push(line),
      recordLog,
    });
    await session.start(); // at 1000 ms: tick k is due at 1000 + k ticks
    clock.advance(495);
    expect(session.tick).toBe(29);
    stall = 290;
    clock.advance(10); // tick 30, at 1500, arms the wake for tick 31 to come at 1806.7
    expect(session.tick).toBe(30);
    clock.advance(310); // that wake finds ticks 31 to 48 due: the latest five run
    expect(session.tick).toBe(48);
    expect(recordLog.skips).toEqual([[31, 13]]);
    expect(session.tickStats().dropped).toBe(13);
    expect(logged).toContainEqual(['warn', 'dropped ticks', { n: 13 }]);
    clock.advance(195); // 2005 ms: on time again
    expect(session.tick).toBe(60);
    await session.stop();
  });

  it('skips ticks by hand with manualLoop, recorded; not with a loop', async () => {
    const clock = new FakeClock();
    const game = testGame();
    const options = {
      store: new MemoryStore(),
      regionLoader: crateLoader(1),
      hooks: defaultHooks(),
      verifier: undefined,
      now: clock.now,
      timers: clock,
      log: () => {},
    };
    const recordLog: InputLog = {
      version: 1,
      seed: game.seed,
      tickRate: game.tickRate,
      entries: [],
    };
    const session = new Session(game, { ...options, manualLoop: true, recordLog });
    expect(() => session.skip(2)).toThrow(/session is/);
    await session.start();
    session.step();
    session.skip(5);
    session.step();
    expect(session.tick).toBe(7);
    expect(recordLog.skips).toEqual([[2, 5]]);
    await session.stop();
    expect(() => new Session(game, options).skip(1)).toThrow(/manualLoop/);
  });

  it('reports the FixedLoop wake lateness of each wake in tickStats', async () => {
    const clock = new FakeClock();
    let timer = 0;
    const session = new Session(testGame(), {
      store: new MemoryStore(),
      regionLoader: crateLoader(1),
      hooks: defaultHooks(),
      verifier: undefined,
      now: clock.now,
      // Timer k wakes the loop for wake k: 0.1 ms late, and every tenth time 20.1 ms late, a
      // catch-up wake that runs two ticks.
      timers: {
        setTimeout: (fn, ms) => clock.setTimeout(fn, ms + (++timer % 10 === 0 ? 20.1 : 0.1)),
        clearTimeout: clock.clearTimeout,
      },
      log: () => {},
    });
    await session.start();
    clock.advance(1000);
    const { wakeLateness: late, dropped } = session.tickStats();
    await session.stop();

    const catchUps = Math.floor(late.wakes / 10);
    expect(dropped).toBe(0);
    expect(late.wakes).toBeGreaterThanOrEqual(50);
    expect(session.tick).toBe(late.wakes + catchUps); // recorded once per wake, not per tick
    expect(late.bucketMs).toBe(0.25);
    expect(late.histogram).toHaveLength(64);
    expect(late.histogram[0]).toBe(late.wakes - catchUps);
    expect(late.histogram[63]).toBe(catchUps); // past the last edge, 16 ms
    expect(late.p50Ms).toBe(0.25); // the upper edge of the first bucket
    expect(late.p99Ms).toBeCloseTo(20.1, 9); // the open last bucket answers the exact maximum
    expect(late.maxMs).toBeCloseTo(20.1, 9);
  });

  it('LatenessHistogram: cumulative buckets, bucket-resolution quantiles and an exact maximum', () => {
    const hist = new LatenessHistogram();
    expect(hist.stats()).toEqual({
      wakes: 0,
      p50Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      bucketMs: 0.25,
      histogram: new Array<number>(64).fill(0),
    });
    for (let i = 0; i < 97; i++) hist.record(0.1);
    hist.record(-0.5); // an early wake: first bucket
    hist.record(0.25); // a lower edge belongs to its bucket
    hist.record(3.9);
    let s = hist.stats();
    expect(s).toMatchObject({ wakes: 100, p50Ms: 0.25, p99Ms: 0.5, maxMs: 3.9 });
    expect([s.histogram[0], s.histogram[1], s.histogram[15]]).toEqual([98, 1, 1]);
    expect(hist.quantile(1)).toBe(3.9); // the edge 4 capped at the maximum
    hist.record(40); // beyond the last bucket
    s = hist.stats();
    expect([s.wakes, s.histogram[63], s.maxMs, s.p99Ms]).toEqual([101, 1, 40, 4]);
    expect(hist.quantile(1)).toBe(40); // the open last bucket answers the maximum
  });
});

describe('player entities and regions', () => {
  it('keeps the spawn region wanted for a joined player and the entity region for a spawned one', async () => {
    const h = await createHarness();
    const a = h.client();
    a.hello();
    await h.step(); // join: pending spawn region starts loading
    expect(h.session.regions.state(SPAWN_REGION)).toBe('loading');
    await h.step();
    expect(h.session.regions.active()).toContain(SPAWN_REGION);
    expect(h.loader.populated).toContain(SPAWN_REGION);
    a.ready();
    const set = payloadOf<{ active: string[] }>(a.take(), 'RegionSet');
    a.regionLoadState(set.active);
    await h.step();
    const entity = h.session.players()[0]?.entity as number;
    expect(h.session.world.get(entity, Region).id).toBe(SPAWN_REGION);
    expect(h.session.regions.entitiesIn(SPAWN_REGION)).toContain(entity);
  });

  it('keeps the spawn region of a player still loading wanted past the linger time; it lingers once the player leaves', async () => {
    const h = await createHarness({ tickRate: 10 }); // LINGER_MS is 100 ticks at 10 Hz
    const { regions, interest } = h.session;
    const a = h.client();
    a.hello();
    await h.step();
    a.ready(); // loading from here on: it never reports its regions, so it never spawns
    const wanted = interest.wantedForRegion(SPAWN_REGION);
    expect(payloadOf<RegionSetPayload>(a.take(), 'RegionSet').active).toEqual(sorted(wanted));
    await h.step(150);
    expect(h.session.players()).toEqual([
      expect.objectContaining({ playerId: 0, entity: ENTITY_NONE }),
    ]);
    expect(wanted).toHaveLength(9);
    for (const id of wanted) {
      expect(regions.state(id)).toBe('active');
      expect(regions.lingering(id)).toBe(false);
    }
    expect(cratesIn(h, SPAWN_REGION)).toHaveLength(2);

    a.leave();
    await h.step(2);
    expect(h.session.players()).toEqual([]);
    for (const id of wanted) expect(regions.lingering(id)).toBe(true);
    await h.step(110);
    for (const id of wanted) {
      expect(regions.state(id)).not.toBe('active');
      expect(regions.entitiesIn(id)).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// World streaming (M3): RegionSet with prefetch, interest = wanted ∩ reported, relevance.

/** Cell ids within Chebyshev distance `depth` of cell `(ix, iy)` of an 8 x 8 grid, sorted. */
function cellsAround(ix: number, iy: number, depth: number): string[] {
  const out: string[] = [];
  for (let y = iy - depth; y <= iy + depth; y++) {
    for (let x = ix - depth; x <= ix + depth; x++) {
      if (x >= 0 && y >= 0 && x < 8 && y < 8) out.push(`cell/${x}_${y}`);
    }
  }
  return out.sort(stringCompare);
}

/** The prefetch ring of cell `(ix, iy)` at wanted depth 1: distance 2, sorted. */
function ringAround(ix: number, iy: number): string[] {
  const wanted = cellsAround(ix, iy, 1);
  return cellsAround(ix, iy, 2).filter((id) => !wanted.includes(id));
}

function sorted(ids: readonly string[]): string[] {
  return [...ids].sort(stringCompare);
}

/** `onPlayerJoin` spawning each player in the region named for its display name (else the default). */
function spawnByName(regions: Record<string, string>) {
  return (player: PlayerInfo): PlayerSpawn => {
    const regionId = regions[player.displayName] ?? SPAWN_REGION;
    return {
      regionId,
      spawn: (ctx) => {
        const e = ctx.world.create();
        ctx.world.add(e, Region, { id: regionId });
        ctx.world.add(e, Transform, { pos: { x: 32 + player.playerId, y: 0, z: 32 } });
        ctx.world.add(e, Owner, { player: player.playerId });
        return e;
      },
    };
  };
}

/** Steps until the last simulated tick is a snapshot tick. */
async function alignToSnapshot(h: Harness): Promise<void> {
  while (h.session.tick % h.game.snapshotEvery !== 0) await h.step();
}

function entityOf(h: Harness, playerId: number): EntityId {
  const player = h.session.players().find((p) => p.playerId === playerId);
  if (player === undefined) throw new Error(`no player ${playerId}`);
  return player.entity;
}

/** Every entity the server lists in `regions`, ascending. */
function entitiesOf(h: Harness, regions: readonly string[]): EntityId[] {
  return regions.flatMap((r) => [...h.session.regions.entitiesIn(r)]).sort((x, y) => x - y);
}

function cratesIn(h: Harness, region: string): EntityId[] {
  return h.session.regions.entitiesIn(region).filter((e) => h.session.world.has(e, Crate));
}

/** The client side of a `TestClient`: net-client's `ReplicaWorld` fed with every snapshot it got. */
class Watcher {
  readonly client: TestClient;
  readonly replica: ReplicaWorld;

  constructor(h: Harness, client: TestClient) {
    this.client = client;
    this.replica = new ReplicaWorld(h.game.registry, h.game.components, {
      tickRate: h.game.tickRate,
      snapshotEvery: h.game.snapshotEvery,
      log: () => {},
    });
  }

  apply(messages: ReceivedMessage[]): ReceivedMessage[] {
    for (const snapshot of snapshotsOf(messages)) this.replica.applySnapshot(snapshot);
    return messages;
  }

  take(): ReceivedMessage[] {
    return this.apply(this.client.take());
  }

  /** Entities the client holds and has not seen destroyed, ascending. */
  live(): EntityId[] {
    const out: EntityId[] = [];
    for (const ent of this.replica.entities()) if (ent.destroyedTick === null) out.push(ent.id);
    return out.sort((x, y) => x - y);
  }
}

describe('world streaming: RegionSet and interest (docs/net.md A.8.2, docs/world.md 9)', () => {
  it('sends wantedFor as active and the ring one step beyond it as prefetch; the server loads only active', async () => {
    const h = await createHarness({
      cols: 8,
      rows: 8,
      hooks: { onPlayerJoin: spawnByName({ a: 'cell/3_3' }) },
    });
    const a = h.client();
    a.hello({ displayName: 'a' });
    await h.step();
    a.ready();
    const set = payloadOf<RegionSetPayload>(a.take(), 'RegionSet');
    expect(set.active).toEqual(cellsAround(3, 3, 1));
    expect(set.prefetch).toEqual(ringAround(3, 3));
    expect(set.prefetch).toHaveLength(16);
    const { interest } = h.session;
    expect(set.active).toEqual(sorted(interest.wantedForRegion('cell/3_3')));
    expect(set.prefetch).toEqual(sorted(interest.prefetchForRegion('cell/3_3')));

    a.regionLoadState([...set.active, ...set.prefetch]); // a client reports its prefetch too
    await h.step(3);
    const entity = entityOf(h, 0);
    expect(h.session.regions.regionOf(entity)).toBe('cell/3_3');
    expect(set.active).toEqual(sorted(interest.wantedFor(entity)));
    expect(set.prefetch).toEqual(sorted(interest.prefetchFor(entity)));
    expect(h.session.regions.active()).toEqual(set.active);
    for (const id of set.prefetch) expect(h.session.regions.state(id)).toBe('inactive');

    await h.step(30);
    expect(a.names()).not.toContain('RegionSet'); // unchanged sets are never re-sent
  });

  it('re-sends the RegionSet before the snapshot when the player changes region; regions left behind are destroyed on the client', async () => {
    const h = await createHarness({
      cols: 8,
      rows: 8,
      hooks: { onPlayerJoin: spawnByName({ a: 'cell/3_3' }) },
    });
    const a = h.client();
    const watch = new Watcher(h, a);
    watch.apply(await joinAndSpawn(h, a, 'a')); // reports exactly its active regions
    await alignToSnapshot(h);
    watch.take();
    await h.step(6);
    expect(watch.take().map((m) => m.name)).toEqual(['Snapshot', 'Snapshot']);

    const entity = entityOf(h, 0);
    const behind = entitiesOf(h, ['cell/2_2', 'cell/2_3', 'cell/2_4']);
    expect(behind).toHaveLength(6);
    expect(watch.live()).toEqual(expect.arrayContaining(behind));
    h.session.world.write(entity, Transform).pos.x = CELL + 8; // across the border into cell/4_3
    await h.step(3);
    const got = watch.take();
    expect(got.map((m) => m.name)).toEqual(['RegionSet', 'Snapshot']);
    expect(h.session.regions.regionOf(entity)).toBe('cell/4_3');
    const set = payloadOf<RegionSetPayload>(got, 'RegionSet');
    expect(set).toEqual({ active: cellsAround(4, 3, 1), prefetch: ringAround(4, 3) });
    expect(set.active).toEqual(sorted(h.session.interest.wantedFor(entity)));
    expect(set.prefetch).toEqual(sorted(h.session.interest.prefetchFor(entity)));

    // Interest is the new wanted set ∩ the old report: the column left behind is destroyed on the
    // client (still alive on the server) and the new column waits for the client's report.
    const [snap] = snapshotsOf(got) as [SnapshotData];
    expect(snap.destroys).toEqual(behind);
    expect(snap.creates).toEqual([]);
    for (const e of behind) {
      expect(h.session.world.alive(e)).toBe(true);
      expect(watch.replica.get(e)?.destroyedTick).toBe(snap.header.serverTick);
    }
    expect(watch.live()).toContain(entity);

    a.regionLoadState([...set.active, ...set.prefetch]);
    await h.step(3);
    expect(watch.take().map((m) => m.name)).toEqual(['Snapshot']); // not re-sent
    expect(entitiesOf(h, ['cell/5_2', 'cell/5_3', 'cell/5_4'])).toHaveLength(6);
    expect(watch.live()).toEqual(entitiesOf(h, set.active));
  });

  it('replicates only the entities of wanted ∩ reported that pass the relevance hook', async () => {
    let hidden: EntityId = ENTITY_NONE;
    const relevance = vi.fn((_player: PlayerInfo, e: EntityId, _ctx: HookContext) => e !== hidden);
    const h = await createHarness({
      cols: 8,
      rows: 8,
      hooks: { onPlayerJoin: spawnByName({ near: 'cell/2_2', far: 'cell/6_6' }), relevance },
    });
    const a = h.client();
    const b = h.client();
    const near = new Watcher(h, a);
    near.apply(await joinAndSpawn(h, a, 'near'));
    await joinAndSpawn(h, b, 'far');
    near.take();

    const wanted = cellsAround(2, 2, 1);
    const unreported = 'cell/1_1'; // wanted, but no longer reported loaded
    const far = 'cell/6_6'; // active for B and reported by A, but not wanted by A
    const reported = sorted([...wanted.filter((r) => r !== unreported), far, ...ringAround(2, 2)]);
    const unreportedCrates = cratesIn(h, unreported);
    hidden = cratesIn(h, 'cell/2_2')[0] as EntityId;
    expect(near.live()).toEqual(expect.arrayContaining([...unreportedCrates, hidden]));
    a.regionLoadState(reported);
    relevance.mockClear();
    await h.step(3);
    near.take();

    const inInterest = entitiesOf(
      h,
      wanted.filter((r) => r !== unreported),
    ).filter((e) => e !== hidden);
    expect(near.live()).toEqual(inInterest);
    expect(near.live()).toContain(entityOf(h, 0));
    const farEntities = entitiesOf(h, [far]);
    expect(farEntities).toContain(entityOf(h, 1));
    for (const e of farEntities) expect(near.replica.has(e)).toBe(false); // never sent
    for (const e of [...unreportedCrates, hidden]) {
      expect(near.replica.get(e)?.destroyedTick).not.toBeNull();
      expect(h.session.world.alive(e)).toBe(true);
    }
    const nearInfo = expect.objectContaining({ playerId: 0, displayName: 'near' });
    expect(relevance).toHaveBeenCalledWith(nearInfo, hidden, h.session.ctx);
    const askedForNear = relevance.mock.calls.filter(([p]) => p.playerId === 0).map(([, e]) => e);
    expect(sortedIds(askedForNear)).toEqual(sortedIds([...inInterest, hidden]));

    hidden = ENTITY_NONE;
    const all = sorted([...reported, unreported]);
    a.regionLoadState(all);
    await h.step(3);
    near.take();
    expect(near.live()).toEqual(entitiesOf(h, wanted));
    const visible = h.session.interest.visible(
      { player: entityOf(h, 0), wanted, reported: all },
      [],
    );
    expect(near.live()).toEqual(visible);
  });

  it('destroys an entity on the client when it moves out of the client interest, while it lives on', async () => {
    const h = await createHarness({
      cols: 8,
      rows: 8,
      hooks: { onPlayerJoin: spawnByName({ a: 'cell/2_2', b: 'cell/4_4' }) },
    });
    const a = h.client();
    const b = h.client();
    const watchA = new Watcher(h, a);
    const watchB = new Watcher(h, b);
    watchA.apply(await joinAndSpawn(h, a, 'a'));
    watchB.apply(await joinAndSpawn(h, b, 'b'));
    await alignToSnapshot(h);
    watchA.take();
    watchB.take();

    const crate = cratesIn(h, 'cell/3_3')[0] as EntityId; // wanted by both players
    expect(watchA.live()).toContain(crate);
    expect(watchB.live()).toContain(crate);
    h.session.world.write(crate, Transform).pos.x = CELL + 4; // into cell/4_3: B's, not A's
    await h.step(3);
    const [snapA] = snapshotsOf(watchA.take()) as [SnapshotData];
    const [snapB] = snapshotsOf(watchB.take()) as [SnapshotData];
    expect(h.session.regions.regionOf(crate)).toBe('cell/4_3');
    expect(h.session.world.alive(crate)).toBe(true);

    expect(snapA.destroys).toEqual([crate]);
    const tick = snapA.header.serverTick;
    expect(watchA.replica.get(crate)?.destroyedTick).toBe(tick);
    expect([...watchA.replica.visibleAt(tick)].map((ent) => ent.id)).not.toContain(crate);

    const registry = h.game.registry;
    const update = snapB.updates.find((u) => u.entity === crate);
    expect(update?.components.map((c) => c.id)).toEqual(
      [registry.componentId('Region'), registry.componentId('Transform')].sort((x, y) => x - y),
    );
    expect(snapB.destroys).toEqual([]);
    expect(watchB.replica.get(crate)?.regionId).toBe('cell/4_3');
    expect(watchB.live()).toContain(crate);
  });

  it('a relevance hook that throws fails only the snapshot of that player', async () => {
    const relevance = (player: PlayerInfo): boolean => {
      if (player.displayName === 'bad') throw new Error('bad relevance');
      return true;
    };
    const h = await createHarness({ hooks: { relevance } });
    const bad = h.client();
    const good = h.client();
    await joinAndSpawn(h, bad, 'bad'); // player 0: its snapshot is built first
    await joinAndSpawn(h, good, 'good');
    await alignToSnapshot(h);
    bad.take();
    good.take();
    const errors = h.session.stats.tickErrors;
    h.log.mockClear();
    await h.step(3);
    expect(bad.names()).toEqual([]);
    expect(good.names()).toEqual(['Snapshot']);
    expect(h.session.stats.tickErrors).toBe(errors + 1);
    expect(h.log).toHaveBeenCalledWith('error', 'snapshot for player 0 failed', expect.any(Error));
  });
});

describe('world streaming: the spatial index and the world edge (docs/world.md 6.1, 8.2)', () => {
  it('rebuilds the spatial index after membership: queries see positions moved this tick, in the new region after a crossing', async () => {
    const moves: { e: EntityId; x: number; z: number }[] = [];
    let probe: { region: string; x: number; z: number } | null = null;
    const seenBySystems: EntityId[][] = [];
    const mover = defineSystem('mover', 'sim', (ctx) => {
      for (const m of moves.splice(0)) {
        const pos = ctx.world.write(m.e, Transform).pos;
        pos.x = m.x;
        pos.z = m.z;
      }
    });
    const query = defineSystem('query', 'preSim', (ctx) => {
      if (probe === null) return;
      const { region, x, z } = probe;
      seenBySystems.push(ctx.spatial.queryRadius(region, { x, y: 0, z }, 0.5, []));
    });
    const h = await createHarness({ systems: [query, mover] });
    await joinAndSpawn(h, h.client());
    const { spatial, regions, world } = h.session;
    expect(spatial).toBeInstanceOf(SpatialIndex);
    const slot: SessionSpatial = spatial; // type-checked: SpatialIndex satisfies SessionSpatial
    expect(h.session.ctx.spatial).toBe(slot);
    const at = (region: string, x: number, z: number): EntityId[] =>
      spatial.queryRadius(region, { x, y: 0, z }, 0.5, []);
    const crate = cratesIn(h, SPAWN_REGION)[0] as EntityId;
    const { x: x0, z: z0 } = world.get(crate, Transform).pos;
    expect(at(SPAWN_REGION, x0, z0)).toEqual([crate]);

    moves.push({ e: crate, x: 10, z: 20 });
    await h.step();
    expect(at(SPAWN_REGION, 10, 20)).toEqual([crate]);
    expect(at(SPAWN_REGION, x0, z0)).toEqual([]);
    probe = { region: SPAWN_REGION, x: 10, z: 20 };
    await h.step();
    probe = null;
    expect(seenBySystems).toEqual([[crate]]); // the next tick's systems query the rebuilt grids

    // Over the border into cell/2_1 in sim: membership moves it before the rebuild files it.
    moves.push({ e: crate, x: CELL + 2, z: 20 });
    await h.step();
    expect(regions.regionOf(crate)).toBe('cell/2_1');
    expect(world.get(crate, Transform).pos).toMatchObject({ x: 2, z: 20 });
    expect(at('cell/2_1', 2, 20)).toEqual([crate]);
    expect(at(SPAWN_REGION, CELL + 2, 20)).toEqual([]);
    const regionsOut: string[] = [];
    const across = spatial.queryRadiusAcross(
      SPAWN_REGION,
      { x: CELL - 1, y: 0, z: 20 },
      4,
      [],
      regionsOut,
    );
    expect(across).toContain(crate);
    expect(regionsOut).toHaveLength(across.length);
    expect(regionsOut[across.indexOf(crate)]).toBe('cell/2_1');
  });

  it('passes onWorldEdge to the RegionManager: an entity off the world is clamped, then the hook gets the hook context', async () => {
    const calls: { e: EntityId; x: number; tick: number }[] = [];
    const onWorldEdge = vi.fn((e: EntityId, ctx: HookContext) => {
      // Called during the membership pass of the tick, with the entity already clamped.
      calls.push({ e, x: ctx.world.get(e, Transform).pos.x, tick: ctx.tick });
    });
    const h = await createHarness({ hooks: { onWorldEdge } });
    const a = h.client();
    await joinAndSpawn(h, a);
    const { world, regions } = h.session;
    const crate = cratesIn(h, 'cell/0_1')[0] as EntityId; // the west edge of the grid
    world.write(crate, Transform).pos.x = -5;
    await h.step();
    expect(calls).toEqual([{ e: crate, x: 0, tick: h.session.tick }]);
    expect(onWorldEdge.mock.calls[0]?.[1]).toBe(h.session.ctx);
    expect(regions.regionOf(crate)).toBe('cell/0_1');
    expect(world.get(crate, Transform).pos.x).toBe(0);
    await h.step();
    expect(onWorldEdge).toHaveBeenCalledTimes(1);

    // This callback can mutate authoritative state, so a throw faults the session.
    onWorldEdge.mockImplementation(() => {
      throw new Error('edge');
    });
    await alignToSnapshot(h);
    a.take();
    world.write(crate, Transform).pos.x = -1;
    await h.step();
    expect(h.session.fault?.cause).toMatchObject({ system: 'onWorldEdge', phase: 'hook' });
    expect(a.take().filter((m) => m.name === 'Snapshot')).toEqual([]);
  });
});

function sortedIds(ids: readonly EntityId[]): EntityId[] {
  return [...ids].sort((x, y) => x - y);
}
