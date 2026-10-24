import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthError, DEV_AUTH_WARNING, mintToken, tokenExpiry } from '@conduit/auth';
import { type DisconnectInfo, NetClient } from '@conduit/net-client';
import { type PlayerInfo, Session } from '@conduit/net-server';
import {
  type BlobStore,
  BlobStoreError,
  openApplicationSave,
  openNodeSqlite,
} from '@conduit/persist';
import {
  CoreKind,
  decodeWith,
  encodeWith,
  FrameWriter,
  HelloSchema,
  KickReason,
  type MessageDef,
  PlayerState,
  readFrame,
  RejectedSchema,
  RejectReason,
  WelcomeSchema,
} from '@conduit/protocol';
import type { EntityId } from '@conduit/sim';
import { BLOB_NAMESPACE, decodeBlob, type RegionLoader } from '@conduit/world';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  defineComponent,
  defineGame,
  defineInput,
  defineMessage,
  defineSystem,
  f,
  GridWorld,
  Name,
  Owner,
  Region,
  Transform,
} from '../src/index.ts';
import {
  AUTOSAVE_INTERVAL_MS,
  createServer,
  DEV_TOKEN,
  defineSessionFactory,
  type GameServer,
  MemoryStore,
  type ServerContext,
  type ServerHooks,
  type ServerLog,
  SqliteStore,
} from '../src/server.ts';
import { adaptHooks, consoleServerLog } from '../src/serverContext.ts';

const SPAWN = 'cell/1_1';
const SECRET = 'a-test-secret-that-is-at-least-32-bytes';

const Input = defineInput({ tick: f.u32, throttle: f.i8 });
type Frame = ReturnType<typeof Input.create>;
const Mover = defineComponent('Mover', { speed: f.i8 });
const Echo = defineMessage('Echo', 'both', { text: f.str(64) });
const Ignored = defineMessage('Ignored', 'c2s', { n: f.u8 });

/** What the `input` system and the `Echo` handler observed (test instrumentation, not sim state). */
const probe = {
  lastSystemTick: -1,
  pendingEcho: false,
  echoSeenBySystemAt: -1,
};

const observe = defineSystem('observe', 'input', (ctx) => {
  if (probe.pendingEcho) {
    probe.pendingEcho = false;
    probe.echoSeenBySystemAt = ctx.tick;
  }
  probe.lastSystemTick = ctx.tick;
});

const game = defineGame({
  id: 'server-test',
  name: 'Server test',
  protocolVersion: 7,
  seed: 42,
  components: [Mover],
  messages: [Echo, Ignored],
  events: [],
  input: Input,
  systems: [observe],
  world: (seed) =>
    new GridWorld({ cellSize: 64, cols: 3, rows: 3, wantedDepth: 1, worldSeed: seed }),
});

interface Record {
  populated: string[];
  /** Regions whose `populate` received a saved blob (restored rather than seeded). */
  restored: string[];
  inits: number;
  loaded: unknown[];
  saves: number;
  joins: PlayerInfo[];
  spawns: {
    entity: EntityId;
    spawnRegionActive: boolean;
    populated: boolean;
    isServerContext: boolean;
  }[];
  leaves: string[];
  echoes: { text: string; tick: number; lastSystemTick: number; player: number }[];
}

function newRecord(): Record {
  return {
    populated: [],
    restored: [],
    inits: 0,
    loaded: [],
    saves: 0,
    joins: [],
    spawns: [],
    leaves: [],
    echoes: [],
  };
}

function loaderFor(record: Record): RegionLoader {
  return {
    populate(region, _blob, ctx) {
      record.populated.push(region.id);
      const e = ctx.world.create();
      ctx.world.add(e, Region, { id: region.id });
      ctx.world.add(e, Transform, { pos: { x: 8, y: 0, z: 8 } });
    },
  };
}

/**
 * Seeds a fresh region with one marker entity at (8, 0, 8); a region with a saved blob gets nothing,
 * since the core already restored its persisted entities (docs/world.md 5.3).
 */
