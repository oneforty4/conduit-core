import { fnv1a32, q, Rng, type Vec2 } from '@conduit/math';
import { describe, expect, it } from 'vitest';
import {
  ByteReader,
  ByteWriter,
  DecodeError,
  decodeFields,
  decodeInto,
  decodeWith,
  defineSchema,
  EncodeError,
  encodeFields,
  encodeWith,
  f,
  fieldMaskBytes,
} from '../src/index.ts';

const transformLike = {
  pos: f.vec3(f.fixed32(0.001)),
  rot: f.quat(),
  vel: f.vec3(f.fixed16(0.01)),
  hp: f.u8,
  alive: f.bool,
  target: f.entity(),
  heading: f.angle16(),
  speed: f.f32,
  flags: f.u16,
};

describe('defineSchema', () => {
  it('exposes fields, names in declaration order, type, descriptor, hash and allocates', () => {
    const fields = { b: f.u8, a: f.str(4) };
    const s = defineSchema(fields);
    expect(s.fieldNames).toEqual(['b', 'a']);
    expect(s.fields).toEqual(fields);
    expect(s.fields.b).toBe(f.u8);
    expect(s.type.kind).toBe('struct');
    expect(s.descriptor).toBe('struct{b:u8,a:str(4)}');
    expect(s.descriptor).toBe(s.type.descriptor);
    expect(s.hash).toBe(fnv1a32(s.descriptor));
    expect(s.allocates).toBe(true);
    expect(s.create()).toEqual({ b: 0, a: '' });
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.fields)).toBe(true);
  });

  it('accepts an empty field map', () => {
    const s = defineSchema({});
    expect(s.descriptor).toBe('struct{}');
    expect(s.fieldNames).toEqual([]);
    expect(s.allocates).toBe(false);
    const w = new ByteWriter();
    encodeWith(w, s, {});
    expect(w.length).toBe(0);
    expect(decodeWith(new ByteReader(w.view()), s)).toEqual({});
  });

  it('rejects invalid field names', () => {
    expect(() => defineSchema({ 'not-a-name': f.u8 })).toThrow(RangeError);
  });
});

