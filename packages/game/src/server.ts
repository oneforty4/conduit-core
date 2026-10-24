import { devVerifier, hmacVerifier, type TokenVerifier } from '@conduit/auth';
import {
  CloseCode,
  createWsServer,
  Session,
  WsLink,
  type SessionOptions,
} from '@conduit/net-server';
import { AUTOSAVE_INTERVAL_MS, Autosaver, type BlobStore, MemoryStore } from '@conduit/persist';
import type { InputFrame } from '@conduit/sim';
import type { RegionLoader } from '@conduit/world';
import type { WebSocket, WebSocketServer } from 'ws';
import { adaptHooks, consoleServerLog } from './serverContext.ts';
import type {
  Game,
  ServerHooks,
  ServerLog,
  SessionFactory,
  SessionFactoryResult,
} from './types.ts';

// Re-exports so a dev server needs only this entry (docs/game.md 6). Importing `@conduit/persist`
// never loads node:sqlite; `new SqliteStore` does.
export {
  AUTOSAVE_INTERVAL_MS,
  MemoryStore,
  SqliteStore,
  openApplicationSave,
} from '@conduit/persist';
export { DEV_TOKEN, devVerifier, hmacVerifier } from '@conduit/auth';
export {
  createReplayRun,
  createJournalReplayRun,
  type GameReplayRun,
  type ReplayRunOpts,
  type GameJournalReplayRun,
  type JournalReplayRunOpts,
  type ReplayEffectSink,
} from './replayRun.ts';
export type {
  HookContext,
  PlayerInfo,
  PlayerSpawn,
  ServerContext,
  ServerHooks,
  ServerLog,
  SessionFactory,
  SessionFactoryResult,
} from './types.ts';

/** `createServer`'s default bind address. */
export const DEFAULT_SERVER_HOST = '127.0.0.1';
/** The single session's id; `devVerifier` identities carry it, minted tokens must too. */
export const DEV_SESSION_ID = 'dev';

/** Optional fields also accept `undefined`, so options can be passed straight through. */
export interface CreateServerOpts<I extends InputFrame = InputFrame> extends Pick<
  SessionOptions,
  | 'saveSchema'
  | 'saveLimits'
  | 'saveCompatibilityAdapter'
  | 'saveRegistryAdapter'
  | 'diagnostics'
  | 'replication'
  | 'snapshotLimits'
> {
  /** Default 0 (ephemeral); the bound port is `GameServer.port`. */
  port?: number | undefined;
  /** Default `DEFAULT_SERVER_HOST`. */
  host?: string | undefined;
  /**
   * Default `new MemoryStore()`. The server owns the store it is given: `close()` closes it after
   * the final save, and so does a failed start, when it has a `close()` method (`SqliteStore` has).
   */
  store?: BlobStore | undefined;
  /**
   * Period of the autosave (`regions.flushAll`, then `onSave`) while the session runs; ms in
   * (0, 2^31 - 1]; default `AUTOSAVE_INTERVAL_MS` (60 000). The shutdown save of `close()` is its
   * final save.
   */
  autosaveIntervalMs?: number | undefined;
  journal?: SessionOptions['journal'];
  simulationMessages?: SessionOptions['simulationMessages'];
  externalCommands?: SessionOptions['externalCommands'];
  stateSerializers?: SessionOptions['stateSerializers'];
  spawnPlanSerializer?: SessionOptions['spawnPlanSerializer'];
  sessionEpoch?: SessionOptions['sessionEpoch'];
  regionLoader: RegionLoader;
  hooks: ServerHooks<I>;
  /** true: `devVerifier()`, any token accepted, `DEV_AUTH_WARNING` logged once. Default false. */
  devAuth?: boolean | undefined;
  /** Required unless `devAuth`: `hmacVerifier(secret)` (at least 32 UTF-8 bytes). */
  secret?: string | undefined;
  /** 1..8; default 8. */
  maxPlayers?: number | undefined;
  /** Default 120000 (docs/net.md A.1). */
  reconnectGraceMs?: number | undefined;
  /** Default console-backed. Used by the Session, its links and every `ServerContext`. */
  log?: ServerLog | undefined;
}

