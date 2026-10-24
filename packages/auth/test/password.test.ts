import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AuthError,
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_BYTES,
  PASSWORD_HASH_PREFIX,
  SCRYPT_KEYLEN,
  SCRYPT_MAXMEM,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
  SCRYPT_SALT_BYTES,
  base64url,
  hashPassword,
  needsRehash,
  parsePasswordHash,
  validatePasswordLength,
  verifyPassword,
  type AuthErrorCode,
} from '../src/index.ts';

const HASH_RE = /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/;
const PASSWORD = 'correct horse battery staple';

/** A stored hash built outside `hashPassword`, with any parameters and lengths. */
function customHash(
  pw: string,
  opts: { N?: number; r?: number; p?: number; saltBytes?: number; keylen?: number } = {},
): string {
  const { N = 1024, r = 8, p = 1, saltBytes = 16, keylen = 32 } = opts;
  const salt = randomBytes(saltBytes);
  const hash = scryptSync(pw, salt, keylen, { N, r, p, maxmem: SCRYPT_MAXMEM });
  return ['scrypt', N, r, p, base64url(salt), base64url(hash)].join('$');
}

/** A syntactically valid stored hash whose bytes are not derived from any password. */
function shapedHash(fields: {
  prefix?: string;
  N?: string;
  r?: string;
  p?: string;
  saltBytes?: number;
  hashBytes?: number;
}): string {
  const {
    prefix = 'scrypt',
    N = '32768',
    r = '8',
    p = '1',
    saltBytes = 16,
    hashBytes = 32,
  } = fields;
  return [
    prefix,
    N,
    r,
    p,
    base64url(new Uint8Array(saltBytes).fill(7)),
    base64url(new Uint8Array(hashBytes).fill(9)),
  ].join('$');
}

/** `stored` with its `$`-separated part `index` replaced. */
function withPart(stored: string, index: number, value: string): string {
  const parts = stored.split('$');
  parts[index] = value;
  return parts.join('$');
}

async function rejectionCode(promise: Promise<unknown>): Promise<AuthErrorCode | 'none'> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof AuthError) return err.code;
    throw err;
  }
  return 'none';
}

/** Replaces the character at `index` with a base64url character that differs in its data bits. */
function flipCharAt(s: string, index: number): string {
  const replacement = s[index] === 'A' ? 'g' : 'A';
  return s.slice(0, index) + replacement + s.slice(index + 1);
}

describe('constants', () => {
  it('match docs/persist.md 2.2', () => {
    expect(SCRYPT_N).toBe(32768);
    expect(SCRYPT_R).toBe(8);
    expect(SCRYPT_P).toBe(1);
    expect(SCRYPT_KEYLEN).toBe(32);
    expect(SCRYPT_SALT_BYTES).toBe(16);
    expect(SCRYPT_MAXMEM).toBe(64 * 1024 * 1024);
    expect(MIN_PASSWORD_BYTES).toBe(8);
    expect(MAX_PASSWORD_BYTES).toBe(256);
    expect(PASSWORD_HASH_PREFIX).toBe('scrypt');
  });
});

describe('validatePasswordLength', () => {
  it('counts UTF-8 bytes, inclusive of both bounds', () => {
    expect(validatePasswordLength('a'.repeat(7))).toBe(false);
    expect(validatePasswordLength('a'.repeat(8))).toBe(true);
    expect(validatePasswordLength('a'.repeat(256))).toBe(true);
    expect(validatePasswordLength('a'.repeat(257))).toBe(false);
    expect(validatePasswordLength('\u{E9}'.repeat(4))).toBe(true); // 4 chars, 8 bytes
    expect(validatePasswordLength('\u{E9}'.repeat(129))).toBe(false); // 258 bytes
    expect(validatePasswordLength('')).toBe(false);
    expect(validatePasswordLength(12345678 as unknown as string)).toBe(false);
  });
});

describe('hashPassword', () => {
  it('produces the documented format, and two hashes of one password differ and both verify', async () => {
    const [a, b] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);
    expect(a).toMatch(HASH_RE);
    expect(b).toMatch(HASH_RE);
    expect(a).not.toBe(b);
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword(PASSWORD, b)).toBe(true);
    expect(await verifyPassword('correct horse battery stapler', a)).toBe(false);
  });

  it('enforces the length rule in UTF-8 bytes', async () => {
    expect(await rejectionCode(hashPassword('a'.repeat(7)))).toBe('password_length');
    expect(await rejectionCode(hashPassword('a'.repeat(257)))).toBe('password_length');
    expect(await rejectionCode(hashPassword(''))).toBe('password_length');
    const [eight, max, twoByte] = await Promise.all([
      hashPassword('a'.repeat(8)),
      hashPassword('a'.repeat(256)),
      hashPassword('\u{E9}'.repeat(5)), // 5 chars, 10 bytes
    ]);
    expect(eight).toMatch(HASH_RE);
    expect(max).toMatch(HASH_RE);
    expect(twoByte).toMatch(HASH_RE);
    expect(await verifyPassword('\u{E9}'.repeat(5), twoByte)).toBe(true);
  });

  it('hashes the string as given, without normalization', async () => {
    const composed = 'caf\u{E9}-password';
    const decomposed = 'cafe\u{301}-password';
    const stored = await hashPassword(composed);
    expect(await verifyPassword(composed, stored)).toBe(true);
    expect(await verifyPassword(decomposed, stored)).toBe(false);
  });
});

