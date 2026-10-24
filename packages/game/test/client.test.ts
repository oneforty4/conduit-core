import type { Manifest } from '@conduit/assets';
import { DEV_TOKEN, mintToken, nowSeconds } from '@conduit/auth';
import { ConnectError, type DisconnectInfo, type ReplicatedEventInfo } from '@conduit/net-client';
import { KickReason, PlayerState, RejectReason } from '@conduit/protocol';
import type { EntityId } from '@conduit/sim';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type ClientState,
  createClient,
  type FrameContext,
  type GameClient,
  HEADLESS_FRAME_MS,
  type InputContext,
} from '../src/client.ts';
import {
  defineComponent,
  defineEvent,
  defineGame,
  defineInput,
  defineMessage,
  defineSystem,
  f,
  GridWorld,
  Owner,
  Region,
  Transform,
} from '../src/index.ts';
import { createServer, type CreateServerOpts, type GameServer } from '../src/server.ts';
import { TcpProxy } from './tcp-proxy.ts';

/**
 * A stand-in for `@conduit/render`, which needs WebGL: just the members `createClient` uses, with a
 * shared log. Only the canvas test below loads it; the other clients here are headless and never
 * import the render module (test/module-graph.test.ts proves that for the real one).
 */
const fakeRender = vi.hoisted(() => {
  const log: string[] = [];
  class GltfBackend {
    readonly type = 'model';
    async load(url: string): Promise<{ url: string }> {
      log.push(`GltfBackend.load ${url}`);
      return { url };
    }
    dispose(): void {
      log.push('GltfBackend.dispose');
    }
  }
  class RenderHost {
    constructor(readonly opts: { canvas: unknown }) {}
    onFrame(): () => void {
      return () => {};
    }
    start(): void {
      log.push('RenderHost.start');
    }
    dispose(): void {
      log.push('RenderHost.dispose');
    }
  }
  class RenderWorld {
    readonly binders: unknown[] = [];
    readonly pushed: unknown[] = [];
    /** `setFloatingOrigin <id>` and `update` calls, in order. */
    readonly calls: string[] = [];
    floatingRegion: string | null = null;
    constructor(
      readonly host: unknown,
      readonly replica: unknown,
      readonly clock: unknown,
      readonly assets: unknown,
      readonly graph: unknown,
    ) {
      worlds.push(this);
    }
    registerBinder(b: unknown): () => void {
      this.binders.push(b);
      return () => {};
    }
    setInput(): void {}
    setCamera(): void {}
    cameraTarget(): void {}
    setFloatingOrigin(id: string): void {
      this.calls.push(`setFloatingOrigin ${id}`);
      this.floatingRegion = id;
    }
    update(): void {
      this.calls.push('update');
    }
    pushEvent(evt: unknown): void {
      this.pushed.push(evt);
    }
    dispose(): void {
      log.push('RenderWorld.dispose');
    }
  }
  const worlds: RenderWorld[] = [];
  const module = {
    GltfBackend,
    RenderHost,
    RenderWorld,
    RegionBinder: class RegionBinder {
      constructor(readonly world: unknown) {}
    },
    TransformBinder: class TransformBinder {},
    ModelBinder: class ModelBinder {
      constructor(readonly world: unknown) {}
    },
    FollowCamera: class FollowCamera {},
    NULL_INPUT: {},
  };
  return { log, worlds, module };
});
vi.mock('@conduit/render', () => fakeRender.module);

// A minimal game: a car per player whose throttle input drives it along +x at up to 10 m/s.

const SPAWN = 'cell/1_1';
/** The cell east of `SPAWN`; the car of the player named `Renderer` spawns 2 m from its border. */
const EAST = 'cell/2_1';
const Input = defineInput({ tick: f.u32, throttle: f.i8 });
type Frame = ReturnType<typeof Input.create>;
const Car = defineComponent('Car', { throttle: f.i8 });
const Knock = defineMessage('Knock', 'c2s', { n: f.u16 });
const Answer = defineMessage('Answer', 's2c', { n: f.u16 });
/** Replicated; the server emits it in the spawn cell for every Knock. */
const Beep = defineEvent('Beep', { n: f.u16 });

const drive = defineSystem('drive', 'input', (ctx) => {
  for (const e of ctx.world.query(Owner, Car)) {
    const frame = ctx.inputs(ctx.world.get(e, Owner).player) as Frame | undefined;
    const throttle = frame?.throttle ?? 0;
    if (ctx.world.get(e, Car).throttle !== throttle) ctx.world.write(e, Car).throttle = throttle;
  }
});

const move = defineSystem('move', 'sim', (ctx) => {
  for (const e of ctx.world.query(Car, Transform)) {
    const throttle = ctx.world.get(e, Car).throttle;
    if (throttle !== 0) ctx.world.write(e, Transform).pos.x += (throttle / 127) * 10 * ctx.dt;
  }
});

