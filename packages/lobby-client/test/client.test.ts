import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  COOKIE_NAME,
  INVITE_CODE_RE,
  LobbyService,
  PresenceHub,
  RateLimiter,
  ULID_RE,
  lobbyMigrations,
  lobbyRoutes,
  parseCookies,
  type Account,
  type FriendEntry,
  type GameInfo,
  type GameRegistry,
  type JoinResponse,
  type LobbyEnv,
  type LobbyEvent,
  type MeResponse,
  type PresenceSocket,
  type SessionHostControl,
  type SessionSummary,
} from '@conduit/lobby';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @conduit/persist is not a dependency of lobby-client; the test lobby borrows its store directly.
import { SqliteStore, migrate, openNodeSqlite } from '../../persist/src/index.ts';
import { LobbyClient, LobbyError, type PresenceConnection, wsUrlFor } from '../src/index.ts';

interface Call {
  url: string;
  init: RequestInit;
}

const ACCOUNT: Account = {
  id: '01J00000000000000000000001',
  username: 'alice',
  displayName: 'Alice',
  createdAt: 1,
  lastLoginAt: 2,
};
const SESSION: SessionSummary = {
  id: '01J0000000000000000000000S',
  gameId: 'sandbox',
  name: 'Crates',
  ownerId: ACCOUNT.id,
  visibility: 'private',
  maxPlayers: 4,
  state: 'created',
  memberCount: 1,
  members: [{ ...ACCOUNT, joinedAt: 1 }],
  createdAt: 1,
  lastActiveAt: 1,
  inviteCode: 'BCDFGHJK',
};
const GAME: GameInfo = { gameId: 'sandbox', name: 'Sandbox', version: 1 };
const FRIEND: FriendEntry = {
  account: { id: '01J00000000000000000000002', username: 'bob', displayName: 'Bob' },
  status: 'pending_out',
  since: 3,
};
const JOINED: JoinResponse = { token: 'v1.token', wsUrl: 'ws://lobby.test/session/x' };
const ME: MeResponse = { account: ACCOUNT, friends: [FRIEND], invites: [] };

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

