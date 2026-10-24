import { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import { SqliteStore, migrate, openNodeSqlite } from '@conduit/persist';
import type { Hono } from 'hono';
import {
  COOKIE_NAME,
  LOBBY_SESSION_TTL_MS,
  LobbyService,
  RateLimiter,
  hashCookieToken,
  lobbyMigrations,
  lobbyRoutes,
  newCookieToken,
  ulid,
  type Account,
  type EventSink,
  type GameInfo,
  type GameRegistry,
  type LobbyEnv,
  type LobbyEvent,
  type LobbyRouteOptions,
  type PresenceHubOptions,
  type PresenceSocket,
  type SessionHostControl,
} from '../src/index.ts';

export const SECRET = 'lobby-test-secret-0123456789abcdefghijklmnopqrstuvwxyz';
export const T0 = 1_800_000_000_000;
export const SANDBOX: GameInfo = { gameId: 'sandbox', name: 'Sandbox', version: 1 };
export const PASSWORD = 'hunter2hunter2';
/** A parseable scrypt hash no password verifies against, for accounts inserted without scrypt. */
export const UNUSABLE_HASH = `scrypt$32768$8$1$${'A'.repeat(22)}$${'A'.repeat(43)}`;

/**
 * Why node:sqlite tests are skipped in this process, or null when node:sqlite is available (the
 * same check as persist's tests).
 */
export function nodeSqliteSkipReason(): string | null {
  try {
    openNodeSqlite(':memory:').close();
    return null;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ERR_UNKNOWN_BUILTIN_MODULE') {
      console.warn(`Skipping lobby tests. ${err.message}`);
      return err.message;
    }
    throw err;
  }
}

/** A manual clock with timers, for the service, the rate limiter and the presence hub. */
export class ManualClock {
  now = T0;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; every: number | null; fn: () => void }>();

  readonly hubOptions: PresenceHubOptions = {
    now: () => this.now,
    setTimeout: (fn, ms) => this.schedule(fn, ms, null),
    clearTimeout: (handle) => this.cancel(handle),
    setInterval: (fn, ms) => this.schedule(fn, ms, ms),
    clearInterval: (handle) => this.cancel(handle),
  };

  /** Moves time forward, firing due timers in order. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let due: { id: number; at: number } | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && (due === null || timer.at < due.at)) due = { id, at: timer.at };
      }
      if (due === null) break;
      const timer = this.timers.get(due.id);
      if (timer === undefined) break;
      this.now = timer.at;
      if (timer.every === null) this.timers.delete(due.id);
      else timer.at += timer.every;
      timer.fn();
    }
    this.now = target;
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  private schedule(fn: () => void, ms: number, every: number | null): number {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, every, fn });
    return id;
  }

  private cancel(handle: unknown): void {
    if (typeof handle === 'number') this.timers.delete(handle);
  }
}

export type HostCall =
  | { op: 'start'; sessionId: string; gameId: string }
  | { op: 'stop'; sessionId: string; close: { code: number; reason: string } | undefined }
  | { op: 'touch'; sessionId: string }
  | { op: 'disconnect'; sessionId: string; accountId: string; code: number; reason: string };

/** Records calls; `start` resolves unless an outcome was queued with `failNextStart`/`holdNextStart`. */
export class FakeHostControl implements SessionHostControl {
  readonly calls: HostCall[] = [];
  readonly running = new Set<string>();
  readonly capacities = new Map<string, number>();
  private readonly startOutcomes: (Error | Promise<void>)[] = [];

  failNextStart(err: Error = new Error('worker failed to start')): void {
    this.startOutcomes.push(err);
  }

  /** The next `start` waits until `release()` (or rejects on `fail(err)`). */
  holdNextStart(): { release(): void; fail(err: Error): void } {
    let release = (): void => {};
    let fail = (_err: Error): void => {};
    this.startOutcomes.push(
      new Promise<void>((resolve, reject) => {
        release = resolve;
        fail = reject;
      }),
    );
    return { release: () => release(), fail: (err) => fail(err) };
  }

