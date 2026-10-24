import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MEMORY_PRE_QUEUE_MAX,
  type MemoryLink,
  MemoryTransport,
  type MemoryTransportOptions,
  webSocketTransport,
} from '../src/index.ts';
import { ManualTimers } from './helpers.ts';

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

interface Recorder {
  messages: number[][];
  closes: [number, string][];
}

function record(end: {
  onMessage(cb: (buf: Uint8Array) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
}): Recorder {
  const rec: Recorder = { messages: [], closes: [] };
  end.onMessage((buf) => rec.messages.push([...buf]));
  end.onClose((code, reason) => rec.closes.push([code, reason]));
  return rec;
}

function openPair(opts: Pick<MemoryTransportOptions, 'latencyMs'> = {}): {
  timers: ManualTimers;
  transport: MemoryTransport;
  link: MemoryLink;
  client: Recorder;
  server: Recorder;
} {
  const timers = new ManualTimers();
  const transport = new MemoryTransport({ timers, ...opts });
  const client = record(transport);
  const server = record(transport.link);
  timers.flush();
  expect(transport.opened).toBe(true);
  return { timers, transport, link: transport.link, client, server };
}

describe('MemoryTransport pair', () => {
  it('delivers in order in both directions, never re-entrantly from send', () => {
    const { timers, transport, link, client, server } = openPair();
    transport.send(bytes(1));
    transport.send(bytes(2, 2));
    transport.send(bytes(3));
    link.send(bytes(9));
    link.send(bytes(8));
    expect(server.messages).toEqual([]);
    expect(client.messages).toEqual([]);
    timers.flush();
    expect(server.messages).toEqual([[1], [2, 2], [3]]);
    expect(client.messages).toEqual([[9], [8]]);
  });

  it('fires onOpen on a later turn, and never after close', () => {
    const timers = new ManualTimers();
    const opened: string[] = [];
    const t = new MemoryTransport({ timers });
    t.onOpen(() => opened.push('a'));
    expect(opened).toEqual([]);
    timers.flush();
    expect(opened).toEqual(['a']);

    const closedEarly = new MemoryTransport({ timers });
    closedEarly.onOpen(() => opened.push('b'));
    closedEarly.close();
    timers.flush();
    expect(opened).toEqual(['a']);
    expect(closedEarly.opened).toBe(false);
  });

  it('with autoOpen false waits for open(); sends before open are dropped', () => {
    const timers = new ManualTimers();
    const t = new MemoryTransport({ timers, autoOpen: false });
    const server = record(t.link);
    const client = record(t);
    let opens = 0;
    t.onOpen(() => opens++);
    t.send(bytes(1));
    t.link.send(bytes(7));
    timers.advance(1000);
    expect(opens).toBe(0);
    expect(server.messages).toEqual([]);
    expect(client.messages).toEqual([]); // held until open
    t.open();
    t.open();
    expect(opens).toBe(1);
    expect(client.messages).toEqual([[7]]);
    t.send(bytes(2));
    timers.flush();
    expect(server.messages).toEqual([[2]]);
  });

  it('applies latencyMs to messages and closes, preserving order', () => {
    const { timers, transport, link, server } = openPair({ latencyMs: 25 });
    transport.send(bytes(1));
    timers.advance(10);
    transport.send(bytes(2));
    timers.advance(14);
    expect(server.messages).toEqual([]);
    timers.advance(1);
    expect(server.messages).toEqual([[1]]);
    transport.close(1000, 'bye');
    timers.advance(10);
    expect(server.messages).toEqual([[1], [2]]);
    expect(server.closes).toEqual([]);
    timers.advance(15);
    expect(server.closes).toEqual([[1000, 'bye']]);
    expect(link.closed).toBe(true);
  });

  it('samples a latencyMs function per message and close, delivering in order behind a slower earlier item', () => {
    const delays = [30, 5, 10, 1, 50, 0];
    const sampled: number[] = [];
    const { timers, transport, link, server, client } = openPair({
      latencyMs: () => {
        const ms = delays.shift() ?? 0;
        sampled.push(ms);
        return ms;
      },
    });
    transport.send(bytes(1)); // due at 30
    transport.send(bytes(2)); // due at 5, held behind 1
    timers.advance(10);
    transport.send(bytes(3)); // due at 20, held behind 1
    expect(server.messages).toEqual([]);
    expect(transport.bufferedAmount()).toBe(3);
    link.send(bytes(9)); // the other direction is independent: due at 11
    timers.advance(1);
    expect(client.messages).toEqual([[9]]);
    timers.advance(19);
    expect(server.messages).toEqual([[1], [2], [3]]); // all at 30
    expect(transport.bufferedAmount()).toBe(0);
    transport.send(bytes(4)); // due at 80
    transport.close(1000, 'bye'); // due at 30, held behind 4
    timers.advance(49);
    expect(server.messages).toEqual([[1], [2], [3]]);
    expect(server.closes).toEqual([]);
    timers.advance(1);
    expect(server.messages).toEqual([[1], [2], [3], [4]]);
    expect(server.closes).toEqual([[1000, 'bye']]);
    expect(sampled).toEqual([30, 5, 10, 1, 50, 0]);
  });

  it('a latencyMs function returning an invalid delay throws from send and queues nothing', () => {
    let next = 5;
    const { timers, transport, server } = openPair({ latencyMs: () => next });
    next = -1;
    expect(() => transport.send(bytes(1))).toThrow(RangeError);
    expect(transport.bufferedAmount()).toBe(0);
    next = Number.NaN;
    expect(() => transport.close()).toThrow(RangeError);
    expect(transport.closed).toBe(false);
    next = 5;
    transport.send(bytes(2));
    timers.advance(5);
    expect(server.messages).toEqual([[2]]);
  });

  it('a close from the link reaches the transport after the messages sent before it, once per end', () => {
    const { timers, transport, link, client, server } = openPair();
    link.send(bytes(39));
    link.close(4005, 'please refresh');
    link.close(4000, 'second close is a no-op');
    link.send(bytes(1)); // after close: dropped
    timers.flush();
    expect(client.messages).toEqual([[39]]);
    expect(client.closes).toEqual([[4005, 'please refresh']]);
    expect(server.closes).toEqual([[4005, 'please refresh']]);
    transport.close();
    transport.send(bytes(2));
    timers.advance(100);
    expect(client.closes).toHaveLength(1);
    expect(server.closes).toHaveLength(1);
    expect(server.messages).toEqual([]);
    expect(transport.closed).toBe(true);
  });

  it('a close from the transport fires onClose once on both ends', () => {
    const { timers, transport, client, server } = openPair();
    transport.close(1000, 'client disconnect');
    timers.flush();
    expect(client.closes).toEqual([[1000, 'client disconnect']]);
    expect(server.closes).toEqual([[1000, 'client disconnect']]);
  });

  it('simultaneous closes from both ends still fire once per end', () => {
    const { timers, transport, link, client, server } = openPair();
    transport.close(1000);
    link.close(4011);
    timers.flush();
    expect(client.closes).toHaveLength(1);
    expect(server.closes).toHaveLength(1);
  });

  it('delivers no message to an end after its own close()', () => {
    const { timers, transport, link, server } = openPair();
    transport.send(bytes(1));
    link.close(4003, 'protocol');
    timers.flush();
    expect(server.messages).toEqual([]);
    expect(server.closes).toEqual([[4003, 'protocol']]);
  });

  it('drop() discards in-flight data both ways and closes both ends once with 1006', () => {
    const { timers, transport, link, client, server } = openPair({ latencyMs: 50 });
    transport.send(bytes(1, 2, 3));
    link.send(bytes(4));
    expect(transport.bufferedAmount()).toBe(3);
    expect(link.bufferedAmount()).toBe(1);
    transport.drop();
    expect(transport.bufferedAmount()).toBe(0);
    expect(link.bufferedAmount()).toBe(0);
    timers.advance(100);
    expect(client.messages).toEqual([]);
    expect(server.messages).toEqual([]);
    expect(client.closes).toEqual([[1006, '']]);
    expect(server.closes).toEqual([[1006, '']]);
    link.drop(4000);
    timers.advance(100);
    expect(client.closes).toHaveLength(1);
  });

  it('fail() reports the error, then drops', () => {
    const { timers, transport, client, server } = openPair();
    const errors: unknown[] = [];
    transport.onError((err) => errors.push(err));
    const boom = new Error('boom');
    transport.fail(boom);
    timers.flush();
    expect(errors).toEqual([boom]);
    expect(client.closes).toEqual([[1006, '']]);
    expect(server.closes).toEqual([[1006, '']]);
  });

  it('tracks bufferedAmount until delivery', () => {
    const { timers, transport, link } = openPair({ latencyMs: 10 });
    transport.send(new Uint8Array(100));
    transport.send(new Uint8Array(20));
    link.send(new Uint8Array(7));
    expect(transport.bufferedAmount()).toBe(120);
    expect(link.bufferedAmount()).toBe(7);
    timers.advance(10);
    expect(transport.bufferedAmount()).toBe(0);
    expect(link.bufferedAmount()).toBe(0);
  });

  it('queues link messages that arrive before onMessage and flushes them synchronously on registration', () => {
    const timers = new ManualTimers();
    const transport = new MemoryTransport({ timers });
    timers.flush();
    transport.send(bytes(1));
    transport.send(bytes(2));
    timers.flush();
    const got: number[][] = [];
    transport.link.onMessage((buf) => got.push([...buf]));
    expect(got).toEqual([[1], [2]]);
    transport.send(bytes(3));
    timers.flush();
    expect(got).toEqual([[1], [2], [3]]);
    // A second registration replaces the first.
    const second: number[][] = [];
    transport.link.onMessage((buf) => second.push([...buf]));
    transport.send(bytes(4));
    timers.flush();
    expect(got).toHaveLength(3);
    expect(second).toEqual([[4]]);
  });

  it(`closes the link with 4003 when more than ${MEMORY_PRE_QUEUE_MAX} messages wait for onMessage`, () => {
    const timers = new ManualTimers();
    const transport = new MemoryTransport({ timers });
    const client = record(transport);
    timers.flush();
    for (let i = 0; i <= MEMORY_PRE_QUEUE_MAX; i++) transport.send(bytes(i & 0xff));
    timers.flush();
    expect(client.closes).toEqual([[4003, 'too many messages before onMessage']]);
    const got: Uint8Array[] = [];
    transport.link.onMessage((buf) => got.push(buf));
    expect(got).toEqual([]);
  });

  it('fires an onClose registered after the close, on a later turn', () => {
    const timers = new ManualTimers();
    const transport = new MemoryTransport({ timers });
    timers.flush();
    transport.close(1000, 'early');
    timers.flush();
    const closes: [number, string][] = [];
    transport.link.onClose((code, reason) => closes.push([code, reason]));
    expect(closes).toEqual([]);
    timers.flush();
    expect(closes).toEqual([[1000, 'early']]);
  });

  it('factory() pairs a transport per call, hands the link to accept, and ids are unique', () => {
    const timers = new ManualTimers();
    const accepted: [MemoryLink, string][] = [];
    const factory = MemoryTransport.factory((link, url) => accepted.push([link, url]), { timers });
    const a = factory('memory://one');
    const b = factory('memory://two');
    expect(accepted.map(([, url]) => url)).toEqual(['memory://one', 'memory://two']);
    expect(accepted[0]![0].transport).toBe(a);
    expect(accepted[1]![0].transport).toBe(b);
    expect(accepted[0]![0].id).not.toBe(accepted[1]![0].id);
    expect(new MemoryTransport({ timers, id: 77 }).link.id).toBe(77);
  });

  it('rejects a negative latency', () => {
    expect(() => new MemoryTransport({ latencyMs: -1 })).toThrow(RangeError);
  });
});

/** Just enough of the DOM WebSocket for webSocketTransport. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly url: string;
  binaryType = 'blob';
  readyState = 0;
  sent: unknown[] = [];
  closeCalls: unknown[][] = [];
  private readonly listeners = new Map<string, ((ev: unknown) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }

  dispatch(type: string, ev: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(...args: unknown[]): void {
    this.closeCalls.push(args);
    if (args.length > 0 && args[0] !== 1000 && !((args[0] as number) >= 3000)) {
      throw new Error('InvalidAccessError');
    }
    this.readyState = 2;
  }
}

describe('webSocketTransport', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    FakeWebSocket.instances = [];
  });

  it('throws without a global WebSocket', () => {
    vi.stubGlobal('WebSocket', undefined);
    expect(() => webSocketTransport('ws://localhost:1')).toThrow(/WebSocket is undefined/);
  });

  it('wraps the global WebSocket: arraybuffer binary, text ignored, send only when open', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const t = webSocketTransport('ws://example.test/session');
    const ws = FakeWebSocket.instances[0]!;
    expect(ws.url).toBe('ws://example.test/session');
    expect(ws.binaryType).toBe('arraybuffer');

    const events: string[] = [];
    const messages: number[][] = [];
    t.onOpen(() => events.push('open'));
    t.onMessage((buf) => messages.push([...buf]));
    t.onClose((code, reason) => events.push(`close:${code}:${reason}`));
    t.onError(() => events.push('error'));

    t.send(bytes(1)); // CONNECTING: dropped
    expect(ws.sent).toEqual([]);
    ws.readyState = 1;
    ws.dispatch('open', {});
    t.send(bytes(5, 6));
    expect(ws.sent).toHaveLength(1);

    ws.dispatch('message', { data: Uint8Array.from([7, 8]).buffer });
    ws.dispatch('message', { data: 'text frame' });
    const view = new Uint8Array([0, 9, 10, 0]).subarray(1, 3);
    ws.dispatch('message', { data: view });
    expect(messages).toEqual([
      [7, 8],
      [9, 10],
    ]);

    ws.dispatch('error', {});
    ws.dispatch('close', { code: 1006, reason: '' });
    expect(events).toEqual(['open', 'error', 'close:1006:']);
  });

  it('close passes code and reason, falls back for codes the browser refuses, and is a no-op once closing', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const a = webSocketTransport('ws://a');
    const wsA = FakeWebSocket.instances[0]!;
    wsA.readyState = 1;
    a.close(1000, 'bye');
    expect(wsA.closeCalls).toEqual([[1000, 'bye']]);
    a.close(1000, 'again');
    expect(wsA.closeCalls).toHaveLength(1);

    const b = webSocketTransport('ws://b');
    const wsB = FakeWebSocket.instances[1]!;
    wsB.readyState = 1;
    b.close(1006, 'reserved');
    expect(wsB.closeCalls).toEqual([[1006, 'reserved'], []]);

    const c = webSocketTransport('ws://c');
    const wsC = FakeWebSocket.instances[2]!;
    c.close();
    expect(wsC.closeCalls).toEqual([[]]);
  });
});
