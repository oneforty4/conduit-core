import type { AssetId, AssetLoader, GroupHandle, Manifest, Priority } from '@conduit/assets';
import type { RegionSetPayload } from '@conduit/protocol';
import { type RegionId, stringCompare } from '@conduit/world';
import { consoleLog, type LogFn, REGION_RELEASE_GRACE_MS } from './constants.ts';

export type RegionClientEvent = 'regionLoaded' | 'regionUnloaded';

/** The timers `RegionClient` schedules its release grace with; `NetClient`'s `ClientTimers` fit. */
export interface RegionClientTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RegionClientOptions {
  /**
   * Receives the sorted loaded and loading sets after every `apply`, every group completion (or
   * failure) and every release after the grace; `NetClient.reportRegions` sends each as
   * RegionLoadState.
   */
  report: (loaded: RegionId[], loading: RegionId[]) => void;
  /**
   * Loads each region's asset group (docs/assets.md 3). Streaming needs both `loader` and
   * `manifest`. Without them (one alone logs a warning) every listed region counts as loaded at
   * once and a region dropped from the set is released at once: the M1 behaviour.
   */
  loader?: AssetLoader | undefined;
  /** `regions[id]` lists region `id`'s asset ids; a region without an entry has no assets. */
  manifest?: Manifest | undefined;
  /** Schedules `REGION_RELEASE_GRACE_MS`; default the global timers. */
  timers?: RegionClientTimers | undefined;
  log?: LogFn | undefined;
}

/** One `acquireGroup` call. Aborting `abort` before it settles gives its references back. */
interface PendingGroup {
  readonly priority: Priority;
  readonly abort: AbortController;
}

/** A region the client holds (docs/net.md B.8). */
interface HeldRegion {
  readonly id: RegionId;
  /** `manifest.regions[id]`; empty when the region has no assets or there is no loader. */
  readonly assets: readonly AssetId[];
  status: 'loading' | 'loaded';
  /** The acquisition whose outcome counts; `null` once it settled, and always without assets. */
  pending: PendingGroup | null;
  /** The loaded group, released with the region; `null` without assets or after a failure. */
  handle: GroupHandle | null;
  /** The pending release while the region is not listed. */
  releaseTimer: { handle: unknown } | null;
}

const defaultTimers: RegionClientTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0]),
};

function sortedUnique(ids: readonly RegionId[]): RegionId[] {
  return [...new Set(ids)].sort(stringCompare);
}

function byId(a: HeldRegion, b: HeldRegion): number {
  return stringCompare(a.id, b.id);
}

/**
 * Holds the regions of the latest RegionSet and loads their asset groups (docs/net.md B.8).
 *
 * With a loader and a manifest, each region acquires `manifest.regions[id]` as one group: active
 * regions at `'high'`, prefetch regions at `'low'`. A prefetch region still loading that becomes
 * active is acquired again at `'high'`, which is how the loader promotes its queued members, and
 * the `'low'` acquisition is handed back. A region counts as loaded once its group resolves, and
 * also when the group fails (with one warning), so a missing asset never blocks play. A region
 * dropped from the set is released `REGION_RELEASE_GRACE_MS` later unless it is listed again first.
 *
 * `regionLoaded` fires once when a region becomes loaded; `regionUnloaded` fires when a held region
 * is released, whether or not it finished loading.
 */
export class RegionClient {
  private readonly reportFn: (loaded: RegionId[], loading: RegionId[]) => void;
  private readonly streaming: { readonly loader: AssetLoader; readonly manifest: Manifest } | null;
  private readonly timers: RegionClientTimers;
  private readonly log: LogFn;
  private readonly held = new Map<RegionId, HeldRegion>();
  private readonly listeners: Record<RegionClientEvent, Set<(id: RegionId) => void>> = {
    regionLoaded: new Set(),
    regionUnloaded: new Set(),
  };