/** The lobby's routes (docs/host.md §10) with canned bodies; `login` sets `conduit_sid=<cookie>`. */
function cannedLobby(calls: Call[], opts: { cookie?: string } = {}): typeof fetch {
  return async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const route = `${init.method ?? 'GET'} ${path}`;
    if (route === 'POST /auth/register') return json(201, { account: ACCOUNT });
    if (route === 'POST /auth/login') {
      const cookie = `conduit_sid=${opts.cookie ?? 'raw-cookie'}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
      return json(200, { account: ACCOUNT }, { 'Set-Cookie': cookie });
    }
    if (route === 'POST /auth/logout') {
      const cleared = 'conduit_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
      return new Response(null, { status: 204, headers: { 'Set-Cookie': cleared } });
    }
    if (route === 'GET /me') return json(200, ME);
    if (route === 'GET /games') return json(200, [GAME]);
    if (route === 'GET /sessions') return json(200, [SESSION]);
    if (route === 'POST /sessions') return json(201, { session: SESSION, inviteCode: 'BCDFGHJK' });
    if (/^GET \/sessions\/[^/]+$/.test(route)) return json(200, SESSION);
    if (/^POST \/sessions\/[^/]+\/join$/.test(route)) return json(200, JOINED);
    if (/^POST \/sessions\/[^/]+\/leave$/.test(route)) return new Response(null, { status: 204 });
    if (/^DELETE \/sessions\/[^/]+$/.test(route)) return new Response(null, { status: 204 });
    if (/^POST \/friends\/[^/]+\/accept$/.test(route)) {
      return json(200, { friend: { ...FRIEND, status: 'accepted' } });
    }
    if (/^POST \/friends\/[^/]+$/.test(route)) return json(201, { friend: FRIEND });
    if (/^DELETE \/friends\/[^/]+$/.test(route)) return new Response(null, { status: 204 });
    return json(404, { error: 'not_found', message: 'not found' });
  };
}

/** A fetch that answers every call with `respond()`. */
function answer(calls: Call[], respond: () => Response | Promise<Response>): typeof fetch {
  return async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return respond();
  };
}

function header(call: Call | undefined, name: string): string | null {
  return new Headers(call?.init.headers).get(name);
}

async function rejection(promise: Promise<unknown>): Promise<LobbyError> {
  const err: unknown = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(LobbyError);
  return err as LobbyError;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LobbyClient requests', () => {
  it('maps every method to its route with credentials, Accept and JSON body headers', async () => {
    const calls: Call[] = [];
    const client = new LobbyClient({
      baseUrl: 'http://lobby.test/',
      fetch: cannedLobby(calls),
      cookieMode: 'browser',
    });

    expect(await client.register('Alice', 'password1')).toEqual(ACCOUNT);
    expect(await client.register('Alice', 'password1', 'Al')).toEqual(ACCOUNT);
    expect(await client.login('alice', 'password1')).toEqual(ACCOUNT);
    expect(await client.me()).toEqual(ME);
    expect(await client.games()).toEqual([GAME]);
    expect(await client.listSessions()).toEqual([SESSION]);
    expect(await client.listSessions('sandbox')).toEqual([SESSION]);
    expect(await client.getSession(SESSION.id)).toEqual(SESSION);
    const input = {
      gameId: 'sandbox',
      name: 'Crates',
      visibility: 'private',
      maxPlayers: 4,
    } as const;
    expect(await client.createSession(input)).toEqual({ session: SESSION, inviteCode: 'BCDFGHJK' });
    expect(await client.join(SESSION.id)).toEqual(JOINED);
    expect(await client.join(SESSION.id, 'bcdfghjk')).toEqual(JOINED);
    expect(await client.leave(SESSION.id)).toBeUndefined();
    expect(await client.deleteSession(SESSION.id)).toBeUndefined();
    expect(await client.requestFriend('bob')).toEqual(FRIEND);
    expect(await client.acceptFriend(FRIEND.account.id)).toEqual({ ...FRIEND, status: 'accepted' });
    expect(await client.removeFriend(FRIEND.account.id)).toBeUndefined();
    expect(await client.logout()).toBeUndefined();

    const s = SESSION.id;
    const f = FRIEND.account.id;
    expect(calls.map((c) => `${c.init.method} ${c.url} ${String(c.init.body ?? '-')}`)).toEqual([
      'POST http://lobby.test/auth/register {"username":"Alice","password":"password1"}',
      'POST http://lobby.test/auth/register {"username":"Alice","password":"password1","displayName":"Al"}',
      'POST http://lobby.test/auth/login {"username":"alice","password":"password1"}',
      'GET http://lobby.test/me -',
      'GET http://lobby.test/games -',
      'GET http://lobby.test/sessions -',
      'GET http://lobby.test/sessions?gameId=sandbox -',
      `GET http://lobby.test/sessions/${s} -`,
      'POST http://lobby.test/sessions {"gameId":"sandbox","name":"Crates","visibility":"private","maxPlayers":4}',
      `POST http://lobby.test/sessions/${s}/join {}`,
      `POST http://lobby.test/sessions/${s}/join {"inviteCode":"bcdfghjk"}`,
      `POST http://lobby.test/sessions/${s}/leave -`,
      `DELETE http://lobby.test/sessions/${s} -`,
      'POST http://lobby.test/friends/bob -',
      `POST http://lobby.test/friends/${f}/accept -`,
      `DELETE http://lobby.test/friends/${f} -`,
      'POST http://lobby.test/auth/logout -',
    ]);
    for (const call of calls) {
      expect(call.init.credentials).toBe('include');
      expect(header(call, 'accept')).toBe('application/json');
      const contentType = call.init.body === undefined ? null : 'application/json';
      expect(header(call, 'content-type')).toBe(contentType);
      expect(header(call, 'cookie')).toBeNull(); // browser mode: the browser owns the cookie
    }
    expect(client.cookie).toBeNull();
  });

  it('encodes path segments and the gameId query', async () => {
    const calls: Call[] = [];
    const client = new LobbyClient({ baseUrl: 'https://lobby.test', fetch: cannedLobby(calls) });
    await client.listSessions('my game&x=1');
    await client.getSession('a/b c').catch(() => undefined);
    await client.requestFriend('bob/../x').catch(() => undefined);
    expect(calls.map((c) => c.url)).toEqual([
      'https://lobby.test/sessions?gameId=my%20game%26x%3D1',
      'https://lobby.test/sessions/a%2Fb%20c',
      'https://lobby.test/friends/bob%2F..%2Fx',
    ]);
  });

  it('uses globalThis.fetch, looked up per call, when no fetch is given', async () => {
    const client = new LobbyClient({ baseUrl: '', cookieMode: 'browser' });
    const calls: Call[] = [];
    vi.stubGlobal(
      'fetch',
      answer(calls, () => json(200, [GAME])),
    );
    expect(await client.games()).toEqual([GAME]); // stubbed after construction, still used
    expect(calls.map((c) => c.url)).toEqual(['/games']); // same-origin: a page-relative URL
  });

  it('resolves 204 and empty 2xx bodies with undefined', async () => {
    const calls: Call[] = [];
    const client = new LobbyClient({
      baseUrl: 'http://lobby.test',
      fetch: answer(calls, () =>
        calls.length === 1
          ? new Response(null, { status: 204 })
          : new Response('', { status: 200 }),
      ),
    });
    expect(await client.leave('x')).toBeUndefined();
    await expect(client.me()).resolves.toBeUndefined();
  });

  it('rejects a 400 with the ErrorResponse code, status and field', async () => {
    const body = { error: 'validation', message: 'username: 3-24 of a-z 0-9 _', field: 'username' };
    const client = new LobbyClient({
      baseUrl: 'http://lobby.test',
      fetch: answer([], () => json(400, body)),
    });
    const err = await rejection(client.register('a', 'password1'));
    expect(err).toMatchObject({ code: 'validation', status: 400, field: 'username' });
    expect(err.message).toBe(body.message);
  });

  it('rejects a non-JSON 502 as internal with the status', async () => {
    const client = new LobbyClient({
      baseUrl: 'http://lobby.test',
      fetch: answer([], () => new Response('<html>Bad Gateway</html>', { status: 502 })),
    });
    const err = await rejection(client.me());
    expect(err).toMatchObject({ code: 'internal', status: 502 });
    expect(err.field).toBeUndefined();
  });

  it('rejects a JSON failure body that is not an ErrorResponse as internal', async () => {
    const client = new LobbyClient({
      baseUrl: 'http://lobby.test',
      fetch: answer([], () => json(418, { error: 'teapot', message: 'short and stout' })),
    });
    expect(await rejection(client.games())).toMatchObject({ code: 'internal', status: 418 });
  });

  it('rejects a 2xx body that is not JSON as internal', async () => {
    const client = new LobbyClient({
      baseUrl: 'http://lobby.test',
      fetch: answer([], () => new Response('<!doctype html>', { status: 200 })),
    });
    expect(await rejection(client.games())).toMatchObject({ code: 'internal', status: 200 });
  });

  it('rejects with network and status 0 when fetch throws or the body cannot be read', async () => {
    const cause = new TypeError('fetch failed');
    const throwing = new LobbyClient({
      baseUrl: 'http://lobby.test',
      fetch: () => Promise.reject(cause),
    });
    const err = await rejection(throwing.me());
    expect(err).toMatchObject({ code: 'network', status: 0, cause });

    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('connection reset'));
      },
    });
    const cut = new LobbyClient({
      baseUrl: 'http://lobby.test',
      fetch: answer([], () => new Response(broken, { status: 200 })),
    });
    expect(await rejection(cut.me())).toMatchObject({ code: 'network', status: 0 });
  });
});

