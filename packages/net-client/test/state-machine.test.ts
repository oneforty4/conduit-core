import {
  CoreKind,
  DEFAULT_SNAPSHOT_LIMITS,
  PROTOCOL_SESSION_CAPACITY_MAX,
  createCompatibilityDescriptor,
  ENTITY_NONE,
  FrameWriter,
  HelloSchema,
  type HelloPayload,
  type InputFrameBase,
  type InputPayload,
  KickReason,
  REGION_IDX_NONE,
  RejectReason,
  SessionStateSchema,
  SNAPSHOT_FLAG_FULL,
  type SnapshotData,
  type WelcomePayload,
  WIRE_VERSION,
} from '@conduit/protocol';
import { Transform } from '@conduit/sim';
import { GridWorld } from '@conduit/world';
import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  canTransition,
  CLIENT_STATES,
  CLIENT_TRANSITIONS,
  type ClientState,
  CONNECT_TIMEOUT_MS,
  ConnectError,
  describeRejected,
  type DisconnectInfo,
  gcLagTicks,
  isReconnectableClose,
  kickReasonName,
  type LogLevel,
  MemoryTransport,
  NetClient,
  type NetClientOptions,
  PING_INTERVAL_MS,
  QUICK_PING_MS,
  QUICK_PINGS,
  RECONNECT_DELAYS_MS,
  rejectReasonName,
} from '../src/index.ts';
import {
  Chat,
  ManualTimers,
  Notice,
  ScriptedServer,
  Shout,
  testGame,
  testRegistry,
} from './helpers.ts';

type Harness = ReturnType<typeof harness>;

function harness(opts: Partial<NetClientOptions> = {}, transportOpts: { autoOpen?: boolean } = {}) {
  const timers = new ManualTimers();
  const registry = testRegistry();
  const servers: ScriptedServer[] = [];
  const transports: MemoryTransport[] = [];
  const urls: string[] = [];
  const logs: { level: LogLevel; msg: string; data: object | undefined }[] = [];
  const client = new NetClient({
    url: 'memory://session/dev',
    game: testGame(registry),
    token: 'dev-token',
    displayName: 'Ann',
    transport: (url) => {
      urls.push(url);
      const t = new MemoryTransport({ timers, ...transportOpts });
      transports.push(t);
      servers.push(new ScriptedServer(t.link, registry));
      return t;
    },
    now: timers.nowFn,
    timers,
    log: (level, msg, data) => logs.push({ level, msg, data }),
    ...opts,
  });
  const states: string[] = [];
  const disconnects: DisconnectInfo[] = [];
  const errors: unknown[] = [];
  client.on('state', (s, prev) => states.push(`${prev}->${s}`));
  client.on('disconnected', (info) => disconnects.push(info));
  client.on('error', (err) => errors.push(err));
  const server = (): ScriptedServer => {
    const s = servers.at(-1);
    if (s === undefined) throw new Error('no connection yet');
    return s;
  };
  return {
    timers,
    registry,
    client,
    servers,
    transports,
    urls,
    logs,
    states,
    disconnects,
    errors,
    server,
  };
}

async function joined(h: Harness): Promise<void> {
  const p = h.client.connect();
  h.timers.flush();
  h.server().welcome();
  h.timers.flush();
  await p;
  expect(h.client.state).toBe('Joined');
}

async function playing(h: Harness): Promise<void> {
  await joined(h);
  h.server().regionSet(['cell/1_1'], ['cell/0_1']);
  h.timers.flush();
  h.server().spawned(2, 1234);
  h.timers.flush();
  expect(h.client.state).toBe('Playing');
}

function fullSnapshot(h: Harness, tick: number, entities: number[]): SnapshotData {
  const tId = h.registry.componentId(Transform);
  return {
    header: {
      serverTick: tick,
      serverTimeMs: Math.round((tick * 1000) / 60),
      baselineTick: 0,
      lastInputSeq: 0,
      lastInputTick: 0,
      flags: SNAPSHOT_FLAG_FULL,
    },
    regions: [],
    // Producers send records in ascending entity order (docs/protocol.md 9.11).
    creates: [...entities]
      .sort((a, b) => a - b)
      .map((entity) => ({
        entity,
        regionIdx: REGION_IDX_NONE,
        components: [
          {
            id: tId,
            value: {
              pos: { x: 1, y: 0, z: 2 },
              rot: { x: 0, y: 0, z: 0, w: 1 },
              vel: { x: 0, y: 0, z: 0 },
            },
          },
        ],
      })),
    updates: [],
    destroys: [],
  };
}

