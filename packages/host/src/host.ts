import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type GameRegistry,
  LobbyService,
  lobbyMigrations,
  type LobbyEnv,
  type LobbyRouteOptions,
  lobbyRoutes,
  PresenceHub,
  PURGE_INTERVAL_MS,
} from '@conduit/lobby';
import { migrate, SqliteStore } from '@conduit/persist';
import { Hono } from 'hono';
import { type HostConfig, type HostConfigOverrides, loadConfig } from './config.ts';
import { GATEWAY_CLOSE, SHUTDOWN_DEADLINE_MS } from './constants.ts';
import { Gateway } from './gateway.ts';
import { healthRoute } from './health.ts';
import { consoleLogger, type Logger } from './logger.ts';
import { handle } from './node-adapter.ts';
import { type RegisteredGame, type RegisteredGameDef, SessionManager } from './session-manager.ts';
import { staticFiles } from './static.ts';

export interface HostOptions extends HostConfigOverrides {
  /** `HOST_SECRET`; required. */
  secret: string;
  /** gameId → module URL or path, used when `registerGame` names no module. */
  gameModules?: Record<string, string | URL> | undefined;
  /**
   * The session worker entry; default `worker.ts` next to `session-manager.ts`. A bundle builds
   * `@conduit/host/worker` as a second entry and points this at its output (docs/consuming.md 4).
   */
  workerEntry?: string | URL | undefined;
  /** Default `process.execArgv`. */
  workerExecArgv?: string[] | undefined;
  /** `WorkerData.extra`, opaque to core. */
  workerExtra?: Record<string, unknown> | undefined;
  /** Default: `Secure` cookies unless the request `Host` is localhost. */
  secureCookies?: boolean | undefined;
  /** Default `consoleLogger(config.logLevel)`. */
  logger?: Logger | undefined;
  /**
   * `listen()` installs SIGTERM/SIGINT handlers: the first signal runs `close()` and exits 0 (1 when
   * it fails or takes longer than `SHUTDOWN_DEADLINE_MS`), a second one exits 1 at once. Default true.
   */
  handleSignals?: boolean | undefined;
}

const SHUTDOWN_CLOSE = { code: GATEWAY_CLOSE.SHUTTING_DOWN as number, reason: 'shutting_down' };

/** A module location as an importable URL: URLs as they are, paths as `file:` URLs. */
function moduleUrl(module: string | URL): string {
  if (module instanceof URL) return module.href;
  if (isAbsolute(module) || module.startsWith('./') || module.startsWith('../')) {
    return pathToFileURL(resolve(module)).href;
  }
  return module; // a URL (file:, data:) or a bare specifier
}

/**
 * The production process (docs/host.md 15, 22): one HTTP server with `/healthz`, the lobby API and
 * static files; the WebSocket gateway; the SQLite store, lobby service and presence hub; one worker
 * per running game session.
 */
export class Host {
  readonly config: HostConfig;
  readonly app: Hono<LobbyEnv>;
  readonly store: SqliteStore;
  readonly service: LobbyService;
  readonly presence: PresenceHub;
  readonly sessions: SessionManager;
  readonly gateway: Gateway;
  readonly games = new Map<string, RegisteredGame>();
  /** Unix ms, when the host was constructed. */
  readonly startedAt: number;
  private readonly logger: Logger;
  private readonly gameModules: Record<string, string | URL>;
  private readonly handleSignals: boolean;
  private server: Server | null = null;
  private purgeTimer: ReturnType<typeof setInterval> | undefined = undefined;
  private removeSignalHandlers: (() => void) | undefined = undefined;
  private closing: Promise<void> | null = null;

  /**
   * Loads the config (`opts` over `process.env`, docs/host.md 16), opens the store and migrates the
   * lobby schema. Throws `ConfigError`, or the store's error (node:sqlite unavailable, a bad file).
   */
  constructor(opts: HostOptions) {
    this.config = loadConfig(process.env, opts);
    const config = this.config;
    this.startedAt = Date.now();
    this.logger = opts.logger ?? consoleLogger(config.logLevel);
    this.gameModules = opts.gameModules ?? {};
    this.handleSignals = opts.handleSignals ?? true;
    this.store = new SqliteStore(config.dbPath);
    try {
      migrate(this.store.db, lobbyMigrations);
    } catch (err) {
      this.store.close();
      throw err;
    }
    const logger = this.logger;
    this.sessions = new SessionManager({
      store: this.store,
      games: this.games,
      logger,
      idleTimeoutMs: config.idleTimeoutMs,
      workerEntry: opts.workerEntry,
      execArgv: opts.workerExecArgv,
      workerExtra: opts.workerExtra,
      logLevel: config.logLevel,
      onCrash: (id) => this.markIdle(id),
      onIdle: (id) => this.markIdle(id),
    });
    const games = this.games;
    const registry: GameRegistry = {
      list: () =>
        [...games.values()].map(({ def }) => ({
          gameId: def.id,
          name: def.name,
          version: def.protocolVersion,
        })),
      has: (gameId) => games.has(gameId),
    };
    this.service = new LobbyService(this.store.db, {
      host: this.sessions,
      games: registry,
      secret: config.secret,
    });
    this.presence = new PresenceHub(this.service);
    this.service.attachSink(this.presence);
    this.gateway = new Gateway({
      secret: config.secret,
      service: this.service,
      presence: this.presence,
      sessions: this.sessions,
      logger,
    });

    const routeOpts: LobbyRouteOptions = { trustProxy: config.trustProxy };
    if (config.publicWsBase !== undefined) routeOpts.publicWsBase = config.publicWsBase;
    if (opts.secureCookies !== undefined) routeOpts.secureCookies = opts.secureCookies;
    const app = new Hono<LobbyEnv>();
    app.route('/', healthRoute(this.sessions, this.startedAt));
    app.route('/', lobbyRoutes(this.service, routeOpts));
    if (config.staticDir !== undefined) app.all('*', staticFiles(config.staticDir));
    app.notFound((c) => c.json({ error: 'not_found', message: 'not found' }, 404));
    this.app = app;
  }

