import {
  TOKEN_TTL_S,
  assertSecret,
  nowSeconds,
  verifyToken,
  type SessionToken,
  type VerifyTokenOptions,
} from './token.ts';

/** What `createClient` sends in `Hello.sessionToken` without a lobby token; not a credential. */
export const DEV_TOKEN = 'dev';
export const DEV_AUTH_WARNING =
  '[conduit/auth] devAuth enabled: session tokens are NOT verified. Never use in production.';

const DEV_NAME_MAX_CHARS = 32;
const DEV_ANON_NAME = 'anon';
const DEV_SESSION_ID = 'dev';

/** How a Session turns `Hello.sessionToken` into an identity (docs/persist.md 2.4). */
export interface TokenVerifier {
  readonly dev: boolean;
  /**
   * The identity, or `null` for a token that does not verify. `opts.allowExpired` (a Hello with a
   * reconnect token) also returns an expired token's identity; see `isTokenExpired`.
   */
  verify(
    token: string,
    hello: { displayName: string },
    now?: number,
    opts?: VerifyTokenOptions,
  ): SessionToken | null;
}

/** Verifies HMAC session tokens; the identity comes from the token, never from `hello`. */
export function hmacVerifier(secret: string): TokenVerifier {
  assertSecret(secret);
  return Object.freeze({
    dev: false,
    verify: (
      token: string,
      _hello: { displayName: string },
      now?: number,
      opts?: VerifyTokenOptions,
    ) => verifyToken(token, secret, now, opts),
  });
}

/**
 * Accepts any token and derives the identity from `hello.displayName`; its identities never expire,
 * so `allowExpired` changes nothing. Only `createServer` with the explicit `devAuth: true` option
 * constructs one. Emits DEV_AUTH_WARNING once, at construction.
 */
export function devVerifier(opts?: { warn?: (msg: string) => void }): TokenVerifier {
  const warn = opts?.warn ?? ((msg: string) => console.warn(msg));
  warn(DEV_AUTH_WARNING);
  return Object.freeze({
    dev: true,
    verify: (
      _token: string,
      hello: { displayName: string },
      now: number = nowSeconds(),
    ): SessionToken => {
      const trimmed = typeof hello.displayName === 'string' ? hello.displayName.trim() : '';
      const name =
        trimmed.length === 0 || trimmed.length > DEV_NAME_MAX_CHARS ? DEV_ANON_NAME : trimmed;
      return {
        accountId: `dev:${name.toLowerCase()}`,
        displayName: name,
        sessionId: DEV_SESSION_ID,
        exp: now + TOKEN_TTL_S,
      };
    },
  });
}