export interface GameServer {
  readonly port: number;
  readonly session: Session;
  /** `ws://host:port`. */
  readonly url: string;
  /**
   * Stops accepting and stops the Session: the loop stops, clients get `Kicked{ServerShutdown}` and
   * close 1001, then the autosaver's final save (`regions.flushAll`, `onSave`); once every socket has
   * closed, the store is closed. Rejects when that save or closing the store failed. Idempotent.
   */
  close(): Promise<void>;
}

function wsUrl(host: string, port: number): string {
  return host.includes(':') ? `ws://[${host}]:${port}` : `ws://${host}:${port}`;
}

function verifierFor(
  opts: { readonly devAuth?: boolean | undefined; readonly secret?: string | undefined },
  log: ServerLog,
): TokenVerifier {
  if (opts.devAuth === true) return devVerifier({ warn: (msg) => log('warn', msg) });
  if (typeof opts.secret === 'string' && opts.secret !== '') return hmacVerifier(opts.secret);
  throw new Error('createServer: pass secret or devAuth: true');
}

function listening(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      wss.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      wss.off('error', onError);
      resolve();
    };
    wss.once('error', onError);
    wss.once('listening', onListening);
  });
}

/**
 * Single-session mode for dev and tests (docs/game.md 2): one `ws` server, one `Session` with
 * `sessionId 'dev'`, tokens verified in-process, and an `Autosaver` saving the session every
 * `autosaveIntervalMs`. Option errors (no `secret` and no `devAuth`, a weak secret, a bad `port`,
 * `maxPlayers` or `autosaveIntervalMs`, missing hooks) throw synchronously; the returned promise
 * rejects when starting the session or listening fails (the session is stopped again and the store
 * closed).
 */
export function createServer<I extends InputFrame>(
  game: Game<I>,
  opts: CreateServerOpts<I>,
): Promise<GameServer> {
  const log = opts.log ?? consoleServerLog;
  if (typeof opts.regionLoader?.populate !== 'function') {
    throw new TypeError('createServer: regionLoader.populate is required');
  }
  const port = opts.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new RangeError(`createServer: port must be an integer in [0, 65535], got ${port}`);
  }
  const verifier = verifierFor(opts, log);
  const store = opts.store ?? new MemoryStore();
  const autosaveIntervalMs = opts.autosaveIntervalMs ?? AUTOSAVE_INTERVAL_MS;
  for (const definition of opts.simulationMessages ?? [])
    if (typeof opts.hooks.onMessage?.[definition.name] !== 'function')
      throw new TypeError(`Simulation command ${definition.name} has no handler`);
  const session = new Session(game, {
    diagnostics: opts.diagnostics,
    store,
    journal: opts.journal,
    simulationMessages: opts.simulationMessages,
    externalCommands: opts.externalCommands,
    stateSerializers: opts.stateSerializers,
    spawnPlanSerializer: opts.spawnPlanSerializer,
    sessionEpoch: opts.sessionEpoch,
    regionLoader: opts.regionLoader,
    hooks: adaptHooks(opts.hooks, game, log),
    verifier,
    sessionId: DEV_SESSION_ID,
    maxPlayers: opts.maxPlayers,
    reconnectGraceMs: opts.reconnectGraceMs,
    log,
    ...(opts.replication === undefined ? {} : { replication: opts.replication }),
    ...(opts.snapshotLimits === undefined ? {} : { snapshotLimits: opts.snapshotLimits }),
    ...(opts.saveSchema === undefined ? {} : { saveSchema: opts.saveSchema }),
    ...(opts.saveLimits === undefined ? {} : { saveLimits: opts.saveLimits }),
    ...(opts.saveRegistryAdapter === undefined
      ? {}
      : { saveRegistryAdapter: opts.saveRegistryAdapter }),
    ...(opts.saveCompatibilityAdapter === undefined
      ? {}
      : { saveCompatibilityAdapter: opts.saveCompatibilityAdapter }),
    // Started by session.start() once loaded; its stop() in session.stop() is the shutdown save, so
    // nothing here saves on its own. The constructor throws RangeError for a bad interval.
    autosaver: (save) =>
      new Autosaver(save, autosaveIntervalMs, {
        onError: (err) => log('error', 'saving the session failed', err),
      }),
  });
  return serve(session, store, opts.host ?? DEFAULT_SERVER_HOST, port, log);
}

