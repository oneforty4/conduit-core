import { devVerifier } from '@conduit/auth';
import {
  type HookContext,
  type PlayerInfo,
  type PlayerSpawn,
  Session,
  type SessionGameDef,
} from '@conduit/net-server';
import { MemoryStore } from '@conduit/persist';
import {
  ByteWriter,
  defineInput,
  type EntityId,
  f,
  type InputPayload,
  KickReason,
  type KickedPayload,
  PlayerState,
  type RejectedPayload,
  RejectReason,
  type Schema,
  SchemaRegistry,
  SNAPSHOT_FLAG_FULL,
  type SnapshotHeader,
} from '@conduit/protocol';
import {
  type ComponentType,
  CORE_COMPONENTS,
  defineEvent,
  defineSystem,
  Name,
  Owner,
  Region,
  RegionChanged,
  Transform,
} from '@conduit/sim';
import { GridWorld, type RegionLoader } from '@conduit/world';
import { describe, expect, it } from 'vitest';
import {
  type ClientGameDef,
  type ClientState,
  ConnectError,
  type DisconnectInfo,
  INPUT_FRAMES_PER_MESSAGE,
  MemoryTransport,
  NetClient,
  RECONNECT_DELAYS_MS,
  type ReplicatedEventInfo,
  type Transport,
  type TransportFactory,
} from '../src/index.ts';
import { type ClientMessage, decodeClientFrame, ManualTimers } from './helpers.ts';

const CELL = 64;
const SPAWN_REGION = 'cell/1_1';
const Input = defineInput({ tick: f.u32, throttle: f.i8 });
type Frame = ReturnType<typeof Input.create>;
const steer = (throttle: number): Frame => ({ tick: 0, throttle });
/** A global replicated event: the `beacon` system emits one per number in `beacons`. */
const Beacon = defineEvent('Beacon', { n: f.u16 });
const beacons: number[] = [];

/** Moves each player's entity along +x at `throttle` m/s while its input says so. */
const drive = defineSystem('drive', 'sim', (ctx) => {
  for (const e of ctx.world.query(Owner, Transform)) {
    const input = ctx.inputs(ctx.world.get(e, Owner).player) as Frame | undefined;
    const throttle = input?.throttle ?? 0;
    if (throttle === 0 && ctx.world.get(e, Transform).vel.x === 0) continue;
    const t = ctx.world.write(e, Transform);
    t.pos.x += throttle * ctx.dt;
    t.vel.x = throttle;
  }
});

const beacon = defineSystem('beacon', 'sim', (ctx) => {
  for (const n of beacons.splice(0)) ctx.events.emit(Beacon, { n });
});

const components: ComponentType<unknown>[] = [...CORE_COMPONENTS];
const registry = new SchemaRegistry({
  components,
  messages: [],
  events: [RegionChanged, Beacon],
  input: Input,
});
const game: SessionGameDef & ClientGameDef = {
  id: 'reconnect',
  protocolVersion: 1,
  tickRate: 60,
  snapshotEvery: 3,
  seed: 77,
  registry,
  input: Input,
  systems: [drive, beacon],
  components,
  world: (seed) =>
    new GridWorld({ cellSize: CELL, cols: 4, rows: 4, wantedDepth: 1, worldSeed: seed }),
};

/** One crate per activated region, so the replica holds more than the player's own entity. */
const loader: RegionLoader = {
  populate(region, _blob, ctx) {
    const rng = ctx.regionRng(region.id);
    const e = ctx.world.create();
    ctx.world.add(e, Region, { id: region.id });
    ctx.world.add(e, Transform, {
      pos: { x: 8 + rng.float() * 48, y: 0, z: 8 + rng.float() * 48 },
    });
    ctx.world.add(e, Name, { value: 'crate' });
  },
};

