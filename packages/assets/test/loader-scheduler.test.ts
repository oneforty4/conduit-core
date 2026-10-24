import { describe, expect, it, vi } from 'vitest';
import {
  AssetIntegrityError,
  AssetLoadError,
  AssetLoader,
  AssetNetworkError,
  AudioBackend,
  BinaryBackend,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_UNLOAD_GRACE_MS,
  JsonBackend,
  sha256Sri,
  type Manifest,
} from '../src/index.ts';
import { ManualBackend, ManualTimers, flush, manifestOf, recordEvents } from './loader-harness.ts';

describe('AssetLoader scheduling', () => {
  it('starts a high acquisition as soon as a slot frees, before queued lows; FIFO per priority', async () => {
    const backend = new ManualBackend();
    const lows = ['l1', 'l2', 'l3', 'l4', 'l5'];
    const loader = new AssetLoader(manifestOf([...lows, 'h1', 'h2']), [backend], {
      maxConcurrent: 2,
      ...new ManualTimers().options(),
    });
    const pending = lows.map((id) => loader.acquire(id, 'low'));
    pending.push(loader.acquire('h1', 'high'), loader.acquire('h2'));
    await flush();
    expect(backend.order).toEqual(['l1', 'l2']);
    expect(loader.stats()).toEqual({ queuedHigh: 2, queuedLow: 3, inFlight: 2, loaded: 0 });
    expect(loader.state('l3')).toBe('queued');
    expect(loader.state('l1')).toBe('loading');

    backend.resolve('l1');
    await flush();
    expect(backend.order).toEqual(['l1', 'l2', 'h1']);
    backend.resolve('l2');
    await flush();
    expect(backend.order).toEqual(['l1', 'l2', 'h1', 'h2']);
    expect(loader.stats()).toEqual({ queuedHigh: 0, queuedLow: 3, inFlight: 2, loaded: 2 });

    backend.resolve('h2');
    await flush();
    backend.resolve('h1');
    await flush();
    expect(backend.order).toEqual(['l1', 'l2', 'h1', 'h2', 'l3', 'l4']);
    backend.resolve('l4');
    await flush();
    expect(backend.order.slice(-1)).toEqual(['l5']);
    backend.resolve('l3');
    backend.resolve('l5');
    const handles = await Promise.all(pending);
    expect(handles.map((h) => h.asset)).toEqual([...lows, 'h1', 'h2'].map((id) => `asset:${id}`));
    expect(loader.stats()).toEqual({ queuedHigh: 0, queuedLow: 0, inFlight: 0, loaded: 7 });
  });

  it('never has more than maxConcurrent loads in flight', async () => {
    const backend = new ManualBackend();
    const ids = Array.from({ length: 20 }, (_, i) => `a${i}`);
    const loader = new AssetLoader(manifestOf(ids), [backend], { maxConcurrent: 3 });
    let peak = 0;
    const all = Promise.all(ids.map((id, i) => loader.acquire(id, i % 2 === 0 ? 'high' : 'low')));
    for (let settled = 0; settled < ids.length; settled++) {
      await flush();
      peak = Math.max(peak, loader.stats().inFlight);
      const next = backend.loads.find((l) => loader.state(l.id) === 'loading');
      next?.resolve('x');
    }
    await all;
    expect(peak).toBe(3);
    expect(backend.loads).toHaveLength(20);
  });

  it('a high acquire promotes a queued low record ahead of the other lows', async () => {
    const backend = new ManualBackend();
    const loader = new AssetLoader(manifestOf(['busy', 'l1', 'l2', 'l3']), [backend], {
      maxConcurrent: 1,
    });
    void loader.acquire('busy', 'low');
    const lows = ['l1', 'l2', 'l3'].map((id) => loader.acquire(id, 'low'));
    const again = loader.acquire('l3', 'high');
    expect(loader.stats()).toMatchObject({ queuedHigh: 1, queuedLow: 2 });
    await flush();
    backend.resolve('busy');
    await flush();
    expect(backend.order).toEqual(['busy', 'l3']);
    backend.resolve('l3');
    const [first, second] = await Promise.all([lows[2], again]);
    expect(first?.asset).toBe('asset:l3');
    expect(second?.asset).toBe('asset:l3');
    expect(loader.refcount('l3')).toBe(2);
  });

  it('a second acquire of an in-flight id shares the one backend call and asset', async () => {
    const backend = new ManualBackend();
    const loader = new AssetLoader(manifestOf(['a']), [backend]);
    const first = loader.acquire('a');
    await flush();
    const second = loader.acquire('a', 'low');
    expect(backend.loads).toHaveLength(1);
    expect(loader.refcount('a')).toBe(2);
    const asset = { mesh: 'hull' };
    backend.resolve('a', asset);
    const [a, b] = await Promise.all([first, second]);
    expect(a.asset).toBe(asset);
    expect(b.asset).toBe(asset);
    expect(a).not.toBe(b);
    const third = await loader.acquire('a');
    expect(third.asset).toBe(asset);
    expect(backend.loads).toHaveLength(1);
    expect(loader.refcount('a')).toBe(3);
  });

  it('emits progress 0/size then size/size and one loaded event, and resolves urls', async () => {
    const backend = new ManualBackend();
    const manifest = manifestOf(['a', 'empty']);
    const emptyEntry = manifest.assets.empty;
    if (emptyEntry) emptyEntry.size = 0;
    const loader = new AssetLoader(manifest, [backend]);
    const progress: string[] = [];
    loader.on('progress', (e) => progress.push(`${e.id} ${e.loaded}/${e.total}`));
    const events = recordEvents(loader);
    const handles = Promise.all([loader.acquire('a'), loader.acquire('empty')]);
    await flush();
    expect(backend.last('a').url).toBe('/assets/a.bin');
    expect(backend.last('a').entry).toBe(manifest.assets.a);
    backend.last('a').ctx.progress(4, 10);
    backend.resolve('a');
    backend.resolve('empty');
    await handles;
    expect(progress).toEqual(['a 0/10', 'empty 0/1', 'a 4/10', 'a 10/10', 'empty 1/1']);
    expect(events).toEqual(['loaded a', 'loaded empty']);
  });

  it('rejects bad retry options', () => {
    expect(() => new AssetLoader(manifestOf(['a']), [], { retries: -1 })).toThrow(RangeError);
    expect(() => new AssetLoader(manifestOf(['a']), [], { retries: 1.5 })).toThrow(RangeError);
    expect(() => new AssetLoader(manifestOf(['a']), [], { retryMs: -1 })).toThrow(RangeError);
  });

  it('rejects unknown ids, types without a backend, duplicate backends and bad options', async () => {
    const manifest = manifestOf(['a', 'music'], {}, { music: 'audio' });
    const loader = new AssetLoader(manifest, [new ManualBackend()]);
    await expect(loader.acquire('nope')).rejects.toThrow(new RangeError('unknown asset nope'));
    await expect(loader.acquire('constructor')).rejects.toThrow(RangeError);
    await expect(loader.acquire('music')).rejects.toThrow(new Error('no backend for type audio'));
    expect(loader.state('nope')).toBe('idle');
    expect(loader.refcount('music')).toBe(0);
    expect(() => new AssetLoader(manifest, [new ManualBackend(), new ManualBackend()])).toThrow(
      'duplicate backend for type binary',
    );
    expect(() => new AssetLoader(manifest, [], { maxConcurrent: 0 })).toThrow(RangeError);
    expect(() => new AssetLoader(manifest, [], { unloadGraceMs: -1 })).toThrow(RangeError);
    expect(DEFAULT_MAX_CONCURRENT).toBe(6);
    expect(DEFAULT_UNLOAD_GRACE_MS).toBe(5000);
  });

  it('a backend that throws synchronously puts the asset in error', async () => {
    const loader = new AssetLoader(manifestOf(['a']), [
      {
        type: 'binary',
        load: () => {
          throw new Error('sync boom');
        },
        dispose: () => undefined,
      },
    ]);
    await expect(loader.acquire('a')).rejects.toThrow('sync boom');
    expect(loader.state('a')).toBe('error');
  });
});

