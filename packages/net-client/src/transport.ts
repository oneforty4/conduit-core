/** A message-oriented, ordered, reliable byte pipe to one server (docs/net.md B.2). */
export interface Transport {
  send(buf: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (buf: Uint8Array) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
  onError(cb: (err: unknown) => void): void;
}

export type TransportFactory = (url: string) => Transport;

const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

/**
 * The part of the WHATWG `WebSocket` (browsers, Node >= 22) that `webSocketTransport` uses, typed
 * structurally so this package type-checks without the DOM lib.
 */
interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'error', listener: (ev: unknown) => void): void;
  addEventListener(type: 'message', listener: (ev: { readonly data: unknown }) => void): void;
  addEventListener(
    type: 'close',
    listener: (ev: { readonly code: number; readonly reason: string }) => void,
  ): void;
}

type WebSocketConstructor = new (url: string) => WebSocketLike;

function isArrayBuffer(data: unknown): data is ArrayBuffer {
  return (
    data instanceof ArrayBuffer || Object.prototype.toString.call(data) === '[object ArrayBuffer]'
  );
}

/**
 * `new globalThis.WebSocket(url)` with `binaryType = 'arraybuffer'`. Binary messages arrive as
 * `Uint8Array` views (no copy); text messages are ignored. `send` before open or after close is
 * dropped silently. Throws at construction when `globalThis.WebSocket` is undefined.
 */
