import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  pairKey,
  type CreateSessionResponse,
  type ErrorResponse,
  type FriendEntry,
  type FriendResponse,
  type MeResponse,
} from '../src/index.ts';
import {
  addAccount,
  call,
  createHarness,
  nodeSqliteSkipReason,
  type LobbyHarness,
} from './helpers.ts';

const skipReason = nodeSqliteSkipReason();

describe('pairKey', () => {
  it('orders the pair', () => {
    expect(pairKey('B', 'A')).toEqual(['A', 'B']);
    expect(pairKey('A', 'B')).toEqual(['A', 'B']);
  });
});

describe.skipIf(skipReason !== null)('friends', () => {
  let h: LobbyHarness;
  let alice: ReturnType<typeof addAccount>;
  let bob: ReturnType<typeof addAccount>;
  let carol: ReturnType<typeof addAccount>;

  beforeEach(() => {
    h = createHarness();
    alice = addAccount(h, 'alice', 'Alice');
    bob = addAccount(h, 'bob', 'Bob');
    carol = addAccount(h, 'carol', 'Carol');
  });

  afterEach(() => {
    h.close();
  });

  function request(from: { cookie: string }, username: string) {
    h.clock.now += 1;
    return call<FriendResponse & ErrorResponse>(h.app, 'POST', `/friends/${username}`, {
      cookie: from.cookie,
    });
  }

  function accept(by: { cookie: string }, requesterId: string) {
    return call<FriendResponse & ErrorResponse>(h.app, 'POST', `/friends/${requesterId}/accept`, {
      cookie: by.cookie,
    });
  }

  function remove(by: { cookie: string }, otherId: string) {
    return call<ErrorResponse>(h.app, 'DELETE', `/friends/${otherId}`, { cookie: by.cookie });
  }

  async function me(who: { cookie: string }): Promise<MeResponse> {
    const res = await call<MeResponse>(h.app, 'GET', '/me', { cookie: who.cookie });
    expect(res.status).toBe(200);
    return res.body;
  }

  async function statuses(who: { cookie: string }): Promise<Record<string, FriendEntry['status']>> {
    const { friends } = await me(who);
    return Object.fromEntries(friends.map((entry) => [entry.account.username, entry.status]));
  }

  it('a request is pending_out for the sender and pending_in for the recipient', async () => {
    const res = await request(alice, 'bob');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      friend: {
        account: { id: bob.account.id, username: 'bob', displayName: 'Bob' },
        status: 'pending_out',
        since: h.clock.now,
      },
    });
    expect((await me(alice)).friends).toEqual([res.body.friend]);
    expect((await me(bob)).friends).toEqual([
      {
        account: { id: alice.account.id, username: 'alice', displayName: 'Alice' },
        status: 'pending_in',
        since: h.clock.now,
      },
    ]);
    expect(await statuses(carol)).toEqual({});
    expect(h.service.friendIds(alice.account.id)).toEqual([]);
  });

  it('accepting makes both sides accepted and friendIds symmetric', async () => {
    await request(alice, 'bob');
    const since = h.clock.now;
    h.clock.now += 100;
    const res = await accept(bob, alice.account.id);
    expect(res.status).toBe(200);
    expect(res.body.friend).toEqual({
      account: { id: alice.account.id, username: 'alice', displayName: 'Alice' },
      status: 'accepted',
      since,
    });
    expect(await statuses(alice)).toEqual({ bob: 'accepted' });
    expect(await statuses(bob)).toEqual({ alice: 'accepted' });
    expect(h.service.friendIds(alice.account.id)).toEqual([bob.account.id]);
    expect(h.service.friendIds(bob.account.id)).toEqual([alice.account.id]);
    expect(h.service.friendIds(carol.account.id)).toEqual([]);
  });

  it('a mutual request auto-accepts with 200', async () => {
    expect((await request(bob, 'alice')).status).toBe(201);
    const res = await request(alice, 'BOB');
    expect(res.status).toBe(200);
    expect(res.body.friend.status).toBe('accepted');
    expect(res.body.friend.account.id).toBe(bob.account.id);
    expect(await statuses(alice)).toEqual({ bob: 'accepted' });
    expect(await statuses(bob)).toEqual({ alice: 'accepted' });
  });

  it('only the recipient can accept, and only a pending request', async () => {
    await request(alice, 'bob');
    expect((await accept(alice, bob.account.id)).status).toBe(404); // the sender
    expect((await accept(carol, alice.account.id)).status).toBe(404); // not involved
    expect((await accept(alice, alice.account.id)).status).toBe(404); // self
    const wrong = await accept(bob, carol.account.id);
    expect(wrong.status).toBe(404);
    expect(wrong.body.error).toBe('not_found');
    expect(await statuses(bob)).toEqual({ alice: 'pending_in' });
    expect((await accept(bob, alice.account.id)).status).toBe(200);
    expect((await accept(bob, alice.account.id)).status).toBe(404); // already accepted
  });

  it('a duplicate request or a request between friends is 409', async () => {
    await request(alice, 'bob');
    const duplicate = await request(alice, 'bob');
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toBe('conflict');
    await accept(bob, alice.account.id);
    expect((await request(alice, 'bob')).status).toBe(409);
    expect((await request(bob, 'alice')).status).toBe(409);
  });

  it('rejects requests to yourself (400) and to unknown usernames (404)', async () => {
    const self = await request(alice, 'ALICE');
    expect(self.status).toBe(400);
    expect(self.body).toMatchObject({ error: 'validation', field: 'username' });
    expect((await request(alice, 'nobody')).status).toBe(404);
    expect((await request(alice, 'not%20a%20name')).status).toBe(404);
    expect((await call(h.app, 'POST', '/friends/bob')).status).toBe(401);
  });

  it('remove cancels, declines or unfriends, and is 404 without a row', async () => {
    await request(alice, 'bob');
    expect((await remove(alice, bob.account.id)).status).toBe(204); // cancel
    expect(await statuses(bob)).toEqual({});

    await request(alice, 'bob');
    expect((await remove(bob, alice.account.id)).status).toBe(204); // decline
    expect(await statuses(alice)).toEqual({});

    await request(alice, 'bob');
    await accept(bob, alice.account.id);
    expect((await remove(bob, alice.account.id)).status).toBe(204); // unfriend
    expect(await statuses(alice)).toEqual({});
    expect(h.service.friendIds(alice.account.id)).toEqual([]);

    const missing = await remove(alice, bob.account.id);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('not_found');
    expect((await remove(alice, alice.account.id)).status).toBe(404);
  });

  it('lists friends sorted by username with every status', async () => {
    const dave = addAccount(h, 'dave', 'Dave');
    await request(carol, 'alice'); // alice: pending_in
    await request(alice, 'dave'); // alice: pending_out
    await request(alice, 'bob');
    await accept(bob, alice.account.id); // alice: accepted
    const { friends } = await me(alice);
    expect(friends.map((f) => [f.account.username, f.status])).toEqual([
      ['bob', 'accepted'],
      ['carol', 'pending_in'],
      ['dave', 'pending_out'],
    ]);
    expect(friends[2]?.account).toEqual({
      id: dave.account.id,
      username: 'dave',
      displayName: 'Dave',
    });
  });

  it('shows a friends-only session in /me invites only while accepted and not a member', async () => {
    h.clock.now += 1;
    const created = await call<CreateSessionResponse>(h.app, 'POST', '/sessions', {
      cookie: alice.cookie,
      body: { gameId: 'sandbox', name: 'Friends night', visibility: 'friends', maxPlayers: 4 },
    });
    const { session } = created.body;
    const invites = async () => (await me(bob)).invites.map((s) => s.id);

    expect(await invites()).toEqual([]);
    await request(alice, 'bob');
    expect(await invites()).toEqual([]); // pending
    await accept(bob, alice.account.id);
    const [invite] = (await me(bob)).invites;
    expect(invite?.id).toBe(session.id);
    expect(invite?.inviteCode).toBeUndefined();
    expect((await me(alice)).invites).toEqual([]); // not your own sessions

    expect(
      (await call(h.app, 'POST', `/sessions/${session.id}/join`, { cookie: bob.cookie })).status,
    ).toBe(200);
    expect(await invites()).toEqual([]); // a member
    expect(
      (await call(h.app, 'POST', `/sessions/${session.id}/leave`, { cookie: bob.cookie })).status,
    ).toBe(204);
    expect(await invites()).toEqual([session.id]);

    h.clock.now += 1;
    const newer = await call<CreateSessionResponse>(h.app, 'POST', '/sessions', {
      cookie: alice.cookie,
      body: { gameId: 'sandbox', name: 'Later', visibility: 'friends', maxPlayers: 4 },
    });
    await call(h.app, 'POST', '/sessions', {
      cookie: alice.cookie,
      body: { gameId: 'sandbox', name: 'Public', visibility: 'public', maxPlayers: 4 },
    });
    expect(await invites()).toEqual([newer.body.session.id, session.id]); // newest activity first

    await remove(bob, alice.account.id);
    expect(await invites()).toEqual([]);
    await request(bob, 'alice');
    await accept(alice, bob.account.id);
    expect(await invites()).toHaveLength(2);
    await call(h.app, 'DELETE', `/sessions/${session.id}`, { cookie: alice.cookie });
    expect(await invites()).toEqual([newer.body.session.id]); // archived
  });

  it('emits friends snapshots to both parties that are online', async () => {
    h.sink.onlineIds.add(alice.account.id);
    h.sink.onlineIds.add(bob.account.id);
    await request(alice, 'bob');
    expect(h.sink.events).toEqual([
      { recipients: [alice.account.id], event: { t: 'friends', online: [] } },
      { recipients: [bob.account.id], event: { t: 'friends', online: [] } },
    ]);
    h.sink.clear();
    await accept(bob, alice.account.id);
    expect(h.sink.events).toEqual([
      { recipients: [bob.account.id], event: { t: 'friends', online: [alice.account.id] } },
      { recipients: [alice.account.id], event: { t: 'friends', online: [bob.account.id] } },
    ]);
    h.sink.clear();
    h.sink.onlineIds.delete(bob.account.id);
    await remove(alice, bob.account.id);
    expect(h.sink.events).toEqual([
      { recipients: [alice.account.id], event: { t: 'friends', online: [] } },
    ]);
  });

  it('creating a friends-only session invites the accepted friends', async () => {
    await request(alice, 'bob');
    await accept(bob, alice.account.id);
    await request(alice, 'carol'); // pending: not invited
    h.sink.clear();
    const created = await call<CreateSessionResponse>(h.app, 'POST', '/sessions', {
      cookie: alice.cookie,
      body: { gameId: 'sandbox', name: 'Friends', visibility: 'friends', maxPlayers: 4 },
    });
    expect(h.sink.events.map((e) => [e.recipients, e.event.t])).toEqual([
      [[alice.account.id], 'session'],
      [[bob.account.id], 'invite'],
    ]);
    const invite = h.sink.events[1]?.event;
    expect(invite).toMatchObject({
      t: 'invite',
      from: { id: alice.account.id, username: 'alice', displayName: 'Alice' },
      session: { id: created.body.session.id, visibility: 'friends' },
    });
    expect(invite?.t === 'invite' ? invite.session.inviteCode : 'n/a').toBeUndefined();

    h.sink.clear();
    await call(h.app, 'POST', '/sessions', {
      cookie: alice.cookie,
      body: { gameId: 'sandbox', name: 'Private', visibility: 'private', maxPlayers: 4 },
    });
    expect(h.sink.events.map((e) => e.event.t)).toEqual(['session']);
  });
});