function persistentLoaderFor(record: Record): RegionLoader {
  return {
    populate(region, blob, ctx) {
      record.populated.push(region.id);
      if (blob !== null) {
        record.restored.push(region.id);
        return;
      }
      const e = ctx.world.create();
      ctx.world.add(e, Region, { id: region.id });
      ctx.world.add(e, Transform, { pos: { x: 8, y: 0, z: 8 } });
    },
  };
}

/** Why the node:sqlite cases are skipped in this process, or null when node:sqlite is available. */
function nodeSqliteSkipReason(): string | null {
  try {
    openNodeSqlite(':memory:').close();
    return null;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ERR_UNKNOWN_BUILTIN_MODULE') {
      console.warn(`Skipping node:sqlite tests. ${err.message}`);
      return err.message;
    }
    throw err;
  }
}

function hooksFor(record: Record): ServerHooks<Frame> {
  let state = { joins: 0 };
  return {
    onInit() {
      record.inits++;
      state = { joins: 0 };
    },
    onLoad(_ctx, saved) {
      record.loaded.push(saved);
      state = saved as { joins: number };
    },
    onSave() {
      record.saves++;
      return state;
    },
    onPlayerJoin(player, ctx) {
      record.joins.push({ ...player });
      state.joins++;
      return {
        regionId: SPAWN,
        spawn(spawnCtx) {
          const e = spawnCtx.world.create();
          spawnCtx.world.add(e, Region, { id: SPAWN });
          spawnCtx.world.add(e, Transform, { pos: { x: 32, y: 0, z: 32 } });
          spawnCtx.world.add(e, Owner, { player: player.playerId });
          spawnCtx.world.add(e, Name, { value: player.displayName });
          spawnCtx.world.add(e, Mover, { speed: 0 });
          record.spawns.push({
            entity: e,
            spawnRegionActive: ctx.regionManager.state(SPAWN) === 'active',
            populated: record.populated.includes(SPAWN),
            isServerContext: (spawnCtx as ServerContext<Frame>).game === game,
          });
          return e;
        },
      };
    },
    onPlayerLeave(player) {
      record.leaves.push(player.displayName);
    },
    onMessage: {
      Echo(player, msg, ctx) {
        const { text } = msg as { text: string };
        record.echoes.push({
          text,
          tick: ctx.tick,
          lastSystemTick: probe.lastSystemTick,
          player: player.playerId,
        });
        probe.pendingEcho = true;
        ctx.send(player.playerId, Echo, { text: `echo:${text}` });
      },
    },
  };
}

interface LogEntry {
  level: string;
  msg: string;
  data: unknown;
}

function logger(): { log: ServerLog; entries: LogEntry[]; errors: () => LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    log: (level, msg, data) => entries.push({ level, msg, data }),
    entries,
    errors: () => entries.filter((e) => e.level === 'error'),
  };
}

function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = async (): Promise<void> => {
      try {
        if (await predicate()) resolve();
        else if (performance.now() > deadline) reject(new Error(`timed out waiting for ${label}`));
        else
          setTimeout(() => {
            void poll();
          }, 5);
      } catch (cause) {
        reject(cause);
      }
    };
    void poll();
  });
}

interface RawMessage {
  kind: number;
  payload: unknown;
}

/** A `ws` client speaking just enough of the protocol to send Hello and read the answer. */
async function rawHello(
  url: string,
  hello: { token: string; displayName: string },
): Promise<{ ws: WebSocket; first: RawMessage; closed: Promise<number> }> {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const messages: RawMessage[] = [];
  ws.on('message', (data) => {
    readFrame(new Uint8Array(data as ArrayBuffer), (h, r) => {
      if (h.kind === CoreKind.Welcome)
        messages.push({ kind: h.kind, payload: decodeWith(r, WelcomeSchema) });
      else if (h.kind === CoreKind.Rejected)
        messages.push({ kind: h.kind, payload: decodeWith(r, RejectedSchema) });
      else messages.push({ kind: h.kind, payload: undefined });
    });
  });
  const closed = new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const fw = new FrameWriter();
  fw.begin();
  fw.message(CoreKind.Hello, 0, 0, (w) =>
    encodeWith(w, HelloSchema, {
      protocolVersion: game.protocolVersion,
      registryHash: game.registryHash,
      sessionToken: hello.token,
      reconnectToken: '',
      displayName: hello.displayName,
    }),
  );
  ws.send(fw.finish());
  await waitFor(() => messages.length > 0, 'Welcome or Rejected');
  return { ws, first: messages[0] as RawMessage, closed };
}

