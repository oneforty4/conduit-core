import { fnv1a32, q, Rng, type Quat, type Vec2, type Vec3 } from '@conduit/math';
import { describe, expect, it } from 'vitest';
import {
  ByteReader,
  ByteWriter,
  DecodeError,
  EncodeError,
  ENTITY_NONE,
  f,
  MAX_ARRAY_COUNT,
  MAX_STR_BYTES,
  TAU,
  type DecodeErrorCode,
  type EncodeErrorCode,
  type EntityId,
  type FieldType,
  type Infer,
  type NumericFieldType,
} from '../src/index.ts';

// ---------------------------------------------------------------------------------------------
// helpers

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

function fromHex(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function encodeErr(fn: () => unknown): EncodeErrorCode | 'none' {
  try {
    fn();
  } catch (err) {
    if (err instanceof EncodeError) return err.code;
    throw err;
  }
  return 'none';
}

function decodeErr(fn: () => unknown): { code: DecodeErrorCode; offset: number } | 'none' {
  try {
    fn();
  } catch (err) {
    if (err instanceof DecodeError) return { code: err.code, offset: err.offset };
    throw err;
  }
  return 'none';
}

function encode<T>(type: FieldType<T>, v: T): Uint8Array {
  const w = new ByteWriter();
  type.encode(w, v);
  return w.finish();
}

function show(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x === undefined ? '<undefined>' : typeof x === 'number' && !Number.isFinite(x) ? String(x) : x,
  );
}

// ---------------------------------------------------------------------------------------------
// models: a generator, the value expected after one encode/decode (from the spec formulas), and
// an equality

interface Model<T> {
  type: FieldType<T>;
  gen(rng: Rng): T;
  expect(v: T): T;
  eq(a: T, b: T): boolean;
  /** Re-encoding a decoded value reproduces the bytes (false for quat). */
  idem: boolean;
}

type NumModel = Model<number> & { type: NumericFieldType };

const eqNum = (a: number, b: number): boolean => a === b || (Number.isNaN(a) && Number.isNaN(b));

