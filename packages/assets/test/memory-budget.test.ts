import { describe, expect, it, vi } from 'vitest';
import {
  AssetLoader,
  ResourceLedger,
  type AssetBackend,
  type ResourceEstimate,
} from '../src/index.ts';
import { ManualBackend, ManualTimers, flush, manifestOf } from './loader-harness.ts';

function known(identity: object, bytes: number): ResourceEstimate {
  return { resources: [{ identity, cpuBytes: bytes, gpuBytes: 0, retainedSourceBytes: bytes }] };
}
describe('resource identity accounting', () => {
  it('deduplicates shared resources, uses conservative conflicts, and retires only the last owner', () => {
    const ledger = new ResourceLedger(),
      shared = {},
      a = {},
      b = {};
    ledger.set(a, known(shared, 64));
    ledger.set(b, known(shared, 96));
    expect(ledger.snapshot().cpuBytes).toEqual({ knownBytes: 96, unknownResources: 0 });
    expect(ledger.snapshot(a).resources).toBe(0);
    ledger.delete(b);
    expect(ledger.snapshot().cpuBytes.knownBytes).toBe(64);
    ledger.set(b, {
      resources: [{ identity: shared, cpuBytes: null, gpuBytes: 0, retainedSourceBytes: null }],
    });
    expect(ledger.snapshot().cpuBytes).toEqual({ knownBytes: 64, unknownResources: 1 });
    ledger.delete(a);
    ledger.delete(b);
    expect(ledger.snapshot().resources).toBe(0);
  });
});

describe('optional asset memory policy', () => {
  function setup(budget = true) {
    const disposed: object[] = [];
    const timers = new ManualTimers();
    let loads = 0;
    const backend: AssetBackend<ArrayBuffer> = {
      type: 'binary',
      async load() {
        loads++;
        return new ArrayBuffer(64);
      },
      dispose(asset) {
        disposed.push(asset);
      },
      estimate: (asset) => known(asset, asset.byteLength),
    };
    const loader = new AssetLoader(
      manifestOf(['a', 'b', 'c']),
      [backend],
      timers.options({
        ...(budget
          ? { memoryBudget: { soft: { cpuBytes: 64 }, hard: { cpuBytes: 96 }, maxPendingLoads: 8 } }
          : {}),
      }),
    );
    return {
      loader,
      disposed,
      timers,
      get loads() {
        return loads;
      },
    };
  }
  it('keeps live handles under pressure, blocks optional prefetch, and evicts only released grace owners', async () => {
    const s = setup();
    const a = await s.loader.acquire('a');
    const b = await s.loader.acquire('b');
    expect(s.loader.memoryStats()).toMatchObject({
      cpuBytes: { knownBytes: 128 },
      hardPressure: true,
      evictions: 0,
    });
    await expect(s.loader.acquire('c', 'low')).rejects.toThrow('prefetch');
    expect(a.asset).toBe(s.loader.peek('a'));
    expect(b.asset).toBe(s.loader.peek('b'));
    expect(s.disposed).toEqual([]);
    a.release();
    expect(s.loader.state('a')).toBe('idle');
    expect(s.disposed).toEqual([a.asset]);
    expect(s.loader.memoryStats()).toMatchObject({
      cpuBytes: { knownBytes: 64 },
      hardPressure: false,
      evictions: 1,
    });
    const again = await s.loader.acquire('b');
    expect(again.asset).toBe(b.asset);
    expect(s.loads).toBe(2);
    again.release();
    b.release();
    s.loader.dispose();
    expect(s.disposed).toHaveLength(2);
  });
  it('preserves grace/reacquisition with budgets disabled and releases instance accounting idempotently', async () => {
    const s = setup(false);
    const a = await s.loader.acquire('a');
    const extra = {};
    const instance = s.loader.trackResources(known(extra, 16));
    expect(s.loader.memoryStats()).toMatchObject({
      cpuBytes: { knownBytes: 80 },
      instanceOwners: 1,
      hardPressure: false,
    });
    instance.release();
    instance.release();
    expect(s.loader.memoryStats().cpuBytes.knownBytes).toBe(64);
    a.release();
    expect(s.loader.state('a')).toBe('grace');
    const again = await s.loader.acquire('a');
    expect(again.asset).toBe(a.asset);
    expect(s.loads).toBe(1);
    again.release();
    s.loader.dispose();
    expect(s.loader.memoryStats().resources).toBe(0);
  });
  it('reports unknown/failed estimates as pressure instead of treating them as free', async () => {
    const backend = new ManualBackend();
    const timers = new ManualTimers();
    const records: unknown[] = [];
    const loader = new AssetLoader(
      manifestOf(['a', 'b']),
      [backend],
      timers.options({
        memoryBudget: { hard: { cpuBytes: 100 } },
        diagnostics: { observer: { observe: (record) => records.push(record) }, now: () => 1 },
      }),
    );
    const pending = loader.acquire('a');
    await flush();
    backend.resolve('a');
    const handle = await pending;
    expect(loader.memoryStats()).toMatchObject({
      cpuBytes: { knownBytes: 0, unknownResources: 1 },
      hardPressure: true,
    });
    await expect(loader.acquire('b', 'low')).rejects.toThrow('prefetch');
    expect(records).toContainEqual(
      expect.objectContaining({
        category: 'asset',
        name: 'memory.cpuBytes',
        status: 'unavailable',
      }),
    );
    handle.release();
    expect(backend.disposed).toEqual(['asset:a']);
    loader.dispose();
  });
  it('cascades pressure eviction through zero-reference dependencies exactly once', async () => {
    const disposed: unknown[] = [];
    const backend: AssetBackend<object> = {
      type: 'binary',
      async load() {
        return {};
      },
      dispose(asset) {
        disposed.push(asset);
      },
      estimate: (asset) => known(asset, 16),
    };
    const loader = new AssetLoader(
      manifestOf(['parent', 'shared'], { parent: ['shared'] }),
      [backend],
      { memoryBudget: { hard: { cpuBytes: 0 } } },
    );
    const handle = await loader.acquire('parent');
    expect(loader.memoryStats().cpuBytes.knownBytes).toBe(32);
    handle.release();
    expect(disposed).toHaveLength(2);
    expect(loader.memoryStats().cpuBytes.knownBytes).toBe(0);
    expect(loader.memoryStats().hardPressure).toBe(false);
    loader.dispose();
    expect(disposed).toHaveLength(2);
  });

  it('bounds pending distinct work without invalidating an existing acquisition', async () => {
    const backend = new ManualBackend();
    const loader = new AssetLoader(manifestOf(['a', 'b']), [backend], {
      memoryBudget: { maxPendingLoads: 1 },
    });
    const pending = loader.acquire('a');
    await flush();
    await expect(loader.acquire('b')).rejects.toThrow('pending-load');
    backend.resolve('a');
    const handle = await pending;
    expect(handle.asset).toBe('asset:a');
    handle.release();
    loader.dispose();
  });
  it('protects loader behavior from broken estimates and observer callbacks', async () => {
    const observer = vi.fn(() => {
      throw new Error('observer');
    });
    const backend: AssetBackend<object> = {
      type: 'binary',
      async load() {
        return {};
      },
      dispose() {},
      estimate() {
        throw new Error('unknown estimate');
      },
    };
    const loader = new AssetLoader(manifestOf(['a']), [backend], {
      diagnostics: { observer: { observe: observer }, now: () => 1 },
    });
    const handle = await loader.acquire('a');
    expect(loader.memoryStats().estimateErrors).toBe(1);
    expect(observer).toHaveBeenCalled();
    handle.release();
    loader.dispose();
  });
});