describe('verifyPassword', () => {
  it('returns false without throwing for unparseable hashes and out-of-range passwords', async () => {
    const stored = await hashPassword(PASSWORD);
    const fivePart = stored.split('$').slice(0, 5).join('$');
    const nThree = stored.replace('$32768$', '$3$');
    for (const bad of ['', 'scrypt$x', fivePart, nThree]) {
      await expect(verifyPassword(PASSWORD, bad), bad).resolves.toBe(false);
    }
    await expect(verifyPassword('', stored)).resolves.toBe(false);
    await expect(verifyPassword('a'.repeat(257), stored)).resolves.toBe(false);
    await expect(verifyPassword('a'.repeat(100_000), stored)).resolves.toBe(false);
    await expect(verifyPassword(PASSWORD, null as unknown as string)).resolves.toBe(false);
  });

  it('fails when the last character of the hash part is flipped', async () => {
    const stored = await hashPassword(PASSWORD);
    const tampered = flipCharAt(stored, stored.length - 1);
    expect(tampered).not.toBe(stored);
    expect(parsePasswordHash(tampered)).not.toBeNull();
    expect(await verifyPassword(PASSWORD, tampered)).toBe(false);
  });

  it('verifies with the parameters and key length stored in the hash', async () => {
    const old = customHash(PASSWORD, { N: 1024 });
    expect(await verifyPassword(PASSWORD, old)).toBe(true);
    expect(await verifyPassword('wrong password', old)).toBe(false);
    expect(needsRehash(old)).toBe(true);

    const odd = customHash(PASSWORD, { N: 2048, r: 4, p: 2, saltBytes: 8, keylen: 64 });
    expect(await verifyPassword(PASSWORD, odd)).toBe(true);
    expect(needsRehash(odd)).toBe(true);
  });
});

describe('parsePasswordHash', () => {
  it('returns the fields of a fresh hash', async () => {
    const parsed = parsePasswordHash(await hashPassword(PASSWORD));
    expect(parsed).not.toBeNull();
    expect(parsed?.N).toBe(SCRYPT_N);
    expect(parsed?.r).toBe(SCRYPT_R);
    expect(parsed?.p).toBe(SCRYPT_P);
    expect(Buffer.isBuffer(parsed?.salt)).toBe(true);
    expect(parsed?.salt.length).toBe(SCRYPT_SALT_BYTES);
    expect(parsed?.hash.length).toBe(SCRYPT_KEYLEN);
  });

  it('accepts the parameter and length bounds', () => {
    const accepted = [
      shapedHash({ N: String(2 ** 10) }),
      shapedHash({ N: String(2 ** 22) }),
      shapedHash({ r: '1', p: '1' }),
      shapedHash({ r: '32', p: '16' }),
      shapedHash({ saltBytes: 8, hashBytes: 16 }),
      shapedHash({ saltBytes: 64, hashBytes: 64 }),
    ];
    for (const stored of accepted) expect(parsePasswordHash(stored), stored).not.toBeNull();
  });

  it('rejects everything else', () => {
    const valid = shapedHash({});
    const rejected = [
      '',
      'scrypt',
      'scrypt$x',
      valid.split('$').slice(0, 5).join('$'),
      `${valid}$extra`,
      shapedHash({ prefix: 'bcrypt' }),
      shapedHash({ prefix: 'SCRYPT' }),
      shapedHash({ N: '3' }),
      shapedHash({ N: String(2 ** 9) }),
      shapedHash({ N: String(2 ** 23) }),
      shapedHash({ N: '32767' }),
      shapedHash({ N: '032768' }),
      shapedHash({ N: '32768.0' }),
      shapedHash({ N: '+32768' }),
      shapedHash({ N: '' }),
      shapedHash({ r: '0' }),
      shapedHash({ r: '33' }),
      shapedHash({ p: '0' }),
      shapedHash({ p: '17' }),
      shapedHash({ p: '-1' }),
      shapedHash({ saltBytes: 7 }),
      shapedHash({ saltBytes: 65 }),
      shapedHash({ hashBytes: 15 }),
      shapedHash({ hashBytes: 65 }),
      withPart(valid, 5, 'bm90+base64/url='),
      withPart(valid, 4, 'bad salt bytes'),
      withPart(valid, 4, ''),
      withPart(valid, 5, ''),
    ];
    for (const stored of rejected) expect(parsePasswordHash(stored), stored).toBeNull();
    expect(parsePasswordHash(undefined as unknown as string)).toBeNull();
  });
});

describe('needsRehash', () => {
  it('is false for a fresh hash and true for other parameters or unparseable input', async () => {
    expect(needsRehash(await hashPassword(PASSWORD))).toBe(false);
    expect(needsRehash(shapedHash({}))).toBe(false);
    expect(needsRehash(shapedHash({ N: '65536' }))).toBe(true);
    expect(needsRehash(shapedHash({ r: '16' }))).toBe(true);
    expect(needsRehash(shapedHash({ p: '2' }))).toBe(true);
    expect(needsRehash(shapedHash({ saltBytes: 32 }))).toBe(true);
    expect(needsRehash(shapedHash({ hashBytes: 64 }))).toBe(true);
    expect(needsRehash('')).toBe(true);
    expect(needsRehash('scrypt$x')).toBe(true);
  });
});
