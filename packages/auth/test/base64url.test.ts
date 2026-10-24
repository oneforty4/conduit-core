import { describe, expect, it } from 'vitest';
import { AuthError, base64url, base64urlDecode, type AuthErrorCode } from '../src/index.ts';

function codeOf(fn: () => void): AuthErrorCode | 'none' {
  try {
    fn();
  } catch (err) {
    if (err instanceof AuthError) return err.code;
    throw err;
  }
  return 'none';
}

/** Deterministic bytes that include 0xf8..0xff, which encode to '+' and '/' in plain base64. */
function sampleBytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (i * 157 + length * 31 + 0xfb) & 0xff);
}

describe('base64url', () => {
  it('round-trips 0..64-byte inputs without padding, "+" or "/"', () => {
    for (let length = 0; length <= 64; length++) {
      const bytes = sampleBytes(length);
      const encoded = base64url(bytes);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(encoded).not.toMatch(/[=+/]/);
      expect(encoded.length).toBe(Math.ceil((length * 4) / 3));
      expect(Array.from(base64urlDecode(encoded))).toEqual(Array.from(bytes));
    }
  });

  it('matches the RFC 4648 vectors and uses the URL-safe alphabet', () => {
    const vectors: [string, string][] = [
      ['', ''],
      ['f', 'Zg'],
      ['fo', 'Zm8'],
      ['foo', 'Zm9v'],
      ['foob', 'Zm9vYg'],
      ['fooba', 'Zm9vYmE'],
      ['foobar', 'Zm9vYmFy'],
    ];
    for (const [text, encoded] of vectors) {
      expect(base64url(text)).toBe(encoded);
      expect(base64urlDecode(encoded).toString('utf8')).toBe(text);
    }
    expect(base64url(new Uint8Array([0xfb, 0xff]))).toBe('-_8'); // '+/8=' in plain base64
  });

  it('encodes strings as UTF-8 and only the bytes of a view', () => {
    expect(base64url('\u{E9}\u{1F600}')).toBe(base64url(Buffer.from('\u{E9}\u{1F600}', 'utf8')));
    const backing = new Uint8Array([1, 2, 3, 4, 5]);
    expect(base64url(backing.subarray(1, 3))).toBe(base64url(new Uint8Array([2, 3])));
  });

  it('decodes to a Buffer', () => {
    const decoded = base64urlDecode('AQID');
    expect(Buffer.isBuffer(decoded)).toBe(true);
    expect(Array.from(decoded)).toEqual([1, 2, 3]);
    expect(base64urlDecode('').length).toBe(0);
  });

  it('rejects "=", "+", "/", whitespace and other characters with bad_encoding', () => {
    const bad = ['Zg==', 'Zm9v=', 'a+b', 'a/b', 'Zm 9v', 'Zm9v\n', '\tZm9v', 'Zm9v\r', 'Zm.9v'];
    for (const s of [...bad, '\u{E9}', 42, null]) {
      const code = codeOf(() => base64urlDecode(s as string));
      expect(code, JSON.stringify(s)).toBe('bad_encoding');
    }
  });
});
