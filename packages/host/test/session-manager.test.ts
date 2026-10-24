import { Worker } from 'node:worker_threads';
import { MemoryStore, openApplicationSave } from '@conduit/persist';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GATEWAY_CLOSE,
  MAX_SOCKET_BUFFERED_BYTES,
  SHUTDOWN_GRACE_MS,
  STATS_INTERVAL_MS,
  WORKER_READY_TIMEOUT_MS,
} from '../src/constants.ts';
import type { MainToWorker } from '../src/port-protocol.ts';
import {
  type GatewayClient,
  type RegisteredGame,
  SessionManager,
  type SessionManagerOptions,
} from '../src/session-manager.ts';
import { Chat, FIXTURE_GAME_ID, type FixtureFlags, game } from './fixtures/game.ts';
import {
  FakeSocket,
  FIXTURE_MODULE,
  gameFrame,
  helloFrame,
  ManualTimers,
  recordingLogger,
  sleep,
  waitFor,
  WORKER_EXEC_ARGV,
} from './fixtures/helpers.ts';

const S1 = '01J8ZK4A5B6C7D8E9F0G1H2J3K';
const S2 = '01J8ZK4A5B6C7D8E9F0G1H2J3M';

interface Setup {
  manager: SessionManager;
  store: MemoryStore;
  logger: ReturnType<typeof recordingLogger>;
  crashes: [string, Error][];
  idles: string[];
  timers: ManualTimers | undefined;
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

function setup(
  opts: {
    flags?: FixtureFlags;
    manualTimers?: boolean;
    module?: string | undefined;
  } & Partial<SessionManagerOptions> = {},
): Setup {
  const store = new MemoryStore();
  const logger = recordingLogger();
  const crashes: [string, Error][] = [];
  const idles: string[] = [];
  const games = new Map<string, RegisteredGame>([
    [FIXTURE_GAME_ID, { def: game, module: 'module' in opts ? opts.module : FIXTURE_MODULE }],
  ]);
  const timers = opts.manualTimers === true ? new ManualTimers() : undefined;
  const manager = new SessionManager({
    store,
    games,
    logger,
    execArgv: WORKER_EXEC_ARGV,
    workerExtra: opts.flags as Record<string, unknown> | undefined,
    onCrash: (id, err) => crashes.push([id, err]),
    onIdle: (id) => idles.push(id),
    ...(timers === undefined
      ? {}
      : {
          now: timers.now,
          setTimeout: timers.setTimeout,
          clearTimeout: timers.clearTimeout,
          setInterval: timers.setInterval,
          clearInterval: timers.clearInterval,
        }),
    ...opts,
  });
  cleanups.push(async () => {
    const stopping = manager.shutdown();
    timers?.advance(SHUTDOWN_GRACE_MS * 4);
    await stopping;
  });
  return { manager, store, logger, crashes, idles, timers };
}

/** Every Worker spawned while the spy is active (each registers its handlers with `on`). */
function spyWorkers(): { workers(): Worker[] } {
  const on = vi.spyOn(Worker.prototype, 'on');
  return { workers: () => [...new Set(on.mock.contexts as Worker[])] };
}

function exited(worker: Worker): Promise<void> {
  return new Promise((resolve) => {
    if (worker.threadId === -1) resolve();
    else worker.once('exit', () => resolve());
  });
}

async function savedCount(store: MemoryStore, sessionId = S1): Promise<number | null> {
  const save = await openApplicationSave(store, { scope: sessionId });
  const blob = await save.get('session', 'state');
  return blob === null
    ? null
    : (JSON.parse(new TextDecoder().decode(blob)) as { saves: number }).saves;
}

function client(ws: FakeSocket, clientId: number, accountId: string): GatewayClient {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const hello = helloFrame('token', accountId);
  return {
    ws,
    clientId,
    identity: { accountId, displayName: accountId, sessionId: S1, exp },
    helloFrame: hello.buffer as ArrayBuffer,
  };
}

describe('SessionManager.start', () => {
  it('resolves after ready; isRunning is true from then', async () => {
    const { manager } = setup();
    const starting = manager.start(S1, FIXTURE_GAME_ID);
    expect(manager.has(S1)).toBe(true);
    expect(manager.isRunning(S1)).toBe(false);
    expect(manager.health()).toMatchObject([
      { sessionId: S1, gameId: FIXTURE_GAME_ID, state: 'starting' },
    ]);
    await starting;
    expect(manager.isRunning(S1)).toBe(true);
    expect(manager.health()).toMatchObject([{ state: 'running', clients: 0, tick: null }]);
    await manager.start(S1, FIXTURE_GAME_ID); // running: resolves at once
  });

  it('rejects unknown_game and no_game_module', async () => {
    const { manager } = setup({ module: undefined });
    await expect(manager.start(S1, 'nope')).rejects.toMatchObject({ code: 'unknown_game' });
    await expect(manager.start(S1, FIXTURE_GAME_ID)).rejects.toMatchObject({
      code: 'no_game_module',
    });
    expect(manager.has(S1)).toBe(false);
  });

  it('shares one worker between concurrent start calls', async () => {
    const spy = spyWorkers();
    const { manager } = setup();
    await Promise.all([manager.start(S1, FIXTURE_GAME_ID), manager.start(S1, FIXTURE_GAME_ID)]);
    await manager.start(S1, FIXTURE_GAME_ID);
    expect(spy.workers()).toHaveLength(1);
    expect(manager.health()).toHaveLength(1);
  });

  it('times out a slow load with worker_start_timeout and terminates the worker', async () => {
    const spy = spyWorkers();
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    const { manager, timers } = setup({ manualTimers: true, flags: { slowLoad: 20_000 } });
    const starting = manager.start(S1, FIXTURE_GAME_ID);
    await sleep(50);
    timers?.advance(WORKER_READY_TIMEOUT_MS - 1);
    expect(manager.has(S1)).toBe(true);
    timers?.advance(1);
    await expect(starting).rejects.toMatchObject({ code: 'worker_start_timeout' });
    expect(manager.has(S1)).toBe(false);
    expect(terminate).toHaveBeenCalled();
    const [worker] = spy.workers();
    await exited(worker as Worker);
  });

  it('fails with worker_start_failed when the module does not load', async () => {
    const { manager, logger } = setup({
      module: new URL('./fixtures/missing.ts', import.meta.url).href,
    });
    const err = await manager.start(S1, FIXTURE_GAME_ID).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'worker_start_failed' });
    expect(manager.has(S1)).toBe(false);
    expect(logger.messages('error').some((m) => m.includes('fatal'))).toBe(true);
  });
});

