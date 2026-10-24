import { FNV_BASIS, fnv1a32, fnv1a32u32 } from '@conduit/math';
import { ByteWriter, encodeWith } from '@conduit/protocol';
import type { World } from './world.ts';

/**
 * Deterministic u32 state hash over the replicated stores (docs/sim.md 2.6): per replicated store in
 * component id order, the id and size, then per entity in ascending slot order the id and the
 * schema-encoded bytes of the value. Hashing encoded bytes makes the hash follow quantization.
 * `scratch` is reset before each value; `World.hash()` passes its own reusable writer.
 */
export function hashWorld(world: World, scratch: ByteWriter = new ByteWriter(256)): number {
  let h = FNV_BASIS;
  const stores = world.stores();
  for (let id = 0; id < stores.length; id++) {
    const store = stores[id]!;
    if (!store.type.replicate) continue;
    h = fnv1a32u32(h, id);
    h = fnv1a32u32(h, store.size);
    const schema = store.type.schema;
    const order = store.entitiesArray();
    for (let i = 0; i < order.length; i++) {
      const e = order[i]!;
      h = fnv1a32u32(h, e);
      scratch.reset();
      encodeWith(scratch, schema, store.read(e));
      h = fnv1a32(scratch.view(), h);
    }
  }
  return h;
}
