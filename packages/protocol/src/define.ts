import { NAME_PATTERN } from './constants.ts';
import type { FieldMap, FieldType, Infer } from './fields.ts';
import { CoreKind } from './messages.ts';
import type { EventDef, MessageDef, MessageDirection } from './registry.ts';
import { defineSchema, type Schema } from './schema.ts';

/** Throws `RangeError` unless `name` matches `NAME_PATTERN`. */
export function assertName(name: string): void {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new RangeError(
      `invalid name ${JSON.stringify(name)}: must match ${String(NAME_PATTERN)}`,
    );
  }
}

function schemaFor<F extends FieldMap>(what: string, fields: F): Schema<Infer<F>> {
  try {
    return defineSchema(fields);
  } catch (err) {
    if (err instanceof RangeError) throw new RangeError(`${what}: ${err.message}`);
    throw err;
  }
}

/**
 * A game message (kinds are assigned by `SchemaRegistry` from sorted names). Throws `RangeError`
 * for an invalid or core name (`Hello`, `Ready`, ... case-sensitive), an invalid direction or
 * invalid fields.
 */
export function defineMessage<F extends FieldMap>(
  name: string,
  direction: MessageDirection,
  fields: F,
): MessageDef<Infer<F>> {
  assertName(name);
  if (Object.hasOwn(CoreKind, name)) {
    throw new RangeError(`message name ${name} is reserved for a core message`);
  }
  if (direction !== 'c2s' && direction !== 's2c' && direction !== 'both') {
    throw new RangeError(`message ${name}: invalid direction ${JSON.stringify(direction)}`);
  }
  const schema = schemaFor(`message ${name}`, fields);
  return Object.freeze({ name, direction, schema, core: false });
}

/**
 * An event type. `replicate` defaults to `false`; non-replicated events never reach the wire but
 * still receive ids, so the sim's EventBus uses one id space.
 */
export function defineEvent<F extends FieldMap>(
  name: string,
  fields: F,
  opts?: { replicate?: boolean },
): EventDef<Infer<F>> {
  assertName(name);
  const schema = schemaFor(`event ${name}`, fields);
  return Object.freeze({ name, schema, replicate: opts?.replicate === true });
}

/**
 * The input frame schema. `tick: f.u32` must be the first declared field so a server can read the
 * tick without decoding the rest; any other fields may follow.
 */
export function defineInput<F extends FieldMap & { tick: FieldType<number> }>(
  fields: F,
): Schema<Infer<F>> {
  const first = Object.keys(fields)[0];
  const tick = (fields as FieldMap)['tick'];
  if (first !== 'tick' || tick === undefined || tick.kind !== 'u32') {
    throw new RangeError('defineInput: the first field must be tick: f.u32');
  }
  return schemaFor('input', fields);
}
