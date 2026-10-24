import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type WebSocketServer } from 'ws';
import { CloseCode } from '../src/constants.ts';
import { createWsServer, WsLink } from '../src/ws-link.ts';

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
