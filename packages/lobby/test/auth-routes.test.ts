import { randomBytes, scryptSync } from 'node:crypto';
import {
  SCRYPT_MAXMEM,
  base64url,
  needsRehash,
  parsePasswordHash,
  verifyPassword,
} from '@conduit/auth';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOBBY_SESSION_TTL_MS,
  MAX_JSON_BODY_BYTES,
  hashCookieToken,
  type Account,
  type ErrorResponse,
  type GameInfo,
  type LobbyEnv,
  type MeResponse,
} from '../src/index.ts';
import {
  PASSWORD,
  SANDBOX,
  addAccount,
  call,
  cookieValue,
  createHarness,
  nodeSqliteSkipReason,
  registerAndLogin,
  type LobbyHarness,
} from './helpers.ts';

const skipReason = nodeSqliteSkipReason();

describe.skipIf(skipReason !== null)('auth routes', () => {
  let h: LobbyHarness;

  beforeEach(() => {
    h = createHarness();
  });

  afterEach(() => {
    h.close();
  });

  function storedHash(username: string): string {
    const row = h.db.prepare('SELECT password_hash FROM accounts WHERE username = ?').get(username);
    return String(row?.['password_hash']);
  }

  function loginRows(): number {
    return Number(h.db.prepare('SELECT COUNT(*) AS n FROM lobby_sessions').get()?.['n']);
  }

  describe('POST /auth/register', () => {
    it('returns 201 with the Account and no password hash', async () => {
      const res = await call<{ account: Account }>(h.app, 'POST', '/auth/register', {
        body: { username: 'Alice_1', password: PASSWORD },
      });
      expect(res.status).toBe(201);
      expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
      expect(res.setCookies).toEqual([]);
      const { account } = res.body;
      expect(Object.keys(account).sort()).toEqual(
        ['createdAt', 'displayName', 'id', 'lastLoginAt', 'username'].sort(),
      );
      expect(account.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(account).toMatchObject({
        username: 'alice_1',
        displayName: 'Alice_1',
        createdAt: h.clock.now,
        lastLoginAt: null,
      });
      expect(JSON.stringify(res.body)).not.toContain('scrypt');
      expect(await verifyPassword(PASSWORD, storedHash('alice_1'))).toBe(true);
    });

    it('trims an explicit displayName', async () => {
      const res = await call<{ account: Account }>(h.app, 'POST', '/auth/register', {
        body: { username: 'bob', password: PASSWORD, displayName: '  Bob the Builder  ' },
      });
      expect(res.status).toBe(201);
      expect(res.body.account.displayName).toBe('Bob the Builder');
    });

    it('rejects a username taken in any case with 409', async () => {
      await call(h.app, 'POST', '/auth/register', {
        body: { username: 'carol', password: PASSWORD },
      });
      const res = await call<ErrorResponse>(h.app, 'POST', '/auth/register', {
        body: { username: 'CaRoL', password: 'another password' },
      });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: 'conflict', field: 'username' });
    });

    it('maps a registration that loses a race for the username to 409', async () => {
      const [first, second] = await Promise.all([
        call(h.app, 'POST', '/auth/register', { body: { username: 'racer', password: PASSWORD } }),
        call(h.app, 'POST', '/auth/register', { body: { username: 'RACER', password: PASSWORD } }),
      ]);
      expect([first.status, second.status].sort()).toEqual([201, 409]);
    });

    it('rejects bad fields with 400 and the field name', async () => {
      const cases: [Record<string, unknown>, string][] = [
        [{ password: PASSWORD }, 'username'],
        [{ username: 'ab', password: PASSWORD }, 'username'],
        [{ username: 'a'.repeat(25), password: PASSWORD }, 'username'],
        [{ username: 'has space', password: PASSWORD }, 'username'],
        [{ username: 'dash-name', password: PASSWORD }, 'username'],
        [{ username: 42, password: PASSWORD }, 'username'],
        [{ username: 'dave' }, 'password'],
        [{ username: 'dave', password: '1234567' }, 'password'],
        [{ username: 'dave', password: 'x'.repeat(257) }, 'password'],
        [{ username: 'dave', password: 12345678 }, 'password'],
        [{ username: 'dave', password: PASSWORD, displayName: '   ' }, 'displayName'],
        [{ username: 'dave', password: PASSWORD, displayName: 'x'.repeat(33) }, 'displayName'],
        [{ username: 'dave', password: PASSWORD, displayName: 'tab\there' }, 'displayName'],
        [{ username: 'dave', password: PASSWORD, displayName: 'del\u{7F}' }, 'displayName'],
        [{ username: 'dave', password: PASSWORD, displayName: null }, 'displayName'],
      ];
      for (const [i, [body, field]] of cases.entries()) {
        const res = await call<ErrorResponse>(h.app, 'POST', '/auth/register', {
          body,
          remoteAddress: `192.0.2.${i}`, // stay under the per-IP rate limit
        });
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(res.body, JSON.stringify(body)).toMatchObject({ error: 'validation', field });
      }
      const accepted = await call(h.app, 'POST', '/auth/register', {
        body: { username: 'dave', password: '\u{E9}'.repeat(4), displayName: 'x'.repeat(32) },
      });
      expect(accepted.status).toBe(201);
    });

    it('requires a JSON object body with a JSON Content-Type', async () => {
      const invalid = { error: 'validation', message: 'invalid JSON body' };
      const json = { 'Content-Type': 'application/json' };
      expect((await call(h.app, 'POST', '/auth/register')).body).toMatchObject(invalid);
      for (const rawBody of ['{', '[]', '"alice"', 'null', '42']) {
        const res = await call(h.app, 'POST', '/auth/register', {
          rawBody,
          headers: json,
          remoteAddress: '192.0.2.77',
        });
        expect(res.status, rawBody).toBe(400);
        expect(res.body, rawBody).toMatchObject(invalid);
      }
      const form = await call<ErrorResponse>(h.app, 'POST', '/auth/register', {
        rawBody: 'username=eve&password=hunter2hunter2',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      expect(form.status).toBe(400);
      expect(form.body).toMatchObject({ error: 'validation' });
      const textPlain = await call(h.app, 'POST', '/auth/register', {
        rawBody: JSON.stringify({ username: 'eve', password: PASSWORD }),
        headers: { 'Content-Type': 'text/plain' },
      });
      expect(textPlain.status).toBe(400);
      const charset = await call(h.app, 'POST', '/auth/register', {
        rawBody: JSON.stringify({ username: 'eve', password: PASSWORD }),
        headers: { 'Content-Type': 'Application/JSON; charset=utf-8' },
      });
      expect(charset.status).toBe(201);
    });

    it('rejects a body over MAX_JSON_BODY_BYTES', async () => {
      const res = await call<ErrorResponse>(h.app, 'POST', '/auth/register', {
        body: { username: 'frank', password: PASSWORD, padding: 'x'.repeat(MAX_JSON_BODY_BYTES) },
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain(String(MAX_JSON_BODY_BYTES));
      const streamed = await h.app.request(
        '/auth/register',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(16_384).fill(0x20));
            },
          }),
          duplex: 'half',
        } as RequestInit,
        { remoteAddress: '192.0.2.99' },
      );
      expect(streamed.status).toBe(400);
    });
  });

  describe('POST /auth/login', () => {
    it('sets the login cookie without Secure for localhost and returns the Account', async () => {
      const registered = await call<{ account: Account }>(h.app, 'POST', '/auth/register', {
        body: { username: 'alice', password: PASSWORD },
      });
      h.clock.now += 5000;
      const res = await call<{ account: Account }>(h.app, 'POST', '/auth/login', {
        body: { username: 'ALICE', password: PASSWORD },
        headers: { Host: 'localhost:8080' },
      });
      expect(res.status).toBe(200);
      expect(res.body.account).toEqual({ ...registered.body.account, lastLoginAt: h.clock.now });
      expect(res.setCookies).toHaveLength(1);
      const [header = ''] = res.setCookies;
      expect(header).toMatch(
        /^conduit_sid=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/,
      );
      const cookie = cookieValue(res.setCookies) ?? '';
      const row = h.db
        .prepare('SELECT account_id, created_at, expires_at FROM lobby_sessions WHERE token = ?')
        .get(hashCookieToken(cookie));
      expect(row).toEqual({
        account_id: registered.body.account.id,
        created_at: h.clock.now,
        expires_at: h.clock.now + LOBBY_SESSION_TTL_MS,
      });
      expect(
        h.db.prepare('SELECT 1 FROM lobby_sessions WHERE token = ?').get(cookie),
      ).toBeUndefined(); // only the hash is stored
      const stored = h.db
        .prepare('SELECT last_login_at FROM accounts WHERE id = ?')
        .get(registered.body.account.id);
      expect(stored?.['last_login_at']).toBe(h.clock.now);
    });

    it('marks the cookie Secure for other hosts unless secureCookies says otherwise', async () => {
      await call(h.app, 'POST', '/auth/register', {
        body: { username: 'alice', password: PASSWORD },
      });
      const login = (headers: Record<string, string>) =>
        call(h.app, 'POST', '/auth/login', {
          body: { username: 'alice', password: PASSWORD },
          headers,
        });
      expect((await login({ Host: 'play.example.com' })).setCookies[0]).toMatch(/; Secure$/);
      expect((await login({ Host: '127.0.0.1:8080' })).setCookies[0]).not.toContain('Secure');
      expect((await login({ Host: '[::1]:8080' })).setCookies[0]).not.toContain('Secure');
      expect((await login({})).setCookies[0]).not.toContain('Secure'); // app.request: http://localhost

      const forced = createHarness({ routes: { secureCookies: true } });
      const relaxed = createHarness({ routes: { secureCookies: false } });
      try {
        for (const [harness, secure] of [
          [forced, true],
          [relaxed, false],
        ] as const) {
          await call(harness.app, 'POST', '/auth/register', {
            body: { username: 'alice', password: PASSWORD },
          });
          const res = await call(harness.app, 'POST', '/auth/login', {
            body: { username: 'alice', password: PASSWORD },
            headers: { Host: secure ? 'localhost:8080' : 'play.example.com' },
          });
          expect(res.setCookies[0]?.endsWith('; Secure')).toBe(secure);
        }
      } finally {
        forced.close();
        relaxed.close();
      }
    });

    it('answers every credential failure with the same 401 and no cookie', async () => {
      await call(h.app, 'POST', '/auth/register', {
        body: { username: 'alice', password: PASSWORD },
      });
      const attempts = [
        { username: 'alice', password: 'wrong password' },
        { username: 'nobody', password: PASSWORD },
        { username: 'alice', password: 'short' },
        { username: 'alice', password: 'x'.repeat(300) },
        { username: 'not a valid name!', password: PASSWORD },
      ];
      for (const body of attempts) {
        const res = await call<ErrorResponse>(h.app, 'POST', '/auth/login', { body });
        expect(res.status, JSON.stringify(body)).toBe(401);
        expect(res.body).toEqual({ error: 'unauthorized', message: 'invalid credentials' });
        expect(res.setCookies).toEqual([]);
      }
      expect(loginRows()).toBe(0);
    });

    it('validates only the shape of the credentials', async () => {
      const cases: [unknown, string][] = [
        [{ password: PASSWORD }, 'username'],
        [{ username: 'alice' }, 'password'],
        [{ username: 'alice', password: 12345678 }, 'password'],
      ];
      for (const [body, field] of cases) {
        const res = await call<ErrorResponse>(h.app, 'POST', '/auth/login', { body });
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ error: 'validation', field });
      }
      const notObject = await call(h.app, 'POST', '/auth/login', { body: ['alice', PASSWORD] });
      expect(notObject.status).toBe(400);
    });

    it('re-hashes a password stored with old parameters', async () => {
      await call(h.app, 'POST', '/auth/register', {
        body: { username: 'alice', password: PASSWORD },
      });
      const salt = randomBytes(16);
      const old = [
        'scrypt',
        1024,
        8,
        1,
        base64url(salt),
        base64url(scryptSync(PASSWORD, salt, 32, { N: 1024, r: 8, p: 1, maxmem: SCRYPT_MAXMEM })),
      ].join('$');
      h.db.prepare("UPDATE accounts SET password_hash = ? WHERE username = 'alice'").run(old);
      expect(needsRehash(storedHash('alice'))).toBe(true);

      const res = await call(h.app, 'POST', '/auth/login', {
        body: { username: 'alice', password: PASSWORD },
      });
      expect(res.status).toBe(200);
      const rehashed = storedHash('alice');
      expect(rehashed).not.toBe(old);
      expect(parsePasswordHash(rehashed)?.N).toBe(32768);
      expect(needsRehash(rehashed)).toBe(false);
      expect(await verifyPassword(PASSWORD, rehashed)).toBe(true);

      const again = await call(h.app, 'POST', '/auth/login', {
        body: { username: 'alice', password: PASSWORD },
      });
      expect(again.status).toBe(200);
      expect(storedHash('alice')).toBe(rehashed); // current parameters: left alone
    });

    it('returns 429 with Retry-After on the 11th attempt from one IP within a minute', async () => {
      const attempt = (remoteAddress: string) =>
        call<ErrorResponse>(h.app, 'POST', '/auth/login', {
          body: { username: 'nobody', password: 'wrong password' },
          remoteAddress,
        });
      for (let i = 0; i < 10; i++) expect((await attempt('203.0.113.5')).status).toBe(401);
      const limited = await attempt('203.0.113.5');
      expect(limited.status).toBe(429);
      expect(limited.headers.get('Retry-After')).toBe('60');
      expect(limited.body).toMatchObject({ error: 'rate_limited' });
      expect((await attempt('203.0.113.6')).status).toBe(401);
      // Register shares the per-IP bucket.
      const register = await call(h.app, 'POST', '/auth/register', {
        body: { username: 'late', password: PASSWORD },
        remoteAddress: '203.0.113.5',
      });
      expect(register.status).toBe(429);
      h.clock.now += 6000;
      expect((await attempt('203.0.113.5')).status).toBe(401);
    });

    it('keys the rate limit by X-Forwarded-For only with trustProxy', async () => {
      const attempt = (app: LobbyHarness['app'], forwardedFor: string) =>
        call(app, 'POST', '/auth/login', {
          body: { username: 'nobody', password: 'wrong password' },
          remoteAddress: '10.0.0.1',
          headers: { 'X-Forwarded-For': `${forwardedFor}, 10.0.0.1` },
        });
      for (let i = 0; i < 10; i++) await attempt(h.app, `198.51.100.${i}`);
      expect((await attempt(h.app, '198.51.100.200')).status).toBe(429);

      const proxied = createHarness({ routes: { trustProxy: true } });
      try {
        for (let i = 0; i < 10; i++)
          expect((await attempt(proxied.app, '198.51.100.1')).status).toBe(401);
        expect((await attempt(proxied.app, '198.51.100.1')).status).toBe(429);
        expect((await attempt(proxied.app, '198.51.100.2')).status).toBe(401);
      } finally {
        proxied.close();
      }
    });

    it("uses the key 'unknown' without a remote address", async () => {
      const bare = async () =>
        h.app.request('/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'nobody', password: 'wrong password' }),
        });
      for (let i = 0; i < 10; i++) expect((await bare()).status).toBe(401);
      expect((await bare()).status).toBe(429);
    });
  });

  describe('cookie authentication', () => {
    it('GET /me answers 200 with the cookie, 401 without or with a tampered one', async () => {
      const { account, cookie } = await registerAndLogin(h, 'alice');
      const me = await call<MeResponse>(h.app, 'GET', '/me', { cookie });
      expect(me.status).toBe(200);
      expect(me.body).toEqual({ account, friends: [], invites: [] });

      const missing = await call<ErrorResponse>(h.app, 'GET', '/me');
      expect(missing.status).toBe(401);
      expect(missing.body).toMatchObject({ error: 'unauthorized' });
      const flipped = (cookie[0] === 'A' ? 'B' : 'A') + cookie.slice(1);
      expect((await call(h.app, 'GET', '/me', { cookie: flipped })).status).toBe(401);
      expect((await call(h.app, 'GET', '/me', { cookie: '' })).status).toBe(401);
      expect(
        (await call(h.app, 'GET', '/me', { headers: { Cookie: `other=${cookie}` } })).status,
      ).toBe(401);
      expect(
        (
          await call(h.app, 'GET', '/me', {
            headers: { Cookie: `theme=dark; conduit_sid=${cookie}` },
          })
        ).status,
      ).toBe(200);
    });

    it('logout deletes the login, clears the cookie, and the old cookie is then rejected', async () => {
      const { cookie } = await registerAndLogin(h, 'alice');
      const second = addAccount(h, 'bob');
      const res = await call(h.app, 'POST', '/auth/logout', {
        cookie,
        headers: { Host: 'localhost:8080' },
      });
      expect(res.status).toBe(204);
      expect(res.setCookies).toEqual(['conduit_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0']);
      expect((await call(h.app, 'GET', '/me', { cookie })).status).toBe(401);
      expect((await call(h.app, 'GET', '/me', { cookie: second.cookie })).status).toBe(200);

      const anonymous = await call(h.app, 'POST', '/auth/logout', {
        headers: { Host: 'play.example.com' },
      });
      expect(anonymous.status).toBe(204);
      expect(anonymous.setCookies).toEqual([
        'conduit_sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
      ]);
      expect(loginRows()).toBe(1);
    });

    it('rejects and deletes an expired login; there is no sliding expiry', async () => {
      const { cookie } = addAccount(h, 'alice');
      h.clock.now += LOBBY_SESSION_TTL_MS - 1;
      expect((await call(h.app, 'GET', '/me', { cookie })).status).toBe(200);
      expect(loginRows()).toBe(1);
      h.clock.now += 1;
      expect((await call(h.app, 'GET', '/me', { cookie })).status).toBe(401);
      expect(loginRows()).toBe(0);
    });

    it('purgeExpired deletes only expired logins', () => {
      addAccount(h, 'alice');
      h.clock.now += 1000;
      const bob = addAccount(h, 'bob');
      h.clock.now = expiryOf(h, 'alice');
      expect(h.service.purgeExpired()).toBe(1);
      expect(h.service.purgeExpired()).toBe(0);
      expect(h.service.authenticate(bob.cookie)?.username).toBe('bob');
    });
  });

  describe('other routes', () => {
    it('GET /games lists the registry without authentication', async () => {
      const res = await call<GameInfo[]>(h.app, 'GET', '/games');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([SANDBOX]);
    });

    it('answers unknown paths with 404 not_found', async () => {
      const res = await call<ErrorResponse>(h.app, 'GET', '/nope');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'not_found', message: 'not found' });
      expect((await call(h.app, 'PUT', '/me')).status).toBe(404);
    });

    it('maps unexpected exceptions to 500 internal and logs them', async () => {
      const { cookie } = addAccount(h, 'alice');
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(h.service, 'me').mockImplementation(() => {
        throw new Error('database is on fire');
      });
      const res = await call<ErrorResponse>(h.app, 'GET', '/me', { cookie });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'internal', message: 'internal error' });
      expect(error).toHaveBeenCalled();
      error.mockRestore();
    });

    it('keeps its error mapping when mounted in a host app, without touching other routes', async () => {
      const parent = new Hono<LobbyEnv>();
      parent.get('/healthz', (c) => c.json({ ok: true }));
      parent.route('/', h.app);
      parent.post('/static/upload', (c) => c.text('static', 200)); // registered after the lobby
      parent.notFound((c) => c.text('host 404', 404));
      const { cookie } = await registerAndLogin(h, 'alice');

      expect((await call(parent, 'GET', '/healthz')).body).toEqual({ ok: true });
      expect((await call(parent, 'GET', '/me', { cookie })).status).toBe(200);
      const unauthorized = await call<ErrorResponse>(parent, 'GET', '/me');
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.body.error).toBe('unauthorized');
      const badId = await call<ErrorResponse>(parent, 'GET', '/sessions/nope', { cookie });
      expect(badId.body).toMatchObject({ error: 'not_found' });
      const validation = await call<ErrorResponse>(parent, 'POST', '/sessions', {
        cookie,
        body: { gameId: 'chess' },
      });
      expect(validation.body).toMatchObject({ error: 'validation', field: 'gameId' });
      const upload = await parent.request('/static/upload', {
        method: 'POST',
        body: 'plain text',
        headers: { 'Content-Type': 'text/plain' },
      });
      expect(await upload.text()).toBe('static');
      expect(await (await parent.request('/elsewhere')).text()).toBe('host 404');
    });
  });
});

/** When the first login of `username` expires. */
function expiryOf(h: LobbyHarness, username: string): number {
  const row = h.db
    .prepare(
      'SELECT MIN(s.expires_at) AS at FROM lobby_sessions s JOIN accounts a ON a.id = s.account_id WHERE a.username = ?',
    )
    .get(username);
  return Number(row?.['at']);
}