describe('SessionManager.stop', () => {
  it('posts shutdown, resolves once the worker exited, and the worker saved exactly once', async () => {
    const spy = spyWorkers();
    const post = vi.spyOn(Worker.prototype, 'postMessage');
    const { manager, store } = setup();
    await manager.start(S1, FIXTURE_GAME_ID);
    const [worker] = spy.workers();
    await manager.stop(S1);
    expect(post.mock.calls.map((c) => c[0] as MainToWorker)).toContainEqual({
      t: 'shutdown',
      graceMs: SHUTDOWN_GRACE_MS,
      code: GATEWAY_CLOSE.SHUTTING_DOWN,
      reason: 'shutting_down',
    });
    expect((worker as Worker).threadId).toBe(-1);
    expect(manager.has(S1)).toBe(false);
    expect(await savedCount(store)).toBe(1); // the autosaver's final save is the only shutdown save
    await manager.stop(S1); // not present: resolves
  });

  it('terminates a worker that ignores shutdown after SHUTDOWN_GRACE_MS', async () => {
    const spy = spyWorkers();
    const terminate = vi.spyOn(Worker.prototype, 'terminate');
    const { manager, timers, store } = setup({
      manualTimers: true,
      flags: { ignoreShutdown: true },
    });
    await manager.start(S1, FIXTURE_GAME_ID);
    const [worker] = spy.workers();
    let stopped = false;
    const stopping = manager.stop(S1).then(() => {
      stopped = true;
    });
    await waitFor(() => stopped || (worker as Worker).threadId !== -1, 'worker');
    await sleep(300);
    expect(stopped).toBe(false);
    expect((worker as Worker).threadId).not.toBe(-1);
    expect(manager.health()).toMatchObject([{ state: 'stopping' }]);
    expect(await savedCount(store)).toBe(1); // it did everything but exit
    timers?.advance(SHUTDOWN_GRACE_MS - 1);
    await sleep(20);
    expect(stopped).toBe(false);
    timers?.advance(1);
    await stopping;
    expect(terminate).toHaveBeenCalled();
    expect((worker as Worker).threadId).toBe(-1);
    expect(manager.has(S1)).toBe(false);
  });

  it('a start during stopping waits for the stop, then spawns a new worker that loads the save', async () => {
    const spy = spyWorkers();
    const { manager, store } = setup();
    await manager.start(S1, FIXTURE_GAME_ID);
    let stopped = false;
    const stopping = manager.stop(S1).then(() => {
      stopped = true;
    });
    const restarting = manager.start(S1, FIXTURE_GAME_ID);
    expect(manager.health()).toMatchObject([{ state: 'stopping' }]);
    await restarting;
    expect(stopped).toBe(true);
    await stopping;
    const workers = spy.workers();
    expect(workers).toHaveLength(2);
    expect(workers[0]?.threadId).toBe(-1);
    expect(manager.isRunning(S1)).toBe(true);
    await manager.flushAll();
    expect(await savedCount(store)).toBe(2);
  });
});

