import { createHmac, timingSafeEqual } from 'node:crypto';
import { base64url, base64urlDecode } from './base64url.ts';
import { AuthError } from './errors.ts';

export const TOKEN_TTL_S = 600;
export const MIN_SECRET_BYTES = 32;
export const MAX_TOKEN_FIELD_CHARS = 256;

const MAX_TOKEN_CHARS = 4096;
const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SIGNATURE_BYTES = 32; // HMAC-SHA256

/** Authorizes joining one session (docs/persist.md 2.3). */
export interface SessionToken {
  accountId: string;
  displayName: string;
  sessionId: string;
  exp: number; // unix seconds; valid while exp > now
}

/** Options of `verifyToken` and `TokenVerifier.verify` (docs/persist.md 2.3, 2.4). */
export interface VerifyTokenOptions {
  /**
   * Skip rule 6: a well-formed, correctly signed token is returned even when `exp <= now`, and the
   * caller tells it apart with `isTokenExpired`. Only a Hello that carries a reconnect token is
   * verified this way (docs/host.md 17, docs/net.md A.6): an expired token may resume a player,
   * never join fresh.
   */
  allowExpired?: boolean | undefined;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function tokenExpiry(now: number = nowSeconds()): number {
  return now + TOKEN_TTL_S;
}

/**
 * Rule 6 of `verifyToken` on its own: `exp <= now` (and a NaN `now`) is expired. For a token
 * verified with `allowExpired`.
 */
export function isTokenExpired(
  token: Pick<SessionToken, 'exp'>,
  now: number = nowSeconds(),
): boolean {
  return !(token.exp > now);
}

/** Throws `AuthError('weak_secret')` when `secret` is shorter than MIN_SECRET_BYTES UTF-8 bytes. */
export function assertSecret(secret: string): void {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < MIN_SECRET_BYTES) {
    throw new AuthError('weak_secret', `secret must be at least ${MIN_SECRET_BYTES} UTF-8 bytes`);
  }
}

function hmac(body: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(body, 'utf8').digest();
}

/** Rule 5 of `verifyToken`: the field types and lengths every valid token carries. */
function hasValidFields(v: Partial<Record<keyof SessionToken, unknown>>): v is SessionToken {
  const { accountId, displayName, sessionId, exp } = v;
  return (
    typeof accountId === 'string' &&
    typeof displayName === 'string' &&
    typeof sessionId === 'string' &&
    accountId.length > 0 &&
    sessionId.length > 0 &&
    accountId.length <= MAX_TOKEN_FIELD_CHARS &&
    displayName.length <= MAX_TOKEN_FIELD_CHARS &&
    sessionId.length <= MAX_TOKEN_FIELD_CHARS &&
    typeof exp === 'number' &&
    Number.isInteger(exp)
  );
}

/**
 * `base64url(json).base64url(HMAC-SHA256(secret, body))`, where `body` is the base64url text and
 * the JSON holds exactly `accountId, displayName, sessionId, exp` in that order. Throws
 * `AuthError('bad_payload')` for a payload `verifyToken` would reject (fields breaking rule 5, or
 * `exp` not a non-negative integer) and `AuthError('weak_secret')` for a short secret.
 */
export function mintToken(payload: SessionToken, secret: string): string {
  assertSecret(secret);
  if (!hasValidFields(payload) || payload.exp < 0) {
    throw new AuthError(
      'bad_payload',
      `token payload needs non-empty accountId and sessionId, fields of at most ${MAX_TOKEN_FIELD_CHARS} chars and a non-negative integer exp`,
    );
  }
  const { accountId, displayName, sessionId, exp } = payload;
  const body = base64url(JSON.stringify({ accountId, displayName, sessionId, exp }));
  return `${body}.${base64url(hmac(body, secret))}`;
}

/**
 * The token's payload, or `null` when the token is malformed, forged, or expired (`exp <= now`;
 * with `opts.allowExpired` an expired token is returned too). Never throws for bad tokens; throws
 * `AuthError('weak_secret')` for a short secret.
 */
export function verifyToken(
  token: string,
  secret: string,
  now: number = nowSeconds(),
  opts: VerifyTokenOptions = {},
): SessionToken | null {
  assertSecret(secret);
  // 1. Shape.
  if (typeof token !== 'string' || token.length > MAX_TOKEN_CHARS || !TOKEN_RE.test(token)) {
    return null;
  }
  const dot = token.indexOf('.');
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  // 2. Signature length, in canonical encoding: the 2 spare bits of the 43rd character must be zero,
  // otherwise several signature strings would verify for the same body.
  const sigBytes = base64urlDecode(sig);
  if (sigBytes.length !== SIGNATURE_BYTES || base64url(sigBytes) !== sig) return null;
  // 3. Signature, checked before the body is parsed so malformed bodies cost the same as valid ones.
  if (!timingSafeEqual(sigBytes, hmac(body, secret))) return null;
  // 4. JSON object.
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64urlDecode(body).toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  // 5. Fields.
  const fields: Partial<Record<keyof SessionToken, unknown>> = parsed;
  if (!hasValidFields(fields)) return null;
  // 6. Expiry (written so that a NaN `now` rejects), unless the caller accepts expired tokens.
  if (opts.allowExpired !== true && isTokenExpired(fields, now)) return null;
  const { accountId, displayName, sessionId, exp } = fields;
  return { accountId, displayName, sessionId, exp };
}
