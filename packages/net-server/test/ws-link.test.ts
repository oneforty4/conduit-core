import { type AddressInfo, connect as tcpConnect, createServer, type Server } from 'node:net';
import {
  defineInput,
  defineSchema,
  encodeSnapshot,
  f,
  FrameWriter,
  CoreKind,
  REGION_IDX_NONE,
  SchemaRegistry,
  SNAPSHOT_FLAG_FULL,
  type SnapshotData,
} from '@conduit/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type WebSocketServer } from 'ws';
import { CloseCode } from '../src/constants.ts';
import {
  createWsServer,
  DEFAULT_WS_COMPRESSION,
  type WsCompressionOptions,
  WsLink,
  wsPerMessageDeflate,
} from '../src/ws-link.ts';

interface Harness {
  wss: WebSocketServer;
  client: WebSocket;
  link: WsLink;
  /** Raw server-side socket, for counting arrivals independently of the link. */
  socket: WebSocket;
}

const open: Harness[] = [];

async function connect(): Promise<Harness> {
  const wss = createWsServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const { port } = wss.address() as AddressInfo;
  const accepted = new Promise<WebSocket>((resolve) => wss.once('connection', resolve));
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  client.binaryType = 'arraybuffer';
  await new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve());
    client.once('error', reject);
  });
  const socket = await accepted;
  const link = new WsLink(socket, 7, { log: () => {} });
  const h = { wss, client, link, socket };
  open.push(h);
  return h;
}

function closed(ws: WebSocket): Promise<{ code: number; reason: string }> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve({ code: 0, reason: '' });
  return new Promise((resolve) =>
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  );
}

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (predicate()) resolve();
      else if (Date.now() > deadline) reject(new Error('waitFor timed out'));
      else setTimeout(poll, 5);
    };
    poll();
  });
}

afterEach(async () => {
  for (const h of open.splice(0)) {
    h.client.terminate();
    await new Promise<void>((resolve) => h.wss.close(() => resolve()));
  }
});

