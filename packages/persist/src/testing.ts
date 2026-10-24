import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BlobStore } from './blob-store.ts';
import { BlobStoreError, type BlobStoreErrorCode } from './errors.ts';

export interface StoreFixture {
  store: BlobStore;
  close(): Promise<void>;
}

const NS = 'contract';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/** Deterministic pseudo-random bytes (xorshift32, low byte of each step). */
function seededBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    out[i] = s & 0xff;
  }
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expectBytes(actual: Uint8Array | null, expected: Uint8Array): void {
  expect(actual, 'stored value').toBeInstanceOf(Uint8Array);
  if (!(actual instanceof Uint8Array)) return;
  if (expected.length <= 1024) {
    expect(Array.from(actual)).toEqual(Array.from(expected));
    return;
  }
  expect(actual.length, 'stored length').toBe(expected.length);
  let firstDiff = -1;
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) {
      firstDiff = i;
      break;
    }
  }
  expect(firstDiff, 'index of the first differing byte').toBe(-1);
}

/** The rejection reason of `call()`, failing if it throws synchronously or resolves. */
async function rejectionOf(call: () => Promise<unknown>): Promise<unknown> {
  let promise: Promise<unknown>;
  try {
    promise = call();
  } catch (err) {
    throw new Error('expected a rejected promise, but the call threw synchronously', {
      cause: err,
    });
  }
  expect(promise).toBeInstanceOf(Promise);
  return promise.then(
    () => {
      throw new Error('expected the promise to reject, but it resolved');
    },
    (err: unknown) => err,
  );
}

async function expectCode(call: () => Promise<unknown>, code: BlobStoreErrorCode): Promise<void> {
  const err = await rejectionOf(call);
  expect(err).toBeInstanceOf(BlobStoreError);
  expect(err).toMatchObject({ code });
}

/**
 * Registers the BlobStore contract (docs/persist.md 1.10) as `describe(name)`. `factory` runs before
 * each case and must return an empty store; `close` runs after it. Every BlobStore implementation
 * (MemoryStore, SqliteStore, the host's ProxyBlobStore) must pass every case.
 */
