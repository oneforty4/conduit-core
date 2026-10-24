import type { BlobStore } from './blob-store.ts';
import { BlobStoreError } from './errors.ts';

type BoundStoreOwner = BlobStore & {
  /** Runs `fn` inside the owner's open transaction (no mutex, no savepoint). */
  nested<T>(fn: (tx: BlobStore) => T | Promise<T>): Promise<T>;
};

/**
 * The `tx` passed to a transaction's `fn` (docs/persist.md 1.4). While open it forwards
 * `get/put/delete/list` to the owner and `transaction` to `owner.nested`; after `close()` (the
 * outermost transaction committed or rolled back) every method rejects `tx_closed`.
 */
export class BoundStore implements BlobStore {
  private readonly owner: BoundStoreOwner;
  private isOpen = true;

  constructor(owner: BoundStoreOwner) {
    this.owner = owner;
  }

  get open(): boolean {
    return this.isOpen;
  }

  close(): void {
    this.isOpen = false;
  }

  async get(ns: string, key: string): Promise<Uint8Array | null> {
    this.assertOpen();
    return this.owner.get(ns, key);
  }

  async put(ns: string, key: string, blob: Uint8Array): Promise<void> {
    this.assertOpen();
    return this.owner.put(ns, key, blob);
  }

  async delete(ns: string, key: string): Promise<void> {
    this.assertOpen();
    return this.owner.delete(ns, key);
  }

  async list(ns: string, prefix?: string): Promise<string[]> {
    this.assertOpen();
    return this.owner.list(ns, prefix);
  }

  async transaction<T>(fn: (tx: BlobStore) => T | Promise<T>): Promise<T> {
    this.assertOpen();
    return this.owner.nested(fn);
  }

  private assertOpen(): void {
    if (!this.isOpen) {
      throw new BlobStoreError('tx_closed', 'the transaction this store was bound to has ended');
    }
  }
}
