import { DEFAULT_SESSION_CAPACITY, QUALIFIED_SESSION_CAPACITY } from '@conduit/protocol';
// The entry of a session worker (docs/host.md 21). Runs only inside a `worker_threads` Worker that
// `SessionManager` spawned; it has no exports.
import { parentPort, workerData } from 'node:worker_threads';
import { PortLink, Session, type SessionGameDef, type SessionLog } from '@conduit/net-server';
import { AUTOSAVE_INTERVAL_MS, Autosaver } from '@conduit/persist';
import { GATEWAY_CLOSE, TICK_STATS_INTERVAL_MS } from './constants.ts';
import { portLogger } from './logger.ts';
import type { MainToWorker, WorkerData, WorkerToMain } from './port-protocol.ts';
import { ProxyBlobStore } from './proxy-blob-store.ts';
import type { SessionFactory } from './session-manager.ts';

/** `CloseCode.ProtocolViolation` (docs/net.md A.3). */
const PROTOCOL_VIOLATION = 4003;

interface GameModule {
  game?: unknown;
  sessionFactory?: unknown;
  default?: { game?: unknown; sessionFactory?: unknown } | null;
}

const maybePort = parentPort;
if (maybePort === null) throw new Error('@conduit/host worker.ts only runs inside a Worker');
const port = maybePort;
const data = workerData as WorkerData;

