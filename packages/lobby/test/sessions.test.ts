import { TOKEN_TTL_S, verifyToken } from '@conduit/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  INVITE_CODE_RE,
  LobbyError,
  MAX_SESSIONS_PER_OWNER,
  SESSION_TRANSITIONS,
  assertTransition,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type ErrorResponse,
  type JoinResponse,
  type SessionSummary,
  type Visibility,
} from '../src/index.ts';
import {
  SECRET,
  addAccount,
  befriend,
  call,
  createHarness,
  nodeSqliteSkipReason,
  type LobbyHarness,
} from './helpers.ts';

const skipReason = nodeSqliteSkipReason();

describe.skipIf(skipReason !== null)('sessions', () => {
  let h: LobbyHarness;

  beforeEach(() => {
    h = createHarness();
  });

  afterEach(() => {
    h.close();
  });

  async function create(
    cookie: string,
    input: Partial<CreateSessionRequest> = {},
  ): Promise<CreateSessionResponse> {
    h.clock.now += 1;
    const res = await call<CreateSessionResponse>(h.app, 'POST', '/sessions', {
      cookie,
      body: { gameId: 'sandbox', name: 'Session', visibility: 'private', maxPlayers: 4, ...input },
    });
    if (res.status !== 201) throw new Error(`create: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }

  function join(cookie: string, id: string, body?: unknown, headers?: Record<string, string>) {
    h.clock.now += 1;
    return call<JoinResponse & ErrorResponse>(h.app, 'POST', `/sessions/${id}/join`, {
      cookie,
      ...(body === undefined ? {} : { body }),
      ...(headers === undefined ? {} : { headers }),
    });
  }

  function list(cookie: string, query = '') {
    return call<SessionSummary[]>(h.app, 'GET', `/sessions${query}`, { cookie });
  }

  function state(id: string): string {
    return String(h.db.prepare('SELECT state FROM sessions WHERE id = ?').get(id)?.['state']);
  }

  function lastActive(id: string): number {
    return Number(
      h.db.prepare('SELECT last_active_at FROM sessions WHERE id = ?').get(id)?.['last_active_at'],
    );
  }

  function memberIds(id: string): string[] {
    return h.db
      .prepare('SELECT account_id FROM session_members WHERE session_id = ? ORDER BY joined_at')
      .all(id)
      .map((row) => String(row['account_id']));
  }

  function setInviteCode(id: string, code: string): void {
    h.db.prepare('UPDATE sessions SET invite_code = ? WHERE id = ?').run(code, id);
  }

  describe('create', () => {
    it('returns 201 with the owner as the only member and an 8-char invite code', async () => {
      const alice = addAccount(h, 'alice', 'Alice');
      h.clock.now += 10;
      const res = await call<CreateSessionResponse>(h.app, 'POST', '/sessions', {
        cookie: alice.cookie,
        body: { gameId: 'sandbox', name: '  Friday night  ', visibility: 'public', maxPlayers: 3 },
      });
      expect(res.status).toBe(201);
      const { session, inviteCode } = res.body;
      expect(inviteCode).toMatch(INVITE_CODE_RE);
      expect(session).toEqual({
        id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
        gameId: 'sandbox',
        name: 'Friday night',
        ownerId: alice.account.id,
        visibility: 'public',
        maxPlayers: 3,
        state: 'created',
        memberCount: 1,
        members: [
          { id: alice.account.id, username: 'alice', displayName: 'Alice', joinedAt: h.clock.now },
        ],
        createdAt: h.clock.now,
        lastActiveAt: h.clock.now,
        inviteCode,
      });
      expect(memberIds(session.id)).toEqual([alice.account.id]);
      expect(h.sink.events).toEqual([
        { recipients: [alice.account.id], event: { t: 'session', session } },
      ]);
      expect(h.host.calls).toEqual([]);
      const fetched = await call<SessionSummary>(h.app, 'GET', `/sessions/${session.id}`, {
        cookie: alice.cookie,
      });
      expect(fetched.status).toBe(200);
      expect(fetched.body).toEqual(session);
    });

    it('validates every field and requires a login', async () => {
      const { cookie } = addAccount(h, 'alice');
      const base = { gameId: 'sandbox', name: 'Session', visibility: 'private', maxPlayers: 4 };
      const cases: [Record<string, unknown>, string][] = [
        [{ gameId: 'chess' }, 'gameId'],
        [{ gameId: undefined }, 'gameId'],
        [{ name: '' }, 'name'],
        [{ name: '    ' }, 'name'],
        [{ name: 'n'.repeat(49) }, 'name'],
        [{ name: 'bell\u{7}' }, 'name'],
        [{ name: 7 }, 'name'],
        [{ visibility: 'secret' }, 'visibility'],
        [{ visibility: undefined }, 'visibility'],
        [{ maxPlayers: 0 }, 'maxPlayers'],
        [{ maxPlayers: 9 }, 'maxPlayers'],
        [{ maxPlayers: 2.5 }, 'maxPlayers'],
        [{ maxPlayers: '4' }, 'maxPlayers'],
      ];
      for (const [patch, field] of cases) {
        const res = await call<ErrorResponse>(h.app, 'POST', '/sessions', {
          cookie,
          body: { ...base, ...patch },
        });
        expect(res.status, JSON.stringify(patch)).toBe(400);
        expect(res.body, JSON.stringify(patch)).toMatchObject({ error: 'validation', field });
      }
      for (const maxPlayers of [1, 8]) {
        const ok = await call(h.app, 'POST', '/sessions', {
          cookie,
          body: { ...base, name: 'n'.repeat(48), maxPlayers },
        });
        expect(ok.status).toBe(201);
      }
      expect((await call(h.app, 'POST', '/sessions', { body: base })).status).toBe(401);
      const missing = await call<ErrorResponse>(h.app, 'POST', '/sessions', { cookie });
      expect(missing.status).toBe(400);
      expect(missing.body.message).toBe('invalid JSON body');
    });

    it(`allows ${MAX_SESSIONS_PER_OWNER} open sessions per owner; the next is 409`, async () => {
      const alice = addAccount(h, 'alice');
      const bob = addAccount(h, 'bob');
      const ids: string[] = [];
      for (let i = 0; i < MAX_SESSIONS_PER_OWNER; i++)
        ids.push((await create(alice.cookie)).session.id);
      const res = await call<ErrorResponse>(h.app, 'POST', '/sessions', {
        cookie: alice.cookie,
        body: { gameId: 'sandbox', name: 'One too many', visibility: 'public', maxPlayers: 2 },
      });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('conflict');
      await create(bob.cookie); // per owner

      const deleted = await call(h.app, 'DELETE', `/sessions/${ids[0]}`, { cookie: alice.cookie });
      expect(deleted.status).toBe(204);
      await create(alice.cookie); // archived sessions do not count
    });
  });

  describe('visibility', () => {
    it('lists public sessions for strangers, friends sessions for accepted friends, own and member sessions always', async () => {
      const owner = addAccount(h, 'owner');
      const friend = addAccount(h, 'friend');
      const pending = addAccount(h, 'pending');
      const stranger = addAccount(h, 'stranger');
      const member = addAccount(h, 'member');
      befriend(h, owner.account.id, friend.account.id);
      const [low, high] = [owner.account.id, pending.account.id].sort();
      h.db
        .prepare(
          "INSERT INTO friends (account_id, friend_id, status, requested_by, created_at) VALUES (?, ?, 'pending', ?, 1)",
        )
        .run(low ?? '', high ?? '', owner.account.id);

      const priv = await create(owner.cookie, { name: 'Private' });
      const friends = await create(owner.cookie, { name: 'Friends', visibility: 'friends' });
      const pub = await create(owner.cookie, { name: 'Public', visibility: 'public' });
      expect(
        (await join(member.cookie, priv.session.id, { inviteCode: priv.inviteCode })).status,
      ).toBe(200);

      const names = (sessions: SessionSummary[]) => sessions.map((s) => s.name);
      const codes = (sessions: SessionSummary[]) => sessions.map((s) => s.inviteCode ?? null);

      const strangerView = (await list(stranger.cookie)).body;
      expect(names(strangerView)).toEqual(['Public']);
      expect(codes(strangerView)).toEqual([null]);
      expect(names((await list(pending.cookie)).body)).toEqual(['Public']);
      const friendView = (await list(friend.cookie)).body;
      expect(names(friendView)).toEqual(['Public', 'Friends']);
      expect(codes(friendView)).toEqual([null, null]);
      // The member's join made Private the most recently active.
      const ownerView = (await list(owner.cookie)).body;
      expect(names(ownerView)).toEqual(['Private', 'Public', 'Friends']);
      expect(codes(ownerView)).toEqual([priv.inviteCode, pub.inviteCode, friends.inviteCode]);
      const memberView = (await list(member.cookie)).body;
      expect(names(memberView)).toEqual(['Private', 'Public']);
      expect(codes(memberView)).toEqual([priv.inviteCode, null]);

      expect(names((await list(owner.cookie, '?gameId=sandbox')).body)).toHaveLength(3);
      expect((await list(owner.cookie, '?gameId=chess')).body).toEqual([]);
      expect(names((await list(owner.cookie, '?gameId=')).body)).toHaveLength(3);
      expect((await call(h.app, 'GET', '/sessions')).status).toBe(401);

      const get = (cookie: string, id: string) => call(h.app, 'GET', `/sessions/${id}`, { cookie });
      expect((await get(stranger.cookie, priv.session.id)).status).toBe(404);
      expect((await get(stranger.cookie, friends.session.id)).status).toBe(404);
      expect((await get(stranger.cookie, pub.session.id)).status).toBe(200);
      expect((await get(friend.cookie, friends.session.id)).status).toBe(200);
      expect((await get(pending.cookie, friends.session.id)).status).toBe(404);
      expect((await get(member.cookie, priv.session.id)).status).toBe(200);
    });

    it('answers a malformed :id with 404 before authenticating or querying', async () => {
      const { cookie } = addAccount(h, 'alice');
      const authenticate = vi.spyOn(h.service, 'authenticate');
      const getSession = vi.spyOn(h.service, 'getSession');
      for (const [method, path] of [
        ['GET', '/sessions/not-a-ulid'],
        ['GET', `/sessions/${'0'.repeat(25)}`],
        ['GET', `/sessions/${'0'.repeat(25)}u`],
        ['POST', '/sessions/nope/join'],
        ['POST', '/sessions/nope/leave'],
        ['DELETE', '/sessions/nope'],
        ['POST', '/friends/nope/accept'],
        ['DELETE', '/friends/nope'],
      ] as const) {
        const res = await call<ErrorResponse>(h.app, method, path, { cookie });
        expect(res.status, path).toBe(404);
        expect(res.body.error).toBe('not_found');
      }
      expect(authenticate).not.toHaveBeenCalled();
      expect(getSession).not.toHaveBeenCalled();
      const unknown = await call(h.app, 'GET', `/sessions/${'0'.repeat(26)}`, { cookie });
      expect(unknown.status).toBe(404);
    });
  });

  describe('join', () => {
    it('requires the invite code for a session the caller cannot see', async () => {
      const owner = addAccount(h, 'owner');
      const guest = addAccount(h, 'guest', 'Guest Star');
      const { session } = await create(owner.cookie);
      setInviteCode(session.id, 'B0C1D0F1');

      const noCode = await join(guest.cookie, session.id);
      expect(noCode.status).toBe(403);
      expect(noCode.body.error).toBe('bad_invite');
      expect((await join(guest.cookie, session.id, {})).status).toBe(403);
      expect((await join(guest.cookie, session.id, { inviteCode: 'B0C1D0F2' })).status).toBe(403);
      expect((await join(guest.cookie, session.id, { inviteCode: 'bad code' })).status).toBe(403);
      expect((await join(guest.cookie, session.id, { inviteCode: 12345678 })).status).toBe(403);
      expect(h.host.calls).toEqual([]);
      expect(memberIds(session.id)).toEqual([owner.account.id]);

      const res = await join(guest.cookie, session.id, { inviteCode: ' boclDoFi ' });
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['token', 'wsUrl']);
      expect(res.body.wsUrl).toBe(`ws://localhost/session/${session.id}`);
      const nowS = Math.floor(h.clock.now / 1000);
      expect(verifyToken(res.body.token, SECRET, nowS)).toEqual({
        accountId: guest.account.id,
        displayName: 'Guest Star',
        sessionId: session.id,
        exp: nowS + TOKEN_TTL_S,
      });
      expect(verifyToken(res.body.token, SECRET, nowS + TOKEN_TTL_S)).toBeNull();
      expect(memberIds(session.id)).toEqual([owner.account.id, guest.account.id]);
    });

    it('lets public sessions, the owner and accepted friends join without a code', async () => {
      const owner = addAccount(h, 'owner');
      const friend = addAccount(h, 'friend');
      const stranger = addAccount(h, 'stranger');
      befriend(h, owner.account.id, friend.account.id);
      const pub = await create(owner.cookie, { visibility: 'public' });
      const friends = await create(owner.cookie, { visibility: 'friends' });
      const priv = await create(owner.cookie, { visibility: 'private' });
      expect((await join(stranger.cookie, pub.session.id)).status).toBe(200);
      expect((await join(stranger.cookie, friends.session.id)).status).toBe(403);
      expect(
        (await join(friend.cookie, friends.session.id, { inviteCode: 'ignored!' })).status,
      ).toBe(200);
      expect((await join(friend.cookie, priv.session.id)).status).toBe(403);
      expect((await join(owner.cookie, priv.session.id)).status).toBe(200);
    });

    it('derives wsUrl from Host, trusted proxy headers, TLS or publicWsBase', async () => {
      const owner = addAccount(h, 'owner');
      const { session } = await create(owner.cookie, { visibility: 'public' });
      const path = `/session/${session.id}`;
      const proxyHeaders = { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'edge.example.com' };

      expect(
        (await join(owner.cookie, session.id, undefined, { Host: 'play.example.com:8080' })).body
          .wsUrl,
      ).toBe(`ws://play.example.com:8080${path}`);
      expect((await join(owner.cookie, session.id, undefined, proxyHeaders)).body.wsUrl).toBe(
        `ws://localhost${path}`,
      );
      const encrypted = await h.app.request(
        `/sessions/${session.id}/join`,
        {
          method: 'POST',
          headers: { Cookie: `conduit_sid=${owner.cookie}`, Host: 'secure.example.com' },
        },
        { remoteAddress: '192.0.2.1', encrypted: true },
      );
      expect(((await encrypted.json()) as JoinResponse).wsUrl).toBe(
        `wss://secure.example.com${path}`,
      );

      for (const [routes, headers, expected] of [
        [{ trustProxy: true }, proxyHeaders, `wss://edge.example.com${path}`],
        [{ trustProxy: true }, { 'X-Forwarded-Proto': 'https, http' }, `wss://localhost${path}`],
        [{ trustProxy: true }, { 'X-Forwarded-Proto': 'http' }, `ws://localhost${path}`],
        [
          { publicWsBase: 'wss://play.example.com/' },
          proxyHeaders,
          `wss://play.example.com${path}`,
        ],
        [{ publicWsBase: 'ws://127.0.0.1:9000' }, {}, `ws://127.0.0.1:9000${path}`],
      ] as const) {
        const other = createHarness({ routes });
        try {
          const account = addAccount(other, 'owner');
          const created = await call<CreateSessionResponse>(other.app, 'POST', '/sessions', {
            cookie: account.cookie,
            body: { gameId: 'sandbox', name: 'S', visibility: 'public', maxPlayers: 2 },
          });
          const res = await call<JoinResponse>(
            other.app,
            'POST',
            `/sessions/${created.body.session.id}/join`,
            { cookie: account.cookie, headers },
          );
          expect(res.body.wsUrl.replace(created.body.session.id, session.id)).toBe(expected);
        } finally {
          other.close();
        }
      }
    });

    it('refuses a new member when full, but members rejoin without code or capacity checks', async () => {
      const owner = addAccount(h, 'owner');
      const second = addAccount(h, 'second');
      const third = addAccount(h, 'third');
      const { session, inviteCode } = await create(owner.cookie, { maxPlayers: 2 });
      expect((await join(second.cookie, session.id, { inviteCode })).status).toBe(200);
      const full = await join(third.cookie, session.id, { inviteCode });
      expect(full.status).toBe(409);
      expect(full.body.error).toBe('session_full');
      expect((await join(second.cookie, session.id)).status).toBe(200);
      expect((await join(owner.cookie, session.id)).status).toBe(200);
      expect(memberIds(session.id)).toEqual([owner.account.id, second.account.id]);
    });

    it('starts the worker on the first join only and marks the session running', async () => {
      const owner = addAccount(h, 'owner');
      const guest = addAccount(h, 'guest');
      const { session, inviteCode } = await create(owner.cookie);
      h.sink.clear();
      const first = await join(owner.cookie, session.id);
      expect(first.status).toBe(200);
      expect(h.host.calls).toEqual([{ op: 'start', sessionId: session.id, gameId: 'sandbox' }]);
      expect(h.host.capacities.get(session.id)).toBe(4);
      expect(state(session.id)).toBe('running');
      expect((await join(guest.cookie, session.id, { inviteCode })).status).toBe(200);
      expect(h.host.callsOf('start')).toHaveLength(1);
      expect(lastActive(session.id)).toBe(h.clock.now);

      const events = h.sink.events.map(({ recipients, event }) => ({
        recipients,
        t: event.t,
        state: event.t === 'session' ? event.session.state : null,
        members: event.t === 'session' ? event.session.memberCount : null,
        code: event.t === 'session' ? event.session.inviteCode : null,
      }));
      expect(events).toEqual([
        {
          recipients: [owner.account.id],
          t: 'session',
          state: 'running',
          members: 1,
          code: inviteCode,
        },
        {
          recipients: [owner.account.id, guest.account.id],
          t: 'session',
          state: 'running',
          members: 2,
          code: inviteCode,
        },
      ]);
    });

    it('answers a failed start with 500 and changes nothing', async () => {
      const owner = addAccount(h, 'owner');
      const guest = addAccount(h, 'guest');
      const { session, inviteCode } = await create(owner.cookie);
      const before = lastActive(session.id);
      h.host.failNextStart();
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const res = await join(guest.cookie, session.id, { inviteCode });
      error.mockRestore();
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'internal', message: 'the session failed to start' });
      expect(memberIds(session.id)).toEqual([owner.account.id]);
      expect(state(session.id)).toBe('created');
      expect(lastActive(session.id)).toBe(before);

      expect((await join(guest.cookie, session.id, { inviteCode })).status).toBe(200);
      expect(state(session.id)).toBe('running');
      expect(h.host.callsOf('start')).toHaveLength(2);
    });

    it('restarts an idle session, and a running one whose worker is gone', async () => {
      const owner = addAccount(h, 'owner');
      const { session } = await create(owner.cookie, { visibility: 'public' });
      await join(owner.cookie, session.id);
      h.sink.clear();

      h.service.markIdle(session.id);
      expect(state(session.id)).toBe('idle');
      expect(h.sink.events).toHaveLength(1);
      expect(h.sink.events[0]?.event).toMatchObject({ t: 'session', session: { state: 'idle' } });
      h.service.markIdle(session.id); // not running: no-op
      expect(h.sink.events).toHaveLength(1);

      h.host.running.delete(session.id);
      expect((await join(owner.cookie, session.id)).status).toBe(200);
      expect(h.host.callsOf('start')).toHaveLength(2);
      expect(state(session.id)).toBe('running');

      h.host.running.delete(session.id); // crashed; the host has not reported it yet
      expect((await join(owner.cookie, session.id)).status).toBe(200);
      expect(h.host.callsOf('start')).toHaveLength(3);
      expect(state(session.id)).toBe('running');
    });

    it('touches a running session on every later join (restarting its idle timer), never one it starts', async () => {
      const owner = addAccount(h, 'owner');
      const guest = addAccount(h, 'guest');
      const stranger = addAccount(h, 'stranger');
      const { session, inviteCode } = await create(owner.cookie, { maxPlayers: 2 });
      const touches = () => h.host.callsOf('touch');

      expect((await join(owner.cookie, session.id)).status).toBe(200);
      expect(h.host.calls).toEqual([{ op: 'start', sessionId: session.id, gameId: 'sandbox' }]);
      expect(h.host.capacities.get(session.id)).toBe(2);

      // Running: a new member and a rejoin each touch it instead of starting it.
      expect((await join(guest.cookie, session.id, { inviteCode })).status).toBe(200);
      expect((await join(owner.cookie, session.id)).status).toBe(200);
      expect(touches()).toEqual([
        { op: 'touch', sessionId: session.id },
        { op: 'touch', sessionId: session.id },
      ]);
      expect(h.host.callsOf('start')).toHaveLength(1);

      // A refused join touches nothing.
      expect((await join(stranger.cookie, session.id)).status).toBe(403);
      expect((await join(stranger.cookie, session.id, { inviteCode })).status).toBe(409);
      expect(touches()).toHaveLength(2);

      // Idle, or its worker gone: started again, not touched.
      h.service.markIdle(session.id);
      h.host.running.delete(session.id);
      expect((await join(guest.cookie, session.id)).status).toBe(200);
      h.host.running.delete(session.id);
      expect((await join(guest.cookie, session.id)).status).toBe(200);
      expect(h.host.callsOf('start')).toHaveLength(3);
      expect(touches()).toHaveLength(2);
    });

    it('markRunning moves created and idle sessions to running and emits', async () => {
      const owner = addAccount(h, 'owner');
      const { session } = await create(owner.cookie);
      h.sink.clear();
      h.service.markIdle(session.id);
      expect(state(session.id)).toBe('created');
      h.service.markRunning(session.id);
      expect(state(session.id)).toBe('running');
      h.service.markRunning(session.id);
      h.service.markIdle(session.id);
      h.service.markRunning(session.id);
      expect(state(session.id)).toBe('running');
      expect(
        h.sink.events.map((e) => (e.event.t === 'session' ? e.event.session.state : null)),
      ).toEqual(['running', 'idle', 'running']);
      h.service.markIdle('01J00000000000000000000000'); // unknown id: ignored
    });

    it('does not admit a join whose session was deleted while its worker started', async () => {
      const owner = addAccount(h, 'owner');
      const guest = addAccount(h, 'guest');
      const { session } = await create(owner.cookie, { visibility: 'public' });
      const pending = h.host.holdNextStart();
      const joining = join(guest.cookie, session.id);
      await vi.waitFor(() => expect(h.host.callsOf('start')).toHaveLength(1));
      expect(
        (await call(h.app, 'DELETE', `/sessions/${session.id}`, { cookie: owner.cookie })).status,
      ).toBe(204);
      pending.release();
      const res = await joining;
      expect(res.status).toBe(404);
      expect(memberIds(session.id)).toEqual([owner.account.id]);
      expect(h.host.callsOf('stop')).toEqual([
        { op: 'stop', sessionId: session.id, close: { code: 4106, reason: 'session_deleted' } },
        { op: 'stop', sessionId: session.id, close: { code: 4106, reason: 'session_deleted' } },
      ]);
      expect(h.host.isRunning(session.id)).toBe(false);
    });

    it('re-checks capacity after waiting for the worker', async () => {
      const owner = addAccount(h, 'owner');
      const a = addAccount(h, 'a');
      const b = addAccount(h, 'b');
      const { session } = await create(owner.cookie, { visibility: 'public', maxPlayers: 2 });
      const pending = h.host.holdNextStart();
      const first = join(a.cookie, session.id);
      await vi.waitFor(() => expect(h.host.callsOf('start')).toHaveLength(1));
      const second = join(b.cookie, session.id);
      await vi.waitFor(() => expect(h.host.callsOf('start')).toHaveLength(2));
      pending.release();
      const statuses = [(await first).status, (await second).status].sort();
      expect(statuses).toEqual([200, 409]);
      expect(memberIds(session.id)).toHaveLength(2);
    });
  });

  describe('leave and delete', () => {
    it('leave removes the member, disconnects them with 4105 and updates last_active_at', async () => {
      const owner = addAccount(h, 'owner');
      const guest = addAccount(h, 'guest');
      const { session, inviteCode } = await create(owner.cookie);
      await join(guest.cookie, session.id, { inviteCode });
      h.sink.clear();
      h.clock.now += 1000;
      const res = await call(h.app, 'POST', `/sessions/${session.id}/leave`, {
        cookie: guest.cookie,
      });
      expect(res.status).toBe(204);
      expect(memberIds(session.id)).toEqual([owner.account.id]);
      expect(lastActive(session.id)).toBe(h.clock.now);
      expect(h.host.callsOf('disconnect')).toEqual([
        {
          op: 'disconnect',
          sessionId: session.id,
          accountId: guest.account.id,
          code: 4105,
          reason: 'left',
        },
      ]);
      expect(h.sink.events.map((e) => e.recipients)).toEqual([
        [owner.account.id],
        [guest.account.id],
      ]);
      const [toOwner, toLeaver] = h.sink.events.map((e) =>
        e.event.t === 'session' ? e.event.session : null,
      );
      expect(toOwner?.inviteCode).toBe(inviteCode);
      expect(toOwner?.memberCount).toBe(1);
      expect(toLeaver?.inviteCode).toBeUndefined();

      const again = await call<ErrorResponse>(h.app, 'POST', `/sessions/${session.id}/leave`, {
        cookie: guest.cookie,
      });
      expect(again.status).toBe(404);
      expect((await join(guest.cookie, session.id)).status).toBe(403); // needs the code again
    });

    it('lets the owner leave without losing ownership or visibility', async () => {
      const owner = addAccount(h, 'owner');
      const { session, inviteCode } = await create(owner.cookie);
      expect(
        (await call(h.app, 'POST', `/sessions/${session.id}/leave`, { cookie: owner.cookie }))
          .status,
      ).toBe(204);
      const view = await call<SessionSummary>(h.app, 'GET', `/sessions/${session.id}`, {
        cookie: owner.cookie,
      });
      expect(view.body).toMatchObject({ ownerId: owner.account.id, memberCount: 0, inviteCode });
      expect(h.sink.events.at(-1)?.recipients).toEqual([owner.account.id]);
      expect((await join(owner.cookie, session.id)).status).toBe(200);
    });

    it('only the owner deletes; deletion stops the worker with 4106, archives, and keeps members', async () => {
      const owner = addAccount(h, 'owner');
      const guest = addAccount(h, 'guest');
      const { session, inviteCode } = await create(owner.cookie);
      await join(guest.cookie, session.id, { inviteCode });

      const forbidden = await call<ErrorResponse>(h.app, 'DELETE', `/sessions/${session.id}`, {
        cookie: guest.cookie,
      });
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.error).toBe('forbidden');
      expect(state(session.id)).toBe('running');

      h.sink.clear();
      h.clock.now += 500;
      const deleted = await call(h.app, 'DELETE', `/sessions/${session.id}`, {
        cookie: owner.cookie,
      });
      expect(deleted.status).toBe(204);
      expect(h.host.callsOf('stop')).toEqual([
        { op: 'stop', sessionId: session.id, close: { code: 4106, reason: 'session_deleted' } },
      ]);
      expect(state(session.id)).toBe('archived');
      expect(lastActive(session.id)).toBe(h.clock.now);
      expect(memberIds(session.id)).toEqual([owner.account.id, guest.account.id]);
      expect(h.sink.events).toHaveLength(1);
      expect(h.sink.events[0]?.recipients).toEqual([owner.account.id, guest.account.id]);
      expect(h.sink.events[0]?.event).toMatchObject({
        t: 'session',
        session: { state: 'archived' },
      });

      expect((await join(owner.cookie, session.id)).status).toBe(404);
      expect((await join(guest.cookie, session.id)).status).toBe(404);
      expect(
        (await call(h.app, 'GET', `/sessions/${session.id}`, { cookie: owner.cookie })).status,
      ).toBe(404);
      expect(
        (await call(h.app, 'DELETE', `/sessions/${session.id}`, { cookie: owner.cookie })).status,
      ).toBe(404);
      expect(
        (await call(h.app, 'POST', `/sessions/${session.id}/leave`, { cookie: guest.cookie }))
          .status,
      ).toBe(404);
      expect((await list(owner.cookie)).body).toEqual([]);
      h.service.markIdle(session.id);
      h.service.markRunning(session.id);
      expect(state(session.id)).toBe('archived');
    });

    it('deleting a session that never ran still asks the host to stop it', async () => {
      const owner = addAccount(h, 'owner');
      const { session } = await create(owner.cookie);
      expect(
        (await call(h.app, 'DELETE', `/sessions/${session.id}`, { cookie: owner.cookie })).status,
      ).toBe(204);
      expect(h.host.callsOf('stop')).toHaveLength(1);
      expect(state(session.id)).toBe('archived');
    });

    it('a stop failure other than not_running is a 500 and leaves the session open', async () => {
      const owner = addAccount(h, 'owner');
      const { session } = await create(owner.cookie);
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const stop = vi.spyOn(h.host, 'stop');
      stop.mockRejectedValueOnce(Object.assign(new Error('not running'), { code: 'not_running' }));
      expect(
        (await call(h.app, 'DELETE', `/sessions/${session.id}`, { cookie: owner.cookie })).status,
      ).toBe(204);
      const second = await create(owner.cookie);
      stop.mockRejectedValueOnce(new Error('worker wedged'));
      const res = await call(h.app, 'DELETE', `/sessions/${second.session.id}`, {
        cookie: owner.cookie,
      });
      error.mockRestore();
      expect(res.status).toBe(500);
      expect(state(second.session.id)).toBe('created');
    });
  });

  describe('state machine', () => {
    it('has the documented transitions and rejects the others with conflict', () => {
      expect(SESSION_TRANSITIONS).toEqual({
        created: ['running', 'archived'],
        running: ['idle', 'archived'],
        idle: ['running', 'archived'],
        archived: [],
      });
      const states = Object.keys(SESSION_TRANSITIONS) as (keyof typeof SESSION_TRANSITIONS)[];
      for (const from of states) {
        for (const to of states) {
          const allowed = SESSION_TRANSITIONS[from].includes(to);
          if (allowed) expect(() => assertTransition(from, to)).not.toThrow();
          else expect(() => assertTransition(from, to), `${from} -> ${to}`).toThrow(LobbyError);
        }
      }
      try {
        assertTransition('archived', 'running');
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(LobbyError);
        expect((err as LobbyError).code).toBe('conflict');
        expect((err as LobbyError).status).toBe(409);
      }
    });
  });

  it('keeps the visibility values in the SQL in sync with the API type', async () => {
    const owner = addAccount(h, 'owner');
    for (const visibility of ['private', 'friends', 'public'] satisfies Visibility[]) {
      expect((await create(owner.cookie, { visibility })).session.visibility).toBe(visibility);
    }
  });
});
