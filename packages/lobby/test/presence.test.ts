import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  HELLO_TIMEOUT_MS,
  MAX_PRESENCE_MESSAGE_BYTES,
  PresenceHub,
  type LobbyEvent,
  type PublicAccount,
} from '../src/index.ts';
import {
  FakeSocket,
  addAccount,
  befriend,
  createHarness,
  nodeSqliteSkipReason,
  type LobbyHarness,
} from './helpers.ts';

const skipReason = nodeSqliteSkipReason();

describe('constants', () => {
  it('match docs/host.md section 7', () => {
    expect(HELLO_TIMEOUT_MS).toBe(5_000);
    expect(HEARTBEAT_INTERVAL_MS).toBe(30_000);
    expect(HEARTBEAT_TIMEOUT_MS).toBe(60_000);
    expect(MAX_PRESENCE_MESSAGE_BYTES).toBe(4_096);
  });
});

describe.skipIf(skipReason !== null)('PresenceHub', () => {
  let h: LobbyHarness;
  let hub: PresenceHub;
  let alice: PublicAccount;
  let bob: PublicAccount;
  let carol: PublicAccount;

  beforeEach(() => {
    h = createHarness();
    hub = new PresenceHub(h.service, h.clock.hubOptions);
    h.service.attachSink(hub);
    alice = addAccount(h, 'alice', 'Alice').account;
    bob = addAccount(h, 'bob', 'Bob').account;
    carol = addAccount(h, 'carol', 'Carol').account;
  });

  afterEach(() => {
    hub.closeAll(1001, 'test over');
    h.close();
  });

  /** Attaches a socket for `account`, optionally sending `hello`, and drops what it was sent. */
  function connect(account: PublicAccount, hello = true): FakeSocket {
    const socket = new FakeSocket();
    hub.attach(socket, account);
    if (hello) socket.receive({ t: 'hello' });
    return socket;
  }

  function friendsOnline(events: LobbyEvent[]): string[][] {
    return events.flatMap((event) => (event.t === 'friends' ? [event.online] : []));
  }

  describe('connection lifecycle', () => {
    it('closes a connection that sends no hello within 5 s with 4107', () => {
      const silent = connect(alice, false);
      const polite = connect(bob);
      h.clock.advance(HELLO_TIMEOUT_MS - 1);
      expect(silent.closedWith).toBeNull();
      expect(hub.connections()).toBe(2);
      h.clock.advance(1);
      expect(silent.closedWith).toEqual({ code: 4107, reason: 'hello_timeout' });
      expect(polite.closedWith).toBeNull();
      expect(hub.connections(alice.id)).toBe(0);
      expect(hub.connections(bob.id)).toBe(1);
      silent.emit('close', 4107); // the socket's own close event later is harmless
      expect(hub.connections()).toBe(1);
    });

    it('closes with 4108 on binary, oversize, non-JSON or t-less messages', () => {
      const bad: [unknown, boolean][] = [
        [Buffer.from(JSON.stringify({ t: 'hello' })), true],
        ['not json', false],
        ['[1,2,3]', false],
        ['null', false],
        ['"hello"', false],
        [JSON.stringify({ type: 'hello' }), false],
        [JSON.stringify({ t: 42 }), false],
        [JSON.stringify({ t: 'ping', pad: 'x'.repeat(MAX_PRESENCE_MESSAGE_BYTES) }), false],
        [Buffer.from([0xff, 0xfe, 0x7b]), false],
        [42, false],
      ];
      for (const [data, isBinary] of bad) {
        const socket = connect(alice, false);
        socket.emit('message', data, isBinary);
        expect(socket.closedWith, String(data).slice(0, 40)).toEqual({
          code: 4108,
          reason: 'bad_message',
        });
        expect(socket.sent).toEqual([]);
      }
      expect(hub.connections()).toBe(0);
    });

    it('accepts text as ws delivers it: Buffer, ArrayBuffer and fragments, up to the size limit', () => {
      const socket = connect(alice, false);
      const ping = JSON.stringify({ t: 'ping' });
      socket.emit('message', Buffer.from(ping), false);
      const bytes = new TextEncoder().encode(ping);
      socket.emit(
        'message',
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        false,
      );
      socket.emit('message', [Buffer.from(ping.slice(0, 3)), Buffer.from(ping.slice(3))], false);
      const exact = JSON.stringify({ t: 'ping', pad: '' });
      socket.receive(
        JSON.stringify({ t: 'ping', pad: 'x'.repeat(MAX_PRESENCE_MESSAGE_BYTES - exact.length) }),
      );
      expect(socket.take()).toEqual([{ t: 'pong' }, { t: 'pong' }, { t: 'pong' }, { t: 'pong' }]);
      expect(socket.closedWith).toBeNull();
    });

    it('answers ping with pong, before hello too, and ignores unknown message types', () => {
      const socket = connect(alice, false);
      socket.receive({ t: 'ping' });
      expect(socket.take()).toEqual([{ t: 'pong' }]);
      socket.receive({ t: 'subscribe', topic: 'news' });
      expect(socket.take()).toEqual([]);
      expect(socket.closedWith).toBeNull();
      expect(hub.online().has(alice.id)).toBe(false);
      socket.receive({ t: 'hello' });
      socket.take();
      socket.receive({ t: 'ping' });
      expect(socket.take()).toEqual([{ t: 'pong' }]);
      h.clock.advance(HELLO_TIMEOUT_MS * 2);
      expect(socket.closedWith).toBeNull();
    });

    it('counts connections per account and removes them on close or error', () => {
      const a1 = connect(alice);
      const a2 = connect(alice, false);
      const b1 = connect(bob);
      expect(hub.connections()).toBe(3);
      expect(hub.connections(alice.id)).toBe(2);
      expect(hub.connections(carol.id)).toBe(0);
      expect([...hub.online()].sort()).toEqual([alice.id, bob.id].sort());
      a1.emit('close', 1000);
      expect(hub.connections(alice.id)).toBe(1);
      expect(hub.online().has(alice.id)).toBe(false); // a2 never said hello
      b1.emit('error');
      b1.emit('close', 1006);
      expect(hub.connections(bob.id)).toBe(0);
      a2.receive({ t: 'ping' }); // still attached
      expect(a2.take()).toEqual([{ t: 'pong' }]);
      expect(a1.take()).toEqual([{ t: 'friends', online: [] }]); // its hello snapshot
      a1.receive({ t: 'ping' }); // closed: ignored
      expect(a1.take()).toEqual([]);
    });

    it('closeAll closes every socket with the given code and stops the timers', () => {
      const sockets = [connect(alice), connect(alice, false), connect(bob)];
      expect(h.clock.pendingTimers).toBeGreaterThan(0);
      hub.closeAll(4111, 'shutting_down');
      for (const socket of sockets)
        expect(socket.closedWith).toEqual({ code: 4111, reason: 'shutting_down' });
      expect(hub.connections()).toBe(0);
      expect(hub.online().size).toBe(0);
      expect(h.clock.pendingTimers).toBe(0);
      for (const socket of sockets) {
        socket.take();
        socket.emit('close', 4111);
      }
      hub.emit([alice.id, bob.id], { t: 'pong' });
      expect(sockets.flatMap((socket) => socket.take())).toEqual([]);
    });
  });

  describe('friends presence', () => {
    it('hello yields a snapshot of the online accepted friends only', () => {
      const dave = addAccount(h, 'dave').account;
      befriend(h, alice.id, bob.id);
      befriend(h, alice.id, carol.id);
      h.service.requestFriend(dave.id, 'alice'); // pending
      connect(bob);
      connect(dave);
      const socket = connect(alice, false);
      socket.receive({ t: 'hello' });
      expect(socket.take()).toEqual([{ t: 'friends', online: [bob.id] }]);
      socket.receive({ t: 'hello' }); // a second hello resends the snapshot
      expect(socket.take()).toEqual([{ t: 'friends', online: [bob.id] }]);
    });

    it("tells online friends when an account's first connection comes online and its last goes offline", () => {
      befriend(h, alice.id, bob.id);
      const bobSocket = connect(bob);
      const stranger = connect(carol);
      bobSocket.take();
      stranger.take();

      const first = connect(alice, false);
      expect(bobSocket.take()).toEqual([]); // not online before hello
      first.receive({ t: 'hello' });
      expect(first.take()).toEqual([{ t: 'friends', online: [bob.id] }]);
      expect(bobSocket.take()).toEqual([{ t: 'friends', online: [alice.id] }]);

      const second = connect(alice);
      expect(second.take()).toEqual([{ t: 'friends', online: [bob.id] }]);
      expect(bobSocket.take()).toEqual([]);

      first.emit('close', 1000);
      expect(bobSocket.take()).toEqual([]); // alice is still online
      const unhelloed = connect(alice, false);
      second.emit('close', 1001);
      expect(bobSocket.take()).toEqual([{ t: 'friends', online: [] }]);
      unhelloed.emit('close', 1000);
      expect(bobSocket.take()).toEqual([]);
      expect(stranger.take()).toEqual([]);
    });

    it('request, accept and remove refresh both online parties', () => {
      const aliceSocket = connect(alice);
      const bobSocket = connect(bob);
      aliceSocket.take();
      bobSocket.take();
      h.service.requestFriend(alice.id, 'bob');
      expect(friendsOnline(aliceSocket.take())).toEqual([[]]);
      expect(friendsOnline(bobSocket.take())).toEqual([[]]);
      h.service.acceptFriend(bob.id, alice.id);
      expect(friendsOnline(aliceSocket.take())).toEqual([[bob.id]]);
      expect(friendsOnline(bobSocket.take())).toEqual([[alice.id]]);
      h.service.removeFriend(alice.id, bob.id);
      expect(friendsOnline(aliceSocket.take())).toEqual([[]]);
      expect(friendsOnline(bobSocket.take())).toEqual([[]]);
    });
  });

  describe('session events', () => {
    it('createSession sends session to the owner and invite to online friends for friends visibility', () => {
      befriend(h, alice.id, bob.id);
      befriend(h, alice.id, carol.id);
      const aliceSocket = connect(alice);
      const bobSocket = connect(bob);
      const bobUnhelloed = connect(bob, false);
      for (const socket of [aliceSocket, bobSocket]) socket.take();

      const { session, inviteCode } = h.service.createSession(alice.id, {
        gameId: 'sandbox',
        name: 'Friends night',
        visibility: 'friends',
        maxPlayers: 4,
      });
      expect(aliceSocket.take()).toEqual([{ t: 'session', session }]);
      const [invite] = bobSocket.take();
      expect(invite).toEqual({
        t: 'invite',
        session: { ...session, inviteCode: undefined },
        from: { id: alice.id, username: 'alice', displayName: 'Alice' },
      });
      expect(JSON.stringify(invite)).not.toContain(inviteCode);
      expect(bobUnhelloed.take()).toEqual([]);

      h.service.createSession(alice.id, {
        gameId: 'sandbox',
        name: 'Private',
        visibility: 'private',
        maxPlayers: 4,
      });
      expect(aliceSocket.take().map((e) => e.t)).toEqual(['session']);
      expect(bobSocket.take()).toEqual([]);
    });

    it('join, leave and delete send session to owner and members (and the leaver)', async () => {
      const sockets = { alice: connect(alice), bob: connect(bob), carol: connect(carol) };
      const take = () => ({
        alice: sockets.alice.take(),
        bob: sockets.bob.take(),
        carol: sockets.carol.take(),
      });
      const { session, inviteCode } = h.service.createSession(alice.id, {
        gameId: 'sandbox',
        name: 'Public',
        visibility: 'public',
        maxPlayers: 4,
      });
      take();

      await h.service.joinSession(bob.id, session.id);
      let got = take();
      expect(got.alice).toHaveLength(1);
      expect(got.bob).toEqual(got.alice);
      expect(got.alice[0]).toMatchObject({
        t: 'session',
        session: { memberCount: 2, state: 'running', inviteCode },
      });
      expect(got.carol).toEqual([]);

      h.service.leaveSession(bob.id, session.id);
      got = take();
      expect(got.alice).toEqual([
        { t: 'session', session: expect.objectContaining({ memberCount: 1, inviteCode }) },
      ]);
      expect(got.bob).toHaveLength(1);
      expect(got.bob[0]).toMatchObject({ t: 'session', session: { memberCount: 1 } });
      expect(got.bob[0]?.t === 'session' && got.bob[0].session.inviteCode).toBeUndefined();
      expect(got.carol).toEqual([]);

      await h.service.joinSession(carol.id, session.id);
      take();
      h.service.markIdle(session.id);
      got = take();
      expect(got.alice).toMatchObject([{ t: 'session', session: { state: 'idle' } }]);
      expect(got.carol).toMatchObject([{ t: 'session', session: { state: 'idle' } }]);
      expect(got.bob).toEqual([]);

      await h.service.deleteSession(alice.id, session.id);
      got = take();
      expect(got.alice).toMatchObject([{ t: 'session', session: { state: 'archived' } }]);
      expect(got.carol).toMatchObject([{ t: 'session', session: { state: 'archived' } }]);
      expect(got.bob).toEqual([]);
    });

    it('emit reaches only helloed connections and survives failing sends', () => {
      const broken = connect(alice);
      const working = connect(alice);
      const unhelloed = connect(alice, false);
      for (const socket of [broken, working, unhelloed]) socket.take();
      broken.failSends = true;
      hub.emit([alice.id, alice.id, carol.id], { t: 'pong' });
      expect(working.take()).toEqual([{ t: 'pong' }]); // once, despite the duplicate recipient
      expect(unhelloed.take()).toEqual([]);
      expect(broken.closedWith).toBeNull();
    });
  });

  describe('heartbeat', () => {
    it('pings every 30 s and terminates a connection silent for more than 60 s', () => {
      befriend(h, alice.id, bob.id);
      const bobSocket = connect(bob);
      const silent = connect(alice);
      bobSocket.take();

      h.clock.advance(HEARTBEAT_INTERVAL_MS);
      expect(silent.pings).toBe(1);
      bobSocket.receive({ t: 'ping' }); // bob stays active
      h.clock.advance(HEARTBEAT_INTERVAL_MS); // 60 s: exactly the timeout, not more
      expect(silent.terminated).toBe(false);
      expect(silent.pings).toBe(2);
      bobSocket.emit('pong');
      bobSocket.take();

      h.clock.advance(HEARTBEAT_INTERVAL_MS); // 90 s
      expect(silent.terminated).toBe(true);
      expect(bobSocket.terminated).toBe(false);
      expect(hub.connections(alice.id)).toBe(0);
      expect(bobSocket.take()).toEqual([{ t: 'friends', online: [] }]);

      h.clock.advance(HEARTBEAT_INTERVAL_MS * 3); // pongs are what keep a connection alive
      expect(bobSocket.terminated).toBe(true);
      expect(hub.connections()).toBe(0);
      expect(h.clock.pendingTimers).toBe(0); // the interval stops with the last connection
    });

    it('keeps a connection that answers pings alive', () => {
      const socket = connect(alice);
      for (let i = 0; i < 10; i++) {
        h.clock.advance(HEARTBEAT_INTERVAL_MS);
        socket.emit('pong');
      }
      expect(socket.terminated).toBe(false);
      expect(socket.pings).toBe(10);
    });
  });
});
