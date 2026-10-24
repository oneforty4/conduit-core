/** `PORT` default (docs/host.md 15, 16). */
export const DEFAULT_PORT = 8080;
/** `DB_PATH` default. */
export const DEFAULT_DB_PATH = './conduit.sqlite';
/** A running session with no attached game socket for this long is stopped (`IDLE_TIMEOUT_MS`). */
export const IDLE_TIMEOUT_MS = 300_000;
/** A worker must post `ready` within this after it was spawned. */
export const WORKER_READY_TIMEOUT_MS = 10_000;
/** A stopping worker is terminated when it has not exited this long after `shutdown`. */
export const SHUTDOWN_GRACE_MS = 5_000;
/** `SessionManager.flushAll` gives each worker this long to answer `flushed`. */
export const FLUSH_TIMEOUT_MS = 10_000;
/** The CLI's signal handler exits 1 when a graceful shutdown takes longer than this. */
export const SHUTDOWN_DEADLINE_MS = 15_000;
/** Period of the main thread's `stats` message (socket `bufferedAmount`) to each worker. */
export const STATS_INTERVAL_MS = 100;
/** Period of each worker's `tickStats` message. */
export const TICK_STATS_INTERVAL_MS = 1_000;
/** A game socket must send its Hello within this after the upgrade. */
export const HELLO_TIMEOUT_MS = 5_000;
/** `ws` `maxPayload` for `/session` sockets. */
export const MAX_CLIENT_FRAME_BYTES = 65_536;
/**
 * Main-thread safety net: a game socket buffering more than this is closed with `SLOW_CLIENT`. The
 * Session's 64 KB snapshot skip rule (docs/net.md A.10) is the primary control.
 */
export const MAX_SOCKET_BUFFERED_BYTES = 1_048_576;
/** `ws` `maxPayload` for `/lobby` sockets. */
export const MAX_PRESENCE_MESSAGE_BYTES = 4_096;

/**
 * WebSocket close codes of the gateway, SessionManager and presence hub (docs/host.md 17). The
 * Session's own codes are 4000-4099 (docs/net.md A.3); net-client reconnects after 4110 and 4111.
 */
export const GATEWAY_CLOSE = Object.freeze({
  BAD_TOKEN: 4101,
  TOKEN_EXPIRED: 4102,
  SESSION_MISMATCH: 4103,
  SESSION_NOT_RUNNING: 4104,
  LEFT: 4105,
  SESSION_DELETED: 4106,
  HELLO_TIMEOUT: 4107,
  BAD_FRAME: 4108,
  NOT_MEMBER: 4109,
  WORKER_CRASHED: 4110,
  SHUTTING_DOWN: 4111,
  SLOW_CLIENT: 4112,
} as const);
export type GatewayCloseCode = (typeof GATEWAY_CLOSE)[keyof typeof GATEWAY_CLOSE];