  async start(sessionId: string, gameId: string, maxPlayers = 8): Promise<void> {
    this.capacities.set(sessionId, maxPlayers);
    this.calls.push({ op: 'start', sessionId, gameId });
    const outcome = this.startOutcomes.shift();
    if (outcome instanceof Error) throw outcome;
    if (outcome !== undefined) await outcome;
    this.running.add(sessionId);
  }

  async stop(sessionId: string, close?: { code: number; reason: string }): Promise<void> {
    this.calls.push({ op: 'stop', sessionId, close });
    this.running.delete(sessionId);
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  touch(sessionId: string): void {
    this.calls.push({ op: 'touch', sessionId });
  }

  disconnect(sessionId: string, accountId: string, code: number, reason: string): void {
    this.calls.push({ op: 'disconnect', sessionId, accountId, code, reason });
  }

  callsOf<Op extends HostCall['op']>(op: Op): Extract<HostCall, { op: Op }>[] {
    return this.calls.filter((call): call is Extract<HostCall, { op: Op }> => call.op === op);
  }
}

export class StaticGameRegistry implements GameRegistry {
  private readonly games: GameInfo[];

  constructor(games: GameInfo[]) {
    this.games = games;
  }

  list(): GameInfo[] {
    return this.games.map((game) => ({ ...game }));
  }

  has(gameId: string): boolean {
    return this.games.some((game) => game.gameId === gameId);
  }
}

export interface RecordedEvent {
  recipients: string[];
  event: LobbyEvent;
}

/** Records emitted events; `onlineIds` is what `online()` reports. */
export class RecordingSink implements EventSink {
  readonly events: RecordedEvent[] = [];
  readonly onlineIds = new Set<string>();

  emit(recipients: string[], event: LobbyEvent): void {
    this.events.push({ recipients: [...recipients], event });
  }

  online(): ReadonlySet<string> {
    return this.onlineIds;
  }

  clear(): void {
    this.events.length = 0;
  }
}

export interface LobbyHarness {
  store: SqliteStore;
  db: DatabaseSync;
  clock: ManualClock;
  host: FakeHostControl;
  games: StaticGameRegistry;
  sink: RecordingSink;
  service: LobbyService;
  app: Hono<LobbyEnv>;
  close(): void;
}

/** An in-memory lobby: migrated SqliteStore, fake host, sandbox registry, recording sink, routes. */
export function createHarness(opts: { routes?: LobbyRouteOptions } = {}): LobbyHarness {
  const store = new SqliteStore(':memory:');
  migrate(store.db, lobbyMigrations);
  const clock = new ManualClock();
  const host = new FakeHostControl();
  const games = new StaticGameRegistry([SANDBOX]);
  const sink = new RecordingSink();
  const service = new LobbyService(store.db, { host, games, secret: SECRET, now: () => clock.now });
  service.attachSink(sink);
  const app = lobbyRoutes(service, {
    rateLimiter: new RateLimiter({ now: () => clock.now }),
    ...opts.routes,
  });
  return {
    store,
    db: store.db,
    clock,
    host,
    games,
    sink,
    service,
    app,
    close: () => store.close(),
  };
}

export interface CallOptions {
  /** Sent as JSON with `Content-Type: application/json` unless `headers` sets another type. */
  body?: unknown;
  /** Sent verbatim (no Content-Type added). */
  rawBody?: string;
  /** Raw `conduit_sid` value. */
  cookie?: string;
  headers?: Record<string, string>;
  remoteAddress?: string;
}

export interface CallResult<T> {
  status: number;
  body: T;
  headers: Headers;
  setCookies: string[];
}

/** One request through `app.request` with `{ remoteAddress }` bindings. */
export async function call<T = unknown>(
  app: Hono<LobbyEnv>,
  method: string,
  path: string,
  opts: CallOptions = {},
): Promise<CallResult<T>> {
  const headers = new Headers(opts.headers);
  if (opts.cookie !== undefined) headers.set('Cookie', `${COOKIE_NAME}=${opts.cookie}`);
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  }
  if (opts.rawBody !== undefined) init.body = opts.rawBody;
  const res = await app.request(path, init, { remoteAddress: opts.remoteAddress ?? '192.0.2.1' });
  const text = await res.text();
  return {
    status: res.status,
    body: text === '' ? undefined : JSON.parse(text),
    headers: res.headers,
    setCookies: res.headers.getSetCookie(),
  };
}