const definition = {
  id: 'client-test',
  name: 'Client test',
  protocolVersion: 1,
  seed: 5,
  components: [Car],
  messages: [Knock, Answer],
  events: [Beep],
  input: Input,
  systems: [drive, move],
  world: (seed: number) =>
    new GridWorld({ cellSize: 64, cols: 3, rows: 3, wantedDepth: 1, worldSeed: seed }),
};
const game = defineGame(definition);
// Same types in the same order, so the ids agree; only the protocol version differs.
const olderGame = defineGame({ ...definition, protocolVersion: 2 });

const sri = (c: string) => `sha256-${c.repeat(43)}=` as const;
const MANIFEST: Manifest = {
  version: 1,
  baseUrl: '/assets/',
  assets: {
    config: { type: 'json', url: 'config.json', hash: sri('A'), size: 11 },
    ship: { type: 'model', url: 'ship.glb', hash: sri('B'), size: 4 },
  },
  groups: {},
  regions: {},
};
const gameWithAssets = defineGame({ ...definition, assets: MANIFEST });

function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (predicate()) resolve();
      else if (performance.now() > deadline) reject(new Error(`timed out waiting for ${label}`));
      else setTimeout(poll, 5);
    };
    poll();
  });
}

let server: GameServer;
const clients: GameClient<Frame>[] = [];
const serverErrors: unknown[] = [];

/** The test server's options; its errors are collected into `errors`. */
function serverOptions(errors: unknown[]): CreateServerOpts<Frame> {
  return {
    devAuth: true,
    log: (level, msg, data) => {
      if (level === 'error') errors.push([msg, data]);
    },
    regionLoader: { populate() {} },
    hooks: {
      onPlayerJoin: (player) => {
        if (player.displayName === 'Unwelcome') throw new Error('no entry');
        return {
          regionId: SPAWN,
          spawn(ctx) {
            const e = ctx.world.create();
            ctx.world.add(e, Region, { id: SPAWN });
            const x = player.displayName === 'Renderer' ? 62 : 10;
            ctx.world.add(e, Transform, { pos: { x, y: 0, z: 10 + 4 * player.playerId } });
            ctx.world.add(e, Owner, { player: player.playerId });
            ctx.world.add(e, Car, { throttle: 0 });
            return e;
          },
        };
      },
      onMessage: {
        Knock(player, msg, ctx) {
          const { n } = msg as { n: number };
          ctx.send(player.playerId, Answer, { n: n + 1 });
          ctx.events.emit(Beep, { n }, SPAWN);
        },
      },
    },
  };
}

beforeAll(async () => {
  server = await createServer(game, serverOptions(serverErrors));
});

afterAll(async () => {
  for (const c of clients.splice(0)) c.dispose();
  await server.close();
  expect(serverErrors).toEqual([]);
});

function track(client: GameClient<Frame>): GameClient<Frame> {
  clients.push(client);
  return client;
}