describe('LobbyClient cookies', () => {
  it('manual mode captures conduit_sid from login and replays it on later requests', async () => {
    const calls: Call[] = [];
    const client = new LobbyClient({
      baseUrl: 'http://lobby.test',
      fetch: cannedLobby(calls, { cookie: 'abc-123_XYZ' }),
      cookieMode: 'manual',
    });
    expect(client.cookie).toBeNull();
    await client.register('alice', 'password1');
    expect(client.cookie).toBeNull(); // register does not log in
    await client.login('alice', 'password1');
    expect(client.cookie).toBe('abc-123_XYZ');
    await client.me();
    await client.join(SESSION.id);
    expect(header(calls[0], 'cookie')).toBeNull();
    expect(header(calls[1], 'cookie')).toBeNull();
    expect(header(calls[2], 'cookie')).toBe('conduit_sid=abc-123_XYZ');
    expect(header(calls[3], 'cookie')).toBe('conduit_sid=abc-123_XYZ');
    for (const call of calls) expect(call.init.credentials).toBe('include');

    await client.logout(); // the clearing Set-Cookie and logout itself both clear it
    expect(header(calls[4], 'cookie')).toBe('conduit_sid=abc-123_XYZ');
    expect(client.cookie).toBeNull();
    await client.me();
    expect(header(calls[5], 'cookie')).toBeNull();
  });

  it('manual mode ignores other cookies and clears on Max-Age=0', async () => {
    let setCookie: string[] = [];
    const fetchWithCookies: typeof fetch = async () => {
      const headers = new Headers({ 'Content-Type': 'application/json' });
      for (const line of setCookie) headers.append('Set-Cookie', line);
      return new Response(JSON.stringify({ account: ACCOUNT }), { status: 200, headers });
    };
    const client = new LobbyClient({ baseUrl: 'http://l', fetch: fetchWithCookies });
    setCookie = ['theme=dark; Path=/', 'conduit_sid=first; Path=/; HttpOnly'];
    await client.login('alice', 'password1');
    expect(client.cookie).toBe('first');
    setCookie = ['other=1'];
    await client.me();
    expect(client.cookie).toBe('first');
    setCookie = ['conduit_sid=second; Max-Age=; Path=/', 'conduit_sid_x=nope'];
    await client.me(); // an empty Max-Age is ignored, a longer name is another cookie
    expect(client.cookie).toBe('second');
    setCookie = ['conduit_sid=gone; Path=/; max-age=0'];
    await client.me();
    expect(client.cookie).toBeNull();
  });

  it('a 401 rejects with unauthorized, clears the cookie; a failed login keeps it', async () => {
    let status = 200;
    const calls: Call[] = [];
    const lobby = cannedLobby(calls);
    const client = new LobbyClient({
      baseUrl: 'http://lobby.test',
      cookieMode: 'manual',
      fetch: async (input, init) => {
        if (status === 200) return lobby(input, init);
        const message = String(input).endsWith('/auth/login')
          ? 'invalid credentials'
          : 'login required';
        return json(status, { error: 'unauthorized', message });
      },
    });
    await client.login('alice', 'password1');
    status = 401;
    const failedLogin = await rejection(client.login('alice', 'wrong-password'));
    expect(failedLogin).toMatchObject({ code: 'unauthorized', status: 401 });
    expect(client.cookie).toBe('raw-cookie');

    const err = await rejection(client.me());
    expect(err).toMatchObject({ code: 'unauthorized', status: 401, message: 'login required' });
    expect(client.cookie).toBeNull();
  });

  it('logout clears the manual cookie even when the request fails', async () => {
    const calls: Call[] = [];
    const lobby = cannedLobby(calls);
    let offline = false;
    const client = new LobbyClient({
      baseUrl: 'http://lobby.test',
      fetch: (input, init) =>
        offline ? Promise.reject(new TypeError('offline')) : lobby(input, init),
    });
    await client.login('alice', 'password1');
    offline = true;
    expect(await rejection(client.logout())).toMatchObject({ code: 'network', status: 0 });
    expect(client.cookie).toBeNull();
  });

  it('browser mode neither stores nor sends cookies, and is the default with a document', async () => {
    vi.stubGlobal('document', {});
    const calls: Call[] = [];
    const client = new LobbyClient({ baseUrl: 'http://lobby.test', fetch: cannedLobby(calls) });
    await client.login('alice', 'password1');
    await client.me();
    expect(client.cookie).toBeNull();
    expect(header(calls[1], 'cookie')).toBeNull();
    vi.unstubAllGlobals();

    const nodeClient = new LobbyClient({ baseUrl: 'http://lobby.test', fetch: cannedLobby([]) });
    await nodeClient.login('alice', 'password1');
    expect(nodeClient.cookie).toBe('raw-cookie'); // no document: manual
  });
});