  /**
   * Makes a game available (`GET /games`, `createSession`). The main thread never sees a session
   * factory: workers import `module` (a URL, or a path resolved against the working directory),
   * which must export `game` and `sessionFactory` (docs/host.md 21). Without `opts.module`,
   * `HostOptions.gameModules[def.id]` is used; a game with neither fails at its first start
   * (`no_game_module`). A duplicate id throws.
   */
  registerGame(gameDef: RegisteredGameDef, opts: { module?: string | URL | undefined } = {}): void {
    if (this.games.has(gameDef.id)) {
      throw new Error(`Host.registerGame: game ${gameDef.id} is already registered`);
    }
    const module = opts.module ?? this.gameModules[gameDef.id];
    this.games.set(gameDef.id, {
      def: gameDef,
      module: module === undefined ? undefined : moduleUrl(module),
    });
  }

  /** Starts the HTTP server on `config.port` (0 picks a free port). */
  async listen(): Promise<{ port: number; url: string }> {
    if (this.server !== null) throw new Error('Host.listen: already listening');
    if (this.closing !== null) throw new Error('Host.listen: the host is closed');
    const server = createServer((req, res) => {
      void handle(this.app, req, res, (err) => this.logger.error('request failed', err));
    });
    server.on('upgrade', (req, socket, head: Buffer) =>
      this.gateway.handleUpgrade(req, socket, head),
    );
    server.keepAliveTimeout = 65_000;
    this.server = server;
    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(this.config.port, () => {
          server.off('error', rejectListen);
          resolveListen();
        });
      });
    } catch (err) {
      this.server = null;
      throw err;
    }
    server.on('error', (err) => this.logger.error('http server error', err));
    const port = (server.address() as AddressInfo).port;
    this.purgeTimer = setInterval(() => {
      try {
        this.service.purgeExpired();
      } catch (err) {
        this.logger.error('purging expired logins failed', err);
      }
    }, PURGE_INTERVAL_MS);
    this.purgeTimer.unref();
    if (this.handleSignals) this.installSignalHandlers();
    return { port, url: `http://127.0.0.1:${port}` };
  }

  /**
   * Graceful shutdown (docs/host.md 22), idempotent: stop accepting upgrades and HTTP connections,
   * close presence sockets with 4111, flush and stop every worker (their clients close with 4111),
   * let in-flight requests finish, then close the store.
   */
  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    this.gateway.stopAccepting();
    const server = this.server;
    const serverClosed =
      server === null
        ? Promise.resolve()
        : new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    server?.closeIdleConnections();
    this.presence.closeAll(SHUTDOWN_CLOSE.code, SHUTDOWN_CLOSE.reason);
    const failures: unknown[] = [];
    try {
      await this.sessions.shutdown(SHUTDOWN_CLOSE);
    } catch (err) {
      failures.push(err);
    }
    this.gateway.closeAll(SHUTDOWN_CLOSE.code, SHUTDOWN_CLOSE.reason);
    if (this.purgeTimer !== undefined) clearInterval(this.purgeTimer);
    this.purgeTimer = undefined;
    this.removeSignalHandlers?.();
    this.removeSignalHandlers = undefined;
    server?.closeAllConnections();
    await serverClosed;
    try {
      this.store.close();
    } catch (err) {
      failures.push(err);
    }
    if (failures.length > 0) throw failures[0];
  }

  private markIdle(sessionId: string): void {
    try {
      this.service.markIdle(sessionId);
    } catch (err) {
      this.logger.error(`[session ${sessionId}] marking the session idle failed`, err);
    }
  }

  private installSignalHandlers(): void {
    let signalled = false;
    const onSignal = (signal: NodeJS.Signals): void => {
      if (signalled) {
        process.exit(1);
      }
      signalled = true;
      this.logger.info(`${signal}: shutting down`);
      const deadline = setTimeout(() => {
        this.logger.error(`shutdown did not finish within ${SHUTDOWN_DEADLINE_MS} ms`);
        process.exit(1);
      }, SHUTDOWN_DEADLINE_MS);
      deadline.unref();
      this.close().then(
        () => process.exit(0),
        (err: unknown) => {
          this.logger.error('shutdown failed', err);
          process.exit(1);
        },
      );
    };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    this.removeSignalHandlers = () => {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
    };
  }
}
