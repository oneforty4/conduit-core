import { randomBytes, randomInt } from 'node:crypto';

/** Crockford base32. */
export const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** Crockford base32 without I L O U (already absent) and without the vowels A E and Y: 29 chars. */
export const INVITE_ALPHABET = '0123456789BCDFGHJKMNPQRSTVWXZ';
export const INVITE_CODE_LENGTH = 8;
export const INVITE_CODE_RE = /^[0-9BCDFGHJKMNPQRSTVWXZ]{8}$/;
/** Attempts at drawing an unused invite code before `createSession` gives up. */
export const INVITE_RETRIES = 5;

const ULID_TIME_CHARS = 10;
const ULID_RANDOM_BYTES = 10; // 80 bits, 16 base32 chars
const MAX_ULID_TIME = 2 ** 48 - 1;

/**
 * A 26-char ulid: 10 chars of the millisecond time `now` (base32, most significant first) and 16
 * chars of `randomBytes(10)`. Ids from different milliseconds sort by time as plain strings.
 */
export function ulid(now: number = Date.now()): string {
  if (!Number.isInteger(now) || now < 0 || now > MAX_ULID_TIME) {
    throw new RangeError(`ulid time must be an integer in 0..2^48 - 1, got ${now}`);
  }
  let time = '';
  let rest = now;
  for (let i = 0; i < ULID_TIME_CHARS; i++) {
    time = ULID_ALPHABET.charAt(rest % 32) + time;
    rest = Math.floor(rest / 32);
  }
  let random = '';
  let acc = 0;
  let bits = 0;
  for (const byte of randomBytes(ULID_RANDOM_BYTES)) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      random += ULID_ALPHABET.charAt((acc >> bits) & 31);
    }
    acc &= (1 << bits) - 1;
  }
  return time + random;
}

/** A fresh 8-char invite code, each char drawn uniformly from INVITE_ALPHABET. */
export function inviteCode(): string {
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    code += INVITE_ALPHABET.charAt(randomInt(INVITE_ALPHABET.length));
  }
  return code;
}

/**
 * The canonical form of a typed invite code: trimmed, uppercased, `O` read as `0` and `I`/`L` as
 * `1`. `null` when the result is not a valid code (or `s` is not a string).
 */
export function normalizeInviteCode(s: string): string | null {
  if (typeof s !== 'string') return null;
  const code = s.trim().toUpperCase().replaceAll('O', '0').replace(/[IL]/g, '1');
  return INVITE_CODE_RE.test(code) ? code : null;
}