  constructor(opts: RegionClientOptions) {
    this.reportFn = opts.report;
    this.log = opts.log ?? consoleLog;
    this.timers = opts.timers ?? defaultTimers;
    const { loader, manifest } = opts;
    this.streaming = loader !== undefined && manifest !== undefined ? { loader, manifest } : null;
    if (this.streaming === null && (loader !== undefined || manifest !== undefined)) {
      const given =
        loader === undefined ? 'a manifest without a loader' : 'a loader without a manifest';
      this.log('warn', `RegionClient: ${given}; every region counts as loaded at once`);
    }
  }

  /**
   * Applies a RegionSet, then reports once. New regions start loading (or are loaded at once when
   * they have no assets); a listed region still loading at `'low'` that is now active is promoted;
   * held regions no longer listed are released after `REGION_RELEASE_GRACE_MS` (at once without a
   * loader), and listing one again before that cancels its release.
   */
  apply(set: RegionSetPayload): void {
    const active = sortedUnique(set.active);
    const activeSet = new Set(active);
    const prefetch = sortedUnique(set.prefetch).filter((id) => !activeSet.has(id));
    const listed = new Set([...active, ...prefetch]);
    const loadedNow: RegionId[] = [];
    // Active regions first: their members join the loader's high queue before prefetch ones are
    // queued behind them.
    for (const id of active) this.ensure(id, 'high', loadedNow);
    for (const id of prefetch) this.ensure(id, 'low', loadedNow);
    const releasedNow: HeldRegion[] = [];
    for (const r of this.held.values()) {
      if (listed.has(r.id)) this.cancelRelease(r);
      else if (this.streaming === null) releasedNow.push(r);
      else if (r.releaseTimer === null) this.scheduleRelease(r);
    }
    for (const r of releasedNow) this.drop(r);
    loadedNow.sort(stringCompare);
    releasedNow.sort(byId);
    for (const id of loadedNow) this.emit('regionLoaded', id);
    for (const r of releasedNow) this.emit('regionUnloaded', r.id);
    this.report();
  }

  /** Loaded regions (including failed groups and regions awaiting release), ascending. */
  loaded(): RegionId[] {
    return this.withStatus('loaded');
  }

  /** Regions whose asset group is still loading, ascending. */
  loading(): RegionId[] {
    return this.withStatus('loading');
  }

