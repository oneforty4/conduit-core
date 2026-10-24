import type { LobbyEvent, PublicAccount, SessionSummary } from '@conduit/lobby';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LobbyClient,
  PRESENCE_BACKOFF_MAX_MS,
  PRESENCE_BACKOFF_MIN_MS,
  PRESENCE_PING_INTERVAL_MS,
  PresenceConnection,
} from '../src/index.ts';

type Listener = (ev: unknown) => void;

/** A scriptable stand-in for the WHATWG WebSocket: the test plays the server. */
class FakeWebSocket {
  static readonly instances: FakeWebSocket[] = [];
  static failNext: Error | null = null;

  readonly url: string;
  readonly init: unknown;
  readonly argCount: number;
  readyState = 0;
  readonly sent: unknown[] = [];
  readonly closeCalls: (number | undefined)[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(...args: [url: string, init?: unknown]) {
    if (FakeWebSocket.failNext !== null) {
      const err = FakeWebSocket.failNext;
      FakeWebSocket.failNext = null;
      throw err;
    }
    this.url = args[0];
    this.init = args[1];
    this.argCount = args.length;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('send while not open');
    this.sent.push(JSON.parse(data));
  }

  close(code?: number): void {
    this.closeCalls.push(code);
    if (this.readyState < 2) this.readyState = 2;
  }

  // Server side of the script.
  open(): void {
    this.readyState = 1;
    this.dispatch('open', { type: 'open' });
  }

  receive(msg: unknown): void {
    this.dispatch('message', { data: typeof msg === 'string' ? msg : JSON.stringify(msg) });
  }

  serverClose(code: number): void {
    this.readyState = 3;
    this.dispatch('close', { code, reason: '', wasClean: code !== 1006 });
  }

  fail(): void {
    this.dispatch('error', { type: 'error' });
    this.serverClose(1006);
  }

  private dispatch(type: string, ev: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }
}

const WS = FakeWebSocket as unknown as typeof WebSocket;

function latest(): FakeWebSocket {
  const ws = FakeWebSocket.instances.at(-1);
  if (ws === undefined) throw new Error('no socket was created');
  return ws;
}

const ALICE: PublicAccount = {
  id: '01J00000000000000000000001',
  username: 'alice',
  displayName: 'Alice',
};
const SESSION: SessionSummary = {
  id: '01J0000000000000000000000S',
  gameId: 'sandbox',
  name: 'Crates',
  ownerId: ALICE.id,
  visibility: 'friends',
  maxPlayers: 4,
  state: 'created',
  memberCount: 1,
  members: [{ ...ALICE, joinedAt: 1 }],
  createdAt: 1,
  lastActiveAt: 1,
};

/** A fetch stub: `/auth/login` sets `conduit_sid=<next cookie>`, `/me` answers `meStatus`. */
function lobbyFetch(state: { cookies: string[]; meStatus: number }): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.endsWith('/auth/login')) {
      const account = { ...ALICE, createdAt: 1, lastLoginAt: 2 };
      const cookie = state.cookies.shift() ?? 'none';
      return new Response(JSON.stringify({ account }), {
        status: 200,
        headers: { 'Set-Cookie': `conduit_sid=${cookie}; Path=/; HttpOnly; SameSite=Lax` },
      });
    }
    if (url.endsWith('/auth/logout')) return new Response(null, { status: 204 });
    const error = { error: 'unauthorized', message: 'login required' };
    return new Response(JSON.stringify(error), { status: state.meStatus });
  };
}

function browserClient(baseUrl = 'https://play.example.com'): LobbyClient {
  return new LobbyClient({
    baseUrl,
    WebSocket: WS,
    cookieMode: 'browser',
    fetch: lobbyFetch({ cookies: [], meStatus: 401 }),
  });
}

interface Recorded {
  log: string[];
  closes: [number, boolean][];
  errors: unknown[];
}

