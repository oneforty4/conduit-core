import {
  type AssetBackend,
  type AssetEntry,
  AssetLoader,
  type AssetLoaderOptions,
  type BackendContext,
  type GroupHandle,
  type Manifest,
  type Priority,
} from '@conduit/assets';
import { describe, expect, it, vi } from 'vitest';
import {
  type LogLevel,
  MemoryTransport,
  NetClient,
  REGION_RELEASE_GRACE_MS,
  RegionClient,
} from '../src/index.ts';
import { ManualTimers, ScriptedServer, testGame, testRegistry } from './helpers.ts';

const HASH = `sha256-${'A'.repeat(43)}=` as const;

/** A manifest with this region table; each asset it names is a `binary` entry unless `missing`. */
function manifestOf(regions: Record<string, string[]>, missing: readonly string[] = []): Manifest {
  const assets: Record<string, AssetEntry> = {};
  for (const id of Object.values(regions).flat()) {
    if (!missing.includes(id)) {
      assets[id] = { type: 'binary', url: `${id}.bin`, hash: HASH, size: 10 };
    }
  }
  return { version: 1, baseUrl: '/assets/', assets, groups: {}, regions };
}

interface BackendLoad {
  readonly id: string;
  readonly signal: AbortSignal;
  resolve(asset: unknown): void;
  reject(err: unknown): void;
}

/** A `binary` backend whose loads settle when the test says so; an aborted load rejects. */
class ManualBackend implements AssetBackend<unknown> {
  readonly type = 'binary';
  readonly loads: BackendLoad[] = [];
  readonly disposed: unknown[] = [];

  load(
    _url: string,
    _entry: AssetEntry,
    signal: AbortSignal,
    ctx: BackendContext,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.loads.push({ id: ctx.id, signal, resolve, reject });
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }

  dispose(asset: unknown): void {
    this.disposed.push(asset);
  }

  /** Asset ids in backend call order. */
  get order(): string[] {
    return this.loads.map((l) => l.id);
  }

  last(id: string): BackendLoad {
    const load = this.loads.filter((l) => l.id === id).at(-1);
    if (load === undefined) throw new Error(`no load of ${id} (calls: ${this.order.join(', ')})`);
    return load;
  }

  resolve(id: string): void {
    this.last(id).resolve({ asset: id });
  }

  fail(id: string): void {
    this.last(id).reject(new Error(`HTTP 404 for ${id}`));
  }
}

/** Lets the loader's promise chains run to the end. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Loader options that run the loader's unload grace on `timers`. */
function loaderTimers(timers: ManualTimers): AssetLoaderOptions {
  return {
    setTimer: (fn, ms) => timers.setTimeout(fn, ms),
    clearTimer: (handle) => timers.clearTimeout(handle),
  };
}

interface Logged {
  level: LogLevel;
  msg: string;
  data: object | undefined;
}

interface Report {
  loaded: string[];
  loading: string[];
}

function setup(
  regions: Record<string, string[]>,
  opts: { maxConcurrent?: number; missing?: string[] } = {},
) {
  /** The RegionClient's release grace only. */
  const timers = new ManualTimers();
  /** The loader's own unload grace, kept apart so `timers.pending()` counts RegionClient timers. */
  const loaderClock = new ManualTimers();
  const backend = new ManualBackend();
  const manifest = manifestOf(regions, opts.missing);
  const loader = new AssetLoader(manifest, [backend], {
    ...loaderTimers(loaderClock),
    maxConcurrent: opts.maxConcurrent ?? 6,
  });
  const acquireGroup = vi.spyOn(loader, 'acquireGroup');
  const reports: Report[] = [];
  const events: string[] = [];
  const logs: Logged[] = [];
  const client = new RegionClient({
    loader,
    manifest,
    timers,
    report: (loaded, loading) => reports.push({ loaded, loading }),
    log: (level, msg, data) => logs.push({ level, msg, data }),
  });
  client.on('regionLoaded', (id) => events.push(`loaded ${id}`));
  client.on('regionUnloaded', (id) => events.push(`unloaded ${id}`));
  /** `[ids, priority]` of every `acquireGroup` call, in order. */
  const acquisitions = (): [readonly string[], Priority | undefined][] =>
    acquireGroup.mock.calls.map(([ids, priority]) => [ids, priority]);
  return { timers, loaderClock, backend, loader, client, reports, events, logs, acquisitions };
}