export const webSocketTransport: TransportFactory = (url) => {
  const Ctor = (globalThis as unknown as { WebSocket?: WebSocketConstructor }).WebSocket;
  if (typeof Ctor !== 'function') {
    throw new Error(
      'webSocketTransport: globalThis.WebSocket is undefined (use a browser or Node >= 22)',
    );
  }
  const socket = new Ctor(url);
  socket.binaryType = 'arraybuffer';
  let openCb: (() => void) | undefined;
  let messageCb: ((buf: Uint8Array) => void) | undefined;
  let closeCb: ((code: number, reason: string) => void) | undefined;
  let errorCb: ((err: unknown) => void) | undefined;
  socket.addEventListener('open', () => openCb?.());
  socket.addEventListener('message', (ev) => {
    const data = ev.data;
    if (isArrayBuffer(data)) messageCb?.(new Uint8Array(data));
    else if (ArrayBuffer.isView(data)) {
      messageCb?.(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
    // Text frames (strings) and Blobs are not part of the protocol.
  });
  socket.addEventListener('close', (ev) => closeCb?.(ev.code, ev.reason));
  socket.addEventListener('error', (ev) => errorCb?.(ev));
  return {
    send(buf) {
      if (socket.readyState === WS_OPEN) socket.send(buf);
    },
    close(code, reason) {
      if (socket.readyState === WS_CLOSING || socket.readyState === WS_CLOSED) return;
      try {
        if (code === undefined) socket.close();
        else socket.close(code, reason ?? '');
      } catch {
        socket.close(); // browsers accept only 1000 and 3000-4999
      }
    },
    onOpen(cb) {
      openCb = cb;
    },
    onMessage(cb) {
      messageCb = cb;
    },
    onClose(cb) {
      closeCb = cb;
    },
    onError(cb) {
      errorCb = cb;
    },
  };
};

/** Timers a memory pair schedules deliveries with; `globalThis.setTimeout` by default. */
export interface MemoryTimers {
  setTimeout(fn: () => void, ms: number): unknown;
}

export interface MemoryTransportOptions {
  /** `MemoryLink.id`; default a process-wide counter. */
  id?: number;
  /**
   * One-way delay of every message and close, in ms. Default 0 (a later turn, never re-entrant). A
   * function is called once per message and close for that item's delay (e.g. seeded jitter);
   * delivery stays in order: an item arrives once its delay has passed and every earlier item has
   * arrived (head-of-line blocking, as on a TCP stream).
   */
  latencyMs?: number | (() => number);
  timers?: MemoryTimers;
  /** Default true: `onOpen` fires on a later turn. With false the test calls `open()`. */
  autoOpen?: boolean;
}

/** Messages a `MemoryLink` holds before `onMessage` is registered; one more closes it with 4003. */
export const MEMORY_PRE_QUEUE_MAX = 64;

const defaultTimers: MemoryTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
};

let nextLinkId = 1;

/** A sampled delay: finite and >= 0, else a `RangeError` (thrown from the `send` or `close` call). */
function validLatency(ms: number): number {
  if (!(Number.isFinite(ms) && ms >= 0)) {
    throw new RangeError(`MemoryTransport: latencyMs() must return a finite value >= 0, got ${ms}`);
  }
  return ms;
}

interface PairContext {
  readonly timers: MemoryTimers;
  /** The delay of the next message or close. */
  latency(): number;
}

type Item = ({ readonly buf: Uint8Array } | { readonly code: number; readonly reason: string }) & {
  arrived: boolean;
};

/**
 * One end of a memory pair. Messages and a normal close travel through a FIFO outbox, so the peer
 * sees every message sent before `close()` and then the close; `drop()` discards everything in
 * flight in both directions.
 */
class Endpoint {
  peer: Endpoint | null = null;
  opened: boolean;
  closing = false;
  buffered = 0;
  private readonly ctx: PairContext;
  private readonly bounded: boolean;
  private messageCb: ((buf: Uint8Array) => void) | null = null;
  private closeCb: ((code: number, reason: string) => void) | null = null;
  private closeInfo: { code: number; reason: string } | null = null;
  private closeFired = false;
  private readonly waiting: Uint8Array[] = [];
  private readonly outbox: Item[] = [];

  constructor(ctx: PairContext, opened: boolean, bounded: boolean) {
    this.ctx = ctx;
    this.opened = opened;
    this.bounded = bounded;
  }

  send(buf: Uint8Array): void {
    if (this.closing || !this.opened) return;
    this.enqueue({ buf, arrived: false });
    this.buffered += buf.byteLength;
  }

  close(code: number, reason: string): void {
    if (this.closing) return;
    this.enqueue({ code, reason, arrived: false });
    this.closing = true;
    this.waiting.length = 0;
  }

  drop(code: number, reason: string): void {
    const peer = this.peer as Endpoint;
    for (const end of [this, peer]) {
      end.closing = true;
      end.waiting.length = 0;
      end.outbox.length = 0;
      end.buffered = 0;
    }
    this.ctx.timers.setTimeout(() => {
      peer.finishClose(code, reason);
      this.finishClose(code, reason);
    }, 0);
  }

  onMessage(cb: (buf: Uint8Array) => void): void {
    this.messageCb = cb;
    this.flush();
  }

  onClose(cb: (code: number, reason: string) => void): void {
    this.closeCb = cb;
    if (this.closeInfo !== null && !this.closeFired) {
      this.ctx.timers.setTimeout(() => this.fireClose(), 0);
    }
  }

  /** Marks the end open; false when it already was or is closed. */
  open(): boolean {
    if (this.opened || this.closing) return false;
    this.opened = true;
    return true;
  }

  flush(): void {
    while (this.waiting.length > 0 && this.messageCb !== null && this.opened && !this.closing) {
      this.messageCb(this.waiting.shift() as Uint8Array);
    }
  }

  /** Queues `item` behind the outbox; a throwing latency function leaves nothing queued. */
  private enqueue(item: Item): void {
    const delayMs = this.ctx.latency();
    this.outbox.push(item);
    this.ctx.timers.setTimeout(() => this.arrive(item), delayMs);
  }

  /**
   * `item`'s delay has passed. Delivers from the head while the head has arrived, so order holds
   * whatever order the timers fire in; an item dropped from the outbox meanwhile is ignored.
   */
  private arrive(item: Item): void {
    item.arrived = true;
    for (let head = this.outbox[0]; head?.arrived === true; head = this.outbox[0]) {
      this.outbox.shift();
      const peer = this.peer as Endpoint;
      if ('buf' in head) {
        this.buffered -= head.buf.byteLength;
        peer.receive(head.buf);
      } else {
        peer.remoteClose(head.code, head.reason);
        this.finishClose(head.code, head.reason);
      }
    }
  }

  private receive(buf: Uint8Array): void {
    if (this.closing) return;
    if (this.messageCb === null || !this.opened || this.waiting.length > 0) {
      this.waiting.push(buf);
      if (this.bounded && this.waiting.length > MEMORY_PRE_QUEUE_MAX) {
        this.close(4003, 'too many messages before onMessage');
        return;
      }
      this.flush();
      return;
    }
    this.messageCb(buf);
  }

  private remoteClose(code: number, reason: string): void {
    this.closing = true;
    this.waiting.length = 0;
    this.finishClose(code, reason);
  }

  private finishClose(code: number, reason: string): void {
    if (this.closeInfo !== null) return;
    this.closeInfo = { code, reason };
    this.fireClose();
  }

  private fireClose(): void {
    if (this.closeFired || this.closeInfo === null || this.closeCb === null) return;
    this.closeFired = true;
    this.closeCb(this.closeInfo.code, this.closeInfo.reason);
  }
}

/**
 * The client end of an in-process connection (docs/net.md B.2); `link` is the paired server end,
 * a `ClientLink` (docs/net.md A.2) a `Session` can `attach`. Both ends deliver in order on later
 * turns, fire `onClose` exactly once, and a normal `close()` reaches the peer after the messages
 * sent before it.
 */
export class MemoryTransport implements Transport {
  readonly link: MemoryLink;
  private readonly end: Endpoint;
  private openCb: (() => void) | null = null;
  private errorCb: ((err: unknown) => void) | null = null;

  constructor(opts: MemoryTransportOptions = {}) {
    const latencyMs = opts.latencyMs ?? 0;
    if (typeof latencyMs === 'number' && !(Number.isFinite(latencyMs) && latencyMs >= 0)) {
      throw new RangeError(`MemoryTransport: latencyMs must be finite and >= 0, got ${latencyMs}`);
    }
    const latency =
      typeof latencyMs === 'number' ? () => latencyMs : () => validLatency(latencyMs());
    const ctx: PairContext = { timers: opts.timers ?? defaultTimers, latency };
    const clientEnd = new Endpoint(ctx, false, false);
    const serverEnd = new Endpoint(ctx, true, true);
    clientEnd.peer = serverEnd;
    serverEnd.peer = clientEnd;
    this.end = clientEnd;
    this.link = new MemoryLink(opts.id ?? nextLinkId++, this, serverEnd);
    if (opts.autoOpen ?? true) ctx.timers.setTimeout(() => this.open(), 0);
  }

  /**
   * A `TransportFactory` that creates a pair per call and hands the server end to `accept`
   * (typically `link => session.attach(link)`) before returning the client end.
   */
  static factory(
    accept: (link: MemoryLink, url: string) => void,
    opts: Omit<MemoryTransportOptions, 'id'> = {},
  ): TransportFactory {
    return (url) => {
      const transport = new MemoryTransport(opts);
      accept(transport.link, url);
      return transport;
    };
  }

  /** True once `onOpen` has fired. */
  get opened(): boolean {
    return this.end.opened;
  }

  /** True once either end closed or the pair was dropped. */
  get closed(): boolean {
    return this.end.closing;
  }

  /** Fires `onOpen` (idempotent; no-op once closed), then delivers messages that arrived earlier. */
  open(): void {
    if (!this.end.open()) return;
    this.openCb?.();
    this.end.flush();
  }

  /** Bytes sent by the client end and not yet delivered to the link. */
  bufferedAmount(): number {
    return this.end.buffered;
  }

  /** Abrupt loss of the connection: in-flight data is discarded and both ends close with `code`. */
  drop(code = 1006, reason = ''): void {
    this.end.drop(code, reason);
  }

  /** Fires `onError(err)`, then drops the connection with 1006. */
  fail(err: unknown = new Error('memory transport failure')): void {
    this.errorCb?.(err);
    this.end.drop(1006, '');
  }

  send(buf: Uint8Array): void {
    this.end.send(buf);
  }

  close(code = 1000, reason = ''): void {
    this.end.close(code, reason);
  }

  onOpen(cb: () => void): void {
    this.openCb = cb;
  }

  onMessage(cb: (buf: Uint8Array) => void): void {
    this.end.onMessage(cb);
  }

  onClose(cb: (code: number, reason: string) => void): void {
    this.end.onClose(cb);
  }

  onError(cb: (err: unknown) => void): void {
    this.errorCb = cb;
  }
}

/**
 * The server end of a `MemoryTransport`; implements net-server's `ClientLink` (docs/net.md A.2):
 * ordered delivery on later turns, up to `MEMORY_PRE_QUEUE_MAX` messages queued before `onMessage`
 * is registered (then close 4003), `onClose` exactly once, no `onMessage` after `close()`.
 */
export class MemoryLink {
  readonly id: number;
  readonly transport: MemoryTransport;
  private readonly end: Endpoint;

  constructor(id: number, transport: MemoryTransport, end: Endpoint) {
    this.id = id;
    this.transport = transport;
    this.end = end;
  }

  /** True once either end closed or the pair was dropped. */
  get closed(): boolean {
    return this.end.closing;
  }

  send(buf: Uint8Array): void {
    this.end.send(buf);
  }

  /** Bytes sent by the link and not yet delivered to the transport. */
  bufferedAmount(): number {
    return this.end.buffered;
  }

  close(code = 1000, reason = ''): void {
    this.end.close(code, reason);
  }

  onMessage(cb: (buf: Uint8Array) => void): void {
    this.end.onMessage(cb);
  }

  onClose(cb: (code: number, reason: string) => void): void {
    this.end.onClose(cb);
  }

  /** Abrupt loss of the connection, as `MemoryTransport.drop`. */
  drop(code = 1006, reason = ''): void {
    this.end.drop(code, reason);
  }
}
