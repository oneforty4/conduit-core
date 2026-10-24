import { describe, expect, it } from 'vitest';
import { AssetLoader } from '../src/index.ts';
import { ManualBackend, ManualTimers, flush, manifestOf, recordEvents } from './loader-harness.ts';

describe('AssetLoader dependencies', () => {
  it('loads deps first: a deps [b], b deps [c] calls the backend c, b, a', async () => {
    const backend = new ManualBackend();
    const loader = new AssetLoader(manifestOf(['a', 'b', 'c'], { a: ['b'], b: ['c'] }), [backend]);
    let resolved = false;
    const pending = loader.acquire('a').then((handle) => {
      resolved = true;
      return handle;
    });
    await flush();
    expect(backend.order).toEqual(['c']);
    expect(loader.state('a')).toBe('queued');
    expect(loader.state('b')).toBe('queued');

    backend.resolve('c');
    await flush();
    expect(backend.order).toEqual(['c', 'b']);
    expect(loader.state('a')).toBe('queued');

    backend.resolve('b');
    await flush();
    expect(backend.order).toEqual(['c', 'b', 'a']);
    expect(resolved).toBe(false);
    // A dependant's backend can read its loaded deps.
    const ctx = backend.last('a').ctx;
    expect(ctx.loader.peek('b')).toBe('asset:b');
    expect(ctx.loader.peek('c')).toBe('asset:c');

    backend.resolve('a');
    const handle = await pending;
    expect(handle.asset).toBe('asset:a');
    expect(['a', 'b', 'c'].map((id) => loader.state(id))).toEqual(['loaded', 'loaded', 'loaded']);
    // a holds b and c (transitive), b holds c.
    expect(['a', 'b', 'c'].map((id) => loader.refcount(id))).toEqual([1, 1, 2]);
  });

  it('never starts a dependant whose dep is still loading, even with free slots', async () => {
    const backend = new ManualBackend();
    const loader = new AssetLoader(manifestOf(['a', 'b', 'x'], { a: ['b'] }), [backend], {
      maxConcurrent: 4,
    });
    void loader.acquire('a');
    void loader.acquire('x', 'low');
    await flush();
    expect(backend.order).toEqual(['b', 'x']);
    expect(loader.stats()).toEqual({ queuedHigh: 1, queuedLow: 0, inFlight: 2, loaded: 0 });
  });

  it('releasing a to zero and expiring grace cascades a grace period on b, then c', async () => {
    const backend = new ManualBackend();
    const timers = new ManualTimers();
    const loader = new AssetLoader(
      manifestOf(['a', 'b', 'c'], { a: ['b'], b: ['c'] }),
      [backend],
      timers.options(),
    );
    const events = recordEvents(loader);
    const pending = loader.acquire('a');
    for (const id of ['c', 'b', 'a']) {
      await flush();
      backend.resolve(id);
    }
    (await pending).release();
    const states = () => ['a', 'b', 'c'].map((id) => loader.state(id));
    expect(states()).toEqual(['grace', 'loaded', 'loaded']);

    expect(timers.fireAll()).toBe(1);
    expect(states()).toEqual(['idle', 'grace', 'loaded']);
    expect(loader.refcount('c')).toBe(1);

    expect(timers.fireAll()).toBe(1);
    expect(states()).toEqual(['idle', 'idle', 'grace']);

    expect(timers.fireAll()).toBe(1);
    expect(states()).toEqual(['idle', 'idle', 'idle']);
    expect(backend.disposed).toEqual(['asset:a', 'asset:b', 'asset:c']);
    expect(events).toEqual([
      'loaded c',
      'loaded b',
      'loaded a',
      'unloaded a',
      'unloaded b',
      'unloaded c',
    ]);
  });

  it('a failing dep rejects the parent and leaves no handles', async () => {
    const backend = new ManualBackend();
    const loader = new AssetLoader(
      manifestOf(['a', 'b', 'c'], { a: ['b', 'c'] }),
      [backend],
      new ManualTimers().options(),
    );
    const events = recordEvents(loader);
    const pending = loader.acquire('a');
    await flush();
    expect(backend.order).toEqual(['b', 'c']);
    backend.resolve('b');
    await flush();
    backend.last('c').reject(new Error('c failed'));
    await expect(pending).rejects.toThrow('c failed');
    expect(['a', 'b', 'c'].map((id) => loader.refcount(id))).toEqual([0, 0, 0]);
    expect(['a', 'b', 'c'].map((id) => loader.state(id))).toEqual(['error', 'grace', 'error']);
    expect(backend.order).not.toContain('a');
    expect(events).toEqual(['loaded b', 'error c', 'error a']);
  });

  it('a dep failing while a sibling dep is loading aborts the sibling', async () => {
    const backend = new ManualBackend();
    const loader = new AssetLoader(manifestOf(['a', 'b', 'c'], { a: ['b', 'c'] }), [backend]);
    const events = recordEvents(loader);
    const pending = loader.acquire('a');
    await flush();
    backend.last('c').reject(new Error('c failed'));
    await expect(pending).rejects.toThrow('c failed');
    const sibling = backend.last('b');
    expect(sibling.signal.aborted).toBe(true);
    sibling.resolve('late-b');
    await flush();
    expect(backend.disposed).toEqual(['late-b']);
    expect(['a', 'b', 'c'].map((id) => loader.refcount(id))).toEqual([0, 0, 0]);
    expect(loader.state('b')).toBe('idle');
    expect(events).toEqual(['error c', 'error a']);
  });

  it('shares a dep between dependants and keeps it while either holds it', async () => {
    const backend = new ManualBackend();
    const timers = new ManualTimers();
    const loader = new AssetLoader(
      manifestOf(['hull', 'sail', 'tex'], { hull: ['tex'], sail: ['tex'] }),
      [backend],
      timers.options(),
    );
    const hull = loader.acquire('hull');
    const sail = loader.acquire('sail');
    await flush();
    expect(backend.order).toEqual(['tex']);
    backend.resolve('tex');
    await flush();
    backend.resolve('hull');
    backend.resolve('sail');
    const [h, s] = await Promise.all([hull, sail]);
    expect(loader.refcount('tex')).toBe(2);
    h.release();
    timers.fireAll();
    expect(loader.state('hull')).toBe('idle');
    expect(loader.state('tex')).toBe('loaded');
    s.release();
    timers.fireAll();
    expect(loader.state('tex')).toBe('grace');
    expect(backend.order).toEqual(['tex', 'hull', 'sail']);
  });

  it('a dependency cycle (unvalidated manifest) rejects instead of hanging', async () => {
    const backend = new ManualBackend();
    const loader = new AssetLoader(manifestOf(['a', 'b', 'c'], { a: ['b'], b: ['c'], c: ['b'] }), [
      backend,
    ]);
    await expect(loader.acquire('a')).rejects.toThrow('dependency cycle');
    await expect(loader.acquire('c')).rejects.toThrow('dependency cycle: c depends on b');
    expect(backend.loads).toEqual([]);
    expect(['a', 'b', 'c'].map((id) => loader.refcount(id))).toEqual([0, 0, 0]);
  });

  it('releasing a queued dependant cancels its pending dep acquisitions', async () => {
    const backend = new ManualBackend();
    const loader = new AssetLoader(manifestOf(['a', 'b'], { a: ['b'] }), [backend]);
    const controller = new AbortController();
    const pending = loader.acquire('a', 'low', controller.signal);
    await flush();
    expect(backend.order).toEqual(['b']);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await flush();
    expect(loader.state('a')).toBe('idle');
    expect(backend.last('b').signal.aborted).toBe(true);
    expect(loader.refcount('b')).toBe(0);
  });

  it('deps inherit the priority, and a high acquire promotes queued low deps', async () => {
    const backend = new ManualBackend();
    const loader = new AssetLoader(
      manifestOf(['busy', 'other', 'a', 'b'], { a: ['b'] }),
      [backend],
      { maxConcurrent: 1 },
    );
    void loader.acquire('busy');
    void loader.acquire('other', 'low');
    const low = loader.acquire('a', 'low');
    await flush();
    expect(loader.stats()).toMatchObject({ queuedHigh: 0, queuedLow: 3 });
    const high = loader.acquire('a', 'high');
    expect(loader.stats()).toMatchObject({ queuedHigh: 2, queuedLow: 1 });
    backend.resolve('busy');
    await flush();
    expect(backend.order).toEqual(['busy', 'b']);
    backend.resolve('b');
    await flush();
    expect(backend.order).toEqual(['busy', 'b', 'a']);
    backend.resolve('a');
    await Promise.all([low, high]);
    expect(loader.state('other')).toBe('loading');
  });
});
