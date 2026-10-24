import type { LobbyEvent, PublicAccount } from './api.ts';
import type { EventSink, LobbyService } from './service.ts';

/** The subset of a `ws` WebSocket the hub uses (structural, so `ws` is not a dependency). */
export interface PresenceSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping?(): void;
  on(event: 'message', cb: (data: unknown, isBinary: boolean) => void): void;
  on(event: 'close', cb: (code: number) => void): void;
  on(event: 'pong' | 'error', cb: () => void): void;
}

/** Clock and timers, injectable for tests; default the globals. */
export interface PresenceHubOptions {
  now?: () => number;
  setTimeout?(callback: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
  setInterval?(callback: () => void, ms: number): unknown;
  clearInterval?(handle: unknown): void;
}

export const HELLO_TIMEOUT_MS = 5_000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TIMEOUT_MS = 60_000;
export const MAX_PRESENCE_MESSAGE_BYTES = 4_096;

/** docs/host.md section 17 close codes. */
const CLOSE_HELLO_TIMEOUT = 4107;
const CLOSE_BAD_MESSAGE = 4108;

const PONG = JSON.stringify({ t: 'pong' } satisfies LobbyEvent);
const UTF8 = new TextDecoder('utf-8', { fatal: true });

interface Connection {
  readonly socket: PresenceSocket;
  readonly accountId: string;
  helloed: boolean;
  lastSeen: number;
  helloTimer: unknown;
  /** False once removed from the hub (closed by either side). */
  attached: boolean;
}

/**
 * Owns the `/lobby` presence sockets (docs/host.md section 7) and is the service's `EventSink`.
 * The host authenticates the upgrade and hands over the socket with `attach`. A connection must
 * send `hello` within HELLO_TIMEOUT_MS; only helloed connections count as online and receive
 * events. One heartbeat interval runs while any connection is attached.
 */
export class PresenceHub implements EventSink {
  private readonly service: LobbyService;
  private readonly opts: PresenceHubOptions;
  private readonly conns = new Map<string, Set<Connection>>();
  private heartbeat: unknown = null;

  constructor(service: LobbyService, opts: PresenceHubOptions = {}) {
    this.service = service;
    this.opts = opts;
  }

  /** Takes over an authenticated socket for `account`. */
  attach(socket: PresenceSocket, account: PublicAccount): void {
    const conn: Connection = {
      socket,
      accountId: account.id,
      helloed: false,
      lastSeen: this.now(),
      helloTimer: null,
      attached: true,
    };
    let accountConns = this.conns.get(account.id);
    if (accountConns === undefined) {
      accountConns = new Set();
      this.conns.set(account.id, accountConns);
    }
    accountConns.add(conn);
    conn.helloTimer = this.setTimeout(() => {
      conn.helloTimer = null;
      this.guard(() => {
        if (conn.attached && !conn.helloed) {
          this.closeConnection(conn, CLOSE_HELLO_TIMEOUT, 'hello_timeout');
        }
      });
    }, HELLO_TIMEOUT_MS);
    socket.on('message', (data, isBinary) =>
      this.guard(() => this.handleMessage(conn, data, isBinary)),
    );
    socket.on('pong', () => {
      if (conn.attached) conn.lastSeen = this.now();
    });
    socket.on('close', () => this.guard(() => this.remove(conn)));
    socket.on('error', () => this.guard(() => this.remove(conn)));
    this.startHeartbeat();
  }

  /** Sends `event` to every helloed connection of each recipient. Send errors are ignored. */
  emit(recipients: string[], event: LobbyEvent): void {
    let payload: string | null = null;
    for (const accountId of new Set(recipients)) {
      for (const conn of this.conns.get(accountId) ?? []) {
        if (!conn.helloed) continue;
        payload ??= JSON.stringify(event);
        sendQuietly(conn.socket, payload);
      }
    }
  }

  /** Accounts with at least one helloed connection. */
  online(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const accountId of this.conns.keys()) {
      if (this.isOnline(accountId)) ids.add(accountId);
    }
    return ids;
  }

  /** Attached connections (helloed or not) of one account, or of all accounts. */
  connections(accountId?: string): number {
    if (accountId !== undefined) return this.conns.get(accountId)?.size ?? 0;
    let total = 0;
    for (const accountConns of this.conns.values()) total += accountConns.size;
    return total;
  }

  /** Closes every socket with `code`/`reason` (host shutdown: 4111) and forgets them. */
  closeAll(code: number, reason: string): void {
    const all = [...this.conns.values()].flatMap((accountConns) => [...accountConns]);
    this.conns.clear();
    this.stopHeartbeat();
    for (const conn of all) {
      conn.attached = false;
      this.clearHelloTimer(conn);
      closeQuietly(conn.socket, code, reason);
    }
  }

