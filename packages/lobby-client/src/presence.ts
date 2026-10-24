import type {
  LobbyEvent,
  PresenceClientMessage,
  PublicAccount,
  SessionSummary,
} from '@conduit/lobby';

/** `'connecting'` covers a socket being opened and the wait before a reconnect attempt. */
export type PresenceState = 'connecting' | 'open' | 'closed';

/** Listener signatures for `PresenceConnection.on` (docs/host.md §13). */
export interface PresenceEvents {
  /** Every server message except `pong`, before its typed event. */
  event: (ev: LobbyEvent) => void;
  friends: (online: string[]) => void;
  session: (s: SessionSummary) => void;
  invite: (s: SessionSummary, from: PublicAccount) => void;
  open: () => void;
  /** `willRetry`: a reconnect attempt is scheduled. */
  close: (code: number, willRetry: boolean) => void;
  /** A socket `error` event, a malformed server message, or a failed reconnect attempt. */
  error: (err: unknown) => void;
}

export const PRESENCE_PING_INTERVAL_MS = 25_000;
export const PRESENCE_BACKOFF_MIN_MS = 1_000;
export const PRESENCE_BACKOFF_MAX_MS = 30_000;

/** Each reconnect waits the backoff times a uniform factor in [1 - JITTER, 1 + JITTER). */
const BACKOFF_JITTER = 0.2;
/** Close code meaning the login cookie is no longer valid: no retry (docs/host.md §13). */
const CLOSE_UNAUTHORIZED = 4101;
const WS_OPEN = 1;

export interface PresenceConnectionOptions {
  /** The presence socket URL: `wsUrlFor(baseUrl, '/lobby')`. */
  url: string;
  WebSocket: typeof WebSocket;
  /**
   * Manual cookie mode: the `Cookie` header value (`conduit_sid=<v>`) for each connection attempt,
   * or `null` for none. With a value the socket is created as
   * `new WebSocket(url, { headers: { Cookie } })` (undici's option in Node); otherwise as
   * `new WebSocket(url)`, and a browser attaches its own cookies.
   */
  cookie?: () => string | null;
}

/** The members of a WHATWG `WebSocket` this file uses. */
interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (ev: { readonly data: unknown }) => void): void;
  addEventListener(type: 'close', listener: (ev: { readonly code: number }) => void): void;
  addEventListener(type: 'error', listener: (ev: unknown) => void): void;
}

type SocketConstructor = new (
  url: string,
  init?: { headers: Record<string, string> },
) => SocketLike;

type AnyListener = (...args: never[]) => void;

/**
 * The `/lobby` presence socket (docs/host.md §7, §13). It says `hello` on every open, pings every
 * `PRESENCE_PING_INTERVAL_MS`, dispatches server events, and reconnects after any close except a
 * `close()` call or code 4101, waiting `PRESENCE_BACKOFF_MIN_MS` doubling up to
 * `PRESENCE_BACKOFF_MAX_MS` (±20% jitter; an open resets it). `LobbyClient.connectPresence()`
 * creates it.
 */
export class PresenceConnection {
  private readonly url: string;
  private readonly Socket: SocketConstructor;
  private readonly cookie: (() => string | null) | undefined;
  private readonly listeners = new Map<keyof PresenceEvents, readonly AnyListener[]>();
  private current: PresenceState = 'connecting';
  /** The socket of the current attempt; kept after `close()` until its close event. */
  private socket: SocketLike | null = null;
  /** The last reconnect backoff; 0 until a close after the last open. */
  private backoffMs = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;

  /** Starts connecting at once. Throws what the `WebSocket` constructor throws (e.g. a bad URL). */
  constructor(opts: PresenceConnectionOptions) {
    if (typeof opts.WebSocket !== 'function') {
      throw new TypeError('PresenceConnection: WebSocket must be a constructor');
    }
    this.url = opts.url;
    this.Socket = opts.WebSocket as unknown as SocketConstructor;
    this.cookie = opts.cookie;
    this.connect(true);
  }

  get state(): PresenceState {
    return this.current;
  }