describe('NetClient: Disconnected → Connecting → Handshaking', () => {
  it('connect() creates the transport; onOpen sends Hello as seq 0, tick 0', async () => {
    const h = harness();
    const p = h.client.connect();
    expect(h.client.connect()).toBe(p);
    expect(h.client.state).toBe('Connecting');
    expect(h.urls).toEqual(['memory://session/dev']);
    expect(h.server().received).toEqual([]);
    h.timers.flush();
    expect(h.client.state).toBe('Handshaking');
    expect(h.states).toEqual(['Disconnected->Connecting', 'Connecting->Handshaking']);
    const hello = h.server().received[0]!;
    expect(hello.name).toBe('Hello');
    expect(hello.header).toMatchObject({ kind: CoreKind.Hello, seq: 0, tick: 0 });
    expect(hello.payload).toEqual({
      maxSessionCapacity: PROTOCOL_SESSION_CAPACITY_MAX,
      snapshotLimits: DEFAULT_SNAPSHOT_LIMITS,
      protocolVersion: 7,
      compatibility: createCompatibilityDescriptor('test-game'),
      registryHash: h.registry.hash,
      sessionToken: 'dev-token',
      reconnectToken: '',
      displayName: 'Ann',
    } satisfies HelloPayload);
    h.client.disconnect();
    await expect(p).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('setTarget replaces the url and Hello token of the next connect(), only while Disconnected', async () => {
    const h = harness();
    await joined(h);
    expect(() => h.client.setTarget('memory://session/next', 'next-token')).toThrow(
      'NetClient.setTarget: only while Disconnected, not Joined',
    );
    h.client.disconnect();
    expect(() => h.client.setTarget('memory://session/next', 'x'.repeat(2049))).toThrow(RangeError);
    h.client.setTarget('memory://session/next', 'next-token');
    const p = h.client.connect();
    h.timers.flush();
    expect(h.urls).toEqual(['memory://session/dev', 'memory://session/next']);
    expect(h.server().received[0]?.payload).toMatchObject({
      sessionToken: 'next-token',
      reconnectToken: '',
      displayName: 'Ann',
    });
    h.client.disconnect();
    await expect(p).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('Hello bytes on open are exactly one Hello message in its own frame', async () => {
    const h = harness();
    const frames: Uint8Array[] = [];
    const p = h.client.connect();
    h.transports[0]!.link.onMessage((buf) => frames.push(buf));
    h.timers.flush();
    const fw = new FrameWriter();
    fw.begin();
    fw.message(CoreKind.Hello, 0, 0, (w) =>
      HelloSchema.encode(w, {
        maxSessionCapacity: PROTOCOL_SESSION_CAPACITY_MAX,
        snapshotLimits: DEFAULT_SNAPSHOT_LIMITS,
        protocolVersion: 7,
        compatibility: createCompatibilityDescriptor('test-game'),
        registryHash: h.registry.hash,
        sessionToken: 'dev-token',
        reconnectToken: '',
        displayName: 'Ann',
      }),
    );
    const expected = fw.finish();
    expect(frames).toHaveLength(1);
    expect([...frames[0]!]).toEqual([...expected]);
    expect(frames[0]![0]).toBe(WIRE_VERSION);
    h.client.disconnect();
    await expect(p).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('rejects connect() when the factory throws, staying Disconnected', async () => {
    const h = harness({
      transport: () => {
        throw new Error('no WebSocket');
      },
    });
    await expect(h.client.connect()).rejects.toThrow('no WebSocket');
    expect(h.client.state).toBe('Disconnected');
    expect(h.states).toEqual([]);
  });

  it('Connecting: connect timeout → Disconnected, connect() rejects', async () => {
    const h = harness({}, { autoOpen: false });
    const p = h.client.connect();
    h.timers.advance(CONNECT_TIMEOUT_MS - 1);
    expect(h.client.state).toBe('Connecting');
    h.timers.advance(1);
    await expect(p).rejects.toMatchObject({ name: 'ConnectError', kind: 'timeout' });
    expect(h.client.state).toBe('Disconnected');
    expect(h.disconnects).toEqual([
      { code: 1006, reason: 'connect timeout', willReconnect: false },
    ]);
    expect(h.transports[0]!.closed).toBe(true);
  });

  it('Connecting: onClose → Disconnected with the close code', async () => {
    const h = harness({}, { autoOpen: false });
    const p = h.client.connect();
    h.transports[0]!.link.close(4009, 'full');
    h.timers.flush();
    await expect(p).rejects.toMatchObject({ kind: 'closed', code: 4009 });
    expect(h.states).toEqual(['Disconnected->Connecting', 'Connecting->Disconnected']);
    expect(h.disconnects).toEqual([{ code: 4009, reason: 'full', willReconnect: false }]);
  });

  it('Handshaking: onError → Disconnected, error emitted', async () => {
    const h = harness();
    const p = h.client.connect();
    h.timers.flush();
    const boom = new Error('socket error');
    h.transports[0]!.fail(boom);
    await expect(p).rejects.toMatchObject({ kind: 'error', cause: boom });
    expect(h.errors).toContain(boom);
    expect(h.client.state).toBe('Disconnected');
    expect(h.disconnects).toEqual([
      { code: 1006, reason: 'transport error', willReconnect: false },
    ]);
    h.timers.flush(); // the transport's own close event is ignored
    expect(h.disconnects).toHaveLength(1);
  });

  it('Handshaking: no Welcome within CONNECT_TIMEOUT_MS → Disconnected', async () => {
    const h = harness();
    const p = h.client.connect();
    h.timers.flush();
    expect(h.client.state).toBe('Handshaking');
    h.timers.advance(CONNECT_TIMEOUT_MS);
    await expect(p).rejects.toBeInstanceOf(ConnectError);
    expect(h.client.state).toBe('Disconnected');
    h.timers.flush();
    expect(h.server().closed?.code).toBe(1000);
  });

  it('Handshaking: onClose → Disconnected', async () => {
    const h = harness();
    const p = h.client.connect();
    h.timers.flush();
    h.server().link.close(4000, 'handshake timeout');
    h.timers.flush();
    await expect(p).rejects.toMatchObject({ kind: 'closed', code: 4000 });
    expect(h.disconnects).toEqual([
      { code: 4000, reason: 'handshake timeout', willReconnect: false },
    ]);
  });
});

describe('NetClient: Rejected (Spike 5)', () => {
  it('Rejected never reconnects', async () => {
    const h = harness({ autoReconnect: true });
    const rejected: unknown[] = [];
    h.client.on('rejected', (r) => rejected.push(r));
    const p = h.client.connect();
    h.timers.flush();
    h.server().rejected(RejectReason.SchemaMismatch, 'please refresh');
    h.server().link.close(4005, 'schema mismatch');
    h.timers.flush();
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConnectError);
    expect(err).toMatchObject({
      kind: 'rejected',
      message: 'Rejected: SchemaMismatch \u{2014} please refresh',
      rejected: { reason: RejectReason.SchemaMismatch, detail: 'please refresh' },
    });
    expect(rejected).toEqual([{ reason: RejectReason.SchemaMismatch, detail: 'please refresh' }]);
    expect(h.client.state).toBe('Disconnected');
    expect(h.states).toEqual([
      'Disconnected->Connecting',
      'Connecting->Handshaking',
      'Handshaking->Disconnected',
    ]);
    const total = RECONNECT_DELAYS_MS.reduce((a, b) => a + b, 0);
    h.timers.advance(10 * total + CONNECT_TIMEOUT_MS);
    expect(h.urls).toHaveLength(1);
    expect(h.client.state).toBe('Disconnected');
    expect(h.timers.pending()).toBe(0);
    expect(h.disconnects).toEqual([]);
  });

  it('stays down even when a reconnectable close code follows the Rejected', async () => {
    const h = harness({ autoReconnect: true });
    const p = h.client.connect();
    h.timers.flush();
    h.server().rejected(RejectReason.SessionNotRunning, '');
    h.server().link.close(1001, 'restarting');
    h.timers.flush();
    await expect(p).rejects.toMatchObject({
      kind: 'rejected',
      message: 'Rejected: SessionNotRunning',
    });
    h.timers.advance(60_000);
    expect(h.urls).toHaveLength(1);
    expect(h.client.state).toBe('Disconnected');
  });
});

describe('NetClient: Handshaking → Joined → Loading → Ready → Playing', () => {
  it('Welcome → Joined: resolves connect(), stores ids, syncs the clock, builds the graph, sends Ready and Ping', async () => {
    const h = harness();
    const welcomes: unknown[] = [];
    h.client.on('welcome', (w) => welcomes.push(w));
    expect(h.client.playerId).toBe(-1);
    const p = h.client.connect();
    h.timers.flush();
    const w = h
      .server()
      .welcome({ playerId: 3, worldSeed: 4242, serverTick: 600, serverTimeMs: 10_000 });
    h.timers.flush();
    await expect(p).resolves.toBeUndefined();
    expect(h.client.state).toBe('Joined');
    expect(welcomes).toEqual([w]);
    expect(h.client.playerId).toBe(3);
    expect(h.client.reconnectToken).toBe('tok-abc');
    expect(h.client.entity).toBe(ENTITY_NONE);
    expect(h.client.clock.synced).toBe(true);
    expect(h.client.clock.serverTickNow()).toBe(600);
    const expected = new GridWorld({ cellSize: 100, cols: 4, rows: 4, worldSeed: 4242 });
    expect(h.client.graph?.get('cell/1_1')?.seed).toBe(expected.get('cell/1_1')?.seed);
    expect(h.server().names()).toEqual(['Hello', 'Ready', 'Ping']);
    expect(h.server().last('Ready')?.header.tick).toBe(600);
    // A few quick Pings, to measure the RTT soon and well, then one a second.
    h.timers.advance(QUICK_PING_MS * QUICK_PINGS);
    expect(h.server().all('Ping')).toHaveLength(1 + QUICK_PINGS);
    h.timers.advance(PING_INTERVAL_MS);
    expect(h.server().all('Ping')).toHaveLength(2 + QUICK_PINGS);
  });

  it('uses the Welcome rates, and Pongs feed the RTT estimate', async () => {
    const h = harness();
    const p = h.client.connect();
    h.timers.flush();
    h.server().welcome({ simTickRate: 30, snapshotEvery: 2 });
    h.timers.flush();
    await p;
    expect(h.client.clock.tickRate).toBe(30);
    expect(h.client.mirror.snapshotEvery).toBe(2);
    const ping = h.server().last('Ping')!.payload as { clientTimeMs: number };
    h.timers.advance(40);
    h.server().pong(ping.clientTimeMs, 2100, 63);
    h.timers.flush();
    expect(h.client.stats().rttMs).toBe(40);
  });

  it('autoReady false: Ready only on ready(), once', async () => {
    const h = harness({ autoReady: false });
    await joined(h);
    expect(h.server().names()).toEqual(['Hello', 'Ping']);
    h.client.ready();
    h.client.ready();
    h.timers.flush();
    expect(h.server().all('Ready')).toHaveLength(1);
    expect(h.logs.some((l) => l.msg === 'ready() ignored')).toBe(true);
  });

  it('RegionSet → Loading → Ready, reporting every listed region loaded', async () => {
    const h = harness();
    const sets: unknown[] = [];
    h.client.on('regionSet', (r) => sets.push(r));
    const loadedEvents: string[] = [];
    h.client.regions.on('regionLoaded', (id) => loadedEvents.push(id));
    await joined(h);
    h.server().regionSet(['cell/1_1', 'cell/0_1'], ['cell/2_2']);
    h.timers.flush();
    expect(h.client.state).toBe('Ready');
    expect(h.states.slice(-2)).toEqual(['Joined->Loading', 'Loading->Ready']);
    expect(sets).toEqual([{ active: ['cell/1_1', 'cell/0_1'], prefetch: ['cell/2_2'] }]);
    expect(h.server().last('RegionLoadState')?.payload).toEqual({
      loaded: ['cell/0_1', 'cell/1_1', 'cell/2_2'],
      loading: [],
    });
    expect(h.client.regions.loaded()).toEqual(['cell/0_1', 'cell/1_1', 'cell/2_2']);
    expect(h.client.regions.loading()).toEqual([]);
    expect(loadedEvents).toEqual(['cell/0_1', 'cell/1_1', 'cell/2_2']);

    // A later RegionSet releases dropped regions and re-reports.
    const unloaded: string[] = [];
    h.client.regions.on('regionUnloaded', (id) => unloaded.push(id));
    h.server().regionSet(['cell/1_1'], []);
    h.timers.flush();
    expect(h.client.state).toBe('Ready');
    expect(unloaded).toEqual(['cell/0_1', 'cell/2_2']);
    expect(h.server().last('RegionLoadState')?.payload).toEqual({
      loaded: ['cell/1_1'],
      loading: [],
    });
  });

  it('Ready → Playing on its own Spawned; other players do not change the state; Input every client tick', async () => {
    const h = harness();
    const spawned: unknown[] = [];
    h.client.on('spawned', (s) => spawned.push(s));
    await joined(h);
    h.server().regionSet(['cell/1_1']);
    h.timers.flush();
    h.server().spawned(5, 777, 'cell/0_0');
    h.timers.flush();
    expect(h.client.state).toBe('Ready');
    expect(h.client.entity).toBe(ENTITY_NONE);
    h.server().spawned(2, 1234, 'cell/1_1');
    h.timers.flush();
    expect(h.client.state).toBe('Playing');
    expect(h.client.entity).toBe(1234);
    expect(spawned).toEqual([
      { playerId: 5, entity: 777, regionId: 'cell/0_0' },
      { playerId: 2, entity: 1234, regionId: 'cell/1_1' },
    ]);

    const input: InputFrameBase & { throttle: number; buttons: number } = {
      tick: 0,
      throttle: 5,
      buttons: 2,
    };
    h.client.sendInput(input);
    h.timers.advance(100);
    const inputs = h.server().all('Input');
    expect(inputs.length).toBeGreaterThanOrEqual(5);
    expect(inputs.length).toBeLessThanOrEqual(7);
    for (const msg of inputs) {
      const payload = msg.payload as InputPayload<InputFrameBase & { throttle: number }>;
      expect(payload.frames.length).toBeGreaterThanOrEqual(1);
      expect(payload.frames.length).toBeLessThanOrEqual(4);
      expect(payload.firstTick).toBe(payload.frames[0]!.tick);
      const ticks = payload.frames.map((fr) => fr.tick);
      expect([...ticks].sort((a, b) => a - b)).toEqual(ticks);
      expect(new Set(ticks).size).toBe(ticks.length);
      expect(payload.frames.at(-1)!.throttle).toBe(5);
    }
    for (const msg of inputs) {
      // Frames target at least serverTickNow + inputLead (1 at RTT 0); the envelope carries serverTickNow.
      const payload = msg.payload as InputPayload;
      expect(payload.frames.at(-1)!.tick).toBeGreaterThanOrEqual(msg.header.tick + 1);
    }
  });

  it('an own Spawned that arrives before the regions are ready waits for Ready', async () => {
    const h = harness();
    await joined(h);
    h.server().spawned(2, 99);
    h.timers.flush();
    expect(h.client.state).toBe('Joined');
    h.server().regionSet(['cell/1_1']);
    h.timers.flush();
    expect(h.client.state).toBe('Playing');
    expect(h.states.slice(-3)).toEqual(['Joined->Loading', 'Loading->Ready', 'Ready->Playing']);
  });

  it('reportRegions de-duplicates and sorts, drops loading ids that are loaded, and gates Ready', async () => {
    const h = harness();
    await joined(h);
    h.client.reportRegions(['b', 'a', 'b'], ['c', 'a']);
    h.timers.flush();
    expect(h.server().last('RegionLoadState')?.payload).toEqual({
      loaded: ['a', 'b'],
      loading: ['c'],
    });
  });

  it('SessionState updates players', async () => {
    const h = harness();
    await joined(h);
    const players = [
      { playerId: 0, name: 'Bob', state: 2, entity: 55 },
      { playerId: 2, name: 'Ann', state: 0, entity: 0 },
    ];
    h.server().sessionState(players);
    h.timers.flush();
    expect(h.client.players).toEqual(players);
  });
});

describe('NetClient: Playing', () => {
  it('applies a Snapshot, then samples the clock, acks it and emits snapshot', async () => {
    const h = harness();
    await playing(h);
    const seen: { tick: number; applied: boolean }[] = [];
    h.client.on('snapshot', (header) =>
      seen.push({ tick: header.serverTick, applied: h.client.mirror.has(1234) }),
    );
    h.server().snapshot(fullSnapshot(h, 150, [1234, 1300]));
    h.timers.flush();
    expect(seen).toEqual([{ tick: 150, applied: true }]);
    expect(h.client.mirror.read(1234, Transform)?.pos).toEqual({ x: 1, y: 0, z: 2 });
    expect(h.server().last('Ack')?.payload).toEqual({ lastSnapshotTick: 150 });
    expect(h.client.stats()).toMatchObject({ snapshots: 1, lastSnapshotTick: 150 });
    expect(h.client.clock.samples().length).toBeGreaterThanOrEqual(2);
  });

  it('update() slews the clock and is the gc caller: destroyed entities go GC_LAG_TICKS behind the render tick', async () => {
    const h = harness();
    await playing(h);
    const tick0 = h.client.clock.serverTickNow();
    const t = tick0 + 3 - ((tick0 + 3) % 3);
    h.server().snapshot(fullSnapshot(h, t, [1234, 4321]));
    h.timers.flush();
    const destroy: SnapshotData = { ...fullSnapshot(h, t + 3, []), destroys: [4321] };
    destroy.header = { ...destroy.header, flags: 0, baselineTick: t };
    h.server().snapshot(destroy);
    h.timers.flush();
    expect(h.client.mirror.get(4321)?.destroyedTick).toBe(t + 3);
    let previousRenderTick = -Infinity;
    for (let i = 0; i < 400 && h.client.mirror.has(4321); i++) {
      previousRenderTick = h.client.clock.renderTick();
      h.timers.advance(16);
      h.client.update();
    }
    expect(h.client.mirror.has(4321)).toBe(false);
    const lag = gcLagTicks(3);
    expect(Math.floor(h.client.clock.renderTick()) - lag).toBeGreaterThan(t + 3);
    expect(Math.floor(previousRenderTick) - lag).toBeLessThanOrEqual(t + 3);
    expect(h.client.mirror.has(1234)).toBe(true);
  });

  it('send(): c2s and both game messages in their own frame; s2c or unknown throw', async () => {
    const h = harness();
    h.client.send(Chat, { text: 'too early' });
    expect(h.logs.some((l) => l.msg === 'send(Chat) dropped')).toBe(true);
    await joined(h);
    h.client.send(Chat, { text: 'hi' });
    h.client.send(Shout, { text: 'HEY' });
    h.timers.flush();
    expect(h.server().last('Chat')?.payload).toEqual({ text: 'hi' });
    expect(h.server().last('Shout')?.payload).toEqual({ text: 'HEY' });
    expect(() => h.client.send(Notice, { text: 'nope' })).toThrow(RangeError);
    expect(() =>
      h.client.send(
        { name: 'Nope', direction: 'c2s', schema: SessionStateSchema, core: false },
        { players: [] },
      ),
    ).toThrow(RangeError);
  });

  it('emits s2c game messages on arrival and counts ignored kinds', async () => {
    const h = harness();
    const messages: unknown[] = [];
    h.client.on('message', (m) =>
      messages.push({ name: m.def.name, tick: m.tick, payload: m.payload }),
    );
    await joined(h);
    h.server().send(h.registry.messageKind(Notice), Notice.schema, { text: 'welcome aboard' }, 777);
    h.server().send(h.registry.messageKind(Chat), Chat.schema, { text: 'hello' }, 778);
    h.server().send(h.registry.messageKind(Shout), Shout.schema, { text: 'wrong way' });
    h.server().frame([
      { kind: 200, encode: () => {} },
      { kind: CoreKind.Ready, encode: () => {} },
    ]);
    h.timers.flush();
    expect(messages).toEqual([
      { name: 'Notice', tick: 777, payload: { text: 'welcome aboard' } },
      { name: 'Chat', tick: 778, payload: { text: 'hello' } },
    ]);
    expect(h.client.stats().ignoredMessages).toBe(3);
  });

  it('Kicked with a final reason, then the close → Disconnected; client ticks stop', async () => {
    const h = harness();
    const kicks: unknown[] = [];
    h.client.on('kicked', (k) => kicks.push(k));
    await playing(h);
    h.server().kicked(KickReason.Replaced);
    h.server().link.close(4006, 'replaced');
    h.timers.flush();
    expect(kicks).toEqual([{ reason: KickReason.Replaced }]);
    expect(h.client.state).toBe('Disconnected');
    expect(h.disconnects).toEqual([{ code: 4006, reason: 'replaced', willReconnect: false }]);
    expect(h.client.entity).toBe(ENTITY_NONE);
    expect(h.client.playerId).toBe(-1);
    const inputs = h.server().all('Input').length;
    h.timers.advance(5000);
    expect(h.server().all('Input')).toHaveLength(inputs);
    expect(h.timers.pending()).toBe(0);
    expect(h.urls).toHaveLength(1);
  });

  it('disconnect() sends Leave, closes with 1000 and never reconnects', async () => {
    const h = harness();
    await playing(h);
    h.client.disconnect();
    expect(h.client.state).toBe('Disconnected');
    expect(h.disconnects).toEqual([
      { code: 1000, reason: 'client disconnect', willReconnect: false },
    ]);
    h.timers.flush();
    expect(h.server().received.at(-1)?.name).toBe('Leave');
    expect(h.server().closed?.code).toBe(1000);
    h.client.disconnect();
    h.timers.advance(60_000);
    expect(h.urls).toHaveLength(1);
    expect(h.disconnects).toHaveLength(1);
    expect(h.client.regions.loaded()).toEqual([]);
  });

  it('autoReconnect false: a reconnectable close in Playing ends in Disconnected', async () => {
    const h = harness({ autoReconnect: false });
    await playing(h);
    h.transports[0]!.drop(1006);
    h.timers.flush();
    expect(h.client.state).toBe('Disconnected');
    expect(h.disconnects).toEqual([{ code: 1006, reason: '', willReconnect: false }]);
    h.timers.advance(60_000);
    expect(h.urls).toHaveLength(1);
    expect(h.timers.pending()).toBe(0);
  });

  it.each(['Joined', 'Ready'] as const)(
    'a drop in %s → Disconnected (the server freed the slot)',
    async (target) => {
      const h = harness();
      await joined(h);
      if (target === 'Ready') {
        h.server().regionSet(['cell/1_1']);
        h.timers.flush();
      }
      expect(h.client.state).toBe(target);
      h.transports[0]!.drop(1006);
      h.timers.flush();
      expect(h.client.state).toBe('Disconnected');
      expect(h.states.at(-1)).toBe(`${target}->Disconnected`);
      expect(h.disconnects).toEqual([{ code: 1006, reason: '', willReconnect: false }]);
      expect(h.timers.pending()).toBe(0);
    },
  );
});

/** A Welcome from the scripted server consistent with the first one: server ms = tick × 1000 / 60. */
function welcomeNow(h: Harness, overrides: Partial<WelcomePayload> = {}): void {
  const serverTick = 120 + Math.round(((h.timers.now - 1000) * 60) / 1000);
  h.server().welcome({
    serverTick,
    serverTimeMs: Math.round((serverTick * 1000) / 60),
    ...overrides,
  });
}

/** Drops the live connection of a Playing client and runs the first backoff: the attempt's Hello arrived. */
function dropAndRetry(h: Harness): ScriptedServer {
  h.transports.at(-1)!.drop(1006);
  h.timers.flush();
  expect(h.client.state).toBe('Reconnecting');
  h.timers.advance(RECONNECT_DELAYS_MS[0]!);
  const s = h.server();
  expect(s.names()).toEqual(['Hello']);
  return s;
}

describe('NetClient: Reconnecting and Resyncing (M4)', () => {
  it('a drop in Playing → Reconnecting; failed attempts retry after 500, 1000, 2000, 4000 and 8000 ms, then Disconnected', async () => {
    const h = harness();
    await playing(h);
    h.timers.advance(100);
    const inputs = h.server().all('Input').length;
    expect(inputs).toBeGreaterThan(0);
    h.transports[0]!.drop(1006);
    h.timers.flush();
    expect(h.client.state).toBe('Reconnecting');
    expect(h.disconnects).toEqual([{ code: 1006, reason: '', willReconnect: true }]);
    // Kept for the attempts: the token, the player and its entity, the clock and the regions.
    expect(h.client.reconnectToken).toBe('tok-abc');
    expect(h.client.playerId).toBe(2);
    expect(h.client.entity).toBe(1234);
    expect(h.client.clock.synced).toBe(true);
    expect(h.client.regions.loaded()).toEqual(['cell/0_1', 'cell/1_1']);

    const delays: number[] = [];
    let failedAt = h.timers.now;
    const nextAttempt = (): ScriptedServer => {
      const before = h.urls.length;
      for (let i = 0; i < 20_000 && h.urls.length === before; i++) h.timers.advance(1);
      expect(h.urls).toHaveLength(before + 1);
      delays.push(h.timers.now - failedAt);
      const s = h.server();
      // The socket opened on the same turn and sent Hello with the stored reconnect token.
      expect(s.received).toHaveLength(1);
      expect(s.received[0]).toMatchObject({
        name: 'Hello',
        header: { seq: 0 },
        payload: { sessionToken: 'dev-token', reconnectToken: 'tok-abc', displayName: 'Ann' },
      });
      return s;
    };

    // 1: the connection is lost again.
    nextAttempt();
    h.transports.at(-1)!.drop(1006);
    h.timers.flush();
    failedAt = h.timers.now;
    expect(h.client.state).toBe('Reconnecting');
    // 2: the server closes with a reconnectable code.
    nextAttempt().link.close(4000, 'handshake timeout');
    h.timers.flush();
    failedAt = h.timers.now;
    // 3: a transport error (its close event is ignored).
    nextAttempt();
    const boom = new Error('socket error');
    h.transports.at(-1)!.fail(boom);
    failedAt = h.timers.now;
    h.timers.flush();
    expect(h.errors).toEqual([boom]);
    // 4: no Welcome within CONNECT_TIMEOUT_MS; the attempt's socket is closed.
    nextAttempt();
    h.timers.advance(CONNECT_TIMEOUT_MS - 1);
    expect(h.transports.at(-1)!.closed).toBe(false);
    h.timers.advance(1);
    failedAt = h.timers.now;
    expect(h.transports.at(-1)!.closed).toBe(true);
    expect(h.client.state).toBe('Reconnecting');
    // 5: fails too, and no delay is left.
    nextAttempt();
    h.transports.at(-1)!.drop(1006);
    h.timers.flush();

    expect(delays).toEqual([...RECONNECT_DELAYS_MS]);
    expect(h.client.state).toBe('Disconnected');
    expect(h.states.slice(-3)).toEqual([
      'Ready->Playing',
      'Playing->Reconnecting',
      'Reconnecting->Disconnected',
    ]);
    expect(h.disconnects).toEqual([
      { code: 1006, reason: '', willReconnect: true },
      { code: 1006, reason: '', willReconnect: false },
    ]);
    expect(h.client.playerId).toBe(-1);
    expect(h.client.entity).toBe(ENTITY_NONE);
    expect(h.client.regions.loaded()).toEqual([]);
    h.timers.advance(60_000);
    expect(h.urls).toHaveLength(6);
    expect(h.timers.pending()).toBe(0);
    // Nothing but Hello went out while reconnecting.
    expect(h.servers[0]!.all('Input')).toHaveLength(inputs);
    for (const s of h.servers.slice(1)) expect(s.names()).toEqual(['Hello']);
  });

  it('a Welcome for the same player → Resyncing: replica, jitter and input reset, clock window and regions kept; a FULL snapshot and Spawned → Playing', async () => {
    const h = harness();
    await playing(h);
    const first = h.server();
    for (const [tick, gapMs] of [
      [150, 20],
      [153, 90],
      [156, 10],
    ] as const) {
      first.snapshot(fullSnapshot(h, tick, [1234, 1300]));
      h.timers.advance(gapMs);
    }
    expect(h.client.clock.jitterMs).toBeGreaterThan(0);
    const input = { tick: 0, throttle: 5, buttons: 1 };
    h.client.sendInput(input);
    h.timers.advance(100);
    expect((first.last('Input')!.payload as InputPayload).frames).toHaveLength(4);
    const windowSize = h.client.clock.samples().length;
    expect(windowSize).toBeLessThan(15);

    const s = dropAndRetry(h);
    expect(h.client.mirror.size).toBe(2); // still shown until the Welcome
    welcomeNow(h);
    h.timers.flush();
    expect(h.client.state).toBe('Resyncing');
    expect(h.states.slice(-2)).toEqual(['Playing->Reconnecting', 'Reconnecting->Resyncing']);
    expect(h.client.mirror.size).toBe(0);
    expect(h.client.clock.jitterMs).toBe(0);
    expect(h.client.clock.samples()).toHaveLength(windowSize); // the window was kept
    expect(h.client.playerId).toBe(2);
    expect(h.client.entity).toBe(1234);
    expect(s.names()).toEqual(['Hello', 'Ping']); // no Ready: the server kept the player

    s.sessionState([{ playerId: 2, name: 'Ann', state: 2, entity: 1234 }]);
    s.regionSet(['cell/1_1'], ['cell/0_1']);
    h.timers.flush();
    expect(s.last('RegionLoadState')?.payload).toEqual({
      loaded: ['cell/0_1', 'cell/1_1'],
      loading: [],
    });
    expect(h.client.players).toHaveLength(1);
    h.timers.advance(100);
    expect(s.all('Input')).toEqual([]); // no client tick while resyncing

    // Playing needs a FULL snapshot and the own Spawned (the other order is the next test).
    const tick = h.client.clock.serverTickNow();
    s.snapshot({
      ...fullSnapshot(h, tick - 3, [1300]),
      header: { ...fullSnapshot(h, tick - 3, []).header, flags: 0 },
    });
    h.timers.flush();
    expect(h.client.mirror.has(1300)).toBe(true);
    s.spawned(2, 1234);
    h.timers.flush();
    expect(h.client.state).toBe('Resyncing'); // a delta is not a resync
    s.snapshot(fullSnapshot(h, tick, [1234]));
    h.timers.flush();
    expect(h.client.state).toBe('Playing');
    expect(h.states.at(-1)).toBe('Resyncing->Playing');
    expect([...h.client.mirror.entities()].map((e) => e.id)).toEqual([1234]);
    expect(s.last('Ack')?.payload).toEqual({ lastSnapshotTick: tick });
    h.timers.advance(20);
    const resent = s.all('Input');
    expect(resent.length).toBeGreaterThan(0);
    const firstInput = resent[0]!.payload as InputPayload<InputFrameBase & { throttle: number }>;
    expect(firstInput.frames).toHaveLength(1); // a fresh ring: nothing of the lost connection
    expect(firstInput.frames[0]!.throttle).toBe(0); // outage input is cleared
    expect(h.disconnects).toEqual([{ code: 1006, reason: '', willReconnect: true }]);
    expect(h.client.reconnectToken).toBe('tok-abc');
  });

  it('Resyncing: a FULL snapshot before the own Spawned waits for it', async () => {
    const h = harness();
    await playing(h);
    const s = dropAndRetry(h);
    welcomeNow(h);
    s.regionSet(['cell/1_1'], ['cell/0_1']);
    s.spawned(7, 555); // another player's
    s.snapshot(fullSnapshot(h, h.client.clock.serverTickNow(), [1234, 555]));
    h.timers.flush();
    expect(h.client.state).toBe('Resyncing');
    expect(h.client.mirror.size).toBe(2);
    s.spawned(2, 1234);
    h.timers.flush();
    expect(h.client.state).toBe('Playing');
    expect(h.states.slice(-3)).toEqual([
      'Playing->Reconnecting',
      'Reconnecting->Resyncing',
      'Resyncing->Playing',
    ]);
  });

  it.each([
    ['a different playerId', { playerId: 5, reconnectToken: 'tok-new' }],
    ['the same playerId and a new token', { playerId: 2, reconnectToken: 'tok-new' }],
  ] as const)(
    'a Welcome with %s is a fresh join → Joined, forgetting the old entity and the clock',
    async (_what, ids) => {
      const h = harness();
      await playing(h);
      h.server().snapshot(fullSnapshot(h, 150, [1234]));
      h.timers.advance(5000);
      expect(h.client.clock.serverTickNow()).toBeGreaterThan(400);
      const s = dropAndRetry(h);
      // A restarted session: its time and ticks started over.
      s.welcome({ ...ids, serverTick: 30, serverTimeMs: 500 });
      h.timers.flush();
      expect(h.client.state).toBe('Joined');
      expect(h.states.slice(-2)).toEqual(['Playing->Reconnecting', 'Reconnecting->Joined']);
      expect(h.client.playerId).toBe(ids.playerId);
      expect(h.client.reconnectToken).toBe('tok-new');
      expect(h.client.entity).toBe(ENTITY_NONE);
      expect(h.client.mirror.size).toBe(0);
      expect(h.client.clock.serverTickNow()).toBe(30); // the clock was reset
      expect(s.names()).toEqual(['Hello', 'Ready', 'Ping']);

      s.regionSet(['cell/2_2']);
      h.timers.flush();
      expect(h.client.state).toBe('Ready');
      s.spawned(ids.playerId, 77, 'cell/2_2');
      h.timers.flush();
      expect(h.client.state).toBe('Playing');
      expect(h.client.entity).toBe(77);
      expect(h.states.slice(-4)).toEqual([
        'Reconnecting->Joined',
        'Joined->Loading',
        'Loading->Ready',
        'Ready->Playing',
      ]);
      expect(h.disconnects).toEqual([{ code: 1006, reason: '', willReconnect: true }]);

      // The next drop reconnects with the new token.
      expect(dropAndRetry(h).received[0]?.payload).toMatchObject({ reconnectToken: 'tok-new' });
    },
  );

  it.each([
    { name: 'Kicked{ServerShutdown} + 1001', kick: KickReason.ServerShutdown, code: 1001 },
    { name: 'Kicked{AckTimeout} + 4007', kick: KickReason.AckTimeout, code: 4007 },
    { name: '4002 (malformed frame)', kick: null, code: 4002 },
    { name: '4111 (host shutting down)', kick: null, code: 4111 },
  ])('$name in Playing → Reconnecting', async ({ kick, code }) => {
    const h = harness();
    await playing(h);
    if (kick !== null) h.server().kicked(kick);
    h.server().link.close(code, 'bye');
    h.timers.flush();
    expect(h.client.state).toBe('Reconnecting');
    expect(h.disconnects).toEqual([{ code, reason: 'bye', willReconnect: true }]);
    h.timers.advance(RECONNECT_DELAYS_MS[0]!);
    expect(h.urls).toHaveLength(2);
    expect(h.server().received[0]?.payload).toMatchObject({ reconnectToken: 'tok-abc' });
    h.client.disconnect();
    h.timers.flush();
    expect(h.timers.pending()).toBe(0);
  });

  it.each([
    { name: 'Kicked{Replaced} + 4006', kick: KickReason.Replaced, code: 4006 },
    { name: 'Kicked{Idle} + 4011', kick: KickReason.Idle, code: 4011 },
    { name: 'Kicked{ByHost} + 1006', kick: KickReason.ByHost, code: 1006 },
    { name: '4003 (protocol violation)', kick: null, code: 4003 },
    { name: '1000', kick: null, code: 1000 },
  ])('$name in Playing → Disconnected, no attempt', async ({ kick, code }) => {
    const h = harness();
    await playing(h);
    if (kick !== null) h.server().kicked(kick);
    h.server().link.close(code, 'bye');
    h.timers.flush();
    expect(h.client.state).toBe('Disconnected');
    expect(h.disconnects).toEqual([{ code, reason: 'bye', willReconnect: false }]);
    h.timers.advance(60_000);
    expect(h.urls).toHaveLength(1);
    expect(h.timers.pending()).toBe(0);
  });

  it('Reconnecting: Rejected ends the attempts with "rejected" and no further "disconnected"', async () => {
    const h = harness();
    const rejected: unknown[] = [];
    h.client.on('rejected', (r) => rejected.push(r));
    await playing(h);
    const s = dropAndRetry(h);
    s.rejected(RejectReason.SessionNotRunning, '');
    s.link.close(4010, 'session not running');
    h.timers.flush();
    expect(h.client.state).toBe('Disconnected');
    expect(h.states.slice(-2)).toEqual(['Playing->Reconnecting', 'Reconnecting->Disconnected']);
    expect(rejected).toEqual([{ reason: RejectReason.SessionNotRunning, detail: '' }]);
    expect(h.disconnects).toEqual([{ code: 1006, reason: '', willReconnect: true }]);
    h.timers.advance(60_000);
    expect(h.urls).toHaveLength(2);
    expect(h.timers.pending()).toBe(0);
  });

  it('Reconnecting: a close with a code that does not reconnect ends the attempts', async () => {
    const h = harness();
    await playing(h);
    dropAndRetry(h).link.close(4003, 'protocol violation');
    h.timers.flush();
    expect(h.client.state).toBe('Disconnected');
    expect(h.disconnects).toEqual([
      { code: 1006, reason: '', willReconnect: true },
      { code: 4003, reason: 'protocol violation', willReconnect: false },
    ]);
    h.timers.advance(60_000);
    expect(h.urls).toHaveLength(2);
  });

  it('disconnect() stops reconnecting, during a backoff and with an attempt in flight (no Leave)', async () => {
    const h = harness();
    await playing(h);
    h.transports[0]!.drop(1006);
    h.timers.flush();
    h.timers.advance(RECONNECT_DELAYS_MS[0]! - 1);
    h.client.disconnect();
    expect(h.client.state).toBe('Disconnected');
    expect(h.disconnects).toEqual([
      { code: 1006, reason: '', willReconnect: true },
      { code: 1000, reason: 'client disconnect', willReconnect: false },
    ]);
    expect(h.timers.pending()).toBe(0);
    h.timers.advance(60_000);
    expect(h.urls).toHaveLength(1);

    await playing(h);
    const attempt = dropAndRetry(h);
    h.client.disconnect();
    h.timers.flush();
    expect(h.client.state).toBe('Disconnected');
    expect(attempt.names()).toEqual(['Hello']); // the server does not know this connection yet
    expect(attempt.closed?.code).toBe(1000);
    h.timers.advance(60_000);
    expect(h.urls).toHaveLength(3);
    expect(h.timers.pending()).toBe(0);
  });

  it('Resyncing: a drop goes back to Reconnecting with the attempt counter continued, and gives up after the last delay', async () => {
    const h = harness();
    await playing(h);
    h.transports[0]!.drop(1006);
    h.timers.flush();
    for (const [i, delay] of RECONNECT_DELAYS_MS.entries()) {
      h.timers.advance(delay - 1);
      expect(h.urls).toHaveLength(1 + i);
      h.timers.advance(1);
      expect(h.urls).toHaveLength(2 + i);
      welcomeNow(h);
      h.timers.flush();
      expect(h.client.state).toBe('Resyncing');
      h.transports.at(-1)!.drop(1006);
      h.timers.flush();
    }
    expect(h.client.state).toBe('Disconnected');
    const lost = { code: 1006, reason: '', willReconnect: true };
    expect(h.disconnects).toEqual([
      lost,
      lost,
      lost,
      lost,
      lost,
      { ...lost, willReconnect: false },
    ]);
    expect(h.states.slice(-3)).toEqual([
      'Resyncing->Reconnecting',
      'Reconnecting->Resyncing',
      'Resyncing->Disconnected',
    ]);
    h.timers.advance(60_000);
    expect(h.urls).toHaveLength(6);
    expect(h.timers.pending()).toBe(0);
  });
});

describe('NetClient: frames', () => {
  it('discards a frame whose any message fails to decode, and disconnects after three bad frames in a row', async () => {
    const h = harness();
    const sessionStates: unknown[] = [];
    h.client.on('sessionState', (s) => sessionStates.push(s));
    await playing(h);
    const badVersion = Uint8Array.of(99, 0);
    h.server().sendRaw(badVersion);
    h.server().sendRaw(badVersion);
    h.server().sessionState([]); // a good frame resets the streak
    h.timers.flush();
    expect(sessionStates).toHaveLength(1);
    // Valid framing, but the second message references an unknown component: nothing is dispatched.
    h.server().frame([
      { kind: CoreKind.SessionState, encode: (w) => SessionStateSchema.encode(w, { players: [] }) },
      {
        kind: CoreKind.Snapshot,
        encode: (w) => {
          w.bytes(new Uint8Array(19)); // header
          w.u8(0); // regions
          w.u16(1); // one create
          w.u32(5);
          w.u8(REGION_IDX_NONE);
          w.u8(1);
          w.u8(250); // no such component
        },
      },
    ]);
    h.server().sendRaw(badVersion);
    h.timers.flush();
    expect(sessionStates).toHaveLength(1);
    expect(h.client.state).toBe('Playing');
    expect(h.client.stats().badFrames).toBe(4);
    h.server().sendRaw(badVersion);
    h.timers.flush();
    expect(h.client.state).toBe('Disconnected');
    expect(h.errors.some((e) => e instanceof Error && e.message === '3 bad frames in a row')).toBe(
      true,
    );
    expect(h.server().received.at(-1)?.name).toBe('Leave');
    expect(h.logs.filter((l) => l.msg === 'bad frame discarded')).toHaveLength(5);
  });

  it('counts seq gaps in server frames', async () => {
    const h = harness();
    await joined(h);
    expect(h.client.stats().seqGaps).toBe(0);
    const s = h.server();
    s.sessionState([]);
    (s as unknown as { seq: number }).seq = 40;
    s.sessionState([]);
    s.sessionState([]);
    h.timers.flush();
    expect(h.client.stats().seqGaps).toBe(1);
    expect(h.client.stats().bytesIn).toBeGreaterThan(0);
    expect(h.client.stats().bytesOut).toBeGreaterThan(0);
  });

  it('stats(): bytesInPerSec and bytesOutPerSec count the frames of the window (now - 1000 ms, now]', async () => {
    const h = harness();
    const p = h.client.connect();
    h.timers.flush(); // Hello out at t = 1000
    const hello = h.client.stats().bytesOut;
    expect(hello).toBeGreaterThan(0);
    expect(h.client.stats()).toMatchObject({ bytesInPerSec: 0, bytesOutPerSec: hello });
    h.timers.advance(500);
    h.server().sessionState([]); // in at t = 1500
    h.timers.flush();
    const state = h.client.stats().bytesIn;
    h.timers.advance(499); // t = 1999
    expect(h.client.stats()).toMatchObject({ bytesInPerSec: state, bytesOutPerSec: hello });
    h.timers.advance(1); // t = 2000: the Hello of t = 1000 is out of the window
    expect(h.client.stats()).toMatchObject({ bytesInPerSec: state, bytesOutPerSec: 0 });
    h.timers.advance(499); // t = 2499
    expect(h.client.stats().bytesInPerSec).toBe(state);
    h.timers.advance(1);
    expect(h.client.stats()).toMatchObject({
      bytesIn: state,
      bytesOut: hello,
      bytesInPerSec: 0,
      bytesOutPerSec: 0,
    });
    h.client.disconnect();
    await expect(p).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('connect() after Disconnected starts over: fresh transport, seq 0, empty mirror and clock', async () => {
    const h = harness();
    await playing(h);
    h.server().snapshot(fullSnapshot(h, 150, [1234]));
    h.timers.flush();
    h.client.disconnect();
    expect(h.client.mirror.size).toBe(1); // kept for inspection until the next connect
    const p = h.client.connect();
    expect(h.client.mirror.size).toBe(0);
    expect(h.client.clock.synced).toBe(false);
    h.timers.flush();
    expect(h.servers).toHaveLength(2);
    expect(h.server().received[0]).toMatchObject({ name: 'Hello', header: { seq: 0 } });
    h.server().welcome({ playerId: 4 });
    h.timers.flush();
    await p;
    expect(h.client.playerId).toBe(4);
  });

  it('a throwing listener is logged and does not break the state machine', async () => {
    const h = harness();
    h.client.on('state', () => {
      throw new Error('listener bug');
    });
    const off = h.client.on('welcome', () => {
      throw new Error('another');
    });
    off();
    await joined(h);
    expect(h.logs.filter((l) => l.msg === "'state' listener threw").length).toBeGreaterThan(0);
    expect(h.logs.some((l) => l.msg === "'welcome' listener threw")).toBe(false);
  });

  it('validates construction options', () => {
    const registry = testRegistry();
    const base = { url: 'x', game: testGame(registry), token: 't', displayName: 'Ann' };
    expect(() => new NetClient({ ...base, displayName: 'x'.repeat(33) })).toThrow(RangeError);
    expect(() => new NetClient({ ...base, token: 'x'.repeat(2049) })).toThrow(RangeError);
    const mismatched = { ...testGame(registry), input: HelloSchema as never };
    expect(() => new NetClient({ ...base, game: mismatched })).toThrow(RangeError);
  });
});

describe('client state table (docs/net.md B.3)', () => {
  it('has an entry for every state and reaches Disconnected from every other state', () => {
    expect(Object.keys(CLIENT_TRANSITIONS).sort()).toEqual([...CLIENT_STATES].sort());
    for (const s of CLIENT_STATES) {
      if (s !== 'Disconnected') expect(canTransition(s, 'Disconnected')).toBe(true);
      expect(canTransition(s, s)).toBe(false);
    }
    expect(CLIENT_TRANSITIONS.Disconnected).toEqual(['Connecting']);
  });

  it('assertTransition throws for edges outside the table', () => {
    expect(() => assertTransition('Disconnected', 'Connecting')).not.toThrow();
    expect(() => assertTransition('Disconnected', 'Playing')).toThrow(/illegal state transition/);
    expect(() => assertTransition('Handshaking', 'Playing')).toThrow();
    expect(() => assertTransition('Playing', 'Joined')).toThrow();
  });

  it('every transition NetClient takes on the way to Playing and back is a table edge', async () => {
    const h = harness();
    await playing(h);
    h.client.disconnect();
    for (const edge of h.states) {
      const [from, to] = edge.split('->') as [ClientState, ClientState];
      expect(canTransition(from, to), edge).toBe(true);
    }
    expect(h.states).toEqual([
      'Disconnected->Connecting',
      'Connecting->Handshaking',
      'Handshaking->Joined',
      'Joined->Loading',
      'Loading->Ready',
      'Ready->Playing',
      'Playing->Disconnected',
    ]);
  });

  it('isReconnectableClose encodes docs/net.md A.3', () => {
    const yes = [1001, 1005, 1006, 1011, 1012, 1013, 1014, 4000, 4002, 4007, 4110, 4111];
    const no = [
      1000, 1002, 1003, 1008, 4001, 4003, 4004, 4005, 4006, 4008, 4009, 4010, 4011, 4012, 4100,
      4105, 4112, 4199, 3000,
    ];
    for (const code of yes) expect(isReconnectableClose(code), `${code}`).toBe(true);
    for (const code of no) expect(isReconnectableClose(code), `${code}`).toBe(false);
  });

  it('names reject and kick reasons for display', () => {
    expect(rejectReasonName(RejectReason.BadToken)).toBe('BadToken');
    expect(rejectReasonName(42)).toBe('Unknown(42)');
    expect(kickReasonName(KickReason.AckTimeout)).toBe('AckTimeout');
    expect(describeRejected({ reason: RejectReason.SessionFull, detail: '' })).toBe(
      'Rejected: SessionFull',
    );
  });
});

describe('snapshot rejection listener reentrancy', () => {
  it('does not close a replacement connection opened by a transport error listener', async () => {
    const h = harness({ autoReconnect: false });
    await joined(h);
    let replacement: Promise<void> | undefined;
    h.client.on('error', () => {
      if (replacement !== undefined) return;
      h.client.disconnect();
      replacement = h.client.connect();
      void replacement.catch(() => {});
    });
    h.transports[0]!.fail(Error('old transport error'));
    h.timers.flush();
    expect(h.client.state).toBe('Handshaking');
    h.server().welcome();
    h.timers.flush();
    await replacement;
    expect(h.client.state).toBe('Joined');
    h.client.disconnect();
  });
  it('does not close a replacement connection opened by an error listener', async () => {
    const h = harness({ autoReconnect: false });
    await joined(h);
    let replacement: Promise<void> | undefined;
    h.client.on('error', () => {
      if (replacement !== undefined) return;
      h.client.disconnect();
      replacement = h.client.connect();
      void replacement.catch(() => {});
    });
    h.server().snapshot({
      header: {
        serverTick: 3,
        baselineTick: 1,
        serverTimeMs: 50,
        lastInputSeq: 0,
        lastInputTick: 0,
        flags: 0,
      },
      regions: [],
      creates: [],
      updates: [],
      destroys: [],
    });
    h.timers.flush();
    expect(h.client.state).toBe('Handshaking');
    h.server().welcome();
    h.timers.flush();
    await replacement;
    expect(h.client.state).toBe('Joined');
    h.client.disconnect();
  });
});
