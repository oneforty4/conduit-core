import { fnv1a32 as mathFnv1a32 } from '@conduit/math';
import { describe, expect, it } from 'vitest';
import {
  defineSchema,
  descriptorOf,
  f,
  FNV_OFFSET,
  FNV_PRIME,
  fnv1a32,
  NAME_PATTERN,
  type FieldMap,
  type FieldType,
} from '../src/index.ts';

// ---------------------------------------------------------------------------------------------
// A recursive-descent checker for the descriptor grammar in docs/protocol.md 6.

const SIMPLE = [
  'varuint',
  'angle16',
  'entity',
  'bool',
  'quat',
  'u16',
  'i16',
  'u32',
  'i32',
  'f32',
  'u8',
  'i8',
];

function fail(s: string, i: number, what: string): never {
  throw new Error(`descriptor ${JSON.stringify(s)}: expected ${what} at ${i}`);
}

function expectChar(s: string, i: number, c: string): number {
  if (s[i] !== c) fail(s, i, `'${c}'`);
  return i + 1;
}

function parseInt10(s: string, i: number): number {
  const m = /0|[1-9][0-9]*/y;
  m.lastIndex = i;
  const hit = m.exec(s);
  if (!hit) fail(s, i, 'int');
  return i + hit[0].length;
}

function parseNum(s: string, i: number): number {
  const m = /[0-9][0-9.e+-]*/y;
  m.lastIndex = i;
  const hit = m.exec(s);
  if (!hit) fail(s, i, 'num');
  const n = Number(hit[0]);
  if (!(Number.isFinite(n) && n > 0) || String(n) !== hit[0]) fail(s, i, 'canonical num');
  return i + hit[0].length;
}

function parseType(s: string, i: number): number {
  for (const k of SIMPLE) {
    const end = i + k.length;
    if (s.startsWith(k, i) && (end === s.length || ',)}'.includes(s[end] as string))) return end;
  }
  for (const k of ['fixed16(', 'fixed32(']) {
    if (s.startsWith(k, i)) return expectChar(s, parseNum(s, i + k.length), ')');
  }
  for (const k of ['vec2(', 'vec3(', 'optional(']) {
    if (s.startsWith(k, i)) return expectChar(s, parseType(s, i + k.length), ')');
  }
  if (s.startsWith('str(', i)) return expectChar(s, parseInt10(s, i + 4), ')');
  if (s.startsWith('array(', i)) {
    const j = expectChar(s, parseType(s, i + 6), ',');
    return expectChar(s, parseInt10(s, j), ')');
  }
  if (s.startsWith('struct{', i)) {
    let j = i + 7;
    if (s[j] === '}') return j + 1;
    for (;;) {
      const name = /[A-Za-z][A-Za-z0-9_]{0,63}/y;
      name.lastIndex = j;
      const hit = name.exec(s);
      if (!hit) fail(s, j, 'field name');
      j = parseType(s, expectChar(s, j + hit[0].length, ':'));
      if (s[j] === ',') {
        j++;
        continue;
      }
      return expectChar(s, j, '}');
    }
  }
  return fail(s, i, 'type');
}

function matchesGrammar(descriptor: string): boolean {
  return parseType(descriptor, 0) === descriptor.length && /^[\x21-\x7e]*$/.test(descriptor);
}

// ---------------------------------------------------------------------------------------------

describe('fnv1a32', () => {
  it('is the @conduit/math implementation', () => {
    expect(fnv1a32).toBe(mathFnv1a32);
    expect(FNV_OFFSET).toBe(0x811c9dc5);
    expect(FNV_PRIME).toBe(0x01000193);
  });

  it('matches the test vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
  });

  it('matches the per-byte loop of docs/protocol.md 6', () => {
    const text = 'struct{pos:vec3(fixed32(0.001)),rot:quat,vel:vec3(fixed16(0.01))}';
    let h = FNV_OFFSET;
    for (const b of new TextEncoder().encode(text)) {
      h = h ^ b;
      h = Math.imul(h, FNV_PRIME) >>> 0;
    }
    expect(fnv1a32(text)).toBe(h >>> 0);
  });
});