describe('AssetLoader.acquireGroup', () => {
  it('resolves one handle per id and releases each once', async () => {
    const backend = new ManualBackend();
    const timers = new ManualTimers();
    const warn = vi.fn();
    const loader = new AssetLoader(
      manifestOf(['a', 'b', 'c']),
      [backend],
      timers.options({ warn }),
    );
    const group = loader.acquireGroup(['a', 'b', 'c'], 'low');
    await flush();
    for (const id of ['c', 'a', 'b']) backend.resolve(id);
    const handle = await group;
    expect(handle.ids).toEqual(['a', 'b', 'c']);
    expect(handle.handles.map((h) => [h.id, h.asset])).toEqual([
      ['a', 'asset:a'],
      ['b', 'asset:b'],
      ['c', 'asset:c'],
    ]);
    handle.release();
    expect(['a', 'b', 'c'].map((id) => loader.state(id))).toEqual(['grace', 'grace', 'grace']);
    handle.release();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(timers.active.size).toBe(3);
    expect(await loader.acquireGroup([])).toMatchObject({ ids: [], handles: [] });
  });

  it('on a failing member: rejects with the first error, releases resolved, cancels pending', async () => {
    const backend = new ManualBackend();
    const ids = ['done', 'loading', 'failing', 'q1', 'q2'];
    const loader = new AssetLoader(manifestOf(ids), [backend], {
      maxConcurrent: 2,
      ...new ManualTimers().options(),
    });
    const group = loader.acquireGroup(ids);
    await flush();
    expect(backend.order).toEqual(['done', 'loading']);
    backend.resolve('done');
    await flush();
    expect(backend.order).toEqual(['done', 'loading', 'failing']);
    backend.last('failing').reject(new Error('failing failed'));
    await expect(group).rejects.toThrow('failing failed');

    // The slot freed by the failure started q1 before the rollback reached it; q2 was still queued.
    expect(backend.order).toEqual(['done', 'loading', 'failing', 'q1']);
    expect(loader.state('failing')).toBe('error');
    expect(loader.state('done')).toBe('grace');
    expect(loader.refcount('done')).toBe(0);
    for (const id of ['loading', 'q1']) {
      expect(backend.last(id).signal.aborted, id).toBe(true);
      expect(loader.state(id), id).toBe('disposing');
    }
    expect(loader.state('q2')).toBe('idle');

    backend.resolve('loading', 'late');
    backend.last('q1').reject(new DOMException('aborted', 'AbortError'));
    await flush();
    expect(backend.disposed).toEqual(['late']);
    expect(loader.state('loading')).toBe('idle');
    expect(loader.state('q1')).toBe('idle');
    expect(backend.order).not.toContain('q2');
    expect(loader.stats()).toEqual({ queuedHigh: 0, queuedLow: 0, inFlight: 0, loaded: 1 });
  });

  it('rejects at once for an unknown member and cancels the others', async () => {
    const backend = new ManualBackend();
    const loader = new AssetLoader(manifestOf(['a']), [backend]);
    await expect(loader.acquireGroup(['a', 'ghost'])).rejects.toThrow('unknown asset ghost');
    await flush();
    expect(backend.last('a').signal.aborted).toBe(true);
    expect(loader.refcount('a')).toBe(0);
  });

  it('aborting the caller signal cancels the whole group', async () => {
    const backend = new ManualBackend();
    const loader = new AssetLoader(manifestOf(['a', 'b']), [backend], { maxConcurrent: 1 });
    const controller = new AbortController();
    const group = loader.acquireGroup(['a', 'b'], 'low', controller.signal);
    await flush();
    controller.abort();
    await expect(group).rejects.toMatchObject({ name: 'AbortError' });
    expect(backend.last('a').signal.aborted).toBe(true);
    expect(loader.state('b')).toBe('idle');
    expect(backend.order).toEqual(['a']);
  });
});

