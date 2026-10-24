import { describe, expect, it, vi } from 'vitest';
import {
  INVITE_ALPHABET,
  INVITE_CODE_LENGTH,
  INVITE_CODE_RE,
  INVITE_RETRIES,
  ULID_ALPHABET,
  ULID_RE,
  inviteCode,
  normalizeInviteCode,
  ulid,
} from '../src/index.ts';

/** Decodes the 10 time chars of a ulid back to milliseconds. */
function ulidTime(id: string): number {
  let time = 0;
  for (const char of id.slice(0, 10)) time = time * 32 + ULID_ALPHABET.indexOf(char);
  return time;
}

describe('constants', () => {
  it('match docs/host.md section 2', () => {
    expect(ULID_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
    expect(INVITE_ALPHABET).toBe('0123456789BCDFGHJKMNPQRSTVWXZ');
    expect(INVITE_ALPHABET).toHaveLength(29);
    expect(INVITE_CODE_LENGTH).toBe(8);
    expect(INVITE_RETRIES).toBe(5);
    for (const char of INVITE_ALPHABET) expect(ULID_ALPHABET).toContain(char);
    for (const excluded of 'AEILOUY') expect(INVITE_ALPHABET).not.toContain(excluded);
    expect(ULID_RE.test(ULID_ALPHABET.repeat(2).slice(0, 26))).toBe(true);
    expect(INVITE_CODE_RE.test('BCDFGHJK')).toBe(true);
  });
});

describe('ulid', () => {
  it('is 26 Crockford chars whose first 10 encode the time', () => {
    const now = 1_800_000_000_123;
    const id = ulid(now);
    expect(id).toHaveLength(26);
    expect(id).toMatch(ULID_RE);
    expect(ulidTime(id)).toBe(now);
    expect(ulid(0).slice(0, 10)).toBe('0000000000');
    expect(ulid(2 ** 48 - 1).slice(0, 10)).toBe('7ZZZZZZZZZ');
  });

  it('sorts by time across milliseconds and differs within one', () => {
    const ids = Array.from({ length: 50 }, (_, i) => ulid(1_700_000_000_000 + i * 37));
    expect([...ids].sort()).toEqual(ids);
    const sameMs = new Set(Array.from({ length: 1000 }, () => ulid(1_700_000_000_000)));
    expect(sameMs.size).toBe(1000);
    for (const id of sameMs) expect(id).toMatch(ULID_RE);
  });

  it('uses every random char and defaults to the wall clock', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) for (const char of ulid(1).slice(10)) seen.add(char);
    expect(seen.size).toBe(32);
    vi.useFakeTimers({ now: 1_750_000_000_000 });
    try {
      expect(ulidTime(ulid())).toBe(1_750_000_000_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects times outside 0..2^48 - 1', () => {
    for (const bad of [-1, 2 ** 48, 1.5, Number.NaN]) expect(() => ulid(bad)).toThrow(RangeError);
  });
});

describe('inviteCode', () => {
  it('draws 8 chars from the invite alphabet, covering all of it', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      const code = inviteCode();
      expect(code).toMatch(INVITE_CODE_RE);
      for (const char of code) seen.add(char);
    }
    expect([...seen].sort().join('')).toBe([...INVITE_ALPHABET].sort().join(''));
  });
});

describe('normalizeInviteCode', () => {
  it('trims, uppercases and maps O to 0 and I, L to 1', () => {
    expect(normalizeInviteCode('bcdfghjk')).toBe('BCDFGHJK');
    expect(normalizeInviteCode('  BCDFGHJK\n')).toBe('BCDFGHJK');
    expect(normalizeInviteCode('0o1il234')).toBe('00111234');
    expect(normalizeInviteCode('OOIILL99')).toBe('00111199');
  });

  it('returns null for anything that is not a code', () => {
    const bad = [
      ' abcd-efgh ',
      'BCDF-GHJK',
      'BCDFGHJ',
      'BCDFGHJKM',
      'BCDFGHJA',
      'BCDFGHJE',
      'BCDFGHJU',
      'BCDFGHJY',
      'BCDF GHJ',
      '',
    ];
    for (const s of bad) expect(normalizeInviteCode(s), s).toBeNull();
    expect(normalizeInviteCode(12345678 as unknown as string)).toBeNull();
    expect(normalizeInviteCode(undefined as unknown as string)).toBeNull();
  });
});