const servers: GameServer[] = [];
const sockets: WebSocket[] = [];
const clients: NetClient[] = [];

async function start(
  record: Record,
  opts: {
    devAuth?: boolean;
    secret?: string;
    store?: BlobStore;
    log?: ServerLog;
    regionLoader?: RegionLoader;
    autosaveIntervalMs?: number;
    port?: number;
  } = {},
): Promise<GameServer> {
  const server = await createServer(game, {
    regionLoader: opts.regionLoader ?? loaderFor(record),
    hooks: hooksFor(record),
    log: opts.log ?? logger().log,
    devAuth: opts.devAuth,
    secret: opts.secret,
    store: opts.store,
    autosaveIntervalMs: opts.autosaveIntervalMs,
    port: opts.port,
  });
  servers.push(server);
  return server;
}

function netClient(
  server: GameServer,
  displayName: string,
  opts: { autoReconnect?: boolean } = {},
): NetClient {
  const client = new NetClient({
    url: server.url,
    game,
    token: DEV_TOKEN,
    displayName,
    log: () => {},
    ...opts,
  });
  clients.push(client);
  return client;
}

/** Decodes the JSON `session`/`state` blob `onSave` stored, or `null`. */
async function savedState(store: BlobStore): Promise<unknown> {
  const blob = await (await openApplicationSave(store)).get('session', 'state');
  return blob === null ? null : JSON.parse(new TextDecoder().decode(blob));
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  for (const ws of sockets.splice(0)) ws.terminate();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('createServer', () => {
  it('throws without a secret or devAuth: true', () => {
    const record = newRecord();
    const base = { regionLoader: loaderFor(record), hooks: hooksFor(record), log: logger().log };
    expect(() => createServer(game, base)).toThrow('createServer: pass secret or devAuth: true');
    expect(() => createServer(game, { ...base, devAuth: false, secret: '' })).toThrow(
      'createServer: pass secret or devAuth: true',
    );
    expect(() => createServer(game, { ...base, secret: 'short' })).toThrow(AuthError);
    const dev = { ...base, devAuth: true };
    expect(() => createServer(game, { ...dev, port: 70000 })).toThrow(RangeError);
    expect(() => createServer(game, { ...dev, port: 1.5 })).toThrow(RangeError);
    expect(() => createServer(game, { ...dev, autosaveIntervalMs: 0 })).toThrow(RangeError);
    expect(AUTOSAVE_INTERVAL_MS).toBe(60_000);
  });

  it('listens on an ephemeral port with devAuth and logs DEV_AUTH_WARNING once', async () => {
    const logs = logger();
    const server = await start(newRecord(), { devAuth: true, log: logs.log });
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`ws://127.0.0.1:${server.port}`);
    expect(server.session.running).toBe(true);
    expect(server.session.id).toBe('dev');
    const warnings = logs.entries.filter((e) => e.msg === DEV_AUTH_WARNING);
    expect(warnings).toEqual([{ level: 'warn', msg: DEV_AUTH_WARNING, data: undefined }]);
  });

  it('accepts any token with devAuth and passes the Hello displayName to onPlayerJoin', async () => {
    const record = newRecord();
    const logs = logger();
    const server = await start(record, { devAuth: true, log: logs.log });
    const a = await rawHello(server.url, { token: '', displayName: 'Alice' });
    sockets.push(a.ws);
    const b = await rawHello(server.url, { token: 'anything at all', displayName: 'Bob' });
    sockets.push(b.ws);
    expect(a.first.kind).toBe(CoreKind.Welcome);
    expect(b.first.kind).toBe(CoreKind.Welcome);
    expect(a.first.payload).toMatchObject({
      playerId: 0,
      worldSeed: 42,
      simTickRate: 60,
      snapshotEvery: 3,
    });
    expect(b.first.payload).toMatchObject({ playerId: 1 });
    await waitFor(() => record.joins.length === 2, 'two joins');
    expect(record.joins.map((p) => [p.displayName, p.accountId, p.state])).toEqual([
      ['Alice', 'dev:alice', PlayerState.Joined],
      ['Bob', 'dev:bob', PlayerState.Joined],
    ]);
    a.ws.close();
    await waitFor(() => record.leaves.length === 1, 'leave of Alice');
    expect(record.leaves).toEqual(['Alice']);
    expect(logs.errors()).toEqual([]);
  });

  it('with a secret rejects a bad token and admits a minted one for session dev', async () => {
    const record = newRecord();
    const server = await start(record, { secret: SECRET });
    expect(server.session.id).toBe('dev');

    const bad = await rawHello(server.url, { token: DEV_TOKEN, displayName: 'Mallory' });
    sockets.push(bad.ws);
    expect(bad.first).toEqual({
      kind: CoreKind.Rejected,
      payload: { reason: RejectReason.BadToken, detail: 'bad token' },
    });
    expect(await bad.closed).toBe(4008);

    const otherSession = mintToken(
      { accountId: 'acct-2', displayName: 'Eve', sessionId: 'elsewhere', exp: tokenExpiry() },
      SECRET,
    );
    const wrong = await rawHello(server.url, { token: otherSession, displayName: 'Eve' });
    sockets.push(wrong.ws);
    expect(wrong.first.kind).toBe(CoreKind.Rejected);

    const token = mintToken(
      { accountId: 'acct-1', displayName: 'Minty', sessionId: 'dev', exp: tokenExpiry() },
      SECRET,
    );
    const good = await rawHello(server.url, { token, displayName: 'Minty' });
    sockets.push(good.ws);
    expect(good.first.kind).toBe(CoreKind.Welcome);
    await waitFor(() => record.joins.length === 1, 'join');
    expect(record.joins[0]).toMatchObject({ accountId: 'acct-1', displayName: 'Minty' });
  });

  it('calls PlayerSpawn.spawn once the spawn region is active', async () => {
    const record = newRecord();
    const logs = logger();
    const server = await start(record, { devAuth: true, log: logs.log });
    const client = netClient(server, 'Spawner');
    await client.connect();
    await waitFor(() => client.state === 'Playing', 'Playing');
    expect(record.spawns).toHaveLength(1);
    const spawn = record.spawns[0];
    expect(spawn).toMatchObject({
      spawnRegionActive: true,
      populated: true,
      isServerContext: true,
    });
    expect(client.entity).toBe(spawn?.entity);
    expect(server.session.world.alive(spawn?.entity ?? 0)).toBe(true);
    expect(record.populated).toContain(SPAWN);
    expect(logs.errors()).toEqual([]);
  });

  it('runs onInit on a fresh store and onLoad with the saved value on the next start', async () => {
    const store = new MemoryStore();
    const first = newRecord();
    const s1 = await start(first, { devAuth: true, store });
    expect(first.inits).toBe(1);
    expect(first.loaded).toEqual([]);
    const raw = await rawHello(s1.url, { token: DEV_TOKEN, displayName: 'Saver' });
    sockets.push(raw.ws);
    await waitFor(() => first.joins.length === 1, 'join');
    await s1.close();
    expect(first.saves).toBe(1);
    const blob = await (await openApplicationSave(store)).get('session', 'state');
    expect(JSON.parse(new TextDecoder().decode(blob ?? new Uint8Array()))).toEqual({ joins: 1 });

    const second = newRecord();
    await start(second, { devAuth: true, store });
    expect(second.inits).toBe(0);
    expect(second.loaded).toEqual([{ joins: 1 }]);
  });

  it('dispatches a game message to onMessage before the tick systems and lets it reply', async () => {
    const record = newRecord();
    const logs = logger();
    const server = await start(record, { devAuth: true, log: logs.log });
    const client = netClient(server, 'Echoer');
    const replies: unknown[] = [];
    client.on('message', (m) => replies.push([m.def.name, m.payload]));
    await client.connect();
    await waitFor(() => server.session.tick >= 2, 'a few ticks');
    Object.assign(probe, { lastSystemTick: server.session.tick, echoSeenBySystemAt: -1 });
    client.send(Echo, { text: 'hello' });
    await waitFor(() => replies.length === 1, 'the echo reply');
    expect(replies).toEqual([['Echo', { text: 'echo:hello' }]]);
    expect(record.echoes).toHaveLength(1);
    const echo = record.echoes[0];
    // ctx.tick is the last simulated tick: that tick's systems ran, the coming tick's had not.
    expect(echo?.lastSystemTick).toBe(echo?.tick);
    expect(probe.echoSeenBySystemAt).toBe((echo?.tick ?? 0) + 1);
    expect(echo?.player).toBe(client.playerId);
    expect(logs.errors()).toEqual([]);
  });

  it('autosaves regions and onSave every autosaveIntervalMs while running', async () => {
    const record = newRecord();
    const store = new MemoryStore();
    const server = await start(record, { devAuth: true, store, autosaveIntervalMs: 20 });
    const raw = await rawHello(server.url, { token: DEV_TOKEN, displayName: 'Autosaved' });
    sockets.push(raw.ws);
    await waitFor(() => record.populated.includes(SPAWN), 'the spawn region active');
    await waitFor(
      async () =>
        record.saves >= 2 &&
        (await (await openApplicationSave(store)).list('region')).length ===
          record.populated.length,
      'two autosaves covering every active region',
    );
    expect(server.session.running).toBe(true);
    expect(await savedState(store)).toEqual({ joins: 1 });
  });

  it('close() stops the loop, kicks clients with ServerShutdown, saves once, then closes the store; idempotent', async () => {
    const record = newRecord();
    const order: string[] = [];
    const store = Object.assign(new MemoryStore(), {
      close: vi.fn(() => {
        order.push('store.close');
      }),
    });
    const server = await start(record, { devAuth: true, store });
    const regions = server.session.regions;
    const regionsCapture = regions.captureSave.bind(regions);
    const flush = vi.spyOn(regions, 'captureSave').mockImplementation(() => {
      order.push(`regions.captureSave (running: ${server.session.running})`);
      return regionsCapture();
    });
    const client = netClient(server, 'Closer');
    const disconnects: DisconnectInfo[] = [];
    const kicks: number[] = [];
    client.on('kicked', (k) => kicks.push(k.reason));
    client.on('disconnected', (info) => disconnects.push(info));
    await client.connect();
    await waitFor(() => client.state === 'Playing', 'Playing');
    expect(record.saves).toBe(0); // the default autosave interval is 60 s
    const closing = server.close();
    expect(server.close()).toBe(closing);
    await closing;
    // One shutdown save (the autosaver's final one), after the loop stopped; then the store closed.
    expect(flush).toHaveBeenCalledTimes(1);
    expect(record.saves).toBe(1);
    expect(order).toEqual(['regions.captureSave (running: false)', 'store.close']);
    expect(server.session.running).toBe(false);
    const tick = server.session.tick;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.session.tick).toBe(tick);
    expect(await savedState(store)).toEqual({ joins: 1 });

    // A shutdown close is reconnectable (docs/net.md A.3), so the client retries until told to stop.
    await waitFor(() => client.state === 'Reconnecting', 'client reconnecting');
    expect(kicks).toEqual([KickReason.ServerShutdown]);
    expect(disconnects).toMatchObject([{ code: 1001, willReconnect: true }]);
    client.disconnect();
    expect(client.state).toBe('Disconnected');
    await expect(rawHello(server.url, { token: DEV_TOKEN, displayName: 'Late' })).rejects.toThrow();
    await server.close();
    expect(store.close).toHaveBeenCalledTimes(1);
  });

  it('closes the store and stops the session when listening fails', async () => {
    const taken = await start(newRecord(), { devAuth: true });
    const record = newRecord();
    const store = Object.assign(new MemoryStore(), { close: vi.fn() });
    const logs = logger();
    const failed = await start(record, {
      devAuth: true,
      store,
      port: taken.port,
      log: logs.log,
    }).catch((err: unknown) => err);
    expect(failed).toMatchObject({ code: 'EADDRINUSE' });
    expect(record.inits).toBe(1); // the session had started
    expect(record.saves).toBe(1); // and was stopped, which saves
    expect(store.close).toHaveBeenCalledTimes(1);
    expect(logs.errors()).toEqual([]);
  });
});

