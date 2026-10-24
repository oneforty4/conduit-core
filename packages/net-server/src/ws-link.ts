import type { Server as HttpServer } from 'node:http';
import { MAX_FRAME_BYTES } from '@conduit/protocol';
import { type RawData, WebSocket, WebSocketServer } from 'ws';
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

export interface WsServerOptions {
  /** Default 0 (ephemeral). Ignored when `server` is given. */
  port?: number | undefined;
  host?: string | undefined;
  /** Attach to an existing HTTP server instead of listening on `port`. */
  server?: HttpServer | undefined;
  path?: string | undefined;
}

/**
 * A `ws` server for Session links: `perMessageDeflate` off (so `bufferedAmount` reflects real bytes
 * and no CPU is spent compressing quantized data) and `maxPayload` = `MAX_FRAME_BYTES`.
 */
export function createWsServer(opts: WsServerOptions = {}): WebSocketServer {
  const listen =
    opts.server !== undefined ? { server: opts.server } : { port: opts.port ?? 0, host: opts.host };
  return new WebSocketServer({
    ...listen,
    path: opts.path,
    perMessageDeflate: false,
    maxPayload: MAX_FRAME_BYTES,
  });
}
