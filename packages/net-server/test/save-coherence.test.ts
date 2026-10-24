import { GenerationStore, MemoryStore, openApplicationSave } from '@conduit/persist';
import { createCompatibilityDescriptor } from '@conduit/protocol';
import { decodeBlob } from '@conduit/world';
import { describe, expect, it, vi } from 'vitest';
import { createHarness, joinAndSpawn } from './harness.ts';

describe('session generation saves', () => {
  it('detaches session and regions at one tick, then coalesces overlapping flush requests', async () => {
    const capturedTicks: number[] = [];
    const h = await createHarness({
      hooks: {
        onSave: (ctx) => {
          capturedTicks.push(ctx.world.tick);
          return new Uint8Array([ctx.world.tick]);
        },
      },
    });
    await joinAndSpawn(h, h.client());
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = () => {};
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const transaction = h.store.transaction.bind(h.store);
    let first = true;
    vi.spyOn(h.store, 'transaction').mockImplementation(async (fn) => {
      if (first) {
        first = false;
        started();
        await hold;
      }
      return transaction(fn);
    });
    const saving = h.session.flushAll();
    await writing;
    const second = h.session.flushAll();
    const third = h.session.flushAll();
    expect(second).toBe(third);
    await h.step(5);
    release();
    await saving;
    await second;
    expect(capturedTicks).toHaveLength(2);
    expect(capturedTicks[1]).toBe(h.session.tick);
    const firstManifest = JSON.parse(
      new TextDecoder().decode((await h.store.get('save_manifest', '1'))!),
    ) as { completedTick: number; entries: { namespace: string; key: string; blobKey: string }[] };
    expect(firstManifest.completedTick).toBe(capturedTicks[0]);
    for (const entry of firstManifest.entries.filter((entry) => entry.namespace === 'region')) {
      expect(decodeBlob(await h.store.get('save_data', entry.blobKey))?.savedTick).toBe(
        capturedTicks[0],
      );
    }
    const restored = await openApplicationSave(h.store);
    expect(restored.manifest?.completedTick).toBe(capturedTicks[1]);
    expect(await restored.get('session', 'state')).toEqual(new Uint8Array([capturedTicks[1]!]));
    await h.session.stop();
  });

  it('migrates validated legacy game bytes in memory and preserves the original save', async () => {
    const store = new MemoryStore();
    await store.put('session', 'state', new Uint8Array([1]));
    const onLoad = vi.fn();
    const h = await createHarness({
      session: {
        store,
        saveSchema: {
          version: 1,
          migrations: [{ version: 1, migrate: (bytes) => new Uint8Array([bytes[0]! + 1]) }],
          validate: (version, bytes) => {
            if (bytes[0] !== version + 1) throw new Error('invalid game save');
          },
        },
      },
      hooks: { onLoad, onSave: () => new Uint8Array([2]) },
    });
    expect(onLoad).toHaveBeenCalledWith(h.session.ctx, new Uint8Array([2]));
    await h.session.flushAll();
    const restored = await openApplicationSave(store);
    expect(restored.manifest?.gameSaveVersion).toBe(1);
    expect(await restored.get('session', 'state')).toEqual(new Uint8Array([2]));
    expect(await store.get('session', 'state')).toEqual(new Uint8Array([1]));
    await h.session.stop();
  });

  it('leaves original data usable when game migration fails before onLoad', async () => {
    const store = new MemoryStore();
    const original = new Uint8Array([1]);
    await store.put('session', 'state', original);
    const onLoad = vi.fn();
    await expect(
      createHarness({
        session: {
          store,
          saveSchema: {
            version: 1,
            migrations: [
              {
                version: 1,
                migrate: (bytes) => {
                  bytes[0] = 99;
                  throw new Error('bad migration');
                },
              },
            ],
            validate: () => {},
          },
        },
        hooks: { onLoad },
      }),
    ).rejects.toThrow('bad migration');
    expect(onLoad).not.toHaveBeenCalled();
    expect(await store.get('session', 'state')).toEqual(original);
    expect(await store.get('save_manifest', 'current')).toBeNull();
  });

  it('rejects a mismatched saved registry even in schema-only mode and requires an explicit adapter', async () => {
    const store = new MemoryStore();
    const saved = new GenerationStore(store);
    await saved.open();
    await saved.put('session', 'state', new Uint8Array([7]));
    await saved.publish(
      saved.capture(0, createCompatibilityDescriptor('testgame'), [], 0, 0xdeadbeef),
    );
    const pointer = await store.get('save_manifest', 'current');
    const onLoad = vi.fn();
    await expect(createHarness({ session: { store }, hooks: { onLoad } })).rejects.toThrow(
      'saved state schema hash mismatch',
    );
    expect(onLoad).not.toHaveBeenCalled();
    expect(await store.get('save_manifest', 'current')).toEqual(pointer);
    const adapter = vi.fn(
      (previous: number, current: number) => previous === 0xdeadbeef && current !== previous,
    );
    const h = await createHarness({
      session: { store, saveRegistryAdapter: adapter },
      hooks: { onLoad },
    });
    expect(adapter).toHaveBeenCalledWith(0xdeadbeef, h.game.registry.stateSchemaHash);
    expect(onLoad).toHaveBeenCalledWith(h.session.ctx, new Uint8Array([7]));
    await h.session.stop();
  });
});