const sqliteSkipReason = nodeSqliteSkipReason();

describe.skipIf(sqliteSkipReason !== null)(
  sqliteSkipReason === null
    ? 'createServer on a SqliteStore'
    : `createServer on a SqliteStore (skipped: ${sqliteSkipReason})`,
  () => {
    let dir = '';
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'conduit-game-server-'));
    });
    afterEach(async () => {
      await Promise.all(servers.splice(0).map((s) => s.close()));
      rmSync(dir, { recursive: true, force: true });
    });

    /** The marker entity of `regionId` in `server`'s world: its position. */
    function markers(server: GameServer, regionId: string): { x: number; y: number; z: number }[] {
      const { world, regions } = server.session;
      return regions.entitiesIn(regionId).map((e) => ({ ...world.get(e, Transform).pos }));
    }

    it('autosaves into the file, closes it on close(), and a second createServer on the same file restores region blobs and onLoad state', async () => {
      const file = join(dir, 'session.sqlite');
      const first = newRecord();
      const store = new SqliteStore(file);
      const s1 = await start(first, {
        devAuth: true,
        store,
        regionLoader: persistentLoaderFor(first),
        autosaveIntervalMs: 25,
      });
      expect(first.inits).toBe(1);
      const a = await rawHello(s1.url, { token: DEV_TOKEN, displayName: 'Saver' });
      sockets.push(a.ws);
      // The 3 x 3 world is one spawn neighbourhood: every cell activates, seeded (no blobs yet).
      await waitFor(() => first.populated.length === 9, 'nine regions active');
      expect(first.restored).toEqual([]);
      // Move the spawn cell's marker, so a restored region differs from a freshly seeded one.
      const [marker] = s1.session.regions.entitiesIn(SPAWN);
      if (marker === undefined) throw new Error('no marker in the spawn region');
      const pos = s1.session.world.write(marker, Transform).pos;
      pos.x = 40.25;
      pos.z = 20.5;

      // Saved while running: read through a second connection (WAL readers see committed saves).
      const reader = new SqliteStore(file);
      try {
        await waitFor(async () => {
          const saved = await openApplicationSave(reader);
          const blob = decodeBlob(await saved.get(BLOB_NAMESPACE, SPAWN));
          return (blob?.entities ?? []).some((entity) =>
            entity.components.some(
              ([name, value]) =>
                name === 'Transform' && (value as { pos: { x: number } }).pos.x === 40.25,
            ),
          );
        }, 'an autosave with the moved marker');
        expect(await savedState(reader)).toEqual({ joins: 1 });
      } finally {
        reader.close();
      }

      await s1.close();
      expect(store.closed).toBe(true);
      await expect(store.get('session', 'state')).rejects.toBeInstanceOf(BlobStoreError);
      const saved = markers(s1, SPAWN);
      expect(saved).toEqual([{ x: 40.25, y: 0, z: 20.5 }]);

      const second = newRecord();
      const reopened = new SqliteStore(file);
      const s2 = await start(second, {
        devAuth: true,
        store: reopened,
        regionLoader: persistentLoaderFor(second),
      });
      expect(second.inits).toBe(0);
      expect(second.loaded).toEqual([{ joins: 1 }]);
      const b = await rawHello(s2.url, { token: DEV_TOKEN, displayName: 'Loader' });
      sockets.push(b.ws);
      await waitFor(() => second.populated.length === 9, 'nine regions active again');
      expect(second.restored).toEqual(first.populated);
      expect(markers(s2, SPAWN)).toEqual(saved);
      for (const id of second.populated) expect(markers(s2, id)).toEqual(markers(s1, id));

      await s2.close();
      expect(reopened.closed).toBe(true);
      const check = new SqliteStore(file);
      try {
        expect(await savedState(check)).toEqual({ joins: 2 });
        expect((await (await openApplicationSave(check)).list(BLOB_NAMESPACE)).sort()).toEqual(
          [...first.populated].sort(),
        );
      } finally {
        check.close();
      }
    });
  },
);