describe('SessionManager', () => {
  it('flushAll resolves once every running worker answered flushed; sessions keep their blobs apart', async () => {
    const { manager, store, logger } = setup();
    await Promise.all([manager.start(S1, FIXTURE_GAME_ID), manager.start(S2, FIXTURE_GAME_ID)]);
    await manager.flushAll();
    expect(await savedCount(store, S1)).toBe(1);
    expect(await savedCount(store, S2)).toBe(1);
    await manager.flushAll();
    expect(await savedCount(store, S1)).toBe(2);
    for (const scope of [S1, S2]) {
      const save = await openApplicationSave(store, { scope });
      expect(await save.list('session')).toEqual(['state']);
    }
    expect(logger.messages('error')).toEqual([]);
  });

  it('health() lists every session and its latest tickStats', async () => {
    const { manager } = setup();
    expect(manager.health()).toEqual([]);
    const before = Date.now();
    await Promise.all([manager.start(S1, FIXTURE_GAME_ID), manager.start(S2, FIXTURE_GAME_ID)]);
    const health = manager.health();
    expect(health.map((h) => [h.sessionId, h.state, h.clients])).toEqual([
      [S1, 'running', 0],
      [S2, 'running', 0],
    ]);
    for (const h of health) expect(h.startedAt).toBeGreaterThanOrEqual(before);
    await waitFor(() => manager.health().every((h) => h.tick !== null), 'tickStats', 5000);
    expect(manager.health()[0]?.tick).toMatchObject({ players: 0, dropped: expect.any(Number) });
    expect(manager.health()[0]?.tick?.tick).toBeGreaterThan(0);
  });

  it('relays a game socket: Hello to Welcome, frames both ways, closed, and the idle timer', async () => {
    const { manager, timers, idles, logger } = setup({ manualTimers: true, idleTimeoutMs: 60_000 });
    await manager.start(S1, FIXTURE_GAME_ID);
    const a = new FakeSocket();
    const b = new FakeSocket();
    manager.attach(S1, client(a, 1, 'alice'));
    manager.attach(S1, client(b, 2, 'bob'));
    expect(manager.health()).toMatchObject([{ clients: 2 }]);
    await waitFor(() => a.sent.length >= 2 && b.sent.length >= 2, 'welcome');
    expect(
      a
        .take()
        .map((m) => m.name)
        .slice(0, 2),
    ).toEqual(['Welcome', 'SessionState']);
    b.take();
    // The game's hook log (ServerContext.log) reaches the host logger through the worker's port.
    await waitFor(
      () => logger.messages('info').includes(`[session ${S1}] fixture: bob joined`),
      'the hook log lines',
    );
    expect(logger.messages('info')).toContain(`[session ${S1}] fixture: alice joined`);
    b.receive(gameFrame(Chat, { text: 'hi' }, 1));
    await waitFor(
      () =>
        a.sent.length > 0 &&
        a
          .take()
          .some((m) => m.name === 'Chat' && (m.payload as { text: string }).text === 'bob: hi'),
      'chat',
    );

    timers?.advance(STATS_INTERVAL_MS); // a stats message goes out; nothing breaks
    a.close(1000, 'bye');
    await waitFor(() => manager.health()[0]?.clients === 1, 'close relayed');
    b.emit('message', 'text frame', false);
    expect(b.closedWith).toEqual({ code: GATEWAY_CLOSE.BAD_FRAME, reason: 'binary only' });
    await waitFor(() => manager.health()[0]?.clients === 0, 'second close');
    timers?.advance(59_999);
    expect(manager.isRunning(S1)).toBe(true);
    timers?.advance(1);
    await waitFor(() => idles.length === 1, 'idle stop');
    expect(manager.has(S1)).toBe(false);
  });

  it('isolates a socket send failure without throwing from the worker message listener', async () => {
    const spawned = spyWorkers();
    const { manager, crashes } = setup();
    await manager.start(S1, FIXTURE_GAME_ID);
    const broken = new FakeSocket();
    const healthy = new FakeSocket();
    manager.attach(S1, client(broken, 1, 'alice'));
    manager.attach(S1, client(healthy, 2, 'bob'));
    await waitFor(() => broken.sent.length >= 2 && healthy.sent.length >= 2, 'welcome');
    const worker = spawned.workers()[0]!;
    vi.spyOn(broken, 'send').mockImplementationOnce(() => {
      throw new Error('socket closed during send');
    });
    expect(() =>
      worker.emit('message', { t: 'send', clientId: 1, buf: new ArrayBuffer(0) }),
    ).not.toThrow();
    await waitFor(() => manager.health()[0]?.clients === 1, 'failed socket removed');
    expect(broken.terminated).toBe(true);
    expect(manager.isRunning(S1)).toBe(true);
    expect(crashes).toEqual([]);
    healthy.take();
    healthy.receive(gameFrame(Chat, { text: 'still here' }, 1));
    await waitFor(
      () => healthy.take().some((message) => message.name === 'Chat'),
      'healthy client chat',
    );
  });

  it('closes a socket for a session that is not running, a slow client and a disconnected account', async () => {
    const { manager, timers } = setup({ manualTimers: true });
    const early = new FakeSocket();
    manager.attach(S1, client(early, 1, 'early'));
    expect(early.closedWith).toEqual({
      code: GATEWAY_CLOSE.SESSION_NOT_RUNNING,
      reason: 'session not running',
    });

    await manager.start(S1, FIXTURE_GAME_ID);
    const slow = new FakeSocket();
    const kept = new FakeSocket();
    const left = new FakeSocket();
    manager.attach(S1, client(slow, 2, 'slow'));
    manager.attach(S1, client(kept, 3, 'kept'));
    manager.attach(S1, client(left, 4, 'left'));
    slow.bufferedAmount = MAX_SOCKET_BUFFERED_BYTES + 1;
    timers?.advance(STATS_INTERVAL_MS);
    expect(slow.closedWith).toEqual({ code: GATEWAY_CLOSE.SLOW_CLIENT, reason: 'slow client' });
    manager.disconnect(S1, 'left', GATEWAY_CLOSE.LEFT, 'left');
    expect(left.closedWith).toEqual({ code: GATEWAY_CLOSE.LEFT, reason: 'left' });
    expect(kept.closedWith).toBeNull();
  });
});

