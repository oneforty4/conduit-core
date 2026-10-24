import { q, type Quat, type Vec2, type Vec3 } from '@conduit/math';
import type { ByteReader, ByteWriter } from './bytes.ts';
import { ENTITY_NONE, MAX_ARRAY_COUNT, MAX_STR_BYTES, NAME_PATTERN, TAU } from './constants.ts';
import { DecodeError, EncodeError } from './errors.ts';
import { decodeAngle16, encodeAngle16, packQuat, quantize, unpackQuat } from './quant.ts';

export { ENTITY_NONE } from './constants.ts';

/**
 * u32 entity handle. The single definition, re-exported by `@conduit/sim` together with
 * `ENTITY_NONE`; docs/sim.md 2.1 defines the slot/generation layout. 0 is never a live entity.
 */
export type EntityId = number;

export type FieldKind =
  | 'u8'
  | 'i8'
  | 'u16'
  | 'i16'
  | 'u32'
  | 'i32'
  | 'f32'
  | 'bool'
  | 'varuint'
  | 'fixed16'
  | 'fixed32'
  | 'vec2'
  | 'vec3'
  | 'quat'
  | 'angle16'
  | 'str'
  | 'entity'
  | 'array'
  | 'struct'
  | 'optional';

/** A wire type: codec, defaults, deep copy and interpolation metadata (docs/protocol.md 4). */
export interface FieldType<T> {
  readonly kind: FieldKind;
  /** Canonical text, docs/protocol.md 6. */
  readonly descriptor: string;
  /**
   * True when `decodeInto` may allocate even into a target of the right shape: `str` (new string),
   * `array` (growth), `optional` of an object/string/array kind (becoming present), and any struct
   * holding one of those. Numbers, bools, entities, vectors and quats never allocate.
   */
  readonly allocates: boolean;
  /** True for u8..f32, varuint, fixed16, fixed32, angle16. */
  readonly numeric: boolean;
  /** Present only where interpolation is defined (docs/protocol.md 4.4). */
  lerp?(a: T, b: T, t: number, out: T): T;
  encode(w: ByteWriter, v: T): void;
  /** Allocates for object kinds. */
  decode(r: ByteReader): T;
  /** Reuses `target` where possible; returns `target` (or the new primitive/string). */
  decodeInto(r: ByteReader, target: T): T;
  /** Default: 0, false, '', ENTITY_NONE, zero vector, identity quat, [], struct of defaults, undefined. */
  create(): T;
  /** Deep copy into `out` (object kinds; returns `out`), or returns `v` (primitives, strings). */
  copy(v: T, out: T): T;
}

export type FieldMap = { readonly [name: string]: FieldType<unknown> };
export type NumericFieldType = FieldType<number> & { readonly numeric: true };

export type Infer<F> =
  F extends FieldType<infer T> ? T : F extends FieldMap ? { [K in keyof F]: Infer<F[K]> } : never;

type AnyObject = Record<string, unknown>;

function assertFieldType(where: string, t: unknown): asserts t is FieldType<unknown> {
  const ft = t as FieldType<unknown> | null | undefined;
  if (
    typeof ft !== 'object' ||
    ft === null ||
    typeof ft.kind !== 'string' ||
    typeof ft.encode !== 'function' ||
    typeof ft.decode !== 'function'
  ) {
    throw new RangeError(`${where}: expected a FieldType built with f.*`);
  }
}