describe('createClient (headless) against createServer', () => {
  it('throws for the connection members before connect()', () => {
    const client = track(
      createClient(game, {
        url: server.url,
        sampleInput: (ctx) => ({ tick: ctx.tick, throttle: 0 }),
      }),
    );
    expect(client.state).toBe('idle');
    expect(client.localEntity).toBeUndefined();
    expect(client.game).toBe(game);
    expect(() => client.replica).toThrow('call connect() first');
    expect(() => client.clock).toThrow('call connect() first');
    expect(() => client.net).toThrow('call connect() first');
    expect(() => client.regions).toThrow('call connect() first');
    expect(() => client.send(Knock, { n: 1 })).toThrow('call connect() first');
    client.disconnect();
    expect(client.state).toBe('closed');
  });

  it('rejects reconnect from a closed-state listener while disposing a direct client', async () => {
    const isolated = await createServer(game, serverOptions([]));
    const client = track(
      createClient(game, {
        url: isolated.url,
        sampleInput: (ctx) => ({ tick: ctx.tick, throttle: 0 }),
      }),
    );
    await client.connect();
    let retry: ReturnType<typeof client.connect> | undefined;
    client.on('state', (state) => {
      if (state === 'closed' && retry === undefined) {
        retry = client.connect();
        void retry.catch(() => {});
      }
    });
    try {
      client.dispose();
      expect(retry).toBeDefined();
      await expect(retry).rejects.toThrow('disposed');
      expect(client.state).toBe('closed');
      expect(client.net.state).toBe('Disconnected');
    } finally {
      client.net.disconnect();
      await isolated.close();
    }
  });

  it("A's input moves A's entity as seen by B; A's disconnect destroys it on B", async () => {
    const throttle = { a: 0 };
    const samples: InputContext<Frame>[] = [];
    const frames: FrameContext<Frame>[] = [];
    const states: ClientState[] = [];
    const answers: [unknown, number][] = [];
    const regionEvents: string[] = [];
    const a = track(
      createClient(game, {
        url: server.url,
        displayName: 'A',
        sampleInput: (ctx) => {
          if (samples.length < 3)
            samples.push({ ...ctx, previous: ctx.previous && { ...ctx.previous } });
          return { tick: ctx.tick, throttle: throttle.a };
        },
        onFrame: (frame) => {
          if (frames.length < 1000)
            frames.push({ ...frame, input: frame.input && { ...frame.input } });
        },
        onMessage: { Answer: (msg, frame) => answers.push([msg, frame.renderTick]) },
        onRegion: (ev) => regionEvents.push(`${ev.type}:${ev.id}`),
      }),
    );
    a.on('state', (s) => states.push(s));
    const b = track(
      createClient(game, {
        url: server.url,
        displayName: 'B',
        token: DEV_TOKEN,
        sampleInput: (ctx) => ({ tick: ctx.tick, throttle: 0 }),
      }),
    );

    const joinedA = await a.connect();
    const joinedB = await b.connect();
    expect(states).toEqual(['connecting', 'connected', 'spawned']);
    expect(a.state).toBe('spawned');
    expect(joinedA.playerId).toBe(0);
    expect(joinedB.playerId).toBe(1);
    expect(a.localEntity).toBe(joinedA.localEntity);
    expect(b.localEntity).toBe(joinedB.localEntity);
    expect(a.net.graph?.get(SPAWN)).toBeDefined();
    expect(regionEvents).toContain(`loaded:${SPAWN}`);

    // Frames run on their own (autoFrame) and describe the connection.
    await waitFor(
      () => frames.some((fr) => fr.localEntity === joinedA.localEntity && fr.renderTick > 0),
      'frames',
    );
    const frame = frames[frames.length - 1] as FrameContext<Frame>;
    expect(frame.replica.world).toBe(a.replica); // as of the frame's render tick
    expect(frame.replica.tick).toBe(frame.renderTick);
    expect(frame.clock).toBe(a.clock);
    expect(frame.render).toBeUndefined();
    expect(frame.dt).toBeCloseTo(HEADLESS_FRAME_MS / 1000, 6);
    expect(frame.regions.wanted).toContain(SPAWN);
    expect(frame.regions.prefetch).toEqual([]); // the 3 x 3 world is all wanted from its centre
    expect(frame.regions.loaded).toEqual(frame.regions.wanted);
    expect(frame.regions.loading).toEqual([]);

    // Input sampling: once per client tick, with the previous frame after the first.
    await waitFor(() => samples.length >= 3, 'input samples');
    expect(samples[0]?.previous).toBeUndefined();
    expect(samples[1]?.previous).toMatchObject({ throttle: 0 });
    expect(samples[0]?.dt).toBe(0);
    expect(samples[2]?.dt).toBeGreaterThan(0);
    expect(samples[2]?.sampleTimeMs).toBeGreaterThan(samples[1]!.sampleTimeMs);
    expect(samples[2]?.localEntity).toBe(joinedA.localEntity);

    // A drives; B observes A's entity moving more than 1 m.
    const entity: EntityId = joinedA.localEntity;
    await waitFor(() => b.replica.read(entity, Transform) !== undefined, "A's entity on B");
    const startX = b.replica.read(entity, Transform)?.pos.x ?? Number.NaN;
    throttle.a = 127;
    await waitFor(
      () => (b.replica.read(entity, Transform)?.pos.x ?? startX) > startX + 1,
      "A's movement on B",
    );
    const sampled = b.replica.sample(entity, Transform, b.clock.renderTick(), Transform.create());
    expect(sampled?.pos.x).toBeGreaterThanOrEqual(startX);
    await waitFor(
      () => frames.some((fr) => fr.input?.throttle === 127),
      'the sent input in FrameContext',
    );

    // Game messages both ways; the handler gets a FrameContext.
    a.send(Knock, { n: 41 });
    await waitFor(() => answers.length === 1, 'Answer');
    expect(answers[0]?.[0]).toEqual({ n: 42 });

    // A leaves: B's replica marks A's entity destroyed.
    a.disconnect();
    expect(a.state).toBe('closed');
    expect(a.localEntity).toBeUndefined();
    await waitFor(() => {
      const ent = b.replica.get(entity);
      return ent === undefined || ent.destroyedTick !== null;
    }, "A's destroy on B");
    expect(server.session.world.alive(entity)).toBe(false);
    const framesAfterClose = frames.length;
    await new Promise((resolve) => setTimeout(resolve, 5 * HEADLESS_FRAME_MS));
    expect(frames.length).toBe(framesAfterClose); // the headless frame loop stopped
  });

  it('with autoFrame false delivers frames only through tickFrame', async () => {
    const frames: FrameContext<Frame>[] = [];
    const c = track(
      createClient(game, {
        url: server.url,
        displayName: 'C',
        autoFrame: false,
        sampleInput: (ctx) => ({ tick: ctx.tick, throttle: 0 }),
        onFrame: (frame) => frames.push(frame),
      }),
    );
    await c.connect();
    await new Promise((resolve) => setTimeout(resolve, 5 * HEADLESS_FRAME_MS));
    expect(frames).toHaveLength(0);
    const order: string[] = [];
    const pulse = vi.spyOn(c.net, 'pulseInput').mockImplementation(() => {
      order.push('input');
      return false;
    });
    const update = vi.spyOn(c.net, 'update').mockImplementation(() => {
      order.push('presentation');
    });
    const t0 = Math.round(performance.now());
    c.tickFrame(t0);
    expect(order).toEqual(['input', 'presentation']);
    pulse.mockRestore();
    update.mockRestore();
    c.tickFrame(t0 + 50);
    expect(frames.map((fr) => fr.dt)).toEqual([0, 0.05]);
    c.tickFrame(t0 + 5000);
    expect(frames[2]?.dt).toBe(0.25);
    c.dispose();
    expect(c.state).toBe('closed');
  });

  it('rejects connect() with the Rejected reason and never spawns', async () => {
    const rejected: unknown[] = [];
    const stale = track(
      createClient(olderGame, {
        url: server.url,
        sampleInput: (ctx) => ({ tick: ctx.tick, throttle: 0 }),
      }),
    );
    stale.on('rejected', (r) => rejected.push(r));
    const err: unknown = await stale.connect().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).kind).toBe('rejected');
    expect((err as ConnectError).rejected?.reason).toBe(RejectReason.ProtocolVersion);
    expect(rejected).toHaveLength(1);
    expect(stale.state).toBe('closed');
    expect(stale.localEntity).toBeUndefined();
  });

  it('rejects connect() with the close code when the server drops the player before spawning', async () => {
    const isolatedErrors: unknown[] = [];
    const isolated = await createServer(game, serverOptions(isolatedErrors));
    const states: ClientState[] = [];
    const unwelcome = track(
      createClient(game, {
        url: isolated.url,
        displayName: 'Unwelcome',
        sampleInput: (ctx) => ({ tick: ctx.tick, throttle: 0 }),
      }),
    );
    unwelcome.on('state', (st) => states.push(st));
    const err: unknown = await unwelcome.connect().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).kind).toBe('closed');
    expect((err as ConnectError).code).toBe(4012); // authoritative join failure faults this isolated session
    expect(states).toEqual(['connecting', 'connected', 'closed']);
    await new Promise((resolve) => setTimeout(resolve, 3 * HEADLESS_FRAME_MS));
    expect(unwelcome.state).toBe('closed');
    await isolated.close();
    expect(isolatedErrors).toHaveLength(1);
  });
});