describe('defineSessionFactory and adaptHooks', () => {
  it('builds per-session hooks that see a ServerContext and JSON save/load', async () => {
    const record = newRecord();
    const seen: string[] = [];
    let captured: ServerContext<Frame> | undefined;
    const factory = defineSessionFactory(game, (sessionId) => {
      seen.push(sessionId);
      const hooks = hooksFor(record);
      return {
        regionLoader: loaderFor(record),
        hooks: {
          ...hooks,
          onInit(ctx) {
            captured = ctx;
          },
          onSave: () => undefined,
        },
      };
    });
    const { regionLoader, hooks } = factory('session-a');
    expect(seen).toEqual(['session-a']);
    const store = new MemoryStore();
    const session = new Session(game, {
      store,
      regionLoader,
      hooks,
      manualLoop: true,
      log: () => {},
    });
    await session.start();
    expect(captured?.game).toBe(game);
    expect(captured?.sim).toBe(session.simulation);
    expect(captured?.regionManager).toBe(session.regions);
    expect(captured?.spatialIndex).toBe(session.spatial);
    expect(captured?.session).toBe(session);
    expect(captured?.players).toEqual([]);
    session.step();
    session.step();
    expect(captured?.tick).toBe(2); // live through the prototype chain
    expect(captured?.inputs(0)).toBeUndefined();
    await session.stop();
    // onSave returned undefined, which JSON cannot hold: stored as null, handed to onLoad as null.
    expect(
      new TextDecoder().decode(
        (await (await openApplicationSave(store)).get('session', 'state')) ?? undefined,
      ),
    ).toBe('null');
  });

  it("gives the ServerContext the log the host worker passes, and the console's without one", async () => {
    const lines: [string, string, unknown][] = [];
    const contexts: ServerContext<Frame>[] = [];
    const factory = defineSessionFactory(game, () => ({
      regionLoader: loaderFor(newRecord()),
      hooks: {
        ...hooksFor(newRecord()),
        onInit(ctx) {
          contexts.push(ctx);
          ctx.log('info', 'hook line', { n: 1 });
        },
      },
    }));
    for (const built of [
      factory('logged', { log: (level, msg, data) => lines.push([level, msg, data]) }),
      factory('console'),
    ]) {
      const session = new Session(game, {
        store: new MemoryStore(),
        regionLoader: built.regionLoader,
        hooks: built.hooks,
        manualLoop: true,
        log: () => {},
      });
      const info = vi.spyOn(console, 'info').mockImplementation(() => {});
      await session.start();
      await session.stop();
      info.mockRestore();
      if (lines.length === 1) expect(info).not.toHaveBeenCalled();
      else expect(info).toHaveBeenCalledWith('[conduit/game] hook line', { n: 1 });
    }
    expect(lines).toEqual([['info', 'hook line', { n: 1 }]]);
    expect(contexts[1]?.log).toBe(consoleServerLog);
  });

  it('dispatches onMessage by own name and counts messages without a handler', async () => {
    const record = newRecord();
    const adapted = adaptHooks(hooksFor(record), game, () => {});
    const session = new Session(game, {
      store: new MemoryStore(),
      regionLoader: loaderFor(record),
      hooks: adapted,
      manualLoop: true,
      log: () => {},
    });
    await session.start();
    const player: PlayerInfo = {
      playerId: 0,
      accountId: 'dev:x',
      displayName: 'X',
      state: PlayerState.Playing,
      entity: 0,
    };
    adapted.onMessage?.(player, Ignored as MessageDef, { n: 1 }, session.ctx);
    const inherited = { ...Ignored, name: 'toString' } as MessageDef;
    adapted.onMessage?.(player, inherited, { n: 2 }, session.ctx);
    expect(adapted.unhandledMessages).toBe(2);
    adapted.onMessage?.(player, Echo as MessageDef, { text: 'direct' }, session.ctx);
    expect(adapted.unhandledMessages).toBe(2);
    expect(record.echoes.map((e) => e.text)).toEqual(['direct']);
    expect(() => adaptHooks({} as ServerHooks<Frame>, game)).toThrow(TypeError);
    await session.stop();
  });
});
