import { describe, expect, it, vi } from 'vitest';
import {
  GenerationStore,
  MemoryStore,
  migrateGameSave,
  openApplicationSave,
  SqliteStore,
  type BlobStore,
} from '../src/index.ts';
import { generationContract } from './generation-contract.ts';
import { nodeSqliteSkipReason } from './node-sqlite.ts';

generationContract('generation contract / memory', async () => ({
  store: new MemoryStore(),
  close() {},
}));
describe.skipIf(nodeSqliteSkipReason() !== null)('SQLite generations', () => {
  generationContract('generation contract / SQLite', async () => {
    const store = new SqliteStore(':memory:');
    return { store, close: () => store.close() };
  });
});

it('isolates staging transactions, validates bounds and rejects edited capture metadata', async () => {
  const store = new GenerationStore(new MemoryStore(), {
    maxOverlayBytes: 4,
    maxCaptureBytes: 1024,
  });
  await store.open();
  await store.put('region', 'a', new Uint8Array([1]));
  let release = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const transaction = store.transaction(async (tx) => {
    await tx.put('region', 'a', new Uint8Array([2]));
    entered();
    await hold;
    throw new Error('rollback');
  });
  await started;
  expect(() => store.capture(1, null)).toThrow('wait for staging');
  let observed = false;
  const read = store.get('region', 'a').then((value) => {
    observed = true;
    return value;
  });
  await read;
  expect(observed).toBe(true);
  expect(await store.get('region', 'a')).toEqual(new Uint8Array([1]));
  release();
  await expect(transaction).rejects.toThrow('rollback');
  expect(await read).toEqual(new Uint8Array([1]));
  await expect(store.put('region', 'b', new Uint8Array(5))).rejects.toThrow('overlay resource');
  const image = store.capture(1, null);
  image.completedTick = 2;
  await expect(store.publish(image)).rejects.toThrow('modified capture');
});

it('migrates declared game versions with validation and preserves originals on a failing migration', () => {
  const original = new Uint8Array([1]);
  const checked: number[] = [];
  const schema = {
    version: 2,
    migrations: [
      { version: 1, migrate: (bytes: Uint8Array) => new Uint8Array([bytes[0]! + 1]) },
      { version: 2, migrate: (bytes: Uint8Array) => new Uint8Array([bytes[0]! + 1]) },
    ],
    validate: (version: number, bytes: Uint8Array) => {
      expect(bytes[0]).toBe(version + 1);
      checked.push(version);
    },
  };
  expect(migrateGameSave(original, 0, schema)).toEqual(new Uint8Array([3]));
  expect(checked).toEqual([0, 1, 2]);
  schema.migrations[1]!.migrate = (bytes) => {
    bytes[0] = 99;
    throw new Error('migration');
  };
  expect(() => migrateGameSave(original, 0, schema)).toThrow('migration');
  expect(original).toEqual(new Uint8Array([1]));
  expect(() => migrateGameSave(original, 3, schema)).toThrow('newer');
});

it('keeps newer dirty data when an earlier detached image finishes publishing', async () => {
  const backing = new MemoryStore();
  let release = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const delayed: BlobStore = {
    get: (ns, key) => backing.get(ns, key),
    put: (ns, key, value) => backing.put(ns, key, value),
    delete: (ns, key) => backing.delete(ns, key),
    list: (ns, prefix) => backing.list(ns, prefix),
    transaction: async (fn) => {
      entered();
      await hold;
      return backing.transaction(fn);
    },
  };
  const store = new GenerationStore(delayed);
  await store.open();
  await store.put('region', 'a', new Uint8Array([1]));
  const image = store.capture(1, null);
  const publishing = store.publish(image);
  await started;
  await store.put('region', 'a', new Uint8Array([2]));
  release();
  await publishing;
  expect(await store.get('region', 'a')).toEqual(new Uint8Array([2]));
  const restored = new GenerationStore(backing);
  await restored.open();
  expect(await restored.get('region', 'a')).toEqual(new Uint8Array([1]));
});

