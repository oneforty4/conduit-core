import { describe, expect, it } from 'vitest';
import {
  ByteReader,
  ByteWriter,
  DecodeError,
  EncodeError,
  MAX_WRITER_BYTES,
  type DecodeErrorCode,
  type EncodeErrorCode,
} from '../src/index.ts';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

function fromHex(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function encodeErrorCode(fn: () => unknown): EncodeErrorCode | 'none' {
  try {
    fn();
  } catch (err) {
    if (err instanceof EncodeError) return err.code;
    throw err;
  }
  return 'none';
}

function decodeError(fn: () => unknown): { code: DecodeErrorCode; offset: number } | 'none' {
  try {
    fn();
  } catch (err) {
    if (err instanceof DecodeError) return { code: err.code, offset: err.offset };
    throw err;
  }
  return 'none';
}

type IntMethod = 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32';

const INT_CASES: { m: IntMethod; bytes: number; ok: number[]; bad: number[] }[] = [
  { m: 'u8', bytes: 1, ok: [0, 1, 127, 128, 255], bad: [-1, 256, 1.5, NaN, Infinity] },
  { m: 'i8', bytes: 1, ok: [-128, -1, 0, 127], bad: [-129, 128, 0.5, NaN] },
  { m: 'u16', bytes: 2, ok: [0, 255, 256, 65535], bad: [-1, 65536, 2.5, NaN] },
  { m: 'i16', bytes: 2, ok: [-32768, -1, 0, 32767], bad: [-32769, 32768, -0.5, NaN] },
  {
    m: 'u32',
    bytes: 4,
    ok: [0, 1, 0x7fffffff, 0x80000000, 4294967295],
    bad: [-1, 4294967296, 1e-9, NaN, -Infinity],
  },
  {
    m: 'i32',
    bytes: 4,
    ok: [-2147483648, -1, 0, 2147483647],
    bad: [-2147483649, 2147483648, 3.25, NaN],
  },
];

describe('ByteWriter / ByteReader integers', () => {
  for (const { m, bytes, ok, bad } of INT_CASES) {
    it(`${m} round-trips at its boundaries and rejects out-of-range values`, () => {
      const w = new ByteWriter();
      for (const v of ok) w[m](v);
      expect(w.length).toBe(ok.length * bytes);
      const r = new ByteReader(w.view());
      for (const v of ok) expect(r[m]()).toBe(v === 0 ? 0 : v);
      expect(r.remaining()).toBe(0);
      for (const v of bad) {
        const before = w.length;
        expect(encodeErrorCode(() => w[m](v))).toBe('range');
        expect(w.length).toBe(before);
      }
    });
  }

  it('writes little-endian', () => {
    const w = new ByteWriter();
    w.u16(0x1234); // 34 12
    w.i16(-2); // 0xFFFE -> fe ff
    w.u32(0x12345678); // 78 56 34 12
    w.i32(-2); // 0xFFFFFFFE -> fe ff ff ff
    w.i8(-128); // 80
    w.u8(0xab); // ab
    expect(hex(w.view())).toBe('34 12 fe ff 78 56 34 12 fe ff ff ff 80 ab');
  });
});

describe('f32', () => {
  it('writes IEEE-754 binary32 little-endian', () => {
    const w = new ByteWriter();
    w.f32(1); // 0x3F800000
    w.f32(-2.5); // sign 1, exponent 128, mantissa .01 -> 0xC0200000
    w.f32(0); // 00000000
    expect(hex(w.view())).toBe('00 00 80 3f 00 00 20 c0 00 00 00 00');
  });

  it('accepts any number, including NaN and infinities', () => {
    const values = [
      0,
      -0,
      1.5,
      -1.5,
      0.1,
      3.4028234663852886e38,
      1e-45,
      1e39,
      NaN,
      Infinity,
      -Infinity,
    ];
    const w = new ByteWriter();
    for (const v of values) w.f32(v);
    const r = new ByteReader(w.view());
    for (const v of values) expect(Object.is(r.f32(), Math.fround(v))).toBe(true);
  });
});

describe('varuint', () => {
  // Unsigned LEB128: low 7 bits first, bit 7 set while more bytes follow.
  const cases: [number, string][] = [
    [0, '00'],
    [1, '01'],
    [127, '7f'],
    [128, '80 01'], // 128 = 0b1_0000000
    [300, 'ac 02'], // 300 = 0b10_0101100 -> 0x2c|0x80, 0x02
    [16383, 'ff 7f'],
    [16384, '80 80 01'],
    [2097151, 'ff ff 7f'], // 2^21 - 1
    [2097152, '80 80 80 01'], // 2^21
    [268435455, 'ff ff ff 7f'], // 2^28 - 1
    [268435456, '80 80 80 80 01'], // 2^28
    [4294967295, 'ff ff ff ff 0f'], // 2^32 - 1: 5th byte carries bits 28..31
  ];

  it('encodes to the exact LEB128 bytes and decodes back', () => {
    for (const [v, bytes] of cases) {
      const w = new ByteWriter(1);
      w.varuint(v);
      expect(hex(w.view())).toBe(bytes);
      const r = new ByteReader(fromHex(bytes));
      expect(r.varuint()).toBe(v);
      expect(r.remaining()).toBe(0);
    }
  });

  it('rejects values outside 0..2^32-1 on encode', () => {
    const w = new ByteWriter();
    for (const v of [-1, 4294967296, 1.5, NaN, Infinity]) {
      expect(encodeErrorCode(() => w.varuint(v))).toBe('range');
    }
    expect(w.length).toBe(0);
  });

  it('rejects 6-byte and over-range input with the offset of the varuint', () => {
    const prefix = '00 00 00'; // the varuint starts at offset 3
    for (const body of [
      'ff ff ff ff 10',
      'ff ff ff ff 1f',
      'ff ff ff ff 8f 01',
      'ff ff ff ff ff ff',
    ]) {
      const r = new ByteReader(fromHex(`${prefix} ${body}`));
      r.skip(3);
      expect(decodeError(() => r.varuint())).toEqual({ code: 'varuint', offset: 3 });
      expect(r.offset).toBe(3);
    }
  });

  it('accepts non-minimal encodings within 5 bytes', () => {
    expect(new ByteReader(fromHex('80 00')).varuint()).toBe(0);
    expect(new ByteReader(fromHex('ff 80 80 80 00')).varuint()).toBe(127);
  });

  it('throws eof for a truncated varuint', () => {
    expect(decodeError(() => new ByteReader(fromHex('80')).varuint())).toEqual({
      code: 'eof',
      offset: 0,
    });
    expect(decodeError(() => new ByteReader(fromHex('ff ff ff ff')).varuint())).toEqual({
      code: 'eof',
      offset: 0,
    });
  });
});

describe('bytes and utf8', () => {
  it('bytes copies raw without a length prefix; reader.bytes is a view', () => {
    const w = new ByteWriter();
    const src = Uint8Array.of(1, 2, 3);
    w.bytes(src);
    src[0] = 9;
    expect(hex(w.view())).toBe('01 02 03');
    const buf = w.finish();
    const r = new ByteReader(buf);
    const view = r.bytes(2);
    expect(hex(view)).toBe('01 02');
    buf[0] = 7;
    expect(view[0]).toBe(7); // no copy
    expect(r.offset).toBe(2);
    expect(hex(r.bytes(0))).toBe('');
  });

  it('utf8 writes a varuint byte length then UTF-8', () => {
    const w = new ByteWriter();
    w.utf8('', 10); // 00
    w.utf8('hi', 10); // 02 68 69
    w.utf8('\u{E9}\u{20AC}', 10); // U+00E9 -> c3 a9, U+20AC -> e2 82 ac: 5 bytes
    w.utf8('\u{1F600}', 10); // f0 9f 98 80
    w.utf8('\ud800', 10); // lone surrogate -> U+FFFD -> ef bf bd
    expect(hex(w.view())).toBe('00 02 68 69 05 c3 a9 e2 82 ac 04 f0 9f 98 80 03 ef bf bd');
    const r = new ByteReader(w.view());
    expect(r.utf8(10)).toBe('');
    expect(r.utf8(10)).toBe('hi');
    expect(r.utf8(10)).toBe('\u{E9}\u{20AC}');
    expect(r.utf8(10)).toBe('\u{1F600}');
    expect(r.utf8(10)).toBe('\u{FFFD}');
  });

  it('utf8 max is enforced on both sides', () => {
    const w = new ByteWriter();
    w.u8(0xaa);
    expect(encodeErrorCode(() => w.utf8('abcd', 3))).toBe('length');
    expect(encodeErrorCode(() => w.utf8('\u{E9}', 1))).toBe('length'); // 2 bytes
    expect(w.length).toBe(1);
    w.utf8('abcd', 4);
    const r = new ByteReader(w.view());
    r.skip(1);
    expect(decodeError(() => r.utf8(3))).toEqual({ code: 'length', offset: 1 });
    expect(r.offset).toBe(1);
    expect(r.utf8(4)).toBe('abcd');
  });

  it('utf8 rejects invalid UTF-8 and truncated strings', () => {
    // 02 c3 28: invalid continuation byte
    expect(decodeError(() => new ByteReader(fromHex('02 c3 28')).utf8(10))).toEqual({
      code: 'utf8',
      offset: 0,
    });
    // 01 80: lone continuation byte
    expect(decodeError(() => new ByteReader(fromHex('ff 01 80'), 1).utf8(10))).toEqual({
      code: 'utf8',
      offset: 1,
    });
    // 03 ed a0 80: encoded surrogate U+D800 is invalid UTF-8
    expect(decodeError(() => new ByteReader(fromHex('03 ed a0 80')).utf8(10))).toEqual({
      code: 'utf8',
      offset: 0,
    });
    // length 5 but only 2 bytes follow
    expect(decodeError(() => new ByteReader(fromHex('05 61 62')).utf8(10))).toEqual({
      code: 'eof',
      offset: 0,
    });
  });

  it('keeps a leading byte-order mark', () => {
    const w = new ByteWriter();
    w.utf8('\u{FEFF}x', 10); // 04 ef bb bf 78
    expect(hex(w.view())).toBe('04 ef bb bf 78');
    expect(new ByteReader(w.view()).utf8(10)).toBe('\u{FEFF}x');
  });
});

describe('reserve and patch', () => {
  it('patches in place without moving length', () => {
    const w = new ByteWriter();
    const o8 = w.reserveU8();
    const o16 = w.reserveU16();
    w.u32(0);
    expect([o8, o16, w.length]).toEqual([0, 1, 7]);
    w.patchU8(o8, 0xfe);
    w.patchU16(o16, 0xbeef);
    w.patchU32(3, 0xdeadbeef);
    expect(w.length).toBe(7);
    expect(hex(w.view())).toBe('fe ef be ef be ad de');
  });

  it('throws range for patches outside the written bytes or values out of range', () => {
    const w = new ByteWriter();
    w.u16(0);
    w.u8(0); // length 3
    expect(encodeErrorCode(() => w.patchU16(2, 1))).toBe('range'); // 2 + 2 > 3
    expect(encodeErrorCode(() => w.patchU16(-1, 1))).toBe('range');
    expect(encodeErrorCode(() => w.patchU16(0.5, 1))).toBe('range');
    expect(encodeErrorCode(() => w.patchU16(0, 65536))).toBe('range');
    expect(encodeErrorCode(() => w.patchU8(3, 1))).toBe('range');
    expect(encodeErrorCode(() => w.patchU8(0, -1))).toBe('range');
    expect(encodeErrorCode(() => w.patchU32(0, 1))).toBe('range'); // 0 + 4 > 3
    expect(encodeErrorCode(() => w.patchU16(1, 0xffff))).toBe('none');
    expect(hex(w.view())).toBe('00 ff ff');
  });
});

describe('growth, truncate, finish', () => {
  it('grows from 16 bytes to 1 MB keeping contents', () => {
    const w = new ByteWriter(16);
    expect(w.view().buffer.byteLength).toBe(16);
    const n = (1 << 20) / 4;
    for (let i = 0; i < n; i++) w.u32((i * 2654435761) >>> 0);
    expect(w.length).toBe(1 << 20);
    const r = new ByteReader(w.view());
    let mismatches = 0;
    for (let i = 0; i < n; i++) if (r.u32() !== (i * 2654435761) >>> 0) mismatches++;
    expect(mismatches).toBe(0);
  });

  it('grows to max(capacity * 2, needed) rounded up to 1024', () => {
    const w = new ByteWriter(16);
    w.bytes(new Uint8Array(17)); // max(32, 17) -> 1024
    expect(w.view().buffer.byteLength).toBe(1024);
    w.bytes(new Uint8Array(1024)); // needs 1041: max(2048, 1041) -> 2048
    expect(w.view().buffer.byteLength).toBe(2048);
    w.bytes(new Uint8Array(5000)); // needs 6041: max(4096, 6041) -> 6144
    expect(w.view().buffer.byteLength).toBe(6144);
  });

  it('throws capacity past MAX_WRITER_BYTES and keeps what was written', () => {
    const w = new ByteWriter(1500);
    w.bytes(new Uint8Array(12_582_912)); // max(3000, 3 * 2^22) -> capacity 12 582 912
    expect(w.view().buffer.byteLength).toBe(12_582_912);
    w.u8(0); // doubling would give 25 MB: capped at MAX_WRITER_BYTES instead of throwing
    expect(w.view().buffer.byteLength).toBe(MAX_WRITER_BYTES);
    w.bytes(new Uint8Array(MAX_WRITER_BYTES - 12_582_912 - 2));
    w.u8(1);
    expect(w.length).toBe(MAX_WRITER_BYTES);
    expect(encodeErrorCode(() => w.u8(2))).toBe('capacity');
    expect(encodeErrorCode(() => w.utf8('x', 1))).toBe('capacity');
    expect(w.length).toBe(MAX_WRITER_BYTES);
    expect(w.view()[MAX_WRITER_BYTES - 1]).toBe(1);
    expect(
      encodeErrorCode(() => new ByteWriter().bytes(new Uint8Array(MAX_WRITER_BYTES + 1))),
    ).toBe('capacity');
  });

  it('truncate, reset and view', () => {
    const w = new ByteWriter();
    w.u32(0x04030201);
    w.truncate(2);
    expect(hex(w.view())).toBe('01 02');
    expect(encodeErrorCode(() => w.truncate(3))).toBe('range');
    expect(encodeErrorCode(() => w.truncate(-1))).toBe('range');
    w.u8(9);
    expect(hex(w.view())).toBe('01 02 09');
    w.reset();
    expect(w.length).toBe(0);
    expect(w.view().length).toBe(0);
  });

  it('finish() returns an exact copy unaffected by later writes, then resets', () => {
    const w = new ByteWriter();
    w.u16(0x0201);
    const out = w.finish();
    expect(w.length).toBe(0);
    expect(out.byteOffset).toBe(0);
    expect(out.buffer.byteLength).toBe(2);
    w.u16(0xffff);
    expect(hex(out)).toBe('01 02');
  });

  it('rejects an invalid initial capacity', () => {
    expect(() => new ByteWriter(-1)).toThrow(RangeError);
    expect(() => new ByteWriter(1.5)).toThrow(RangeError);
    expect(() => new ByteWriter(MAX_WRITER_BYTES + 1)).toThrow(RangeError);
    const w = new ByteWriter(0);
    w.u8(1);
    expect(w.length).toBe(1);
  });
});

describe('ByteReader bounds', () => {
  const reads: { name: string; n: number; read: (r: ByteReader) => unknown }[] = [
    { name: 'u8', n: 1, read: (r) => r.u8() },
    { name: 'i8', n: 1, read: (r) => r.i8() },
    { name: 'u16', n: 2, read: (r) => r.u16() },
    { name: 'i16', n: 2, read: (r) => r.i16() },
    { name: 'u32', n: 4, read: (r) => r.u32() },
    { name: 'i32', n: 4, read: (r) => r.i32() },
    { name: 'f32', n: 4, read: (r) => r.f32() },
    { name: 'bytes(3)', n: 3, read: (r) => r.bytes(3) },
    { name: 'skip(3)', n: 3, read: (r) => r.skip(3) },
    { name: 'sub(3)', n: 3, read: (r) => r.sub(3) },
  ];

  for (const { name, n, read } of reads) {
    it(`${name} past the end throws eof with the read's offset and leaves offset unchanged`, () => {
      // buffer of 10 bytes; the reader covers [2, 2 + 2 + n - 1): one byte short after skipping 2
      const buf = new Uint8Array(10);
      const r = new ByteReader(buf, 2, 2 + n - 1);
      r.skip(2);
      expect(decodeError(() => read(r))).toEqual({ code: 'eof', offset: 4 });
      expect(r.offset).toBe(4);
      const ok = new ByteReader(buf, 2, 2 + n);
      ok.skip(2);
      expect(decodeError(() => read(ok))).toBe('none');
      expect(ok.remaining()).toBe(0);
    });
  }

  it('eof on an empty reader for utf8 and varuint', () => {
    const r = new ByteReader(new Uint8Array(4), 4);
    expect(decodeError(() => r.utf8(5))).toEqual({ code: 'eof', offset: 4 });
    expect(decodeError(() => r.varuint())).toEqual({ code: 'eof', offset: 4 });
  });

  it('reads through a subarray with a non-zero byteOffset', () => {
    const backing = fromHex('ff ff 01 02 03 04 ff');
    const r = new ByteReader(backing.subarray(2, 6));
    expect(r.u32()).toBe(0x04030201);
    expect(decodeError(() => r.u8())).toEqual({ code: 'eof', offset: 4 });
  });

  it('sub() limits the child and advances the parent', () => {
    const r = new ByteReader(fromHex('01 02 03 04 05'));
    r.u8();
    const child = r.sub(2);
    expect(r.offset).toBe(3);
    expect([child.offset, child.end, child.remaining()]).toEqual([1, 3, 2]);
    expect(child.u16()).toBe(0x0302);
    expect(decodeError(() => child.u8())).toEqual({ code: 'eof', offset: 3 });
    expect(r.u8()).toBe(4);
  });

  it('constructor validates the window', () => {
    const buf = new Uint8Array(4);
    expect(() => new ByteReader(buf, 5)).toThrow(RangeError);
    expect(() => new ByteReader(buf, 2, 3)).toThrow(RangeError);
    expect(() => new ByteReader(buf, -1)).toThrow(RangeError);
    const r = new ByteReader(buf, 1);
    expect([r.offset, r.end, r.remaining()]).toEqual([1, 4, 3]);
    expect(() => r.bytes(-1)).toThrow(RangeError);
  });
});
