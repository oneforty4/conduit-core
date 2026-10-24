import { CloseCode, LINK_QUEUE_MAX } from './constants.ts';

export type LinkMessageHandler = (buf: Uint8Array) => void;
export type LinkCloseHandler = (code: number, reason: string) => void;

/**
 * One client connection as the Session sees it (docs/net.md A.2). Guarantees: messages are
 * delivered in order, on the event loop, never re-entrantly from `send`; `onClose` fires exactly
 * once, including after a local `close()`; messages arriving before `onMessage` is registered are
 * queued (bounded to `LINK_QUEUE_MAX`, then the link closes with 4003) and flushed synchronously on
 * registration; after `close()` no further `onMessage` calls occur.
 */
export interface ClientLink {
  /** Unique per process, assigned by the creator (gateway or createServer). */
  readonly id: number;
  /** Takes ownership of `buf`; callers pass `FrameWriter.finish()` copies and never reuse them. */
  send(buf: Uint8Array): void;
  /** Bytes queued and not yet handed to the kernel. */
  bufferedAmount(): number;
  close(code?: number, reason?: string): void;
  /** One callback; a second call replaces the first. */
  onMessage(cb: LinkMessageHandler): void;
  /** One callback; a second call replaces the first. */
  onClose(cb: LinkCloseHandler): void;
}

/**
 * The delivery guarantees of `ClientLink` for transports that push messages in: subclasses call
 * `deliver` for each inbound message and `handleClosed` once the transport has closed, and
 * implement `send`, `bufferedAmount` and `closeTransport`.
 */
export abstract class QueuedLinkBase implements ClientLink {
  readonly id: number;
  private messageCb: LinkMessageHandler | null = null;
  private closeCb: LinkCloseHandler | null = null;
  private queue: Uint8Array[] = [];
  private localClosed = false;
  private transportClosed = false;
  private closeNotified = false;
  private closeCode = CloseCode.Normal as number;
  private closeReason = '';

  constructor(id: number) {
    this.id = id;
  }

  abstract send(buf: Uint8Array): void;
  abstract bufferedAmount(): number;
  /** Starts closing the underlying transport; it reports completion through `handleClosed`. */
  protected abstract closeTransport(code: number, reason: string): void;

  /** True once `close()` was called or the transport reported its close. */
  get closed(): boolean {
    return this.localClosed || this.transportClosed;
  }

  close(code: number = CloseCode.Normal, reason = ''): void {
    if (this.closed) return;
    this.localClosed = true;
    this.queue = [];
    this.closeTransport(code, reason);
  }

  onMessage(cb: LinkMessageHandler): void {
    this.messageCb = cb;
    if (this.queue.length === 0) return;
    const pending = this.queue;
    this.queue = [];
    for (let i = 0; i < pending.length && !this.closed; i++) {
      (this.messageCb as LinkMessageHandler)(pending[i] as Uint8Array);
    }
  }

  onClose(cb: LinkCloseHandler): void {
    this.closeCb = cb;
    if (this.transportClosed && !this.closeNotified) {
      // Closed before anyone listened: notify from the event loop, not from inside the registration.
      this.closeNotified = true;
      queueMicrotask(() => this.closeCb?.(this.closeCode, this.closeReason));
    }
  }

  /** An inbound message from the transport. Dropped once the link is closed. */
  deliver(buf: Uint8Array): void {
    if (this.closed) return;
    const cb = this.messageCb;
    if (cb !== null) {
      cb(buf);
      return;
    }
    if (this.queue.length >= LINK_QUEUE_MAX) {
      this.close(CloseCode.ProtocolViolation, 'too many messages before bind');
      return;
    }
    this.queue.push(buf);
  }

  /** The transport has closed. Fires `onClose` exactly once (later, if no callback is registered yet). */
  handleClosed(code: number, reason: string): void {
    if (this.transportClosed) return;
    this.transportClosed = true;
    this.queue = [];
    this.closeCode = code;
    this.closeReason = reason;
    const cb = this.closeCb;
    if (cb === null) return;
    this.closeNotified = true;
    cb(code, reason);
  }
}