function num(type: NumericFieldType, gen: (r: Rng) => number, exp = (v: number) => v): NumModel {
  return { type, gen, expect: exp, eq: eqNum, idem: true };
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function fixedModel(bits: 16 | 32, scale: number, spread: number): NumModel {
  const lo = bits === 16 ? -32768 : -2147483648;
  const hi = bits === 16 ? 32767 : 2147483647;
  const type = bits === 16 ? f.fixed16(scale) : f.fixed32(scale);
  return num(
    type,
    (r) => (r.float() * 2 - 1) * spread,
    (v) => clampInt(Math.round(v / scale), lo, hi) * scale,
  );
}

const F32_SPECIAL = [0, -0, 1e-45, 3.4028234663852886e38];

const models = {
  u8: num(f.u8, (r) => r.int(0, 255)),
  i8: num(f.i8, (r) => r.int(-128, 127)),
  u16: num(f.u16, (r) => r.int(0, 65535)),
  i16: num(f.i16, (r) => r.int(-32768, 32767)),
  u32: num(f.u32, (r) => r.next()),
  i32: num(f.i32, (r) => r.next() | 0),
  f32: num(
    f.f32,
    (r) =>
      r.chance(0.05) ? (r.pick(F32_SPECIAL) as number) : (r.float() * 2 - 1) * 10 ** r.int(-40, 38),
    Math.fround,
  ),
  varuint: num(f.varuint, (r) => r.next() >>> r.int(0, 31)),
  fixed16: fixedModel(16, 0.01, 400), // exceeds +-327.67 sometimes: clamps
  fixed32: fixedModel(32, 0.001, 3e6), // exceeds +-2147483.647 sometimes: clamps
  angle16: num(
    f.angle16(),
    (r) => (r.float() * 2 - 1) * 50,
    (v) => ((Math.round(((((v / TAU) % 1) + 1) % 1) * 65536) & 0xffff) * TAU) / 65536,
  ),
};

const boolModel: Model<boolean> = {
  type: f.bool,
  gen: (r) => r.chance(0.5),
  expect: (v) => v,
  eq: (a, b) => a === b,
  idem: true,
};

const entityModel: Model<EntityId> = {
  type: f.entity(),
  gen: (r) => (r.chance(0.1) ? ENTITY_NONE : r.next()),
  expect: (v) => v,
  eq: (a, b) => a === b,
  idem: true,
};

const CODE_POINTS = [
  0x00, 0x7f, 0xe9, 0x7ff, 0x800, 0x20ac, 0x65e5, 0xfeff, 0xfffd, 0xffff, 0x10000, 0x1f600,
  0x10ffff,
];

function strModel(max: number): Model<string> {
  return {
    type: f.str(max),
    gen(r) {
      let s = '';
      let bytes = 0;
      const n = r.int(0, max);
      for (let i = 0; i < n; i++) {
        const cp = r.chance(0.6) ? r.int(0x20, 0x7e) : (r.pick(CODE_POINTS) as number);
        const len = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
        if (bytes + len > max) break;
        s += String.fromCodePoint(cp);
        bytes += len;
      }
      return s;
    },
    expect: (v) => v,
    eq: (a, b) => a === b,
    idem: true,
  };
}

function vec2Model(elem: NumModel): Model<Vec2> {
  return {
    type: f.vec2(elem.type),
    gen: (r) => ({ x: elem.gen(r), y: elem.gen(r) }),
    expect: (v) => ({ x: elem.expect(v.x), y: elem.expect(v.y) }),
    eq: (a, b) => elem.eq(a.x, b.x) && elem.eq(a.y, b.y),
    idem: true,
  };
}

function vec3Model(elem: NumModel): Model<Vec3> {
  return {
    type: f.vec3(elem.type),
    gen: (r) => ({ x: elem.gen(r), y: elem.gen(r), z: elem.gen(r) }),
    expect: (v) => ({ x: elem.expect(v.x), y: elem.expect(v.y), z: elem.expect(v.z) }),
    eq: (a, b) => elem.eq(a.x, b.x) && elem.eq(a.y, b.y) && elem.eq(a.z, b.z),
    idem: true,
  };
}

function randomUnitQuat(rng: Rng): Quat {
  for (;;) {
    const r = q.create(
      rng.float() * 2 - 1,
      rng.float() * 2 - 1,
      rng.float() * 2 - 1,
      rng.float() * 2 - 1,
    );
    if (q.length(r) > 0.1) return q.normalize(r);
  }
}

const quatModel: Model<Quat> = {
  type: f.quat(),
  gen: randomUnitQuat,
  expect: (v) => v,
  eq: (a, b) => Math.abs(q.dot(a, b)) > 0.9999,
  idem: false,
};

function arrayModel<E>(elem: Model<E>, max: number): Model<E[]> {
  return {
    type: f.array(elem.type, max),
    gen: (r) => {
      const n = r.int(0, max);
      const out: E[] = [];
      for (let i = 0; i < n; i++) out.push(elem.gen(r));
      return out;
    },
    expect: (v) => v.map((e) => elem.expect(e)),
    eq: (a, b) => a.length === b.length && a.every((e, i) => elem.eq(e, b[i] as E)),
    idem: elem.idem,
  };
}

function optionalModel<E>(of: Model<E>): Model<E | undefined> {
  return {
    type: f.optional(of.type),
    gen: (r) => (r.chance(0.3) ? undefined : of.gen(r)),
    expect: (v) => (v === undefined ? undefined : of.expect(v)),
    eq: (a, b) => (a === undefined || b === undefined ? a === b : of.eq(a, b)),
    idem: of.idem,
  };
}

type AnyModel = Model<unknown>;
const erase = <T>(m: Model<T>): AnyModel => m as unknown as AnyModel;

function structModel(fields: Record<string, AnyModel>): Model<Record<string, unknown>> {
  const names = Object.keys(fields);
  const types: Record<string, FieldType<unknown>> = {};
  for (const n of names) types[n] = (fields[n] as AnyModel).type;
  const field = (n: string): AnyModel => fields[n] as AnyModel;
  return {
    type: f.struct(types) as FieldType<Record<string, unknown>>,
    gen: (r) => {
      const o: Record<string, unknown> = {};
      for (const n of names) o[n] = field(n).gen(r);
      return o;
    },
    expect: (v) => {
      const o: Record<string, unknown> = {};
      for (const n of names) o[n] = field(n).expect(v[n]);
      return o;
    },
    eq: (a, b) => names.every((n) => n in a && n in b && field(n).eq(a[n], b[n])),
    idem: names.every((n) => field(n).idem),
  };
}

function checkRoundTrips(name: string, model: AnyModel, cases = 10_000): void {
  const rng = new Rng(fnv1a32(name));
  const w = new ByteWriter();
  const w2 = new ByteWriter();
  let target = model.type.create();
  let failures = 0;
  let first: string | undefined;
  for (let i = 0; i < cases; i++) {
    const v = model.gen(rng);
    w.reset();
    model.type.encode(w, v);
    const bytes = w.view();
    const r1 = new ByteReader(bytes);
    const decoded = model.type.decode(r1);
    const r2 = new ByteReader(bytes);
    target = model.type.decodeInto(r2, target);
    const expected = model.expect(v);
    let ok =
      r1.remaining() === 0 &&
      r2.remaining() === 0 &&
      model.eq(decoded, expected) &&
      model.eq(target, expected);
    if (ok && model.idem) {
      w2.reset();
      model.type.encode(w2, decoded);
      ok = bytesEqual(w2.view(), bytes);
    }
    if (!ok) {
      failures++;
      first ??= `case ${i}: in ${show(v)} bytes [${hex(bytes)}] decoded ${show(decoded)} into ${show(target)} expected ${show(expected)}`;
    }
  }
  expect(first).toBeUndefined();
  expect(failures).toBe(0);
}

// ---------------------------------------------------------------------------------------------

describe('seeded property round-trips (10 000 cases per kind)', () => {
  const kinds: [string, AnyModel][] = [
    ['u8', erase(models.u8)],
    ['i8', erase(models.i8)],
    ['u16', erase(models.u16)],
    ['i16', erase(models.i16)],
    ['u32', erase(models.u32)],
    ['i32', erase(models.i32)],
    ['f32', erase(models.f32)],
    ['bool', erase(boolModel)],
    ['varuint', erase(models.varuint)],
    ['fixed16(0.01)', erase(models.fixed16)],
    ['fixed32(0.001)', erase(models.fixed32)],
    ['vec2(i16)', erase(vec2Model(models.i16))],
    ['vec2(angle16)', erase(vec2Model(models.angle16))],
    ['vec3(fixed32(0.001))', erase(vec3Model(models.fixed32))],
    ['vec3(f32)', erase(vec3Model(models.f32))],
    ['quat', erase(quatModel)],
    ['angle16', erase(models.angle16)],
    ['str(24)', erase(strModel(24))],
    ['entity', erase(entityModel)],
    ['array(u16,8)', erase(arrayModel(models.u16, 8))],
    ['array(str(6),5)', erase(arrayModel(strModel(6), 5))],
    ['optional(i32)', erase(optionalModel(models.i32))],
    ['optional(vec3(fixed16(0.01)))', erase(optionalModel(vec3Model(models.fixed16)))],
    [
      'struct (flat)',
      erase(
        structModel({
          id: erase(entityModel),
          hp: erase(models.u8),
          alive: erase(boolModel),
          name: erase(strModel(12)),
        }),
      ),
    ],
    [
      'struct (nested struct / array / optional)',
      erase(
        structModel({
          pos: erase(vec3Model(models.fixed32)),
          rot: erase(quatModel),
          tags: erase(arrayModel(strModel(4), 3)),
          inner: erase(
            structModel({
              heading: erase(models.angle16),
              path: erase(arrayModel(vec2Model(models.i16), 4)),
              maybe: erase(optionalModel(erase(structModel({ n: erase(models.varuint) })))),
            }),
          ),
          slots: erase(
            arrayModel(
              optionalModel(erase(structModel({ e: erase(entityModel), f: erase(models.f32) }))),
              3,
            ),
          ),
          empty: erase(structModel({})),
        }),
      ),
    ],
    [
      'array(struct{v:vec2(f32),q:quat},6)',
      erase(arrayModel(structModel({ v: erase(vec2Model(models.f32)), q: erase(quatModel) }), 6)),
    ],
    ['optional(array(bool,7))', erase(optionalModel(arrayModel(boolModel, 7)))],
  ];

  for (const [name, model] of kinds) {
    it(name, () => checkRoundTrips(name, model));
  }
});

describe('byte layouts', () => {
  it('scalars, entity, vectors, str, array, struct and optional', () => {
    expect(hex(encode(f.u8, 200))).toBe('c8');
    expect(hex(encode(f.i8, -1))).toBe('ff');
    expect(hex(encode(f.u16, 513))).toBe('01 02');
    expect(hex(encode(f.i16, -32768))).toBe('00 80');
    expect(hex(encode(f.u32, 1))).toBe('01 00 00 00');
    expect(hex(encode(f.i32, -1))).toBe('ff ff ff ff');
    expect(hex(encode(f.f32, 0.5))).toBe('00 00 00 3f'); // 0x3F000000
    expect(hex(encode(f.bool, false))).toBe('00');
    expect(hex(encode(f.bool, true))).toBe('01');
    expect(hex(encode(f.varuint, 129))).toBe('81 01');
    expect(hex(encode(f.entity(), 0x00100001))).toBe('01 00 10 00');
    expect(hex(encode(f.vec2(f.u8), { x: 1, y: 2 }))).toBe('01 02');
    expect(hex(encode(f.vec3(f.i16), { x: -1, y: 0, z: 256 }))).toBe('ff ff 00 00 00 01');
    expect(hex(encode(f.str(8), 'ok'))).toBe('02 6f 6b');
    expect(hex(encode(f.array(f.u16, 4), [1, 0xffff]))).toBe('02 00 01 00 ff ff');
    expect(hex(encode(f.array(f.u8, 4), []))).toBe('00 00');
    // struct fields in declaration order, not alphabetical
    expect(hex(encode(f.struct({ z: f.u8, a: f.u16 }), { z: 1, a: 2 }))).toBe('01 02 00');
    expect(hex(encode(f.struct({}), {}))).toBe('');
    expect(hex(encode(f.optional(f.u16), undefined))).toBe('00');
    expect(hex(encode(f.optional(f.u16), 7))).toBe('01 07 00');
  });
});

describe('fixed16 / fixed32', () => {
  it('quantize with Math.round and clamp to the integer range', () => {
    const w = new ByteWriter();
    f.fixed16(0.01).encode(w, 1e9); // clamps to 32767 -> ff 7f
    f.fixed16(0.01).encode(w, -1e9); // clamps to -32768 -> 00 80
    f.fixed16(0.01).encode(w, Infinity); // ff 7f
    f.fixed16(0.5).encode(w, 0.25); // 0.5 rounds up to 1 -> 01 00
    f.fixed16(0.5).encode(w, -0.25); // -0.5 rounds to -0 -> 00 00
    f.fixed16(0.5).encode(w, -0.75); // -1.5 rounds to -1 -> ff ff
    f.fixed32(0.001).encode(w, 1e10); // 2147483647 -> ff ff ff 7f
    f.fixed32(0.001).encode(w, -Infinity); // -2147483648 -> 00 00 00 80
    f.fixed32(0.001).encode(w, 1.234); // 1234 = 0x4D2 -> d2 04 00 00
    expect(hex(w.view())).toBe(
      'ff 7f 00 80 ff 7f 01 00 00 00 ff ff ff ff ff 7f 00 00 00 80 d2 04 00 00',
    );
    const r = new ByteReader(w.view());
    expect(f.fixed16(0.01).decode(r)).toBe(32767 * 0.01);
    expect(f.fixed16(0.01).decode(r)).toBe(-32768 * 0.01);
  });

  it('reject NaN without writing', () => {
    const w = new ByteWriter();
    expect(encodeErr(() => f.fixed16(0.01).encode(w, NaN))).toBe('nan');
    expect(encodeErr(() => f.fixed32(0.001).encode(w, NaN))).toBe('nan');
    expect(encodeErr(() => f.vec3(f.fixed32(1)).encode(w, { x: 1, y: NaN, z: 0 }))).toBe('nan');
    expect(w.length).toBe(4); // x was written before y threw; encodeWith is what rolls back
  });
});

describe('decode errors', () => {
  it('str max is enforced on both sides and invalid UTF-8 is rejected', () => {
    const w = new ByteWriter();
    expect(encodeErr(() => f.str(4).encode(w, 'hello'))).toBe('length');
    expect(encodeErr(() => f.str(4).encode(w, 'h\u{E9}ll'))).toBe('length'); // 5 UTF-8 bytes
    expect(encodeErr(() => f.str(4).encode(w, 'hell'))).toBe('none');
    const five = fromHex('05 68 65 6c 6c 6f'); // 'hello'
    expect(decodeErr(() => f.str(4).decode(new ByteReader(five)))).toEqual({
      code: 'length',
      offset: 0,
    });
    expect(f.str(5).decode(new ByteReader(five))).toBe('hello');
    expect(decodeErr(() => f.str(8).decode(new ByteReader(fromHex('02 c3 28'))))).toEqual({
      code: 'utf8',
      offset: 0,
    });
    // overlong encoding of NUL
    expect(decodeErr(() => f.str(8).decode(new ByteReader(fromHex('02 c0 80'))))).toEqual({
      code: 'utf8',
      offset: 0,
    });
    expect(decodeErr(() => f.str(8).decode(new ByteReader(fromHex('03 61 62'))))).toEqual({
      code: 'eof',
      offset: 0,
    });
  });

  it('bool byte > 1 is rejected', () => {
    for (const b of ['02', 'ff']) {
      expect(decodeErr(() => f.bool.decode(new ByteReader(fromHex(`00 ${b}`), 1)))).toEqual({
        code: 'range',
        offset: 1,
      });
    }
    expect(decodeErr(() => f.bool.decodeInto(new ByteReader(fromHex('02')), false))).toEqual({
      code: 'range',
      offset: 0,
    });
  });

  it('optional flag > 1 is rejected', () => {
    const t = f.optional(f.u8);
    expect(decodeErr(() => t.decode(new ByteReader(fromHex('02 05'))))).toEqual({
      code: 'range',
      offset: 0,
    });
    expect(decodeErr(() => t.decodeInto(new ByteReader(fromHex('ff')), 1))).toEqual({
      code: 'range',
      offset: 0,
    });
    expect(decodeErr(() => t.decode(new ByteReader(fromHex('01'))))).toEqual({
      code: 'eof',
      offset: 1,
    });
  });

  it('array count > max is rejected on decode (and on encode)', () => {
    const t = f.array(f.u8, 2);
    expect(decodeErr(() => t.decode(new ByteReader(fromHex('03 00 01 02 03'))))).toEqual({
      code: 'count',
      offset: 0,
    });
    expect(decodeErr(() => t.decodeInto(new ByteReader(fromHex('ff ff')), []))).toEqual({
      code: 'count',
      offset: 0,
    });
    expect(t.decode(new ByteReader(fromHex('02 00 01 02')))).toEqual([1, 2]);
    expect(encodeErr(() => t.encode(new ByteWriter(), [1, 2, 3]))).toBe('count');
    expect(decodeErr(() => t.decode(new ByteReader(fromHex('02 00 01'))))).toEqual({
      code: 'eof',
      offset: 3,
    });
  });

  it('nested errors report the offset of the failing value', () => {
    const t = f.struct({ a: f.u16, b: f.array(f.struct({ ok: f.bool }), 4) });
    // a = 1, count = 2, ok = true, ok = 7 (bad) at offset 5
    expect(decodeErr(() => t.decode(new ByteReader(fromHex('01 00 02 00 01 07'))))).toEqual({
      code: 'range',
      offset: 5,
    });
  });
});

describe('create()', () => {
  it('returns the documented defaults', () => {
    for (const t of [f.u8, f.i8, f.u16, f.i16, f.u32, f.i32, f.f32, f.varuint]) {
      expect(t.create()).toBe(0);
    }
    expect(f.fixed16(0.01).create()).toBe(0);
    expect(f.fixed32(0.001).create()).toBe(0);
    expect(f.angle16().create()).toBe(0);
    expect(f.bool.create()).toBe(false);
    expect(f.str(3).create()).toBe('');
    expect(f.entity().create()).toBe(ENTITY_NONE);
    expect(ENTITY_NONE).toBe(0);
    expect(f.vec2(f.f32).create()).toEqual({ x: 0, y: 0 });
    expect(f.vec3(f.f32).create()).toEqual({ x: 0, y: 0, z: 0 });
    expect(f.quat().create()).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(f.array(f.u8, 3).create()).toEqual([]);
    expect(f.optional(f.vec2(f.u8)).create()).toBeUndefined();
    const s = f.struct({
      a: f.u8,
      b: f.optional(f.str(3)),
      c: f.struct({ v: f.vec3(f.i8), q: f.quat(), list: f.array(f.bool, 2) }),
    });
    const v = s.create();
    expect(v).toEqual({
      a: 0,
      b: undefined,
      c: { v: { x: 0, y: 0, z: 0 }, q: { x: 0, y: 0, z: 0, w: 1 }, list: [] },
    });
    expect('b' in v).toBe(true); // optional keys are present with value undefined
    const v2 = s.create();
    expect(v2.c).not.toBe(v.c);
    expect(v2.c.v).not.toBe(v.c.v);
    expect(v2.c.list).not.toBe(v.c.list);
  });
});

describe('copy()', () => {
  const S = f.struct({
    id: f.entity(),
    name: f.str(16),
    pos: f.vec3(f.f32),
    rot: f.quat(),
    path: f.array(f.vec2(f.i16), 4),
    extra: f.optional(f.struct({ hp: f.u8, at: f.vec2(f.f32) })),
  });
  type S = Infer<typeof S>;

  function sample(): S {
    return {
      id: 7,
      name: 'crate',
      pos: { x: 1, y: 2, z: 3 },
      rot: { x: 0, y: 1, z: 0, w: 0 },
      path: [
        { x: 1, y: 1 },
        { x: 2, y: 2 },
      ],
      extra: { hp: 9, at: { x: 5, y: 6 } },
    };
  }

  it('deep-copies into a fresh out: nothing is shared', () => {
    const src = sample();
    const out = S.copy(src, S.create());
    expect(out).toEqual(src);
    expect(out.pos).not.toBe(src.pos);
    expect(out.rot).not.toBe(src.rot);
    expect(out.path).not.toBe(src.path);
    expect(out.path[0]).not.toBe(src.path[0]);
    expect(out.extra).not.toBe(src.extra);
    expect(out.extra?.at).not.toBe(src.extra?.at);
    src.pos.x = 100;
    (src.path[1] as Vec2).y = 100;
    if (src.extra) src.extra.at.x = 100;
    expect(out.pos.x).toBe(1);
    expect(out.path[1]?.y).toBe(2);
    expect(out.extra?.at.x).toBe(5);
  });

  it('reuses nested objects already present in out', () => {
    const out = S.copy(sample(), S.create());
    const pos = out.pos;
    const path0 = out.path[0];
    const extra = out.extra;
    const next = sample();
    next.pos = { x: -1, y: -2, z: -3 };
    next.path = [{ x: 9, y: 9 }];
    const result = S.copy(next, out);
    expect(result).toBe(out);
    expect(out.pos).toBe(pos);
    expect(out.pos).toEqual({ x: -1, y: -2, z: -3 });
    expect(out.path).toHaveLength(1);
    expect(out.path[0]).toBe(path0);
    expect(out.extra).toBe(extra);
    next.extra = undefined;
    S.copy(next, out);
    expect(out.extra).toBeUndefined();
  });

  it('primitives and strings return the value', () => {
    expect(f.u8.copy(5, 0)).toBe(5);
    expect(f.str(4).copy('ab', '')).toBe('ab');
    expect(f.optional(f.u8).copy(undefined, 3)).toBeUndefined();
    expect(f.optional(f.u8).copy(4, undefined)).toBe(4);
  });
});

describe('constructor validation', () => {
  it('rejects bad scales, elements, maxima, names and nested optionals', () => {
    for (const scale of [0, -1, NaN, Infinity]) {
      expect(() => f.fixed16(scale)).toThrow(RangeError);
      expect(() => f.fixed32(scale)).toThrow(RangeError);
    }
    const notNumeric = [f.bool, f.str(3), f.entity(), f.quat()] as unknown as NumericFieldType[];
    for (const elem of notNumeric) {
      expect(() => f.vec2(elem)).toThrow(RangeError);
      expect(() => f.vec3(elem)).toThrow(RangeError);
    }
    for (const max of [0, 1.5, MAX_STR_BYTES + 1, NaN])
      expect(() => f.str(max)).toThrow(RangeError);
    expect(f.str(1).descriptor).toBe('str(1)');
    expect(f.str(MAX_STR_BYTES).descriptor).toBe(`str(${MAX_STR_BYTES})`);
    for (const max of [0, -1, 2.5, MAX_ARRAY_COUNT + 1]) {
      expect(() => f.array(f.u8, max)).toThrow(RangeError);
    }
    expect(f.array(f.u8, MAX_ARRAY_COUNT).descriptor).toBe(`array(u8,${MAX_ARRAY_COUNT})`);
    for (const name of ['1a', '_a', 'a-b', 'a b', '', 'x'.repeat(65), 'caf\u{E9}']) {
      expect(() => f.struct({ [name]: f.u8 })).toThrow(RangeError);
    }
    expect(() => f.struct({ ['x'.repeat(64)]: f.u8, A_1: f.u8 })).not.toThrow();
    expect(() => f.optional(f.optional(f.u8))).toThrow(RangeError);
    const notAType = { a: f.quat } as unknown as Record<string, FieldType<unknown>>;
    expect(() => f.struct(notAType)).toThrow(RangeError);
    expect(() => f.array(undefined as unknown as FieldType<number>, 3)).toThrow(RangeError);
  });
});

describe('lerp metadata', () => {
  it('is defined exactly for numeric kinds, vectors, quat and angle16', () => {
    const withLerp: FieldType<unknown>[] = [
      f.u8,
      f.i8,
      f.u16,
      f.i16,
      f.u32,
      f.i32,
      f.f32,
      f.varuint,
      f.fixed16(0.1),
      f.fixed32(0.1),
      f.vec2(f.f32),
      f.vec3(f.f32),
      f.quat(),
      f.angle16(),
    ];
    for (const t of withLerp) expect(typeof t.lerp).toBe('function');
    const withoutLerp: FieldType<unknown>[] = [
      f.bool,
      f.str(4),
      f.entity(),
      f.array(f.f32, 2),
      f.struct({ a: f.f32 }),
      f.optional(f.f32),
    ];
    for (const t of withoutLerp) expect(t.lerp).toBeUndefined();
  });

  it('interpolates numbers, vectors and quaternions', () => {
    expect(f.u8.lerp?.(10, 20, 0.25, 0)).toBe(12.5); // integers are not re-rounded
    expect(f.fixed32(0.001).lerp?.(-1, 1, 0.5, 0)).toBe(0);
    const out = { x: 9, y: 9, z: 9 };
    const r = f.vec3(f.f32).lerp?.({ x: 0, y: 2, z: -4 }, { x: 10, y: 4, z: 4 }, 0.5, out);
    expect(r).toBe(out);
    expect(out).toEqual({ x: 5, y: 3, z: 0 });
    const a = q.identity();
    const b = q.fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2);
    const negB = { x: -b.x, y: -b.y, z: -b.z, w: -b.w };
    const mid = f.quat().lerp?.(a, negB, 0.5, q.create()) as Quat;
    expect(q.equals(mid, q.fromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 4), 1e-12)).toBe(true);
    expect(mid.w).toBeGreaterThan(0); // shortest path from a
  });
});

