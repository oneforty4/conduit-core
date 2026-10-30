import type { Server as HttpServer } from 'node:http';
import { MAX_FRAME_BYTES } from '@conduit/protocol';
import { type PerMessageDeflateOptions, type RawData, WebSocket, WebSocketServer } from 'ws';
import { CloseCode, WS_CLOSE_TIMEOUT_MS } from './constants.ts';
import { QueuedLinkBase } from './link.ts';

/** Abnormal closure: no close frame was received (a socket that was already closed). */
const CLOSE_ABNORMAL = 1006;
/** RFC 6455 limits the close reason to 123 bytes of UTF-8. */
const MAX_CLOSE_REASON_BYTES = 123;

export interface WsLinkOptions {
  /** Receives socket `error` events (ws closes the socket itself afterwards). Default `console.warn`. */
  log?: ((level: 'warn' | 'error', msg: string, data?: unknown) => void) | undefined;
}

function toBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** A `ClientLink` over a `ws` socket (docs/net.md A.2). */
export class WsLink extends QueuedLinkBase {
  private readonly socket: WebSocket;
  private readonly log: (level: 'warn' | 'error', msg: string, data?: unknown) => void;
  private terminateTimer: ReturnType<typeof setTimeout> | undefined = undefined;

  constructor(socket: WebSocket, id: number, opts: WsLinkOptions = {}) {
    super(id);
    this.socket = socket;
    this.log =
      opts.log ?? ((_level, msg, data) => console.warn(`[conduit/net-server] ${msg}`, data ?? ''));
    socket.binaryType = 'arraybuffer';
    socket.on('message', (data, isBinary) => {
      if (!isBinary) {
        this.close(CloseCode.ProtocolViolation, 'binary only');
        return;
      }
      this.deliver(toBytes(data));
    });
    socket.on('close', (code, reason) => {
      if (this.terminateTimer !== undefined) clearTimeout(this.terminateTimer);
      this.terminateTimer = undefined;
      this.handleClosed(code, reason.toString('utf8'));
    });
    socket.on('error', (err) => this.log('warn', `websocket error on link ${id}`, err));
    if (socket.readyState === WebSocket.CLOSED) this.handleClosed(CLOSE_ABNORMAL, '');
  }

  /** Dropped silently unless the socket is open (the close path is already in flight). */
  send(buf: Uint8Array): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(buf, { binary: true });
  }

  /**
   * `socket.bufferedAmount`: bytes in the socket's write buffer, which are wire bytes (compressed
   * when permessage-deflate is on), plus frames still waiting for zlib at their own size.
   */
  bufferedAmount(): number {
    return this.socket.bufferedAmount;
  }

  protected closeTransport(code: number, reason: string): void {
    const socket = this.socket;
    if (socket.readyState === WebSocket.CLOSED) return;
    const safeReason = Buffer.byteLength(reason, 'utf8') > MAX_CLOSE_REASON_BYTES ? '' : reason;
    try {
      socket.close(code, safeReason);
    } catch (err) {
      this.log('warn', `close(${code}) failed on link ${this.id}; terminating`, err);
      socket.terminate();
      return;
    }
    const timer = setTimeout(() => {
      this.terminateTimer = undefined;
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }, WS_CLOSE_TIMEOUT_MS);
    timer.unref();
    this.terminateTimer = timer;
  }
}

/**
 * permessage-deflate (RFC 7692) on Session sockets (docs/net.md A.2), with context takeover both
 * ways: each message is compressed against those before it, which is what makes a snapshot, much
 * like the last, compress well. `ws` then compresses every message, however small.
 */
export interface WsCompressionOptions {
  /** zlib level, 0..9. Default 3. */
  level?: number | undefined;
  /** zlib memLevel, 1..9. Default 8. */
  memLevel?: number | undefined;
  /** The server's window, 2^windowBits bytes (`server_max_window_bits`), 9..15. Default 15. */
  windowBits?: number | undefined;
  /**
   * The window asked of clients that offer `client_max_window_bits` (browsers do), 9..15; a client
   * that does not offer it keeps 15. Default: not asked, the client's own.
   */
  clientWindowBits?: number | undefined;
}

/** `WsCompressionOptions` defaults; why each, docs/net.md A.2. */
export const DEFAULT_WS_COMPRESSION: Readonly<{
  level: number;
  memLevel: number;
  windowBits: number;
}> = Object.freeze({ level: 3, memLevel: 8, windowBits: 15 });

function bounded(name: string, value: number, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new RangeError(`compression.${name} must be an integer in ${min}..${max}`);
  return value;
}

/**
 * `ws`'s `perMessageDeflate` for `compression` (`WsServerOptions.compression`): `false` for
 * `false`/`undefined`, else `DEFAULT_WS_COMPRESSION` overridden by what `compression` gives.
 * `RangeError` for a value out of range.
 */
export function wsPerMessageDeflate(
  compression: boolean | WsCompressionOptions | undefined,
): false | PerMessageDeflateOptions {
  if (compression === undefined || compression === false) return false;
  const given = compression === true ? {} : compression;
  const d = DEFAULT_WS_COMPRESSION;
  const options: PerMessageDeflateOptions = {
    zlibDeflateOptions: {
      level: bounded('level', given.level ?? d.level, 0, 9),
      memLevel: bounded('memLevel', given.memLevel ?? d.memLevel, 1, 9),
    },
    serverMaxWindowBits: bounded('windowBits', given.windowBits ?? d.windowBits, 9, 15),
  };
  if (given.clientWindowBits !== undefined)
    options.clientMaxWindowBits = bounded('clientWindowBits', given.clientWindowBits, 9, 15);
  return options;
}

export interface WsServerOptions {
  /** Default 0 (ephemeral). Ignored when `server` is given. */
  port?: number | undefined;
  host?: string | undefined;
  /** Attach to an existing HTTP server instead of listening on `port`. */
  server?: HttpServer | undefined;
  path?: string | undefined;
  /**
   * permessage-deflate for clients that offer it (browsers and `ws` do): `true` for
   * `DEFAULT_WS_COMPRESSION`, or options. Default `false`: frames go as they are.
   */
  compression?: boolean | WsCompressionOptions | undefined;
}

/**
 * A `ws` server for Session links: `maxPayload` = `MAX_FRAME_BYTES` (of the inflated message when
 * compressed), and `perMessageDeflate` off unless `compression` (docs/net.md A.2).
 */
export function createWsServer(opts: WsServerOptions = {}): WebSocketServer {
  const listen =
    opts.server !== undefined ? { server: opts.server } : { port: opts.port ?? 0, host: opts.host };
  return new WebSocketServer({
    ...listen,
    path: opts.path,
    perMessageDeflate: wsPerMessageDeflate(opts.compression),
    maxPayload: MAX_FRAME_BYTES,
  });
}