function record(conn: PresenceConnection): Recorded {
  const rec: Recorded = { log: [], closes: [], errors: [] };
  conn.on('open', () => rec.log.push('open'));
  conn.on('event', (ev) => rec.log.push(`event:${ev.t}`));
  conn.on('friends', (online) => rec.log.push(`friends:${online.join(',')}`));
  conn.on('session', (s) => rec.log.push(`session:${s.id}`));
  conn.on('invite', (s, from) => rec.log.push(`invite:${s.id}:${from.username}`));
  conn.on('close', (code, willRetry) => rec.closes.push([code, willRetry]));
  conn.on('error', (err) => rec.errors.push(err));
  return rec;
}

beforeEach(() => {
  FakeWebSocket.instances.length = 0;
  FakeWebSocket.failNext = null;
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5); // jitter factor exactly 1
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PresenceConnection', () => {
  it('connects to /lobby with ws(s) and sends hello on open', () => {
    const conn = browserClient().connectPresence();
    const rec = record(conn);
    const ws = latest();
    expect(ws.url).toBe('wss://play.example.com/lobby');
    expect(ws.argCount).toBe(1); // browser mode: cookies attach on their own
    expect(conn.state).toBe('connecting');
    expect(ws.sent).toEqual([]);

    ws.open();
    expect(conn.state).toBe('open');
    expect(ws.sent).toEqual([{ t: 'hello' }]);
    expect(rec.log).toEqual(['open']);

    const plain = browserClient('http://localhost:8080/').connectPresence();
    expect(latest().url).toBe('ws://localhost:8080/lobby');
    plain.close();
  });

  it('pings every 25 s while open and stops when the socket closes', () => {
    const conn = browserClient().connectPresence();
    const ws = latest();
    vi.advanceTimersByTime(60_000);
    expect(ws.sent).toEqual([]); // no pings before open

    ws.open();
    vi.advanceTimersByTime(PRESENCE_PING_INTERVAL_MS - 1);
    expect(ws.sent).toEqual([{ t: 'hello' }]);
    vi.advanceTimersByTime(1);
    expect(ws.sent).toEqual([{ t: 'hello' }, { t: 'ping' }]);
    vi.advanceTimersByTime(2 * PRESENCE_PING_INTERVAL_MS);
    expect(ws.sent).toEqual([{ t: 'hello' }, { t: 'ping' }, { t: 'ping' }, { t: 'ping' }]);

    ws.serverClose(1006);
    vi.advanceTimersByTime(PRESENCE_PING_INTERVAL_MS * 4);
    expect(ws.sent).toHaveLength(4);
    conn.close();
  });

  it('dispatches friends, session and invite to event and typed listeners; pong is swallowed', () => {
    const conn = browserClient().connectPresence();
    const rec = record(conn);
    const events: LobbyEvent[] = [];
    conn.on('event', (ev) => events.push(ev));
    const ws = latest();
    ws.open();

    ws.receive({ t: 'friends', online: ['01A', '01B'] });
    ws.receive({ t: 'pong' });
    ws.receive({ t: 'session', session: SESSION });
    ws.receive({ t: 'invite', session: SESSION, from: ALICE });

    expect(rec.log).toEqual([
      'open',
      'event:friends',
      'friends:01A,01B',
      'event:session',
      `session:${SESSION.id}`,
      'event:invite',
      `invite:${SESSION.id}:alice`,
    ]);
    expect(events).toEqual([
      { t: 'friends', online: ['01A', '01B'] },
      { t: 'session', session: SESSION },
      { t: 'invite', session: SESSION, from: ALICE },
    ]);
    expect(rec.errors).toEqual([]);
    conn.close();
  });

  it('reports malformed messages as errors and ignores unknown message types', () => {
    const conn = browserClient().connectPresence();
    const rec = record(conn);
    const ws = latest();
    ws.open();

    ws.receive('not json');
    ws.receive('[1,2]');
    ws.receive({ t: 7 });
    ws.receive({ t: 'friends', online: [1] });
    ws.receive({ t: 'session' });
    ws.receive({ t: 'invite', session: SESSION });
    ws.receive({ t: 'emote', from: ALICE }); // a newer lobby's event: ignored
    (ws as unknown as { dispatch(type: string, ev: unknown): void }).dispatch('message', {
      data: new ArrayBuffer(2),
    });

    expect(rec.log).toEqual(['open']);
    expect(rec.errors).toHaveLength(7);
    for (const err of rec.errors) expect(err).toBeInstanceOf(Error);
    expect(conn.state).toBe('open');
    conn.close();
  });

  it('reconnects after an unexpected close at 1 s, 2 s, 4 s … capped at 30 s, and an open resets it', () => {
    const conn = browserClient().connectPresence();
    const rec = record(conn);
    latest().open();
    latest().serverClose(1006);
    expect(rec.closes).toEqual([[1006, true]]);
    expect(conn.state).toBe('connecting');

    const expected = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    expect(expected[0]).toBe(PRESENCE_BACKOFF_MIN_MS);
    expect(expected.at(-1)).toBe(PRESENCE_BACKOFF_MAX_MS);
    for (const [i, delay] of expected.entries()) {
      const before = FakeWebSocket.instances.length;
      vi.advanceTimersByTime(delay - 1);
      expect(FakeWebSocket.instances.length, `attempt ${i + 1} is not early`).toBe(before);
      vi.advanceTimersByTime(1);
      expect(FakeWebSocket.instances.length, `attempt ${i + 1} at ${delay} ms`).toBe(before + 1);
      expect(conn.state).toBe('connecting');
      latest().fail(); // the attempt fails before opening
    }
    expect(rec.closes).toHaveLength(expected.length + 1);
    expect(rec.errors).toHaveLength(expected.length);

    vi.advanceTimersByTime(30_000);
    const ws = latest();
    ws.open();
    expect(ws.sent).toEqual([{ t: 'hello' }]);
    ws.serverClose(1001); // server shutdown also retries, from the minimum again
    expect(rec.closes.at(-1)).toEqual([1001, true]);
    const before = FakeWebSocket.instances.length;
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances.length).toBe(before);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances.length).toBe(before + 1);

    latest().open();
    latest().serverClose(1000);
    expect(rec.closes.at(-1)).toEqual([1000, true]);
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances.length).toBe(before + 2);
    conn.close();
  });

  it('jitters each wait by up to ±20%', () => {
    const random = vi.mocked(Math.random);
    random.mockReturnValue(0);
    const conn = browserClient().connectPresence();
    latest().serverClose(1006);
    vi.advanceTimersByTime(799);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    random.mockReturnValue(0.999);
    latest().serverClose(1006); // backoff 2000 x 1.1996 = 2399 ms (2400 is the open bound)
    vi.advanceTimersByTime(2_398);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
    conn.close();
  });

  it('does not retry after close code 4101', () => {
    const conn = browserClient().connectPresence();
    const rec = record(conn);
    latest().open();
    latest().serverClose(4101);
    expect(rec.closes).toEqual([[4101, false]]);
    expect(conn.state).toBe('closed');
    vi.advanceTimersByTime(10 * PRESENCE_BACKOFF_MAX_MS);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('close() stops pings and retries, closes the socket with 1000 and reports willRetry false', () => {
    const conn = browserClient().connectPresence();
    const rec = record(conn);
    const ws = latest();
    ws.open();
    conn.close();
    expect(conn.state).toBe('closed');
    expect(ws.closeCalls).toEqual([1000]);
    ws.receive({ t: 'friends', online: [] }); // late messages are not dispatched
    ws.serverClose(1000);
    expect(rec.closes).toEqual([[1000, false]]);
    expect(rec.log).toEqual(['open']);
    vi.advanceTimersByTime(10 * PRESENCE_BACKOFF_MAX_MS);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(ws.sent).toEqual([{ t: 'hello' }]);
    conn.close(); // idempotent
    expect(ws.closeCalls).toEqual([1000]);

    // During a backoff wait there is no socket: nothing more is attempted.
    const waiting = browserClient().connectPresence();
    latest().serverClose(1006);
    waiting.close();
    vi.advanceTimersByTime(10 * PRESENCE_BACKOFF_MAX_MS);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(waiting.state).toBe('closed');

    // While connecting: the attempt is abandoned and its failure is not an error.
    const connecting = browserClient().connectPresence();
    const recConnecting = record(connecting);
    const pending = latest();
    connecting.close();
    expect(pending.closeCalls).toEqual([1000]);
    pending.fail();
    pending.open();
    expect(recConnecting.closes).toEqual([[1006, false]]);
    expect(recConnecting.errors).toEqual([]);
    expect(recConnecting.log).toEqual([]);
    expect(pending.sent).toEqual([]);
  });

  it('keeps retrying when creating a socket throws on a reconnect attempt', () => {
    const conn = browserClient().connectPresence();
    const rec = record(conn);
    latest().serverClose(1006);
    const boom = new Error('socket limit');
    FakeWebSocket.failNext = boom;
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(rec.errors).toEqual([boom]);
    expect(conn.state).toBe('connecting');
    vi.advanceTimersByTime(2_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    conn.close();
  });

  it('does not resume retries when an error listener closes a failed reconnect', () => {
    const conn = browserClient().connectPresence();
    conn.on('error', () => conn.close());
    latest().serverClose(1006);
    FakeWebSocket.failNext = new Error('socket limit');

    vi.advanceTimersByTime(PRESENCE_BACKOFF_MIN_MS);
    expect(conn.state).toBe('closed');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * PRESENCE_BACKOFF_MAX_MS);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('does not start pings or emit open after a hello-send error listener closes it', () => {
    const conn = browserClient().connectPresence();
    const rec = record(conn);
    conn.on('error', () => conn.close());
    const ws = latest();
    const failure = new Error('socket closed during hello');
    vi.spyOn(ws, 'send').mockImplementationOnce(() => {
      throw failure;
    });

    ws.open();
    expect(conn.state).toBe('closed');
    expect(rec.errors).toEqual([failure]);
    expect(rec.log).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops typed message delivery when an event listener closes the connection', () => {
    const conn = browserClient().connectPresence();
    const friends = vi.fn();
    conn.on('event', () => conn.close());
    conn.on('friends', friends);
    const ws = latest();
    ws.open();

    ws.receive({ t: 'friends', online: ['01A'] });
    expect(conn.state).toBe('closed');
    expect(friends).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rethrows a throwing listener in a microtask without starving the others', () => {
    const queued: (() => void)[] = [];
    vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((cb) => void queued.push(cb));
    const conn = browserClient().connectPresence();
    const seen: string[] = [];
    const boom = new Error('listener bug');
    conn.on('open', () => {
      throw boom;
    });
    conn.on('open', () => seen.push('second'));
    latest().open();
    expect(seen).toEqual(['second']);
    expect(queued).toHaveLength(1);
    expect(() => queued[0]?.()).toThrow(boom);
    conn.close();
  });

  it('throws from the constructor when the first socket cannot be created', () => {
    FakeWebSocket.failNext = new SyntaxError('bad url');
    expect(() => new PresenceConnection({ url: 'nope', WebSocket: WS })).toThrow(SyntaxError);
    expect(
      () =>
        new PresenceConnection({
          url: 'ws://x/lobby',
          WebSocket: undefined as unknown as typeof WebSocket,
        }),
    ).toThrow(TypeError);
  });
});

describe('LobbyClient presence', () => {
  it('connectPresence returns one shared connection until it is closed', () => {
    const client = browserClient();
    const a = client.connectPresence();
    expect(client.connectPresence()).toBe(a);
    expect(FakeWebSocket.instances).toHaveLength(1);
    a.close();
    const b = client.connectPresence();
    expect(b).not.toBe(a);
    expect(FakeWebSocket.instances).toHaveLength(2);
    b.close();
  });

  it('onPresence returns an unsubscribe that stops delivery', () => {
    const client = browserClient();
    const first: LobbyEvent[] = [];
    const second: LobbyEvent[] = [];
    const stopFirst = client.onPresence((ev) => first.push(ev));
    client.onPresence((ev) => second.push(ev));
    expect(FakeWebSocket.instances).toHaveLength(1); // both share the connection
    const ws = latest();
    ws.open();
    ws.receive({ t: 'friends', online: ['01A'] });
    stopFirst();
    stopFirst(); // idempotent
    ws.receive({ t: 'session', session: SESSION });
    expect(first).toEqual([{ t: 'friends', online: ['01A'] }]);
    expect(second).toEqual([
      { t: 'friends', online: ['01A'] },
      { t: 'session', session: SESSION },
    ]);
    client.connectPresence().close();
  });

  it('manual mode sends the current login cookie with every connection attempt', async () => {
    const state = { cookies: ['first', 'second'], meStatus: 401 };
    const client = new LobbyClient({
      baseUrl: 'http://127.0.0.1:8080',
      WebSocket: WS,
      fetch: lobbyFetch(state),
      cookieMode: 'manual',
    });

    const anonymous = client.connectPresence();
    expect(latest().argCount).toBe(1); // no cookie yet: nothing to send
    anonymous.close();

    await client.login('alice', 'password1');
    const conn = client.connectPresence();
    expect(latest().url).toBe('ws://127.0.0.1:8080/lobby');
    expect(latest().init).toEqual({ headers: { Cookie: 'conduit_sid=first' } });

    await client.login('alice', 'password1');
    latest().serverClose(1006);
    vi.advanceTimersByTime(1_000);
    expect(latest().init).toEqual({ headers: { Cookie: 'conduit_sid=second' } });
    conn.close();
  });

  it('defaults to manual mode without a document, and to browser mode with one', async () => {
    const fetch = lobbyFetch({ cookies: ['node', 'page'], meStatus: 401 });
    expect(typeof document).toBe('undefined');
    const node = new LobbyClient({ baseUrl: 'http://lobby.test', WebSocket: WS, fetch });
    await node.login('alice', 'password1');
    node.connectPresence().close();
    expect(latest().init).toEqual({ headers: { Cookie: 'conduit_sid=node' } });

    vi.stubGlobal('document', {});
    try {
      const page = new LobbyClient({ baseUrl: 'http://lobby.test', WebSocket: WS, fetch });
      await page.login('alice', 'password1');
      page.connectPresence().close();
      expect(latest().argCount).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('logout and a 401 close the presence connection, ending its retries', async () => {
    const state = { cookies: ['c1', 'c2'], meStatus: 401 };
    const client = new LobbyClient({
      baseUrl: 'http://lobby.test',
      WebSocket: WS,
      fetch: lobbyFetch(state),
    });
    await client.login('alice', 'password1');
    const conn = client.connectPresence();
    const rec = record(conn);
    const ws = latest();
    ws.open();

    await expect(client.me()).rejects.toMatchObject({ code: 'unauthorized', status: 401 });
    expect(client.cookie).toBeNull();
    expect(conn.state).toBe('closed');
    expect(ws.closeCalls).toEqual([1000]);
    ws.serverClose(1000);
    expect(rec.closes).toEqual([[1000, false]]);

    await client.login('alice', 'password1');
    const next = client.connectPresence();
    expect(next).not.toBe(conn);
    latest().open();
    await client.logout();
    expect(next.state).toBe('closed');
    expect(latest().closeCalls).toEqual([1000]);
    vi.advanceTimersByTime(10 * PRESENCE_BACKOFF_MAX_MS);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('throws when no WebSocket implementation exists', () => {
    vi.stubGlobal('WebSocket', undefined);
    try {
      const client = new LobbyClient({
        baseUrl: 'http://lobby.test',
        fetch: lobbyFetch({ cookies: [], meStatus: 401 }),
      });
      expect(() => client.connectPresence()).toThrow(TypeError);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