describe('WsLink over a real ws server', () => {
  it('round-trips binary frames in both directions', async () => {
    const { client, link } = await connect();
    link.onMessage((buf) => link.send(buf.slice().reverse()));
    const reply = new Promise<Uint8Array>((resolve) =>
      client.once('message', (data) => resolve(new Uint8Array(data as ArrayBuffer))),
    );
    client.send(new Uint8Array([1, 2, 3, 250]));
    expect(Array.from(await reply)).toEqual([250, 3, 2, 1]);
    expect(link.id).toBe(7);
  });

  it('sends only the bytes of an offset view', async () => {
    const { client, link } = await connect();
    const reply = new Promise<Uint8Array>((resolve) =>
      client.once('message', (data) => resolve(new Uint8Array(data as ArrayBuffer))),
    );
    const backing = new Uint8Array([9, 9, 4, 5, 6, 9]);
    link.send(backing.subarray(2, 5));
    expect(Array.from(await reply)).toEqual([4, 5, 6]);
  });

  it('closes with 4003 on a text frame', async () => {
    const { client, link } = await connect();
    const onMessage = vi.fn();
    link.onMessage(onMessage);
    const done = closed(client);
    client.send('hello');
    expect((await done).code).toBe(CloseCode.ProtocolViolation);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('bufferedAmount grows while the peer is not reading', async () => {
    const { client, link } = await connect();
    expect(link.bufferedAmount()).toBe(0);
    client.pause();
    const chunk = new Uint8Array(256 * 1024);
    let sent = 0;
    while (link.bufferedAmount() < 4 * 1024 * 1024 && sent < 512) {
      link.send(chunk.slice());
      sent++;
    }
    const buffered = link.bufferedAmount();
    expect(buffered).toBeGreaterThanOrEqual(4 * 1024 * 1024);
    client.resume();
    await waitFor(() => link.bufferedAmount() < buffered);
  });

  it('queues messages that arrive before onMessage and flushes them in order', async () => {
    const { client, link, socket } = await connect();
    let arrived = 0;
    socket.on('message', () => arrived++);
    for (let i = 0; i < 5; i++) client.send(new Uint8Array([i]));
    await waitFor(() => arrived === 5);
    const got: number[] = [];
    link.onMessage((buf) => got.push(buf[0] as number));
    expect(got).toEqual([0, 1, 2, 3, 4]); // flushed synchronously on registration
    client.send(new Uint8Array([5]));
    await waitFor(() => got.length === 6);
    expect(got).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('closes with 4003 when more than 64 messages arrive before onMessage', async () => {
    const { client, socket } = await connect();
    let arrived = 0;
    socket.on('message', () => arrived++);
    const done = closed(client);
    for (let i = 0; i < 65; i++) client.send(new Uint8Array([i]));
    expect((await done).code).toBe(CloseCode.ProtocolViolation);
    expect(arrived).toBeGreaterThanOrEqual(65);
  });

  it('fires onClose exactly once after a local close', async () => {
    const { client, link } = await connect();
    const onClose = vi.fn();
    const onMessage = vi.fn();
    link.onClose(onClose);
    link.onMessage(onMessage);
    const done = closed(client);
    link.close(4010, 'bye');
    link.close(4011, 'again');
    const clientSaw = await done;
    expect(clientSaw).toEqual({ code: 4010, reason: 'bye' });
    await waitFor(() => onClose.mock.calls.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose.mock.calls[0]?.[0]).toBe(4010);
    expect(link.closed).toBe(true);
    link.send(new Uint8Array([1])); // dropped silently
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('fires onClose exactly once after a remote close', async () => {
    const { client, link } = await connect();
    const onClose = vi.fn();
    link.onClose(onClose);
    client.close(1000, 'leaving');
    await waitFor(() => onClose.mock.calls.length > 0);
    link.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose.mock.calls[0]).toEqual([1000, 'leaving']);
  });

  it('reports a close that happened before onClose was registered', async () => {
    const { client, link, socket } = await connect();
    const serverClosed = closed(socket);
    client.close(1000);
    await serverClosed;
    const onClose = vi.fn();
    link.onClose(onClose);
    expect(onClose).not.toHaveBeenCalled(); // never from inside the registration
    await Promise.resolve();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('createWsServer disables permessage-deflate', async () => {
    const { client } = await connect();
    expect(client.extensions).toBe('');
  });
});

/** A TCP relay in front of `port` counting the bytes it carries each way (the wire, framing included). */
async function countingProxy(
  port: number,
): Promise<{ server: Server; port: number; toClient: () => number }> {
  let toClient = 0;
  const server = createServer((client) => {
    const upstream = tcpConnect(port, '127.0.0.1');
    client.on('data', (d) => upstream.write(d));
    upstream.on('data', (d) => {
      toClient += d.byteLength;
      client.write(d);
    });
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.on('error', () => {});
    upstream.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return { server, port: (server.address() as AddressInfo).port, toClient: () => toClient };
}

/** Snapshot frames of 40 bodies a little on from each other, as a session sends them. */
function snapshotFrames(count: number): Uint8Array[] {
  const Body = {
    name: 'Body',
    replicate: true,
    interpolate: [],
    schema: defineSchema({ pos: f.vec3(f.f32), heading: f.u16, hp: f.u8 }),
  };
  const registry = new SchemaRegistry({
    components: [Body],
    messages: [],
    events: [],
    input: defineInput({ tick: f.u32 }),
  });
  const frames: Uint8Array[] = [];
  const fw = new FrameWriter();
  for (let tick = 3; frames.length < count; tick += 3) {
    const data: SnapshotData = {
      header: {
        serverTick: tick,
        serverTimeMs: tick * 16,
        baselineTick: 0,
        lastInputSeq: 0,
        lastInputTick: 0,
        flags: SNAPSHOT_FLAG_FULL,
      },
      regions: [],
      creates: Array.from({ length: 40 }, (_, i) => ({
        entity: i + 1,
        regionIdx: REGION_IDX_NONE,
        components: [
          {
            id: 0,
            value: { pos: { x: i * 10 + tick * 0.25, y: 100, z: -i }, heading: i * 99, hp: 100 },
          },
        ],
      })),
      updates: [],
      destroys: [],
    };
    fw.begin();
    fw.message(CoreKind.Snapshot, tick, frames.length, (w) => encodeSnapshot(w, registry, data));
    frames.push(fw.finish());
  }
  return frames;
}

async function wireBytes(
  compression: boolean | WsCompressionOptions,
  clientOffers = true,
): Promise<{ wire: number; frames: number; extensions: string; received: Uint8Array[] }> {
  const wss = createWsServer({ host: '127.0.0.1', port: 0, compression });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  // The handshake response's Sec-WebSocket-Extensions: what was agreed, parameters included.
  let extensions = '';
  wss.once('headers', (headers) => {
    const line = headers.find((h) => h.toLowerCase().startsWith('sec-websocket-extensions:'));
    extensions = line === undefined ? '' : line.slice(line.indexOf(':') + 1).trim();
  });
  const proxy = await countingProxy((wss.address() as AddressInfo).port);
  const accepted = new Promise<WebSocket>((resolve) => wss.once('connection', resolve));
  const client = new WebSocket(`ws://127.0.0.1:${proxy.port}`, {
    perMessageDeflate: clientOffers,
  });
  client.binaryType = 'arraybuffer';
  await new Promise<void>((resolve) => client.once('open', () => resolve()));
  const link = new WsLink(await accepted, 1, { log: () => {} });
  const handshake = proxy.toClient();
  const frames = snapshotFrames(30);
  const received: Uint8Array[] = [];
  client.on('message', (data: ArrayBuffer) => received.push(new Uint8Array(data)));
  for (const frame of frames) link.send(frame);
  await waitFor(() => received.length === frames.length);
  const result = {
    wire: proxy.toClient() - handshake,
    frames: frames.reduce((sum, frame) => sum + frame.byteLength, 0),
    extensions,
    received,
  };
  for (let i = 0; i < frames.length; i++) expect(received[i]).toEqual(frames[i]);
  client.terminate();
  proxy.server.close();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  return result;
}

describe('compression (docs/net.md A.2)', () => {
  it('negotiates permessage-deflate when enabled, and the bytes on the wire shrink', async () => {
    const plain = await wireBytes(false);
    expect(plain.extensions).toBe('');
    // Uncompressed, the wire is the frames plus a 4-byte WebSocket header each (126..65535 bytes).
    expect(plain.wire).toBe(plain.frames + 30 * 4);
    const compressed = await wireBytes(true);
    expect(compressed.extensions).toBe('permessage-deflate; server_max_window_bits=15');
    expect(compressed.received).toEqual(plain.received); // inflated to the same frames
    // Each frame is much like the one before it: context takeover makes it cheap.
    expect(compressed.wire).toBeLessThan(plain.wire * 0.25);
    const level9 = await wireBytes({ level: 9, windowBits: 9, clientWindowBits: 12 });
    expect(level9.extensions).toBe(
      'permessage-deflate; client_max_window_bits=12; server_max_window_bits=9',
    );
  });

  it('leaves a client that does not offer it uncompressed', async () => {
    const plain = await wireBytes(true, false);
    expect(plain.extensions).toBe('');
    expect(plain.wire).toBe(plain.frames + 30 * 4);
  });

  it('is negotiated by the WHATWG WebSocket that webSocketTransport uses (Node 22+, browsers)', async () => {
    const wss = createWsServer({ host: '127.0.0.1', port: 0, compression: true });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    const accepted = new Promise<WebSocket>((resolve) => wss.once('connection', resolve));
    const Native = (globalThis as { WebSocket?: new (url: string) => globalThis.WebSocket })
      .WebSocket!;
    const client = new Native(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`);
    client.binaryType = 'arraybuffer';
    const got = new Promise<Uint8Array>((resolve) =>
      client.addEventListener('message', (ev) => resolve(new Uint8Array(ev.data as ArrayBuffer))),
    );
    const socket = await accepted;
    expect(socket.extensions).toBe('permessage-deflate');
    const frame = snapshotFrames(1)[0]!;
    new WsLink(socket, 1, { log: () => {} }).send(frame);
    expect(await got).toEqual(frame);
    client.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it('maps the options onto ws, with defaults, and rejects values out of range', () => {
    expect(wsPerMessageDeflate(undefined)).toBe(false);
    expect(wsPerMessageDeflate(false)).toBe(false);
    expect(DEFAULT_WS_COMPRESSION).toEqual({ level: 3, memLevel: 8, windowBits: 15 });
    expect(wsPerMessageDeflate(true)).toEqual({
      zlibDeflateOptions: { level: 3, memLevel: 8 },
      serverMaxWindowBits: 15,
    });
    expect(wsPerMessageDeflate({ level: 1, clientWindowBits: 10 })).toEqual({
      zlibDeflateOptions: { level: 1, memLevel: 8 },
      serverMaxWindowBits: 15,
      clientMaxWindowBits: 10,
    });
    for (const bad of [
      { level: 10 },
      { level: -1 },
      { memLevel: 0 },
      { windowBits: 8 },
      { windowBits: 16 },
      { clientWindowBits: 8 },
      { level: 1.5 },
    ])
      expect(() => wsPerMessageDeflate(bad)).toThrow(RangeError);
    expect(() => createWsServer({ compression: { level: 12 } })).toThrow(RangeError);
  });
});