function post(msg: WorkerToMain, transfer?: ArrayBuffer[]): void {
  port.postMessage(msg, transfer);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Posts `fatal` and exits non-zero: the main thread treats the exit as a failed start or a crash. */
function fatal(err: unknown): never {
  const error: { message: string; stack?: string } = { message: messageOf(err) };
  if (err instanceof Error && err.stack !== undefined) error.stack = err.stack;
  try {
    post({ t: 'fatal', error });
  } catch {
    // The port is gone; the exit code still tells.
  }
  process.exit(1);
}

process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

const logger = portLogger(port, data.logLevel);
const store = new ProxyBlobStore(port);
const links = new Map<number, PortLink>();
let session: Session | null = null;
let statsTimer: ReturnType<typeof setInterval> | undefined;
let shuttingDown = false;

async function flush(reqId: number): Promise<void> {
  if (session === null) {
    post({ t: 'flushed', reqId, ok: false, error: 'the session has not started' });
    return;
  }
  try {
    await session.flushAll();
    post({ t: 'flushed', reqId, ok: true });
  } catch (err) {
    post({ t: 'flushed', reqId, ok: false, error: messageOf(err) });
  }
}

/**
 * `shutdown`: every client is closed with the given code (the main thread closes the sockets), then
 * `session.stop()` stops the loop and makes the autosaver's final save, the only shutdown save
 * (docs/net.md A.5). Exits 0, or 1 when that save failed.
 */
async function shutdown(code: number, reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (statsTimer !== undefined) clearInterval(statsTimer);
  for (const link of links.values()) link.close(code, reason);
  let exitCode = 0;
  try {
    await session?.stop();
  } catch (err) {
    logger.error('the final save failed', err);
    exitCode = 1;
  }
  if (session?.fault !== null && session?.fault !== undefined) fatal(session.fault);
  process.exit(exitCode);
}

/** One inbound frame to its link; a throw while handling it closes that client only. */
function deliver(clientId: number, buf: ArrayBuffer): void {
  const link = links.get(clientId);
  if (link === undefined) return;
  try {
    link.deliver(new Uint8Array(buf));
  } catch (err) {
    logger.error(`client ${clientId}: frame handling failed`, err);
    link.close(PROTOCOL_VIOLATION, 'protocol violation');
  }
}

function route(msg: MainToWorker): void {
  switch (msg.t) {
    case 'storeResult':
      store.handleResult(msg);
      return;
    case 'attach': {
      if (session === null || shuttingDown) {
        post({
          t: 'close',
          clientId: msg.clientId,
          code: GATEWAY_CLOSE.SESSION_NOT_RUNNING,
          reason: 'session not running',
        });
        return;
      }
      if (links.has(msg.clientId)) {
        logger.warn(`client ${msg.clientId} attached twice; ignored`);
        return;
      }
      const link = new PortLink(msg.clientId, port);
      links.set(msg.clientId, link);
      try {
        session.attach(link, msg.identity, { tokenExpired: msg.tokenExpired });
        link.deliver(new Uint8Array(msg.helloFrame));
      } catch (err) {
        logger.error(`client ${msg.clientId}: attach failed`, err);
        link.close(PROTOCOL_VIOLATION, 'attach failed');
      }
      return;
    }
    case 'frame':
      deliver(msg.clientId, msg.buf);
      return;
    case 'closed': {
      const link = links.get(msg.clientId);
      if (link === undefined) return;
      links.delete(msg.clientId);
      link.handleClosed(msg.code, msg.reason);
      return;
    }
    case 'stats':
      for (const [clientId, buffered] of msg.entries) links.get(clientId)?.reportBuffered(buffered);
      return;
    case 'flush':
      void flush(msg.reqId);
      return;
    case 'shutdown':
      void shutdown(msg.code, msg.reason);
      return;
  }
}

// The router comes first: loading the session already needs store answers.
port.on('message', route);

try {
  const mod = (await import(data.gameModule)) as GameModule;
  const game = (mod.game ?? mod.default?.game) as SessionGameDef | undefined;
  const sessionFactory = (mod.sessionFactory ?? mod.default?.sessionFactory) as
    SessionFactory | undefined;
  if (game === undefined || game === null || typeof sessionFactory !== 'function') {
    throw new Error(`game module ${data.gameModule} must export game and sessionFactory`);
  }
  if (game.id !== data.gameId) {
    throw new Error(`game module ${data.gameModule} exports game ${game.id}, not ${data.gameId}`);
  }
  const configuredCapacity = data.maxPlayers ?? DEFAULT_SESSION_CAPACITY;
  if (
    !Number.isInteger(configuredCapacity) ||
    configuredCapacity < 1 ||
    configuredCapacity > QUALIFIED_SESSION_CAPACITY
  )
    throw new Error('worker capacity configuration is outside qualified limits');
  // One log for the Session and the game's hooks (their ServerContext.log): through the port.
  const log: SessionLog = (level, msg, extra) => logger[level](msg, extra);
  const { regionLoader, hooks, ...persistence } = sessionFactory(data.sessionId, {
    log,
    maxPlayers: configuredCapacity,
  });
  if (persistence.maxPlayers !== undefined && persistence.maxPlayers !== configuredCapacity)
    throw new Error(
      `sessionFactory capacity ${persistence.maxPlayers} differs from configured lobby capacity ${configuredCapacity}`,
    );
  const started = new Session(game, {
    ...persistence,
    maxPlayers: configuredCapacity,
    sessionId: data.sessionId,
    store,
    regionLoader,
    hooks,
    log,
    onFault: (fault) => {
      logger.error('authoritative session fault', fault);
      post({
        t: 'fatal',
        error: {
          message: fault.message,
          ...(fault.stack === undefined ? {} : { stack: fault.stack }),
        },
      });
      // A worker hosts exactly one session. Fatal reporting removes it from admission and health.
      void shutdown(GATEWAY_CLOSE.SESSION_NOT_RUNNING, 'session faulted').then(() => fatal(fault));
    },
    // Its final save, made by session.stop(), is the only save on shutdown (docs/host.md 21).
    autosaver: (save) =>
      new Autosaver(save, AUTOSAVE_INTERVAL_MS, {
        onError: (err) => logger.error('autosave failed', err),
      }),
  });
  if (started.capacity !== configuredCapacity)
    throw new Error('constructed Session capacity differs from configured lobby capacity');
  await started.start();
  session = started;
  statsTimer = setInterval(
    () => post({ t: 'tickStats', stats: started.tickStats() }),
    TICK_STATS_INTERVAL_MS,
  );
  post({ t: 'ready' });
} catch (err) {
  fatal(err);
}
