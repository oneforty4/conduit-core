import type {
  AssetBackend,
  AssetEntry,
  AssetLoaderOptions,
  AssetType,
  BackendContext,
  Manifest,
} from '../src/index.ts';

/** A syntactically valid SRI; the loader never checks it unless `verifyHashes` is set. */
export const HASH = `sha256-${'A'.repeat(43)}=` as const;

/** A manifest whose assets are `binary` (or `types[id]`), sized 10, 20, 30, ... bytes. */
export function manifestOf(
  ids: readonly string[],
  deps: Readonly<Record<string, string[]>> = {},
  types: Readonly<Record<string, AssetType>> = {},
): Manifest {
  const assets: Record<string, AssetEntry> = {};
  ids.forEach((id, i) => {
    const entry: AssetEntry = {
      type: types[id] ?? 'binary',
      url: `${id}.bin`,
      hash: HASH,
      size: 10 * (i + 1),
    };
    const list = deps[id];
    if (list !== undefined) entry.deps = list;
    assets[id] = entry;
  });
  return { version: 1, baseUrl: '/assets/', assets, groups: {}, regions: {} };
}

export interface PendingLoad {
  id: string;
  url: string;
  entry: AssetEntry;
  signal: AbortSignal;
  ctx: BackendContext;
  resolve(asset: unknown): void;
  reject(error: unknown): void;
}

/** Backend whose loads settle only when the test says so; records calls and disposals. */
export class ManualBackend implements AssetBackend<unknown> {
  readonly type: AssetType;
  readonly loads: PendingLoad[] = [];
  readonly disposed: unknown[] = [];

  constructor(type: AssetType = 'binary') {
    this.type = type;
  }

  load(url: string, entry: AssetEntry, signal: AbortSignal, ctx: BackendContext): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.loads.push({ id: ctx.id, url, entry, signal, ctx, resolve, reject });
    });
  }

  dispose(asset: unknown): void {
    this.disposed.push(asset);
  }

  /** Asset ids in backend call order. */
  get order(): string[] {
    return this.loads.map((load) => load.id);
  }

  /** The latest load of `id`. */
  last(id: string): PendingLoad {
    const load = this.loads.filter((l) => l.id === id).pop();
    if (load === undefined) throw new Error(`no load of ${id} (calls: ${this.order.join(', ')})`);
    return load;
  }

  resolve(id: string, asset: unknown = `asset:${id}`): void {
    this.last(id).resolve(asset);
  }
}

/** `setTimer`/`clearTimer` whose callbacks run only when the test fires them. */
export class ManualTimers {
  readonly active = new Map<number, { fn: () => void; ms: number }>();
  readonly cleared: unknown[] = [];
  private nextId = 1;

  readonly setTimer = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.active.set(id, { fn, ms });
    return id;
  };

  readonly clearTimer = (handle: unknown): void => {
    this.cleared.push(handle);
    this.active.delete(handle as number);
  };

  /** Runs every pending timer once (timers they schedule stay pending); returns how many ran. */
  fireAll(): number {
    const due = [...this.active.values()];
    this.active.clear();
    for (const timer of due) timer.fn();
    return due.length;
  }

  /** Loader options wiring these timers in. */
  options(extra: AssetLoaderOptions = {}): AssetLoaderOptions {
    return { setTimer: this.setTimer, clearTimer: this.clearTimer, ...extra };
  }
}

/** Lets every queued promise callback run (the loader chains several per acquisition). */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Records loader events as `'<event> <id>'` strings. */
export function recordEvents(loader: {
  on(evt: 'loaded' | 'unloaded' | 'error', cb: (e: { id: string }) => void): () => void;
}): string[] {
  const events: string[] = [];
  for (const evt of ['loaded', 'unloaded', 'error'] as const) {
    loader.on(evt, (e) => events.push(`${evt} ${e.id}`));
  }
  return events;
}