function spawnAt(player: PlayerInfo): PlayerSpawn {
  return {
    regionId: SPAWN_REGION,
    spawn: (ctx: HookContext): EntityId => {
      const e = ctx.world.create();
      ctx.world.add(e, Region, { id: SPAWN_REGION });
      ctx.world.add(e, Transform, { pos: { x: 20 + 4 * player.playerId, y: 0, z: 32 } });
      ctx.world.add(e, Owner, { player: player.playerId });
      ctx.world.add(e, Name, { value: player.displayName });
      return e;
    },
  };
}

/** A macrotask turn: the Session's region loads (`store.get`) resolve between frames. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A frame the client sent: when, on which connection (index into `transports`), and what. */
interface SentFrame {
  at: number;
  conn: number;
  bytes: number;
  messages: ClientMessage[];
}

interface ReceivedFrame {
  at: number;
  conn: number;
  bytes: number;
}

interface SnapshotSeen {
  at: number;
  header: SnapshotHeader;
  state: ClientState;
  /** `createdTick` of every entity in the replica right after the snapshot was applied. */
  createdTicks: number[];
}

/**
 * A Session on fake timers and one NetClient 'A' whose transports come from `factory`: while
 * `net.online` each connection is attached to the Session over a `MemoryTransport` with 5 ms each
 * way; while offline the socket fails before it opens (the server never sees it). Every frame is
 * recorded at the client's transport boundary, where `NetClient.stats()` counts bytes.
 */
async function setup(opts: { reconnectGraceMs?: number } = {}) {
  beacons.length = 0;
  const timers = new ManualTimers();
  const leaves: string[] = [];
  const problems: unknown[] = [];
  const session = new Session(game, {
    store: new MemoryStore(),
    regionLoader: loader,
    hooks: {
      onPlayerJoin: (player) => spawnAt(player),
      onPlayerLeave: (player) => leaves.push(player.displayName),
    },
    verifier: devVerifier({ warn: () => {} }),
    sessionId: 'dev',
    now: timers.nowFn,
    timers,
    reconnectGraceMs: opts.reconnectGraceMs,
    log: (level, msg, data) => {
      if (level !== 'info') problems.push({ side: 'server', level, msg, data });
    },
  });
  await session.start();

  const net = { online: true };
  /** `timers.now` of every transport the client asked for (the first is `connect()`). */
  const attempts: number[] = [];
  const transports: MemoryTransport[] = [];
  const sent: SentFrame[] = [];
  const received: ReceivedFrame[] = [];
  const factory: TransportFactory = () => {
    const conn = transports.length;
    attempts.push(timers.now);
    const inner = new MemoryTransport({ timers, latencyMs: 5 });
    transports.push(inner);
    if (net.online) session.attach(inner.link);
    else inner.drop(1006); // unreachable: closes with 1006 on a later turn, never opens
    const transport: Transport = {
      send: (buf) => {
        const messages = decodeClientFrame(buf, registry);
        sent.push({ at: timers.now, conn, bytes: buf.byteLength, messages });
        inner.send(buf);
      },
      close: (code, reason) => inner.close(code, reason),
      onOpen: (cb) => inner.onOpen(cb),
      onMessage: (cb) =>
        inner.onMessage((buf) => {
          received.push({ at: timers.now, conn, bytes: buf.byteLength });
          cb(buf);
        }),
      onClose: (cb) => inner.onClose(cb),
      onError: (cb) => inner.onError(cb),
    };
    return transport;
  };

  const client = new NetClient({
    url: 'memory://dev',
    game,
    token: 'dev',
    displayName: 'A',
    transport: factory,
    now: timers.nowFn,
    timers,
    log: (level, msg, data) => {
      if (level === 'warn' || level === 'error')
        problems.push({ side: 'client', level, msg, data });
    },
  });
  const states: { edge: string; at: number }[] = [];
  const disconnects: (DisconnectInfo & { at: number })[] = [];
  const snapshots: SnapshotSeen[] = [];
  const welcomes: { at: number; state: ClientState; mirrorSize: number }[] = [];
  const events: ReplicatedEventInfo[] = [];
  const kicks: KickedPayload[] = [];
  const rejections: RejectedPayload[] = [];
  client.on('state', (s, prev) => states.push({ edge: `${prev}->${s}`, at: timers.now }));
  client.on('disconnected', (info) => disconnects.push({ ...info, at: timers.now }));
  client.on('snapshot', (header) =>
    snapshots.push({
      at: timers.now,
      header,
      state: client.state,
      createdTicks: [...client.mirror.entities()].map((e) => e.createdTick),
    }),
  );
  client.on('welcome', () =>
    welcomes.push({ at: timers.now, state: client.state, mirrorSize: client.mirror.size }),
  );
  client.on('event', (ev) => events.push(ev));
  client.on('kicked', (k) => kicks.push(k));
  client.on('rejected', (r) => rejections.push(r));
  client.on('error', (err) => problems.push({ side: 'client', err }));

  const frame = async (): Promise<void> => {
    timers.advance(16);
    client.update();
    await settle();
  };
  const frames = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) await frame();
  };
  const runUntil = async (done: () => boolean, maxFrames: number, what: string): Promise<void> => {
    for (let i = 0; i < maxFrames && !done(); i++) await frame();
    expect(done(), what).toBe(true);
  };
  const play = async (): Promise<void> => {
    const connected = client.connect();
    await runUntil(() => client.state === 'Playing', 300, 'Playing');
    await connected;
  };
  /** Abrupt loss of the live connection (both ends close with 1006), returning the client's close time. */
  const loseConnection = async (): Promise<number> => {
    const seen = disconnects.length;
    (transports.at(-1) as MemoryTransport).drop(1006);
    await runUntil(() => disconnects.length > seen, 5, 'the close reaches the client');
    return (disconnects.at(-1) as { at: number }).at;
  };
  const beaconsSeen = (): number[] => events.map((ev) => (ev.payload as { n: number }).n);
  const edges = (): string[] => states.map((s) => s.edge);
  return {
    timers,
    session,
    client,
    net,
    leaves,
    problems,
    attempts,
    transports,
    sent,
    received,
    states,
    edges,
    disconnects,
    snapshots,
    welcomes,
    events,
    kicks,
    rejections,
    frame,
    frames,
    runUntil,
    play,
    loseConnection,
    beaconsSeen,
  };
}

