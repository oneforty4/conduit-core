import { EventEmitter } from 'node:events';
import {
  CoreKind,
  decodeWith,
  encodeWith,
  FrameWriter,
  HelloSchema,
  type MessageDef,
  readFrame,
  type Schema,
} from '@conduit/protocol';
import { WebSocket } from 'ws';
import { Host, type HostOptions } from '../../src/host.ts';
import type { Logger, LogLevel } from '../../src/logger.ts';
import { game } from './game.ts';

/** The fixture game module's URL, as the worker imports it. */
export const FIXTURE_MODULE = new URL('./game.ts', import.meta.url).href;
/** 48 bytes. */
export const SECRET = 'host-test-secret-0123456789abcdef-0123456789abcd';
/** Workers load `.ts` through Node's type stripping, or tsx where Node lacks it. */
export const WORKER_EXEC_ARGV: string[] = process.features.typescript ? [] : ['--import', 'tsx'];

export interface LogEntry {
  level: LogLevel;
  msg: string;
  data: unknown;
}

/** A `Logger` that records every entry (and prints errors when `CONDUIT_TEST_LOG` is set). */
export function recordingLogger(): Logger & {
  entries: LogEntry[];
  messages(level?: LogLevel): string[];
} {
  const entries: LogEntry[] = [];
  const log = (level: LogLevel) => (msg: string, data?: unknown) => {
    entries.push({ level, msg, data });
    if (process.env.CONDUIT_TEST_LOG !== undefined) console.log(level, msg, data ?? '');
  };
  return {
    entries,
    messages: (level) =>
      entries.filter((e) => level === undefined || e.level === level).map((e) => e.msg),
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
}

/**
 * Injectable timers on a virtual clock (`SessionManager`, `Gateway`): nothing fires until
 * `advance(ms)`, which runs due timers in deadline order.
 */
export class ManualTimers {
  ms = 1_000_000;
  private seq = 0;
  private timers: { id: number; at: number; every: number; fn: () => void }[] = [];

  now = (): number => this.ms;

  setTimeout = (fn: () => void, ms: number): unknown => this.add(fn, ms, 0);
  clearTimeout = (handle: unknown): void => this.remove(handle);
  setInterval = (fn: () => void, ms: number): unknown => this.add(fn, ms, Math.max(1, ms));
  clearInterval = (handle: unknown): void => this.remove(handle);

  /** Timers armed and not fired or cleared. */
  pending(): number {
    return this.timers.length;
  }

  /** Delay of the next timer due, or `undefined`. */
  nextIn(): number | undefined {
    const next = [...this.timers].sort((a, b) => a.at - b.at)[0];
    return next === undefined ? undefined : next.at - this.ms;
  }

  advance(ms: number): void {
    const end = this.ms + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (next === undefined || next.at > end) break;
      this.ms = next.at;
      if (next.every > 0) next.at += next.every;
      else this.timers.shift();
      next.fn();
    }
    this.ms = end;
  }

  private add(fn: () => void, ms: number, every: number): number {
    const id = ++this.seq;
    this.timers.push({ id, at: this.ms + Math.max(0, ms), every, fn });
    return id;
  }

  private remove(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }
}

/** Resolves after `ms` of real time. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `predicate` every 5 ms of real time. */
export async function waitFor(
  predicate: () => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(5);
  }
}

/** A decoded server message. */
export interface Received {
  kind: number;
  name: string;
  payload: unknown;
}

/** Every message of the frames in `bufs`, decoded with the fixture registry (snapshots stay raw). */
export function decodeFrames(bufs: readonly (ArrayBuffer | Uint8Array)[]): Received[] {
  const out: Received[] = [];
  for (const buf of bufs) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    readFrame(bytes, (header, reader) => {
      const def = game.registry.message(header.kind);
      const decodable =
        def !== undefined && header.kind !== CoreKind.Snapshot && header.kind !== CoreKind.Events;
      out.push({
        kind: header.kind,
        name: def?.name ?? `kind${header.kind}`,
        payload: decodable ? decodeWith(reader, def.schema) : undefined,
      });
    });
  }
  return out;
}

/** One frame with one message. */
export function frameOf<T>(kind: number, schema: Schema<T>, payload: T, seq = 0): Uint8Array {
  const fw = new FrameWriter();
  fw.begin();
  fw.message(kind, 0, seq, (w) => encodeWith(w, schema, payload));
  return fw.finish();
}

/** A game message frame of the fixture registry. */
export function gameFrame<T>(def: MessageDef<T>, payload: T, seq: number): Uint8Array {
  return frameOf(game.registry.messageKind(def), def.schema, payload, seq);
}

/** A Hello for the fixture game (docs/protocol.md 9.1), built with `FrameWriter`. */
export function helloFrame(token: string, displayName: string, reconnectToken = ''): Uint8Array {
  return frameOf(CoreKind.Hello, HelloSchema, {
    protocolVersion: game.protocolVersion,
    registryHash: game.registry.hash,
    sessionToken: token,
    reconnectToken,
    displayName,
  });
}

/** An in-memory game socket for `SessionManager.attach` (the `ws` members it uses). */
export class FakeSocket extends EventEmitter {
  bufferedAmount = 0;
  readonly sent: ArrayBuffer[] = [];
  closedWith: { code: number | undefined; reason: string | undefined } | null = null;
  terminated = false;