interface FakeAcquisition {
  readonly ids: readonly string[];
  readonly priority: Priority;
  readonly signal: AbortSignal;
  resolve(handle: GroupHandle): void;
  reject(err: unknown): void;
}

/** An `acquireGroup` whose outcome the test decides, whatever happens to its signal. */
class FakeLoader {
  readonly calls: FakeAcquisition[] = [];

  acquireGroup(
    ids: readonly string[],
    priority: Priority,
    signal: AbortSignal,
  ): Promise<GroupHandle> {
    return new Promise((resolve, reject) => {
      this.calls.push({ ids, priority, signal, resolve, reject });
    });
  }
}

function fakeHandle(ids: readonly string[]) {
  return { ids, handles: [], release: vi.fn<() => void>() };
}

describe('RegionClient', () => {
  it.each([
    ['neither a loader nor a manifest', false, false],
    ['a loader without a manifest', true, false],
    ['a manifest without a loader', false, true],
  ] as const)(
    'with %s every listed region is loaded at once and a dropped one is released at once (M1)',
    (_name, withLoader, withManifest) => {
      const timers = new ManualTimers();
      const manifest = manifestOf({ 'cell/0_0': ['road'] });
      const loader = new AssetLoader(manifest, [new ManualBackend()], loaderTimers(timers));
      const acquireGroup = vi.spyOn(loader, 'acquireGroup');
      const reports: Report[] = [];
      const events: string[] = [];
      const logs: Logged[] = [];
      const client = new RegionClient({
        loader: withLoader ? loader : undefined,
        manifest: withManifest ? manifest : undefined,
        timers,
        report: (loaded, loading) => reports.push({ loaded, loading }),
        log: (level, msg, data) => logs.push({ level, msg, data }),
      });
      client.on('regionLoaded', (id) => events.push(`loaded ${id}`));
      client.on('regionUnloaded', (id) => events.push(`unloaded ${id}`));

      client.apply({ active: ['cell/1_1', 'cell/0_0'], prefetch: ['cell/2_2'] });
      expect(events).toEqual(['loaded cell/0_0', 'loaded cell/1_1', 'loaded cell/2_2']);
      expect(reports).toEqual([{ loaded: ['cell/0_0', 'cell/1_1', 'cell/2_2'], loading: [] }]);
      expect(client.loading()).toEqual([]);

      client.apply({ active: ['cell/1_1'], prefetch: [] });
      expect(events.slice(3)).toEqual(['unloaded cell/0_0', 'unloaded cell/2_2']);
      expect(reports.at(-1)).toEqual({ loaded: ['cell/1_1'], loading: [] });
      expect(timers.pending()).toBe(0);
      expect(acquireGroup).not.toHaveBeenCalled();
      // Half a configuration is a mistake worth one warning; nothing else is logged.
      expect(logs.map((l) => l.level)).toEqual(withLoader === withManifest ? [] : ['warn']);
    },
  );

  it("acquires active groups at 'high' and prefetch groups at 'low', reporting on apply and on each group completion", async () => {
    const h = setup(
      {
        'cell/0_0': ['road', 'crate'],
        'cell/1_1': [],
        'cell/0_1': ['tree'],
        'cell/1_0': ['bush'],
      },
      { maxConcurrent: 1 },
    );
    h.client.apply({
      active: ['cell/1_1', 'cell/0_0'],
      prefetch: ['cell/2_2', 'cell/1_0', 'cell/0_1'],
    });
    expect(h.acquisitions()).toEqual([
      [['road', 'crate'], 'high'],
      [['tree'], 'low'],
      [['bush'], 'low'],
    ]);
    // Regions without assets (an empty list, or no entry at all) count as loaded at once.
    expect(h.events).toEqual(['loaded cell/1_1', 'loaded cell/2_2']);
    expect(h.reports).toEqual([
      { loaded: ['cell/1_1', 'cell/2_2'], loading: ['cell/0_0', 'cell/0_1', 'cell/1_0'] },
    ]);
    expect(h.client.loaded()).toEqual(['cell/1_1', 'cell/2_2']);
    expect(h.client.loading()).toEqual(['cell/0_0', 'cell/0_1', 'cell/1_0']);
    expect(h.backend.order).toEqual(['road']);

    h.backend.resolve('road');
    await settle();
    expect(h.backend.order).toEqual(['road', 'crate']); // the active group before any prefetch
    expect(h.reports).toHaveLength(1); // a group reports once, when it completes

    h.backend.resolve('crate');
    await settle();
    expect(h.backend.order).toEqual(['road', 'crate', 'tree']);
    expect(h.events.at(-1)).toBe('loaded cell/0_0');
    expect(h.reports.at(-1)).toEqual({
      loaded: ['cell/0_0', 'cell/1_1', 'cell/2_2'],
      loading: ['cell/0_1', 'cell/1_0'],
    });

    h.backend.resolve('tree');
    await settle();
    h.backend.resolve('bush');
    await settle();
    expect(h.events).toEqual([
      'loaded cell/1_1',
      'loaded cell/2_2',
      'loaded cell/0_0',
      'loaded cell/0_1',
      'loaded cell/1_0',
    ]);
    expect(h.reports.slice(2)).toEqual([
      { loaded: ['cell/0_0', 'cell/0_1', 'cell/1_1', 'cell/2_2'], loading: ['cell/1_0'] },
      { loaded: ['cell/0_0', 'cell/0_1', 'cell/1_0', 'cell/1_1', 'cell/2_2'], loading: [] },
    ]);
    for (const id of ['road', 'crate', 'tree', 'bush']) expect(h.loader.refcount(id)).toBe(1);

    // A loaded prefetch region that becomes active needs nothing new.
    h.client.apply({ active: ['cell/0_1'], prefetch: ['cell/0_0'] });
    expect(h.acquisitions()).toHaveLength(3);
    expect(h.reports.at(-1)).toEqual({
      loaded: ['cell/0_0', 'cell/0_1', 'cell/1_0', 'cell/1_1', 'cell/2_2'],
      loading: [],
    });
    expect(h.logs).toEqual([]);
  });

  it("promotes a prefetch region still loading when it becomes active: its queued members load before older 'low' ones", async () => {
    const h = setup(
      { 'cell/0_0': ['road'], 'cell/0_1': ['tree', 'bush'], 'cell/0_2': ['rock', 'crate'] },
      { maxConcurrent: 1 },
    );
    h.client.apply({ active: ['cell/0_0'], prefetch: ['cell/0_1', 'cell/0_2'] });
    expect(h.backend.order).toEqual(['road']);
    expect(h.loader.stats()).toEqual({ queuedHigh: 0, queuedLow: 4, inFlight: 1, loaded: 0 });

    h.client.apply({ active: ['cell/0_0', 'cell/0_2'], prefetch: ['cell/0_1'] });
    expect(h.acquisitions()).toEqual([
      [['road'], 'high'],
      [['tree', 'bush'], 'low'],
      [['rock', 'crate'], 'low'],
      [['rock', 'crate'], 'high'],
    ]);
    expect(h.loader.stats()).toEqual({ queuedHigh: 2, queuedLow: 2, inFlight: 1, loaded: 0 });
    // The 'low' acquisition gave its references back; the 'high' one holds each member once.
    expect(h.loader.refcount('rock')).toBe(1);
    expect(h.loader.refcount('crate')).toBe(1);
    expect(h.reports.at(-1)).toEqual({
      loaded: [],
      loading: ['cell/0_0', 'cell/0_1', 'cell/0_2'],
    });
    await settle();
    expect(h.events).toEqual([]);
    expect(h.logs).toEqual([]); // the cancelled 'low' acquisition is not a failure

    h.backend.resolve('road');
    await settle();
    expect(h.backend.order).toEqual(['road', 'rock']); // ahead of tree, queued earlier at 'low'
    h.backend.resolve('rock');
    await settle();
    h.backend.resolve('crate');
    await settle();
    expect(h.backend.order).toEqual(['road', 'rock', 'crate', 'tree']);
    expect(h.events).toEqual(['loaded cell/0_0', 'loaded cell/0_2']);
    expect(h.reports.at(-1)).toEqual({ loaded: ['cell/0_0', 'cell/0_2'], loading: ['cell/0_1'] });
    expect(h.loader.refcount('rock')).toBe(1);

    h.backend.resolve('tree');
    await settle();
    h.backend.resolve('bush');
    await settle();
    expect(h.events).toEqual(['loaded cell/0_0', 'loaded cell/0_2', 'loaded cell/0_1']);
    expect(h.reports).toHaveLength(5); // two RegionSets and three group completions
    expect(h.logs).toEqual([]);
  });

  it('promotion hands the references over without interrupting a member already loading', async () => {
    const h = setup({ 'cell/0_1': ['tree', 'bush'] }, { maxConcurrent: 1 });
    h.client.apply({ active: [], prefetch: ['cell/0_1'] });
    expect(h.loader.state('tree')).toBe('loading');
    expect(h.loader.state('bush')).toBe('queued');

    h.client.apply({ active: ['cell/0_1'], prefetch: [] });
    expect(h.acquisitions()).toEqual([
      [['tree', 'bush'], 'low'],
      [['tree', 'bush'], 'high'],
    ]);
    expect(h.backend.last('tree').signal.aborted).toBe(false);
    expect(h.loader.refcount('tree')).toBe(1);
    expect(h.loader.refcount('bush')).toBe(1);
    expect(h.loader.stats()).toEqual({ queuedHigh: 1, queuedLow: 0, inFlight: 1, loaded: 0 });

    h.backend.resolve('tree');
    await settle();
    h.backend.resolve('bush');
    await settle();
    expect(h.backend.order).toEqual(['tree', 'bush']); // each loaded once
    expect(h.events).toEqual(['loaded cell/0_1']);
    expect(h.client.loaded()).toEqual(['cell/0_1']);
    expect(h.loader.refcount('tree')).toBe(1);

    // Its release gives back exactly the references the region holds.
    h.client.apply({ active: [], prefetch: [] });
    h.timers.advance(REGION_RELEASE_GRACE_MS);
    expect(h.loader.refcount('tree')).toBe(0);
    expect(h.loader.refcount('bush')).toBe(0);
    expect(h.logs).toEqual([]);
  });

  it('keeps a dropped region for REGION_RELEASE_GRACE_MS from the RegionSet that dropped it; listing it again first cancels the release', async () => {
    const h = setup({ 'cell/0_0': ['road'], 'cell/0_1': ['tree'] });
    h.client.apply({ active: ['cell/0_0', 'cell/0_1'], prefetch: [] });
    h.backend.resolve('road');
    h.backend.resolve('tree');
    await settle();
    expect(h.client.loaded()).toEqual(['cell/0_0', 'cell/0_1']);

    h.client.apply({ active: ['cell/0_0'], prefetch: [] });
    expect(h.client.loaded()).toEqual(['cell/0_0', 'cell/0_1']);
    expect(h.reports.at(-1)).toEqual({ loaded: ['cell/0_0', 'cell/0_1'], loading: [] });
    h.timers.advance(3000);
    h.client.apply({ active: ['cell/0_0'], prefetch: [] }); // still dropped: the grace is not restarted
    h.timers.advance(REGION_RELEASE_GRACE_MS - 3000 - 1);
    expect(h.events).not.toContain('unloaded cell/0_1');
    const reports = h.reports.length;
    h.timers.advance(1);
    expect(h.events.at(-1)).toBe('unloaded cell/0_1');
    expect(h.client.loaded()).toEqual(['cell/0_0']);
    expect(h.reports).toHaveLength(reports + 1);
    expect(h.reports.at(-1)).toEqual({ loaded: ['cell/0_0'], loading: [] });
    expect(h.loader.refcount('tree')).toBe(0);
    expect(h.loader.state('tree')).toBe('grace'); // the loader's own unload grace stacks on top

    // Back soon after: a new acquisition, served from the loader's grace without a refetch.
    h.client.apply({ active: ['cell/0_0', 'cell/0_1'], prefetch: [] });
    expect(h.client.loading()).toEqual(['cell/0_1']);
    await settle();
    expect(h.events.at(-1)).toBe('loaded cell/0_1');
    expect(h.backend.order).toEqual(['road', 'tree']);

    // Dropped, then listed again (as prefetch) within the grace: nothing is released or re-acquired.
    h.client.apply({ active: ['cell/0_0'], prefetch: [] });
    h.timers.advance(REGION_RELEASE_GRACE_MS - 1);
    h.client.apply({ active: ['cell/0_0'], prefetch: ['cell/0_1'] });
    h.timers.advance(REGION_RELEASE_GRACE_MS * 2);
    expect(h.events.filter((e) => e === 'unloaded cell/0_1')).toHaveLength(1);
    expect(h.client.loaded()).toEqual(['cell/0_0', 'cell/0_1']);
    expect(h.acquisitions()).toHaveLength(3);
    expect(h.loader.refcount('tree')).toBe(1);
    expect(h.logs).toEqual([]);
  });

  it('releasing a region still loading cancels its load: queued members are dequeued, loading ones aborted, and it never counts as loaded', async () => {
    const h = setup({ 'cell/0_0': ['road'], 'cell/0_1': ['tree', 'bush'] }, { maxConcurrent: 1 });
    h.client.apply({ active: ['cell/0_0'], prefetch: ['cell/0_1'] });
    h.backend.resolve('road');
    await settle();
    expect(h.loader.state('tree')).toBe('loading');
    expect(h.loader.state('bush')).toBe('queued');

    h.client.apply({ active: ['cell/0_0'], prefetch: [] });
    expect(h.client.loading()).toEqual(['cell/0_1']); // held through the grace
    h.timers.advance(REGION_RELEASE_GRACE_MS);
    expect(h.events).toEqual(['loaded cell/0_0', 'unloaded cell/0_1']);
    expect(h.client.loading()).toEqual([]);
    expect(h.reports.at(-1)).toEqual({ loaded: ['cell/0_0'], loading: [] });
    expect(h.backend.last('tree').signal.aborted).toBe(true);
    expect(h.loader.state('bush')).toBe('idle');

    await settle();
    expect(h.loader.state('tree')).toBe('idle');
    expect(h.backend.order).toEqual(['road', 'tree']); // bush never started
    expect(h.loader.stats()).toEqual({ queuedHigh: 0, queuedLow: 0, inFlight: 0, loaded: 1 });
    expect(h.events).toEqual(['loaded cell/0_0', 'unloaded cell/0_1']);
    expect(h.logs).toEqual([]);
  });

  it('a group that fails is reported loaded with one warning and holds no references', async () => {
    const h = setup(
      { 'cell/0_0': ['road', 'sign', 'lamp'], 'cell/0_1': ['ghost'] },
      { missing: ['ghost'] },
    );
    h.client.apply({ active: ['cell/0_0', 'cell/0_1'], prefetch: [] });
    await settle();
    // `ghost` is not in the manifest's assets: that group fails at once.
    expect(h.events).toEqual(['loaded cell/0_1']);
    expect(h.reports.at(-1)).toEqual({ loaded: ['cell/0_1'], loading: ['cell/0_0'] });

    h.backend.resolve('road');
    h.backend.fail('sign'); // the group gives up at its first failure and cancels lamp
    await settle();
    expect(h.events).toEqual(['loaded cell/0_1', 'loaded cell/0_0']);
    expect(h.client.loaded()).toEqual(['cell/0_0', 'cell/0_1']);
    expect(h.reports.at(-1)).toEqual({ loaded: ['cell/0_0', 'cell/0_1'], loading: [] });
    expect(h.logs.map((l) => [l.level, l.data])).toEqual([
      ['warn', { region: 'cell/0_1', err: expect.any(RangeError) }],
      ['warn', { region: 'cell/0_0', err: expect.any(Error) }],
    ]);
    expect(h.backend.last('lamp').signal.aborted).toBe(true);
    await settle();
    for (const id of ['road', 'sign', 'lamp']) expect(h.loader.refcount(id)).toBe(0);

    // Released like any region: nothing to give back, and no second warning.
    h.client.apply({ active: [], prefetch: [] });
    h.timers.advance(REGION_RELEASE_GRACE_MS);
    expect(h.events.slice(2)).toEqual(['unloaded cell/0_0', 'unloaded cell/0_1']);
    expect(h.logs).toHaveLength(2);
  });

  it('reset() releases everything at once without reporting: loads cancelled, groups released, release timers cleared', async () => {
    const h = setup({ 'cell/0_0': ['road'], 'cell/0_1': ['tree'], 'cell/0_2': ['rock'] });
    h.client.apply({ active: ['cell/0_0', 'cell/0_1'], prefetch: ['cell/0_2'] });
    h.backend.resolve('road');
    h.backend.resolve('tree');
    await settle();
    h.client.apply({ active: ['cell/0_0'], prefetch: ['cell/0_2'] }); // cell/0_1 awaits release
    expect(h.timers.pending()).toBe(1);
    const reports = h.reports.length;
    const events = h.events.length;

    h.client.reset();
    expect(h.events.slice(events)).toEqual([
      'unloaded cell/0_0',
      'unloaded cell/0_1',
      'unloaded cell/0_2',
    ]);
    expect(h.client.loaded()).toEqual([]);
    expect(h.client.loading()).toEqual([]);
    expect(h.reports).toHaveLength(reports);
    expect(h.timers.pending()).toBe(0);
    expect(h.loader.refcount('road')).toBe(0);
    expect(h.loader.refcount('tree')).toBe(0);
    expect(h.backend.last('rock').signal.aborted).toBe(true);

    h.timers.advance(REGION_RELEASE_GRACE_MS);
    h.loaderClock.advance(REGION_RELEASE_GRACE_MS); // the loader's own unload grace
    await settle();
    expect(h.events).toHaveLength(events + 3);
    expect(h.reports).toHaveLength(reports);
    expect(h.loader.stats()).toEqual({ queuedHigh: 0, queuedLow: 0, inFlight: 0, loaded: 0 });

    // Usable again afterwards (a reconnect).
    h.client.apply({ active: ['cell/0_0'], prefetch: [] });
    h.backend.resolve('road');
    await settle();
    expect(h.client.loaded()).toEqual(['cell/0_0']);
    expect(h.logs).toEqual([]);
  });

  it('ignores outcomes it cancelled: a group resolving after its promotion or release is released at once', async () => {
    const fake = new FakeLoader();
    const reports: Report[] = [];
    const events: string[] = [];
    const logs: Logged[] = [];
    const client = new RegionClient({
      loader: fake as unknown as AssetLoader,
      manifest: manifestOf({ 'cell/0_0': ['road'], 'cell/0_1': ['tree'] }),
      timers: new ManualTimers(),
      report: (loaded, loading) => reports.push({ loaded, loading }),
      log: (level, msg, data) => logs.push({ level, msg, data }),
    });
    client.on('regionLoaded', (id) => events.push(`loaded ${id}`));
    client.on('regionUnloaded', (id) => events.push(`unloaded ${id}`));

    client.apply({ active: ['cell/0_0'], prefetch: ['cell/0_1'] });
    client.apply({ active: ['cell/0_0', 'cell/0_1'], prefetch: [] });
    const [road, treeLow, treeHigh] = fake.calls;
    expect(fake.calls.map((c) => [c.ids, c.priority])).toEqual([
      [['road'], 'high'],
      [['tree'], 'low'],
      [['tree'], 'high'],
    ]);
    expect(treeLow?.signal.aborted).toBe(true);
    expect(treeHigh?.signal.aborted).toBe(false);

    // The 'low' group resolves anyway (its members were already loaded): its handle goes back.
    const lowHandle = fakeHandle(['tree']);
    treeLow?.resolve(lowHandle);
    await settle();
    expect(lowHandle.release).toHaveBeenCalledTimes(1);
    expect(client.loading()).toEqual(['cell/0_0', 'cell/0_1']);
    expect(events).toEqual([]);

    const highHandle = fakeHandle(['tree']);
    treeHigh?.resolve(highHandle);
    await settle();
    expect(events).toEqual(['loaded cell/0_1']);
    expect(highHandle.release).not.toHaveBeenCalled();

    const count = reports.length;
    client.reset();
    expect(road?.signal.aborted).toBe(true);
    expect(highHandle.release).toHaveBeenCalledTimes(1);
    const roadHandle = fakeHandle(['road']);
    road?.resolve(roadHandle);
    await settle();
    expect(roadHandle.release).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['loaded cell/0_1', 'unloaded cell/0_0', 'unloaded cell/0_1']);
    expect(reports).toHaveLength(count);
    expect(logs).toEqual([]);
  });
});