  on(evt: RegionClientEvent, cb: (id: RegionId) => void): () => void {
    const set = this.listeners[evt];
    const listener = (id: RegionId): void => cb(id);
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  /**
   * Releases every region at once without reporting (disconnect, not resync): clears release
   * timers, cancels loads in flight, releases loaded groups, then emits `regionUnloaded` for each.
   */
  reset(): void {
    const regions = [...this.held.values()].sort(byId);
    for (const r of regions) this.drop(r);
    for (const r of regions) this.emit('regionUnloaded', r.id);
  }

  private ensure(id: RegionId, priority: Priority, loadedNow: RegionId[]): void {
    const held = this.held.get(id);
    if (held !== undefined) {
      // Listed again. A group still loading at 'low' is promoted; nothing is ever demoted.
      const pending = held.pending;
      if (priority === 'high' && pending !== null && pending.priority === 'low') {
        this.promote(held, pending);
      }
      return;
    }
    const assets = this.assetsOf(id);
    const r: HeldRegion = {
      id,
      assets,
      status: 'loaded',
      pending: null,
      handle: null,
      releaseTimer: null,
    };
    this.held.set(id, r);
    if (this.streaming === null || assets.length === 0) {
      loadedNow.push(id);
      return;
    }
    r.status = 'loading';
    this.acquire(r, this.streaming.loader, priority);
  }

  private assetsOf(id: RegionId): readonly AssetId[] {
    if (this.streaming === null) return [];
    const regions = this.streaming.manifest.regions;
    return Object.hasOwn(regions, id) ? (regions[id] ?? []) : [];
  }

  /** Acquires `r`'s group at `priority` as `r.pending`. */
  private acquire(r: HeldRegion, loader: AssetLoader, priority: Priority): void {
    const pending: PendingGroup = { priority, abort: new AbortController() };
    r.pending = pending;
    let group: Promise<GroupHandle>;
    try {
      group = loader.acquireGroup(r.assets, priority, pending.abort.signal);
    } catch (err) {
      group = Promise.reject(err);
    }
    void group
      .then(
        (handle) => this.onGroupLoaded(r, pending, handle),
        (err: unknown) => this.onGroupFailed(r, pending, err),
      )
      .catch((err: unknown) => {
        this.log('error', `region ${r.id}: handling its asset group outcome threw`, {
          region: r.id,
          err,
        });
      });
  }

  /** Whether `pending` is still the acquisition that decides `r`'s status. */
  private isCurrent(r: HeldRegion, pending: PendingGroup): boolean {
    return this.held.get(r.id) === r && r.pending === pending;
  }

  private onGroupLoaded(r: HeldRegion, pending: PendingGroup, handle: GroupHandle): void {
    if (!this.isCurrent(r, pending)) {
      // Released, reset or promoted meanwhile: this acquisition's references go back.
      handle.release();
      return;
    }
    r.pending = null;
    r.handle = handle;
    this.markLoaded(r);
  }

  private onGroupFailed(r: HeldRegion, pending: PendingGroup, err: unknown): void {
    if (!this.isCurrent(r, pending)) return; // our own abort (release, reset or promotion)
    r.pending = null;
    // Reported loaded so the player is not stuck; missing models render as placeholders.
    this.log('warn', `region ${r.id}: asset group failed to load; reporting it loaded`, {
      region: r.id,
      err,
    });
    this.markLoaded(r);
  }

  private markLoaded(r: HeldRegion): void {
    r.status = 'loaded';
    this.emit('regionLoaded', r.id);
    this.report();
  }

  /**
   * A prefetch region still loading became active. Acquiring its group at `'high'` takes a
   * reference on every member at once (docs/assets.md 3.1) and makes the loader move each queued
   * `'low'` member, with its queued `'low'` deps, to the high queue (3.2); members already loading
   * keep their slot. Aborting the `'low'` acquisition afterwards gives its references back without
   * dequeuing or aborting anything, since the `'high'` one holds every member.
   */
  private promote(r: HeldRegion, low: PendingGroup): void {
    if (this.streaming === null) return;
    this.acquire(r, this.streaming.loader, 'high');
    low.abort.abort();
  }

  private scheduleRelease(r: HeldRegion): void {
    const timer: { handle: unknown } = { handle: null };
    r.releaseTimer = timer;
    timer.handle = this.timers.setTimeout(() => {
      if (this.held.get(r.id) !== r || r.releaseTimer !== timer) return;
      r.releaseTimer = null;
      this.drop(r);
      this.emit('regionUnloaded', r.id);
      this.report();
    }, REGION_RELEASE_GRACE_MS);
  }

  private cancelRelease(r: HeldRegion): void {
    const timer = r.releaseTimer;
    if (timer === null) return;
    r.releaseTimer = null;
    this.timers.clearTimeout(timer.handle);
  }

  /** Forgets `r`: clears its release timer, cancels a load in flight, releases a loaded group. */
  private drop(r: HeldRegion): void {
    if (this.held.get(r.id) === r) this.held.delete(r.id);
    this.cancelRelease(r);
    const pending = r.pending;
    const handle = r.handle;
    r.pending = null;
    r.handle = null;
    // Members nobody else holds are dequeued or have their backend load aborted (docs/assets.md 3.1).
    pending?.abort.abort();
    // Loaded members enter the loader's own unload grace.
    handle?.release();
  }

  private withStatus(status: HeldRegion['status']): RegionId[] {
    const out: RegionId[] = [];
    for (const r of this.held.values()) if (r.status === status) out.push(r.id);
    return out.sort(stringCompare);
  }

  private report(): void {
    this.reportFn(this.loaded(), this.loading());
  }

  private emit(evt: RegionClientEvent, id: RegionId): void {
    for (const listener of [...this.listeners[evt]]) {
      try {
        listener(id);
      } catch (err) {
        this.log('error', `${evt} listener threw`, { region: id, err });
      }
    }
  }
}
