import { MessageChannel } from 'node:worker_threads';
import { BlobStoreError, MemoryStore } from '@conduit/persist';
import { storeContract } from '@conduit/persist/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { StoreRequest, StoreResult } from '../src/port-protocol.ts';
import { ProxyBlobStore } from '../src/proxy-blob-store.ts';
import { StoreBridge } from '../src/store-bridge.ts';

const channels: MessageChannel[] = [];

/**
 * A ProxyBlobStore and a StoreBridge over a MemoryStore, connected by a MessageChannel, recording
 * every request the proxy sends. `answer: false` drops the requests instead (a bridge that never
 * replies).
 */
function proxied(opts: { timeoutMs?: number; answer?: boolean } = {}) {
  const channel = new MessageChannel();
  channels.push(channel);
  const memory = new MemoryStore();
  const bridge = new StoreBridge(memory, channel.port1);
  const sent: StoreRequest[] = [];
  channel.port1.on('message', (msg: StoreRequest) => {
    sent.push(msg);
    if (opts.answer !== false) void bridge.handle(msg);
  });
  const store = new ProxyBlobStore(channel.port2, { timeoutMs: opts.timeoutMs });
  channel.port2.on('message', (msg: StoreResult) => store.handleResult(msg));
  return { store, memory, sent };
}

afterEach(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close();
    channel.port2.close();
  }
});

storeContract('ProxyBlobStore', async () => {
  const { store } = proxied();
  return { store, close: async () => undefined };
});

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe('ProxyBlobStore transactions', () => {
  it('sends a transaction as one batch, ops in first-write order, one op per key', async () => {
    const { store, memory, sent } = proxied();
    await memory.put('region', 'gone', bytes(9));
    await store.transaction(async (tx) => {
      await tx.put('region', 'a', bytes(1));
      await tx.put('region', 'b', bytes(2));
      await tx.delete('region', 'gone');
      await tx.put('session', 'state', bytes(3));
    });
    expect(sent.map((m) => m.op)).toEqual(['batch']);
    const batch = sent[0];
    expect(batch?.op === 'batch' && batch.ops.map((op) => `${op.op} ${op.ns}/${op.key}`)).toEqual([
      'put region/a',
      'put region/b',
      'delete region/gone',
      'put session/state',
    ]);
    expect(await memory.list('region')).toEqual(['a', 'b']);
    expect([...((await memory.get('session', 'state')) ?? [])]).toEqual([3]);

    sent.length = 0;
    await store.transaction(async (tx) => {
      await tx.put('region', 'a', bytes(4));
      await tx.delete('region', 'a');
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.op === 'batch' && sent[0].ops).toEqual([
      { op: 'delete', ns: 'region', key: 'a' },
    ]);
    expect(await memory.get('region', 'a')).toBeNull();
  });

  it('sends nothing for a throwing transaction or one that only read', async () => {
    const { store, memory, sent } = proxied();
    const err = new Error('nope');
    await expect(
      store.transaction(async (tx) => {
        await tx.put('region', 'a', bytes(1));
        throw err;
      }),
    ).rejects.toBe(err);
    expect(sent).toEqual([]);
    expect(await memory.list('region')).toEqual([]);
    await store.transaction(() => 'nothing written');
    expect(sent).toEqual([]);
  });

  it('reads inside a transaction see the overlay; list merges it in compareKeys order', async () => {
    const { store, memory, sent } = proxied();
    await memory.put('region', 'b', bytes(1));
    await memory.put('region', 'd', bytes(2));
    await memory.put('region', '\u{1F600}', bytes(3));
    await store.transaction(async (tx) => {
      await tx.put('region', 'b', bytes(7));
      await tx.put('region', '\u{E000}', bytes(8));
      await tx.put('region', 'a', bytes(9));
      await tx.delete('region', 'd');
      expect([...((await tx.get('region', 'b')) ?? [])]).toEqual([7]);
      expect(await tx.get('region', 'd')).toBeNull();
      const overlayValue = await tx.get('region', 'a');
      overlayValue?.fill(0); // a copy
      expect([...((await tx.get('region', 'a')) ?? [])]).toEqual([9]);
      expect(await tx.list('region')).toEqual(['a', 'b', '\u{E000}', '\u{1F600}']);
      expect(await tx.list('region', '\u{E000}')).toEqual(['\u{E000}']);
      // The root store still reads committed state.
      expect([...((await store.get('region', 'b')) ?? [])]).toEqual([1]);
    });
    expect(sent.filter((m) => m.op === 'batch')).toHaveLength(1);
    expect(await memory.list('region')).toEqual(['a', 'b', '\u{E000}', '\u{1F600}']);
  });

  it('rejects io after timeoutMs when the bridge never replies', async () => {
    const { store, sent } = proxied({ timeoutMs: 50, answer: false });
    const started = Date.now();
    const err = await store.get('region', 'a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlobStoreError);
    expect(err).toMatchObject({ code: 'io', message: 'store request timed out' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(45);
    expect(sent).toHaveLength(1);
    expect(store.pending).toBe(0);
  });

  it('validates locally: a bad name rejects without a message', async () => {
    const { store, sent } = proxied();
    await expect(store.put('Bad', 'k', bytes(1))).rejects.toMatchObject({ code: 'bad_namespace' });
    await expect(store.get('ok', '')).rejects.toMatchObject({ code: 'bad_key' });
    expect(sent).toEqual([]);
  });

  it('passes a BlobStoreError from the main side with its code', async () => {
    const { store, memory } = proxied();
    memory.get = async () => {
      throw new BlobStoreError('closed', 'the store is closed');
    };
    const err = await store.get('region', 'k').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlobStoreError);
    expect(err).toMatchObject({ code: 'closed', message: 'the store is closed' });
    memory.list = async () => {
      throw new Error('weird');
    };
    await expect(store.list('region')).rejects.toMatchObject({ code: 'io', message: 'weird' });
    expect(store.pending).toBe(0);
  });

  it('pipelines requests: pending counts the unanswered ones', async () => {
    const { store } = proxied();
    const puts = Array.from({ length: 5 }, (_, i) => store.put('region', `k${i}`, bytes(i)));
    expect(store.pending).toBe(5);
    await Promise.all(puts);
    expect(store.pending).toBe(0);
    expect(await store.list('region')).toEqual(['k0', 'k1', 'k2', 'k3', 'k4']);
  });
});