function encode(schema: Schema<unknown>, value: unknown): number[] {
  const w = new ByteWriter();
  schema.encode(w, value);
  return [...w.finish()];
}

/**
 * The client's live replica equals the server's replicated stores: the same entities as the server
 * holds in the wanted regions of the player's region, with byte-identical component values.
 */
function expectReplicaMatchesServer(client: NetClient, session: Session): void {
  const region = session.regions.regionOf(client.entity) as string;
  const serverEntities = [...new Set(session.interest.wantedForRegion(region))]
    .flatMap((r) => [...session.regions.entitiesIn(r)])
    .sort((x, y) => x - y);
  const alive = [...client.mirror.entities()].filter((e) => e.destroyedTick === null);
  expect(alive.map((e) => e.id).sort((x, y) => x - y)).toEqual(serverEntities);
  for (const ent of alive) {
    for (const c of registry.replicated) {
      const server = session.world.tryGet(ent.id, c as ComponentType<unknown>);
      const mirror = ent.latest.get(registry.componentId(c));
      expect(mirror === undefined, `${ent.id}/${c.name} presence`).toBe(server === undefined);
      if (server !== undefined) {
        expect(encode(c.schema, mirror), `${ent.id}/${c.name}`).toEqual(encode(c.schema, server));
      }
    }
  }
}

const sum = (list: readonly { bytes: number }[]): number => list.reduce((n, m) => n + m.bytes, 0);