/** Closes a store that has a `close()` (`SqliteStore`); other stores have nothing to release. */
async function closeStore(store: BlobStore): Promise<void> {
  const closable = store as BlobStore & { close?: () => unknown };
  if (typeof closable.close === 'function') await closable.close();
}

/**
 * Runs every step in order, also after one failed; resolves once all ran and rejects with the first
 * failure (later ones are logged).
 */
async function runAll(log: ServerLog, steps: readonly (() => Promise<void>)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      if (failures.length > 0) log('error', 'createServer: shutdown step failed', err);
      failures.push(err);
    }
  }
  if (failures.length > 0) throw failures[0];
}

async function serve(
  session: Session,
  store: BlobStore,
  host: string,
  port: number,
  log: ServerLog,
): Promise<GameServer> {
  // A failed start stops what did start and closes the store it was given, then rethrows the start
  // failure (a failure of that cleanup is only logged).
  const abandon = async (err: unknown, steps: readonly (() => Promise<void>)[]): Promise<never> => {
    try {
      await runAll(log, [...steps, () => closeStore(store)]);
    } catch (cleanupErr) {
      log('error', 'createServer: cleanup after a failed start failed', cleanupErr);
    }
    throw err;
  };

  try {
    await session.start();
  } catch (err) {
    return abandon(err, []);
  }
  let wss: WebSocketServer;
  try {
    wss = createWsServer({ host, port });
  } catch (err) {
    return abandon(err, [() => session.stop()]);
  }
  let nextLinkId = 1;
  wss.on('connection', (socket: WebSocket) => {
    const link = new WsLink(socket, nextLinkId++, {
      log: (level, msg, data) => log(level, msg, data),
    });
    try {
      session.attach(link); // no identity: the Session verifies Hello.sessionToken
    } catch (err) {
      log('error', `attach of link ${link.id} failed`, err);
      link.close(CloseCode.ProtocolViolation, 'attach failed');
    }
  });
  try {
    await listening(wss);
  } catch (err) {
    return abandon(err, [
      async () => {
        wss.close();
      },
      () => session.stop(),
    ]);
  }
  wss.on('error', (err) => log('error', 'websocket server error', err));
  const address = wss.address();
  const boundPort = address !== null && typeof address === 'object' ? address.port : port;

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      // Resolves once every socket has closed; Session.stop() closes every link (1001).
      const serverClosed = new Promise<void>((resolve) => wss.close(() => resolve()));
      await runAll(log, [
        // The loop stops, clients are kicked, then the autosaver's final save: regions.flushAll
        // and onSave. Nothing else saves, so the shutdown save happens exactly once.
        () => session.stop(),
        () => serverClosed,
        // Last: no save can reach the store after this.
        () => closeStore(store),
      ]);
    })();
    return closing;
  };

  return Object.freeze({ port: boundPort, session, url: wsUrl(host, boundPort), close });
}

/**
 * Builds a game module's `sessionFactory` export (docs/game.md 3): the host worker calls it with
 * the session id and its log, and gets the loader plus the game's hooks adapted to `SessionHooks`,
 * so hooks see the same `ServerContext` under `createHost` as under `createServer`, and
 * `ServerContext.log` reaches the host's logger (console-backed when no log is passed).
 */
export function defineSessionFactory<I extends InputFrame>(
  game: Game<I>,
  fn: (sessionId: string, options?: { maxPlayers?: number }) => SessionFactoryResult<I>,
): SessionFactory {
  return (sessionId, opts) => {
    const { regionLoader, hooks, ...persistence } = fn(sessionId, opts);
    return { ...persistence, regionLoader, hooks: adaptHooks(hooks, game, opts?.log) };
  };
}
