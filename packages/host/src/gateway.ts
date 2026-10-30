import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { isTokenExpired, verifyToken } from '@conduit/auth';
import {
  type Account,
  COOKIE_NAME,
  type LobbyService,
  parseCookies,
  type PresenceHub,
  type PresenceSocket,
  ULID_RE,
} from '@conduit/lobby';
import {
  CoreKind,
  decodeWith,
  encodeWith,
  FrameWriter,
  type HelloPayload,
  HelloSchema,
  readFrame,
  RejectedSchema,
  RejectReason,
} from '@conduit/protocol';
import { type WsCompressionOptions, wsPerMessageDeflate } from '@conduit/net-server';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import {
  GATEWAY_CLOSE,
  HELLO_TIMEOUT_MS,
  MAX_CLIENT_FRAME_BYTES,
  MAX_PRESENCE_MESSAGE_BYTES,
} from './constants.ts';
import type { Logger } from './logger.ts';
import { closeSocket, type GatewayClient } from './session-manager.ts';

export { GATEWAY_CLOSE } from './constants.ts';

export interface GatewayOptions {
  /** `HOST_SECRET`: verifies the session tokens. */
  secret: string;
  service: Pick<LobbyService, 'authenticate' | 'isMember'>;
  presence: Pick<PresenceHub, 'attach'>;
  sessions: {
    isRunning(sessionId: string): boolean;
    attach(sessionId: string, client: GatewayClient): void;
  };
  logger: Logger;
  /** Unix ms; default `Date.now`. Token expiry is checked against it. */
  now?: (() => number) | undefined;
  /** The Hello timer; default the globals. */
  setTimeout?: ((fn: () => void, ms: number) => unknown) | undefined;
  clearTimeout?: ((handle: unknown) => void) | undefined;
  /**
   * permessage-deflate on game sockets (net-server's `wsPerMessageDeflate`, docs/net.md A.2):
   * `true` for `DEFAULT_WS_COMPRESSION`, or options. Default `false`. Presence sockets never are.
   */
  compression?: boolean | WsCompressionOptions | undefined;
}

const SESSION_PATH_RE = /^\/session\/([^/]+)$/;

/** Process-wide game socket ids: a u32 counter from 1, never reused. */
let nextClientId = 1;

function takeClientId(): number {
  const id = nextClientId;
  nextClientId = nextClientId >= 0xffff_ffff ? 1 : nextClientId + 1;
  return id;
}

/**
 * The Hello of a frame that holds exactly one message, a Hello (docs/host.md 17). Throws for
 * anything else: a frame that does not decode (`DecodeError`), another message count or kind, or a
 * payload that does not decode as `HelloSchema`.
 */
export function readHello(buf: Uint8Array): HelloPayload {
  let count = 0;
  let hello: HelloPayload | undefined;
  readFrame(buf, (header, payload) => {
    count++;
    if (count === 1 && header.kind === CoreKind.Hello) hello = decodeWith(payload, HelloSchema);
  });
  if (count !== 1 || hello === undefined) throw new Error('expected a frame holding one Hello');
  return hello;
}

