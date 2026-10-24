import type { TransferListItem } from 'node:worker_threads';
import { QueuedLinkBase } from './link.ts';

/** Where a `PortLink` posts: the worker's `parentPort`, or one end of a `MessageChannel` in tests. */
export interface PortLinkPort {
  postMessage(msg: unknown, transfer?: readonly TransferListItem[]): void;
}

/** `WorkerToMain` `send` (docs/host.md 18): one frame for the client's socket, `buf` transferred. */
export interface PortLinkSend {
  t: 'send';
  clientId: number;
  buf: ArrayBuffer;
}

/** `WorkerToMain` `close` (docs/host.md 18): the main thread closes the client's socket. */
export interface PortLinkClose {
  t: 'close';
  clientId: number;
  code: number;
  reason: string;
}

/** A standalone `ArrayBuffer` holding exactly `buf`'s bytes: its own buffer when that is exact. */
function transferable(buf: Uint8Array): ArrayBuffer {
  const backing = buf.buffer;
  if (
    backing instanceof ArrayBuffer &&
    buf.byteOffset === 0 &&
    buf.byteLength === backing.byteLength
  ) {
    return backing;
  }
  // `new Uint8Array(view)` copies into a fresh buffer (`slice` would not copy a Buffer view).
  return new Uint8Array(buf).buffer;
}

/**
 * The worker side of a client socket that lives on the main thread (docs/host.md 18, 21; behaviour
 * normative there). Frames leave through the port as transferred `ArrayBuffer`s; the worker's
 * message router feeds inbound frames to `deliver`, the socket's close to `handleClosed` and the
 * main thread's `bufferedAmount` reports to `reportBuffered`. `QueuedLinkBase` supplies the
 * `ClientLink` guarantees (docs/net.md A.2).
 */
export class PortLink extends QueuedLinkBase {
  private readonly port: PortLinkPort;
  private lastReported = 0;
  private bytesSinceReport = 0;

  constructor(id: number, port: PortLinkPort) {
    super(id);
    this.port = port;
  }

  /**
   * Posts `{ t: 'send', clientId, buf }`, transferring `buf.buffer` when the view covers all of it
   * (a `FrameWriter.finish()` copy does) and a copy otherwise; `buf` must not be used afterwards.
   * Dropped once the link is closed.
   */
  send(buf: Uint8Array): void {
    if (this.closed) return;
    const out = transferable(buf);
    this.bytesSinceReport += out.byteLength;
    const msg: PortLinkSend = { t: 'send', clientId: this.id, buf: out };
    this.port.postMessage(msg, [out]);
  }

  /**
   * The main thread's last report plus the bytes sent since, so the Session's backpressure rule
   * reacts between two reports (`STATS_INTERVAL_MS`, docs/host.md 15).
   */
  bufferedAmount(): number {
    return this.lastReported + this.bytesSinceReport;
  }

  /** The socket's `bufferedAmount` as the main thread last measured it. */
  reportBuffered(n: number): void {
    this.lastReported = n;
    this.bytesSinceReport = 0;
  }

  /** Posts `{ t: 'close', clientId, code, reason }`; the main thread echoes `closed` once it closed. */
  protected closeTransport(code: number, reason: string): void {
    const msg: PortLinkClose = { t: 'close', clientId: this.id, code, reason };
    this.port.postMessage(msg);
  }
}
