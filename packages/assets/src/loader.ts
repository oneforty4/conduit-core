import { diagnosticNow, observeDiagnostic, type DiagnosticOptions } from '@conduit/math';
import {
  RESOURCE_DOMAINS,
  ResourceLedger,
  validateMemoryBudget,
  type AssetMemoryBudget,
  type ResourceEstimate,
  type ResourceOwner,
  type ResourceTotals,
} from './resources.ts';
import { type AssetBackend, type BackendContext, transientError } from './backend.ts';
import { Emitter } from './emitter.ts';
import {
  depsOf,
  resolveUrl,
  type AssetEntry,
  type AssetId,
  type AssetType,
  type Manifest,
} from './manifest.ts';

function assetNow(): number {
  return performance.now();
}

export type Priority = 'high' | 'low';
export type AssetState = 'idle' | 'queued' | 'loading' | 'loaded' | 'error' | 'grace' | 'disposing';

export interface AssetHandle<T = unknown> {
  readonly id: AssetId;
  readonly asset: T;
  /** Idempotent: a second call warns and does nothing. */
  release(): void;
}

export interface GroupHandle {
  readonly ids: readonly AssetId[];
  readonly handles: readonly AssetHandle[];
  /** Releases every handle once; a second call warns and does nothing. */
  release(): void;
}

export interface LoaderEvents {
  loaded: { id: AssetId };
  unloaded: { id: AssetId };
  error: { id: AssetId; error: Error };
  /**
   * A load failed for a reason that may pass (`transientError`) and is tried again in `delayMs`:
   * retry `attempt` of `AssetLoaderOptions.retries`. Its acquisitions wait on.
   */
  retrying: { id: AssetId; error: Error; attempt: number; delayMs: number };
  /** Bytes when the backend reports them, else 0/1 then 1/1. */
  progress: { id: AssetId; loaded: number; total: number };
}

export interface AssetLoaderOptions {
  diagnostics?: DiagnosticOptions;
  memoryBudget?: AssetMemoryBudget;
  /** Backend loads in flight at once; default `DEFAULT_MAX_CONCURRENT`. */
  maxConcurrent?: number;
  /** How long a released asset stays `peek`-able; default `DEFAULT_UNLOAD_GRACE_MS`. */
  unloadGraceMs?: number;
  /** Sets `BackendContext.verify`; default false. */
  verifyHashes?: boolean;
  /**
   * Times a load that failed for a reason that may pass (`transientError`) is tried again before it
   * fails; default `DEFAULT_RETRIES`.
   */
  retries?: number;
  /** Milliseconds before the first of them, doubling for each after; default `DEFAULT_RETRY_MS`. */
  retryMs?: number;
  /** Default `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Default `setTimeout`; injectable for tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Default `clearTimeout`. */
  clearTimer?: (handle: unknown) => void;
  /** Default `console.warn`. */
  warn?: (msg: string) => void;
}

export const DEFAULT_MAX_CONCURRENT = 6;
export const DEFAULT_UNLOAD_GRACE_MS = 5000;
/** With `DEFAULT_RETRY_MS`: tried again after 0.5, 1, 2, 4 and 8 s -- a server restarting. */
export const DEFAULT_RETRIES = 5;
export const DEFAULT_RETRY_MS = 500;

/**
 * Receives the outcome of one acquisition. Public `acquire` plugs in a promise's resolve/reject;
 * dependency acquisitions use plain callbacks, so a dependant becomes ready in the same call that
 * finishes its last dep, before the scheduler hands the free slot to anything else.
 */
interface Sink {
  resolve(handle: AssetHandle): void;
  reject(error: unknown): void;
}

interface Waiter extends Sink {
  /** Removes the acquisition's abort listener. */
  detach(): void;
}

/** Internal per-id state (docs/assets.md §3.2 `Record_`). */
interface LoadRecord {
  lastUse: number;
  loadStartedAt: number | undefined;
  readonly id: AssetId;
  readonly entry: AssetEntry;
  readonly backend: AssetBackend<unknown>;
  state: AssetState;
  /** Outstanding handles plus pending acquisitions. */
  refs: number;
  asset: unknown;
  error: Error | undefined;
  waiters: Waiter[];
  /** Handles on transitive deps, held while this record is not idle. */
  depHandles: AssetHandle[];
  depsReady: boolean;
  /** Cancels this record's dep acquisitions that are still pending; `null` once all resolved. */
  depsAbort: AbortController | null;
  abort: AbortController | null;
  graceTimer: unknown;
  /** Bumped whenever a grace period starts or is cancelled, so a stale timer is ignored. */
  graceGen: number;
  /** Highest priority requested while queued. */
  priority: Priority;
  /** Loads of it that failed and were tried again (`retries`). */
  attempts: number;
  /** Queued, but waiting out the delay before it is tried again; and that wait's timer. */
  waiting: boolean;
  retryTimer: unknown;
  /** Resolves when the record is evicted. */
  readonly disposed: Promise<void>;
  readonly markDisposed: () => void;
}