describe('core backends', () => {
  const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

  async function manifestFor(
    files: Record<string, { type: 'json' | 'binary' | 'audio'; body: string }>,
  ): Promise<Manifest> {
    const manifest = manifestOf([]);
    for (const [id, file] of Object.entries(files)) {
      manifest.assets[id] = {
        type: file.type,
        url: `${id}.x`,
        hash: await sha256Sri(bytes(file.body)),
        size: bytes(file.body).length,
      };
    }
    return manifest;
  }

  function fakeFetch(bodies: Record<string, string | number>) {
    return vi.fn(async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      const body = bodies[String(input)];
      if (typeof body === 'number') return new Response('nope', { status: body });
      if (body === undefined) return new Response('missing', { status: 404 });
      return new Response(bytes(body));
    });
  }

  const backends = () => [new JsonBackend(), new BinaryBackend(), new AudioBackend()];

  it('JsonBackend parses, BinaryBackend and AudioBackend return the bytes', async () => {
    const manifest = await manifestFor({
      config: { type: 'json', body: '{"speed":3}' },
      blob: { type: 'binary', body: 'BIN' },
      horn: { type: 'audio', body: 'OggS' },
    });
    const fetch = fakeFetch({
      '/assets/config.x': '{"speed":3}',
      '/assets/blob.x': 'BIN',
      '/assets/horn.x': 'OggS',
    });
    const loader = new AssetLoader(manifest, backends(), { fetch });
    const [config, blob, horn] = await Promise.all([
      loader.acquire<unknown>('config'),
      loader.acquire<ArrayBuffer>('blob'),
      loader.acquire<ArrayBuffer>('horn'),
    ]);
    expect(config.asset).toEqual({ speed: 3 });
    expect(new TextDecoder().decode(blob.asset)).toBe('BIN');
    expect(new TextDecoder().decode(horn.asset)).toBe('OggS');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty('integrity');
  });

  it('a non-2xx response rejects with AssetLoadError', async () => {
    const manifest = await manifestFor({ blob: { type: 'binary', body: 'BIN' } });
    const loader = new AssetLoader(manifest, backends(), {
      fetch: fakeFetch({ '/assets/blob.x': 503 }),
      retries: 0,
    });
    const error = await loader.acquire('blob').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AssetLoadError);
    expect(error).toMatchObject({ id: 'blob', url: '/assets/blob.x', status: 503 });
  });

  it('no response rejects with AssetNetworkError', async () => {
    const manifest = await manifestFor({ blob: { type: 'binary', body: 'BIN' } });
    const loader = new AssetLoader(manifest, backends(), {
      fetch: async () => {
        throw new TypeError('Failed to fetch');
      },
      retries: 0,
    });
    const error = await loader.acquire('blob').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AssetNetworkError);
    expect(error).toMatchObject({ id: 'blob', url: '/assets/blob.x' });
    expect((error as Error).cause).toBeInstanceOf(TypeError);
  });

  it('tries a load that failed for a reason that may pass again, after a wait that doubles', async () => {
    const manifest = await manifestFor({ blob: { type: 'binary', body: 'BIN' } });
    let calls = 0;
    const fetch = async (): Promise<Response> => {
      calls++;
      if (calls === 1) throw new TypeError('Failed to fetch');
      if (calls === 2) return new Response('busy', { status: 503 });
      return new Response(bytes('BIN'));
    };
    const timers = new ManualTimers();
    const loader = new AssetLoader(manifest, backends(), timers.options({ fetch, retryMs: 100 }));
    const retrying: string[] = [];
    loader.on('retrying', (e) =>
      retrying.push(`${e.id} ${e.attempt} ${e.delayMs} ${e.error.name}`),
    );
    let got: ArrayBuffer | undefined;
    void loader.acquire<ArrayBuffer>('blob').then((h) => (got = h.asset));
    await flush();
    expect(retrying).toEqual(['blob 1 100 AssetNetworkError']);
    expect(loader.state('blob')).toBe('queued'); // waiting
    expect(calls).toBe(1);
    timers.fireAll();
    await flush();
    expect(retrying).toEqual(['blob 1 100 AssetNetworkError', 'blob 2 200 AssetLoadError']);
    expect(calls).toBe(2);
    timers.fireAll();
    await flush();
    expect(calls).toBe(3);
    expect(new TextDecoder().decode(got)).toBe('BIN');
    expect(loader.state('blob')).toBe('loaded');
  });

  it('fails at once for a reason that will not pass, and after the last try for one that may', async () => {
    const manifest = await manifestFor({
      missing: { type: 'binary', body: 'BIN' },
      busy: { type: 'binary', body: 'BIN' },
    });
    const timers = new ManualTimers();
    const loader = new AssetLoader(
      manifest,
      backends(),
      timers.options({ fetch: fakeFetch({ '/assets/busy.x': 502 }), retries: 1 }),
    );
    const errors: string[] = [];
    loader.on('error', (e) => errors.push(e.id));
    await expect(loader.acquire('missing')).rejects.toMatchObject({ status: 404 });
    const busy = loader.acquire('busy').catch((e: unknown) => e);
    await flush();
    expect(errors).toEqual(['missing']);
    timers.fireAll();
    expect(await busy).toMatchObject({ status: 502 });
    expect(errors).toEqual(['missing', 'busy']);
  });

  it('a release while it waits to be tried again dequeues it, and it is not tried', async () => {
    const manifest = await manifestFor({ blob: { type: 'binary', body: 'BIN' } });
    const fetch = vi.fn(async (): Promise<Response> => new Response('busy', { status: 503 }));
    const timers = new ManualTimers();
    const loader = new AssetLoader(manifest, backends(), timers.options({ fetch }));
    const abort = new AbortController();
    const pending = loader.acquire('blob', 'high', abort.signal).catch((e: unknown) => e);
    await flush();
    expect(loader.state('blob')).toBe('queued');
    abort.abort(new Error('not wanted'));
    expect(await pending).toMatchObject({ message: 'not wanted' });
    expect(loader.state('blob')).toBe('idle');
    expect(timers.active.size).toBe(0); // its timer cleared
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('gives a new acquisition its own retry budget after an earlier load exhausted it', async () => {
    const manifest = await manifestFor({ blob: { type: 'binary', body: 'BIN' } });
    let calls = 0;
    const fetch = async (): Promise<Response> => {
      calls++;
      return calls <= 3 ? new Response('busy', { status: 503 }) : new Response(bytes('BIN'));
    };
    const timers = new ManualTimers();
    const loader = new AssetLoader(
      manifest,
      backends(),
      timers.options({ fetch, retries: 1, retryMs: 100 }),
    );
    const attempts: number[] = [];
    loader.on('retrying', ({ attempt }) => attempts.push(attempt));
    const first = loader.acquire('blob').catch((error: unknown) => error);
    await flush();
    expect(timers.fireAll()).toBe(1);
    expect(await first).toMatchObject({ status: 503 });
    expect(loader.state('blob')).toBe('error');

    const next = loader.acquire<ArrayBuffer>('blob');
    // Keep a failed regression from reporting an unrelated unhandled rejection.
    void next.catch(() => {});
    await flush();
    expect(loader.state('blob')).toBe('queued');
    expect(attempts).toEqual([1, 1]);
    expect([...timers.active.values()].map(({ ms }) => ms)).toEqual([100]);
    timers.fireAll();
    const handle = await next;
    expect(new TextDecoder().decode(handle.asset)).toBe('BIN');
    expect(calls).toBe(4);
    handle.release();
    loader.dispose();
  });

  it('verifyHashes passes integrity to fetch and rejects mismatched bytes with AssetIntegrityError', async () => {
    const manifest = await manifestFor({
      good: { type: 'binary', body: 'right' },
      bad: { type: 'json', body: '{}' },
    });
    const fetch = fakeFetch({ '/assets/good.x': 'right', '/assets/bad.x': '{"tampered":1}' });
    const loader = new AssetLoader(manifest, backends(), { fetch, verifyHashes: true });
    await expect(loader.acquire('good')).resolves.toMatchObject({ id: 'good' });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ integrity: manifest.assets.good?.hash });
    const error = await loader.acquire('bad').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AssetIntegrityError);
    expect(error).toMatchObject({
      id: 'bad',
      expected: manifest.assets.bad?.hash,
      actual: await sha256Sri(bytes('{"tampered":1}')),
    });
  });

  it('defaults to the global fetch without binding it to another object', async () => {
    const manifest = await manifestFor({ blob: { type: 'binary', body: 'BIN' } });
    const original = globalThis.fetch;
    let calledUnbound = false;
    globalThis.fetch = function (this: unknown) {
      calledUnbound = this === undefined;
      return Promise.resolve(new Response(bytes('BIN')));
    } as typeof fetch;
    try {
      const loader = new AssetLoader(manifest, backends());
      await loader.acquire('blob');
      expect(calledUnbound).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});
