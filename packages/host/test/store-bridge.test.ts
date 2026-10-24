import { MessageChannel } from 'node:worker_threads';
import { type BlobStore, BlobStoreError, MemoryStore } from '@conduit/persist';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoreRequest, StoreResult } from '../src/port-protocol.ts';
import { StoreBridge } from '../src/store-bridge.ts';

const channels: MessageChannel[] = [];

/** A bridge over `store` posting into a MessageChannel; `ask` sends one request and awaits its answer. */
function bridgeOver(store: BlobStore, scope?: string) {
  const channel = new MessageChannel();
  channels.push(channel);
  const bridge = new StoreBridge(store, channel.port1, scope);
  const waiters = new Map<number, (msg: StoreResult) => void>();
  channel.port2.on('message', (msg: StoreResult) => waiters.get(msg.reqId)?.(msg));
  let nextId = 1;
  const ask = async (op: DistributiveOmit<StoreRequest, 't' | 'reqId'>): Promise<StoreResult> => {
    const reqId = nextId++;
    const answer = new Promise<StoreResult>((resolve) => waiters.set(reqId, resolve));
    await bridge.handle({ t: 'store', reqId, ...op } as StoreRequest);
    return answer;
  };
  return { bridge, ask };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function buffer(...bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

afterEach(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
});

describe('StoreBridge', () => {
  it('maps each op to the store', async () => {
    const store = new MemoryStore();
    const { ask } = bridgeOver(store);
    expect(await ask({ op: 'put', ns: 'region', key: 'a', value: buffer(1, 2) })).toEqual({
      t: 'storeResult',
      reqId: 1,
      ok: true,
    });
    expect([...((await store.get('region', 'a')) ?? [])]).toEqual([1, 2]);
    await store.put('region', 'b', new Uint8Array([3]));

    const got = await ask({ op: 'get', ns: 'region', key: 'a' });
    expect(got.ok && got.value instanceof ArrayBuffer && [...new Uint8Array(got.value)]).toEqual([
      1, 2,
    ]);
    expect(await ask({ op: 'get', ns: 'region', key: 'missing' })).toMatchObject({
      ok: true,
      value: null,
    });
    expect(await ask({ op: 'list', ns: 'region', prefix: '' })).toMatchObject({
      ok: true,
      value: ['a', 'b'],
    });
    expect(await ask({ op: 'list', ns: 'region', prefix: 'b' })).toMatchObject({
      ok: true,
      value: ['b'],
    });
    expect(await ask({ op: 'delete', ns: 'region', key: 'a' })).toEqual({
      t: 'storeResult',
      reqId: 6,
      ok: true,
    });
    expect(await store.get('region', 'a')).toBeNull();
    const empty = await ask({ op: 'get', ns: 'region', key: 'b' });
    expect(empty.ok && empty.value instanceof ArrayBuffer && empty.value.byteLength).toBe(1);
  });

  it('runs a batch inside store.transaction: a failing op rolls back the earlier ones', async () => {
    const store = new MemoryStore();
    await store.put('session', 'kept', new Uint8Array([9]));
    const transaction = vi.spyOn(store, 'transaction');
    const { ask } = bridgeOver(store);
    const ok = await ask({
      op: 'batch',
      ops: [
        { op: 'put', ns: 'session', key: 'x', value: buffer(1) },
        { op: 'delete', ns: 'session', key: 'kept' },
        { op: 'put', ns: 'region', key: 'y', value: buffer(2) },
      ],
    });
    expect(ok).toMatchObject({ ok: true });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(await store.list('session')).toEqual(['x']);
    expect(await store.list('region')).toEqual(['y']);

    const failed = await ask({
      op: 'batch',
      ops: [
        { op: 'put', ns: 'session', key: 'z', value: buffer(3) },
        { op: 'delete', ns: 'session', key: 'x' },
        { op: 'put', ns: 'Bad-Namespace', key: 'w', value: buffer(4) },
      ],
    });
    expect(failed).toMatchObject({ ok: false, error: { code: 'bad_namespace' } });
    expect(await store.list('session')).toEqual(['x']);
  });

  it('transfers a get result: the store-side buffer is detached', async () => {
    const value = new Uint8Array([4, 5, 6]);
    const store = new MemoryStore();
    vi.spyOn(store, 'get').mockResolvedValue(value);
    const { ask } = bridgeOver(store);
    const got = await ask({ op: 'get', ns: 'region', key: 'k' });
    expect(value.byteLength).toBe(0);
    expect(got.ok && got.value instanceof ArrayBuffer && [...new Uint8Array(got.value)]).toEqual([
      4, 5, 6,
    ]);
  });

  it('copies a get result that is a view into a larger buffer', async () => {
    const backing = new Uint8Array([0, 7, 8, 0]);
    const store = new MemoryStore();
    vi.spyOn(store, 'get').mockResolvedValue(backing.subarray(1, 3));
    const { ask } = bridgeOver(store);
    const got = await ask({ op: 'get', ns: 'region', key: 'k' });
    expect(backing.byteLength).toBe(4);
    expect(got.ok && got.value instanceof ArrayBuffer && [...new Uint8Array(got.value)]).toEqual([
      7, 8,
    ]);
  });

  it('answers BlobStoreError codes as they are and other failures as io', async () => {
    const store = new MemoryStore();
    const { ask } = bridgeOver(store);
    expect(await ask({ op: 'get', ns: 'NOPE', key: 'k' })).toMatchObject({
      ok: false,
      error: { code: 'bad_namespace' },
    });
    expect(
      await ask({ op: 'put', ns: 'ok', key: 'k', value: 'not bytes' as unknown as ArrayBuffer }),
    ).toMatchObject({
      ok: false,
      error: { code: 'bad_value' },
    });
    vi.spyOn(store, 'list').mockRejectedValueOnce(new BlobStoreError('closed', 'store closed'));
    expect(await ask({ op: 'list', ns: 'ok', prefix: '' })).toMatchObject({
      ok: false,
      error: { code: 'closed', message: 'store closed' },
    });
    vi.spyOn(store, 'delete').mockRejectedValueOnce(new Error('disk on fire'));
    expect(await ask({ op: 'delete', ns: 'ok', key: 'k' })).toMatchObject({
      ok: false,
      error: { code: 'io', message: 'disk on fire' },
    });
    expect(
      await ask({ op: 'nope' } as unknown as DistributiveOmit<StoreRequest, 't' | 'reqId'>),
    ).toMatchObject({
      ok: false,
      error: { code: 'io' },
    });
  });

  it('keeps each scope apart: keys are stored as <scope>/<key> and listed without the prefix', async () => {
    const store = new MemoryStore();
    const one = bridgeOver(store, 'S1');
    const two = bridgeOver(store, 'S2');
    await one.ask({ op: 'put', ns: 'session', key: 'state', value: buffer(1) });
    await two.ask({ op: 'put', ns: 'session', key: 'state', value: buffer(2) });
    await one.ask({
      op: 'batch',
      ops: [
        { op: 'put', ns: 'region', key: 'cell/0_0', value: buffer(3) },
        { op: 'put', ns: 'region', key: 'cell/1_0', value: buffer(4) },
      ],
    });
    await two.ask({ op: 'put', ns: 'region', key: 'cell/0_0', value: buffer(5) });
    expect(await store.list('session')).toEqual(['S1/state', 'S2/state']);
    expect(await store.list('region')).toEqual(['S1/cell/0_0', 'S1/cell/1_0', 'S2/cell/0_0']);

    const got = await two.ask({ op: 'get', ns: 'session', key: 'state' });
    expect(got.ok && got.value instanceof ArrayBuffer && [...new Uint8Array(got.value)]).toEqual([
      2,
    ]);
    expect(await one.ask({ op: 'list', ns: 'region', prefix: '' })).toMatchObject({
      value: ['cell/0_0', 'cell/1_0'],
    });
    expect(await one.ask({ op: 'list', ns: 'region', prefix: 'cell/1' })).toMatchObject({
      value: ['cell/1_0'],
    });
    expect(await two.ask({ op: 'list', ns: 'region', prefix: '' })).toMatchObject({
      value: ['cell/0_0'],
    });
    await one.ask({ op: 'batch', ops: [{ op: 'delete', ns: 'region', key: 'cell/0_0' }] });
    await two.ask({ op: 'delete', ns: 'session', key: 'state' });
    expect(await store.list('region')).toEqual(['S1/cell/1_0', 'S2/cell/0_0']);
    expect(await store.list('session')).toEqual(['S1/state']);
    expect(await one.ask({ op: 'get', ns: 'session', key: '' })).toMatchObject({
      ok: false,
      error: { code: 'bad_key' },
    });
  });

  it('handles requests concurrently', async () => {
    const store = new MemoryStore();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realGet = store.get.bind(store);
    vi.spyOn(store, 'get').mockImplementation(async (ns, key) => {
      if (key === 'slow') await gate;
      return realGet(ns, key);
    });
    const { ask } = bridgeOver(store);
    const slow = ask({ op: 'get', ns: 'region', key: 'slow' });
    expect(await ask({ op: 'list', ns: 'region', prefix: '' })).toMatchObject({
      ok: true,
      value: [],
    });
    release();
    expect(await slow).toMatchObject({ ok: true, value: null });
  });
});
