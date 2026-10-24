import type { DeepReadonly } from './readonly.ts';
import {
  assertName,
  defineSchema,
  type FieldMap,
  type FieldType,
  type Infer,
  type Schema,
} from '@conduit/protocol';

export interface ComponentOpts {
  /** Default `true`. */
  replicate?: boolean;
  /** Default `false`. */
  persist?: boolean;
  /** Default `[]`. Validated by `defineGame` (docs/game.md). */
  interpolate?: string[];
  /** Default `undefined`. Validated by `defineGame` (docs/game.md). */
  extrapolateWith?: string;
}

/**
 * A component definition. Structurally a protocol `ComponentLike`, so a list of these is a valid
 * `RegistryInput.components`.
 */
export interface ComponentType<T> {
  readonly name: string;
  /** `defineSchema(fields)` (docs/protocol.md 5). */
  readonly schema: Schema<T>;
  /** A frozen copy of the field declarations, for tooling. */
  readonly fields: FieldMap;
  readonly replicate: boolean;
  readonly persist: boolean;
  readonly interpolate: readonly string[];
  readonly extrapolateWith?: string;
  /** Schema defaults: numbers 0, bool false, str '', vec zero, quat identity, array [], optional undefined, entity ENTITY_NONE, struct recursively. */
  create(): T;
  /** Deep copy of every field of `src` into `dst`; returns `dst`. */
  copy(dst: T, src: DeepReadonly<T>): T;
  /** Copies one field by value (nested vec/struct/array copied into `dst`'s objects, never referenced). */
  copyField(key: keyof T, dst: T, src: Partial<T>): void;
}

type Fields = Record<string, unknown>;

function fieldList(schema: Schema<unknown>): {
  names: readonly string[];
  types: FieldType<unknown>[];
} {
  const names = schema.fieldNames;
  const types: FieldType<unknown>[] = [];
  for (const name of names) {
    const type = schema.fields[name];
    if (type === undefined) throw new RangeError(`schema field ${name} has no type`);
    types.push(type);
  }
  return { names, types };
}

/**
 * Deep-copies `v` into `current` when `current` is an object of the field's shape; primitives and
 * strings are returned as-is (`FieldType.copy`, docs/protocol.md 4.1).
 */
function copyValue(type: FieldType<unknown>, v: unknown, current: unknown): unknown {
  return type.copy(v, current === undefined || current === null ? type.create() : current);
}

/**
 * Builds `create()` for a schema by walking its fields in declaration order: every field gets its
 * kind's default (`FieldType.create`).
 */
export function buildCreate<T>(schema: Schema<T>): () => T {
  const { names, types } = fieldList(schema as Schema<unknown>);
  const n = names.length;
  return () => {
    const out: Fields = {};
    for (let i = 0; i < n; i++) out[names[i]!] = types[i]!.create();
    return out as T;
  };
}

/**
 * Builds `copy(dst, src)` for a schema by walking its fields in declaration order: scalars and
 * strings assign, `vec2/vec3/quat/struct` copy into the existing objects of `dst`, `array` copies
 * the length then the elements, `optional` copies `undefined` or recurses. Returns `dst`.
 */
export function buildCopy<T>(schema: Schema<T>): (dst: T, src: DeepReadonly<T>) => T {
  const { names, types } = fieldList(schema as Schema<unknown>);
  const n = names.length;
  return (dst, src) => {
    const d = dst as Fields;
    const s = src as Readonly<Fields>;
    for (let i = 0; i < n; i++) {
      const name = names[i]!;
      d[name] = copyValue(types[i]!, s[name], d[name]);
    }
    return dst;
  };
}

/**
 * Builds `copyField(key, dst, src)`. A key that is not a field throws `RangeError`. An `undefined`
 * value for a non-optional field leaves `dst` unchanged (it is absent, not a value).
 */
function buildCopyField<T>(schema: Schema<T>): (key: keyof T, dst: T, src: Partial<T>) => void {
  const { names, types } = fieldList(schema as Schema<unknown>);
  const byName = new Map<string, FieldType<unknown>>(); // lookup only
  for (let i = 0; i < names.length; i++) byName.set(names[i]!, types[i]!);
  return (key, dst, src) => {
    const name = key as string;
    const type = byName.get(name);
    if (type === undefined) throw new RangeError(`copyField: ${String(name)} is not a field`);
    const v = (src as Fields)[name];
    if (v === undefined && type.kind !== 'optional') return;
    const d = dst as Fields;
    d[name] = copyValue(type, v, d[name]);
  };
}

/**
 * Defines a component type. `name` must match `NAME_PATTERN` (docs/protocol.md 1); uniqueness and
 * the `interpolate`/`extrapolateWith` names are validated by `defineGame` (docs/game.md).
 */
export function defineComponent<F extends FieldMap>(
  name: string,
  fields: F,
  opts: ComponentOpts = {},
): ComponentType<Infer<F>> {
  assertName(name);
  let schema: Schema<Infer<F>>;
  try {
    schema = defineSchema(fields);
  } catch (err) {
    if (err instanceof RangeError) throw new RangeError(`component ${name}: ${err.message}`);
    throw err;
  }
  const base = {
    name,
    schema,
    fields: schema.fields,
    replicate: opts.replicate ?? true,
    persist: opts.persist ?? false,
    interpolate: Object.freeze([...(opts.interpolate ?? [])]),
  };
  const methods = {
    create: buildCreate(schema),
    copy: buildCopy(schema),
    copyField: buildCopyField(schema),
  };
  const type: ComponentType<Infer<F>> =
    opts.extrapolateWith === undefined
      ? { ...base, ...methods }
      : { ...base, extrapolateWith: opts.extrapolateWith, ...methods };
  return Object.freeze(type);
}