it('enforces capture bounds before copying and rejects metadata that JSON would silently change', async () => {
  const store = new GenerationStore(new MemoryStore(), { maxCaptureBytes: 128 });
  await store.open();
  const bytes = new Uint8Array(256);
  const copy = vi.spyOn(bytes, 'slice');
  expect(() => store.capture(0, null, [{ namespace: 'region', key: 'a', bytes }])).toThrow(
    'capture resource',
  );
  expect(copy).not.toHaveBeenCalled();
  const getter = vi.fn(() => 'secret');
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: getter });
  for (const metadata of [
    new Date(),
    accessor,
    Object.defineProperty({}, 'hidden', { value: 1 }),
    { toJSON: () => ({}) },
    { [Symbol('key')]: 1 },
    [undefined],
    -0,
  ])
    expect(() => store.capture(0, metadata)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});

it('blocks further publications after a retention failure until cleanup recovers', async () => {
  const backing = new MemoryStore();
  let failCleanup = true;
  const faulty: BlobStore = {
    get: (ns, key) => backing.get(ns, key),
    put: (ns, key, value) => backing.put(ns, key, value),
    delete: (ns, key) => backing.delete(ns, key),
    list: (ns, prefix) => backing.list(ns, prefix),
    transaction: (fn) =>
      backing.transaction((tx) => {
        const wrapped: BlobStore = {
          get: (ns, key) => tx.get(ns, key),
          put: (ns, key, value) => tx.put(ns, key, value),
          delete: async (ns, key) => {
            if (failCleanup) throw new Error('cleanup');
            await tx.delete(ns, key);
          },
          list: (ns, prefix) => tx.list(ns, prefix),
          transaction: (nested) => tx.transaction(nested),
        };
        return fn(wrapped);
      }),
  };
  const save = new GenerationStore(faulty);
  await save.open();
  for (let tick = 1; tick <= 3; tick++) {
    await save.put('region', 'a', new Uint8Array([tick]));
    await save.publish(save.capture(tick, null));
  }
  expect(save.lastRetentionError).toBeInstanceOf(Error);
  await expect(save.publish(save.capture(4, null))).rejects.toThrow(
    'retention cleanup must recover',
  );
  expect((await openApplicationSave(backing)).manifest?.generation).toBe(3);
  failCleanup = false;
  await save.publish(save.capture(4, null));
  expect(save.lastRetentionError).toBeUndefined();
  expect(await backing.list('save_manifest')).toEqual(['3', '4', 'current']);
});

it('detaches Node Buffer inputs despite Buffer.slice returning shared views', async () => {
  const backing = new MemoryStore();
  const store = new GenerationStore(backing);
  await store.open();
  const bytes = Buffer.from([1]);
  await store.put('region', 'staged', bytes);
  bytes[0] = 99;
  const captureBytes = Buffer.from([2]);
  const image = store.capture(1, null, [
    { namespace: 'region', key: 'captured', bytes: captureBytes },
  ]);
  captureBytes[0] = 88;
  await store.publish(image);
  const restored = await openApplicationSave(backing);
  expect(await restored.get('region', 'staged')).toEqual(new Uint8Array([1]));
  expect(await restored.get('region', 'captured')).toEqual(new Uint8Array([2]));
  const original = Buffer.from([3]);
  expect(() =>
    migrateGameSave(original, 0, {
      version: 1,
      migrations: [
        {
          version: 1,
          migrate: (input) => {
            input[0] = 0;
            throw new Error('migration');
          },
        },
      ],
      validate: () => {},
    }),
  ).toThrow('migration');
  expect(original[0]).toBe(3);
});

it('owns publication metadata and bytes while immutable reference reads are pending', async () => {
  const backing = new MemoryStore();
  await backing.put('region', 'legacy', new Uint8Array([1]));
  const store = new GenerationStore(backing);
  await store.open();
  await store.put('region', 'staged', new Uint8Array([2]));
  const image = store.capture(1, { revision: 'original' });
  let release = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const originalGet = backing.get.bind(backing);
  vi.spyOn(backing, 'get').mockImplementation(async (namespace, key) => {
    if (namespace === 'region' && key === 'legacy') {
      entered();
      await hold;
    }
    return originalGet(namespace, key);
  });
  const publishing = store.publish(image);
  await started;
  image.completedTick = 99;
  (image.compatibility as { revision: string }).revision = 'changed';
  image.writes[0]!.bytes![0] = 9;
  image.revisions.length = 0;
  release();
  const manifest = await publishing;
  expect(manifest.completedTick).toBe(1);
  expect(manifest.compatibility).toEqual({ revision: 'original' });
  expect(await store.get('region', 'staged')).toEqual(new Uint8Array([2]));
  expect(await openApplicationSave(backing).then((save) => save.get('region', 'staged'))).toEqual(
    new Uint8Array([2]),
  );
});
