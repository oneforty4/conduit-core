import { Worker } from 'node:worker_threads';
import type { SessionToken } from '@conduit/auth';
import { LobbyService, lobbyMigrations } from '@conduit/lobby';
import { migrate, openApplicationSave, SqliteStore } from '@conduit/persist';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDLE_TIMEOUT_MS, SHUTDOWN_GRACE_MS } from '../src/constants.ts';
import type { MainToWorker } from '../src/port-protocol.ts';
import { type RegisteredGame, SessionManager } from '../src/session-manager.ts';
import { game } from './fixtures/game.ts';
import {
  FakeSocket,
  FIXTURE_MODULE,
  helloFrame,
  ManualTimers,
  PASSWORD,
  recordingLogger,
  SECRET,
  sleep,
  waitFor,
  WORKER_EXEC_ARGV,
} from './fixtures/helpers.ts';

interface Stack {
  store: SqliteStore;
  timers: ManualTimers;
  manager: SessionManager;
  service: LobbyService;
  accountId: string;
  sessionId: string;
  idles: string[];
}

const stacks: Stack[] = [];

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    const stopping = stack.manager.shutdown();
    stack.timers.advance(SHUTDOWN_GRACE_MS * 2);
    await stopping;
    stack.store.close();
  }
  vi.restoreAllMocks();
});

/** The host's session stack with virtual timers: SQLite store, lobby service, SessionManager. */
async function stack(): Promise<Stack> {
  const store = new SqliteStore(':memory:');
  migrate(store.db, lobbyMigrations);
  const timers = new ManualTimers();
  const games = new Map<string, RegisteredGame>([[game.id, { def: game, module: FIXTURE_MODULE }]]);
  const idles: string[] = [];
  const holder: { service: LobbyService | null } = { service: null };
  const manager = new SessionManager({
    store,
    games,
    logger: recordingLogger(),
    execArgv: WORKER_EXEC_ARGV,
    onCrash: (id) => holder.service?.markIdle(id),
    onIdle: (id) => {
      idles.push(id);
      holder.service?.markIdle(id);
    },
    now: timers.now,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  });
  const service = new LobbyService(store.db, {
    host: manager,
    games: { list: () => [], has: (id) => games.has(id) },
    secret: SECRET,
  });
  holder.service = service;
  const account = await service.register({ username: 'alice', password: PASSWORD });
  const { session } = service.createSession(account.id, {
    gameId: game.id,
    name: 'idle',
    visibility: 'private',
    maxPlayers: 4,
  });
  const created: Stack = {
    store,
    timers,
    manager,
    service,
    accountId: account.id,
    sessionId: session.id,
    idles,
  };
  stacks.push(created);
  return created;
}

function rowState(s: Stack): unknown {
  return (
    s.store.db.prepare('SELECT state FROM sessions WHERE id = ?').get(s.sessionId) as {
      state: string;
    }
  ).state;
}

/** A game socket handed over by the gateway, for the stack's account. */
function attachClient(s: Stack, clientId: number): FakeSocket {
  const ws = new FakeSocket();
  const identity: SessionToken = {
    accountId: s.accountId,
    displayName: 'alice',
    sessionId: s.sessionId,
    exp: Math.floor(Date.now() / 1000) + 600,
  };
  s.manager.attach(s.sessionId, {
    ws,
    clientId,
    identity,
    helloFrame: helloFrame('token', 'alice').buffer as ArrayBuffer,
  });
  return ws;
}

async function savedState(s: Stack): Promise<{ saves: number } | null> {
  const save = await openApplicationSave(s.store, { scope: s.sessionId });
  const blob = await save.get('session', 'state');
  return blob === null ? null : (JSON.parse(new TextDecoder().decode(blob)) as { saves: number });
}

