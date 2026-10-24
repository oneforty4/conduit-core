import { describe, expect, it } from 'vitest';
import { FNV_BASIS, FNV_PRIME, fnv1a32, fnv1a32u32 } from '../src/index.ts';

describe('fnv1a32', () => {
  it('constants', () => {
    expect(FNV_BASIS).toBe(0x811c9dc5);
    expect(FNV_PRIME).toBe(0x01000193);
  });

  it('known answers', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
    expect(fnv1a32(new Uint8Array(0))).toBe(0x811c9dc5);
  });

  it('returns a u32', () => {
    for (const s of ['', 'a', 'foobar', 'hello world', '\u{1F600}']) {
      const h = fnv1a32(s);
      expect(Number.isInteger(h) && h >= 0 && h < 2 ** 32).toBe(true);
    }
  });

  it('hashes a string and its equal UTF-8 bytes identically', () => {
    const bytes = Uint8Array.of(0x66, 0x6f, 0x6f, 0x62, 0x61, 0x72); // 'foobar'
    expect(fnv1a32(bytes)).toBe(fnv1a32('foobar'));
    const enc = new TextEncoder();
    for (const s of ['struct{pos:vec3(fixed32(0.001))}', 'Zoë', '日本語', 'a\u{1F680}b', '']) {
      expect(fnv1a32(s)).toBe(fnv1a32(enc.encode(s)));
    }
  });

  it('encodes non-ASCII input as UTF-8', () => {
    // 'é' U+00E9 -> C3 A9 (2 bytes)
    expect(fnv1a32('hé')).toBe(fnv1a32(Uint8Array.of(0x68, 0xc3, 0xa9)));
    // '€' U+20AC -> E2 82 AC (3 bytes)
    expect(fnv1a32('€')).toBe(fnv1a32(Uint8Array.of(0xe2, 0x82, 0xac)));
    // '😀' U+1F600 (surrogate pair D83D DE00) -> F0 9F 98 80 (4 bytes)
    expect(fnv1a32('\u{1F600}')).toBe(fnv1a32(Uint8Array.of(0xf0, 0x9f, 0x98, 0x80)));
    // lone surrogates encode as U+FFFD -> EF BF BD, as TextEncoder does
    expect(fnv1a32('\ud800x')).toBe(fnv1a32(Uint8Array.of(0xef, 0xbf, 0xbd, 0x78)));
    expect(fnv1a32('x\udc00')).toBe(fnv1a32(Uint8Array.of(0x78, 0xef, 0xbf, 0xbd)));
    expect(fnv1a32('\ud83d')).toBe(fnv1a32(new TextEncoder().encode('\ud83d')));
    // not the same as hashing UTF-16 code units
    expect(fnv1a32('hé')).not.toBe(fnv1a32(Uint8Array.of(0x68, 0xe9)));
  });

  it('uses the seed as the starting basis', () => {
    expect(fnv1a32('', 1234)).toBe(1234);
    expect(fnv1a32('', -1)).toBe(0xffffffff);
    const h1 = fnv1a32('ab');
    expect(fnv1a32('b', fnv1a32('a'))).toBe(h1);
    expect(fnv1a32('a', 7)).not.toBe(fnv1a32('a'));
  });

  it('matches the per-byte reference loop', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => (i * 37) & 0xff);
    let h = FNV_BASIS;
    for (const b of bytes) h = Math.imul(h ^ b, FNV_PRIME) >>> 0;
    expect(fnv1a32(bytes)).toBe(h);
  });
});

describe('fnv1a32u32', () => {
  it('equals fnv1a32 over the 4 little-endian bytes', () => {
    const values = [0, 1, 0xff, 0x100, 0x12345678, 0x80000000, 0xffffffff, 0xdeadbeef];
    for (const v of values) {
      const le = Uint8Array.of(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
      expect(fnv1a32u32(FNV_BASIS, v)).toBe(fnv1a32(le));
      expect(fnv1a32u32(0x1234abcd, v)).toBe(fnv1a32(le, 0x1234abcd));
    }
  });

  it('chains with fnv1a32', () => {
    const h = fnv1a32u32(fnv1a32('x'), 0x01020304);
    expect(h).toBe(fnv1a32(Uint8Array.of(0x78, 0x04, 0x03, 0x02, 0x01)));
  });
});