describe('wsUrlFor', () => {
  it('maps http to ws and https to wss, keeping host, port and path prefix', () => {
    expect(wsUrlFor('http://localhost:8080', '/lobby')).toBe('ws://localhost:8080/lobby');
    expect(wsUrlFor('https://play.example.com/', '/lobby')).toBe('wss://play.example.com/lobby');
    expect(wsUrlFor('HTTPS://Play.example.com//', 'lobby')).toBe('wss://Play.example.com/lobby');
    expect(wsUrlFor('https://example.com/api', '/lobby')).toBe('wss://example.com/api/lobby');
    expect(wsUrlFor('ws://127.0.0.1:9', '/lobby')).toBe('ws://127.0.0.1:9/lobby');
    expect(wsUrlFor('wss://x.test', '/session/1')).toBe('wss://x.test/session/1');
  });

  it("resolves '' and path-only base URLs against location.origin", () => {
    expect(() => wsUrlFor('', '/lobby')).toThrow(TypeError); // no location in Node
    vi.stubGlobal('location', { origin: 'https://play.example.com' });
    expect(wsUrlFor('', '/lobby')).toBe('wss://play.example.com/lobby');
    expect(wsUrlFor('/api/', '/lobby')).toBe('wss://play.example.com/api/lobby');
    vi.stubGlobal('location', { origin: 'http://localhost:5173' });
    expect(wsUrlFor('', '/lobby')).toBe('ws://localhost:5173/lobby');
    vi.stubGlobal('location', { origin: 'null' }); // file:// pages
    expect(() => wsUrlFor('', '/lobby')).toThrow(TypeError);
  });

  it('rejects other schemes', () => {
    expect(() => wsUrlFor('ftp://x.test', '/lobby')).toThrow(TypeError);
    expect(() => wsUrlFor('lobby.test', '/lobby')).toThrow(TypeError);
  });
});

// ---- Against a real lobby -------------------------------------------------------------------
//
// `lobbyRoutes` over node:http with an in-memory SqliteStore, a PresenceHub behind a minimal
// RFC 6455 upgrade for `/lobby` (cookie-authenticated like the host's gateway, docs/host.md §17),
// and a fake SessionHostControl. Clients use Node's real fetch and WebSocket in manual cookie mode.

