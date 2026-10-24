/**
 * Namespaced byte storage shared by MemoryStore, SqliteStore and the host's ProxyBlobStore
 * (docs/persist.md 1.2). Every method returns a promise; invalid arguments reject with a
 * `BlobStoreError` instead of throwing synchronously.
 */
export interface BlobStore {
  /** A fresh copy of the stored bytes, or `null` when the key is absent. */
  get(ns: string, key: string): Promise<Uint8Array | null>;
  /** Stores a copy of `blob`, replacing any previous value. */
  put(ns: string, key: string, blob: Uint8Array): Promise<void>;
  /** Removes `key`; deleting an absent key resolves. */
  delete(ns: string, key: string): Promise<void>;
  /** Keys starting with `prefix` (empty or omitted: all keys), sorted with `compareKeys`. */
  list(ns: string, prefix?: string): Promise<string[]>;
  /**
   * Runs `fn` atomically (docs/persist.md 1.4): commits when it returns, rolls back and rejects with
   * the same error when it throws. `tx.transaction` nests into the open transaction; `transaction`
   * on the root store always waits for the running one.
   */
  transaction<T>(fn: (tx: BlobStore) => T | Promise<T>): Promise<T>;
}