describe('createClient with a lobby (host mode) against createServer with a secret', () => {
  const SECRET = 'game-client-lobby-secret-0123456789abcdef-01234';
  const sampleInput = (ctx: InputContext<Frame>): Frame => ({ tick: ctx.tick, throttle: 0 });
  let tokenServer: GameServer;
  const errors: unknown[] = [];

  beforeAll(async () => {
    tokenServer = await createServer(game, {
      ...serverOptions(errors),
      devAuth: false,
      secret: SECRET,
    });
  });

  afterAll(async () => {
    await tokenServer.close();
    expect(errors).toEqual([]);
  });

  /** A lobby double whose n-th join mints a token for account `acct-<n>` named `joiner <n>`. */
  function fakeLobby(): {
    joins: string[];
    join(id: string): Promise<{ token: string; wsUrl: string }>;
  } {
    const joins: string[] = [];
    return {
      joins,
      async join(id) {
        joins.push(id);
        const n = joins.length;
        const identity = { accountId: `acct-${n}`, displayName: `joiner ${n}`, sessionId: id };
        return {
          token: mintToken({ ...identity, exp: nowSeconds() + 600 }, SECRET),
          wsUrl: tokenServer.url,
        };
      },
    };
  }

  function identities(): string[][] {
    return tokenServer.session.players().map((p) => [p.accountId, p.displayName]);
  }

  it('takes lobby and sessionId, or url and token, never both', async () => {
    const lobby = fakeLobby();
    expect(() => createClient(game, { lobby, sampleInput })).toThrow(
      new TypeError('createClient: lobby needs a sessionId'),
    );
    expect(() => createClient(game, { lobby, sessionId: '', sampleInput })).toThrow(TypeError);
    for (const direct of [{ url: server.url }, { token: DEV_TOKEN }]) {
      expect(() => createClient(game, { lobby, sessionId: 'dev', ...direct, sampleInput })).toThrow(
        new TypeError('createClient: pass either lobby and sessionId, or url (and token)'),
      );
    }
    expect(() => createClient(game, { url: server.url, sessionId: 'dev', sampleInput })).toThrow(
      new TypeError('createClient: sessionId needs a lobby'),
    );
    const neither = track(createClient(game, { sampleInput }));
    await expect(neither.connect()).rejects.toThrow(
      'createClient: pass url, or lobby and sessionId',
    );
    expect(lobby.joins).toEqual([]);
  });

  it('connect() joins through the lobby and plays with its token; a later connect() joins again with a fresh token', async () => {
    const lobby = fakeLobby();
    const client = track(createClient(game, { lobby, sessionId: 'dev', sampleInput }));
    const states: ClientState[] = [];
    client.on('state', (s) => states.push(s));

    const connecting = client.connect();
    expect(client.state).toBe('connecting');
    expect(() => client.net).toThrow('call connect() first'); // built once the join answered
    const first = await connecting;
    expect(lobby.joins).toEqual(['dev']);
    expect(identities()).toEqual([['acct-1', 'joiner 1']]);
    expect(client.localEntity).toBe(first.localEntity);
    const net = client.net;

    client.disconnect();
    await waitFor(() => tokenServer.session.players().length === 0, 'the leave');
    const second = await client.connect();
    expect(lobby.joins).toEqual(['dev', 'dev']);
    // The same NetClient, connected with the second join's token (the first one would name acct-1).
    expect(client.net).toBe(net);
    expect(identities()).toEqual([['acct-2', 'joiner 2']]);
    expect(second.localEntity).not.toBe(first.localEntity);
    expect(states).toEqual([
      'connecting',
      'connected',
      'spawned',
      'closed',
      'connecting',
      'connected',
      'spawned',
    ]);
    client.disconnect();
    await waitFor(() => tokenServer.session.players().length === 0, 'the second leave');
  });

  it('preserves a connect started by a closed-state listener during disconnect', async () => {
    const client = track(createClient(game, { lobby: fakeLobby(), sessionId: 'dev', sampleInput }));
    await client.connect();
    let retry: ReturnType<typeof client.connect> | undefined;
    const off = client.on('state', (state) => {
      if (state === 'closed' && retry === undefined) {
        retry = client.connect();
        void retry.catch(() => {});
      }
    });
    client.disconnect();
    expect(client.state).toBe('connecting');
    expect(retry).toBeDefined();
    await retry;
    expect(client.state).toBe('spawned');
    off();
    client.dispose();
    await waitFor(() => tokenServer.session.players().length === 0, 'the reentrant client leave');
  });
  it('allows a new connect while an abandoned lobby join is unresolved', async () => {
    let answer!: (result: Awaited<ReturnType<ReturnType<typeof fakeLobby>['join']>>) => void;
    let calls = 0;
    const refused = Error('fresh attempt');
    const client = track(
      createClient(game, {
        lobby: {
          join: () => {
            calls++;
            return calls === 1
              ? new Promise((resolve) => {
                  answer = resolve;
                })
              : Promise.reject(refused);
          },
        },
        sessionId: 'dev',
        sampleInput,
      }),
    );
    const old = client.connect();
    client.disconnect();
    const retry = client.connect();
    expect(retry).not.toBe(old);
    await expect(retry).rejects.toBe(refused);
    answer(await fakeLobby().join('dev'));
    await expect(old).rejects.toMatchObject({ kind: 'aborted' });
    expect(calls).toBe(2);
  });
  it('a failed join rejects connect() with the lobby error; disconnect() during a join aborts', async () => {
    const refused = new Error('bad_invite');
    const failing = track(
      createClient(game, {
        lobby: { join: () => Promise.reject(refused) },
        sessionId: 'dev',
        sampleInput,
      }),
    );
    await expect(failing.connect()).rejects.toBe(refused);
    expect(failing.state).toBe('closed');
    expect(() => failing.net).toThrow('call connect() first');

    let answer = (): void => {};
    const lobby = fakeLobby();
    const held = track(
      createClient(game, {
        lobby: {
          join: (id) => new Promise((resolve) => (answer = () => resolve(lobby.join(id)))),
        },
        sessionId: 'dev',
        sampleInput,
      }),
    );
    const connecting = held.connect();
    held.disconnect();
    answer();
    await expect(connecting).rejects.toMatchObject({ kind: 'aborted' });
    expect(held.state).toBe('closed');
    expect(() => held.net).toThrow('call connect() first');
    expect(tokenServer.session.players()).toEqual([]);
  });
});