  /**
   * Adds a listener; the returned function removes it (idempotent). Listeners run in registration
   * order; one that throws does not stop the others, and its error is rethrown in a microtask.
   */
  on<K extends keyof PresenceEvents>(event: K, cb: PresenceEvents[K]): () => void {
    const listener: AnyListener = cb;
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const list = this.listeners.get(event) ?? [];
      const i = list.indexOf(listener);
      if (i >= 0) this.listeners.set(event, [...list.slice(0, i), ...list.slice(i + 1)]);
    };
  }

  /**
   * Stops for good: clears the timers and closes the socket with 1000. Its close event still
   * reaches `close` listeners with `willRetry` false; nothing else is dispatched.
   */
  close(): void {
    if (this.current === 'closed') return;
    this.current = 'closed';
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.stopPing();
    try {
      this.socket?.close(1000);
    } catch {
      // Closing an already failed socket; its close event (if any) still arrives.
    }
  }

  private connect(first: boolean): void {
    if (this.current === 'closed') return;
    let socket: SocketLike;
    try {
      const cookie = this.cookie?.() ?? null;
      socket =
        cookie === null
          ? new this.Socket(this.url)
          : new this.Socket(this.url, { headers: { Cookie: cookie } });
    } catch (err) {
      if (first) throw err;
      this.emit('error', err);
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.addEventListener('open', () => this.handleOpen(socket));
    socket.addEventListener('message', (ev) => this.handleMessage(socket, ev.data));
    socket.addEventListener('close', (ev) => this.handleClose(socket, ev.code));
    socket.addEventListener('error', (ev) => {
      if (socket === this.socket && this.current !== 'closed') this.emit('error', ev);
    });
  }

  private handleOpen(socket: SocketLike): void {
    if (socket !== this.socket || this.current === 'closed') return;
    this.current = 'open';
    this.backoffMs = 0;
    this.send(socket, { t: 'hello' });
    // A send error listener may close the connection synchronously.
    if (socket !== this.socket || this.state !== 'open') return;
    this.pingTimer = setInterval(() => this.send(socket, { t: 'ping' }), PRESENCE_PING_INTERVAL_MS);
    this.emit('open');
  }

  private handleMessage(socket: SocketLike, data: unknown): void {
    if (socket !== this.socket || this.current === 'closed') return;
    const ev = parseEvent(data);
    if (ev instanceof Error) {
      this.emit('error', ev);
      return;
    }
    if (ev === null || ev.t === 'pong') return;
    this.emit('event', ev);
    if (socket !== this.socket || this.state === 'closed') return;
    if (ev.t === 'friends') this.emit('friends', ev.online);
    else if (ev.t === 'session') this.emit('session', ev.session);
    else this.emit('invite', ev.session, ev.from);
  }

  private handleClose(socket: SocketLike, code: number): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.stopPing();
    const willRetry = this.current !== 'closed' && code !== CLOSE_UNAUTHORIZED;
    if (willRetry) {
      this.current = 'connecting';
      this.scheduleRetry();
    } else {
      this.current = 'closed';
    }
    this.emit('close', code, willRetry);
  }

  private scheduleRetry(): void {
    // A failed reconnect emits an error before reaching this point; listeners may stop it.
    if (this.current === 'closed') return;
    this.backoffMs =
      this.backoffMs === 0
        ? PRESENCE_BACKOFF_MIN_MS
        : Math.min(PRESENCE_BACKOFF_MAX_MS, this.backoffMs * 2);
    const factor = 1 - BACKOFF_JITTER + 2 * BACKOFF_JITTER * Math.random();
    const delayMs = Math.round(this.backoffMs * factor);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connect(false);
    }, delayMs);
  }

  private stopPing(): void {
    clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private send(socket: SocketLike, msg: PresenceClientMessage): void {
    if (socket.readyState !== WS_OPEN) return;
    try {
      socket.send(JSON.stringify(msg));
    } catch (err) {
      this.emit('error', err);
    }
  }

  private emit<K extends keyof PresenceEvents>(
    event: K,
    ...args: Parameters<PresenceEvents[K]>
  ): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        (listener as (...a: Parameters<PresenceEvents[K]>) => void)(...args);
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }
}

/**
 * A server message as a `LobbyEvent`: `null` for a well-formed message of a type this client does
 * not know (a newer lobby), an `Error` for a malformed one.
 */
function parseEvent(data: unknown): LobbyEvent | null | Error {
  if (typeof data !== 'string') return new TypeError('presence: expected a text message');
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch (err) {
    return err instanceof Error ? err : new SyntaxError(String(err));
  }
  if (!isRecord(msg) || typeof msg.t !== 'string') {
    return new TypeError('presence: a message must be an object with a string t');
  }
  switch (msg.t) {
    case 'pong':
      return msg as LobbyEvent;
    case 'friends':
      return Array.isArray(msg.online) && msg.online.every((id) => typeof id === 'string')
        ? (msg as LobbyEvent)
        : malformed(msg.t);
    case 'session':
      return isRecord(msg.session) ? (msg as unknown as LobbyEvent) : malformed(msg.t);
    case 'invite':
      return isRecord(msg.session) && isRecord(msg.from)
        ? (msg as unknown as LobbyEvent)
        : malformed(msg.t);
    default:
      return null;
  }
}

function malformed(t: string): TypeError {
  return new TypeError(`presence: malformed '${t}' message`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