describe('NetClient reconnect against a Session over MemoryTransport', () => {
  it('a drop while Playing reconnects after the backoff and resyncs to the same player and entity; the FULL snapshot rebuilds a replica equal to the server; outage input is neither queued nor replayed; outage events never arrive', async () => {
    const t = await setup();
    const { session, client, timers } = t;
    await t.play();
    const { playerId, entity, reconnectToken } = client;
    expect(reconnectToken).toHaveLength(32);

    // Drive, then rest, so the replica holds a moved entity with samples.
    client.sendInput(steer(5));
    await t.frames(30);
    client.sendInput(steer(0));
    await t.frames(30);
    const restX = session.world.get(entity, Transform).pos.x;
    expect(restX).toBeGreaterThan(20 + 4 * playerId + 1);
    const transformBytes = encode(Transform.schema, session.world.get(entity, Transform)).join();
    await t.runUntil(
      () =>
        encode(Transform.schema, client.mirror.read(entity, Transform)).join() === transformBytes,
      60,
      'the resting Transform replicated',
    );
    beacons.push(1);
    await t.runUntil(() => t.beaconsSeen().includes(1), 60, 'beacon 1');

    // --- Offline: the connection drops and attempts cannot reach the server.
    t.net.online = false;
    const lostAt = await t.loseConnection();
    expect(client.state).toBe('Reconnecting');
    expect(t.disconnects).toEqual([{ code: 1006, reason: '', willReconnect: true, at: lostAt }]);
    await t.frames(2);
    expect(session.players().map((p) => p.state)).toEqual([PlayerState.Away]);
    // The player keeps steering, and the session emits an event while the player is away.
    beacons.push(2);
    for (let i = 0; timers.now < lostAt + 2500; i++) {
      client.sendInput(steer(i < 60 ? 7 : 0));
      await t.frame();
    }
    expect(t.attempts.slice(1).map((at) => at - lostAt)).toEqual([500, 1500]);
    expect(t.transports.every((tr) => tr.bufferedAmount() === 0)).toBe(true);
    expect(session.world.get(entity, Transform).pos.x).toBe(restX);

    // --- Online: the next attempt, 2000 ms after the second failed, resyncs.
    t.net.online = true;
    await t.runUntil(() => client.state === 'Playing', 200, 'Playing again');
    // Waits of RECONNECT_DELAYS_MS[0..2]: 500, then 1000 and 2000 ms after each failure.
    expect(t.attempts.slice(1).map((at) => at - lostAt)).toEqual([500, 1500, 3500]);
    expect(t.edges().slice(-3)).toEqual([
      'Playing->Reconnecting',
      'Reconnecting->Resyncing',
      'Resyncing->Playing',
    ]);
    expect(t.disconnects).toHaveLength(1);
    expect([client.playerId, client.entity, client.reconnectToken]).toEqual([
      playerId,
      entity,
      reconnectToken,
    ]);
    expect(session.players().map((p) => [p.playerId, p.state, p.entity])).toEqual([
      [playerId, PlayerState.Playing, entity],
    ]);
    expect(t.leaves).toEqual([]);

    // The Welcome emptied the replica; the first snapshot after it is FULL from baseline 0, and it
    // replaced the replica wholesale.
    const welcome = t.welcomes.at(-1)!;
    expect(welcome).toMatchObject({ state: 'Resyncing', mirrorSize: 0 });
    const resynced = t.snapshots.filter((s) => s.at >= welcome.at);
    expect(resynced).toHaveLength(1); // so the comparison below is the FULL snapshot's replica
    const full = resynced[0]!;
    expect(full.header.flags & SNAPSHOT_FLAG_FULL).toBe(SNAPSHOT_FLAG_FULL);
    expect(full.header.baselineTick).toBe(0);
    expect(full.state).toBe('Resyncing');
    expect(full.createdTicks.every((tick) => tick === full.header.serverTick)).toBe(true);
    const playingAt = t.states.at(-1)!.at;
    expect(playingAt).toBe(full.at);
    expect(client.mirror.has(entity)).toBe(true);
    expectReplicaMatchesServer(client, session);
    await t.frames(10);
    expect(t.snapshots.slice(-1)[0]!.header.flags & SNAPSHOT_FLAG_FULL).toBe(0);
    expectReplicaMatchesServer(client, session);

    // Input: nothing went out between the drop and Playing again, the new connection's first Input
    // starts from an empty ring, and the steering of the outage was not replayed.
    const outage = t.sent.filter((s) => s.at >= lostAt && s.at < playingAt);
    expect(outage.flatMap((s) => s.messages.map((m) => m.name))).toEqual([
      'Hello',
      'Ping',
      'RegionLoadState',
    ]);
    const conn = t.transports.length - 1;
    const inputs = t.sent
      .filter((s) => s.conn === conn)
      .flatMap((s) => s.messages)
      .filter((m) => m.name === 'Input')
      .map((m) => m.payload as InputPayload<Frame>);
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs[0]!.frames).toHaveLength(1);
    expect(inputs.every((p) => p.frames.length <= INPUT_FRAMES_PER_MESSAGE)).toBe(true);
    expect(inputs.every((p) => p.frames.every((fr) => fr.throttle === 0))).toBe(true);
    expect(session.world.get(entity, Transform).pos.x).toBe(restX);

    // Driving works again, and the replica follows.
    client.sendInput(steer(5));
    await t.runUntil(() => session.world.get(entity, Transform).pos.x > restX + 1, 60, 'driving');
    client.sendInput(steer(0));
    await t.frames(20);
    expectReplicaMatchesServer(client, session);

    // Events: the one emitted while away never arrives; a new one does.
    beacons.push(3);
    await t.runUntil(() => t.beaconsSeen().includes(3), 60, 'beacon 3');
    expect(t.beaconsSeen()).toEqual([1, 3]);

    client.disconnect();
    await session.stop();
    expect(t.problems).toEqual([]);
    expect(session.stats.staleInputs).toBe(0);
    expect(session.stats.badInput).toBe(0);
  });

  it('after the server-side grace expired, the reconnect is a fresh join: the same slot, a new token and entity, through Joined', async () => {
    const t = await setup({ reconnectGraceMs: 1000 });
    const { session, client } = t;
    await t.play();
    const { playerId, entity, reconnectToken } = client;

    t.net.online = false;
    const lostAt = await t.loseConnection();
    await t.runUntil(() => t.leaves.length === 1, 120, 'the grace expiry');
    expect(t.leaves).toEqual(['A']);
    expect(session.world.alive(entity)).toBe(false);
    expect(session.players()).toEqual([]);
    expect(client.state).toBe('Reconnecting');

    t.net.online = true;
    await t.runUntil(() => client.state === 'Playing', 300, 'Playing after the fresh join');
    expect(t.attempts.slice(1).map((at) => at - lostAt)).toEqual([500, 1500]);
    expect(t.edges().slice(-5)).toEqual([
      'Playing->Reconnecting',
      'Reconnecting->Joined',
      'Joined->Loading',
      'Loading->Ready',
      'Ready->Playing',
    ]);
    expect(t.disconnects.map(({ willReconnect }) => willReconnect)).toEqual([true]);
    // The freed slot is handed out again: only the token tells the fresh join from a resync.
    expect(client.playerId).toBe(playerId);
    expect(client.reconnectToken).not.toBe(reconnectToken);
    expect(client.entity).not.toBe(entity);
    expect(session.players().map((p) => [p.playerId, p.state, p.entity])).toEqual([
      [playerId, PlayerState.Playing, client.entity],
    ]);
    await t.frames(10);
    expect(client.mirror.has(entity)).toBe(false);
    expectReplicaMatchesServer(client, session);

    // The new token works for the next drop.
    const lostAgain = await t.loseConnection();
    await t.runUntil(() => client.state === 'Playing', 120, 'Playing after a resync');
    expect(t.attempts.at(-1)! - lostAgain).toBe(RECONNECT_DELAYS_MS[0]);
    expect(t.edges().slice(-2)).toEqual(['Reconnecting->Resyncing', 'Resyncing->Playing']);
    expect(t.leaves).toEqual(['A']);

    client.disconnect();
    await session.stop();
    expect(t.problems).toEqual([]);
  });

  it('Kicked{ServerShutdown} + 1001 reconnects after the backoff, and the stopped session answering Rejected ends it for good', async () => {
    const t = await setup();
    const { session, client, timers } = t;
    await t.play();

    await session.stop();
    await t.runUntil(() => client.state !== 'Playing', 5, 'the shutdown reaches the client');
    expect(client.state).toBe('Reconnecting');
    expect(t.kicks).toEqual([{ reason: KickReason.ServerShutdown }]);
    const lostAt = t.disconnects[0]!.at;
    expect(t.disconnects).toEqual([
      { code: 1001, reason: 'server shutdown', willReconnect: true, at: lostAt },
    ]);

    await t.runUntil(() => client.state === 'Disconnected', 60, 'Disconnected');
    expect(t.attempts.slice(1).map((at) => at - lostAt)).toEqual([RECONNECT_DELAYS_MS[0]]);
    expect(t.rejections).toEqual([
      { reason: RejectReason.SessionNotRunning, detail: 'session not running' },
    ]);
    expect(t.edges().slice(-2)).toEqual(['Playing->Reconnecting', 'Reconnecting->Disconnected']);
    expect(t.disconnects).toHaveLength(1); // Rejected is reported as 'rejected'
    timers.advance(10 * RECONNECT_DELAYS_MS.reduce((a, b) => a + b, 0));
    expect(t.attempts).toHaveLength(2);
    expect(client.state).toBe('Disconnected');
    expect(t.problems).toEqual([
      {
        side: 'client',
        level: 'warn',
        msg: 'Rejected: SessionNotRunning \u{2014} session not running',
        data: undefined,
      },
    ]);
  });

  it('a Rejected connect never reconnects', async () => {
    const t = await setup();
    const stale = new SchemaRegistry({
      components,
      messages: [],
      events: [RegionChanged, Beacon, defineEvent('Extra', { n: f.u8 })],
      input: Input,
    });
    const rejections: RejectedPayload[] = [];
    const attempts: number[] = [];
    const client = new NetClient({
      url: 'memory://dev',
      game: { ...game, registry: stale, input: stale.input },
      token: 'dev',
      displayName: 'Old',
      transport: MemoryTransport.factory(
        (link) => {
          attempts.push(t.timers.now);
          t.session.attach(link);
        },
        { timers: t.timers, latencyMs: 5 },
      ),
      now: t.timers.nowFn,
      timers: t.timers,
      log: () => {},
    });
    client.on('rejected', (r) => rejections.push(r));
    const connected = client.connect();
    const outcome = connected.then(
      () => null,
      (err: unknown) => err,
    );
    for (let i = 0; i < 10; i++) await t.frame();
    const err = await outcome;
    expect(err).toBeInstanceOf(ConnectError);
    expect(err).toMatchObject({ kind: 'rejected' });
    expect(rejections.map((r) => r.reason)).toEqual([RejectReason.SchemaMismatch]);
    for (let i = 0; i < 40; i++) {
      t.timers.advance(1000);
      await settle();
    }
    expect(attempts).toHaveLength(1);
    expect(client.state).toBe('Disconnected');
    await t.session.stop();
  });

  it('disconnect() while Reconnecting stops the attempts; the server keeps the player away until its grace ends', async () => {
    const t = await setup({ reconnectGraceMs: 5000 });
    const { session, client } = t;
    await t.play();
    t.net.online = false;
    const lostAt = await t.loseConnection();
    await t.runUntil(() => t.attempts.length === 2, 40, 'the first attempt');
    await t.frame();
    expect(client.state).toBe('Reconnecting');

    client.disconnect();
    expect(client.state).toBe('Disconnected');
    expect(t.disconnects.map(({ at: _at, ...info }) => info)).toEqual([
      { code: 1006, reason: '', willReconnect: true },
      { code: 1000, reason: 'client disconnect', willReconnect: false },
    ]);
    expect(t.edges().slice(-2)).toEqual(['Playing->Reconnecting', 'Reconnecting->Disconnected']);
    t.net.online = true;
    for (let i = 0; i < 40; i++) {
      t.timers.advance(500);
      await settle();
    }
    expect(t.attempts.slice(1).map((at) => at - lostAt)).toEqual([RECONNECT_DELAYS_MS[0]]);
    expect(client.state).toBe('Disconnected');
    // Nothing could tell the server: the player went away and left when the grace ended.
    expect(t.leaves).toEqual(['A']);
    expect(session.players()).toEqual([]);

    await session.stop();
    expect(t.problems).toEqual([]);
  });

  it('stats(): bytesInPerSec and bytesOutPerSec count the last second of frames, are plausible for the traffic, fall to 0 in an outage and recover', async () => {
    const t = await setup();
    const { client, timers } = t;
    await t.play();
    client.sendInput(steer(3));
    await t.frames(90); // 1.4 s of steady traffic

    const lastSecond = <T extends { at: number }>(list: readonly T[]): T[] =>
      list.filter((m) => m.at > timers.now - 1000);
    let stats = client.stats();
    expect(stats.bytesInPerSec).toBe(sum(lastSecond(t.received)));
    expect(stats.bytesOutPerSec).toBe(sum(lastSecond(t.sent)));
    expect(stats.bytesIn).toBe(sum(t.received));
    expect(stats.bytesOut).toBe(sum(t.sent));
    // Out: one Input per client tick (60 Hz), an Ack per snapshot (20 Hz), a Ping per second.
    const out = lastSecond(t.sent).flatMap((s) => s.messages.map((m) => m.name));
    const count = (name: string): number => out.filter((n) => n === name).length;
    expect(count('Input')).toBeGreaterThanOrEqual(59);
    expect(count('Input')).toBeLessThanOrEqual(61);
    expect(count('Ack')).toBeGreaterThanOrEqual(19);
    expect(count('Ack')).toBeLessThanOrEqual(21);
    expect(stats.bytesOutPerSec / lastSecond(t.sent).length).toBeGreaterThan(10); // bytes per frame
    expect(stats.bytesOutPerSec).toBeLessThan(5000);
    // In: about 20 snapshot frames (the moving car's updates) and a Pong.
    expect(lastSecond(t.received).length).toBeGreaterThanOrEqual(19);
    expect(stats.bytesInPerSec).toBeGreaterThan(19 * 30);
    expect(stats.bytesInPerSec).toBeLessThan(20_000);

    // Offline for longer than the window: both rates fall to 0.
    t.net.online = false;
    await t.loseConnection();
    await t.frames(70);
    stats = client.stats();
    expect(stats).toMatchObject({ bytesInPerSec: 0, bytesOutPerSec: 0 });
    expect(stats.bytesIn).toBe(sum(t.received));

    t.net.online = true;
    await t.runUntil(() => client.state === 'Playing', 400, 'Playing again');
    await t.frames(70);
    stats = client.stats();
    expect(stats.bytesInPerSec).toBe(sum(lastSecond(t.received)));
    expect(stats.bytesOutPerSec).toBe(sum(lastSecond(t.sent)));
    expect(stats.bytesInPerSec).toBeGreaterThan(19 * 30);
    expect(stats.bytesOutPerSec).toBeGreaterThan(59 * 10);

    client.disconnect();
    await t.session.stop();
    expect(t.problems).toEqual([]);
  });
});