describe('idle stop', () => {
  it('stops a session IDLE_TIMEOUT_MS after its last client left: flushed, exited, row idle', async () => {
    const s = await stack();
    const workers = vi.spyOn(Worker.prototype, 'on');
    const post = vi.spyOn(Worker.prototype, 'postMessage');
    await s.service.joinSession(s.accountId, s.sessionId);
    expect(rowState(s)).toBe('running');
    expect(s.manager.isRunning(s.sessionId)).toBe(true);
    const worker = workers.mock.contexts[0] as Worker;

    const ws = attachClient(s, 1);
    await waitFor(() => ws.take().some((m) => m.name === 'Welcome'), 'Welcome');
    s.timers.advance(IDLE_TIMEOUT_MS * 2); // a connected client never idles out
    expect(s.manager.isRunning(s.sessionId)).toBe(true);
    ws.close(1000, 'bye');
    await waitFor(() => s.manager.health()[0]?.clients === 0, 'the close');
    expect(await savedState(s)).toBeNull();

    s.timers.advance(IDLE_TIMEOUT_MS - 1);
    await sleep(50);
    expect(s.manager.isRunning(s.sessionId)).toBe(true);
    expect(post.mock.calls.some((c) => (c[0] as MainToWorker).t === 'shutdown')).toBe(false);

    s.timers.advance(1);
    expect(post.mock.calls.map((c) => c[0] as MainToWorker)).toContainEqual(
      expect.objectContaining({ t: 'shutdown', code: 4111 }),
    );
    await waitFor(() => s.idles.length === 1, 'onIdle');
    expect(s.idles).toEqual([s.sessionId]);
    expect(worker.threadId).toBe(-1);
    expect(s.manager.has(s.sessionId)).toBe(false);
    expect(await savedState(s)).toEqual({ saves: 1 }); // the shutdown save
    const save = await openApplicationSave(s.store, { scope: s.sessionId });
    expect(await save.list('session')).toEqual(['state']);
    expect(rowState(s)).toBe('idle');

    // The next join starts a worker that loads that save.
    await s.service.joinSession(s.accountId, s.sessionId);
    expect(rowState(s)).toBe('running');
    await s.manager.flushAll();
    expect(await savedState(s)).toEqual({ saves: 2 });
  });

  it('a client attaching at IDLE_TIMEOUT_MS - 1 cancels the timer', async () => {
    const s = await stack();
    await s.service.joinSession(s.accountId, s.sessionId);
    s.timers.advance(IDLE_TIMEOUT_MS - 1); // armed at ready: nobody attached yet
    const ws = attachClient(s, 1);
    s.timers.advance(1);
    s.timers.advance(IDLE_TIMEOUT_MS);
    await sleep(50);
    expect(s.manager.isRunning(s.sessionId)).toBe(true);
    expect(s.idles).toEqual([]);
    ws.close(1000, '');
    await waitFor(() => s.manager.health()[0]?.clients === 0, 'the close');
    s.timers.advance(IDLE_TIMEOUT_MS);
    await waitFor(() => s.idles.length === 1, 'onIdle');
    expect(rowState(s)).toBe('idle');
  });

  it('a lobby join of a running session without sockets restarts its idle timer, so the joiner finds it running', async () => {
    const s = await stack();
    await s.service.joinSession(s.accountId, s.sessionId); // starts the worker; the timer is armed
    s.timers.advance(IDLE_TIMEOUT_MS - 1); // nobody attached: the timer is about to fire

    // The race: the session is running, so this join starts nothing; without the touch the old
    // deadline stops the worker before the joiner's socket arrives, which then gets 4104.
    await s.service.joinSession(s.accountId, s.sessionId);
    s.timers.advance(1);
    await sleep(50);
    expect(s.manager.isRunning(s.sessionId)).toBe(true);
    expect(s.idles).toEqual([]);
    const ws = attachClient(s, 1);
    await waitFor(() => ws.take().some((m) => m.name === 'Welcome'), 'Welcome');
    expect(ws.closedWith).toBeNull();
    s.manager.touch(s.sessionId); // a socket is attached: no timer is armed, and none is now
    s.timers.advance(IDLE_TIMEOUT_MS * 2);
    await sleep(50);
    expect(s.manager.isRunning(s.sessionId)).toBe(true);
    ws.close(1000, 'bye');
    await waitFor(() => s.manager.health()[0]?.clients === 0, 'the close');

    // The timer armed by the close, restarted by a join just before it fires, still idles it out.
    s.timers.advance(IDLE_TIMEOUT_MS - 1);
    await s.service.joinSession(s.accountId, s.sessionId);
    s.timers.advance(IDLE_TIMEOUT_MS - 1);
    await sleep(50);
    expect(s.manager.isRunning(s.sessionId)).toBe(true);
    s.timers.advance(1);
    await waitFor(() => s.idles.length === 1, 'onIdle');
    expect(rowState(s)).toBe('idle');
    s.manager.touch(s.sessionId); // not running: a no-op
    expect(s.manager.has(s.sessionId)).toBe(false);
  });

  it('a session started but never attached idles out too', async () => {
    const s = await stack();
    await s.service.joinSession(s.accountId, s.sessionId);
    expect(s.timers.nextIn()).toBeLessThanOrEqual(IDLE_TIMEOUT_MS);
    s.timers.advance(IDLE_TIMEOUT_MS);
    await waitFor(() => s.idles.length === 1, 'onIdle');
    expect(s.manager.has(s.sessionId)).toBe(false);
    expect(rowState(s)).toBe('idle');
    expect(await savedState(s)).toEqual({ saves: 1 });
  });
});
