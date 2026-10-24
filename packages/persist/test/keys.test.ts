import { describe, expect, it } from 'vitest';
import {
  BlobStoreError,
  MAX_BLOB_BYTES,
  MAX_KEY_BYTES,
  MAX_NAMESPACE_CHARS,
  NAMESPACE_RE,
  compareKeys,
  prefixUpperBound,
  validateKey,
  validateNamespace,
  validateValue,
  type BlobStoreErrorCode,
} from '../src/index.ts';

function codeOf(fn: () => void): BlobStoreErrorCode | 'none' {
  try {
    fn();
  } catch (err) {
    if (err instanceof BlobStoreError) return err.code;
    throw err;
  }
  return 'none';
}

function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** xorshift32 in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

function randomString(next: () => number, alphabet: string[], maxLength: number): string {
  const length = Math.floor(next() * (maxLength + 1));
  let s = '';
  for (let i = 0; i < length; i++) s += alphabet[Math.floor(next() * alphabet.length)] ?? '';
  return s;
}

// Code points at every UTF-8 length boundary, around the surrogate gap and at the top of the range.
const ALPHABET = [
  '\u{0}',
  'a',
  'b',
  '\u{7F}',
  '\u{80}',
  '\u{E9}',
  '\u{7FF}',
  '\u{800}',
  '\u{D7FF}',
  '\u{E000}',
  '\u{FFFF}',
  '\u{10000}',
  '\u{1F600}',
  '\u{10FFFF}',
];

describe('constants', () => {
  it('match docs/persist.md 1.2', () => {
    expect(NAMESPACE_RE.source).toBe('^[a-z_]+$');
    expect(NAMESPACE_RE.flags).toBe('');
    expect(MAX_NAMESPACE_CHARS).toBe(64);
    expect(MAX_KEY_BYTES).toBe(256);
    expect(MAX_BLOB_BYTES).toBe(64 * 1024 * 1024);
  });
});

describe('validateNamespace', () => {
  it('accepts [a-z_] names of 1..64 chars', () => {
    for (const ns of ['a', '_', 'region', 'player_state', 'n'.repeat(64)]) {
      const code = codeOf(() => validateNamespace(ns));
      expect(code, ns).toBe('none');
    }
  });

  it('rejects everything else with bad_namespace', () => {
    const bad = ['', 'n'.repeat(65), 'Bad', 'a-b', 'a b', 'ns1', '\u{E9}', 'a.b', 'a\n', '\na'];
    for (const ns of [...bad, 42, null, undefined]) {
      const code = codeOf(() => validateNamespace(ns as string));
      expect(code, JSON.stringify(ns)).toBe('bad_namespace');
    }
  });
});

describe('validateKey', () => {
  it('accepts well-formed keys of 1..256 UTF-8 bytes', () => {
    const good = [
      'k',
      'k'.repeat(256),
      '\u{E9}'.repeat(128),
      '\u{1F600}'.repeat(64),
      `a${'\u{20AC}'.repeat(85)}`,
      'region/cell/3_4',
    ];
    for (const key of good) {
      expect(utf8Bytes(key)).toBeLessThanOrEqual(MAX_KEY_BYTES);
      const code = codeOf(() => validateKey(key));
      expect(code, JSON.stringify(key)).toBe('none');
    }
  });

  it('rejects empty, 257-byte and ill-formed keys with bad_key', () => {
    const tooLong = ['k'.repeat(257), `${'\u{E9}'.repeat(128)}k`, `${'\u{1F600}'.repeat(64)}k`];
    for (const key of tooLong) expect(utf8Bytes(key)).toBe(MAX_KEY_BYTES + 1);
    const loneSurrogates = [
      'a\u{D800}',
      '\u{DC00}',
      '\u{DE00}\u{D83D}', // a pair in the wrong order
      'a\u{D83D}b',
      '\u{D83D}\u{D83D}',
    ];
    for (const key of ['', ...tooLong, ...loneSurrogates, 42, null, undefined]) {
      const code = codeOf(() => validateKey(key as string));
      expect(code, JSON.stringify(key)).toBe('bad_key');
    }
  });

  it('allowEmpty admits the empty string and nothing else the key rules reject', () => {
    expect(codeOf(() => validateKey('', true))).toBe('none');
    expect(codeOf(() => validateKey('prefix/', true))).toBe('none');
    expect(codeOf(() => validateKey('k'.repeat(257), true))).toBe('bad_key');
    expect(codeOf(() => validateKey('\u{D800}', true))).toBe('bad_key');
  });
});

