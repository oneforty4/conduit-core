import type { BlobStore } from './blob-store.ts';
import { BoundStore } from './bound-store.ts';
import { BlobStoreError } from './errors.ts';
import { compareKeys, validateKey, validateNamespace, validateValue } from './keys.ts';
import { Mutex } from './mutex.ts';

type Data = Map<string /* ns */, Map<string /* key */, Uint8Array>>;

/**
 * In-process BlobStore for tests and `createServer` dev mode (docs/persist.md 1.5). Transactions
 * snapshot every namespace (O(total keys)) and restore the snapshot on rollback.
 */
export class MemoryStore implements BlobStore {
  // Stored arrays are private copies that are never mutated, so snapshots share them safely.
  private data: Data = new Map();
  private readonly mutex = new Mutex();
  private bound: BoundStore | null = null;

  async get(ns: string, key: string): Promise<Uint8Array | null> {
    validateNamespace(ns);
    validateKey(key);
    const stored = this.data.get(ns)?.get(key);
    return stored === undefined ? null : stored.slice();
  }

  async put(ns: string, key: string, blob: Uint8Array): Promise<void> {
    validateNamespace(ns);
    validateKey(key);
    validateValue(blob);
    let keys = this.data.get(ns);
    if (keys === undefined) {
      keys = new Map();
      this.data.set(ns, keys);
    }
    // Always a copy into a plain Uint8Array; `blob.slice()` would return a view for a Buffer.
    keys.set(key, new Uint8Array(blob));
  }

  async delete(ns: string, key: string): Promise<void> {
    validateNamespace(ns);
    validateKey(key);
    const keys = this.data.get(ns);
    if (keys !== undefined && keys.delete(key) && keys.size === 0) this.data.delete(ns);
  }

  async list(ns: string, prefix = ''): Promise<string[]> {
    validateNamespace(ns);
    validateKey(prefix, true);
    const keys = this.data.get(ns);
    if (keys === undefined) return [];
    const out: string[] = [];
    for (const key of keys.keys()) if (key.startsWith(prefix)) out.push(key);
    return out.sort(compareKeys);
  }

  transaction<T>(fn: (tx: BlobStore) => T | Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      const snapshot: Data = new Map();
      for (const [ns, keys] of this.data) snapshot.set(ns, new Map(keys));
      const bound = new BoundStore(this);
      this.bound = bound;
      try {
        return await fn(bound);
      } catch (err) {
        this.data = snapshot;
        throw err;
      } finally {
        this.bound = null;
        bound.close();
      }
    });
  }

  /**
   * `BoundStore` owner hook behind `tx.transaction(fn)`: runs `fn` with the open transaction's
   * bound store, without the mutex or a snapshot of its own (no savepoints, docs/persist.md 1.4).
   * Rejects `tx_closed` when no transaction is open.
   */
  async nested<T>(fn: (tx: BlobStore) => T | Promise<T>): Promise<T> {
    if (this.bound === null) throw new BlobStoreError('tx_closed', 'no transaction is open');
    return fn(this.bound);
  }

  /** Number of keys in `ns`, or in all namespaces when omitted. */
  size(ns?: string): number {
    if (ns !== undefined) return this.data.get(ns)?.size ?? 0;
    let total = 0;
    for (const keys of this.data.values()) total += keys.size;
    return total;
  }

  /** Removes every key in every namespace. */
  clear(): void {
    this.data.clear();
  }
}
