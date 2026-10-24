import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  COOKIE_NAME,
  COOKIE_TOKEN_BYTES,
  LOBBY_SESSION_TTL_MS,
  PURGE_INTERVAL_MS,
  clearSessionCookie,
  hashCookieToken,
  isLocalhost,
  newCookieToken,
  parseCookies,
  serializeSessionCookie,
} from '../src/index.ts';

describe('constants', () => {
  it('match docs/host.md section 3', () => {
    expect(COOKIE_NAME).toBe('conduit_sid');
    expect(LOBBY_SESSION_TTL_MS).toBe(30 * 24 * 3600 * 1000);
    expect(COOKIE_TOKEN_BYTES).toBe(32);
    expect(PURGE_INTERVAL_MS).toBe(3_600_000);
  });
});

describe('cookie tokens', () => {
  it('are 43 base64url chars and unique', () => {
    const tokens = new Set(Array.from({ length: 100 }, () => newCookieToken()));
    expect(tokens.size).toBe(100);
    for (const token of tokens) expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hash to SHA-256 hex', () => {
    const token = newCookieToken();
    expect(hashCookieToken(token)).toBe(createHash('sha256').update(token).digest('hex'));
    expect(hashCookieToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCookieToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('serializeSessionCookie / clearSessionCookie', () => {
  it('produce the exact attribute strings, with Secure only when secure', () => {
    expect(serializeSessionCookie('abc_-123', { secure: false })).toBe(
      'conduit_sid=abc_-123; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000',
    );
    expect(serializeSessionCookie('abc_-123', { secure: true })).toBe(
      'conduit_sid=abc_-123; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure',
    );
    expect(serializeSessionCookie('v', { secure: false, maxAgeS: 60 })).toBe(
      'conduit_sid=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=60',
    );
    expect(clearSessionCookie({ secure: false })).toBe(
      'conduit_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    );
    expect(clearSessionCookie({ secure: true })).toBe(
      'conduit_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
    );
  });

  it('refuse values and ages a Set-Cookie header cannot carry', () => {
    for (const bad of ['a;b', 'a b', 'a"b', 'a,b', 'a\\b', 'a\nb']) {
      expect(() => serializeSessionCookie(bad, { secure: false }), bad).toThrow(TypeError);
    }
    expect(() => serializeSessionCookie('v', { secure: false, maxAgeS: -1 })).toThrow(RangeError);
    expect(() => serializeSessionCookie('v', { secure: false, maxAgeS: 1.5 })).toThrow(RangeError);
  });
});

describe('parseCookies', () => {
  it('parses several cookies, whitespace and quoted values', () => {
    const cookies = parseCookies('a=1; conduit_sid=abc;theme="dark mode" ;  empty=; eq=x=y');
    expect([...cookies]).toEqual([
      ['a', '1'],
      ['conduit_sid', 'abc'],
      ['theme', 'dark mode'],
      ['empty', ''],
      ['eq', 'x=y'],
    ]);
  });

  it('skips pairs without a name or "=", keeps the first of duplicate names', () => {
    const cookies = parseCookies('flag; =orphan; conduit_sid=first; conduit_sid=second; "="');
    expect(cookies.get('conduit_sid')).toBe('first');
    expect(cookies.has('flag')).toBe(false);
    expect(cookies.has('')).toBe(false);
  });

  it('returns an empty map without a header', () => {
    expect(parseCookies(undefined).size).toBe(0);
    expect(parseCookies('').size).toBe(0);
  });
});

describe('isLocalhost', () => {
  it('accepts localhost, 127.0.0.1 and [::1], with or without a port', () => {
    for (const host of [
      'localhost',
      'localhost:8080',
      'LOCALHOST:5173',
      '127.0.0.1',
      '127.0.0.1:3000',
      '[::1]',
      '[::1]:8080',
    ]) {
      expect(isLocalhost(host), host).toBe(true);
    }
  });

  it('rejects every other host', () => {
    for (const host of [
      'play.example.com',
      'play.example.com:443',
      'localhost.example.com',
      'example.localhost.com',
      '127.0.0.2',
      '::1',
      '[::2]',
      'localhost:',
      'localhost:port',
      '',
      undefined,
    ]) {
      expect(isLocalhost(host), String(host)).toBe(false);
    }
  });
});
