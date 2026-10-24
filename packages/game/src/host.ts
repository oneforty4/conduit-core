// Node-only entry (docs/game.md 3, 5): the production host (lobby, gateway, one worker per session)
// for one or more games. Never re-exported from src/index.ts.
import { Host, type Logger, type LogLevel, logs } from '@conduit/host';
import type { HostGameEntry, ServerLog } from './types.ts';

export type { HostGameEntry } from './types.ts';

export interface CreateHostOpts {
  /** HTTP and WebSocket port; 0 picks a free one (see `GameHost.port`). */
  port: number;
  /** The SQLite file holding the lobby tables and every session's blobs; `':memory:'` allowed. */
  dbPath: string;
  /** `HOST_SECRET`: the HMAC key of session tokens, at least 32 UTF-8 bytes (docs/host.md 16). */
  secret: string;
  /** Directory served at `/` after the lobby routes (docs/host.md 22). */
  static?: string | undefined;
  /**
   * The session worker entry. Default `@conduit/host`'s `src/worker.ts`, located from its own
   * module, which a bundle does not keep: a bundled host builds `@conduit/host/worker` as a second
   * entry and points this at its output (docs/consuming.md 4).
   */
  workerEntry?: string | URL | undefined;
  /**
   * The workers' `execArgv`. Default `process.execArgv`; pass `[]` when the host runs with flags a
   * worker rejects (`--max-old-space-size`: `ERR_WORKER_INVALID_EXEC_ARGV`).
   */
  workerExecArgv?: string[] | undefined;
  /**
   * Receives the host's log lines, the session workers' included (prefixed `[session <id>]`), at
   * the configured `LOG_LEVEL` (default `info`) and above; debug lines arrive as `'info'`. Default:
   * the host's console logger.
   */
  log?: ServerLog | undefined;
}

export interface GameHost {
  readonly port: number;
  /** `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** Flushes every session worker, stops them all, closes the HTTP server and the store. Idempotent. */
  close(): Promise<void>;
}

/** The host's `Logger` over a `ServerLog`, filtered by the level the host resolved from its config. */
function hostLogger(log: ServerLog, threshold: () => LogLevel): Logger {
  const at =
    (level: LogLevel, as: 'info' | 'warn' | 'error') =>
    (msg: string, data?: unknown): void => {
      if (logs(threshold(), level)) log(as, msg, data);
    };
  return {
    debug: at('debug', 'info'),
    info: at('info', 'info'),
    warn: at('warn', 'warn'),
    error: at('error', 'error'),
  };
}

/**
 * Starts `Host` (docs/host.md 22) with every game registered: session workers import `module`,
 * which must export `game` and `sessionFactory` (built with `defineSessionFactory`), so hooks run
 * with the same `ServerContext` as under `createServer`. Like `createServer`, option errors throw
 * synchronously: a game id listed twice (before anything is opened), then the host's `ConfigError`
 * (a weak `secret`, a bad `port` or `static`) or a store that fails to open. The promise rejects
 * when listening fails, after closing the host again.
 */
export function createHost(
  games: readonly HostGameEntry[],
  opts: CreateHostOpts,
): Promise<GameHost> {
  const ids = new Set<string>();
  for (const { game } of games) {
    if (ids.has(game.id)) throw new Error(`createHost: game ${game.id} is listed twice`);
    ids.add(game.id);
  }
  let threshold: LogLevel = 'info';
  const host = new Host({
    port: opts.port,
    dbPath: opts.dbPath,
    secret: opts.secret,
    staticDir: opts.static,
    workerEntry: opts.workerEntry,
    workerExecArgv: opts.workerExecArgv,
    logger: opts.log === undefined ? undefined : hostLogger(opts.log, () => threshold),
  });
  threshold = host.config.logLevel;
  for (const { game, module } of games) host.registerGame(game, { module });
  return listen(host);
}

async function listen(host: Host): Promise<GameHost> {
  try {
    const { port, url } = await host.listen();
    return Object.freeze({ port, url, close: () => host.close() });
  } catch (err) {
    await host.close().catch(() => undefined);
    throw err;
  }
}
