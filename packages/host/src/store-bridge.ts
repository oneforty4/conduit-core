import type { TransferListItem } from 'node:worker_threads';
import { type BlobStore, BlobStoreError } from '@conduit/persist';
import {
  type MainToWorker,
  type StoreRequest,
  type StoreResult,
  type StoreValue,
  toArrayBuffer,
} from './port-protocol.ts';

/** Where the bridge answers: the session's `Worker`, or a `MessagePort` in tests. */
export interface StoreBridgePort {
  postMessage(msg: MainToWorker, transfer?: readonly TransferListItem[]): void;
}

/** A transferred value as bytes; anything else is passed on for the store to reject `bad_value`. */
function bytesOf(value: unknown): Uint8Array {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : (value as Uint8Array);
}

function describe(err: unknown): { code: string; message: string } {
  if (err instanceof BlobStoreError) return { code: err.code, message: err.message };
  return { code: 'io', message: err instanceof Error ? err.message : String(err) };
}

/**
 * The main-thread side of a worker's `ProxyBlobStore` (docs/host.md 20): runs each `store` request
 * against the host's store and answers it exactly once with `storeResult`. Requests are handled
 * concurrently; a `batch` runs in one `store.transaction` (the store's mutex serializes batches).
 * `BlobStoreError`s keep their code; other failures are `io`.
 *
 * With a `scope` (the session id, as `SessionManager` passes it) every key is stored as
 * `<scope>/<key>` and `list` answers without that prefix, so the sessions sharing the host's store
 * never see each other's blobs; a scoped key must fit `MAX_KEY_BYTES` with its prefix.
 */
export class StoreBridge {
  private readonly store: BlobStore;
  private readonly port: StoreBridgePort;
  private readonly prefix: string;

  constructor(store: BlobStore, port: StoreBridgePort, scope?: string) {
    this.store = store;
    this.port = port;
    this.prefix = scope === undefined ? '' : `${scope}/`;
  }

  /** Resolves once the answer was posted. Never rejects. */
  async handle(msg: StoreRequest): Promise<void> {
    let result: StoreResult;
    const transfer: ArrayBuffer[] = [];
    try {
      const value = await this.run(msg);
      if (value instanceof ArrayBuffer) transfer.push(value);
      result =
        value === undefined
          ? { t: 'storeResult', reqId: msg.reqId, ok: true }
          : { t: 'storeResult', reqId: msg.reqId, ok: true, value };
    } catch (err) {
      result = { t: 'storeResult', reqId: msg.reqId, ok: false, error: describe(err) };
    }
    try {
      this.port.postMessage(result, transfer);
    } catch {
      // The worker is gone; nobody waits for the answer.
    }
  }

  /** The stored key of a worker's key (a non-string is passed on for the store to reject). */
  private key(key: string): string {
    return typeof key === 'string' && key !== '' ? this.prefix + key : key;
  }

  private async run(msg: StoreRequest): Promise<StoreValue> {
    const store = this.store;
    const prefix = this.prefix;
    switch (msg.op) {
      case 'get': {
        const value = await store.get(msg.ns, this.key(msg.key));
        return value === null ? null : toArrayBuffer(value);
      }
      case 'put':
        await store.put(msg.ns, this.key(msg.key), bytesOf(msg.value));
        return undefined;
      case 'delete':
        await store.delete(msg.ns, this.key(msg.key));
        return undefined;
      case 'list': {
        const listPrefix = typeof msg.prefix === 'string' ? prefix + msg.prefix : msg.prefix;
        const keys = await store.list(msg.ns, listPrefix);
        return prefix === '' ? keys : keys.map((key) => key.slice(prefix.length));
      }
      case 'batch': {
        const ops = msg.ops;
        await store.transaction(async (tx) => {
          for (const op of ops) {
            if (op.op === 'put') await tx.put(op.ns, this.key(op.key), bytesOf(op.value));
            else await tx.delete(op.ns, this.key(op.key));
          }
        });
        return undefined;
      }
      default:
        throw new BlobStoreError('io', `unknown store op ${String((msg as { op?: unknown }).op)}`);
    }
  }
}