  send(data: ArrayBuffer): void {
    if (this.closedWith === null) this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.closedWith !== null) return;
    this.closedWith = { code, reason };
    queueMicrotask(() => this.emit('close', code ?? 1005, Buffer.from(reason ?? '')));
  }

  terminate(): void {
    this.terminated = true;
    this.close(1006, '');
  }

  /** A binary message from the client (a pooled `Buffer` view, like `ws` delivers). */
  receive(frame: Uint8Array): void {
    this.emit('message', Buffer.from(frame), true);
  }

  /** Decodes and removes what the server sent so far. */
  take(): Received[] {
    return decodeFrames(this.sent.splice(0));
  }
}

export const PASSWORD = 'correct horse battery';

export interface TestHost {
  host: Host;
  /** `http://127.0.0.1:<port>`. */
  url: string;
  port: number;
  logger: ReturnType<typeof recordingLogger>;
  close(): Promise<void>;
}

/**
 * A listening `Host` on port 0 with an in-memory database, a 48-byte secret, workers loading `.ts`
 * natively (or through tsx) and the fixture game registered by module URL (docs/host.md 23).
 */
export async function startHost(overrides: Partial<HostOptions> = {}): Promise<TestHost> {
  const logger = recordingLogger();
  const host = new Host({
    port: 0,
    dbPath: ':memory:',
    secret: SECRET,
    workerExecArgv: WORKER_EXEC_ARGV,
    logger,
    handleSignals: false,
    ...overrides,
  });
  host.registerGame(game, { module: FIXTURE_MODULE });
  const { port, url } = await host.listen();
  return { host, url, port, logger, close: () => host.close() };
}

/** Registers `username` and logs in over HTTP; returns the `Cookie` header value and the account id. */
export async function lobbyLogin(
  target: TestHost,
  username: string,
): Promise<{ cookie: string; accountId: string }> {
  const post = (path: string, body: unknown) =>
    fetch(`${target.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const registered = await post('/auth/register', { username, password: PASSWORD });
  if (registered.status !== 201) throw new Error(`register ${username}: ${registered.status}`);
  const login = await post('/auth/login', { username, password: PASSWORD });
  if (login.status !== 200) throw new Error(`login ${username}: ${login.status}`);
  const setCookie = login.headers.getSetCookie()[0] ?? '';
  const { account } = (await login.json()) as { account: { id: string } };
  return { cookie: setCookie.split(';')[0] ?? '', accountId: account.id };
}

/** `fetch` against the host with the login cookie and a JSON body. */
export async function lobbyFetch(
  target: TestHost,
  cookie: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = { cookie };
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${target.url}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? null : JSON.stringify(init.body),
  });
}

/** `POST /sessions` for the fixture game; returns the session id and invite code. */
export async function createSession(
  target: TestHost,
  cookie: string,
  visibility: 'private' | 'friends' | 'public' = 'private',
): Promise<{ id: string; inviteCode: string }> {
  const res = await lobbyFetch(target, cookie, '/sessions', {
    method: 'POST',
    body: { gameId: game.id, name: 'test session', visibility, maxPlayers: 8 },
  });
  if (res.status !== 201) throw new Error(`createSession: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { session: { id: string }; inviteCode: string };
  return { id: body.session.id, inviteCode: body.inviteCode };
}

/** `POST /sessions/:id/join` (starts the worker when needed); returns `{ token, wsUrl }`. */
export async function joinSession(
  target: TestHost,
  cookie: string,
  sessionId: string,
  inviteCode?: string,
): Promise<{ token: string; wsUrl: string }> {
  const res = await lobbyFetch(target, cookie, `/sessions/${sessionId}/join`, {
    method: 'POST',
    body: inviteCode === undefined ? {} : { inviteCode },
  });
  if (res.status !== 200) throw new Error(`join: ${res.status} ${await res.text()}`);
  return (await res.json()) as { token: string; wsUrl: string };
}

/** A raw `ws` game socket: every decoded message and the close. */
export class GameSocket {
  readonly ws: WebSocket;
  readonly received: Received[] = [];
  readonly opened: Promise<void>;
  readonly closed: Promise<{ code: number; reason: string }>;
  closeInfo: { code: number; reason: string } | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'nodebuffer';
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
    this.opened.catch(() => undefined);
    this.closed = new Promise((resolve) => {
      this.ws.once('close', (code, reason) => {
        this.closeInfo = { code, reason: reason.toString('utf8') };
        resolve(this.closeInfo);
      });
    });
    this.ws.on('error', () => undefined);
    this.ws.on('message', (data: Buffer, isBinary) => {
      if (isBinary) this.received.push(...decodeFrames([new Uint8Array(data)]));
    });
  }

  send(frame: Uint8Array | string): void {
    this.ws.send(frame);
  }

  names(): string[] {
    return this.received.map((m) => m.name);
  }

  /** Resolves with the first received message named `name` (waiting for it). */
  async next(name: string, timeoutMs = 10_000): Promise<Received> {
    await waitFor(
      () => this.received.some((m) => m.name === name) || this.closeInfo !== null,
      name,
      timeoutMs,
    );
    const found = this.received.find((m) => m.name === name);
    if (found === undefined)
      throw new Error(
        `closed (${this.closeInfo?.code}) before ${name}; got [${this.names().join(', ')}]`,
      );
    return found;
  }
}

/**
 * Joins `sessionId` over the lobby API and opens its game socket with a valid Hello (docs/host.md
 * 23); resolves once the socket is open and the Hello sent.
 */
export async function joinAndConnect(
  target: TestHost,
  cookie: string,
  sessionId: string,
  displayName = 'player',
): Promise<GameSocket & { token: string }> {
  const { token, wsUrl } = await joinSession(target, cookie, sessionId);
  const socket = new GameSocket(wsUrl) as GameSocket & { token: string };
  socket.token = token;
  await socket.opened;
  socket.send(helloFrame(token, displayName));
  return socket;
}