describe('validateValue', () => {
  it('accepts Uint8Arrays of 0..64 MiB, including Buffers and views', () => {
    const good = [
      new Uint8Array(0),
      new Uint8Array(MAX_BLOB_BYTES),
      Buffer.from('buffer'),
      new Uint8Array(8).subarray(2, 4),
    ];
    for (const blob of good) expect(codeOf(() => validateValue(blob))).toBe('none');
  });

  it('rejects oversized values and non-Uint8Arrays with bad_value', () => {
    const bad: unknown[] = [
      new Uint8Array(MAX_BLOB_BYTES + 1),
      'text',
      [1, 2],
      { length: 1, 0: 1 },
      new Uint16Array(1),
      new Int8Array(1),
      new Uint8ClampedArray(1),
      new ArrayBuffer(1),
      new DataView(new ArrayBuffer(1)),
      null,
      undefined,
    ];
    for (const value of bad) {
      expect(codeOf(() => validateValue(value as Uint8Array))).toBe('bad_value');
    }
  });
});

describe('compareKeys', () => {
  it('orders by code point, not UTF-16 code unit', () => {
    expect('\u{1F600}' < '\u{E000}').toBe(true); // what plain `<` gets wrong
    expect(compareKeys('\u{E000}', '\u{1F600}')).toBeLessThan(0);
    expect(compareKeys('\u{1F600}', '\u{E000}')).toBeGreaterThan(0);
    expect(compareKeys('\u{FFFF}', '\u{10000}')).toBeLessThan(0);
    expect(compareKeys('\u{1F600}', '\u{1F601}')).toBeLessThan(0);
    expect(compareKeys('x\u{1F600}', 'x\u{1F600}')).toBe(0);
  });

  it('sorts a proper prefix first', () => {
    expect(compareKeys('', 'a')).toBeLessThan(0);
    expect(compareKeys('a', 'a/1')).toBeLessThan(0);
    expect(compareKeys('a/1', 'a')).toBeGreaterThan(0);
    expect(compareKeys('', '')).toBe(0);
  });

  it('sorts the contract keys', () => {
    const keys = ['b', 'a/2', 'a', 'a/1', '\u{1F600}', '\u{E000}', '\u{E9}'];
    const sorted = ['a', 'a/1', 'a/2', 'b', '\u{E9}', '\u{E000}', '\u{1F600}'];
    expect(keys.sort(compareKeys)).toEqual(sorted);
  });

  it('agrees with UTF-8 byte order on random strings', () => {
    const next = rng(0x5eed);
    for (let i = 0; i < 5000; i++) {
      const a = randomString(next, ALPHABET, 4);
      const b =
        next() < 0.3 ? a + randomString(next, ALPHABET, 2) : randomString(next, ALPHABET, 4);
      const bytewise = Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
      const label = `${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
      expect(Math.sign(compareKeys(a, b)), label).toBe(bytewise);
    }
  });
});

describe('prefixUpperBound', () => {
  it('matches the documented cases', () => {
    expect(prefixUpperBound('')).toBeNull();
    expect(prefixUpperBound('a')).toBe('b');
    expect(prefixUpperBound('a\u{D7FF}')).toBe('a\u{E000}');
    expect(prefixUpperBound('a\u{10FFFF}')).toBe('b');
    expect(prefixUpperBound('\u{10FFFF}')).toBeNull();
  });

  it('increments the last code point, carrying past U+10FFFF', () => {
    expect(prefixUpperBound('a/')).toBe('a0');
    expect(prefixUpperBound('\u{FFFF}')).toBe('\u{10000}');
    expect(prefixUpperBound('x\u{1F600}')).toBe('x\u{1F601}');
    expect(prefixUpperBound('a\u{10FFFF}\u{10FFFF}')).toBe('b');
    expect(prefixUpperBound('\u{10FFFF}\u{10FFFF}')).toBeNull();
    expect(prefixUpperBound('\u{1F600}\u{10FFFF}')).toBe('\u{1F601}');
  });

  it('bounds exactly the strings that start with the prefix', () => {
    const next = rng(0xb0b);
    for (let i = 0; i < 3000; i++) {
      const prefix = randomString(next, ALPHABET, 3);
      const bound = prefixUpperBound(prefix);
      if (bound !== null) expect(codeOf(() => validateKey(bound))).toBe('none');
      const extended = next() < 0.5;
      const candidate = extended
        ? prefix + randomString(next, ALPHABET, 3)
        : randomString(next, ALPHABET, 5);
      const aboveLower = compareKeys(candidate, prefix) >= 0;
      const belowUpper = bound === null || compareKeys(candidate, bound) < 0;
      const label = `${JSON.stringify(candidate)} against prefix ${JSON.stringify(prefix)}`;
      expect(aboveLower && belowUpper, label).toBe(candidate.startsWith(prefix));
    }
  });
});