/** The `conduit_sid` value set by a response, or null. */
export function cookieValue(setCookies: string[]): string | null {
  for (const header of setCookies) {
    const match = /^conduit_sid=([^;]*)/.exec(header);
    if (match) return match[1] ?? '';
  }
  return null;
}

/** Registers through the routes and logs in; returns the account and raw cookie. */
export async function registerAndLogin(
  h: LobbyHarness,
  username: string,
  opts: { password?: string; displayName?: string; remoteAddress?: string } = {},
): Promise<{ account: Account; cookie: string }> {
  const password = opts.password ?? PASSWORD;
  const body: Record<string, string> = { username, password };
  if (opts.displayName !== undefined) body['displayName'] = opts.displayName;
  const address = opts.remoteAddress ?? `198.51.100.${username.length}`;
  const registered = await call(h.app, 'POST', '/auth/register', { body, remoteAddress: address });
  if (registered.status !== 201) throw new Error(`register ${username}: ${registered.status}`);
  const login = await call<{ account: Account }>(h.app, 'POST', '/auth/login', {
    body: { username, password },
    remoteAddress: address,
  });
  const cookie = cookieValue(login.setCookies);
  if (login.status !== 200 || cookie === null)
    throw new Error(`login ${username}: ${login.status}`);
  return { account: login.body.account, cookie };
}

/**
 * Inserts an account and a login row directly (no scrypt: fast), as `register` + `login` would
 * leave them. The clock advances 1 ms so ids and timestamps order by creation.
 */
export function addAccount(
  h: LobbyHarness,
  username: string,
  displayName: string = username,
): { account: Account; cookie: string } {
  h.clock.now += 1;
  const now = h.clock.now;
  const id = ulid(now);
  h.db
    .prepare(
      'INSERT INTO accounts (id, username, display_name, password_hash, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, username.toLowerCase(), displayName, UNUSABLE_HASH, now, now);
  const cookie = newCookieToken();
  h.db
    .prepare(
      'INSERT INTO lobby_sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    )
    .run(hashCookieToken(cookie), id, now, now + LOBBY_SESSION_TTL_MS);
  return {
    account: {
      id,
      username: username.toLowerCase(),
      displayName,
      createdAt: now,
      lastLoginAt: now,
    },
    cookie,
  };
}

/** Makes `a` and `b` accepted friends directly. */
export function befriend(h: LobbyHarness, a: string, b: string): void {
  const [low, high] = a < b ? [a, b] : [b, a];
  h.db
    .prepare(
      "INSERT INTO friends (account_id, friend_id, status, requested_by, created_at) VALUES (?, ?, 'accepted', ?, ?)",
    )
    .run(low, high, a, h.clock.now);
}

/** A presence socket double built on EventEmitter: `emit('message', data, isBinary)` delivers. */
export class FakeSocket extends EventEmitter implements PresenceSocket {
  readonly sent: string[] = [];
  closedWith: { code: number | undefined; reason: string | undefined } | null = null;
  terminated = false;
  pings = 0;
  failSends = false;

  send(data: string): void {
    if (this.failSends) throw new Error('socket is not open');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
  }

  terminate(): void {
    this.terminated = true;
  }

  ping(): void {
    this.pings++;
  }

  /** Delivers a text message (JSON-encoded unless already a string). */
  receive(message: unknown): void {
    this.emit('message', typeof message === 'string' ? message : JSON.stringify(message), false);
  }

  /** Every message sent so far, parsed. */
  events(): LobbyEvent[] {
    return this.sent.map((data) => JSON.parse(data));
  }

  /** Parsed messages sent since the last call to `take`. */
  take(): LobbyEvent[] {
    const events = this.events();
    this.sent.length = 0;
    return events;
  }
}