it('reports stale worker telemetry separately from live/faulted lifecycle without restarting it', async () => {
  const { manager, timers } = setup({ manualTimers: true });
  await manager.start(S1, FIXTURE_GAME_ID);
  expect(manager.health()[0]).toMatchObject({ state: 'running', status: 'live' });
  timers!.advance(6000);
  expect(manager.health()[0]).toMatchObject({ state: 'running', status: 'stale' });
  expect(manager.isRunning(S1)).toBe(true);
});

it('contains a throwing legacy tickStats observer while worker health and admission remain live', async () => {
  let calls = 0;
  const { manager, logger } = setup({
    onTickStats: () => {
      calls++;
      throw Error('monitor');
    },
  });
  await manager.start(S1, FIXTURE_GAME_ID);
  await waitFor(() => calls > 0, 'tick observer', 5000);
  expect(manager.isRunning(S1)).toBe(true);
  expect(manager.health()[0]).toMatchObject({ state: 'running', status: 'live' });
  expect(logger.messages('warn')).toContain('tickStats observer failed');
});

it('pins a smaller actual worker capacity and rejects an explicitly conflicting factory', async () => {
  const good = setup();
  await good.manager.start(S1, FIXTURE_GAME_ID, 2);
  const socket = new FakeSocket();
  good.manager.attach(S1, client(socket, 91, 'capacity'));
  await waitFor(() => socket.sent.length >= 2, 'capacity Welcome');
  expect(socket.take().find((message) => message.name === 'Welcome')?.payload).toMatchObject({
    sessionCapacity: 2,
  });
  await expect(good.manager.start(S1, FIXTURE_GAME_ID, 3)).rejects.toThrow('capacity is pinned');
  const bad = setup({ flags: { capacityOverride: 8 } });
  await expect(bad.manager.start(S2, FIXTURE_GAME_ID, 2)).rejects.toThrow(
    'sessionFactory capacity 8 differs from configured lobby capacity 2',
  );
  expect(bad.manager.isRunning(S2)).toBe(false);
});
