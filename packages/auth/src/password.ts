import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { base64url, base64urlDecode } from './base64url.ts';
import { AuthError } from './errors.ts';

export const SCRYPT_N = 32768; // 2^15
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEYLEN = 32;
export const SCRYPT_SALT_BYTES = 16;
/**
 * scrypt needs `128 * N * r` bytes (32 MiB at the constants above) plus a little more, and Node's
 * default `maxmem` is exactly 32 MiB, which fails. 64 MiB leaves headroom.
 */
export const SCRYPT_MAXMEM = 67108864;
export const MIN_PASSWORD_BYTES = 8;
export const MAX_PASSWORD_BYTES = 256;
export const PASSWORD_HASH_PREFIX = 'scrypt';

/** The fields of a stored hash `scrypt$<N>$<r>$<p>$<salt b64url>$<hash b64url>`. */
export interface ParsedPasswordHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

const MIN_N = 2 ** 10;
const MAX_N = 2 ** 22;
const MAX_R = 32;
const MAX_P = 16;
const MIN_SALT_BYTES = 8;
const MIN_HASH_BYTES = 16;
const MAX_SALT_OR_HASH_BYTES = 64;
/** A positive decimal integer without leading zeros, short enough to stay a safe integer. */
const DECIMAL_RE = /^[1-9][0-9]{0,9}$/;

/** True when `pw` is MIN_PASSWORD_BYTES..MAX_PASSWORD_BYTES UTF-8 bytes. No other rules apply. */
export function validatePasswordLength(pw: string): boolean {
  if (typeof pw !== 'string') return false;
  const bytes = Buffer.byteLength(pw, 'utf8');
  return bytes >= MIN_PASSWORD_BYTES && bytes <= MAX_PASSWORD_BYTES;
}

/**
 * Hashes `pw` (as given: no normalization) with scrypt and a random salt. Rejects with
 * `AuthError('password_length')` when `pw` fails `validatePasswordLength`.
 */
export async function hashPassword(pw: string): Promise<string> {
  if (!validatePasswordLength(pw)) {
    throw new AuthError(
      'password_length',
      `password must be ${MIN_PASSWORD_BYTES}..${MAX_PASSWORD_BYTES} UTF-8 bytes`,
    );
  }
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const hash = await deriveKey(pw, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return formatHash(SCRYPT_N, SCRYPT_R, SCRYPT_P, salt, hash);
}

/**
 * True when `pw` matches `stored`. Never throws: a password failing the length rule, a `stored`
 * that does not parse, or a derivation error all yield `false`. The parameters come from `stored`,
 * so hashes made with older costs keep verifying (see `needsRehash`).
 */
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  if (!validatePasswordLength(pw)) return false;
  const parsed = parsePasswordHash(stored);
  if (parsed === null) return false;
  const { N, r, p, salt, hash } = parsed;
  try {
    const derived = await deriveKey(pw, salt, hash.length, {
      N,
      r,
      p,
      maxmem: Math.max(SCRYPT_MAXMEM, 256 * N * r),
    });
    return timingSafeEqual(derived, hash);
  } catch {
    return false;
  }
}

/**
 * Parses `scrypt$<N>$<r>$<p>$<salt>$<hash>`: `N` a power of two in 2^10..2^22, `r` in 1..32, `p`
 * in 1..16, a salt of 8..64 bytes and a hash of 16..64 bytes (base64url, no padding). Any other
 * input yields `null`.
 */
export function parsePasswordHash(stored: string): ParsedPasswordHash | null {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6) return null;
  const [prefix, nText, rText, pText, saltText, hashText] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (prefix !== PASSWORD_HASH_PREFIX) return null;
  const N = decimal(nText);
  const r = decimal(rText);
  const p = decimal(pText);
  if (N === null || N < MIN_N || N > MAX_N || (N & (N - 1)) !== 0) return null;
  if (r === null || r > MAX_R || p === null || p > MAX_P) return null;
  const salt = decode(saltText);
  const hash = decode(hashText);
  if (salt === null || salt.length < MIN_SALT_BYTES || salt.length > MAX_SALT_OR_HASH_BYTES) {
    return null;
  }
  if (hash === null || hash.length < MIN_HASH_BYTES || hash.length > MAX_SALT_OR_HASH_BYTES) {
    return null;
  }
  return { N, r, p, salt, hash };
}

/**
 * True when `stored` does not parse or was made with parameters other than the current constants
 * (`N`, `r`, `p`, salt length, hash length). The lobby re-hashes after a successful login.
 */
export function needsRehash(stored: string): boolean {
  const parsed = parsePasswordHash(stored);
  return (
    parsed === null ||
    parsed.N !== SCRYPT_N ||
    parsed.r !== SCRYPT_R ||
    parsed.p !== SCRYPT_P ||
    parsed.salt.length !== SCRYPT_SALT_BYTES ||
    parsed.hash.length !== SCRYPT_KEYLEN
  );
}

function formatHash(N: number, r: number, p: number, salt: Uint8Array, hash: Uint8Array): string {
  return [PASSWORD_HASH_PREFIX, N, r, p, base64url(salt), base64url(hash)].join('$');
}

/** Promise form of `crypto.scrypt` with options (util.promisify loses the options overload). */
function deriveKey(
  pw: string,
  salt: Uint8Array,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(pw, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function decimal(text: string): number | null {
  return DECIMAL_RE.test(text) ? Number(text) : null;
}

function decode(text: string): Buffer | null {
  try {
    return base64urlDecode(text);
  } catch {
    return null;
  }
}
