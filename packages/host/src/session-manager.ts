import { DEFAULT_SESSION_CAPACITY, QUALIFIED_SESSION_CAPACITY } from '@conduit/protocol';
import { Worker } from 'node:worker_threads';
import type { SessionToken } from '@conduit/auth';
import type { SessionLog, SessionOptions, TickStats } from '@conduit/net-server';
import type { BlobStore } from '@conduit/persist';
import {
  FLUSH_TIMEOUT_MS,
  GATEWAY_CLOSE,
  IDLE_TIMEOUT_MS,
  MAX_SOCKET_BUFFERED_BYTES,
  SHUTDOWN_GRACE_MS,
  STATS_INTERVAL_MS,
  WORKER_READY_TIMEOUT_MS,
} from './constants.ts';
import { HostError } from './errors.ts';
import { isLogLevel, type Logger, type LogLevel } from './logger.ts';
import type { MainToWorker, WorkerData, WorkerToMain } from './port-protocol.ts';
import { StoreBridge } from './store-bridge.ts';

/** The game facts the host needs on the main thread; any `defineGame` result satisfies it. */
export interface RegisteredGameDef {
  id: string;
  name: string;
  protocolVersion: number;
  tickRate: number;
  snapshotEvery: number;
}

export interface RegisteredGame {
  def: RegisteredGameDef;
  /** Importable URL of the module exporting `game` and `sessionFactory`; unset until known. */
  module: string | undefined;
}

/** What the worker hands a game module's `sessionFactory` besides the session id. */
export interface SessionFactoryOptions {
  maxPlayers?: number | undefined;
  /**
   * The worker's log, the same one its Session gets: lines reach the host's logger prefixed
   * `[session <id>]` (docs/host.md 18). `defineSessionFactory` gives it to every `ServerContext`.
   */
  log: SessionLog;
}

/**
 * The `sessionFactory` export of a game module (docs/host.md 19, 21): called in the worker with the
 * session id and `{ log }`. Games build it with `defineSessionFactory` (docs/game.md 3).
 */
export type SessionFactory = (
  sessionId: string,
  opts?: SessionFactoryOptions,
) => Pick<
  SessionOptions,
  | 'regionLoader'
  | 'hooks'
  | 'saveSchema'
  | 'saveLimits'
  | 'saveCompatibilityAdapter'
  | 'saveRegistryAdapter'
  | 'replication'
  | 'snapshotLimits'
  | 'diagnostics'
  | 'maxPlayers'
>;