describe('descriptors', () => {
  it('render each kind exactly', () => {
    const cases: [FieldType<unknown>, string][] = [
      [f.u8, 'u8'],
      [f.i8, 'i8'],
      [f.u16, 'u16'],
      [f.i16, 'i16'],
      [f.u32, 'u32'],
      [f.i32, 'i32'],
      [f.f32, 'f32'],
      [f.bool, 'bool'],
      [f.varuint, 'varuint'],
      [f.fixed16(0.01), 'fixed16(0.01)'],
      [f.fixed32(0.001), 'fixed32(0.001)'],
      [f.vec2(f.i16), 'vec2(i16)'],
      [f.vec3(f.fixed32(0.001)), 'vec3(fixed32(0.001))'],
      [f.quat(), 'quat'],
      [f.angle16(), 'angle16'],
      [f.str(64), 'str(64)'],
      [f.entity(), 'entity'],
      [f.array(f.u8, 10), 'array(u8,10)'],
      [f.array(f.array(f.str(1), 2), 3), 'array(array(str(1),2),3)'],
      [f.struct({}), 'struct{}'],
      [f.struct({ a: f.u8, b: f.optional(f.str(8)) }), 'struct{a:u8,b:optional(str(8))}'],
      [f.optional(f.vec2(f.f32)), 'optional(vec2(f32))'],
      [
        f.struct({ inner: f.struct({ x: f.angle16(), list: f.array(f.entity(), 255) }) }),
        'struct{inner:struct{x:angle16,list:array(entity,255)}}',
      ],
    ];
    for (const [type, text] of cases) {
      expect(type.descriptor).toBe(text);
      expect(descriptorOf(type)).toBe(text);
      expect(matchesGrammar(type.descriptor)).toBe(true);
    }
  });

  it('render scales with Number.prototype.toString', () => {
    expect(f.fixed32(0.001).descriptor).toBe('fixed32(0.001)');
    expect(f.fixed16(1).descriptor).toBe('fixed16(1)');
    expect(f.fixed16(1e-7).descriptor).toBe('fixed16(1e-7)');
    expect(f.fixed32(0.5).descriptor).toBe('fixed32(0.5)');
    expect(f.fixed32(100).descriptor).toBe('fixed32(100)');
    expect(f.fixed32(1.5e21).descriptor).toBe('fixed32(1.5e+21)');
    for (const t of [f.fixed16(1e-7), f.fixed32(1.5e21), f.fixed32(0.1 + 0.2)]) {
      expect(matchesGrammar(t.descriptor)).toBe(true);
    }
  });

  it('render the Transform example from the spec', () => {
    const transform = defineSchema({
      pos: f.vec3(f.fixed32(0.001)),
      rot: f.quat(),
      vel: f.vec3(f.fixed16(0.01)),
    });
    expect(transform.descriptor).toBe(
      'struct{pos:vec3(fixed32(0.001)),rot:quat,vel:vec3(fixed16(0.01))}',
    );
    expect(descriptorOf(transform)).toBe(transform.descriptor);
    expect(transform.hash).toBe(fnv1a32(transform.descriptor));
  });

  it('the checker rejects text outside the grammar', () => {
    for (const bad of [
      'u9',
      'struct{a:u8,}',
      'fixed16(.5)',
      'fixed16(0.50)',
      'str(08)',
      'array(u8)',
      'vec2(u8',
      'struct{1a:u8}',
      'u8 ',
    ]) {
      expect(() => matchesGrammar(bad) || fail(bad, 0, 'end')).toThrow();
    }
    expect(NAME_PATTERN.test('a'.repeat(64))).toBe(true);
  });
});

describe('schema hash', () => {
  const base: FieldMap = { a: f.u8, b: f.fixed16(0.01), c: f.str(8), d: f.array(f.u16, 4) };

  it('changes when any field, name, scale, max or the order changes', () => {
    const variants: FieldMap[] = [
      { aa: f.u8, b: f.fixed16(0.01), c: f.str(8), d: f.array(f.u16, 4) }, // name
      { a: f.i8, b: f.fixed16(0.01), c: f.str(8), d: f.array(f.u16, 4) }, // type
      { a: f.u8, b: f.fixed16(0.02), c: f.str(8), d: f.array(f.u16, 4) }, // scale
      { a: f.u8, b: f.fixed32(0.01), c: f.str(8), d: f.array(f.u16, 4) }, // width
      { a: f.u8, b: f.fixed16(0.01), c: f.str(9), d: f.array(f.u16, 4) }, // str max
      { a: f.u8, b: f.fixed16(0.01), c: f.str(8), d: f.array(f.u16, 5) }, // array max
      { a: f.u8, b: f.fixed16(0.01), c: f.str(8), d: f.array(f.u32, 4) }, // array element
      { b: f.fixed16(0.01), a: f.u8, c: f.str(8), d: f.array(f.u16, 4) }, // order
      { a: f.u8, b: f.fixed16(0.01), c: f.str(8) }, // removed field
      { a: f.u8, b: f.fixed16(0.01), c: f.str(8), d: f.array(f.u16, 4), e: f.bool }, // added field
      { a: f.optional(f.u8), b: f.fixed16(0.01), c: f.str(8), d: f.array(f.u16, 4) }, // optional
    ];
    const hashes = new Set<number>([defineSchema(base).hash]);
    for (const v of variants) {
      const s = defineSchema(v);
      expect(matchesGrammar(s.descriptor)).toBe(true);
      expect(s.hash).not.toBe(defineSchema(base).hash);
      hashes.add(s.hash);
    }
    expect(hashes.size).toBe(variants.length + 1);
  });

  it('is stable for identical definitions built separately', () => {
    const again: FieldMap = { a: f.u8, b: f.fixed16(0.01), c: f.str(8), d: f.array(f.u16, 4) };
    expect(defineSchema(again).hash).toBe(defineSchema(base).hash);
    expect(defineSchema(again).descriptor).toBe(
      'struct{a:u8,b:fixed16(0.01),c:str(8),d:array(u16,4)}',
    );
  });
});