const SECRET = 'lobby-client-test-secret-0123456789abcdefghijklmnop';
const PASSWORD = 'correct horse battery';
const GAMES: GameInfo[] = [GAME];
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** Why the real-lobby tests are skipped in this process, or null when node:sqlite is available. */
function nodeSqliteSkipReason(): string | null {
  try {
    openNodeSqlite(':memory:').close();
    return null;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ERR_UNKNOWN_BUILTIN_MODULE') {
      console.warn(`Skipping real-lobby tests. ${err.message}`);
      return err.message;
    }
    throw err;
  }
}

class FakeHostControl implements SessionHostControl {
  readonly starts: [sessionId: string, gameId: string][] = [];
  readonly stops: string[] = [];
  readonly disconnects: [sessionId: string, accountId: string, code: number, reason: string][] = [];
  private readonly running = new Set<string>();

  async start(sessionId: string, gameId: string): Promise<void> {
    this.starts.push([sessionId, gameId]);
    this.running.add(sessionId);
  }

  async stop(sessionId: string): Promise<void> {
    this.stops.push(sessionId);
    this.running.delete(sessionId);
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  disconnect(sessionId: string, accountId: string, code: number, reason: string): void {
    this.disconnects.push([sessionId, accountId, code, reason]);
  }
}

/** Server end of an upgraded `/lobby` socket with the `ws`-style surface `PresenceHub` attaches to. */
class TestServerSocket extends EventEmitter implements PresenceSocket {
  private readonly socket: Duplex;
  private pending = Buffer.alloc(0);
  private closeSent = false;
  private closeCode = 1006;

  constructor(socket: Duplex) {
    super();
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.receive(chunk));
    socket.on('close', () => this.emit('close', this.closeCode));
    socket.on('error', () => {
      if (this.listenerCount('error') > 0) this.emit('error');
    });
  }

  send(data: string): void {
    this.writeFrame(0x1, Buffer.from(data, 'utf8'));
  }

  close(code = 1000, reason = ''): void {
    if (this.closeSent) return;
    this.closeSent = true;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2);
    this.writeFrame(0x8, payload); // the client echoes it, then this end ends the TCP stream
  }

  terminate(): void {
    this.socket.destroy();
  }

  ping(): void {
    this.writeFrame(0x9, Buffer.alloc(0));
  }

  private writeFrame(opcode: number, payload: Buffer): void {
    if (this.socket.destroyed || this.socket.writableEnded) return;
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, payload.length]);
    } else if (payload.length < 65_536) {
      header = Buffer.from([0x80 | opcode, 126, 0, 0]);
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header.writeUInt8(0x80 | opcode, 0);
      header.writeUInt8(127, 1);
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  /** Parses whole client frames (always masked, never fragmented by undici for these sizes). */
  private receive(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk]);
    for (;;) {
      if (this.pending.length < 2) return;
      const opcode = this.pending.readUInt8(0) & 0x0f;
      const second = this.pending.readUInt8(1);
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.pending.length < 4) return;
        length = this.pending.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.pending.length < 10) return;
        length = Number(this.pending.readBigUInt64BE(2));
        offset = 10;
      }
      const maskAt = offset;
      if ((second & 0x80) !== 0) offset += 4;
      if (this.pending.length < offset + length) return;
      const payload = Buffer.from(this.pending.subarray(offset, offset + length));
      if (offset > maskAt) {
        for (let i = 0; i < length; i++) {
          payload.writeUInt8(payload.readUInt8(i) ^ this.pending.readUInt8(maskAt + (i % 4)), i);
        }
      }
      this.pending = this.pending.subarray(offset + length);
      this.frame(opcode, payload);
    }
  }

  private frame(opcode: number, payload: Buffer): void {
    if (opcode === 0x1 || opcode === 0x2) {
      this.emit('message', payload, opcode === 0x2);
    } else if (opcode === 0x8) {
      this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      if (!this.closeSent) {
        this.closeSent = true;
        this.writeFrame(0x8, payload.subarray(0, 2));
      }
      this.socket.end();
    } else if (opcode === 0x9) {
      this.writeFrame(0xa, payload);
    } else if (opcode === 0xa) {
      this.emit('pong');
    }
  }
}

interface TestLobby {
  /** `http://127.0.0.1:<port>` */
  readonly url: string;
  readonly service: LobbyService;
  readonly host: FakeHostControl;
  /** Presence connections the test opened; closed before the lobby stops. */
  readonly connections: PresenceConnection[];
  close(): Promise<void>;
}

/** Bridges one node:http request to the Hono app, as the host's node adapter does (§22). */
async function serveHttp(
  app: ReturnType<typeof lobbyRoutes>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(name, value);
      else for (const item of value ?? []) headers.append(name, item);
    }
    const method = req.method ?? 'GET';
    const body = method === 'GET' || method === 'HEAD' ? null : Buffer.concat(chunks).toString();
    const request = new Request(`http://${req.headers.host}${req.url}`, { method, headers, body });
    const env: LobbyEnv['Bindings'] = {};
    if (req.socket.remoteAddress !== undefined) env.remoteAddress = req.socket.remoteAddress;
    const response = await app.fetch(request, env);
    res.statusCode = response.status;
    response.headers.forEach((value, name) => {
      if (name !== 'set-cookie') res.setHeader(name, value);
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) res.setHeader('Set-Cookie', cookies);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    res.statusCode = 500;
    res.end(String(err));
  }
}