function linear(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function same<T>(v: T): T {
  return v;
}

interface NumberCodec {
  encode(w: ByteWriter, v: number): void;
  decode(r: ByteReader): number;
}

function numeric(
  kind: FieldKind,
  descriptor: string,
  codec: NumberCodec,
  lerp: (a: number, b: number, t: number) => number = linear,
): NumericFieldType {
  return Object.freeze({
    kind,
    descriptor,
    allocates: false,
    numeric: true as const,
    lerp,
    encode: codec.encode,
    decode: codec.decode,
    decodeInto: codec.decode,
    create: () => 0,
    copy: same,
  });
}

const u8 = numeric('u8', 'u8', { encode: (w, v) => w.u8(v), decode: (r) => r.u8() });
const i8 = numeric('i8', 'i8', { encode: (w, v) => w.i8(v), decode: (r) => r.i8() });
const u16 = numeric('u16', 'u16', { encode: (w, v) => w.u16(v), decode: (r) => r.u16() });
const i16 = numeric('i16', 'i16', { encode: (w, v) => w.i16(v), decode: (r) => r.i16() });
const u32 = numeric('u32', 'u32', { encode: (w, v) => w.u32(v), decode: (r) => r.u32() });
const i32 = numeric('i32', 'i32', { encode: (w, v) => w.i32(v), decode: (r) => r.i32() });
const f32 = numeric('f32', 'f32', {
  encode(w, v) {
    if (!Number.isFinite(v)) throw new EncodeError('nan', 'f32 schema value must be finite');
    if (!Number.isFinite(Math.fround(v)))
      throw new EncodeError('range', 'f32 schema value overflows wire representation');
    w.f32(v);
  },
  decode(r) {
    const offset = r.offset;
    const value = r.f32();
    if (!Number.isFinite(value))
      throw new DecodeError('range', offset, 'f32 schema value must be finite');
    return value;
  },
});
const varuint = numeric('varuint', 'varuint', {
  encode: (w, v) => w.varuint(v),
  decode: (r) => r.varuint(),
});

function decodeBool(r: ByteReader): boolean {
  const offset = r.offset;
  const b = r.u8();
  if (b > 1) throw new DecodeError('range', offset, `bool byte ${b} > 1`);
  return b === 1;
}

const bool: FieldType<boolean> = Object.freeze({
  kind: 'bool',
  descriptor: 'bool',
  allocates: false,
  numeric: false,
  encode: (w: ByteWriter, v: boolean) => w.u8(v ? 1 : 0),
  decode: decodeBool,
  decodeInto: decodeBool,
  create: () => false,
  copy: same,
});

function assertScale(kind: string, scale: number): void {
  if (!(Number.isFinite(scale) && scale > 0)) {
    throw new RangeError(`f.${kind}: scale must be finite and > 0, got ${String(scale)}`);
  }
}

function fixed16(scale: number): NumericFieldType {
  assertScale('fixed16', scale);
  return numeric('fixed16', `fixed16(${String(scale)})`, {
    encode: (w, v) => w.i16(quantize(v, scale, -32768, 32767)),
    decode: (r) => r.i16() * scale,
  });
}

function fixed32(scale: number): NumericFieldType {
  assertScale('fixed32', scale);
  return numeric('fixed32', `fixed32(${String(scale)})`, {
    encode: (w, v) => w.i32(quantize(v, scale, -2147483648, 2147483647)),
    decode: (r) => r.i32() * scale,
  });
}

function angleLerp(a: number, b: number, t: number): number {
  const x = b - a + Math.PI;
  const d = (((x % TAU) + TAU) % TAU) - Math.PI; // shortest signed difference
  const y = (a + d * t) / TAU;
  return (((y % 1) + 1) % 1) * TAU;
}

const angle16Type = numeric(
  'angle16',
  'angle16',
  { encode: (w, v) => w.u16(encodeAngle16(v)), decode: (r) => decodeAngle16(r.u16()) },
  angleLerp,
);

function elementLerp(
  kind: string,
  elem: NumericFieldType,
): (a: number, b: number, t: number) => number {
  assertFieldType(`f.${kind}`, elem);
  if (elem.numeric !== true) {
    throw new RangeError(`f.${kind}: element must be a numeric field type, got ${elem.kind}`);
  }
  const l = elem.lerp;
  if (l === undefined) return linear;
  return (a, b, t) => l.call(elem, a, b, t, 0);
}

function vec2(elem: NumericFieldType): FieldType<Vec2> {
  const lerpC = elementLerp('vec2', elem);
  const decode = (r: ByteReader): Vec2 => {
    const x = elem.decode(r);
    const y = elem.decode(r);
    return { x, y };
  };
  const type: FieldType<Vec2> = {
    kind: 'vec2',
    descriptor: `vec2(${elem.descriptor})`,
    allocates: false,
    numeric: false,
    lerp(a, b, t, out) {
      const x = lerpC(a.x, b.x, t);
      const y = lerpC(a.y, b.y, t);
      const o = out ?? { x: 0, y: 0 };
      o.x = x;
      o.y = y;
      return o;
    },
    encode(w, v) {
      elem.encode(w, v.x);
      elem.encode(w, v.y);
    },
    decode,
    decodeInto(r, target) {
      if (target == null) return decode(r);
      target.x = elem.decode(r);
      target.y = elem.decode(r);
      return target;
    },
    create: () => ({ x: 0, y: 0 }),
    copy(v, out) {
      const o = out ?? { x: 0, y: 0 };
      o.x = v.x;
      o.y = v.y;
      return o;
    },
  };
  return Object.freeze(type);
}

function vec3(elem: NumericFieldType): FieldType<Vec3> {
  const lerpC = elementLerp('vec3', elem);
  const decode = (r: ByteReader): Vec3 => {
    const x = elem.decode(r);
    const y = elem.decode(r);
    const z = elem.decode(r);
    return { x, y, z };
  };
  const type: FieldType<Vec3> = {
    kind: 'vec3',
    descriptor: `vec3(${elem.descriptor})`,
    allocates: false,
    numeric: false,
    lerp(a, b, t, out) {
      const x = lerpC(a.x, b.x, t);
      const y = lerpC(a.y, b.y, t);
      const z = lerpC(a.z, b.z, t);
      const o = out ?? { x: 0, y: 0, z: 0 };
      o.x = x;
      o.y = y;
      o.z = z;
      return o;
    },
    encode(w, v) {
      elem.encode(w, v.x);
      elem.encode(w, v.y);
      elem.encode(w, v.z);
    },
    decode,
    decodeInto(r, target) {
      if (target == null) return decode(r);
      target.x = elem.decode(r);
      target.y = elem.decode(r);
      target.z = elem.decode(r);
      return target;
    },
    create: () => ({ x: 0, y: 0, z: 0 }),
    copy(v, out) {
      const o = out ?? { x: 0, y: 0, z: 0 };
      o.x = v.x;
      o.y = v.y;
      o.z = v.z;
      return o;
    },
  };
  return Object.freeze(type);
}

const quatType: FieldType<Quat> = Object.freeze({
  kind: 'quat',
  descriptor: 'quat',
  allocates: false,
  numeric: false,
  lerp: (a: Quat, b: Quat, t: number, out: Quat) => q.slerp(a, b, t, out ?? undefined),
  encode: (w: ByteWriter, v: Quat) => w.u32(packQuat(v)),
  decode: (r: ByteReader) => unpackQuat(r.u32(), { x: 0, y: 0, z: 0, w: 1 }),
  decodeInto: (r: ByteReader, target: Quat) =>
    unpackQuat(r.u32(), target ?? { x: 0, y: 0, z: 0, w: 1 }),
  create: () => ({ x: 0, y: 0, z: 0, w: 1 }),
  copy(v: Quat, out: Quat) {
    const o = out ?? { x: 0, y: 0, z: 0, w: 1 };
    o.x = v.x;
    o.y = v.y;
    o.z = v.z;
    o.w = v.w;
    return o;
  },
});

function str(max: number): FieldType<string> {
  if (!Number.isInteger(max) || max < 1 || max > MAX_STR_BYTES) {
    throw new RangeError(
      `f.str: max must be an integer in 1..${MAX_STR_BYTES}, got ${String(max)}`,
    );
  }
  const decode = (r: ByteReader): string => r.utf8(max);
  return Object.freeze({
    kind: 'str',
    descriptor: `str(${max})`,
    allocates: true,
    numeric: false,
    encode: (w: ByteWriter, v: string) => w.utf8(v, max),
    decode,
    decodeInto: decode,
    create: () => '',
    copy: same,
  });
}

const entityType: FieldType<EntityId> = Object.freeze({
  kind: 'entity',
  descriptor: 'entity',
  allocates: false,
  numeric: false,
  encode: (w: ByteWriter, v: EntityId) => w.u32(v),
  decode: (r: ByteReader) => r.u32(),
  decodeInto: (r: ByteReader) => r.u32(),
  create: () => ENTITY_NONE,
  copy: same,
});

function array<E>(elem: FieldType<E>, max: number): FieldType<E[]> {
  assertFieldType('f.array', elem);
  if (!Number.isInteger(max) || max < 1 || max > MAX_ARRAY_COUNT) {
    throw new RangeError(
      `f.array: max must be an integer in 1..${MAX_ARRAY_COUNT}, got ${String(max)}`,
    );
  }
  const readCount = (r: ByteReader): number => {
    const offset = r.offset;
    const n = r.u16();
    if (n > max) throw new DecodeError('count', offset, `array count ${n} exceeds max ${max}`);
    return n;
  };
  const decode = (r: ByteReader): E[] => {
    const n = readCount(r);
    const out: E[] = [];
    for (let i = 0; i < n; i++) out.push(elem.decode(r));
    return out;
  };
  const type: FieldType<E[]> = {
    kind: 'array',
    descriptor: `array(${elem.descriptor},${max})`,
    allocates: true,
    numeric: false,
    encode(w, v) {
      const n = v.length;
      if (n > max) throw new EncodeError('count', `array of ${n} elements exceeds max ${max}`);
      w.u16(n);
      for (let i = 0; i < n; i++) elem.encode(w, v[i] as E);
    },
    decode,
    decodeInto(r, target) {
      if (target == null) return decode(r);
      const n = readCount(r);
      if (target.length > n) target.length = n;
      for (let i = 0; i < n; i++) {
        if (i < target.length) target[i] = elem.decodeInto(r, target[i] as E);
        else target.push(elem.decode(r));
      }
      return target;
    },
    create: () => [],
    copy(v, out) {
      const o = out ?? [];
      const n = v.length;
      if (o.length > n) o.length = n;
      for (let i = 0; i < n; i++) {
        const src = v[i] as E;
        if (i < o.length) {
          const cur = o[i];
          o[i] = elem.copy(src, cur == null ? elem.create() : cur);
        } else {
          o.push(elem.copy(src, elem.create()));
        }
      }
      return o;
    },
  };
  return Object.freeze(type);
}

function struct<F extends FieldMap>(fields: F): FieldType<Infer<F>> {
  if (typeof fields !== 'object' || fields === null) {
    throw new RangeError('f.struct: fields must be an object');
  }
  const names = Object.keys(fields);
  const types: FieldType<unknown>[] = [];
  let allocates = false;
  for (const name of names) {
    if (!NAME_PATTERN.test(name)) {
      throw new RangeError(`f.struct: invalid field name ${JSON.stringify(name)}`);
    }
    const t = fields[name];
    assertFieldType(`f.struct field ${name}`, t);
    types.push(t);
    if (t.allocates) allocates = true;
  }
  const n = names.length;
  const descriptor = `struct{${names.map((name, i) => `${name}:${types[i]!.descriptor}`).join(',')}}`;

  const decode = (r: ByteReader): AnyObject => {
    const o: AnyObject = {};
    for (let i = 0; i < n; i++) o[names[i]!] = types[i]!.decode(r);
    return o;
  };
  const type: FieldType<AnyObject> = {
    kind: 'struct',
    descriptor,
    allocates,
    numeric: false,
    encode(w, v) {
      for (let i = 0; i < n; i++) types[i]!.encode(w, v[names[i]!]);
    },
    decode,
    decodeInto(r, target) {
      if (target == null) return decode(r);
      for (let i = 0; i < n; i++) {
        const name = names[i]!;
        target[name] = types[i]!.decodeInto(r, target[name]);
      }
      return target;
    },
    create() {
      const o: AnyObject = {};
      for (let i = 0; i < n; i++) o[names[i]!] = types[i]!.create();
      return o;
    },
    copy(v, out) {
      const o = out ?? {};
      for (let i = 0; i < n; i++) {
        const name = names[i]!;
        const t = types[i]!;
        const cur = o[name];
        o[name] = t.copy(v[name], cur == null ? t.create() : cur);
      }
      return o;
    },
  };
  return Object.freeze(type) as unknown as FieldType<Infer<F>>;
}

function optional<E>(of: FieldType<E>): FieldType<E | undefined> {
  assertFieldType('f.optional', of);
  if (of.kind === 'optional') {
    throw new RangeError('f.optional: optional(optional(x)) is not allowed');
  }
  const readFlag = (r: ByteReader): boolean => {
    const offset = r.offset;
    const flag = r.u8();
    if (flag > 1) throw new DecodeError('range', offset, `optional flag ${flag} > 1`);
    return flag === 1;
  };
  const objectKind =
    of.kind === 'vec2' || of.kind === 'vec3' || of.kind === 'quat' || of.kind === 'struct';
  const type: FieldType<E | undefined> = {
    kind: 'optional',
    descriptor: `optional(${of.descriptor})`,
    allocates: of.allocates || objectKind,
    numeric: false,
    encode(w, v) {
      if (v === undefined) {
        w.u8(0);
      } else {
        w.u8(1);
        of.encode(w, v);
      }
    },
    decode: (r) => (readFlag(r) ? of.decode(r) : undefined),
    decodeInto(r, target) {
      if (!readFlag(r)) return undefined;
      return target === undefined ? of.decode(r) : of.decodeInto(r, target);
    },
    create: () => undefined,
    copy: (v, out) => (v === undefined ? undefined : of.copy(v, out == null ? of.create() : out)),
  };
  return Object.freeze(type);
}

/** The field-type DSL (docs/protocol.md 4.2). */
export const f: {
  readonly u8: NumericFieldType;
  readonly i8: NumericFieldType;
  readonly u16: NumericFieldType;
  readonly i16: NumericFieldType;
  readonly u32: NumericFieldType;
  readonly i32: NumericFieldType;
  readonly f32: NumericFieldType;
  readonly bool: FieldType<boolean>;
  readonly varuint: NumericFieldType;
  fixed16(scale: number): NumericFieldType;
  fixed32(scale: number): NumericFieldType;
  vec2(elem: NumericFieldType): FieldType<Vec2>;
  vec3(elem: NumericFieldType): FieldType<Vec3>;
  quat(): FieldType<Quat>;
  angle16(): NumericFieldType;
  str(max: number): FieldType<string>;
  entity(): FieldType<EntityId>;
  array<E>(elem: FieldType<E>, max: number): FieldType<E[]>;
  struct<F extends FieldMap>(fields: F): FieldType<Infer<F>>;
  optional<E>(of: FieldType<E>): FieldType<E | undefined>;
} = Object.freeze({
  u8,
  i8,
  u16,
  i16,
  u32,
  i32,
  f32,
  bool,
  varuint,
  fixed16,
  fixed32,
  vec2,
  vec3,
  quat: () => quatType,
  angle16: () => angle16Type,
  str,
  entity: () => entityType,
  array,
  struct,
  optional,
});