describe('NetClient with an AssetLoader and a manifest', () => {
  function harness(regions: Record<string, string[]>) {
    const timers = new ManualTimers();
    const registry = testRegistry();
    const backend = new ManualBackend();
    const manifest = manifestOf(regions);
    const assets = new AssetLoader(manifest, [backend], loaderTimers(timers));
    const servers: ScriptedServer[] = [];
    const logs: Logged[] = [];
    const client = new NetClient({
      url: 'memory://session/dev',
      game: testGame(registry),
      token: 'dev-token',
      displayName: 'Ann',
      transport: () => {
        const t = new MemoryTransport({ timers });
        servers.push(new ScriptedServer(t.link, registry));
        return t;
      },
      now: timers.nowFn,
      timers,
      assets,
      manifest,
      log: (level, msg, data) => logs.push({ level, msg, data }),
    });
    const states: string[] = [];
    client.on('state', (s, prev) => states.push(`${prev}->${s}`));
    const server = (): ScriptedServer => {
      const s = servers.at(-1);
      if (s === undefined) throw new Error('no connection yet');
      return s;
    };
    return {
      timers,
      backend,
      assets,
      client,
      logs,
      states,
      server,
      /** Every RegionLoadState the server received, in order. */
      loadStates: (): unknown[] =>
        server()
          .all('RegionLoadState')
          .map((m) => m.payload),
      /** Lets loads settle, then delivers what the client sent. */
      settle: async (): Promise<void> => {
        await settle();
        timers.flush();
      },
      joined: async (): Promise<void> => {
        const connected = client.connect();
        timers.flush();
        server().welcome();
        timers.flush();
        await connected;
        expect(client.state).toBe('Joined');
      },
    };
  }

  it('Loading waits for the active groups, not prefetch ones; RegionLoadState is re-sent on each completion, RegionSet and release', async () => {
    const h = harness({
      'cell/1_1': ['road', 'crate'],
      'cell/0_1': ['tree'],
      'cell/2_2': ['rock'],
      'cell/3_3': ['lamp'],
    });
    await h.joined();
    h.server().regionSet(['cell/1_1'], ['cell/0_1']);
    h.server().spawned(2, 1234);
    h.timers.flush();
    expect(h.client.state).toBe('Loading');
    expect(h.loadStates()).toEqual([{ loaded: [], loading: ['cell/0_1', 'cell/1_1'] }]);

    h.backend.resolve('road');
    await h.settle();
    expect(h.client.state).toBe('Loading');
    expect(h.loadStates()).toHaveLength(1);

    h.backend.resolve('crate');
    await h.settle();
    expect(h.client.state).toBe('Playing'); // cell/0_1 (prefetch) is still loading
    expect(h.states.slice(-3)).toEqual(['Joined->Loading', 'Loading->Ready', 'Ready->Playing']);
    expect(h.loadStates().at(-1)).toEqual({ loaded: ['cell/1_1'], loading: ['cell/0_1'] });

    h.backend.resolve('tree');
    await h.settle();
    expect(h.loadStates()).toEqual([
      { loaded: [], loading: ['cell/0_1', 'cell/1_1'] },
      { loaded: ['cell/1_1'], loading: ['cell/0_1'] },
      { loaded: ['cell/0_1', 'cell/1_1'], loading: [] },
    ]);

    // Playing: a RegionSet adding a region still loading is reported at once, and play goes on.
    h.server().regionSet(['cell/1_1', 'cell/2_2'], []);
    h.timers.flush();
    expect(h.client.state).toBe('Playing');
    expect(h.loadStates().at(-1)).toEqual({
      loaded: ['cell/0_1', 'cell/1_1'],
      loading: ['cell/2_2'],
    });
    h.backend.resolve('rock');
    await h.settle();
    expect(h.loadStates().at(-1)).toEqual({
      loaded: ['cell/0_1', 'cell/1_1', 'cell/2_2'],
      loading: [],
    });
    // The dropped prefetch region goes after the grace (the client's timers), and that is reported.
    h.timers.advance(REGION_RELEASE_GRACE_MS);
    expect(h.loadStates().at(-1)).toEqual({ loaded: ['cell/1_1', 'cell/2_2'], loading: [] });
    expect(h.assets.refcount('tree')).toBe(0);
    expect(h.loadStates()).toHaveLength(6);

    // Disconnecting releases everything and cancels what is still loading; nothing more is sent.
    h.server().regionSet(['cell/1_1', 'cell/3_3'], []);
    h.timers.flush();
    expect(h.client.regions.loading()).toEqual(['cell/3_3']);
    h.client.disconnect();
    expect(h.client.regions.loaded()).toEqual([]);
    expect(h.backend.last('lamp').signal.aborted).toBe(true);
    expect(h.assets.refcount('road')).toBe(0);
    await h.settle();
    h.timers.advance(REGION_RELEASE_GRACE_MS);
    expect(h.server().received.at(-1)?.name).toBe('Leave');
    expect(h.loadStates()).toHaveLength(7);
    expect(h.logs.filter((l) => l.level === 'warn' || l.level === 'error')).toEqual([]);
  });

  it('Ready goes back to Loading for a new active region still loading; a failed group still lets the client play', async () => {
    const h = harness({ 'cell/1_1': [], 'cell/2_2': ['rock', 'sign'] });
    await h.joined();
    h.server().regionSet(['cell/1_1']);
    h.timers.flush();
    expect(h.client.state).toBe('Ready'); // no assets: loaded at once

    h.server().regionSet(['cell/1_1', 'cell/2_2']);
    h.server().spawned(2, 1234);
    h.timers.flush();
    expect(h.client.state).toBe('Loading');
    expect(h.loadStates().at(-1)).toEqual({ loaded: ['cell/1_1'], loading: ['cell/2_2'] });

    h.backend.fail('rock');
    await h.settle();
    expect(h.client.state).toBe('Playing');
    expect(h.states.slice(-5)).toEqual([
      'Joined->Loading',
      'Loading->Ready',
      'Ready->Loading',
      'Loading->Ready',
      'Ready->Playing',
    ]);
    expect(h.loadStates().at(-1)).toEqual({ loaded: ['cell/1_1', 'cell/2_2'], loading: [] });
    expect(h.logs.filter((l) => l.level === 'warn' || l.level === 'error')).toEqual([
      {
        level: 'warn',
        msg: 'region cell/2_2: asset group failed to load; reporting it loaded',
        data: { region: 'cell/2_2', err: expect.any(Error) },
      },
    ]);
    expect(h.client.regions.loaded()).toEqual(['cell/1_1', 'cell/2_2']);
  });
});
