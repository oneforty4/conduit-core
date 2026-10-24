import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  DEV_AUTH_WARNING,
  DEV_TOKEN,
  TOKEN_TTL_S,
  devVerifier,
  hmacVerifier,
  mintToken,
  nowSeconds,
  verifyToken,
  type SessionToken,
} from '../src/index.ts';

const SECRET = 'v'.repeat(32);
const NOW = 1_800_000_000;
const IDENTITY: SessionToken = {
  accountId: 'acct_1',
  displayName: 'Alice',
  sessionId: 'session_1',
  exp: NOW + TOKEN_TTL_S,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('constants', () => {
  it('match docs/persist.md 2.4', () => {
    expect(DEV_TOKEN).toBe('dev');
    expect(DEV_AUTH_WARNING).toBe(
      '[conduit/auth] devAuth enabled: session tokens are NOT verified. Never use in production.',
    );
  });
});

describe('hmacVerifier', () => {
  it('delegates to verifyToken and ignores hello.displayName', () => {
    const verifier = hmacVerifier(SECRET);
    expect(verifier.dev).toBe(false);
    const token = mintToken(IDENTITY, SECRET);
    const verified = verifier.verify(token, { displayName: 'Mallory' }, NOW);
    expect(verified).toStrictEqual(IDENTITY);
    expect(verified).toStrictEqual(verifyToken(token, SECRET, NOW));

    expect(verifier.verify(DEV_TOKEN, { displayName: 'Alice' }, NOW)).toBeNull();
    expect(verifier.verify('', { displayName: 'Alice' }, NOW)).toBeNull();
    expect(verifier.verify(mintToken(IDENTITY, 'w'.repeat(32)), IDENTITY, NOW)).toBeNull();
    expect(verifier.verify(token, IDENTITY, IDENTITY.exp)).toBeNull(); // expired
  });

  it('passes allowExpired through to verifyToken', () => {
    const verifier = hmacVerifier(SECRET);
    const token = mintToken(IDENTITY, SECRET);
    const later = IDENTITY.exp + 3600;
    expect(verifier.verify(token, { displayName: '' }, later)).toBeNull();
    expect(verifier.verify(token, { displayName: '' }, later, {})).toBeNull();
    expect(
      verifier.verify(token, { displayName: '' }, later, { allowExpired: true }),
    ).toStrictEqual(IDENTITY);
    const forged = mintToken(IDENTITY, 'w'.repeat(32));
    expect(verifier.verify(forged, { displayName: '' }, later, { allowExpired: true })).toBeNull();
  });

  it('defaults now to the wall clock', () => {
    const verifier = hmacVerifier(SECRET);
    const fresh = mintToken({ ...IDENTITY, exp: nowSeconds() + 600 }, SECRET);
    expect(verifier.verify(fresh, { displayName: '' })).not.toBeNull();
    const stale = mintToken({ ...IDENTITY, exp: nowSeconds() - 1 }, SECRET);
    expect(verifier.verify(stale, { displayName: '' })).toBeNull();
  });

  it('asserts the secret at construction', () => {
    expect(() => hmacVerifier('s'.repeat(31))).toThrow(AuthError);
    expect(() => hmacVerifier('s'.repeat(31))).toThrow(
      expect.objectContaining({ code: 'weak_secret' }),
    );
    expect(hmacVerifier('s'.repeat(32)).dev).toBe(false);
  });
});

describe('devVerifier', () => {
  it('accepts any token and derives the identity from the Hello display name', () => {
    const verifier = devVerifier({ warn: () => {} });
    expect(verifier.dev).toBe(true);
    const alice: SessionToken = {
      accountId: 'dev:alice',
      displayName: 'Alice',
      sessionId: 'dev',
      exp: NOW + 600,
    };
    for (const token of [DEV_TOKEN, '', 'garbage', mintToken(IDENTITY, SECRET)]) {
      expect(verifier.verify(token, { displayName: ' Alice ' }, NOW)).toStrictEqual(alice);
    }
    expect(verifier.verify(DEV_TOKEN, { displayName: 'Alice' }, NOW)).toStrictEqual(alice);
  });

  it('falls back to "anon" for empty, blank and over-32-character names', () => {
    const verifier = devVerifier({ warn: () => {} });
    const anon: SessionToken = {
      accountId: 'dev:anon',
      displayName: 'anon',
      sessionId: 'dev',
      exp: NOW + 600,
    };
    for (const displayName of ['', '   ', 'x'.repeat(33)]) {
      expect(verifier.verify(DEV_TOKEN, { displayName }, NOW), displayName).toStrictEqual(anon);
    }
    const name32 = 'Y'.repeat(32);
    expect(verifier.verify(DEV_TOKEN, { displayName: ` ${name32} ` }, NOW)).toStrictEqual({
      accountId: `dev:${'y'.repeat(32)}`,
      displayName: name32,
      sessionId: 'dev',
      exp: NOW + 600,
    });
  });

  it('ignores allowExpired: its identities are never expired', () => {
    const verifier = devVerifier({ warn: () => {} });
    const identity = verifier.verify('', { displayName: 'Alice' }, NOW, { allowExpired: true });
    expect(identity).toStrictEqual(verifier.verify('', { displayName: 'Alice' }, NOW));
    expect(identity?.exp).toBe(NOW + TOKEN_TTL_S);
  });

  it('gives two clients with the same display name the same accountId', () => {
    const verifier = devVerifier({ warn: () => {} });
    const a = verifier.verify('', { displayName: 'Bob' }, NOW);
    const b = verifier.verify(DEV_TOKEN, { displayName: 'bob' }, NOW + 5);
    expect(a?.accountId).toBe('dev:bob');
    expect(b?.accountId).toBe('dev:bob');
  });

  it('defaults now to the wall clock', () => {
    const verifier = devVerifier({ warn: () => {} });
    const before = nowSeconds();
    const exp = verifier.verify(DEV_TOKEN, { displayName: 'Alice' })?.exp ?? 0;
    expect(exp).toBeGreaterThanOrEqual(before + TOKEN_TTL_S);
    expect(exp).toBeLessThanOrEqual(nowSeconds() + TOKEN_TTL_S);
  });

  it('emits the warning once through the injected warn, at construction only', () => {
    const warn = vi.fn();
    const verifier = devVerifier({ warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(DEV_AUTH_WARNING);
    for (let i = 0; i < 3; i++) verifier.verify(DEV_TOKEN, { displayName: 'Alice' }, NOW);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns through console.warn by default', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const verifier = devVerifier();
    verifier.verify(DEV_TOKEN, { displayName: 'Alice' }, NOW);
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(consoleWarn).toHaveBeenCalledWith(DEV_AUTH_WARNING);
  });
});
