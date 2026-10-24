import type { TransferListItem } from 'node:worker_threads';
import {
  type BlobStore,
  BlobStoreError,
  type BlobStoreErrorCode,
  BoundStore,
  compareKeys,
  Mutex,
  validateKey,
  validateNamespace,
  validateValue,
} from '@conduit/persist';
import type { BatchOp, StoreOp, StoreResult, StoreValue } from './port-protocol.ts';

/** Default `ProxyBlobStore` request timeout. */
export const STORE_REQUEST_TIMEOUT_MS = 30_000;

/** Where a `ProxyBlobStore` posts its requests: the worker's `parentPort`. */
export interface ProxyBlobStorePort {
  postMessage(msg: unknown, transfer?: readonly TransferListItem[]): void;
}

export interface ProxyBlobStoreOptions {
  /** A request without an answer after this long rejects `io`. Default `STORE_REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number | undefined;
}

const ERROR_CODES: ReadonlySet<string> = new Set<BlobStoreErrorCode>([
  'bad_namespace',
  'bad_key',
  'bad_value',
  'tx_closed',
  'closed',
  'io',
]);

interface Pending {
  resolve(value: StoreValue): void;
  reject(err: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

type Send = (op: StoreOp, transfer?: ArrayBuffer[]) => Promise<StoreValue>;

/** A standalone copy of `blob` (a `Buffer` view is copied too). */
function copyOf(blob: Uint8Array): Uint8Array {
  return new Uint8Array(blob);
}

/**
 * One transaction's writes (docs/host.md 20): `put`/`delete` go to an overlay only, reads see the
 * committed state plus the overlay, and `commit` sends the overlay as one `batch`.
 */
class ProxyTransaction implements BlobStore {
  /** `ns\0key` → the last write; `null` is a delete. One entry per key, in first-write order. */
  private readonly overlay = new Map<
    string,
    { ns: string; key: string; value: Uint8Array | null }
  >();
  private readonly root: BlobStore;
  private readonly send: Send;
  bound: BoundStore | null = null;

  constructor(root: BlobStore, send: Send) {
    this.root = root;
    this.send = send;
  }

  async get(ns: string, key: string): Promise<Uint8Array | null> {
    validateNamespace(ns);
    validateKey(key);
    const hit = this.overlay.get(`${ns}\0${key}`);
    if (hit !== undefined) return hit.value === null ? null : hit.value.slice();
    return this.root.get(ns, key);
  }

  async put(ns: string, key: string, blob: Uint8Array): Promise<void> {
    validateNamespace(ns);
    validateKey(key);
    validateValue(blob);
    this.overlay.set(`${ns}\0${key}`, { ns, key, value: copyOf(blob) });
  }

  async delete(ns: string, key: string): Promise<void> {
    validateNamespace(ns);
    validateKey(key);
    this.overlay.set(`${ns}\0${key}`, { ns, key, value: null });
  }

  async list(ns: string, prefix = ''): Promise<string[]> {
    validateNamespace(ns);
    validateKey(prefix, true);
    const keys = new Set(await this.root.list(ns, prefix));
    for (const entry of this.overlay.values()) {
      if (entry.ns !== ns || !entry.key.startsWith(prefix)) continue;
      if (entry.value === null) keys.delete(entry.key);
      else keys.add(entry.key);
    }
    return [...keys].sort(compareKeys);
  }

  transaction<T>(fn: (tx: BlobStore) => T | Promise<T>): Promise<T> {
    return this.nested(fn);
  }

  /** `BoundStore` owner hook: `tx.transaction(fn)` shares this overlay (no savepoints). */
  async nested<T>(fn: (tx: BlobStore) => T | Promise<T>): Promise<T> {
    if (this.bound === null) throw new BlobStoreError('tx_closed', 'no transaction is open');
    return fn(this.bound);
  }