describe('createClient reconnect (through a TCP relay whose cut closes both ends with 1006)', () => {
  it("is 'reconnecting' after a loss, with willReconnect, keeps its frames and entity, and resyncs to the same player", async () => {
    const proxy = await TcpProxy.start({ port: server.port });
    try {
      const states: ClientState[] = [];
      const closes: DisconnectInfo[] = [];
      const previous: (Frame | undefined)[] = [];
      const throttle = { value: 0 };
      let frames = 0;
      const c = track(
        createClient(game, {
          url: proxy.url,
          displayName: 'Tunnel',
          sampleInput: (ctx) => {
            previous.push(ctx.previous && { ...ctx.previous });
            return { tick: ctx.tick, throttle: throttle.value };
          },
          onFrame: () => {
            frames++;
          },
        }),
      );
      c.on('state', (st) => states.push(st));
      c.on('disconnected', (info) => closes.push(info));
      const joined = await c.connect();
      const onServer = () => server.session.players().find((p) => p.playerId === joined.playerId);

      proxy.cut(); // no close handshake either way; new connections are refused for now
      await waitFor(() => c.state === 'reconnecting', 'reconnecting');
      expect(closes).toMatchObject([{ code: 1006, willReconnect: true }]);
      expect(c.localEntity).toBe(joined.localEntity);
      await waitFor(() => onServer()?.state === PlayerState.Away, 'the player away on the server');
      const framesAtLoss = frames;
      await waitFor(() => frames > framesAtLoss + 3, 'frames while reconnecting');
      // connect() meanwhile waits for the resync rather than starting a new connection.
      const resuming = c.connect();
      expect(c.state).toBe('reconnecting');

      previous.length = 0;
      proxy.restore(); // the next attempt (backoff 500, 1000, ... ms) gets through
      const resumed = await resuming;
      expect(resumed).toMatchObject({ playerId: joined.playerId, localEntity: joined.localEntity });
      expect(states).toEqual(['connecting', 'connected', 'spawned', 'reconnecting', 'spawned']);
      expect(closes).toHaveLength(1);
      expect(c.localEntity).toBe(joined.localEntity);
      expect(onServer()?.state).toBe(PlayerState.Playing);

      // The new connection's first sample has no previous frame, and input drives the same entity.
      await waitFor(() => previous.length >= 2, 'samples after the resync');
      expect(previous[0]).toBeUndefined();
      const world = server.session.world;
      const x0 = world.get(joined.localEntity, Transform).pos.x;
      throttle.value = 127;
      await waitFor(
        () => world.get(joined.localEntity, Transform).pos.x > x0 + 1,
        'input moving the entity after the resync',
      );

      // A final close (a kick) is not retried: 'closed', with willReconnect false.
      server.session.kick(joined.playerId, KickReason.ByHost);
      await waitFor(() => c.state === 'closed', 'closed after the kick');
      expect(closes).toMatchObject([
        { code: 1006, willReconnect: true },
        { code: 4011, willReconnect: false },
      ]);
      expect(c.localEntity).toBeUndefined();
    } finally {
      await proxy.close();
    }
  });

  it('after the server dropped the player, the reconnect is a fresh join: no localEntity until the new one spawns', async () => {
    const errors: unknown[] = [];
    const graceless = await createServer(game, { ...serverOptions(errors), reconnectGraceMs: 0 });
    const proxy = await TcpProxy.start({ port: graceless.port });
    try {
      const states: [ClientState, EntityId | undefined][] = [];
      const closes: DisconnectInfo[] = [];
      const previous: (Frame | undefined)[] = [];
      const c = track(
        createClient(game, {
          url: proxy.url,
          displayName: 'Stranger',
          sampleInput: (ctx) => {
            previous.push(ctx.previous && { ...ctx.previous });
            return { tick: ctx.tick, throttle: 1 };
          },
        }),
      );
      c.on('state', (st) => states.push([st, c.localEntity]));
      c.on('disconnected', (info) => closes.push(info));
      const joined = await c.connect();
      const token = c.net.reconnectToken;
      await waitFor(() => previous.length >= 2, 'samples before the loss');
      expect(previous[1]).toMatchObject({ throttle: 1 });

      proxy.cut();
      await waitFor(
        () => !graceless.session.world.alive(joined.localEntity),
        'the entity destroyed once the (zero) grace ran out',
      );
      previous.length = 0; // no samples while reconnecting: the client tick is stopped
      proxy.restore();
      await waitFor(() => states.length === 6, 'the fresh join spawned');
      await waitFor(() => previous.length >= 2, 'samples after the fresh join');
      expect(previous[0]).toBeUndefined(); // a new connection's first sample
      expect(previous[1]).toMatchObject({ throttle: 1 });
      expect(states).toEqual([
        ['connecting', undefined],
        ['connected', undefined],
        ['spawned', joined.localEntity],
        ['reconnecting', joined.localEntity],
        ['connected', undefined],
        ['spawned', c.net.entity],
      ]);
      expect(c.localEntity).not.toBe(joined.localEntity);
      expect(graceless.session.world.alive(c.localEntity ?? 0)).toBe(true);
      expect(c.net.reconnectToken).not.toBe(token);
      expect(closes).toMatchObject([{ code: 1006, willReconnect: true }]);
      expect(await c.connect()).toMatchObject({ localEntity: c.localEntity });
      c.dispose();
    } finally {
      await proxy.close();
      await graceless.close();
    }
    expect(errors).toEqual([]);
  });
});