function abortError(message: string): Error {
  return new DOMException(message, 'AbortError');
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? abortError('aborted');
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function removeId(queue: AssetId[], id: AssetId): void {
  const i = queue.indexOf(id);
  if (i >= 0) queue.splice(i, 1);
}

/** Releases in reverse acquisition order (dependants before their deps). */
function releaseAll(handles: readonly AssetHandle[]): void {
  for (let i = handles.length - 1; i >= 0; i--) handles[i]?.release();
}

/**
 * Three-free, refcounted, prioritised asset loader (docs/assets.md §3). One instance per client;
 * exactly one backend per asset type.
 *
 * `acquire` takes a reference as soon as it is called. Aborting its optional `signal` before the
 * promise settles gives that reference back: a queued asset nobody else wants is dequeued, a loading
 * one has its backend signal aborted. Once a handle has resolved, `release()` gives it back instead,
 * and the asset stays `peek`-able for `unloadGraceMs` before its backend disposes it.
 */
export class AssetBudgetError extends Error {
  override readonly name = 'AssetBudgetError';
}
export interface AssetMemoryStats extends ResourceTotals {
  readonly softPressure: boolean;
  readonly hardPressure: boolean;
  readonly evictions: number;
  readonly prefetchRejected: number;
  readonly pendingRejected: number;
  readonly estimateErrors: number;
  readonly instanceOwners: number;
  readonly loadedDownloadBytes: number;
}

export class AssetLoader {
  readonly manifest: Manifest;

  private readonly backends = new Map<AssetType, AssetBackend<unknown>>();
  private readonly records = new Map<AssetId, LoadRecord>();
  private readonly high: AssetId[] = [];
  private readonly low: AssetId[] = [];
  private readonly inFlight = new Set<AssetId>();
  private readonly events = new Emitter<LoaderEvents>();
  private readonly maxConcurrent: number;
  private readonly unloadGraceMs: number;
  private readonly verifyHashes: boolean;
  private readonly retries: number;
  private readonly retryMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly warn: (msg: string) => void;
  private disposed = false;
  private readonly resourceLedger = new ResourceLedger();
  private readonly externalResourceOwners = new Set<object>();
  private readonly memoryBudget: AssetMemoryBudget | undefined;
  private readonly diagnostics: DiagnosticOptions | undefined;
  private useSequence = 0;
  private budgetEvictions = 0;
  private prefetchRejected = 0;
  private pendingRejected = 0;
  private estimateErrors = 0;
  private enforcingBudget = false;

  constructor(
    manifest: Manifest,
    backends: AssetBackend<unknown>[],
    opts: AssetLoaderOptions = {},
  ) {
    this.manifest = manifest;
    validateMemoryBudget(opts.memoryBudget);
    this.memoryBudget =
      opts.memoryBudget === undefined
        ? undefined
        : {
            ...opts.memoryBudget,
            ...(opts.memoryBudget.soft === undefined
              ? {}
              : { soft: { ...opts.memoryBudget.soft } }),
            ...(opts.memoryBudget.hard === undefined
              ? {}
              : { hard: { ...opts.memoryBudget.hard } }),
          };
    this.diagnostics = opts.diagnostics;
    for (const backend of backends) {
      if (this.backends.has(backend.type)) {
        throw new Error(`duplicate backend for type ${backend.type}`);
      }
      this.backends.set(backend.type, backend);
    }
    const maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    if (!(Number.isFinite(maxConcurrent) && maxConcurrent >= 1)) {
      throw new RangeError(`maxConcurrent must be >= 1, got ${maxConcurrent}`);
    }
    const graceMs = opts.unloadGraceMs ?? DEFAULT_UNLOAD_GRACE_MS;
    if (!(Number.isFinite(graceMs) && graceMs >= 0))
      throw new RangeError(`unloadGraceMs must be >= 0, got ${graceMs}`);
    this.maxConcurrent = Math.floor(maxConcurrent);
    this.unloadGraceMs = graceMs;
    this.verifyHashes = opts.verifyHashes ?? false;
    const retries = opts.retries ?? DEFAULT_RETRIES;
    if (!(Number.isInteger(retries) && retries >= 0)) {
      throw new RangeError(`retries must be an integer >= 0, got ${retries}`);
    }
    const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
    if (!(Number.isFinite(retryMs) && retryMs >= 0))
      throw new RangeError(`retryMs must be >= 0, got ${retryMs}`);
    this.retries = retries;
    this.retryMs = retryMs;
    // Injected and platform functions are always called through closures, so `fetch` or
    // `setTimeout` never runs with `this` bound to another object ("Illegal invocation" in browsers).
    const { fetch: fetchOpt, setTimer, clearTimer, warn } = opts;
    this.fetchFn = (input, init) => (fetchOpt ?? globalThis.fetch)(input, init);
    this.setTimer = setTimer ? (fn, ms) => setTimer(fn, ms) : (fn, ms) => setTimeout(fn, ms);
    this.clearTimer = clearTimer
      ? (handle) => clearTimer(handle)
      : (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
    this.warn = warn ? (msg) => warn(msg) : (msg) => console.warn(msg);
  }

  /**
   * Resolves once `id` and all its transitive deps are loaded. Rejects with `RangeError` for an id
   * not in the manifest, `Error('no backend for type <type>')`, the backend's (or a dep's) error,
   * or `signal.reason` when `signal` aborts first.
   */
  acquire<T = unknown>(
    id: AssetId,
    priority: Priority = 'high',
    signal?: AbortSignal,
  ): Promise<AssetHandle<T>> {
    return new Promise<AssetHandle>((resolve, reject) => {
      this.acquireInto(id, priority, signal, { resolve, reject });
    }) as Promise<AssetHandle<T>>;
  }

  /**
   * `acquire` for every id. On any rejection the members that resolved are released, pending ones
   * are cancelled, and the promise rejects with the first error.
   */
  async acquireGroup(
    ids: readonly AssetId[],
    priority: Priority = 'high',
    signal?: AbortSignal,
  ): Promise<GroupHandle> {
    if (this.disposed) throw abortError('AssetLoader is disposed');
    if (signal?.aborted) throw abortReason(signal);
    const abort = new AbortController();
    const forward = (): void => abort.abort(signal === undefined ? undefined : abortReason(signal));
    signal?.addEventListener('abort', forward, { once: true });
    const outcome = { failed: false, error: undefined as unknown };
    try {
      const results = await Promise.allSettled(
        ids.map((id) =>
          this.acquire(id, priority, abort.signal).catch((error: unknown) => {
            if (!outcome.failed) {
              outcome.failed = true;
              outcome.error = error;
              abort.abort(error); // cancel the members still pending
            }
            throw error;
          }),
        ),
      );
      const handles = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      if (outcome.failed) {
        releaseAll(handles);
        throw outcome.error;
      }
      return this.groupHandle(ids, handles);
    } finally {
      signal?.removeEventListener('abort', forward);
    }
  }

  /** The asset while `state(id)` is `'loaded'` or `'grace'`. */
  peek<T = unknown>(id: AssetId): T | undefined {
    const r = this.records.get(id);
    return r !== undefined && (r.state === 'loaded' || r.state === 'grace')
      ? (r.asset as T)
      : undefined;
  }

  /** `'idle'` for unknown or evicted ids. */
  state(id: AssetId): AssetState {
    return this.records.get(id)?.state ?? 'idle';
  }

  refcount(id: AssetId): number {
    return this.records.get(id)?.refs ?? 0;
  }

  /** `loaded` counts assets in memory (`'loaded'` or `'grace'`). */
  stats(): { queuedHigh: number; queuedLow: number; inFlight: number; loaded: number } {
    let loaded = 0;
    for (const r of this.records.values()) {
      if (r.state === 'loaded' || r.state === 'grace') loaded += 1;
    }
    return {
      queuedHigh: this.high.length,
      queuedLow: this.low.length,
      inFlight: this.inFlight.size,
      loaded,
    };
  }

  /** Known minimum byte estimates plus explicit unknown resource counts, deduplicated by identity. */
  memoryStats(): AssetMemoryStats {
    const totals = this.resourceLedger.snapshot();
    const pressured = (limits: AssetMemoryBudget['soft']): boolean =>
      RESOURCE_DOMAINS.some((domain) => {
        const limit = limits?.[domain];
        return (
          limit !== undefined &&
          (totals[domain].knownBytes > limit || totals[domain].unknownResources > 0)
        );
      });
    return {
      ...totals,
      softPressure: pressured(this.memoryBudget?.soft),
      hardPressure: pressured(this.memoryBudget?.hard),
      evictions: this.budgetEvictions,
      prefetchRejected: this.prefetchRejected,
      pendingRejected: this.pendingRejected,
      estimateErrors: this.estimateErrors,
      instanceOwners: this.externalResourceOwners.size,
      loadedDownloadBytes: [...this.records.values()].reduce(
        (bytes, record) =>
          record.state === 'loaded' || record.state === 'grace' ? bytes + record.entry.size : bytes,
        0,
      ),
    };
  }

  /** Accounts resources owned by an instance/consumer. The caller still owns physical disposal. */
  trackResources(estimate: ResourceEstimate): ResourceOwner {
    if (this.disposed) throw new Error('AssetLoader is disposed');
    const owner = {};
    this.resourceLedger.set(owner, estimate);
    this.externalResourceOwners.add(owner);
    let active = true;
    this.enforceMemoryBudget();
    return {
      update: (next) => {
        if (!active || this.disposed) throw new Error('Resource owner released');
        this.resourceLedger.set(owner, next);
        this.enforceMemoryBudget();
      },
      release: () => {
        if (!active) return;
        active = false;
        this.externalResourceOwners.delete(owner);
        this.resourceLedger.delete(owner);
        this.reportMemory();
      },
    };
  }

  private reportMemory(): void {
    const diagnostics = this.diagnostics;
    if (diagnostics === undefined) return;
    const timeMs = diagnosticNow(diagnostics.now ?? assetNow);
    if (timeMs === undefined) return;
    const stats = this.memoryStats();
    for (const domain of RESOURCE_DOMAINS) {
      observeDiagnostic(diagnostics.observer, {
        version: 1,
        category: 'asset',
        name: `memory.${domain}`,
        timeMs,
        value: stats[domain].knownBytes,
        unit: 'bytes',
        status: stats[domain].unknownResources > 0 ? 'unavailable' : 'ok',
      });
      observeDiagnostic(diagnostics.observer, {
        version: 1,
        category: 'asset',
        name: `memory.${domain}.unknown`,
        timeMs,
        value: stats[domain].unknownResources,
        unit: 'count',
        status: 'ok',
      });
    }
    observeDiagnostic(diagnostics.observer, {
      version: 1,
      category: 'asset',
      name: 'memory.pressure',
      timeMs,
      value: stats.hardPressure ? 2 : stats.softPressure ? 1 : 0,
      unit: 'count',
      status: 'ok',
    });
    observeDiagnostic(diagnostics.observer, {
      version: 1,
      category: 'asset',
      name: 'memory.evictions',
      timeMs,
      value: stats.evictions,
      unit: 'count',
      status: 'ok',
    });
    const queue = this.stats();
    observeDiagnostic(diagnostics.observer, {
      version: 1,
      category: 'asset',
      name: 'loads.queued',
      timeMs,
      value: queue.queuedHigh + queue.queuedLow,
      unit: 'count',
      status: 'ok',
    });
    observeDiagnostic(diagnostics.observer, {
      version: 1,
      category: 'asset',
      name: 'loads.active',
      timeMs,
      value: queue.inFlight,
      unit: 'count',
      status: 'ok',
    });
    const values = {
      'loads.liveReferences': [...this.records.values()].reduce(
        (sum, record) => sum + record.refs,
        0,
      ),
      'loads.resident': queue.loaded,
      'memory.prefetchRejected': stats.prefetchRejected,
      'loads.pendingRejected': stats.pendingRejected,
      'memory.estimateErrors': stats.estimateErrors,
    };
    for (const [name, value] of Object.entries(values))
      observeDiagnostic(diagnostics.observer, {
        version: 1,
        category: 'asset',
        name,
        timeMs,
        value,
        unit: 'count',
        status: 'ok',
      });
    observeDiagnostic(diagnostics.observer, {
      version: 1,
      category: 'asset',
      name: 'download.loadedDeclaredBytes',
      timeMs,
      value: stats.loadedDownloadBytes,
      unit: 'bytes',
      status: 'ok',
    });
  }

  private reportLoad(record: LoadRecord, failed: boolean): void {
    const diagnostics = this.diagnostics;
    if (diagnostics === undefined) return;
    const timeMs = diagnosticNow(diagnostics.now ?? assetNow);
    if (timeMs === undefined) return;
    const durationMs =
      record.loadStartedAt === undefined || timeMs < record.loadStartedAt
        ? undefined
        : timeMs - record.loadStartedAt;
    observeDiagnostic(diagnostics.observer, {
      version: 1,
      category: 'asset',
      name: 'load',
      timeMs,
      durationMs,
      status: failed ? 'error' : durationMs === undefined ? 'unavailable' : 'ok',
    });
  }

  private enforceMemoryBudget(): void {
    if (this.enforcingBudget || this.disposed) return;
    if (this.memoryBudget === undefined) {
      this.reportMemory();
      return;
    }
    this.enforcingBudget = true;
    try {
      const visited = new Set<LoadRecord>();
      for (;;) {
        const pressure = this.memoryStats();
        if (!pressure.softPressure && !pressure.hardPressure) break;
        const candidates = [...this.records.values()]
          .filter((record) => record.state === 'grace' && record.refs === 0 && !visited.has(record))
          .map((record) => {
            const reclaimable = this.resourceLedger.snapshot(record);
            return {
              record,
              bytes: Math.max(
                reclaimable.cpuBytes.knownBytes,
                reclaimable.gpuBytes.knownBytes,
                reclaimable.retainedSourceBytes.knownBytes,
              ),
            };
          });
        candidates.sort(
          (a, b) =>
            (a.record.priority === b.record.priority ? 0 : a.record.priority === 'low' ? -1 : 1) ||
            a.record.lastUse - b.record.lastUse ||
            b.bytes - a.bytes ||
            (a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0),
        );
        if (candidates.length === 0) break;
        for (const { record } of candidates) {
          const stats = this.memoryStats();
          if (!stats.softPressure && !stats.hardPressure) break;
          visited.add(record);
          if (record.refs !== 0 || record.state !== 'grace') continue;
          this.cancelGrace(record);
          this.budgetEvictions++;
          this.expire(record, record.graceGen);
        }
        // Expiring a parent can make its dependency newly eligible in this same pass.
      }
    } finally {
      this.enforcingBudget = false;
      this.reportMemory();
    }
  }

  on<K extends keyof LoaderEvents>(evt: K, cb: (e: LoaderEvents[K]) => void): () => void {
    return this.events.on(evt, cb);
  }

  /** Aborts all in-flight loads, disposes all loaded assets, rejects waiters with `AbortError`. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const records = [...this.records.values()];
    for (const owner of this.externalResourceOwners) this.resourceLedger.delete(owner);
    this.externalResourceOwners.clear();
    this.records.clear();
    this.high.length = 0;
    this.low.length = 0;
    this.inFlight.clear();
    const error = abortError('AssetLoader disposed');
    for (const r of records) {
      const state = r.state;
      r.state = 'disposing';
      r.refs = 0;
      r.graceGen += 1;
      if (state === 'grace') this.clearTimer(r.graceTimer);
      if (r.waiting) this.clearTimer(r.retryTimer);
      r.waiting = false;
      const depsAbort = r.depsAbort;
      r.depsAbort = null;
      depsAbort?.abort(error);
      r.depHandles = [];
      this.rejectWaiters(r, error);
      if (state === 'loading') r.abort?.abort(error);
      if (state === 'loaded' || state === 'grace') this.disposeAsset(r, r.asset);
      r.asset = undefined;
      r.markDisposed();
    }
  }

  /** The acquisition state machine (docs/assets.md §3.2 `acquire`); reports through `sink`. */
  private acquireInto(
    id: AssetId,
    priority: Priority,
    signal: AbortSignal | undefined,
    sink: Sink,
  ): void {
    if (this.disposed) return sink.reject(abortError('AssetLoader is disposed'));
    if (signal?.aborted) return sink.reject(abortReason(signal));
    const entry = Object.hasOwn(this.manifest.assets, id) ? this.manifest.assets[id] : undefined;
    if (entry === undefined) return sink.reject(new RangeError(`unknown asset ${id}`));
    const backend = this.backends.get(entry.type);
    if (backend === undefined) return sink.reject(new Error(`no backend for type ${entry.type}`));

    const existing = this.records.get(id);
    if (existing?.state === 'disposing') {
      this.retryAfterEviction(existing, priority, signal, sink);
      return;
    }
    if (
      (existing === undefined || existing.state === 'idle' || existing.state === 'error') &&
      this.memoryBudget !== undefined
    ) {
      if (priority === 'low' && this.memoryStats().hardPressure) {
        this.prefetchRejected++;
        this.reportMemory();
        return sink.reject(
          new AssetBudgetError('Optional prefetch blocked by hard/unknown memory pressure'),
        );
      }
      if (this.memoryBudget.maxPendingLoads !== undefined) {
        const pending = [...this.records.values()].filter(
          (record) => record.state === 'queued' || record.state === 'loading',
        ).length;
        if (pending >= this.memoryBudget.maxPendingLoads) {
          this.pendingRejected++;
          this.reportMemory();
          return sink.reject(new AssetBudgetError('Asset pending-load budget exceeded'));
        }
      }
    }
    const r = existing ?? this.createRecord(id, entry, backend);
    r.lastUse = ++this.useSequence;
    if (priority === 'high' && r.state !== 'queued') r.priority = 'high';
    r.refs += 1;
    switch (r.state) {
      case 'loaded':
        return sink.resolve(this.handle(r));
      case 'grace':
        this.cancelGrace(r);
        r.state = 'loaded';
        return sink.resolve(this.handle(r));
      case 'queued':
        if (priority === 'high' && r.priority === 'low') this.promote(r);
        return this.addWaiter(r, signal, sink);
      case 'loading':
        return this.addWaiter(r, signal, sink);
      default:
        // 'idle' (new record) or 'error' (retry).
        r.error = undefined;
        r.attempts = 0;
        r.state = 'queued';
        r.priority = priority;
        r.depsReady = false;
        this.addWaiter(r, signal, sink);
        (priority === 'high' ? this.high : this.low).push(r.id);
        this.acquireDeps(r, priority);
        this.pump();
        this.reportMemory();
    }
  }

  /** An aborted load is still settling: wait for its eviction, then acquire afresh. */
  private retryAfterEviction(
    r: LoadRecord,
    priority: Priority,
    signal: AbortSignal | undefined,
    sink: Sink,
  ): void {
    let settled = false;
    const onAbort = (): void => {
      if (settled || signal === undefined) return;
      settled = true;
      sink.reject(abortReason(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    void r.disposed.then(() => {
      signal?.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      this.acquireInto(r.id, priority, signal, sink);
    });
  }

  private createRecord(id: AssetId, entry: AssetEntry, backend: AssetBackend<unknown>): LoadRecord {
    let markDisposed = (): void => undefined;
    const disposed = new Promise<void>((resolve) => {
      markDisposed = () => resolve();
    });
    const r: LoadRecord = {
      id,
      entry,
      backend,
      lastUse: ++this.useSequence,
      loadStartedAt: undefined,
      state: 'idle',
      refs: 0,
      asset: undefined,
      error: undefined,
      waiters: [],
      depHandles: [],
      depsReady: false,
      depsAbort: null,
      abort: null,
      graceTimer: undefined,
      graceGen: 0,
      priority: 'low',
      attempts: 0,
      waiting: false,
      retryTimer: undefined,
      disposed,
      markDisposed,
    };
    this.records.set(id, r);
    return r;
  }

  private handle(r: LoadRecord): AssetHandle {
    let released = false;
    return {
      id: r.id,
      asset: r.asset,
      release: () => {
        if (released) {
          this.warn(`AssetHandle.release() called twice for ${r.id}`);
          return;
        }
        released = true;
        this.release(r);
      },
    };
  }

  private groupHandle(ids: readonly AssetId[], handles: AssetHandle[]): GroupHandle {
    let released = false;
    return {
      ids: [...ids],
      handles,
      release: () => {
        if (released) {
          this.warn(`GroupHandle.release() called twice for [${ids.join(', ')}]`);
          return;
        }
        released = true;
        releaseAll(handles);
      },
    };
  }

  private addWaiter(r: LoadRecord, signal: AbortSignal | undefined, sink: Sink): void {
    const waiter: Waiter = {
      resolve: (handle) => sink.resolve(handle),
      reject: (error) => sink.reject(error),
      detach: () => undefined,
    };
    if (signal !== undefined) {
      const onAbort = (): void => this.cancelWaiter(r, waiter, abortReason(signal));
      signal.addEventListener('abort', onAbort, { once: true });
      waiter.detach = () => signal.removeEventListener('abort', onAbort);
    }
    r.waiters.push(waiter);
  }

  /** A pending acquisition was aborted: reject it and give its reference back. */
  private cancelWaiter(r: LoadRecord, waiter: Waiter, reason: unknown): void {
    const i = r.waiters.indexOf(waiter);
    if (i < 0) return;
    r.waiters.splice(i, 1);
    waiter.detach();
    waiter.reject(reason);
    this.release(r);
  }

  private rejectWaiters(r: LoadRecord, error: unknown): void {
    const waiters = r.waiters;
    r.waiters = [];
    for (const waiter of waiters) {
      waiter.detach();
      waiter.reject(error);
    }
  }

  private release(r: LoadRecord): void {
    if (this.records.get(r.id) !== r) return; // evicted, or the loader was disposed
    r.refs = Math.max(0, r.refs - 1);
    if (r.refs > 0) return;
    switch (r.state) {
      case 'loaded':
        this.startGrace(r);
        return;
      case 'queued':
        removeId(this.high, r.id);
        removeId(this.low, r.id);
        if (r.waiting) this.clearTimer(r.retryTimer);
        r.state = 'disposing';
        this.rejectWaiters(r, abortError(`acquisition of ${r.id} was released`));
        this.releaseDeps(r);
        this.evict(r);
        return;
      case 'loading':
        r.state = 'disposing'; // finishOk/finishErr dispose and evict
        r.abort?.abort();
        return;
      default:
        return; // 'grace': timer already running; nothing is held otherwise
    }
  }

  private startGrace(r: LoadRecord): void {
    r.state = 'grace';
    const gen = ++r.graceGen;
    r.graceTimer = this.setTimer(() => this.expire(r, gen), this.unloadGraceMs);
    this.enforceMemoryBudget();
  }

  private cancelGrace(r: LoadRecord): void {
    r.graceGen += 1;
    const timer = r.graceTimer;
    r.graceTimer = undefined;
    this.clearTimer(timer);
  }

  private expire(r: LoadRecord, gen: number): void {
    if (this.records.get(r.id) !== r || r.graceGen !== gen) return;
    if (r.refs > 0 || r.state !== 'grace') return;
    r.state = 'disposing';
    r.graceTimer = undefined;
    const asset = r.asset;
    r.asset = undefined;
    this.disposeAsset(r, asset);
    this.releaseDeps(r); // deps then get their own grace period
    this.evict(r);
    this.events.emit('unloaded', { id: r.id });
    this.reportMemory();
  }

  /** Cancels pending dep acquisitions and releases the dep handles held. */
  private releaseDeps(r: LoadRecord): void {
    const pending = r.depsAbort;
    r.depsAbort = null;
    pending?.abort();
    const handles = r.depHandles;
    r.depHandles = [];
    r.depsReady = false;
    releaseAll(handles);
  }

  private evict(r: LoadRecord): void {
    if (this.records.get(r.id) === r) this.records.delete(r.id);
    r.markDisposed();
  }

  private disposeAsset(r: LoadRecord, asset: unknown): void {
    try {
      r.backend.dispose(asset);
    } catch (error) {
      this.warn(`dispose of asset ${r.id} threw: ${String(error)}`);
    } finally {
      this.resourceLedger.delete(r);
    }
  }

  /** Moves a queued low record, and its queued low deps, to the end of the high queue. */
  private promote(r: LoadRecord): void {
    for (const id of [...depsOf(this.manifest, r.id), r.id]) {
      const rec = this.records.get(id);
      if (rec?.state !== 'queued' || rec.priority !== 'low') continue;
      removeId(this.low, id);
      this.high.push(id);
      rec.priority = 'high';
    }
  }

  /**
   * Acquires every transitive dep of `r` at `priority`. When the last one resolves, `r` becomes
   * ready and the scheduler runs; the first failure fails `r` (which cancels or releases the rest).
   */
  private acquireDeps(r: LoadRecord, priority: Priority): void {
    const ids = depsOf(this.manifest, r.id);
    if (ids.length === 0) {
      r.depsReady = true;
      return;
    }
    // A cycle through `r` (an unvalidated manifest) would leave both ends waiting forever.
    const closing = ids.find((id) => {
      const entry = Object.hasOwn(this.manifest.assets, id) ? this.manifest.assets[id] : undefined;
      return entry?.deps?.includes(r.id) === true;
    });
    if (closing !== undefined) {
      this.fail(
        r,
        new Error(`dependency cycle: ${r.id} depends on ${closing}, which depends on ${r.id}`),
      );
      return;
    }
    const abort = new AbortController();
    r.depsAbort = abort;
    r.depHandles = [];
    let pending = ids.length;
    const current = (): boolean => r.depsAbort === abort && this.records.get(r.id) === r;
    for (const id of ids) {
      if (!current()) return; // a dep failed synchronously and already failed `r`
      this.acquireInto(id, priority, abort.signal, {
        resolve: (handle) => {
          if (!current()) {
            handle.release();
            return;
          }
          r.depHandles.push(handle);
          pending -= 1;
          if (pending > 0) return;
          r.depsAbort = null;
          r.depsReady = true;
          this.pump();
        },
        reject: (error) => {
          if (!current()) return; // cancelled by `r` going away or by an earlier failure
          this.fail(r, toError(error));
          this.pump();
        },
      });
    }
  }

  private pump(): void {
    if (this.disposed) return;
    while (this.inFlight.size < this.maxConcurrent) {
      const r = this.takeReady(this.high) ?? this.takeReady(this.low);
      if (r === undefined) return;
      this.start(r);
    }
  }

  /** Removes and returns the first queued record whose deps are loaded. */
  private takeReady(queue: AssetId[]): LoadRecord | undefined {
    for (let i = 0; i < queue.length; i++) {
      const r = this.records.get(queue[i] ?? '');
      if (r === undefined || r.state !== 'queued') {
        queue.splice(i, 1); // stale entry (defensive)
        i -= 1;
      } else if (r.depsReady && !r.waiting) {
        queue.splice(i, 1);
        return r;
      }
    }
    return undefined;
  }

  private start(r: LoadRecord): void {
    r.loadStartedAt =
      this.diagnostics === undefined ? undefined : diagnosticNow(this.diagnostics.now ?? assetNow);
    this.inFlight.add(r.id);
    r.state = 'loading';
    this.reportMemory();
    const abort = new AbortController();
    r.abort = abort;
    const ctx: BackendContext = {
      loader: this,
      id: r.id,
      verify: this.verifyHashes,
      fetch: this.fetchFn,
      progress: (loaded, total) => {
        if (r.abort === abort && r.state === 'loading' && !abort.signal.aborted) {
          this.events.emit('progress', { id: r.id, loaded, total });
        }
      },
    };
    this.events.emit('progress', { id: r.id, loaded: 0, total: r.entry.size || 1 });
    let pending: Promise<unknown>;
    try {
      const url = resolveUrl(this.manifest, r.id);
      pending = Promise.resolve(r.backend.load(url, r.entry, abort.signal, ctx));
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      (asset) => this.finishOk(r, abort, asset),
      (error: unknown) => this.finishErr(r, abort, error),
    );
  }

  private finishOk(r: LoadRecord, abort: AbortController, asset: unknown): void {
    this.reportLoad(r, false);
    const current = this.records.get(r.id) === r && r.abort === abort;
    if (current) this.inFlight.delete(r.id);
    if (!current || abort.signal.aborted) {
      this.disposeAsset(r, asset);
      this.discard(r);
      return;
    }
    r.abort = null;
    r.asset = asset;
    try {
      this.resourceLedger.set(
        r,
        r.backend.estimate?.(asset, r.entry) ?? {
          resources: [{ identity: r, cpuBytes: null, gpuBytes: null, retainedSourceBytes: null }],
        },
      );
    } catch {
      this.estimateErrors++;
      this.resourceLedger.set(r, {
        resources: [{ identity: r, cpuBytes: null, gpuBytes: null, retainedSourceBytes: null }],
      });
    }
    r.state = 'loaded';
    const total = r.entry.size || 1;
    this.events.emit('progress', { id: r.id, loaded: total, total });
    this.events.emit('loaded', { id: r.id });
    const waiters = r.waiters;
    r.waiters = [];
    for (const waiter of waiters) {
      waiter.detach();
      waiter.resolve(this.handle(r));
    }
    // Released while loading without an abort cannot happen; defensive.
    if (r.refs === 0 && r.state === 'loaded' && this.records.get(r.id) === r) this.startGrace(r);
    this.enforceMemoryBudget();
    this.pump();
  }

  private finishErr(r: LoadRecord, abort: AbortController, error: unknown): void {
    this.reportLoad(r, true);
    const current = this.records.get(r.id) === r && r.abort === abort;
    if (current) this.inFlight.delete(r.id);
    if (!current || abort.signal.aborted) {
      this.discard(r);
      return;
    }
    if (r.attempts < this.retries && transientError(error)) this.retry(r, toError(error));
    else this.fail(r, toError(error));
    this.pump();
  }

  /**
   * A load that failed for a reason that may pass, queued again behind a wait that doubles each
   * time (`retryMs`). It stays queued meanwhile: its waiters wait on, a release dequeues it.
   */
  private retry(r: LoadRecord, error: Error): void {
    const delayMs = this.retryMs * 2 ** r.attempts;
    r.attempts += 1;
    r.abort = null;
    r.state = 'queued';
    r.waiting = true;
    (r.priority === 'high' ? this.high : this.low).push(r.id);
    r.retryTimer = this.setTimer(() => {
      if (this.records.get(r.id) !== r || !r.waiting) return;
      r.waiting = false;
      r.retryTimer = undefined;
      this.pump();
    }, delayMs);
    this.events.emit('retrying', { id: r.id, error, attempt: r.attempts, delayMs });
  }

  /** Ends an aborted load: nothing is emitted, deps are released, the record is evicted. */
  private discard(r: LoadRecord): void {
    this.rejectWaiters(r, abortError(`load of ${r.id} was aborted`));
    this.releaseDeps(r);
    this.evict(r);
    this.pump();
  }

  /** Callers hold no handle on error; they retry with `acquire`. */
  private fail(r: LoadRecord, error: Error): void {
    removeId(this.high, r.id);
    removeId(this.low, r.id);
    const waiters = r.waiters;
    r.waiters = [];
    r.state = 'error';
    r.error = error;
    r.abort = null;
    r.refs = 0;
    this.releaseDeps(r);
    this.events.emit('error', { id: r.id, error });
    for (const waiter of waiters) {
      waiter.detach();
      waiter.reject(error);
    }
  }
}