describe('decodeInto', () => {
  it('performs zero allocations for a non-allocating schema', () => {
    const S = defineSchema(transformLike);
    expect(S.allocates).toBe(false);

    const rng = new Rng(1);
    const w = new ByteWriter();
    const frames: Uint8Array[] = [];
    for (let i = 0; i < 1000; i++) {
      w.reset();
      encodeWith(w, S, {
        pos: { x: rng.float() * 100, y: rng.float() * 100, z: rng.float() * 100 },
        rot: q.fromEuler(rng.float() * 6, rng.float() * 6, rng.float() * 6),
        vel: { x: rng.float(), y: -rng.float(), z: 0 },
        hp: rng.int(0, 255),
        alive: rng.chance(0.5),
        target: rng.next(),
        heading: rng.float() * 6,
        speed: rng.float(),
        flags: rng.int(0, 65535),
      });
      frames.push(w.finish());
    }

    // Counting proxy over the object create() returned: any write that stores an object other than
    // the one already held, or adds a key, is an allocation escaping decodeInto.
    const inner = S.create();
    const refs = { pos: inner.pos, rot: inner.rot, vel: inner.vel };
    let objectWrites = 0;
    let newKeys = 0;
    const target = new Proxy(inner, {
      set(obj, key, value: unknown, receiver) {
        if (!Reflect.has(obj, key)) newKeys++;
        if (typeof value === 'object' && value !== null && value !== Reflect.get(obj, key)) {
          objectWrites++;
        }
        return Reflect.set(obj, key, value, receiver);
      },
      defineProperty(obj, key, desc) {
        if (!Reflect.has(obj, key)) newKeys++;
        return Reflect.defineProperty(obj, key, desc);
      },
    });

    for (const bytes of frames) {
      const r = new ByteReader(bytes);
      decodeInto(r, S, target);
      expect(r.remaining()).toBe(0);
      expect(target).toEqual(decodeWith(new ByteReader(bytes), S));
    }
    expect(objectWrites).toBe(0);
    expect(newKeys).toBe(0);
    expect(inner.pos).toBe(refs.pos);
    expect(inner.rot).toBe(refs.rot);
    expect(inner.vel).toBe(refs.vel);
  });

  it('reuses nested objects and array elements', () => {
    const S = defineSchema({
      path: f.array(f.vec2(f.i16), 8),
      inner: f.struct({ at: f.vec3(f.i8), label: f.str(8) }),
      spin: f.quat(),
    });
    type V = ReturnType<typeof S.create>;
    const encoded = (v: V): Uint8Array => {
      const w = new ByteWriter();
      encodeWith(w, S, v);
      return w.finish();
    };
    const target = S.create();
    decodeInto(
      new ByteReader(
        encoded({
          path: [
            { x: 1, y: 1 },
            { x: 2, y: 2 },
            { x: 3, y: 3 },
          ],
          inner: { at: { x: 1, y: 2, z: 3 }, label: 'a' },
          spin: q.identity(),
        }),
      ),
      S,
      target,
    );
    const path = target.path;
    const p0 = target.path[0] as Vec2;
    const p1 = target.path[1] as Vec2;
    const inner = target.inner;
    const at = target.inner.at;
    const spin = target.spin;

    // shrink to 2 elements: same array, same element objects
    decodeInto(
      new ByteReader(
        encoded({
          path: [
            { x: 7, y: 7 },
            { x: 8, y: 8 },
          ],
          inner: { at: { x: -1, y: -2, z: -3 }, label: 'b' },
          spin: q.fromAxisAngle({ x: 0, y: 0, z: 1 }, 1),
        }),
      ),
      S,
      target,
    );
    expect(target.path).toBe(path);
    expect(target.path).toEqual([
      { x: 7, y: 7 },
      { x: 8, y: 8 },
    ]);
    expect(target.path[0]).toBe(p0);
    expect(target.path[1]).toBe(p1);
    expect(target.inner).toBe(inner);
    expect(target.inner.at).toBe(at);
    expect(target.inner).toEqual({ at: { x: -1, y: -2, z: -3 }, label: 'b' });
    expect(target.spin).toBe(spin);
    expect(q.equals(target.spin, q.fromAxisAngle({ x: 0, y: 0, z: 1 }, 1), 1e-5)).toBe(true);

    // grow to 4: the first two are reused, the rest are new
    decodeInto(
      new ByteReader(
        encoded({
          path: [
            { x: 1, y: 0 },
            { x: 2, y: 0 },
            { x: 3, y: 0 },
            { x: 4, y: 0 },
          ],
          inner: { at: { x: 0, y: 0, z: 0 }, label: '' },
          spin: q.identity(),
        }),
      ),
      S,
      target,
    );
    expect(target.path).toBe(path);
    expect(target.path).toHaveLength(4);
    expect(target.path[0]).toBe(p0);
    expect(target.path[1]).toBe(p1);
    expect(target.path[3]).toEqual({ x: 4, y: 0 });
  });

  it('fills in missing sub-objects on a partial target', () => {
    const S = defineSchema({ a: f.vec2(f.u8), b: f.struct({ c: f.quat() }) });
    const w = new ByteWriter();
    encodeWith(w, S, { a: { x: 1, y: 2 }, b: { c: q.identity() } });
    const partial = {} as ReturnType<typeof S.create>;
    decodeInto(new ByteReader(w.view()), S, partial);
    expect(partial).toEqual({ a: { x: 1, y: 2 }, b: { c: { x: 0, y: 0, z: 0, w: 1 } } });
  });

  it('handles optional absent -> present -> present -> absent transitions', () => {
    const S = defineSchema({ o: f.optional(f.vec3(f.f32)), n: f.optional(f.u8) });
    const enc = (v: ReturnType<typeof S.create>): Uint8Array => {
      const w = new ByteWriter();
      encodeWith(w, S, v);
      return w.finish();
    };
    const target = S.create();
    expect(target).toEqual({ o: undefined, n: undefined });

    decodeInto(new ByteReader(enc({ o: { x: 1, y: 2, z: 3 }, n: 4 })), S, target);
    expect(target).toEqual({ o: { x: 1, y: 2, z: 3 }, n: 4 });
    const present = target.o;

    decodeInto(new ByteReader(enc({ o: { x: 4, y: 5, z: 6 }, n: undefined })), S, target);
    expect(target.o).toBe(present); // reused while present
    expect(target).toEqual({ o: { x: 4, y: 5, z: 6 }, n: undefined });

    decodeInto(new ByteReader(enc({ o: undefined, n: 9 })), S, target);
    expect(target.o).toBeUndefined();
    expect('o' in target).toBe(true);
    expect(target.n).toBe(9);

    decodeInto(new ByteReader(enc({ o: { x: 7, y: 8, z: 9 }, n: 9 })), S, target);
    expect(target.o).toEqual({ x: 7, y: 8, z: 9 });
    expect(target.o).not.toBe(present); // re-allocated after being absent
  });
});