  /** Sends the overlay as one `batch` (nothing when empty) and resolves once it was applied. */
  async commit(): Promise<void> {
    if (this.overlay.size === 0) return;
    const ops: BatchOp[] = [];
    const transfer: ArrayBuffer[] = [];
    for (const { ns, key, value } of this.overlay.values()) {
      if (value === null) {
        ops.push({ op: 'delete', ns, key });
      } else {
        const buf = value.buffer as ArrayBuffer; // `copyOf` made it: a standalone buffer
        ops.push({ op: 'put', ns, key, value: buf });
        transfer.push(buf);
      }
    }
    await this.send({ op: 'batch', ops }, transfer);
  }
}

/**
 * The worker-side `BlobStore` (docs/host.md 20): every operation is a `store` request to the main
 * thread's `StoreBridge`, answered through `handleResult` (the worker's message router calls it).
 * Arguments are validated locally first, so bad names reject at once like in the other stores.
 * Transactions run on the main thread as one batched op list: `transaction(fn)` waits for the
 * store's mutex (a root call never joins an open transaction; `tx.transaction` nests), collects
 * `fn`'s writes in an overlay and sends them as one `batch` once `fn` resolved; a throwing `fn`
 * sends nothing. Reads inside see the committed state plus the transaction's own writes.
 */
export class ProxyBlobStore implements BlobStore {
  private readonly port: ProxyBlobStorePort;
  private readonly timeoutMs: number;
  private readonly requests = new Map<number, Pending>();
  private readonly mutex = new Mutex();
  private nextReqId = 1;

  constructor(port: ProxyBlobStorePort, opts: ProxyBlobStoreOptions = {}) {
    const timeoutMs = opts.timeoutMs ?? STORE_REQUEST_TIMEOUT_MS;
    if (!(timeoutMs > 0)) throw new RangeError(`timeoutMs must be > 0, got ${timeoutMs}`);
    this.port = port;
    this.timeoutMs = timeoutMs;
  }

  /** Requests sent and not answered yet. */
  get pending(): number {
    return this.requests.size;
  }

  async get(ns: string, key: string): Promise<Uint8Array | null> {
    validateNamespace(ns);
    validateKey(key);
    const value = await this.request({ op: 'get', ns, key });
    return value instanceof ArrayBuffer ? new Uint8Array(value) : null;
  }

  async put(ns: string, key: string, blob: Uint8Array): Promise<void> {
    validateNamespace(ns);
    validateKey(key);
    validateValue(blob);
    const value = copyOf(blob).buffer as ArrayBuffer;
    await this.request({ op: 'put', ns, key, value }, [value]);
  }

  async delete(ns: string, key: string): Promise<void> {
    validateNamespace(ns);
    validateKey(key);
    await this.request({ op: 'delete', ns, key });
  }

  async list(ns: string, prefix = ''): Promise<string[]> {
    validateNamespace(ns);
    validateKey(prefix, true);
    const value = await this.request({ op: 'list', ns, prefix });
    return Array.isArray(value) ? value : [];
  }

  transaction<T>(fn: (tx: BlobStore) => T | Promise<T>): Promise<T> {
    return this.mutex.run(async () => {
      const tx = new ProxyTransaction(this, (op, transfer) => this.request(op, transfer));
      const bound = new BoundStore(tx);
      tx.bound = bound;
      try {
        const result = await fn(bound);
        await tx.commit();
        return result;
      } finally {
        tx.bound = null;
        bound.close();
      }
    });
  }

  /** Settles the request `msg.reqId` (unknown ids, such as timed-out ones, are ignored). */
  handleResult(msg: StoreResult): void {
    const pending = this.requests.get(msg.reqId);
    if (pending === undefined) return;
    this.requests.delete(msg.reqId);
    clearTimeout(pending.timer);
    if (msg.ok) {
      pending.resolve(msg.value);
      return;
    }
    const code = ERROR_CODES.has(msg.error.code) ? (msg.error.code as BlobStoreErrorCode) : 'io';
    pending.reject(new BlobStoreError(code, msg.error.message));
  }

  private request(op: StoreOp, transfer: ArrayBuffer[] = []): Promise<StoreValue> {
    const reqId = this.nextReqId++;
    return new Promise<StoreValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.requests.delete(reqId)) {
          reject(new BlobStoreError('io', 'store request timed out'));
        }
      }, this.timeoutMs);
      timer.unref();
      this.requests.set(reqId, { resolve, reject, timer });
      try {
        this.port.postMessage({ t: 'store', reqId, ...op }, transfer);
      } catch (err) {
        this.requests.delete(reqId);
        clearTimeout(timer);
        reject(new BlobStoreError('io', 'store request could not be sent', { cause: err }));
      }
    });
  }
}
