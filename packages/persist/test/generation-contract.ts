import { describe, expect, it } from 'vitest';
import { GenerationStore, type BlobStore } from '../src/index.ts';

const bytes = (value: number) => new Uint8Array([value]);
const text = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function wrapper(backing: BlobStore, transaction: BlobStore['transaction']): BlobStore {
  return {
    get: (ns, key) => backing.get(ns, key),
    put: (ns, key, value) => backing.put(ns, key, value),
    delete: (ns, key) => backing.delete(ns, key),
    list: (ns, prefix) => backing.list(ns, prefix),
    transaction,
  };
}

export function generationContract(
  name: string,
  create: () => Promise<{ store: BlobStore; close(): void | Promise<void> }>,
) {
  describe(name, () => {
    it('publishes session+regions together, isolates live writes and retains two immutable generations', async () => {
      const fixture = await create();
      try {
        const save = new GenerationStore(fixture.store);
        await save.open();
        for (let tick = 1; tick <= 4; tick++) {
          await save.put('region', 'a', bytes(tick));
          await save.put('session', 'state', bytes(tick));
          await save.publish(save.capture(tick, { game: 'test' }));
          await save.put('region', 'a', bytes(99));
          const restored = new GenerationStore(fixture.store);
          await restored.open();
          expect(await restored.get('region', 'a')).toEqual(bytes(tick));
          expect(await restored.get('session', 'state')).toEqual(bytes(tick));
        }
        expect(await fixture.store.list('save_manifest')).toEqual(['3', '4', 'current']);
        expect(await fixture.store.list('save_data')).toHaveLength(4);
      } finally {
        await fixture.close();
      }
    });

    it('rolls back every publication stage and preserves the prior complete generation', async () => {
      const fixture = await create();
      try {
        let failAt = 0;
        let writes = 0;
        const failing = wrapper(fixture.store, async (fn) =>
          fixture.store.transaction(async (tx) => {
            const transactional = wrapper(tx, (nested) => tx.transaction(nested));
            transactional.put = async (ns, key, value) => {
              if (++writes === failAt) throw new Error('injected write');
              await tx.put(ns, key, value);
            };
            const result = await fn(transactional);
            if (++writes === failAt) throw new Error('injected commit');
            return result;
          }),
        );
        const save = new GenerationStore(failing);
        await save.open();
        await save.put('region', 'a', bytes(1));
        await save.put('session', 'state', bytes(1));
        await save.publish(save.capture(1, null));
        await save.put('region', 'a', bytes(2));
        await save.put('session', 'state', bytes(2));
        for (failAt = 1; failAt <= 5; failAt++) {
          writes = 0;
          await expect(save.publish(save.capture(2, null))).rejects.toThrow('injected');
          const restored = new GenerationStore(fixture.store);
          await restored.open();
          expect(await restored.get('region', 'a')).toEqual(bytes(1));
          expect(await restored.get('session', 'state')).toEqual(bytes(1));
          expect(await save.get('region', 'a')).toEqual(bytes(2));
        }
        failAt = 0;
        await save.publish(save.capture(2, null));
        const restored = new GenerationStore(fixture.store);
        await restored.open();
        expect(await restored.get('region', 'a')).toEqual(bytes(2));
      } finally {
        await fixture.close();
      }
    });

    it('copies legacy content before publication and never modifies the original', async () => {
      const fixture = await create();
      try {
        await fixture.store.put('region', 'a', bytes(1));
        await fixture.store.put('session', 'state', bytes(2));
        const save = new GenerationStore(fixture.store);
        await save.open();
        const manifest = await save.publish(save.capture(0, null));
        expect(manifest.entries.every((entry) => entry.blobNamespace === 'save_data')).toBe(true);
        await fixture.store.put('region', 'a', bytes(99));
        const restored = new GenerationStore(fixture.store);
        await restored.open();
        expect(await restored.get('region', 'a')).toEqual(bytes(1));
        expect(await fixture.store.get('session', 'state')).toEqual(bytes(2));
        await fixture.store.delete('save_data', manifest.entries[0]!.blobKey);
        await expect(new GenerationStore(fixture.store).open()).rejects.toThrow(
          'missing referenced blob',
        );
      } finally {
        await fixture.close();
      }
    });

    it('rejects unknown manifest versions without changing any original bytes', async () => {
      const fixture = await create();
      try {
        await fixture.store.put('save_manifest', 'current', text(1));
        const original = text({ kind: 'app-world', version: 99, generation: 1 });
        await fixture.store.put('save_manifest', '1', original);
        await expect(new GenerationStore(fixture.store).open()).rejects.toThrow(
          'unsupported or malformed',
        );
        expect(await fixture.store.get('save_manifest', '1')).toEqual(original);
      } finally {
        await fixture.close();
      }
    });
  });
}
