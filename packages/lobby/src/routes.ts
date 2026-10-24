import { Hono, type Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type {
  Account,
  CreateSessionResponse,
  ErrorResponse,
  FriendResponse,
  GamesResponse,
  JoinResponse,
  ListSessionsResponse,
  LoginResponse,
  MeResponse,
  RegisterResponse,
  SessionSummary,
} from './api.ts';
import {
  COOKIE_NAME,
  clearSessionCookie,
  isLocalhost,
  parseCookies,
  serializeSessionCookie,
} from './cookies.ts';
import { LobbyError } from './errors.ts';
import { ULID_RE } from './ids.ts';
import { RateLimiter } from './rate-limit.ts';
import type { LobbyService } from './service.ts';

export interface LobbyEnv {
  Bindings: { remoteAddress?: string; encrypted?: boolean };
  Variables: { account?: Account };
}

export interface LobbyRouteOptions {
  /** e.g. `'wss://play.example.com'`; default derived per request (`deriveWsBase`). */
  publicWsBase?: string;
  /** Default: `Secure` unless the `Host` is localhost. */
  secureCookies?: boolean;
  /** Trust `X-Forwarded-For/-Proto/-Host`; default false. */
  trustProxy?: boolean;
  /** Applied to register and login per client IP; default `new RateLimiter()`. */
  rateLimiter?: RateLimiter;
}

/** Larger request bodies are rejected with `400 validation` before they are buffered. */
export const MAX_JSON_BODY_BYTES = 65_536;

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const RETRY_AFTER_S = '60';

type LobbyContext = Context<LobbyEnv>;

/**
 * The lobby HTTP API (docs/host.md section 10) as a Hono app for the host to mount. Middleware is
 * attached per route, never with `use('*')`, so mounting it does not affect the host's other
 * routes. `c.env` carries the socket's `remoteAddress` and `encrypted` flag.
 */
export function lobbyRoutes(service: LobbyService, opts: LobbyRouteOptions = {}): Hono<LobbyEnv> {
  const app = new Hono<LobbyEnv>();
  const limiter = opts.rateLimiter ?? new RateLimiter();

  const rateLimited = createMiddleware<LobbyEnv>(async (c, next) => {
    if (!limiter.take(clientIp(c, opts))) {
      return errorResponse(new LobbyError('rate_limited', 'too many attempts, try again later'), {
        'Retry-After': RETRY_AFTER_S,
      });
    }
    await next();
  });

  const auth = createMiddleware<LobbyEnv>(async (c, next) => {
    const account = service.authenticate(sessionCookie(c));
    if (account === null) throw new LobbyError('unauthorized', 'login required');
    c.set('account', account);
    await next();
  });

  /** `:id` must be a ulid; otherwise 404 before any database access. */
  const ulidParam = createMiddleware<LobbyEnv>(async (c, next) => {
    if (!ULID_RE.test(c.req.param('id') ?? '')) throw new LobbyError('not_found', 'not found');
    await next();
  });

  app.post('/auth/register', rateLimited, async (c) => {
    const account = await service.register(await readJsonBody(c, true));
    return json<RegisterResponse>(201, { account });
  });

  app.post('/auth/login', rateLimited, async (c) => {
    const { account, cookieToken } = await service.login(await readJsonBody(c, true));
    return json<LoginResponse>(
      200,
      { account },
      { 'Set-Cookie': serializeSessionCookie(cookieToken, { secure: secureCookies(c, opts) }) },
    );
  });

  app.post('/auth/logout', async (c) => {
    await readJsonBody(c, false);
    service.logout(sessionCookie(c));
    return noContent({ 'Set-Cookie': clearSessionCookie({ secure: secureCookies(c, opts) }) });
  });

  app.get('/me', auth, (c) => json<MeResponse>(200, service.me(accountOf(c).id)));

  app.get('/games', () => json<GamesResponse>(200, service.games()));

  app.get('/sessions', auth, (c) => {
    const gameId = c.req.query('gameId');
    return json<ListSessionsResponse>(
      200,
      service.listSessions(
        accountOf(c).id,
        gameId === undefined || gameId === '' ? undefined : gameId,
      ),
    );
  });

  app.post('/sessions', auth, async (c) => {
    const body = await readJsonBody(c, true);
    return json<CreateSessionResponse>(201, service.createSession(accountOf(c).id, body));
  });

  app.get('/sessions/:id', ulidParam, auth, (c) =>
    json<SessionSummary>(200, service.getSession(accountOf(c).id, c.req.param('id'))),
  );

  app.post('/sessions/:id/join', ulidParam, auth, async (c) => {
    const body = await readJsonBody(c, false);
    const id = c.req.param('id');
    const code = body?.['inviteCode'];
    const { token } = await service.joinSession(
      accountOf(c).id,
      id,
      typeof code === 'string' ? code : undefined,
    );
    return json<JoinResponse>(200, { token, wsUrl: `${deriveWsBase(c, opts)}/session/${id}` });
  });

  app.post('/sessions/:id/leave', ulidParam, auth, async (c) => {
    await readJsonBody(c, false);
    service.leaveSession(accountOf(c).id, c.req.param('id'));
    return noContent();
  });

  app.delete('/sessions/:id', ulidParam, auth, async (c) => {
    await readJsonBody(c, false);
    await service.deleteSession(accountOf(c).id, c.req.param('id'));
    return noContent();
  });

  app.post('/friends/:username', auth, async (c) => {
    await readJsonBody(c, false);
    const friend = service.requestFriend(accountOf(c).id, c.req.param('username').toLowerCase());
    return json<FriendResponse>(friend.status === 'accepted' ? 200 : 201, { friend });
  });

  app.post('/friends/:id/accept', ulidParam, auth, async (c) => {
    await readJsonBody(c, false);
    const friend = service.acceptFriend(accountOf(c).id, c.req.param('id'));
    return json<FriendResponse>(200, { friend });
  });

  app.delete('/friends/:id', ulidParam, auth, async (c) => {
    await readJsonBody(c, false);
    service.removeFriend(accountOf(c).id, c.req.param('id'));
    return noContent();
  });

  app.notFound(() => errorResponse(new LobbyError('not_found', 'not found')));

  app.onError((err) => {
    if (err instanceof LobbyError) {
      if (err.status >= 500) console.error('[conduit/lobby]', err);
      return errorResponse(err);
    }
    console.error('[conduit/lobby] unhandled error:', err);
    return json<ErrorResponse>(500, { error: 'internal', message: 'internal error' });
  });

  return app;
}

/**
 * The public WebSocket origin for `wsUrl`: `publicWsBase` (trailing slash stripped) when set;
 * otherwise `wss` when the proxy says https (with `trustProxy`) or the socket is TLS, else `ws`,
 * with the forwarded host (with `trustProxy`), the `Host` header, or the request URL's host.
 */
export function deriveWsBase(c: Context<LobbyEnv>, opts: LobbyRouteOptions): string {
  if (opts.publicWsBase) return opts.publicWsBase.replace(/\/+$/, '');
  const forwardedProto = opts.trustProxy
    ? firstListEntry(c.req.header('X-Forwarded-Proto'))?.toLowerCase()
    : undefined;
  const proto = forwardedProto === 'https' || envOf(c)?.encrypted === true ? 'wss' : 'ws';
  const forwardedHost = opts.trustProxy
    ? firstListEntry(c.req.header('X-Forwarded-Host'))
    : undefined;
  return `${proto}://${forwardedHost || hostOf(c)}`;
}

/**
 * The JSON object body, or `undefined` when the body is empty and `required` is false. A non-empty
 * body must be `Content-Type: application/json` (with `SameSite=Lax`, the CSRF defence of
 * docs/host.md section 3), at most MAX_JSON_BODY_BYTES, and parse to a plain object; otherwise
 * `400 validation`. The service validates the fields.
 */
async function readJsonBody(c: LobbyContext, required: true): Promise<Record<string, unknown>>;
async function readJsonBody(
  c: LobbyContext,
  required: false,
): Promise<Record<string, unknown> | undefined>;
async function readJsonBody(
  c: LobbyContext,
  required: boolean,
): Promise<Record<string, unknown> | undefined> {
  const raw = await readBodyText(c.req.raw);
  if (raw.length === 0) {
    if (required) throw invalidBody();
    return undefined;
  }
  const mediaType = c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase();
  if (mediaType !== 'application/json') {
    throw new LobbyError('validation', 'Content-Type must be application/json');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidBody();
  }
  if (!isPlainObject(parsed)) throw invalidBody();
  return parsed;
}

/** Reads the body as UTF-8 text, refusing more than MAX_JSON_BODY_BYTES without buffering them. */
async function readBodyText(request: Request): Promise<string> {
  const declared = Number(request.headers.get('Content-Length') ?? 0);
  if (declared > MAX_JSON_BODY_BYTES) throw bodyTooLarge();
  if (request.body === null) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_JSON_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw bodyTooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidBody(): LobbyError {
  return new LobbyError('validation', 'invalid JSON body');
}

function bodyTooLarge(): LobbyError {
  return new LobbyError('validation', `request body exceeds ${MAX_JSON_BODY_BYTES} bytes`);
}

function accountOf(c: LobbyContext): Account {
  const account = c.get('account');
  if (account === undefined) throw new LobbyError('unauthorized', 'login required');
  return account;
}

function sessionCookie(c: LobbyContext): string | undefined {
  return parseCookies(c.req.header('Cookie')).get(COOKIE_NAME);
}

function secureCookies(c: LobbyContext, opts: LobbyRouteOptions): boolean {
  return opts.secureCookies ?? !isLocalhost(hostOf(c));
}

/** The `Host` header, or the request URL's host when the header is absent (`app.request`). */
function hostOf(c: LobbyContext): string {
  return c.req.header('Host') || new URL(c.req.url).host;
}

/** Rate-limit key: the first `X-Forwarded-For` entry with `trustProxy`, else the socket address. */
function clientIp(c: LobbyContext, opts: LobbyRouteOptions): string {
  const forwarded = opts.trustProxy ? firstListEntry(c.req.header('X-Forwarded-For')) : undefined;
  return forwarded || envOf(c)?.remoteAddress || 'unknown';
}

/** `c.env` is undefined when a test calls `app.request` without bindings. */
function envOf(c: LobbyContext): LobbyEnv['Bindings'] | undefined {
  const env: LobbyEnv['Bindings'] | undefined = c.env;
  return env;
}

function firstListEntry(header: string | undefined): string | undefined {
  const first = header?.split(',')[0]?.trim();
  return first === '' ? undefined : first;
}

function json<T>(status: number, body: T, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': JSON_CONTENT_TYPE, ...headers },
  });
}

function noContent(headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 204, headers });
}

function errorResponse(err: LobbyError, headers: Record<string, string> = {}): Response {
  const body: ErrorResponse = { error: err.code, message: err.message };
  if (err.field !== undefined) body.field = err.field;
  return json(err.status, body, headers);
}