describe('flags and types', () => {
  it('numeric and allocates', () => {
    for (const t of [f.u8, f.i8, f.u16, f.i16, f.u32, f.i32, f.f32, f.varuint, f.angle16()]) {
      expect(t.numeric).toBe(true);
      expect(t.allocates).toBe(false);
    }
    expect(f.fixed16(1).numeric).toBe(true);
    expect(f.fixed32(1).numeric).toBe(true);
    for (const t of [f.bool, f.entity(), f.vec2(f.u8), f.vec3(f.u8), f.quat()]) {
      expect(t.numeric).toBe(false);
      expect(t.allocates).toBe(false);
    }
    expect(f.str(3).allocates).toBe(true);
    expect(f.array(f.u8, 3).allocates).toBe(true);
    expect(f.optional(f.u8).allocates).toBe(false);
    expect(f.optional(f.vec2(f.u8)).allocates).toBe(true);
    expect(f.struct({ a: f.u8, b: f.vec3(f.f32), c: f.quat() }).allocates).toBe(false);
    expect(f.struct({ a: f.u8, s: f.str(2) }).allocates).toBe(true);
    expect(f.struct({}).allocates).toBe(false);
  });

  it('kinds', () => {
    expect(f.u8.kind).toBe('u8');
    expect(f.fixed16(2).kind).toBe('fixed16');
    expect(f.struct({}).kind).toBe('struct');
    expect(f.optional(f.bool).kind).toBe('optional');
    expect(Object.isFrozen(f)).toBe(true);
    expect(Object.isFrozen(f.u8)).toBe(true);
  });

  it('Infer maps the DSL to TypeScript types', () => {
    const S = f.struct({
      a: f.u8,
      b: f.optional(f.str(4)),
      c: f.array(f.vec2(f.f32), 3),
      d: f.struct({ e: f.bool, g: f.entity() }),
      r: f.quat(),
    });
    const value: Infer<typeof S> = {
      a: 1,
      b: undefined,
      c: [{ x: 1, y: 2 }],
      d: { e: true, g: 5 },
      r: { x: 0, y: 0, z: 0, w: 1 },
    };
    // @ts-expect-error: optional fields keep their key (value may be undefined)
    const _missingKey: Infer<typeof S> = { a: 1, c: [], d: { e: true, g: 0 }, r: value.r };
    // @ts-expect-error: bool is not a number
    const _wrongType: Infer<typeof S> = { ...value, d: { e: 1, g: 0 } };
    const fromMap: Infer<{ n: NumericFieldType; s: FieldType<string> }> = { n: 1, s: 'x' };
    expect(S.decode(new ByteReader(encode(S, value)))).toEqual(value);
    expect(fromMap.s).toBe('x');
  });
});

it('schema f32 rejects nonfinite values and finite wire overflow while low-level bytes remain IEEE', () => {
  for (const value of [NaN, Infinity, -Infinity, 1e300])
    expect(() => f.f32.encode(new ByteWriter(), value)).toThrow(EncodeError);
  for (const value of [NaN, Infinity, -Infinity]) {
    const bytes = new ByteWriter();
    bytes.f32(value);
    expect(() => f.f32.decode(new ByteReader(bytes.view()))).toThrow(DecodeError);
  }
});
