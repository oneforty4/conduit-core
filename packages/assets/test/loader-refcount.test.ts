import { describe, expect, it, vi } from 'vitest';
import { AssetLoader, type AssetHandle } from '../src/index.ts';
import { ManualBackend, ManualTimers, flush, manifestOf, recordEvents } from './loader-harness.ts';

function setup(ids: readonly string[] = ['a']) {
  const backend = new ManualBackend();
  const timers = new ManualTimers();
  const warn = vi.fn();
  const loader = new AssetLoader(
    manifestOf(ids),
    [backend],
    timers.options({ warn, unloadGraceMs: 5000 }),
  );
  const events = recordEvents(loader);
  /** Acquires `id` and completes its load with `asset`. */
  const load = async (id: string, asset: unknown): Promise<AssetHandle> => {
    const pending = loader.acquire(id);
    await flush();
    backend.resolve(id, asset);
    return pending;
  };
  return { backend, timers, warn, loader, events, load };
}

describe('AssetLoader refcount and grace', () => {
  it('release to 0 enters grace; peek still works; re-acquire in grace cancels the timer, no dispose', async () => {
    const { backend, timers, loader, load } = setup();
    const asset = { geometry: 1 };
    const handle = await load('a', asset);
    expect(loader.refcount('a')).toBe(1);
    expect(loader.state('a')).toBe('loaded');

    handle.release();
    expect(loader.refcount('a')).toBe(0);
    expect(loader.state('a')).toBe('grace');
    expect(loader.peek('a')).toBe(asset);
    expect([...timers.active.values()].map((t) => t.ms)).toEqual([5000]);
    expect(loader.stats().loaded).toBe(1);

    const again = await loader.acquire('a');
    expect(again.asset).toBe(asset);
    expect(loader.state('a')).toBe('loaded');
    expect(timers.cleared).toHaveLength(1);
    expect(timers.active.size).toBe(0);
    expect(backend.disposed).toEqual([]);
    expect(backend.loads).toHaveLength(1);
  });

  it('grace expiry disposes exactly once, emits unloaded and returns to idle', async () => {
    const { backend, timers, loader, events, load } = setup();
    const asset = { geometry: 1 };
    (await load('a', asset)).release();
    expect(timers.fireAll()).toBe(1);
    expect(backend.disposed).toEqual([asset]);
    expect(events).toEqual(['loaded a', 'unloaded a']);
    expect(loader.state('a')).toBe('idle');
    expect(loader.peek('a')).toBeUndefined();
    expect(loader.refcount('a')).toBe(0);
    expect(timers.fireAll()).toBe(0);
    expect(backend.disposed).toHaveLength(1);

    const reloaded = loader.acquire('a');
    await flush();
    expect(backend.loads).toHaveLength(2);
    backend.resolve('a', 'fresh');
    expect((await reloaded).asset).toBe('fresh');
  });

  it('a stale grace timer does nothing after re-acquire and a new release', async () => {
    const backend = new ManualBackend();
    const fired: (() => void)[] = [];
    const loader = new AssetLoader(manifestOf(['a']), [backend], {
      setTimer: (fn) => fired.push(fn), // never cleared: exercises the generation check
      clearTimer: () => undefined,
    });
    const pending = loader.acquire('a');
    await flush();
    backend.resolve('a');
    (await pending).release();
    const second = await loader.acquire('a');
    second.release();
    fired[0]?.();
    expect(loader.state('a')).toBe('grace');
    fired[1]?.();
    expect(loader.state('a')).toBe('idle');
    expect(backend.disposed).toEqual(['asset:a']);
  });

  it('aborting a loading acquisition aborts the backend and disposes the late asset without loaded', async () => {
    const { backend, loader, events } = setup();
    const controller = new AbortController();
    const pending = loader.acquire('a', 'high', controller.signal);
    await flush();
    const load = backend.last('a');
    expect(loader.refcount('a')).toBe(1);

    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(load.signal.aborted).toBe(true);
    expect(loader.state('a')).toBe('disposing');
    expect(loader.refcount('a')).toBe(0);

    const asset = { late: true };
    load.resolve(asset);
    await flush();
    expect(backend.disposed).toEqual([asset]);
    expect(events).toEqual([]);
    expect(loader.state('a')).toBe('idle');
    expect(loader.stats()).toEqual({ queuedHigh: 0, queuedLow: 0, inFlight: 0, loaded: 0 });
  });

  it('an abort only releases its own acquisition while others still want the asset', async () => {
    const { backend, loader } = setup();
    const controller = new AbortController();
    const cancelled = loader.acquire('a', 'high', controller.signal);
    const kept = loader.acquire('a');
    await flush();
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(backend.last('a').signal.aborted).toBe(false);
    backend.resolve('a');
    expect((await kept).asset).toBe('asset:a');
    expect(loader.refcount('a')).toBe(1);
    const already = new AbortController();
    already.abort();
    await expect(loader.acquire('a', 'high', already.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(loader.refcount('a')).toBe(1);
  });

  it('aborting a queued acquisition dequeues it without a backend call', async () => {
    const backend = new ManualBackend();
    const loader = new AssetLoader(manifestOf(['busy', 'a']), [backend], { maxConcurrent: 1 });
    void loader.acquire('busy');
    const controller = new AbortController();
    const pending = loader.acquire('a', 'low', controller.signal);
    expect(loader.stats()).toMatchObject({ queuedLow: 1, inFlight: 1 });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(loader.state('a')).toBe('idle');
    expect(loader.stats()).toMatchObject({ queuedLow: 0, inFlight: 1 });
    backend.resolve('busy');
    await flush();
    expect(backend.order).toEqual(['busy']);
  });

  it('acquire while disposing waits for the aborted load to finish, then loads afresh', async () => {
    const { backend, loader } = setup();
    const controller = new AbortController();
    const first = loader.acquire('a', 'high', controller.signal).catch(() => 'aborted');
    await flush();
    controller.abort();
    expect(await first).toBe('aborted');
    const second = loader.acquire('a');
    await flush();
    expect(backend.loads).toHaveLength(1);
    backend.last('a').resolve('stale');
    await flush();
    expect(backend.disposed).toEqual(['stale']);
    expect(backend.loads).toHaveLength(2);
    backend.resolve('a', 'fresh');
    expect((await second).asset).toBe('fresh');
  });

  it('double release is a no-op that warns', async () => {
    const { timers, warn, loader, load } = setup();
    const first = await load('a', 'asset');
    const second = await loader.acquire('a');
    expect(loader.refcount('a')).toBe(2);
    first.release();
    first.release();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('a');
    expect(loader.refcount('a')).toBe(1);
    expect(loader.state('a')).toBe('loaded');
    second.release();
    second.release();
    expect(loader.refcount('a')).toBe(0);
    expect(timers.active.size).toBe(1);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('error state, then re-acquire calls the backend again and resolves', async () => {
    const { backend, loader, events } = setup();
    const errors: string[] = [];
    loader.on('error', (e) => errors.push(e.error.message));
    const first = loader.acquire('a');
    const second = loader.acquire('a', 'low');
    await flush();
    backend.last('a').reject(new Error('boom'));
    await expect(first).rejects.toThrow('boom');
    await expect(second).rejects.toThrow('boom');
    expect(loader.state('a')).toBe('error');
    expect(loader.refcount('a')).toBe(0);
    expect(loader.peek('a')).toBeUndefined();
    expect(errors).toEqual(['boom']);

    const retry = loader.acquire('a');
    await flush();
    expect(backend.loads).toHaveLength(2);
    backend.resolve('a', 'ok');
    expect((await retry).asset).toBe('ok');
    expect(loader.state('a')).toBe('loaded');
    expect(events).toEqual(['error a', 'loaded a']);
  });

  it('non-Error rejections are wrapped in Error', async () => {
    const { backend, loader } = setup();
    const pending = loader.acquire('a');
    await flush();
    backend.last('a').reject('plain string');
    await expect(pending).rejects.toThrow(new Error('plain string'));
  });

  it('dispose aborts in-flight loads, disposes loaded assets and rejects waiters', async () => {
    const { backend, timers, loader, load } = setup(['kept', 'graced', 'loading']);
    const kept = await load('kept', 'kept-asset');
    (await load('graced', 'graced-asset')).release();
    const pending = loader.acquire('loading');
    await flush();
    const inFlight = backend.last('loading');

    loader.dispose();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(inFlight.signal.aborted).toBe(true);
    expect(backend.disposed).toEqual(['kept-asset', 'graced-asset']);
    expect(timers.cleared).toHaveLength(1);
    expect(loader.stats()).toEqual({ queuedHigh: 0, queuedLow: 0, inFlight: 0, loaded: 0 });
    expect(loader.state('kept')).toBe('idle');

    inFlight.resolve('late-asset');
    await flush();
    expect(backend.disposed).toEqual(['kept-asset', 'graced-asset', 'late-asset']);
    kept.release();
    await expect(loader.acquire('kept')).rejects.toMatchObject({ name: 'AbortError' });
    await expect(loader.acquireGroup(['kept'])).rejects.toMatchObject({ name: 'AbortError' });
    expect(backend.loads).toHaveLength(3);
    loader.dispose();
  });
});
