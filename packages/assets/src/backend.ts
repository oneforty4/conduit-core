import type { ResourceEstimate } from './resources.ts';
import { sha256Sri } from './hash.ts';
import type { AssetLoader } from './loader.ts';
import type { AssetEntry, AssetId, AssetType } from './manifest.ts';

/** What `AssetLoader` hands a backend for one load (docs/assets.md §4). */
export interface BackendContext {
  /** For `peek(dep)`: deps are `loaded` before a dependant's load starts. */
  loader: AssetLoader;
  id: AssetId;
  /** `AssetLoaderOptions.verifyHashes`. */
  verify: boolean;
  /** Safe to call as `ctx.fetch(...)`; defaults to the global `fetch`. */
  fetch: typeof fetch;
  /** Reports byte progress; ignored once the load is aborted. */
  progress(loaded: number, total: number): void;
}

/** Loads one asset `type`. Exactly one backend per type is registered with an `AssetLoader`. */
export interface AssetBackend<T> {
  readonly type: AssetType;
  /** Must reject (or resolve, the loader then disposes the result) once `signal` aborts. */
  load(url: string, entry: AssetEntry, signal: AbortSignal, ctx: BackendContext): Promise<T>;
  dispose(asset: T): void;
  /** Optional estimates; missing/unknown costs remain explicit and are never assumed free. */
  estimate?(asset: T, entry: AssetEntry): ResourceEstimate;
}

/** A non-2xx response. */
export class AssetLoadError extends Error {
  override readonly name = 'AssetLoadError';
  readonly id: AssetId;
  readonly url: string;
  readonly status: number;

  constructor(id: AssetId, url: string, status: number) {
    super(`failed to load asset ${id} from ${url}: HTTP ${status}`);
    this.id = id;
    this.url = url;
    this.status = status;
  }
}

/** A request that got no response, or whose body broke off: the network's fault, or the server gone. */
export class AssetNetworkError extends Error {
  override readonly name = 'AssetNetworkError';
  readonly id: AssetId;
  readonly url: string;

  constructor(id: AssetId, url: string, cause: unknown) {
    const why = cause instanceof Error ? cause.message : String(cause);
    super(`failed to load asset ${id} from ${url}: ${why}`, { cause });
    this.id = id;
    this.url = url;
  }
}

/**
 * Whether a load that failed with `error` may load if tried again: no response
 * (`AssetNetworkError`), or the server's 5xx, 408 or 429.
 */
export function transientError(error: unknown): boolean {
  if (error instanceof AssetNetworkError) return true;
  if (!(error instanceof AssetLoadError)) return false;
  return error.status >= 500 || error.status === 408 || error.status === 429;
}

/** Fetched bytes whose SHA-256 differs from the manifest hash. */
export class AssetIntegrityError extends Error {
  override readonly name = 'AssetIntegrityError';
  readonly id: AssetId;
  readonly expected: string;
  readonly actual: string;

  constructor(id: AssetId, expected: string, actual: string) {
    super(`integrity check failed for asset ${id}: expected ${expected}, got ${actual}`);
    this.id = id;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Fetches `url` and returns the body. Non-2xx rejects with `AssetLoadError`, no response (or a body
 * that broke off) with `AssetNetworkError`, unless `signal` aborted it. When `ctx.verify` is set,
 * the request carries `integrity: entry.hash` (enforced natively by browser fetch) and the bytes
 * are also hashed here, so a `fetch` that ignores `integrity` is still checked
 * (`AssetIntegrityError`). Reports `ctx.progress(size, size)` on completion.
 */
export async function fetchBytes(
  url: string,
  entry: AssetEntry,
  signal: AbortSignal,
  ctx: BackendContext,
): Promise<ArrayBuffer> {
  const init: RequestInit = ctx.verify ? { signal, integrity: entry.hash } : { signal };
  let response: Response;
  let bytes: ArrayBuffer;
  try {
    response = await ctx.fetch(url, init);
  } catch (error) {
    throw signal.aborted ? error : new AssetNetworkError(ctx.id, url, error);
  }
  if (!response.ok) throw new AssetLoadError(ctx.id, url, response.status);
  try {
    bytes = await response.arrayBuffer();
  } catch (error) {
    throw signal.aborted ? error : new AssetNetworkError(ctx.id, url, error);
  }
  signal.throwIfAborted();
  if (ctx.verify) {
    const actual = await sha256Sri(bytes);
    signal.throwIfAborted();
    if (actual !== entry.hash) throw new AssetIntegrityError(ctx.id, entry.hash, actual);
  }
  ctx.progress(bytes.byteLength, bytes.byteLength);
  return bytes;
}