/** The parts of a `ws` `WebSocket` the host uses for a game socket; `ws`'s class satisfies it. */
export interface GatewaySocket {
  readonly bufferedAmount: number;
  send(data: ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(
    event: 'message',
    listener: (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void,
  ): unknown;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/** A game socket that passed the gateway's Hello check (docs/host.md 17). */
export interface GatewayClient {
  ws: GatewaySocket;
  /** Process-wide, never reused. */
  clientId: number;
  identity: SessionToken;
  /** The complete first frame (the Hello); transferred to the worker. */
  helloFrame: ArrayBuffer;
  /** The token had expired and the Hello carried a reconnect token (docs/host.md 17). Default false. */
  tokenExpired?: boolean | undefined;
}

export interface SessionManagerOptions {
  store: BlobStore;
  games: Map<string, RegisteredGame>;
  logger: Logger;
  /** Default `IDLE_TIMEOUT_MS`. */
  idleTimeoutMs?: number | undefined;
  /** Default `./worker.ts` next to this file; a bundle points it at the bundled worker entry. */
  workerEntry?: string | URL | undefined;
  /** Default `process.execArgv` (keeps `--import tsx` and `--experimental-sqlite`). */
  execArgv?: string[] | undefined;
  workerExtra?: Record<string, unknown> | undefined;
  /** Workers log at this level and above. Default `'info'`. */
  logLevel?: LogLevel | undefined;
  onCrash(sessionId: string, err: Error): void;
  onIdle(sessionId: string): void;
  onTickStats?: ((sessionId: string, stats: TickStats) => void) | undefined;
  /** Health-only stale threshold; default5000ms. Does not restart or alter admission. */
  staleAfterMs?: number | undefined;
  now?: (() => number) | undefined;
  setTimeout?: ((fn: () => void, ms: number) => unknown) | undefined;
  clearTimeout?: ((handle: unknown) => void) | undefined;
  setInterval?: ((fn: () => void, ms: number) => unknown) | undefined;
  clearInterval?: ((handle: unknown) => void) | undefined;
}

export type WorkerState = 'starting' | 'running' | 'faulted' | 'stopping';

export interface SessionHealth {
  status?: 'live' | 'stale' | 'faulted' | 'starting' | 'stopping';
  statsAgeMs?: number | null;
  sessionId: string;
  gameId: string;
  state: WorkerState;
  clients: number;
  /** Unix ms: when the worker became ready (while starting: when it was spawned). */
  startedAt: number;
  /** The latest `tickStats` from the worker. */
  tick: TickStats | null;
}

interface PendingFlush {
  resolve(): void;
  reject(err: Error): void;
  timer: unknown;
}

interface WorkerRecord {
  readonly sessionId: string;
  readonly gameId: string;
  readonly maxPlayers: number;
  readonly worker: Worker;
  readonly bridge: StoreBridge;
  state: WorkerState;
  /** Removed from the manager: failed start, crash or completed stop. */
  gone: boolean;
  readonly clients: Map<number, GatewayClient>;
  idleTimer: unknown;
  statsTimer: unknown;
  readyTimer: unknown;
  startedAt: number;
  lastTickStats: TickStats | null;
  lastTickStatsAt: number | null;
  readonly startPromise: Promise<void>;
  resolveStart(): void;
  rejectStart(err: Error): void;
  stopPromise: Promise<void> | null;
  readonly pendingFlushes: Map<number, PendingFlush>;
  nextFlushId: number;
  /** Resolves with the exit code once the thread exited. */
  readonly exited: Promise<number>;
  resolveExit(code: number): void;
  /** The error of a `fatal` message. */
  fatal: Error | null;
}

const DEFAULT_CLOSE = Object.freeze({
  code: GATEWAY_CLOSE.SHUTTING_DOWN as number,
  reason: 'shutting_down',
});

function unref(handle: unknown): unknown {
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
    const fn = (handle as { unref?: unknown }).unref;
    if (typeof fn === 'function') fn.call(handle);
  }
  return handle;
}

/** Closes a socket, terminating it when `close` throws (an invalid code or an over-long reason). */
export function closeSocket(
  ws: Pick<GatewaySocket, 'close' | 'terminate'>,
  code: number,
  reason: string,
): void {
  try {
    ws.close(code, reason);
  } catch {
    ws.terminate();
  }
}

/** A standalone copy of a `ws` message, ready for a transfer (ws hands out pooled `Buffer` views). */
function copyFrame(data: Buffer | ArrayBuffer | Buffer[]): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data.slice(0);
  const buf = Array.isArray(data) ? Buffer.concat(data) : data;
  return (buf.buffer as ArrayBuffer).slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function defaultWorkerEntry(): URL {
  return new URL('./worker.ts', import.meta.url);
}

/**
 * One `worker_threads` Worker per running game session (docs/host.md 19): start on first join,
 * relay game sockets over the worker's port, idle stop, crash isolation and graceful shutdown.
 */
export class SessionManager {
  private readonly store: BlobStore;
  private readonly games: Map<string, RegisteredGame>;
  private readonly logger: Logger;
  private readonly idleTimeoutMs: number;
  private readonly workerEntry: string | URL;
  private readonly execArgv: string[];
  private readonly workerExtra: Record<string, unknown> | undefined;
  private readonly logLevel: LogLevel;
  private readonly onCrash: (sessionId: string, err: Error) => void;
  private readonly onIdle: (sessionId: string) => void;
  private readonly staleAfterMs: number;
  private readonly onTickStats: ((sessionId: string, stats: TickStats) => void) | undefined;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly setRepeat: (fn: () => void, ms: number) => unknown;
  private readonly clearRepeat: (handle: unknown) => void;
  private readonly records = new Map<string, WorkerRecord>();

  constructor(opts: SessionManagerOptions) {
    this.store = opts.store;
    this.games = opts.games;
    this.logger = opts.logger;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    const entry = opts.workerEntry ?? defaultWorkerEntry();
    this.workerEntry =
      typeof entry === 'string' && entry.startsWith('file:') ? new URL(entry) : entry;
    this.execArgv = opts.execArgv ?? process.execArgv;
    this.workerExtra = opts.workerExtra;
    this.logLevel = opts.logLevel ?? 'info';
    this.onCrash = opts.onCrash;
    this.onIdle = opts.onIdle;
    this.onTickStats = opts.onTickStats;
    this.now = opts.now ?? Date.now;
    this.staleAfterMs = opts.staleAfterMs ?? 5000;
    if (!Number.isFinite(this.staleAfterMs) || this.staleAfterMs < 0)
      throw new RangeError('Invalid staleAfterMs');
    this.setTimer = opts.setTimeout ?? ((fn, ms) => unref(setTimeout(fn, ms)));
    this.clearTimer =
      opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.setRepeat = opts.setInterval ?? ((fn, ms) => unref(setInterval(fn, ms)));
    this.clearRepeat =
      opts.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  }

  /**
   * Resolves once the session's worker is ready: at once when it runs, with the pending start when
   * it is starting, after the stop and a fresh start when it is stopping. Rejects `HostError`:
   * `unknown_game`, `no_game_module`, `worker_start_timeout` (the worker is terminated) or
   * `worker_start_failed`.
   */
  async start(
    sessionId: string,
    gameId: string,
    maxPlayers = DEFAULT_SESSION_CAPACITY,
  ): Promise<void> {
    if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > QUALIFIED_SESSION_CAPACITY)
      throw new RangeError('SessionManager: invalid maxPlayers');
    for (;;) {
      const existing = this.records.get(sessionId);
      if (existing === undefined) break;
      if (existing.maxPlayers !== maxPlayers)
        throw new HostError('worker_start_failed', 'session capacity is pinned');
      if (existing.state === 'running') return;
      if (existing.state === 'starting') return existing.startPromise;
      if (existing.state === 'faulted') throw existing.fatal ?? new Error('session faulted');
      await existing.stopPromise?.catch(() => undefined);
    }
    const game = this.games.get(gameId);
    if (game === undefined) throw new HostError('unknown_game', `unknown game ${gameId}`);
    if (game.module === undefined) {
      throw new HostError('no_game_module', `game ${gameId} was registered without a module`);
    }
    return this.spawn(sessionId, gameId, game.module, maxPlayers).startPromise;
  }

  /**
   * Flushes and stops the session's worker: `shutdown` (the worker closes its clients with `close`,
   * saves and exits), `terminate()` after `SHUTDOWN_GRACE_MS`, then sockets still attached are
   * closed with `close.code`. Default close `SHUTTING_DOWN`. Resolves once the worker exited; a
   * session that is not present resolves at once.
   */
  async stop(
    sessionId: string,
    close: { code: number; reason: string } = DEFAULT_CLOSE,
  ): Promise<void> {
    for (;;) {
      const rec = this.records.get(sessionId);
      if (rec === undefined) return;
      if (rec.state === 'stopping') return rec.stopPromise ?? undefined;
      if (rec.state === 'starting') {
        await rec.startPromise.catch(() => undefined);
        continue;
      }
      rec.state = 'stopping';
      rec.stopPromise = this.shutdownWorker(rec, close);
      return rec.stopPromise;
    }
  }

  /** The session's worker is ready and not stopping. */
  isRunning(sessionId: string): boolean {
    return this.records.get(sessionId)?.state === 'running';
  }

  /** The session has a worker in any state. */
  has(sessionId: string): boolean {
    return this.records.has(sessionId);
  }

  /**
   * A lobby join of a running session (docs/host.md 6, 19): restarts the idle timer of a session
   * that has no attached sockets, so its worker is still running when the joiner's socket arrives,
   * however close the old deadline was. A no-op for a session with sockets (no timer is armed) or
   * one that is not running.
   */
  touch(sessionId: string): void {
    const rec = this.records.get(sessionId);
    if (rec === undefined || rec.gone || rec.state !== 'running' || rec.clients.size > 0) return;
    this.armIdle(rec);
  }

  /**
   * Hands a verified game socket to the session's worker (docs/host.md 19): posts `attach` with the
   * Hello frame, relays binary messages as `frame` (a text message closes the socket `BAD_FRAME`)
   * and the socket's close as `closed`. A session that is not running closes the socket
   * `SESSION_NOT_RUNNING`.
   */
  attach(sessionId: string, client: GatewayClient): void {
    const rec = this.records.get(sessionId);
    const { ws, clientId } = client;
    if (rec === undefined || rec.state !== 'running') {
      closeSocket(ws, GATEWAY_CLOSE.SESSION_NOT_RUNNING, 'session not running');
      return;
    }
    rec.clients.set(clientId, client);
    this.disarmIdle(rec);
    const helloFrame = client.helloFrame;
    this.post(
      rec,
      {
        t: 'attach',
        clientId,
        identity: client.identity,
        tokenExpired: client.tokenExpired ?? false,
        helloFrame,
      },
      [helloFrame],
    );
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        closeSocket(ws, GATEWAY_CLOSE.BAD_FRAME, 'binary only');
        return;
      }
      if (rec.gone || rec.clients.get(clientId) !== client) return;
      const buf = copyFrame(data);
      this.post(rec, { t: 'frame', clientId, buf }, [buf]);
    });
    ws.on('close', (code, reason) => {
      if (rec.clients.get(clientId) !== client) return;
      rec.clients.delete(clientId);
      this.post(rec, { t: 'closed', clientId, code, reason: reason.toString('utf8') });
      if (rec.clients.size === 0 && rec.state === 'running' && !rec.gone) this.armIdle(rec);
    });
    ws.on('error', () => ws.terminate());
  }

  /** Closes every game socket of `accountId` in the session (a member left, docs/host.md 6). */
  disconnect(sessionId: string, accountId: string, code: number, reason: string): void {
    const rec = this.records.get(sessionId);
    if (rec === undefined) return;
    for (const client of rec.clients.values()) {
      if (client.identity.accountId === accountId) closeSocket(client.ws, code, reason);
    }
  }

  /** Asks every running worker to save (`flush`) and waits up to `FLUSH_TIMEOUT_MS` each; never rejects. */
  async flushAll(): Promise<void> {
    const running = [...this.records.values()].filter((rec) => rec.state === 'running');
    await Promise.all(
      running.map((rec) =>
        this.flush(rec).catch((err: unknown) =>
          this.logger.error(`[session ${rec.sessionId}] flush failed`, err),
        ),
      ),
    );
  }

  health(): SessionHealth[] {
    return [...this.records.values()].map((rec) => ({
      sessionId: rec.sessionId,
      gameId: rec.gameId,
      state: rec.state,
      clients: rec.clients.size,
      startedAt: rec.startedAt,
      tick: rec.lastTickStats,
      statsAgeMs:
        rec.lastTickStatsAt === null ? null : Math.max(0, this.now() - rec.lastTickStatsAt),
      status:
        rec.state === 'running'
          ? this.now() - (rec.lastTickStatsAt ?? rec.startedAt) > this.staleAfterMs
            ? 'stale'
            : 'live'
          : rec.state,
    }));
  }

  /** `flushAll()`, then every worker stopped with `close`. */
  async shutdown(close: { code: number; reason: string } = DEFAULT_CLOSE): Promise<void> {
    await this.flushAll();
    await Promise.all([...this.records.keys()].map((id) => this.stop(id, close)));
  }

  // -----------------------------------------------------------------------------------------------

  private spawn(
    sessionId: string,
    gameId: string,
    gameModule: string,
    maxPlayers: number,
  ): WorkerRecord {
    const workerData: WorkerData = {
      sessionId,
      gameId,
      gameModule,
      maxPlayers,
      logLevel: this.logLevel,
    };
    if (this.workerExtra !== undefined) workerData.extra = this.workerExtra;
    let worker: Worker;
    try {
      worker = new Worker(this.workerEntry, {
        workerData,
        execArgv: this.execArgv,
        stdout: false,
        stderr: false,
      });
    } catch (err) {
      throw new HostError('worker_start_failed', `session ${sessionId}: the worker did not spawn`, {
        cause: err,
      });
    }
    let resolveStart = (): void => {};
    let rejectStart = (_err: Error): void => {};
    const startPromise = new Promise<void>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    startPromise.catch(() => undefined); // awaited by callers; never an unhandled rejection
    let resolveExit = (_code: number): void => {};
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const rec: WorkerRecord = {
      sessionId,
      gameId,
      maxPlayers,
      worker,
      // Keyed by session: every session of the host shares the one store (docs/host.md 20).
      bridge: new StoreBridge(this.store, worker, sessionId),
      state: 'starting',
      gone: false,
      clients: new Map(),
      idleTimer: undefined,
      statsTimer: undefined,
      readyTimer: undefined,
      startedAt: this.now(),
      lastTickStats: null,
      lastTickStatsAt: null,
      startPromise,
      resolveStart,
      rejectStart,
      stopPromise: null,
      pendingFlushes: new Map(),
      nextFlushId: 1,
      exited,
      resolveExit,
      fatal: null,
    };
    this.records.set(sessionId, rec);
    rec.readyTimer = this.setTimer(() => {
      rec.readyTimer = undefined;
      if (rec.state !== 'starting' || rec.gone) return;
      this.failStart(
        rec,
        new HostError(
          'worker_start_timeout',
          `session ${sessionId}: the worker was not ready within ${WORKER_READY_TIMEOUT_MS} ms`,
        ),
      );
    }, WORKER_READY_TIMEOUT_MS);
    worker.on('message', (msg: WorkerToMain) => this.onWorkerMessage(rec, msg));
    worker.on('error', (err) => this.onWorkerError(rec, err));
    worker.on('exit', (code) => this.onWorkerExit(rec, code));
    return rec;
  }

  private onWorkerMessage(rec: WorkerRecord, msg: WorkerToMain): void {
    switch (msg.t) {
      case 'ready':
        this.onReady(rec);
        return;
      case 'send': {
        const client = rec.clients.get(msg.clientId);
        if (client === undefined) return;
        try {
          client.ws.send(msg.buf);
        } catch {
          // A socket can close between the worker enqueue and this relay. Remove it before
          // termination: an implementation may emit close synchronously or fail to emit it.
          rec.clients.delete(msg.clientId);
          this.post(rec, {
            t: 'closed',
            clientId: msg.clientId,
            code: 1006,
            reason: 'send failed',
          });
          if (rec.clients.size === 0 && rec.state === 'running' && !rec.gone) this.armIdle(rec);
          try {
            client.ws.terminate();
          } catch {
            // Its worker-side link is already detached; transport teardown is best effort.
          }
        }
        return;
      }
      case 'close': {
        const client = rec.clients.get(msg.clientId);
        if (client !== undefined) closeSocket(client.ws, msg.code, msg.reason);
        return;
      }
      case 'flushed': {
        const pending = rec.pendingFlushes.get(msg.reqId);
        if (pending === undefined) return;
        rec.pendingFlushes.delete(msg.reqId);
        this.clearTimer(pending.timer);
        if (msg.ok) pending.resolve();
        else pending.reject(new Error(msg.error ?? 'flush failed'));
        return;
      }
      case 'tickStats':
        rec.lastTickStats = msg.stats;
        rec.lastTickStatsAt = this.now();
        try {
          this.onTickStats?.(rec.sessionId, msg.stats);
        } catch {
          try {
            this.logger.warn('tickStats observer failed');
          } catch {
            /* Diagnostic reporting cannot affect host lifecycle. */
          }
        }
        return;
      case 'store':
        void rec.bridge.handle(msg);
        return;
      case 'log': {
        const level = isLogLevel(msg.level) ? msg.level : 'info';
        this.logger[level](`[session ${rec.sessionId}] ${msg.msg}`, msg.data);
        return;
      }
      case 'fatal': {
        const err = new Error(msg.error.message);
        if (msg.error.stack !== undefined) err.stack = msg.error.stack;
        rec.fatal = err;
        if (rec.state === 'running') rec.state = 'faulted';
        this.logger.error(`[session ${rec.sessionId}] fatal: ${msg.error.message}`, err);
        if (rec.state === 'starting' && !rec.gone) {
          this.failStart(rec, err);
        }
        return;
      }
    }
  }

  private onReady(rec: WorkerRecord): void {
    if (rec.state !== 'starting' || rec.gone) return;
    this.clearTimer(rec.readyTimer);
    rec.readyTimer = undefined;
    rec.state = 'running';
    rec.startedAt = this.now();
    rec.statsTimer = this.setRepeat(() => this.reportStats(rec), STATS_INTERVAL_MS);
    this.armIdle(rec); // a session nobody connects to idles out too
    rec.resolveStart();
  }

  private onWorkerError(rec: WorkerRecord, err: Error): void {
    if (rec.gone) return;
    if (rec.state === 'starting') this.failStart(rec, err);
    else if (rec.state === 'running' || rec.state === 'faulted') this.crash(rec, err);
    else this.logger.error(`[session ${rec.sessionId}] worker error while stopping`, err);
  }

  private onWorkerExit(rec: WorkerRecord, code: number): void {
    rec.resolveExit(code);
    if (rec.gone) return;
    const err = rec.fatal ?? new Error(`the worker exited with code ${code}`);
    if (rec.state === 'starting') {
      this.failStart(rec, err);
    } else if (rec.state === 'running' || rec.state === 'faulted') {
      this.crash(rec, err);
    } else if (code !== 0) {
      this.logger.warn(
        `[session ${rec.sessionId}] the worker exited with code ${code} while stopping`,
      );
    }
  }

  private failStart(rec: WorkerRecord, err: Error): void {
    this.remove(rec);
    void rec.worker.terminate();
    const failure =
      err instanceof HostError
        ? err
        : new HostError('worker_start_failed', `session ${rec.sessionId}: ${err.message}`, {
            cause: err,
          });
    this.logger.error(`[session ${rec.sessionId}] start failed`, failure);
    rec.rejectStart(failure);
  }

  /** An unexpected `error` or exit of a running worker (docs/host.md 19). */
  private crash(rec: WorkerRecord, err: Error): void {
    this.logger.error(`[session ${rec.sessionId}] worker crashed`, err);
    this.remove(rec);
    for (const client of rec.clients.values()) {
      closeSocket(client.ws, GATEWAY_CLOSE.WORKER_CRASHED, 'worker crashed');
    }
    rec.clients.clear();
    void rec.worker.terminate();
    try {
      this.onCrash(rec.sessionId, err);
    } catch (hookErr) {
      this.logger.error(`[session ${rec.sessionId}] onCrash threw`, hookErr);
    }
  }

  private async shutdownWorker(
    rec: WorkerRecord,
    close: { code: number; reason: string },
  ): Promise<void> {
    this.disarmIdle(rec);
    this.clearRepeat(rec.statsTimer);
    rec.statsTimer = undefined;
    this.post(rec, {
      t: 'shutdown',
      graceMs: SHUTDOWN_GRACE_MS,
      code: close.code,
      reason: close.reason,
    });
    const exitedInTime = await this.within(rec.exited, SHUTDOWN_GRACE_MS);
    if (!exitedInTime) {
      this.logger.warn(
        `[session ${rec.sessionId}] the worker did not exit within ${SHUTDOWN_GRACE_MS} ms; terminating it`,
      );
      await rec.worker.terminate();
    }
    for (const client of rec.clients.values()) closeSocket(client.ws, close.code, close.reason);
    rec.clients.clear();
    this.remove(rec);
  }

  /** Takes the record out of the manager: timers cleared, pending flushes rejected. */
  private remove(rec: WorkerRecord): void {
    rec.gone = true;
    if (this.records.get(rec.sessionId) === rec) this.records.delete(rec.sessionId);
    this.clearTimer(rec.readyTimer);
    rec.readyTimer = undefined;
    this.disarmIdle(rec);
    this.clearRepeat(rec.statsTimer);
    rec.statsTimer = undefined;
    for (const pending of rec.pendingFlushes.values()) {
      this.clearTimer(pending.timer);
      pending.reject(new HostError('not_running', `session ${rec.sessionId} is not running`));
    }
    rec.pendingFlushes.clear();
  }

  private flush(rec: WorkerRecord): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const reqId = rec.nextFlushId++;
      const timer = this.setTimer(() => {
        if (rec.pendingFlushes.delete(reqId)) {
          reject(new Error(`no flushed answer within ${FLUSH_TIMEOUT_MS} ms`));
        }
      }, FLUSH_TIMEOUT_MS);
      rec.pendingFlushes.set(reqId, { resolve, reject, timer });
      this.post(rec, { t: 'flush', reqId });
    });
  }

  /** Every `STATS_INTERVAL_MS`: socket buffers to the worker; a socket over the limit is closed. */
  private reportStats(rec: WorkerRecord): void {
    if (rec.gone || rec.clients.size === 0) return;
    const entries: [number, number][] = [];
    for (const [clientId, client] of rec.clients) {
      const buffered = client.ws.bufferedAmount;
      if (buffered > MAX_SOCKET_BUFFERED_BYTES) {
        closeSocket(client.ws, GATEWAY_CLOSE.SLOW_CLIENT, 'slow client');
      }
      entries.push([clientId, buffered]);
    }
    this.post(rec, { t: 'stats', entries });
  }

  private armIdle(rec: WorkerRecord): void {
    this.disarmIdle(rec);
    rec.idleTimer = this.setTimer(() => {
      rec.idleTimer = undefined;
      if (rec.gone || rec.state !== 'running' || rec.clients.size > 0) return;
      void this.idleStop(rec);
    }, this.idleTimeoutMs);
  }

  private disarmIdle(rec: WorkerRecord): void {
    if (rec.idleTimer === undefined) return;
    this.clearTimer(rec.idleTimer);
    rec.idleTimer = undefined;
  }

  private async idleStop(rec: WorkerRecord): Promise<void> {
    try {
      await this.stop(rec.sessionId);
    } catch (err) {
      this.logger.error(`[session ${rec.sessionId}] idle stop failed`, err);
    }
    try {
      this.onIdle(rec.sessionId);
    } catch (err) {
      this.logger.error(`[session ${rec.sessionId}] onIdle threw`, err);
    }
  }

  /** Resolves true when `promise` settles within `ms` (injected timers), else false. */
  private within(promise: Promise<unknown>, ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = this.setTimer(() => resolve(false), ms);
      void promise.then(() => {
        this.clearTimer(timer);
        resolve(true);
      });
    });
  }

  private post(rec: WorkerRecord, msg: MainToWorker, transfer?: ArrayBuffer[]): void {
    try {
      rec.worker.postMessage(msg, transfer);
    } catch (err) {
      this.logger.warn(`[session ${rec.sessionId}] posting ${msg.t} failed`, err);
    }
  }
}
