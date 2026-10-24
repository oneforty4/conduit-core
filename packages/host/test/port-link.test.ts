import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { PortLink } from '@conduit/net-server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerToMain } from '../src/port-protocol.ts';

const channels: MessageChannel[] = [];

/** A PortLink on one end of a MessageChannel and everything the other end receives. */
function linked(id = 7): {
  link: PortLink;
  port: MessagePort;
  received: WorkerToMain[];
  next(): Promise<WorkerToMain>;
} {
  const channel = new MessageChannel();
  channels.push(channel);
  const received: WorkerToMain[] = [];
  const waiters: ((msg: WorkerToMain) => void)[] = [];
  channel.port2.on('message', (msg: WorkerToMain) => {
    received.push(msg);
    waiters.shift()?.(msg);
  });
  return {
    link: new PortLink(id, channel.port1),
    port: channel.port1,
    received,
    next: () => new Promise((resolve) => waiters.push(resolve)),
  };
}

afterEach(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
});

describe('PortLink over a MessageChannel', () => {
  it('send posts send with the buffer transferred', async () => {
    const { link, next } = linked(7);
    const frame = new Uint8Array([1, 2, 3, 4]);
    const arrived = next();
    link.send(frame);
    expect(frame.byteLength).toBe(0); // detached: transferred, not copied
    const msg = await arrived;
    expect(msg.t).toBe('send');
    if (msg.t !== 'send') return;
    expect(msg.clientId).toBe(7);
    expect(msg.buf).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(msg.buf)]).toEqual([1, 2, 3, 4]);
  });

  it('copies a view that does not cover its whole buffer', async () => {
    const { link, next } = linked();
    const backing = new Uint8Array([9, 1, 2, 3, 9]);
    const view = backing.subarray(1, 4);
    const arrived = next();
    link.send(view);
    expect(backing.byteLength).toBe(5); // untouched
    expect(view.byteLength).toBe(3);
    const pooled = Buffer.from([5, 6]); // a Buffer from the shared pool
    const second = arrived.then(() => next());
    link.send(pooled);
    const msg = await arrived;
    expect(msg.t === 'send' && [...new Uint8Array(msg.buf)]).toEqual([1, 2, 3]);
    const msg2 = await second;
    expect(msg2.t === 'send' && [...new Uint8Array(msg2.buf)]).toEqual([5, 6]);
    expect(pooled.byteLength).toBe(2);
  });

  it('bufferedAmount: 0, then bytes sent, then the report, then the report plus bytes sent since', () => {
    const { link } = linked();
    expect(link.bufferedAmount()).toBe(0);
    link.send(new Uint8Array(100));
    link.send(new Uint8Array(20));
    expect(link.bufferedAmount()).toBe(120);
    link.reportBuffered(50);
    expect(link.bufferedAmount()).toBe(50);
    link.send(new Uint8Array(30));
    expect(link.bufferedAmount()).toBe(80);
    link.reportBuffered(0);
    expect(link.bufferedAmount()).toBe(0);
  });

  it('close posts close once and drops later sends', async () => {
    const { link, received, next } = linked(3);
    const arrived = next();
    link.close(4011, 'kicked');
    expect(link.closed).toBe(true);
    link.close(1000, 'again');
    link.send(new Uint8Array([1]));
    expect(await arrived).toEqual({ t: 'close', clientId: 3, code: 4011, reason: 'kicked' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(received).toHaveLength(1);
    expect(link.bufferedAmount()).toBe(0);
  });

  it('close defaults to 1000 with an empty reason', async () => {
    const { link, next } = linked(4);
    const arrived = next();
    link.close();
    expect(await arrived).toEqual({ t: 'close', clientId: 4, code: 1000, reason: '' });
  });

  it('handleClosed fires onClose exactly once, also after a local close', () => {
    const { link } = linked();
    const onClose = vi.fn();
    link.onClose(onClose);
    link.close(4000, 'bye');
    expect(onClose).not.toHaveBeenCalled(); // until the main thread echoes closed
    link.handleClosed(4000, 'bye');
    link.handleClosed(1006, '');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(4000, 'bye');

    const other = linked().link;
    const late = vi.fn();
    other.handleClosed(1006, 'gone');
    expect(other.closed).toBe(true);
    other.onClose(late); // registered after the close: reported from a microtask
    expect(late).not.toHaveBeenCalled();
    return Promise.resolve().then(() => expect(late).toHaveBeenCalledWith(1006, 'gone'));
  });

  it('deliver reaches onMessage in order, queued until onMessage is registered', () => {
    const { link } = linked();
    const got: number[][] = [];
    link.deliver(new Uint8Array([1]));
    link.deliver(new Uint8Array([2]));
    link.onMessage((buf) => got.push([...buf]));
    link.deliver(new Uint8Array([3]));
    expect(got).toEqual([[1], [2], [3]]);
    link.handleClosed(1000, '');
    link.deliver(new Uint8Array([4]));
    expect(got).toHaveLength(3);
  });
});
