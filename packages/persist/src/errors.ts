export type BlobStoreErrorCode =
  | 'bad_namespace' // namespace does not match NAMESPACE_RE or is not 1..MAX_NAMESPACE_CHARS chars
  | 'bad_key' // key (or list prefix) empty, not well-formed, or longer than MAX_KEY_BYTES UTF-8 bytes
  | 'bad_value' // value is not a Uint8Array or is longer than MAX_BLOB_BYTES
  | 'tx_closed' // call on a transaction-bound store after its transaction ended
  | 'closed' // call on a store after close()
  | 'io'; // driver or transport failure; `cause` holds the original error

/** Rejection reason of every BlobStore method (docs/persist.md 1.2). */
export class BlobStoreError extends Error {
  override readonly name = 'BlobStoreError';
  readonly code: BlobStoreErrorCode;

  constructor(code: BlobStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}