  private handleMessage(conn: Connection, data: unknown, isBinary: boolean): void {
    if (!conn.attached) return;
    const message = isBinary ? null : parseClientMessage(data);
    if (message === null) {
      this.closeConnection(conn, CLOSE_BAD_MESSAGE, 'bad_message');
      return;
    }
    conn.lastSeen = this.now();
    if (message.t === 'hello') {
      this.clearHelloTimer(conn);
      const cameOnline = !conn.helloed && !this.isOnline(conn.accountId);
      conn.helloed = true;
      sendQuietly(conn.socket, JSON.stringify(this.friendsSnapshot(conn.accountId)));
      if (cameOnline) this.notifyFriends(conn.accountId);
    } else if (message.t === 'ping') {
      sendQuietly(conn.socket, PONG);
    }
    // Any other `t` is ignored, so newer clients can talk to older hosts.
  }

  /** Removes the connection; when its account just went offline, tells its online friends. */
  private remove(conn: Connection): void {
    if (!conn.attached) return;
    conn.attached = false;
    this.clearHelloTimer(conn);
    const accountConns = this.conns.get(conn.accountId);
    if (accountConns !== undefined) {
      accountConns.delete(conn);
      if (accountConns.size === 0) this.conns.delete(conn.accountId);
    }
    if (this.conns.size === 0) this.stopHeartbeat();
    if (conn.helloed && !this.isOnline(conn.accountId)) this.notifyFriends(conn.accountId);
  }

  /** Closes first, so a failure while notifying friends cannot leave the socket open. */
  private closeConnection(conn: Connection, code: number, reason: string): void {
    closeQuietly(conn.socket, code, reason);
    this.remove(conn);
  }

  private isOnline(accountId: string): boolean {
    for (const conn of this.conns.get(accountId) ?? []) {
      if (conn.helloed) return true;
    }
    return false;
  }

  private friendsSnapshot(accountId: string, online = this.online()): LobbyEvent {
    return {
      t: 'friends',
      online: this.service.friendIds(accountId).filter((id) => online.has(id)),
    };
  }

  /** Sends each online accepted friend of `accountId` their refreshed snapshot. */
  private notifyFriends(accountId: string): void {
    const online = this.online();
    for (const friendId of this.service.friendIds(accountId)) {
      if (online.has(friendId)) this.emit([friendId], this.friendsSnapshot(friendId, online));
    }
  }

  private heartbeatTick(): void {
    const now = this.now();
    for (const accountConns of [...this.conns.values()]) {
      for (const conn of [...accountConns]) {
        if (!conn.attached) continue;
        if (now - conn.lastSeen > HEARTBEAT_TIMEOUT_MS) {
          this.guard(() => this.remove(conn));
          try {
            conn.socket.terminate();
          } catch {
            // Already gone.
          }
        } else {
          try {
            conn.socket.ping?.();
          } catch {
            // The close handler cleans up.
          }
        }
      }
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeat !== null) return;
    const callback = () => this.guard(() => this.heartbeatTick());
    this.heartbeat = this.opts.setInterval
      ? this.opts.setInterval(callback, HEARTBEAT_INTERVAL_MS)
      : unref(setInterval(callback, HEARTBEAT_INTERVAL_MS));
  }

  private stopHeartbeat(): void {
    if (this.heartbeat === null) return;
    if (this.opts.clearInterval) this.opts.clearInterval(this.heartbeat);
    else clearInterval(this.heartbeat as ReturnType<typeof setInterval>);
    this.heartbeat = null;
  }

  private clearHelloTimer(conn: Connection): void {
    if (conn.helloTimer === null) return;
    if (this.opts.clearTimeout) this.opts.clearTimeout(conn.helloTimer);
    else clearTimeout(conn.helloTimer as ReturnType<typeof setTimeout>);
    conn.helloTimer = null;
  }

  private setTimeout(callback: () => void, ms: number): unknown {
    return this.opts.setTimeout ? this.opts.setTimeout(callback, ms) : setTimeout(callback, ms);
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** Socket callbacks run inside `ws`'s emitter: an exception there must not crash the host. */
  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      console.error('[conduit/lobby] presence handler failed:', err);
    }
  }
}

/** A client message with a string `t`, or `null` for anything else (including oversize data). */
function parseClientMessage(data: unknown): { t: string } | null {
  const text = messageText(data);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const t: unknown = (parsed as { t?: unknown }).t;
  return typeof t === 'string' ? { t } : null;
}

/** Decodes the text of a message as `ws` delivers it (Buffer, ArrayBuffer or fragments) or a string. */
function messageText(data: unknown): string | null {
  if (typeof data === 'string') {
    return Buffer.byteLength(data, 'utf8') > MAX_PRESENCE_MESSAGE_BYTES ? null : data;
  }
  let bytes: Uint8Array;
  if (data instanceof Uint8Array) bytes = data;
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (Array.isArray(data) && data.every(isUint8Array)) bytes = Buffer.concat(data);
  else return null;
  if (bytes.byteLength > MAX_PRESENCE_MESSAGE_BYTES) return null;
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

function sendQuietly(socket: PresenceSocket, payload: string): void {
  try {
    socket.send(payload);
  } catch {
    // The close handler cleans up.
  }
}

function closeQuietly(socket: PresenceSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Already closed.
  }
}

/** Lets the process exit while only the heartbeat is pending. */
function unref<T>(handle: T): T {
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
    const { unref: fn } = handle;
    if (typeof fn === 'function') fn.call(handle);
  }
  return handle;
}