describe('encodeWith / decodeWith', () => {
  it('truncates the writer back when encoding throws', () => {
    const S = defineSchema({ a: f.u32, b: f.str(4), c: f.u8 });
    const w = new ByteWriter();
    w.u16(0xbeef);
    let caught: unknown;
    try {
      encodeWith(w, S, { a: 1, b: 'ok', c: 300 }); // c out of range after 7 bytes were written
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EncodeError);
    expect((caught as EncodeError).code).toBe('range');
    expect(w.length).toBe(2);
    expect(Array.from(w.view())).toEqual([0xef, 0xbe]);

    // a non-EncodeError thrown mid-value is rolled back too
    const N = defineSchema({ a: f.u8, v: f.vec2(f.u8) });
    expect(() => encodeWith(w, N, { a: 1, v: undefined as unknown as Vec2 })).toThrow(TypeError);
    expect(w.length).toBe(2);

    // schema.encode behaves the same
    expect(() => S.encode(w, { a: 1, b: 'too long', c: 0 })).toThrow(EncodeError);
    expect(w.length).toBe(2);

    encodeWith(w, S, { a: 1, b: 'ok', c: 3 });
    expect(w.length).toBe(2 + 4 + 3 + 1);
  });

  it('decodeWith allocates a fresh value each call', () => {
    const S = defineSchema({ v: f.vec2(f.u8) });
    const w = new ByteWriter();
    encodeWith(w, S, { v: { x: 1, y: 2 } });
    const a = decodeWith(new ByteReader(w.view()), S);
    const b = decodeWith(new ByteReader(w.view()), S);
    expect(a).toEqual({ v: { x: 1, y: 2 } });
    expect(a).not.toBe(b);
    expect(a.v).not.toBe(b.v);
    expect(S.decode(new ByteReader(w.view()))).toEqual(a);
  });

  it('copy deep-copies through the schema', () => {
    const S = defineSchema({ list: f.array(f.vec2(f.u8), 3) });
    const src = { list: [{ x: 1, y: 2 }] };
    const out = S.copy(src, S.create());
    expect(out).toEqual(src);
    expect(out.list[0]).not.toBe(src.list[0]);
  });
});

describe('field subsets (docs/protocol.md 5.2)', () => {
  const Mixed = defineSchema({
    a: f.u8,
    b: f.str(4),
    c: f.vec2(f.i16),
    d: f.optional(f.u16),
    e: f.bool,
  });
  const u8s = (n: number) =>
    defineSchema(Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, f.u8])));

  it('fieldMaskBytes is 1 up to 8 fields, 2 up to 16 and 0 beyond', () => {
    expect([0, 1, 8, 9, 16, 17].map((n) => fieldMaskBytes(u8s(n)))).toEqual([1, 1, 1, 2, 2, 0]);
  });

  it('encodeFields and decodeFields select exactly the masked fields, for every mask', () => {
    const value = { a: 200, b: 'hey', c: { x: -3, y: 4 }, d: undefined, e: true };
    const byName = value as Record<string, unknown>;
    for (let mask = 0; mask < 1 << Mixed.fieldNames.length; mask++) {
      const expected = new ByteWriter();
      const picked: Record<string, unknown> = {};
      Mixed.fieldNames.forEach((name, i) => {
        if ((mask & (1 << i)) === 0) return;
        Mixed.fields[name]!.encode(expected, byName[name]);
        picked[name] = byName[name];
      });
      const w = new ByteWriter();
      encodeFields(w, Mixed, value, mask);
      expect(Array.from(w.view())).toEqual(Array.from(expected.view()));

      const r = new ByteReader(w.view());
      const decoded = decodeFields(r, Mixed, mask);
      expect(r.remaining()).toBe(0);
      expect(Object.keys(decoded)).toEqual(Object.keys(picked)); // declaration order, nothing else
      expect(decoded).toStrictEqual(picked);
    }
    const all = new ByteWriter();
    encodeFields(all, Mixed, value, 0b11111);
    const whole = new ByteWriter();
    encodeWith(whole, Mixed, value);
    expect(Array.from(all.view())).toEqual(Array.from(whole.view()));
  });

  it('rejects masks the schema cannot have', () => {
    const w = new ByteWriter();
    w.u8(1);
    for (const bad of [0b100000, -1, 1.5, Number.NaN]) {
      let caught: unknown;
      try {
        encodeFields(w, Mixed, {}, bad);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(EncodeError);
      expect((caught as EncodeError).code).toBe('range');
      expect(() => decodeFields(new ByteReader(new Uint8Array(16)), Mixed, bad)).toThrow(
        RangeError,
      );
    }
    expect(() => encodeFields(w, u8s(17), {}, 0)).toThrow(EncodeError);
    expect(() => decodeFields(new ByteReader(new Uint8Array(0)), u8s(17), 0)).toThrow(RangeError);
    expect(() => encodeFields(w, u8s(16), {}, 0)).not.toThrow(); // 16 fields are addressable
    expect(w.length).toBe(1);
  });

  it('encodeFields truncates the writer back when a field throws; decode errors are the fields', () => {
    const w = new ByteWriter();
    w.u16(0xbeef);
    expect(() => encodeFields(w, Mixed, { a: 1, b: 'too long' }, 0b011)).toThrow(EncodeError);
    expect(w.length).toBe(2);
    expect(() => encodeFields(w, Mixed, { a: 1 }, 0b101)).toThrow(TypeError); // c missing
    expect(w.length).toBe(2);

    let caught: unknown;
    try {
      decodeFields(new ByteReader(new Uint8Array([7])), Mixed, 0b011); // a, then b runs out
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DecodeError);
    expect(caught).toMatchObject({ code: 'eof', offset: 1 });
  });
});