/** `/lobby` upgrades: the login cookie must authenticate, else HTTP 401 (docs/host.md §17). */
function upgradeLobby(
  service: LobbyService,
  hub: PresenceHub,
  req: IncomingMessage,
  socket: Duplex,
): void {
  const key = req.headers['sec-websocket-key'];
  const account =
    req.url === '/lobby'
      ? service.authenticate(parseCookies(req.headers.cookie).get(COOKIE_NAME))
      : null;
  if (account === null || typeof key !== 'string') {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const { id, username, displayName } = account;
  hub.attach(new TestServerSocket(socket), { id, username, displayName });
}

async function startLobby(): Promise<TestLobby> {
  const store = new SqliteStore(':memory:');
  migrate(store.db, lobbyMigrations);
  const host = new FakeHostControl();
  const games: GameRegistry = {
    list: () => GAMES,
    has: (gameId) => GAMES.some((game) => game.gameId === gameId),
  };
  const service = new LobbyService(store.db, { host, games, secret: SECRET });
  const hub = new PresenceHub(service);
  service.attachSink(hub);
  // Every client of these tests connects from 127.0.0.1: lift the per-IP login limit.
  const app = lobbyRoutes(service, { rateLimiter: new RateLimiter({ limit: 1_000 }) });
  const upgraded = new Set<Duplex>();
  const server = createServer((req, res) => void serveHttp(app, req, res));
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    upgradeLobby(service, hub, req, socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const connections: PresenceConnection[] = [];
  return {
    url: `http://127.0.0.1:${port}`,
    service,
    host,
    connections,
    async close() {
      for (const connection of connections) connection.close();
      hub.closeAll(1001, 'test_done');
      for (const socket of upgraded) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}

/** A manual-mode client of `lobby` whose fetch calls are recorded. */
function clientOf(lobby: TestLobby, calls: Call[] = []): LobbyClient {
  const recording: typeof fetch = (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return fetch(input, init);
  };
  return new LobbyClient({ baseUrl: lobby.url, fetch: recording, cookieMode: 'manual' });
}

async function account(lobby: TestLobby, username: string): Promise<[LobbyClient, Account]> {
  const client = clientOf(lobby);
  await client.register(username, PASSWORD);
  return [client, await client.login(username, PASSWORD)];
}

/** The payload of a SessionToken (`base64url(json).signature`, docs/persist.md 2.3). */
function tokenPayload(token: string): unknown {
  const body = token.split('.')[0] ?? '';
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
}

function publicOf(a: Account): { id: string; username: string; displayName: string } {
  return { id: a.id, username: a.username, displayName: a.displayName };
}

const SQLITE_SKIP = nodeSqliteSkipReason();

describe.skipIf(SQLITE_SKIP !== null)('LobbyClient against a real lobby', () => {
  let lobby: TestLobby;

  beforeEach(async () => {
    lobby = await startLobby();
  });

  afterEach(async () => {
    await lobby.close();
  });

  it('register, login, me and games round-trip; Set-Cookie is captured and replayed', async () => {
    const calls: Call[] = [];
    const client = clientOf(lobby, calls);
    const registered = await client.register('Alice_1', PASSWORD, 'Alice');
    expect(registered).toEqual({
      id: expect.stringMatching(ULID_RE),
      username: 'alice_1',
      displayName: 'Alice',
      createdAt: expect.any(Number),
      lastLoginAt: null,
    });
    expect(client.cookie).toBeNull();

    const loggedIn = await client.login('ALICE_1', PASSWORD);
    expect(loggedIn).toMatchObject({ id: registered.id, lastLoginAt: expect.any(Number) });
    expect(client.cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(lobby.service.authenticate(client.cookie ?? undefined)?.id).toBe(registered.id);

    const me = await client.me();
    expect(me).toEqual({ account: loggedIn, friends: [], invites: [] });
    expect(await client.games()).toEqual(GAMES);

    expect(calls.map((c) => `${c.init.method} ${new URL(c.url).pathname}`)).toEqual([
      'POST /auth/register',
      'POST /auth/login',
      'GET /me',
      'GET /games',
    ]);
    for (const call of calls) {
      expect(call.init.credentials).toBe('include');
      expect(header(call, 'accept')).toBe('application/json');
      expect(header(call, 'content-type')).toBe(
        call.init.body === undefined ? null : 'application/json',
      );
    }
    expect(header(calls[1], 'cookie')).toBeNull();
    expect(header(calls[2], 'cookie')).toBe(`conduit_sid=${client.cookie}`);
    expect(header(calls[3], 'cookie')).toBe(`conduit_sid=${client.cookie}`);

    const cookie = client.cookie;
    await client.logout();
    expect(client.cookie).toBeNull();
    expect(lobby.service.authenticate(cookie ?? undefined)).toBeNull();
    expect(await rejection(client.me())).toMatchObject({ code: 'unauthorized', status: 401 });
  });

  it('sessions: create, list, get, join by invite code, leave and delete', async () => {
    const [alice, aliceAccount] = await account(lobby, 'alice');
    const [bob, bobAccount] = await account(lobby, 'bob');
    const [carol] = await account(lobby, 'carol');

    const created = await alice.createSession({
      gameId: 'sandbox',
      name: 'Crates',
      visibility: 'private',
      maxPlayers: 2,
    });
    const id = created.session.id;
    expect(created.inviteCode).toMatch(INVITE_CODE_RE);
    expect(created.session).toMatchObject({
      id: expect.stringMatching(ULID_RE),
      gameId: 'sandbox',
      name: 'Crates',
      ownerId: aliceAccount.id,
      visibility: 'private',
      maxPlayers: 2,
      state: 'created',
      memberCount: 1,
      members: [{ ...publicOf(aliceAccount), joinedAt: expect.any(Number) }],
      inviteCode: created.inviteCode,
    });
    expect(await alice.listSessions()).toEqual([created.session]);
    expect(await alice.listSessions('sandbox')).toEqual([created.session]);
    expect(await alice.listSessions('elsewhere')).toEqual([]);
    expect(await alice.getSession(id)).toEqual(created.session);

    expect(await bob.listSessions()).toEqual([]); // private: invisible to strangers
    expect(await rejection(bob.getSession(id))).toMatchObject({ code: 'not_found', status: 404 });
    expect(await rejection(bob.join(id))).toMatchObject({ code: 'bad_invite', status: 403 });
    expect(await rejection(bob.join(id, 'BCDFGHJK'))).toMatchObject({ code: 'bad_invite' });

    const joined = await bob.join(id, created.inviteCode.toLowerCase());
    expect(joined).toEqual({
      token: expect.any(String),
      wsUrl: `${wsUrlFor(lobby.url, '/session')}/${id}`,
    });
    expect(tokenPayload(joined.token)).toMatchObject({
      accountId: bobAccount.id,
      displayName: 'bob',
      sessionId: id,
    });
    expect(lobby.host.starts).toEqual([[id, 'sandbox']]);
    expect(await bob.getSession(id)).toMatchObject({
      state: 'running',
      memberCount: 2,
      inviteCode: created.inviteCode,
    });
    expect(await rejection(carol.join(id, created.inviteCode))).toMatchObject({
      code: 'session_full',
      status: 409,
    });

    expect(await bob.leave(id)).toBeUndefined();
    expect(lobby.host.disconnects).toEqual([[id, bobAccount.id, 4105, 'left']]);
    expect(await rejection(bob.leave(id))).toMatchObject({ code: 'not_found', status: 404 });
    expect(await rejection(bob.deleteSession(id))).toMatchObject({
      code: 'forbidden',
      status: 403,
    });

    expect(await alice.deleteSession(id)).toBeUndefined();
    expect(lobby.host.stops).toEqual([id]);
    expect(await rejection(alice.getSession(id))).toMatchObject({ code: 'not_found', status: 404 });
    expect(await rejection(alice.join(id))).toMatchObject({ code: 'not_found', status: 404 });

    const invalid = alice.createSession({
      gameId: 'sandbox',
      name: 'x',
      visibility: 'public',
      maxPlayers: 9,
    });
    expect(await rejection(invalid)).toMatchObject({
      code: 'validation',
      status: 400,
      field: 'maxPlayers',
    });
  });

  it('friends: request, accept and remove', async () => {
    const [alice, aliceAccount] = await account(lobby, 'alice');
    const [bob, bobAccount] = await account(lobby, 'bob');

    const requested = await alice.requestFriend('BOB');
    expect(requested).toEqual({
      account: publicOf(bobAccount),
      status: 'pending_out',
      since: expect.any(Number),
    });
    expect((await bob.me()).friends).toEqual([
      { account: publicOf(aliceAccount), status: 'pending_in', since: requested.since },
    ]);
    expect(await rejection(alice.requestFriend('bob'))).toMatchObject({
      code: 'conflict',
      status: 409,
    });
    expect(await rejection(alice.requestFriend('nobody'))).toMatchObject({ code: 'not_found' });
    expect(await rejection(alice.acceptFriend(bobAccount.id))).toMatchObject({ code: 'not_found' });

    const accepted = await bob.acceptFriend(aliceAccount.id);
    expect(accepted).toEqual({
      account: publicOf(aliceAccount),
      status: 'accepted',
      since: requested.since,
    });
    expect((await alice.me()).friends).toEqual([{ ...requested, status: 'accepted' }]);

    expect(await alice.removeFriend(bobAccount.id)).toBeUndefined();
    expect((await bob.me()).friends).toEqual([]);
    expect(await rejection(alice.removeFriend(bobAccount.id))).toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });

  it('errors: 409 and 400 with field; a 401 clears the cookie, a failed login keeps it', async () => {
    const client = clientOf(lobby);
    await client.register('alice', PASSWORD);
    expect(await rejection(client.register('ALICE', PASSWORD))).toMatchObject({
      code: 'conflict',
      status: 409,
    });
    expect(await rejection(client.register('al', PASSWORD))).toMatchObject({
      code: 'validation',
      status: 400,
      field: 'username',
    });
    expect(await rejection(client.register('alice2', 'short'))).toMatchObject({
      code: 'validation',
      status: 400,
      field: 'password',
    });
    expect(await rejection(client.me())).toMatchObject({ code: 'unauthorized', status: 401 });

    await client.login('alice', PASSWORD);
    const cookie = client.cookie;
    expect(await rejection(client.login('alice', 'wrong password'))).toMatchObject({
      code: 'unauthorized',
      status: 401,
    });
    expect(client.cookie).toBe(cookie);
    expect((await client.me()).account.username).toBe('alice');

    lobby.service.logout(cookie ?? undefined); // the login ends elsewhere (another tab's logout)
    const err = await rejection(client.me());
    expect(err).toMatchObject({ code: 'unauthorized', status: 401 });
    expect(err.field).toBeUndefined();
    expect(client.cookie).toBeNull();
  });

  it('presence: the login cookie authenticates the socket; friends, invite and session events arrive', async () => {
    const [alice, aliceAccount] = await account(lobby, 'alice');
    const [bob, bobAccount] = await account(lobby, 'bob');
    await alice.requestFriend('bob');
    await bob.acceptFriend(aliceAccount.id);

    const events: LobbyEvent[] = [];
    alice.onPresence((ev) => events.push(ev));
    const alicePresence = alice.connectPresence();
    lobby.connections.push(alicePresence);
    const opened = vi.fn();
    alicePresence.on('open', opened);
    await vi.waitFor(() => expect(events).toEqual([{ t: 'friends', online: [] }]));
    expect(opened).toHaveBeenCalledOnce();
    expect(alicePresence.state).toBe('open');

    const bobPresence = bob.connectPresence();
    lobby.connections.push(bobPresence);
    await vi.waitFor(() =>
      expect(events.at(-1)).toEqual({ t: 'friends', online: [bobAccount.id] }),
    );

    const party = await bob.createSession({
      gameId: 'sandbox',
      name: 'Party',
      visibility: 'friends',
      maxPlayers: 4,
    });
    await vi.waitFor(() => expect(events.at(-1)?.t).toBe('invite'));
    expect(events.at(-1)).toEqual({
      t: 'invite',
      session: expect.objectContaining({ id: party.session.id, ownerId: bobAccount.id }),
      from: publicOf(bobAccount),
    });

    await alice.join(party.session.id);
    await vi.waitFor(() => expect(events.at(-1)?.t).toBe('session'));
    expect(events.at(-1)).toEqual({
      t: 'session',
      session: expect.objectContaining({ id: party.session.id, state: 'running', memberCount: 2 }),
    });

    const closes: [number, boolean][] = [];
    bobPresence.on('close', (code, willRetry) => closes.push([code, willRetry]));
    bobPresence.close();
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ t: 'friends', online: [] }));
    await vi.waitFor(() => expect(closes).toEqual([[1000, false]]));
    expect(events.map((ev) => ev.t)).toEqual([
      'friends',
      'friends',
      'invite',
      'session',
      'friends',
    ]);

    await alice.logout();
    expect(alicePresence.state).toBe('closed');
    expect(alice.connectPresence()).not.toBe(alicePresence);
    lobby.connections.push(alice.connectPresence());
  });

  it('presence without a valid cookie: the upgrade is refused (1006) and retried', async () => {
    const client = clientOf(lobby);
    const presence = client.connectPresence();
    lobby.connections.push(presence);
    const closes: [number, boolean][] = [];
    const errors: unknown[] = [];
    presence.on('close', (code, willRetry) => closes.push([code, willRetry]));
    presence.on('error', (err) => errors.push(err));
    await vi.waitFor(() => expect(closes).toEqual([[1006, true]]));
    expect(errors.length).toBeGreaterThan(0);
    expect(presence.state).toBe('connecting');
    presence.close();
    expect(presence.state).toBe('closed');
  });
});
