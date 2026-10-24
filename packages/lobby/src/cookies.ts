import { createHash, randomBytes } from 'node:crypto';
import { base64url } from '@conduit/auth';

export const COOKIE_NAME = 'conduit_sid';
/** Login lifetime: 30 days, no sliding expiry. */
export const LOBBY_SESSION_TTL_MS = 2_592_000_000;
export const COOKIE_TOKEN_BYTES = 32;
/** How often the host calls `LobbyService.purgeExpired()`. */
export const PURGE_INTERVAL_MS = 3_600_000;

/** RFC 6265 cookie-octets: no controls, whitespace, `"`, `,`, `;` or `\`. */
const COOKIE_VALUE_RE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;
const LOCALHOST_RE = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/i;

/** A fresh raw login token: base64url of 32 random bytes (43 chars). Only its hash is stored. */
export function newCookieToken(): string {
  return base64url(randomBytes(COOKIE_TOKEN_BYTES));
}

/** The `lobby_sessions.token` for a raw cookie value: SHA-256, lowercase hex. */
export function hashCookieToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * `conduit_sid=<raw>; Path=/; HttpOnly; SameSite=Lax; Max-Age=<maxAgeS>` plus `; Secure` when
 * `secure`. `maxAgeS` defaults to the login lifetime in seconds.
 */
export function serializeSessionCookie(
  raw: string,
  opts: { secure: boolean; maxAgeS?: number },
): string {
  const maxAgeS = opts.maxAgeS ?? LOBBY_SESSION_TTL_MS / 1000;
  if (typeof raw !== 'string' || !COOKIE_VALUE_RE.test(raw)) {
    throw new TypeError('cookie value contains characters a cookie cannot carry');
  }
  if (!Number.isInteger(maxAgeS) || maxAgeS < 0) {
    throw new RangeError(`cookie Max-Age must be a non-negative integer, got ${maxAgeS}`);
  }
  const secure = opts.secure ? '; Secure' : '';
  return `${COOKIE_NAME}=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure}`;
}

/** The cookie that removes the login: same attributes, empty value, `Max-Age=0`. */
export function clearSessionCookie(opts: { secure: boolean }): string {
  return serializeSessionCookie('', { secure: opts.secure, maxAgeS: 0 });
}

/**
 * Parses a `Cookie` request header into name → value. Values wrapped in double quotes are
 * unwrapped; pairs without `=` are skipped; the first occurrence of a name wins.
 */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (typeof header !== 'string') return cookies;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    if (name === '' || cookies.has(name)) continue;
    let value = pair.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    cookies.set(name, value);
  }
  return cookies;
}

/** True for a `Host` of `localhost`, `127.0.0.1` or `[::1]`, each with an optional `:port`. */
export function isLocalhost(host: string | undefined): boolean {
  return typeof host === 'string' && LOCALHOST_RE.test(host.trim());
}
