import { describe, expect, it } from 'vitest';
import { BlobStoreError, MemoryStore } from '../src/index.ts';
import { storeContract } from '../src/testing.ts';

storeContract('MemoryStore', async () => ({ store: new MemoryStore(), close: async () => {} }));

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/** Every `[key, bytes]` pair of `ns`, in list order. */
async function contents(store: MemoryStore, ns: string): Promise<[string, number[]][]> {
  const out: [string, number[]][] = [];
  for (const key of await store.list(ns)) {
    out.push([key, Array.from((await store.get(ns, key)) ?? [])]);
  }
  return out;
}

describe('MemoryStore', () => {
  it('size() counts keys per namespace and in total; clear() removes every namespace', async () => {
    const store = new MemoryStore();
    expect(store.size()).toBe(0);
    await store.put('a', 'x', bytes(1));
    await store.put('a', 'y', bytes(2));
    await store.put('a', 'x', bytes(3)); // overwrite: still two keys
    await store.put('b', 'x', bytes(4));
    expect(store.size('a')).toBe(2);
    expect(store.size('b')).toBe(1);
    expect(store.size('never_written')).toBe(0);
    expect(store.size()).toBe(3);

    await store.delete('a', 'y');
    await store.delete('b', 'x');
    await store.delete('b', 'absent');
    expect(store.size('a')).toBe(1);
    expect(store.size('b')).toBe(0);
    expect(store.size()).toBe(1);

    await store.put('c', 'z', bytes(5));
    store.clear();
    expect(store.size()).toBe(0);
    expect(await store.list('a')).toEqual([]);
    expect(await store.get('c', 'z')).toBeNull();

    await store.put('a', 'after_clear', bytes(6));
    expect(store.size()).toBe(1);
  });

  it('a rolled-back transaction leaves untouched namespaces identical', async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 20; i++) await store.put('untouched', `key/${i}`, bytes(i, 255 - i));
    await store.put('touched', 'kept', bytes(7));
    await store.put('touched', 'removed', bytes(8));
    const untouched = await contents(store, 'untouched');
    const touched = await contents(store, 'touched');

    const err = new Error('rollback');
    await expect(
      store.transaction(async (tx) => {
        await tx.put('touched', 'kept', bytes(9));
        await tx.put('touched', 'added', bytes(10));
        await tx.delete('touched', 'removed');
        await tx.put('created', 'key', bytes(11));
        throw err;
      }),
    ).rejects.toBe(err);

    expect(await contents(store, 'untouched')).toEqual(untouched);
    expect(await contents(store, 'touched')).toEqual(touched);
    expect(await store.list('created')).toEqual([]);
    expect(store.size('created')).toBe(0);
    expect(store.size()).toBe(22);
  });

  it('rolls back to the state of the last commit, including root-store writes made meanwhile', async () => {
    const store = new MemoryStore();
    await store.transaction(async (tx) => {
      await tx.put('a', 'committed', bytes(1));
    });
    await expect(
      store.transaction(async (tx) => {
        await tx.put('a', 'tx', bytes(2));
        await store.put('a', 'root', bytes(3)); // not isolated: part of the snapshot/restore
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await contents(store, 'a')).toEqual([['committed', [1]]]);
  });

  it('tx.transaction reuses the same bound store', async () => {
    const store = new MemoryStore();
    await store.transaction(async (tx) => {
      const inner = await tx.transaction((tx2) => tx2);
      expect(inner).toBe(tx);
    });
  });

  it('nested() rejects tx_closed when no transaction is open', async () => {
    const store = new MemoryStore();
    const err = await store.nested(() => 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlobStoreError);
    expect(err).toMatchObject({ code: 'tx_closed' });
  });

  it('a root-store transaction started inside fn waits for the enclosing transaction', async () => {
    const store = new MemoryStore();
    const log: string[] = [];
    const queued: Promise<void>[] = [];
    await store.transaction(async (tx) => {
      queued.push(
        store.transaction(async (root) => {
          log.push(`root sees ${Array.from((await root.get('a', 'k')) ?? []).join()}`);
        }),
      );
      await tx.put('a', 'k', bytes(1));
      await new Promise((resolve) => setTimeout(resolve, 5));
      log.push('outer end');
    });
    await Promise.all(queued);
    expect(log).toEqual(['outer end', 'root sees 1']);
  });
});