describe('createClient asset loader', () => {
  it('has no loader without a manifest, and rejects an assetBaseUrl without a trailing slash', async () => {
    const opts = {
      url: server.url,
      sampleInput: (ctx: InputContext<Frame>) => ({ tick: ctx.tick, throttle: 0 }),
    };
    expect(() => createClient(game, { ...opts, assetBaseUrl: '/cdn' })).toThrow(TypeError);
    const plain = track(createClient(game, { ...opts, displayName: 'Plain' }));
    await plain.connect();
    expect(plain.assets).toBeUndefined();
    plain.dispose();
  });

  it('a headless client builds it from game.assets or opts.manifest, without a model backend', async () => {
    const urls: string[] = [];
    const fetch = async (input: RequestInfo | URL): Promise<Response> => {
      urls.push(String(input));
      return new Response('{"ok":true}');
    };
    const sampleInput = (ctx: InputContext<Frame>) => ({ tick: ctx.tick, throttle: 0 });

    const fromGame = track(
      createClient(gameWithAssets, { url: server.url, displayName: 'Assets', sampleInput }),
    );
    expect(fromGame.assets).toBeUndefined(); // built by connect()
    await fromGame.connect();
    expect(fromGame.assets?.manifest).toBe(MANIFEST);
    fromGame.dispose();

    const c = track(
      createClient(game, {
        url: server.url,
        displayName: 'Manifest',
        sampleInput,
        manifest: MANIFEST,
        assetBaseUrl: 'https://cdn.example/game/',
        assetLoader: { fetch },
      }),
    );
    await c.connect();
    const loader = c.assets;
    if (loader === undefined) throw new Error('no loader');
    expect(loader.manifest).toEqual({ ...MANIFEST, baseUrl: 'https://cdn.example/game/' });
    expect(MANIFEST.baseUrl).toBe('/assets/'); // not mutated
    const handle = await loader.acquire('config');
    expect(handle.asset).toEqual({ ok: true });
    expect(urls).toEqual(['https://cdn.example/game/config.json']);
    await expect(loader.acquire('ship')).rejects.toThrow('no backend for type model');
    handle.release();

    c.dispose();
    await expect(loader.acquire('config')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it("hands the loader to RegionClient: the player spawns once the active regions' groups loaded", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const urls: string[] = [];
    const fetch = async (input: RequestInfo | URL): Promise<Response> => {
      urls.push(String(input));
      await gate;
      return new Response('{"cell":11}');
    };
    const manifest: Manifest = {
      ...MANIFEST,
      assets: {
        ...MANIFEST.assets,
        cell11: { type: 'json', url: 'cell11.json', hash: sri('C'), size: 11 },
      },
      regions: { [SPAWN]: ['cell11'] },
    };
    const regionEvents: string[] = [];
    const frames: FrameContext<Frame>[] = [];
    const c = track(
      createClient(game, {
        url: server.url,
        displayName: 'Streamer',
        manifest,
        assetLoader: { fetch },
        sampleInput: (ctx) => ({ tick: ctx.tick, throttle: 0 }),
        onRegion: (ev) => regionEvents.push(`${ev.type}:${ev.id}`),
        onFrame: (frame) => frames.push(frame),
      }),
    );
    let spawned = false;
    const connecting = c.connect();
    void connecting.then(() => {
      spawned = true;
    });

    // Every cell of the 3 x 3 world is active; only the spawn cell has assets, so only it loads.
    await waitFor(() => urls.length === 1 && frames.length > 0, 'the spawn cell group fetch');
    expect(urls).toEqual(['/assets/cell11.json']);
    expect(c.regions.loading()).toEqual([SPAWN]);
    expect(c.regions.loaded()).toHaveLength(8);
    expect(regionEvents).toHaveLength(8);
    expect(regionEvents).not.toContain(`loaded:${SPAWN}`);
    expect(frames[frames.length - 1]?.regions.loading).toEqual([SPAWN]);
    await new Promise((resolve) => setTimeout(resolve, 10 * HEADLESS_FRAME_MS));
    expect(c.net.state).toBe('Loading'); // Ready waits for every active region
    expect(spawned).toBe(false);

    open();
    await connecting;
    expect(regionEvents[regionEvents.length - 1]).toBe(`loaded:${SPAWN}`);
    expect(c.regions.loading()).toEqual([]);
    expect(c.regions.loaded()).toContain(SPAWN);
    expect(c.assets?.refcount('cell11')).toBe(1); // RegionClient holds the spawn cell's group
    await waitFor(
      () => frames[frames.length - 1]?.regions.loaded.includes(SPAWN) === true,
      'the loaded spawn cell in FrameContext',
    );
    expect(frames[frames.length - 1]?.regions.loading).toEqual([]);
    c.dispose();
  });
});

describe('createClient with a canvas (fake @conduit/render)', () => {
  it('registers GltfBackend, hands RenderWorld the loader, pushes replicated events into it and disposes in order', async () => {
    fakeRender.log.length = 0;
    const events: ReplicatedEventInfo[] = [];
    const throttle = { value: 0 };
    const c = track(
      createClient(game, {
        url: server.url,
        displayName: 'Renderer',
        canvas: {} as HTMLCanvasElement,
        manifest: MANIFEST,
        autoFrame: false,
        sampleInput: (ctx) => ({ tick: ctx.tick, throttle: throttle.value }),
      }),
    );
    c.on('event', (e) => events.push(e));
    const connecting = c.connect();
    expect(() => c.net).toThrow('call connect() first'); // built once the render module loaded
    await connecting;
    const world = fakeRender.worlds[fakeRender.worlds.length - 1];
    if (world === undefined) throw new Error('no RenderWorld');
    expect(world.assets).toBe(c.assets);
    expect(world.binders.map((b) => (b as object).constructor.name)).toEqual([
      'RegionBinder',
      'TransformBinder',
      'ModelBinder',
    ]);
    expect((world.binders[0] as { world: unknown }).world).toBe(world);
    expect(fakeRender.log).toEqual([]); // autoFrame false: the host is not started

    // The floating origin follows the local entity's Region once the replica has it, set before
    // the world updates, and only when it changes.
    await waitFor(() => {
      c.tickFrame(performance.now());
      return world.floatingRegion === SPAWN;
    }, 'the floating origin in the spawn cell');
    c.tickFrame(performance.now());
    const origins = world.calls.filter((call) => call !== 'update');
    expect(origins).toEqual([`setFloatingOrigin ${SPAWN}`]);
    expect(world.calls.slice(world.calls.indexOf(origins[0] as string) + 1)).toEqual([
      'update',
      'update',
    ]);

    // `model` assets load through the render module's GltfBackend.
    const ship = await c.assets?.acquire('ship');
    expect(ship?.asset).toEqual({ url: '/assets/ship.glb' });
    expect(fakeRender.log).toEqual(['GltfBackend.load /assets/ship.glb']);
    ship?.release(); // in its unload grace until the loader is disposed

    // A replicated event reaches RenderWorld.pushEvent and 'event' as the same object.
    c.send(Knock, { n: 7 });
    await waitFor(() => {
      c.tickFrame(performance.now());
      return world.pushed.length > 0;
    }, 'Beep pushed into the render world');
    const [beep] = world.pushed as ReplicatedEventInfo[];
    expect(beep?.def).toBe(Beep);
    expect(beep?.payload).toEqual({ n: 7 });
    expect(beep?.regionId).toBe(SPAWN);
    expect(events).toEqual([beep]);
    expect(events[0]).toBe(beep);

    // Driving east across the border moves the floating origin to the next cell.
    throttle.value = 127;
    await waitFor(() => {
      c.tickFrame(performance.now());
      return world.floatingRegion === EAST;
    }, 'the floating origin in the east cell');
    throttle.value = 0;
    const moved = world.calls.lastIndexOf(`setFloatingOrigin ${EAST}`);
    expect(world.calls.filter((call) => call !== 'update')).toEqual([
      `setFloatingOrigin ${SPAWN}`,
      `setFloatingOrigin ${EAST}`,
    ]);
    expect(world.calls[moved + 1]).toBe('update');
    expect(c.replica.read(c.localEntity as EntityId, Region)?.id).toBe(EAST);

    // The world releases its models before the loader disposes them, the host goes last.
    c.dispose();
    expect(fakeRender.log).toEqual([
      'GltfBackend.load /assets/ship.glb',
      'RenderWorld.dispose',
      'GltfBackend.dispose',
      'RenderHost.dispose',
    ]);
  });
});