function bytesOf(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Answers an upgrade request with a plain HTTP status and closes the raw socket. */
function refuse(socket: Duplex, status: number, text: string): void {
  if (socket.destroyed) return;
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * The main thread's WebSocket front door (docs/host.md 17): upgrades `/lobby` (presence, cookie
 * login) and `/session/:id` (game sockets). A game socket must send its Hello first; the gateway
 * verifies its token and membership and hands the socket to the session's worker, or sends
 * `Rejected` and closes with a `GATEWAY_CLOSE` code.
 */
export class Gateway {
  private readonly secret: string;
  private readonly service: GatewayOptions['service'];
  private readonly presence: GatewayOptions['presence'];
  private readonly sessions: GatewayOptions['sessions'];
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly sessionServer: WebSocketServer;
  private readonly presenceServer = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_PRESENCE_MESSAGE_BYTES,
  });
  private readonly writer = new FrameWriter();
  private isAccepting = true;

  constructor(opts: GatewayOptions) {
    this.sessionServer = new WebSocketServer({
      noServer: true,
      perMessageDeflate: wsPerMessageDeflate(opts.compression),
      maxPayload: MAX_CLIENT_FRAME_BYTES,
    });
    this.secret = opts.secret;
    this.service = opts.service;
    this.presence = opts.presence;
    this.sessions = opts.sessions;
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      opts.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** False after `stopAccepting()`. */
  get accepting(): boolean {
    return this.isAccepting;
  }

  /** New upgrades are refused with 503 from now on. */
  stopAccepting(): void {
    this.isAccepting = false;
  }

  /** Bound to the HTTP server's `upgrade` event. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', (err) => this.logger.debug('upgrade socket error', err));
    if (!this.isAccepting) {
      refuse(socket, 503, 'Service Unavailable');
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      refuse(socket, 404, 'Not Found');
      return;
    }
    if (pathname === '/lobby') {
      this.upgradeLobby(req, socket, head);
      return;
    }
    const sessionId = SESSION_PATH_RE.exec(pathname)?.[1];
    if (sessionId !== undefined && ULID_RE.test(sessionId)) {
      // Always accepted for a well-formed path, so the client gets a decodable Rejected.
      this.sessionServer.handleUpgrade(req, socket, head, (ws) => this.awaitHello(ws, sessionId));
      return;
    }
    refuse(socket, 404, 'Not Found');
  }

  /** Closes every socket the gateway upgraded and still tracks. */
  closeAll(code: number, reason: string): void {
    for (const ws of [...this.sessionServer.clients, ...this.presenceServer.clients]) {
      closeSocket(ws, code, reason);
    }
  }

  private upgradeLobby(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    let account: Account | null;
    try {
      account = this.service.authenticate(parseCookies(req.headers.cookie).get(COOKIE_NAME));
    } catch (err) {
      this.logger.error('presence authentication failed', err);
      refuse(socket, 500, 'Internal Server Error');
      return;
    }
    if (account === null) {
      refuse(socket, 401, 'Unauthorized');
      return;
    }
    const owner = account;
    this.presenceServer.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', (err) => this.logger.debug('presence socket error', err));
      this.presence.attach(ws as unknown as PresenceSocket, owner);
    });
  }

  private awaitHello(ws: WebSocket, sessionId: string): void {
    ws.on('error', (err) => this.logger.debug('game socket error', err));
    let settled = false;
    const timer = this.setTimer(() => {
      if (settled) return;
      settled = true;
      this.reject(ws, GATEWAY_CLOSE.HELLO_TIMEOUT, RejectReason.BadToken, 'hello timeout');
    }, HELLO_TIMEOUT_MS);
    ws.once('close', () => {
      settled = true;
      this.clearTimer(timer);
    });
    ws.once('message', (data, isBinary) => {
      if (settled) return;
      settled = true;
      this.clearTimer(timer);
      this.checkHello(ws, sessionId, data, isBinary);
    });
  }

  /** The Hello check of docs/host.md 17, in order; synchronous up to `sessions.attach`. */
  private checkHello(ws: WebSocket, sessionId: string, data: RawData, isBinary: boolean): void {
    let bytes: Uint8Array;
    let hello: HelloPayload;
    try {
      if (!isBinary) throw new Error('text frame');
      bytes = bytesOf(data);
      hello = readHello(bytes);
    } catch {
      this.reject(ws, GATEWAY_CLOSE.BAD_FRAME, RejectReason.ProtocolVersion, 'expected Hello');
      return;
    }
    const now = Math.floor(this.now() / 1000);
    // Signature and shape first; an expired token only passes for a reconnect (docs/host.md 17).
    const identity = verifyToken(hello.sessionToken, this.secret, now, { allowExpired: true });
    if (identity === null) {
      this.reject(ws, GATEWAY_CLOSE.BAD_TOKEN, RejectReason.BadToken, 'bad token');
      return;
    }
    const tokenExpired = isTokenExpired(identity, now);
    if (tokenExpired && hello.reconnectToken === '') {
      this.reject(ws, GATEWAY_CLOSE.TOKEN_EXPIRED, RejectReason.BadToken, 'token expired');
      return;
    }
    if (identity.sessionId !== sessionId) {
      const detail = 'token is for another session';
      this.reject(ws, GATEWAY_CLOSE.SESSION_MISMATCH, RejectReason.BadToken, detail);
      return;
    }
    if (!this.service.isMember(sessionId, identity.accountId)) {
      this.reject(ws, GATEWAY_CLOSE.NOT_MEMBER, RejectReason.BadToken, 'not a member');
      return;
    }
    if (!this.sessions.isRunning(sessionId)) {
      const detail = 'session not running';
      this.reject(ws, GATEWAY_CLOSE.SESSION_NOT_RUNNING, RejectReason.SessionNotRunning, detail);
      return;
    }
    this.sessions.attach(sessionId, {
      ws,
      clientId: takeClientId(),
      identity,
      helloFrame: new Uint8Array(bytes).buffer,
      tokenExpired,
    });
  }

  /** One frame holding `Rejected{reason, detail}`, then a close with `code` and `detail`. */
  private reject(ws: WebSocket, code: number, reason: RejectReason, detail: string): void {
    const fw = this.writer;
    fw.begin();
    fw.message(CoreKind.Rejected, 0, 0, (w) => encodeWith(w, RejectedSchema, { reason, detail }));
    ws.send(fw.finish());
    closeSocket(ws, code, detail);
  }
}
