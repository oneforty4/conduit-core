import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AuthError,
  MAX_TOKEN_FIELD_CHARS,
  MIN_SECRET_BYTES,
  TOKEN_TTL_S,
  assertSecret,
  base64url,
  base64urlDecode,
  isTokenExpired,
  mintToken,
  nowSeconds,
  tokenExpiry,
  verifyToken,
  type AuthErrorCode,
  type SessionToken,
} from '../src/index.ts';

const SECRET = 's'.repeat(32);
const OTHER_SECRET = 't'.repeat(32);
const NOW = 1_800_000_000;

function payload(overrides: Partial<SessionToken> = {}): SessionToken {
  return {
    accountId: '01J8ZK3V4Q6R7S8T9V0W1X2Y3Z',
    displayName: 'Alice',
    sessionId: '01J8ZK4A5B6C7D8E9F0G1H2J3K',
    exp: NOW + TOKEN_TTL_S,
    ...overrides,
  };
}

function codeOf(fn: () => void): AuthErrorCode | 'none' {
  try {
    fn();
  } catch (err) {
    if (err instanceof AuthError) return err.code;
    throw err;
  }
  return 'none';
}

/** A correctly signed token over an arbitrary body text, to reach the checks after the signature. */
function signedToken(bodyText: string, secret = SECRET): string {
  const body = base64url(bodyText);
  const sig = base64url(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

/** Replaces the character at `index` with a different base64url character that changes its high bits. */
function flipCharAt(s: string, index: number): string {
  const replacement = s[index] === 'A' ? 'g' : 'A';
  return s.slice(0, index) + replacement + s.slice(index + 1);
}

describe('constants', () => {
  it('match docs/persist.md 2.3', () => {
    expect(TOKEN_TTL_S).toBe(600);
    expect(MIN_SECRET_BYTES).toBe(32);
    expect(MAX_TOKEN_FIELD_CHARS).toBe(256);
  });
});

describe('nowSeconds / tokenExpiry', () => {
  it('nowSeconds is the wall clock in whole seconds', () => {
    const before = Math.floor(Date.now() / 1000);
    const now = nowSeconds();
    const after = Math.floor(Date.now() / 1000);
    expect(Number.isInteger(now)).toBe(true);
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it('tokenExpiry adds TOKEN_TTL_S', () => {
    expect(tokenExpiry(100)).toBe(700);
    const expiry = tokenExpiry();
    expect(expiry - nowSeconds()).toBeGreaterThanOrEqual(TOKEN_TTL_S - 1);
    expect(expiry - nowSeconds()).toBeLessThanOrEqual(TOKEN_TTL_S);
  });
});

describe('isTokenExpired', () => {
  it('is rule 6 of verifyToken: exp <= now is expired', () => {
    expect(isTokenExpired({ exp: NOW + 1 }, NOW)).toBe(false);
    expect(isTokenExpired({ exp: NOW }, NOW)).toBe(true);
    expect(isTokenExpired({ exp: NOW - 1 }, NOW)).toBe(true);
    expect(isTokenExpired(payload(), NaN)).toBe(true);
    expect(isTokenExpired(payload({ exp: nowSeconds() + 600 }))).toBe(false);
    expect(isTokenExpired(payload({ exp: nowSeconds() - 1 }))).toBe(true);
  });
});

describe('assertSecret', () => {
  it('requires at least 32 UTF-8 bytes', () => {
    expect(codeOf(() => assertSecret('s'.repeat(31)))).toBe('weak_secret');
    expect(codeOf(() => assertSecret(''))).toBe('weak_secret');
    expect(codeOf(() => assertSecret('s'.repeat(32)))).toBe('none');
    expect(codeOf(() => assertSecret('\u{E9}'.repeat(16)))).toBe('none'); // 16 chars, 32 bytes
    expect(codeOf(() => assertSecret(`${'\u{E9}'.repeat(15)}s`))).toBe('weak_secret'); // 31 bytes
    expect(codeOf(() => assertSecret(undefined as unknown as string))).toBe('weak_secret');
  });
});

describe('mintToken / verifyToken', () => {
  it('round-trips exactly the four fields', () => {
    const token = mintToken(payload(), SECRET);
    const verified = verifyToken(token, SECRET, NOW);
    expect(verified).toStrictEqual(payload());
    expect(Object.keys(verified ?? {})).toEqual(['accountId', 'displayName', 'sessionId', 'exp']);
  });

  it('produces two "."-separated base64url parts; the body is the JSON in field order', () => {
    const token = mintToken(payload(), SECRET);
    const parts = token.split('.');
    expect(parts).toHaveLength(2);
    for (const part of parts) expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
    const [body = '', sig = ''] = parts;
    expect(base64urlDecode(body).toString('utf8')).toBe(JSON.stringify(payload()));
    expect(base64urlDecode(sig)).toHaveLength(32);
    expect(mintToken(payload(), SECRET)).toBe(token); // deterministic
  });

  it('does not encode extra payload fields', () => {
    const extra = { ...payload(), admin: true, sessionIdAlias: 'x' };
    const token = mintToken(extra, SECRET);
    expect(mintToken(payload(), SECRET)).toBe(token);
    expect(verifyToken(token, SECRET, NOW)).toStrictEqual(payload());
  });

  it('keeps unicode display names intact', () => {
    const named = payload({ displayName: '\u{C5}sa \u{1F600}' });
    expect(verifyToken(mintToken(named, SECRET), SECRET, NOW)).toStrictEqual(named);
  });

  it('returns null for tampered and malformed tokens', () => {
    const token = mintToken(payload(), SECRET);
    const dot = token.indexOf('.');
    const cases: [string, string][] = [
      ['wrong secret', mintToken(payload(), OTHER_SECRET)],
      ['flipped signature character', flipCharAt(token, dot + 10)],
      ['flipped body character', flipCharAt(token, 5)],
      ['missing "."', token.replace('.', '')],
      ['three parts', `${token}.${token.slice(dot + 1)}`],
      ['empty string', ''],
      ['empty body', token.slice(dot)],
      ['empty signature', token.slice(0, dot + 1)],
      ['padding', `${token}=`],
      ['short signature', token.slice(0, -2)],
      ['over 4096 chars', `${'A'.repeat(4100)}${token}`],
      ['not JSON', signedToken('not json')],
      ['JSON array', signedToken(JSON.stringify([payload()]))],
      ['JSON null', signedToken('null')],
      ['JSON number', signedToken('42')],
      ['missing sessionId', signedToken(JSON.stringify({ ...payload(), sessionId: undefined }))],
      ['empty accountId', signedToken(JSON.stringify(payload({ accountId: '' })))],
      ['empty sessionId', signedToken(JSON.stringify(payload({ sessionId: '' })))],
      ['numeric displayName', signedToken(JSON.stringify({ ...payload(), displayName: 7 }))],
      ['exp as a string', signedToken(JSON.stringify({ ...payload(), exp: String(NOW + 60) }))],
      ['fractional exp', signedToken(JSON.stringify({ ...payload(), exp: NOW + 0.5 }))],
      ['exp === now', mintToken(payload({ exp: NOW }), SECRET)],
      ['exp < now', mintToken(payload({ exp: NOW - 1 }), SECRET)],
      [
        'over-long field',
        signedToken(
          JSON.stringify(payload({ displayName: 'x'.repeat(MAX_TOKEN_FIELD_CHARS + 1) })),
        ),
      ],
    ];
    for (const [label, bad] of cases) expect(verifyToken(bad, SECRET, NOW), label).toBeNull();
    for (const value of [undefined, null, 42, {}]) {
      expect(verifyToken(value as unknown as string, SECRET, NOW)).toBeNull();
    }
    expect(verifyToken(token, SECRET, NaN)).toBeNull();
  });

  it('rejects a signature whose spare trailing bits are set (non-canonical encoding)', () => {
    const token = mintToken(payload(), SECRET);
    const last = token.at(-1) ?? '';
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const sibling = alphabet[alphabet.indexOf(last) + 1] ?? ''; // same high 4 bits, a spare bit set
    const malleated = token.slice(0, -1) + sibling;
    expect(base64urlDecode(malleated.split('.')[1] ?? '')).toEqual(
      base64urlDecode(token.split('.')[1] ?? ''),
    );
    expect(verifyToken(token, SECRET, NOW)).not.toBeNull();
    expect(verifyToken(malleated, SECRET, NOW)).toBeNull();
  });

  it('treats exp === now + 1 as valid and exp <= now as expired', () => {
    expect(verifyToken(mintToken(payload({ exp: NOW + 1 }), SECRET), SECRET, NOW)).toStrictEqual(
      payload({ exp: NOW + 1 }),
    );
    const expired = mintToken(payload({ exp: NOW }), SECRET);
    expect(verifyToken(expired, SECRET, NOW)).toBeNull();
    // Only the expiry failed: the same token verifies against an earlier now.
    expect(verifyToken(expired, SECRET, NOW - 1)).toStrictEqual(payload({ exp: NOW }));
  });

  it('allowExpired returns a correctly signed expired token and rejects everything else', () => {
    const allow = { allowExpired: true };
    for (const exp of [NOW, NOW - 1, 0]) {
      const expired = mintToken(payload({ exp }), SECRET);
      expect(verifyToken(expired, SECRET, NOW), `exp ${exp}`).toBeNull();
      expect(verifyToken(expired, SECRET, NOW, allow), `exp ${exp}`).toStrictEqual(
        payload({ exp }),
      );
    }
    const valid = mintToken(payload(), SECRET);
    expect(verifyToken(valid, SECRET, NOW, allow)).toStrictEqual(payload());
    expect(verifyToken(valid, SECRET, NOW, { allowExpired: false })).toStrictEqual(payload());
    expect(verifyToken(valid, SECRET, NaN, allow)).toStrictEqual(payload());
    expect(verifyToken(mintToken(payload({ exp: NOW }), SECRET), SECRET, NOW, {})).toBeNull();

    const token = mintToken(payload({ exp: NOW - 60 }), SECRET);
    const dot = token.indexOf('.');
    const forged: [string, string][] = [
      ['wrong secret', mintToken(payload({ exp: NOW - 60 }), OTHER_SECRET)],
      ['flipped signature character', flipCharAt(token, dot + 10)],
      ['flipped body character', flipCharAt(token, 5)],
      ['not JSON', signedToken('not json')],
      ['exp as a string', signedToken(JSON.stringify({ ...payload(), exp: String(NOW - 60) }))],
      ['fractional exp', signedToken(JSON.stringify({ ...payload(), exp: NOW - 0.5 }))],
      ['empty sessionId', signedToken(JSON.stringify(payload({ sessionId: '' })))],
    ];
    for (const [label, bad] of forged) {
      expect(verifyToken(bad, SECRET, NOW, allow), label).toBeNull();
    }
    expect(codeOf(() => verifyToken(token, 's'.repeat(31), NOW, allow))).toBe('weak_secret');
  });

  it('defaults now to the wall clock', () => {
    const fresh = mintToken(payload({ exp: nowSeconds() + 600 }), SECRET);
    expect(verifyToken(fresh, SECRET)).not.toBeNull();
    const stale = mintToken(payload({ exp: nowSeconds() - 1 }), SECRET);
    expect(verifyToken(stale, SECRET)).toBeNull();
  });

  it('throws weak_secret for a 31-byte secret in mint and verify; accepts 32 bytes', () => {
    const weak = 's'.repeat(31);
    const token = mintToken(payload(), SECRET);
    expect(codeOf(() => mintToken(payload(), weak))).toBe('weak_secret');
    expect(codeOf(() => verifyToken(token, weak, NOW))).toBe('weak_secret');
    expect(codeOf(() => verifyToken('garbage', weak, NOW))).toBe('weak_secret');
    const strong = 'k'.repeat(32);
    expect(verifyToken(mintToken(payload(), strong), strong, NOW)).toStrictEqual(payload());
  });

  it('throws bad_payload for a payload verifyToken could never accept', () => {
    const bad: [string, Record<string, unknown>][] = [
      ['exp = 1.5', { exp: 1.5 }],
      ['exp = -1', { exp: -1 }],
      ['exp = NaN', { exp: NaN }],
      ['exp = Infinity', { exp: Infinity }],
      ['exp as a string', { exp: '700' }],
      ['empty accountId', { accountId: '' }],
      ['empty sessionId', { sessionId: '' }],
      ['non-string displayName', { displayName: null }],
      ['over-long displayName', { displayName: 'x'.repeat(MAX_TOKEN_FIELD_CHARS + 1) }],
    ];
    for (const [label, overrides] of bad) {
      const code = codeOf(() => mintToken({ ...payload(), ...overrides } as SessionToken, SECRET));
      expect(code, label).toBe('bad_payload');
    }
    expect(codeOf(() => mintToken(payload({ exp: 0, displayName: '' }), SECRET))).toBe('none');
  });
});
