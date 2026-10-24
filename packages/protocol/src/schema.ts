import type { ByteReader, ByteWriter } from './bytes.ts';
import { EncodeError } from './errors.ts';
import { f, type FieldMap, type FieldType, type Infer } from './fields.ts';
import { fnv1a32 } from './hash.ts';

/** A named-field struct type plus its descriptor and hash (docs/protocol.md 5). */
export interface Schema<T> {
  /** The field map as passed (a frozen shallow copy). */
  readonly fields: FieldMap;
  /** Declaration order. */
  readonly fieldNames: readonly string[];
  /** `f.struct(fields)`. */
  readonly type: FieldType<T>;
  /** `type.descriptor`. */
  readonly descriptor: string;
  /** `fnv1a32(descriptor)`, u32. */
  readonly hash: number;
  /** True if any field allocates; when false, `decodeInto` performs zero allocations. */
  readonly allocates: boolean;
  create(): T;
  copy(v: T, out: T): T;
  /** Same as `encodeWith`: on a throw the writer is truncated back to where it was. */
  encode(w: ByteWriter, v: T): void;
  decode(r: ByteReader): T;
  decodeInto(r: ByteReader, target: T): void;
}

function encodeAtomic<T>(w: ByteWriter, type: FieldType<T>, value: T): void {
  const start = w.length;
  try {
    type.encode(w, value);
  } catch (err) {
    if (w.length >= start) w.truncate(start);
    throw err;
  }
}

export function defineSchema<F extends FieldMap>(fields: F): Schema<Infer<F>> {
  const type = f.struct(fields);
  const descriptor = type.descriptor;
  const schema: Schema<Infer<F>> = {
    fields: Object.freeze({ ...fields }),
    fieldNames: Object.freeze(Object.keys(fields)),
    type,
    descriptor,
    hash: fnv1a32(descriptor),
    allocates: type.allocates,
    create: () => type.create(),
    copy: (v, out) => type.copy(v, out),
    encode: (w, v) => encodeAtomic(w, type, v),
    decode: (r) => type.decode(r),
    decodeInto: (r, target) => {
      type.decodeInto(r, target);
    },
  };
  return Object.freeze(schema);
}

/**
 * Encodes `value` with `schema`. If encoding throws (an `EncodeError` or anything else), the writer
 * is truncated back to its length before the call and the error is rethrown.
 */
export function encodeWith<T>(w: ByteWriter, schema: Schema<T>, value: T): void {
  encodeAtomic(w, schema.type, value);
}

/** Decodes a freshly allocated value. */
export function decodeWith<T>(r: ByteReader, schema: Schema<T>): T {
  return schema.type.decode(r);
}

/** Decodes into `target`, reusing nested objects and array elements (docs/protocol.md 5.1). */
export function decodeInto<T>(r: ByteReader, schema: Schema<T>, target: T): void {
  schema.type.decodeInto(r, target);
}

/** The most top-level fields a field mask addresses (docs/protocol.md 5.2). */
const MASK_MAX_FIELDS = 16;

/** An integer in `0 .. 2^fieldCount - 1`, for at most 16 fields. */
function isFieldMask(fieldCount: number, mask: number): boolean {
  return (
    fieldCount <= MASK_MAX_FIELDS && Number.isInteger(mask) && mask >= 0 && mask < 1 << fieldCount
  );
}

/**
 * Bytes of a field mask for `schema` (docs/protocol.md 5.2): 1 for at most 8 top-level fields, 2 for
 * 9 to 16, and 0 for wider schemas, which have no mask and are always encoded whole.
 */
export function fieldMaskBytes<T>(schema: Schema<T>): 0 | 1 | 2 {
  const n = schema.fieldNames.length;
  return n <= 8 ? 1 : n <= MASK_MAX_FIELDS ? 2 : 0;
}

/**
 * Writes the fields of `value` that `mask` selects (bit i = `schema.fieldNames[i]`), in declaration
 * order, and nothing else: no mask, and unselected fields are not read, so `value` may be partial
 * (docs/protocol.md 5.2). A mask outside `0 .. 2^N - 1`, or a schema of more than 16 fields, throws
 * `EncodeError('range')`. On any throw the writer is truncated back to its length before the call.
 */
export function encodeFields<T>(
  w: ByteWriter,
  schema: Schema<T>,
  value: Partial<T>,
  mask: number,
): void {
  const names = schema.fieldNames;
  if (!isFieldMask(names.length, mask)) {
    throw new EncodeError(
      'range',
      `field mask ${String(mask)} is not valid for ${names.length} fields`,
    );
  }
  const fields = value as Record<string, unknown>;
  const start = w.length;
  try {
    for (let i = 0; i < names.length; i++) {
      if ((mask & (1 << i)) === 0) continue;
      const name = names[i]!;
      schema.fields[name]!.encode(w, fields[name]);
    }
  } catch (err) {
    if (w.length >= start) w.truncate(start);
    throw err;
  }
}

/**
 * Reads the fields that `mask` selects into a fresh object whose own keys are exactly those fields,
 * in declaration order; unselected fields are absent (docs/protocol.md 5.2). An invalid mask throws
 * `RangeError` before reading: decoders validate masks they read off the wire themselves.
 */
export function decodeFields<T>(r: ByteReader, schema: Schema<T>, mask: number): Partial<T> {
  const names = schema.fieldNames;
  if (!isFieldMask(names.length, mask)) {
    throw new RangeError(
      `decodeFields: mask ${String(mask)} is not valid for ${names.length} fields`,
    );
  }
  const out: Record<string, unknown> = {};
  for (let i = 0; i < names.length; i++) {
    if ((mask & (1 << i)) === 0) continue;
    const name = names[i]!;
    out[name] = schema.fields[name]!.decode(r);
  }
  return out as Partial<T>;
}
