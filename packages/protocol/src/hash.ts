import type { FieldType } from './fields.ts';
import type { Schema } from './schema.ts';

/** FNV-1a 32 over the UTF-8 bytes of the input (the `@conduit/math` implementation). */
export { fnv1a32 } from '@conduit/math';

/** The canonical descriptor text (docs/protocol.md 6) of a field type or schema. */
export function descriptorOf(type: FieldType<unknown> | Schema<unknown>): string {
  return type.descriptor;
}