export function storeContract(name: string, factory: () => Promise<StoreFixture>): void {
  describe(name, () => {
    let fixture: StoreFixture | undefined;

    beforeEach(async () => {
      fixture = await factory();
    });

    afterEach(async () => {
      const current = fixture;
      fixture = undefined;
      await current?.close();
    });

    function currentStore(): BlobStore {
      if (fixture === undefined) throw new Error('storeContract: factory did not run');
      return fixture.store;
    }

    it('round-trip', async () => {
      const store = currentStore();
      await store.put(NS, 'key', bytes(1, 2, 3));
      expectBytes(await store.get(NS, 'key'), bytes(1, 2, 3));
      expect(await store.get(NS, 'absent')).toBeNull();
      expect(await store.get('never_written', 'key')).toBeNull();
      expect(await store.list('never_written')).toEqual([]);
    });

    it('overwrite', async () => {
      const store = currentStore();
      await store.put(NS, 'key', bytes(1));
      await store.put(NS, 'key', bytes(2, 3));
      expectBytes(await store.get(NS, 'key'), bytes(2, 3));
      expect(await store.list(NS)).toEqual(['key']);
    });

    it('delete', async () => {
      const store = currentStore();
      await store.put(NS, 'key', bytes(1));
      await store.put(NS, 'other', bytes(2));
      await store.delete(NS, 'key');
      expect(await store.get(NS, 'key')).toBeNull();
      expect(await store.list(NS)).toEqual(['other']);
      await expect(store.delete(NS, 'key')).resolves.toBeUndefined();
      await expect(store.delete('never_written', 'key')).resolves.toBeUndefined();
      expectBytes(await store.get(NS, 'other'), bytes(2));
    });

    it('empty blob', async () => {
      const store = currentStore();
      await store.put(NS, 'empty', new Uint8Array(0));
      const value = await store.get(NS, 'empty');
      expect(value).not.toBeNull();
      expectBytes(value, new Uint8Array(0));
      expect(await store.list(NS)).toEqual(['empty']);
    });

    it('binary safe', async () => {
      const store = currentStore();
      const everyByte = Uint8Array.from({ length: 256 }, (_, i) => i);
      await store.put(NS, 'every_byte', everyByte);
      expectBytes(await store.get(NS, 'every_byte'), everyByte);
      const random = seededBytes(1 << 20, 0x9e3779b9);
      await store.put(NS, 'random', random);
      expectBytes(await store.get(NS, 'random'), random);
    });

    it('copy on put / get', async () => {
      const store = currentStore();
      const source = bytes(1, 2, 3);
      await store.put(NS, 'plain', source);
      source.fill(99);
      expectBytes(await store.get(NS, 'plain'), bytes(1, 2, 3));

      const got = await store.get(NS, 'plain');
      expect(got).not.toBeNull();
      got?.fill(0);
      expectBytes(await store.get(NS, 'plain'), bytes(1, 2, 3));

      // A Buffer (whose slice() is a view, not a copy) is copied too.
      const buffer = Buffer.from([4, 5, 6]);
      await store.put(NS, 'buffer', buffer);
      buffer.fill(99);
      expectBytes(await store.get(NS, 'buffer'), bytes(4, 5, 6));

      // A view into a larger buffer stores exactly the view's bytes.
      const backing = bytes(0, 7, 8, 9, 0);
      await store.put(NS, 'view', backing.subarray(1, 4));
      backing.fill(99);
      expectBytes(await store.get(NS, 'view'), bytes(7, 8, 9));
    });

    it('list ordering and prefix', async () => {
      const store = currentStore();
      for (const key of ['b', 'a/2', 'a', 'a/1', '\u{1F600}', '\u{E000}', '\u{E9}']) {
        await store.put(NS, key, bytes(1));
      }
      const all = ['a', 'a/1', 'a/2', 'b', '\u{E9}', '\u{E000}', '\u{1F600}'];
      expect(await store.list(NS)).toEqual(all);
      expect(await store.list(NS, '')).toEqual(all);
      expect(await store.list(NS, 'a/')).toEqual(['a/1', 'a/2']);
      expect(await store.list(NS, 'a')).toEqual(['a', 'a/1', 'a/2']);
      expect(await store.list(NS, 'zz')).toEqual([]);
      expect(await store.list(NS, '\u{E000}')).toEqual(['\u{E000}']);
      expect(await store.list(NS, '\u{1F600}')).toEqual(['\u{1F600}']);
    });

    it('namespaces are isolated', async () => {
      const store = currentStore();
      await store.put('a', 'same', bytes(1));
      await store.put('b', 'same', bytes(2));
      await store.put('b', 'only_b', bytes(3));
      expectBytes(await store.get('a', 'same'), bytes(1));
      expectBytes(await store.get('b', 'same'), bytes(2));
      expect(await store.get('a', 'only_b')).toBeNull();
      expect(await store.list('a')).toEqual(['same']);
      expect(await store.list('b')).toEqual(['only_b', 'same']);
      await store.delete('a', 'same');
      expectBytes(await store.get('b', 'same'), bytes(2));
    });

    it('validation', async () => {
      const store = currentStore();
      const value = bytes(1);
      for (const ns of ['Bad', 'a-b', '', 'n'.repeat(65)]) {
        await expectCode(() => store.get(ns, 'k'), 'bad_namespace');
        await expectCode(() => store.put(ns, 'k', value), 'bad_namespace');
        await expectCode(() => store.delete(ns, 'k'), 'bad_namespace');
        await expectCode(() => store.list(ns), 'bad_namespace');
      }
      // 257 bytes: ASCII, and 128 two-byte characters plus one ASCII character.
      const badKeys = [
        '',
        'k'.repeat(257),
        `${'\u{E9}'.repeat(128)}k`,
        'lone\u{D800}',
        '\u{DC00}lone',
      ];
      for (const key of badKeys) {
        await expectCode(() => store.get(NS, key), 'bad_key');
        await expectCode(() => store.put(NS, key, value), 'bad_key');
        await expectCode(() => store.delete(NS, key), 'bad_key');
      }
      for (const prefix of ['k'.repeat(257), 'lone\u{D800}']) {
        await expectCode(() => store.list(NS, prefix), 'bad_key');
      }
      const badValues: unknown[] = [
        'text',
        [1, 2, 3],
        new Uint16Array(2),
        new ArrayBuffer(2),
        null,
        undefined,
      ];
      for (const bad of badValues) {
        await expectCode(() => store.put(NS, 'k', bad as Uint8Array), 'bad_value');
      }
      expect(await store.list(NS)).toEqual([]);

      // The boundaries are accepted: a 64-char namespace and 256-byte keys.
      const ns64 = 'n'.repeat(64);
      const key256 = `${'\u{E9}'.repeat(127)}kk`;
      const emojiKey = '\u{1F600}'.repeat(64);
      await store.put(ns64, key256, bytes(4));
      await store.put(ns64, emojiKey, bytes(5));
      expectBytes(await store.get(ns64, key256), bytes(4));
      expectBytes(await store.get(ns64, emojiKey), bytes(5));
      expect(await store.list(ns64, key256)).toEqual([key256]);
    });

    it('transaction commit', async () => {
      const store = currentStore();
      await store.put(NS, 'old', bytes(1));
      const result = await store.transaction(async (tx) => {
        await tx.put(NS, 'b', bytes(2));
        await tx.put(NS, 'a', bytes(3));
        await tx.delete(NS, 'old');
        expectBytes(await tx.get(NS, 'a'), bytes(3));
        expect(await tx.get(NS, 'old')).toBeNull();
        expect(await tx.list(NS)).toEqual(['a', 'b']);
        return 'committed';
      });
      expect(result).toBe('committed');
      expectBytes(await store.get(NS, 'a'), bytes(3));
      expectBytes(await store.get(NS, 'b'), bytes(2));
      expect(await store.get(NS, 'old')).toBeNull();
      expect(await store.list(NS)).toEqual(['a', 'b']);
    });

    it('transaction rollback', async () => {
      const store = currentStore();
      await store.put(NS, 'overwritten', bytes(1));
      await store.put(NS, 'deleted', bytes(2));
      const err = new Error('rollback');
      await expect(
        store.transaction(async (tx) => {
          await tx.put(NS, 'added', bytes(3));
          await tx.put(NS, 'overwritten', bytes(4));
          await tx.delete(NS, 'deleted');
          await tx.put('fresh_ns', 'key', bytes(5));
          throw err;
        }),
      ).rejects.toBe(err);
      expect(await store.get(NS, 'added')).toBeNull();
      expectBytes(await store.get(NS, 'overwritten'), bytes(1));
      expectBytes(await store.get(NS, 'deleted'), bytes(2));
      expect(await store.list(NS)).toEqual(['deleted', 'overwritten']);
      expect(await store.list('fresh_ns')).toEqual([]);

      const syncErr = new Error('sync');
      await expect(
        store.transaction(() => {
          throw syncErr;
        }),
      ).rejects.toBe(syncErr);
    });

    it('nested reuses outer', async () => {
      const store = currentStore();
      // The outer fn throws after the inner transaction resolved: the inner writes roll back too.
      const outerErr = new Error('outer');
      await expect(
        store.transaction(async (tx) => {
          const inner = await tx.transaction(async (tx2) => {
            await tx2.put(NS, 'inner', bytes(1));
            return 'inner result';
          });
          expect(inner).toBe('inner result');
          expectBytes(await tx.get(NS, 'inner'), bytes(1));
          throw outerErr;
        }),
      ).rejects.toBe(outerErr);
      expect(await store.get(NS, 'inner')).toBeNull();

      // The inner fn throws and the outer fn catches it: no savepoint, the inner writes commit.
      const innerErr = new Error('inner');
      await store.transaction(async (tx) => {
        await tx.put(NS, 'outer', bytes(2));
        const caught = await tx
          .transaction(async (tx2) => {
            await tx2.put(NS, 'inner', bytes(3));
            throw innerErr;
          })
          .catch((err: unknown) => err);
        expect(caught).toBe(innerErr);
        expectBytes(await tx.get(NS, 'inner'), bytes(3));
      });
      expectBytes(await store.get(NS, 'outer'), bytes(2));
      expectBytes(await store.get(NS, 'inner'), bytes(3));
    });

    it('bound store closes', async () => {
      const store = currentStore();
      const committed = await store.transaction((tx) => tx);
      await expectCode(() => committed.get(NS, 'k'), 'tx_closed');
      await expectCode(() => committed.put(NS, 'k', bytes(1)), 'tx_closed');
      await expectCode(() => committed.delete(NS, 'k'), 'tx_closed');
      await expectCode(() => committed.list(NS), 'tx_closed');
      await expectCode(() => committed.transaction(() => 1), 'tx_closed');

      const holder: { tx: BlobStore | null } = { tx: null };
      const err = new Error('rollback');
      await expect(
        store.transaction((tx) => {
          holder.tx = tx;
          throw err;
        }),
      ).rejects.toBe(err);
      const rolledBack = holder.tx;
      expect(rolledBack).not.toBeNull();
      if (rolledBack !== null) {
        await expectCode(() => rolledBack.put(NS, 'k', bytes(1)), 'tx_closed');
      }
      expect(await store.get(NS, 'k')).toBeNull();
    });

    it('transaction returns value', async () => {
      const store = currentStore();
      expect(await store.transaction(() => 42)).toBe(42);
      const result = await store.transaction(async (tx) => {
        await tx.put(NS, 'k', bytes(1));
        await delay(1);
        return 'async';
      });
      expect(result).toBe('async');
      const object = { same: true };
      expect(await store.transaction(() => object)).toBe(object);
    });

    it('concurrent transactions serialize', async () => {
      const store = currentStore();
      const log: string[] = [];
      let markSuspended = (): void => {};
      const suspended = new Promise<void>((resolve) => {
        markSuspended = resolve;
      });
      let resumeFirst = (): void => {};
      const resume = new Promise<void>((resolve) => {
        resumeFirst = resolve;
      });

      // Two outermost transactions started without awaiting.
      const first = store.transaction(async (tx) => {
        log.push('first:start');
        await tx.put(NS, 'k', bytes(1));
        markSuspended();
        await resume;
        await tx.put(NS, 'k', bytes(2));
        log.push('first:end');
        return 'first';
      });
      const second = store.transaction(async (tx) => {
        log.push('second:start');
        const seen = await tx.get(NS, 'k'); // the first transaction's committed value
        log.push('second:end');
        return seen;
      });
      // A third one started while the first's fn is suspended at an await also waits: a root-store
      // transaction never joins another caller's open transaction.
      await Promise.race([suspended, first]);
      const third = store.transaction(async (tx) => {
        log.push('third:start');
        await tx.put(NS, 'k', bytes(3));
        log.push('third:end');
      });
      await delay(10);
      const whileSuspended = [...log];
      resumeFirst();

      const [firstResult, secondSeen] = await Promise.all([first, second, third]);
      expect(whileSuspended).toEqual(['first:start']);
      expect(log).toEqual([
        'first:start',
        'first:end',
        'second:start',
        'second:end',
        'third:start',
        'third:end',
      ]);
      expect(firstResult).toBe('first');
      expectBytes(secondSeen, bytes(2));
      expectBytes(await store.get(NS, 'k'), bytes(3));
    });

    it('concurrent puts to different namespaces', async () => {
      const store = currentStore();
      const nsOf = (i: number): string => `ns_${String.fromCharCode(0x61 + (i % 5))}`;
      await Promise.all(
        Array.from({ length: 50 }, (_, i) => store.put(nsOf(i), `key/${i}`, bytes(i))),
      );
      for (let i = 0; i < 50; i++) expectBytes(await store.get(nsOf(i), `key/${i}`), bytes(i));
      for (let n = 0; n < 5; n++) {
        const expected = Array.from({ length: 10 }, (_, j) => `key/${n + 5 * j}`).sort(compare);
        expect(await store.list(nsOf(n))).toEqual(expected);
      }
    });
  });
}

/** Plain code unit comparison; the contract only sorts ASCII with it. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
