import { openApplicationSave } from '@conduit/persist';
import type { SessionToken } from '@conduit/auth';
import {
  CoreKind,
  ENTITY_NONE,
  FrameWriter,
  KickReason,
  PlayerState,
  RejectReason,
  type SessionStatePayload,
  WIRE_VERSION,
} from '@conduit/protocol';
import { defineSystem } from '@conduit/sim';
import { describe, expect, it, vi } from 'vitest';
import { CONN_TRANSITIONS, ConnStateError, createConn, transition } from '../src/client-conn.ts';
import { CloseCode, HANDSHAKE_TIMEOUT_MS, MAX_GAME_MESSAGES_PER_TICK } from '../src/constants.ts';
import type { PlayerInfo, PlayerSpawn } from '../src/session.ts';
import { FakeLink } from './fake-link.ts';
import {
  Chat,
  createHarness,
  type Harness,
  joinAndSpawn,
  Notice,
  payloadOf,
  type ReceivedMessage,
  Shout,
  SPAWN_REGION,
  type TestClient,
} from './harness.ts';

function players(messages: ReceivedMessage[]): SessionStatePayload['players'] {
  const states = messages.filter((m) => m.name === 'SessionState');
  const last = states.at(-1);
  if (last === undefined) throw new Error('no SessionState');
  return (last.payload as SessionStatePayload).players;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function identity(accountId: string, name = accountId): SessionToken {
  return {
    accountId,
    displayName: name,
    sessionId: 'dev',
    exp: Math.floor(Date.now() / 1000) + 600,
  };
}

describe('ClientConn transitions', () => {
  it('allows exactly the A.6 edges', () => {
    expect(CONN_TRANSITIONS).toEqual({
      handshaking: ['joined', 'closed'],
      joined: ['loading', 'closed'],
      loading: ['ready', 'closed'],
      ready: ['playing', 'closed'],
      playing: ['away', 'closed'],
      away: ['playing', 'closed'],
      closed: [],
    });
    const conn = createConn(new FakeLink(1), null, 0);
    expect(() => transition(conn, 'playing', { id: 's' })).toThrow(ConnStateError);
    expect(conn.state).toBe('handshaking');
    transition(conn, 'joined');
    transition(conn, 'closed');
    expect(() => transition(conn, 'joined')).toThrow(/closed -> joined/);
  });
});

describe('handshaking', () => {
  it('attach starts the handshake timer and sends nothing; the timer closes with 4000', async () => {
    const h = await createHarness();
    const c = h.client();
    expect(h.clock.pending()).toBe(1);
    h.clock.advance(HANDSHAKE_TIMEOUT_MS - 1);
    expect(c.link.closedWith).toBeNull();
    h.clock.advance(1);
    expect(c.link.closedWith).toEqual({
      code: CloseCode.HandshakeTimeout,
      reason: 'handshake timeout',
    });
    expect(c.take()).toEqual([]);
    c.hello(); // too late: the link is closed
    expect(c.take()).toEqual([]);
  });

  it('a message other than Hello closes with 4003', async () => {
    const h = await createHarness();
    const c = h.client();
    c.ping(5);
    expect(c.link.closedWith?.code).toBe(CloseCode.ProtocolViolation);
    expect(c.take()).toEqual([]);
    expect(h.clock.pending()).toBe(0);
  });

  it('checks the token before the protocol version', async () => {
    const h = await createHarness({ verifier: { dev: false, verify: () => null } });
    const c = h.client();
    c.hello({ protocolVersion: 99 });
    expect(c.take()[0]?.payload).toMatchObject({ reason: RejectReason.BadToken });
    expect(c.link.closedWith?.code).toBe(CloseCode.BadToken);
  });

  it('a fresh Hello sends Welcome, SessionState to all, and queues the join', async () => {
    const h = await createHarness();
    const a = h.client();
    a.hello({ displayName: 'Ada' });
    const got = a.take();
    expect(got.map((m) => m.name)).toEqual(['Welcome', 'SessionState']);
    expect(got.map((m) => m.seq)).toEqual([0, 1]);
    expect(got[0]?.payload).toMatchObject({
      playerId: 0,
      simTickRate: 60,
      snapshotEvery: 3,
      serverTick: 0,
      worldSeed: 0xc0ffee,
    });
    expect(players(got)).toEqual([
      { playerId: 0, name: 'Ada', state: PlayerState.Joined, entity: ENTITY_NONE },
    ]);
    expect(h.hooks.onPlayerJoin).not.toHaveBeenCalled();

    const b = h.client();
    b.hello({ displayName: 'Bob' });
    expect(b.names()).toEqual(['Welcome', 'SessionState']);
    const toA = a.take();
    expect(toA.map((m) => m.name)).toEqual(['SessionState']);
    expect(players(toA).map((p) => p.name)).toEqual(['Ada', 'Bob']);

    await h.step();
    expect(h.hooks.onPlayerJoin).toHaveBeenCalledTimes(2);
    expect(h.hooks.onPlayerJoin.mock.calls.map((call) => call[0].playerId)).toEqual([0, 1]);
  });

  it('Hello twice closes with 4003', async () => {
    const h = await createHarness();
    const c = h.client();
    c.hello();
    c.take();
    c.hello();
    expect(c.link.closedWith?.code).toBe(CloseCode.ProtocolViolation);
    await h.step();
    expect(h.session.players()).toEqual([]);
  });

  it('rejects with SessionFull once maxPlayers slots are taken', async () => {
    const h = await createHarness({ session: { maxPlayers: 2 } });
    h.client().hello({ displayName: 'a' });
    h.client().hello({ displayName: 'b' });
    const c = h.client();
    c.hello({ displayName: 'c' });
    expect(c.take()).toMatchObject([
      { name: 'Rejected', payload: { reason: RejectReason.SessionFull, detail: 'session full' } },
    ]);
    expect(c.link.closedWith?.code).toBe(CloseCode.SessionFull);
  });

  it('rejects identities of another session', async () => {
    const h = await createHarness({ verifier: null });
    const c = h.client({ identity: { ...identity('x'), sessionId: 'other' } });
    c.hello();
    expect(c.take()[0]?.payload).toMatchObject({ reason: RejectReason.BadToken });
    expect(c.link.closedWith?.code).toBe(CloseCode.BadToken);
  });

  it('closes a frame with the wrong wire version with 4001 and a malformed frame with 4002', async () => {
    const h = await createHarness();
    const a = h.client();
    const fw = new FrameWriter();
    fw.begin();
    const buf = fw.finish();
    buf[0] = WIRE_VERSION + 1;
    a.link.receive(buf);
    expect(a.link.closedWith?.code).toBe(CloseCode.WireVersion);
    const b = h.client();
    b.link.receive(new Uint8Array([WIRE_VERSION, 1, CoreKind.Hello, 0]));
    expect(b.link.closedWith?.code).toBe(CloseCode.MalformedFrame);
    expect(h.session.stats.badFrames).toBe(2);
  });
});

describe('joined -> loading -> ready -> playing', () => {
  it('walks the join, RegionSet, RegionLoadState and spawn rows with their messages', async () => {
    const h = await createHarness();
    const a = h.client();
    a.hello({ displayName: 'Ada' });
    a.take();
    await h.step(); // join runs; the spawn region starts loading
    expect(h.hooks.onPlayerJoin).toHaveBeenCalledTimes(1);
    expect(a.take()).toEqual([]);

    a.ready();
    const loading = a.take();
    expect(loading.map((m) => m.name)).toEqual(['RegionSet']);
    const set = payloadOf<{ active: string[]; prefetch: string[] }>(loading, 'RegionSet');
    expect(set.active).toEqual([
      'cell/0_0',
      'cell/0_1',
      'cell/0_2',
      'cell/1_0',
      'cell/1_1',
      'cell/1_2',
      'cell/2_0',
      'cell/2_1',
      'cell/2_2',
    ]);
    // The ring one step beyond wanted (depth 2), clipped to the 4 x 4 grid.
    expect(set.prefetch).toEqual([
      'cell/0_3',
      'cell/1_3',
      'cell/2_3',
      'cell/3_0',
      'cell/3_1',
      'cell/3_2',
      'cell/3_3',
    ]);

    a.regionLoadState(['cell/1_1'], set.active.slice(1));
    expect(a.take()).toEqual([]); // not everything loaded: stays loading
    expect(h.session.players()[0]?.state).toBe(PlayerState.Joined);

    a.regionLoadState(set.active);
    const ready = a.take();
    expect(ready.map((m) => m.name)).toEqual(['SessionState']);
    expect(players(ready)[0]?.state).toBe(PlayerState.Ready);

    await h.step(); // tick 2: the spawn region activates in this tick's update, so the spawn waits
    expect(a.take().map((m) => m.name)).toEqual([]);
    await h.step(); // tick 3: spawn, and tick 3 is a snapshot tick
    const spawned = a.take();
    expect(spawned.map((m) => m.name)).toEqual(['Spawned', 'SessionState', 'Snapshot']);
    const entity = (spawned[0]?.payload as { entity: number }).entity;
    expect(spawned[0]?.payload).toEqual({ playerId: 0, entity, regionId: SPAWN_REGION });
    expect(players(spawned)).toEqual([
      { playerId: 0, name: 'Ada', state: PlayerState.Playing, entity },
    ]);
    expect(h.session.world.alive(entity)).toBe(true);
    expect(spawned[2]?.payload).toMatchObject({
      header: { serverTick: 3, flags: 1, baselineTick: 0 },
    });
    expect(spawned[2]?.tick).toBe(3);
  });

  it('buffers a Ready that arrives before the join ran', async () => {
    const h = await createHarness();
    const a = h.client();
    a.hello();
    a.ready();
    expect(a.names()).toEqual(['Welcome', 'SessionState']);
    await h.step();
    expect(a.names()).toEqual(['RegionSet']);
  });

  it('sends Spawned to every conn in loading, ready and playing, not joined', async () => {
    const h = await createHarness();
    const a = h.client();
    await joinAndSpawn(h, a, 'a');
    const joined = h.client();
    joined.hello({ displayName: 'joined' });
    const loading = h.client();
    loading.hello({ displayName: 'loading' });
    await h.step();
    loading.ready();
    for (const c of [a, joined, loading]) c.take();
    const b = h.client();
    await joinAndSpawn(h, b, 'b');
    const got = (c: TestClient) => c.names().filter((n) => n === 'Spawned').length;
    expect(got(a)).toBe(1);
    expect(got(loading)).toBe(1);
    expect(got(joined)).toBe(0);
  });

  it('faults with 4012 when spawn returns an entity outside an active region', async () => {
    const onPlayerJoin = vi.fn((): PlayerSpawn => ({
      regionId: SPAWN_REGION,
      spawn: (ctx) => ctx.world.create(),
    }));
    const h = await createHarness({ hooks: { onPlayerJoin } });
    const a = h.client();
    await expect(joinAndSpawn(h, a)).rejects.toThrow(/faulted/);
    expect(a.link.closedWith?.code).toBe(CloseCode.SessionFault);
    expect(h.session.fault?.cause).toBeInstanceOf(Error);
    expect(h.session.running).toBe(false);
    expect(() => h.session.step()).toThrow('faulted');
    // Partial private state is diagnostic; running a synthetic leave cannot repair it.
    expect(h.hooks.onPlayerLeave).not.toHaveBeenCalled();
  });

  it('faults with 4012 when onPlayerJoin throws, without running leave', async () => {
    const onPlayerJoin = vi.fn((): PlayerSpawn => {
      throw new Error('no room');
    });
    const h = await createHarness({ hooks: { onPlayerJoin } });
    const a = h.client();
    a.hello();
    a.take();
    await h.step();
    expect(a.take()).toEqual([]);
    expect(a.link.closedWith?.code).toBe(CloseCode.SessionFault);
    expect(h.session.fault).toMatchObject({ system: 'onPlayerJoin', phase: 'hook' });
    expect(h.hooks.onPlayerLeave).not.toHaveBeenCalled();
  });
});

describe('leaving', () => {
  it('Leave while playing closes 1000; the leave runs next tick, frees the slot, SessionState shrinks', async () => {
    const h = await createHarness();
    const a = h.client();
    const b = h.client();
    await joinAndSpawn(h, a, 'a');
    await joinAndSpawn(h, b, 'b');
    const entityA = h.session.players()[0]?.entity as number;
    a.take();
    b.take();

    a.leave();
    expect(a.link.closedWith).toEqual({ code: CloseCode.Normal, reason: 'leave' });
    expect(h.hooks.onPlayerLeave).not.toHaveBeenCalled();
    await h.step();
    expect(h.hooks.onPlayerLeave).toHaveBeenCalledTimes(1);
    expect(h.hooks.onPlayerLeave.mock.calls[0]?.[0]).toMatchObject({
      playerId: 0,
      entity: entityA,
    });
    expect(h.session.world.alive(entityA)).toBe(false);
    expect(players(b.take()).map((p) => p.name)).toEqual(['b']);
    expect(h.session.players().map((p) => p.playerId)).toEqual([1]);

    const c = h.client();
    c.hello({ displayName: 'c' });
    expect(payloadOf<{ playerId: number }>(c.take(), 'Welcome').playerId).toBe(0);
  });

  it('a drop before spawn calls onPlayerLeave only if onPlayerJoin ran', async () => {
    const h = await createHarness();
    const early = h.client();
    early.hello({ displayName: 'early' });
    early.link.remoteClose(1006);
    await h.step();
    expect(h.hooks.onPlayerJoin).not.toHaveBeenCalled();
    expect(h.hooks.onPlayerLeave).not.toHaveBeenCalled();
    expect(h.session.players()).toEqual([]);

    for (const drop of ['close', 'leave'] as const) {
      h.hooks.onPlayerLeave.mockClear();
      const late = h.client();
      late.hello({ displayName: drop });
      await h.step(); // join ran
      late.ready(); // loading
      if (drop === 'close') late.link.remoteClose(1006);
      else late.leave();
      await h.step();
      expect(h.hooks.onPlayerLeave).toHaveBeenCalledTimes(1);
      expect(h.hooks.onPlayerLeave.mock.calls[0]?.[0]).toMatchObject({ displayName: drop });
      expect(h.session.players()).toEqual([]);
    }
  });

  it('kick sends Kicked, closes 4011 and removes the player without grace', async () => {
    const h = await createHarness();
    const a = h.client();
    await joinAndSpawn(h, a);
    a.take();
    h.session.kick(0, KickReason.Idle);
    expect(a.take()).toMatchObject([{ name: 'Kicked', payload: { reason: KickReason.Idle } }]);
    expect(a.link.closedWith?.code).toBe(CloseCode.Kicked);
    await h.step();
    expect(h.hooks.onPlayerLeave).toHaveBeenCalledTimes(1);
    expect(h.session.players()).toEqual([]);
  });
});

describe('away and reconnect', () => {
  async function playing(): Promise<{ h: Harness; a: TestClient; b: TestClient; token: string }> {
    const h = await createHarness({ session: { reconnectGraceMs: 2000 } });
    const a = h.client();
    const b = h.client();
    const seen = await joinAndSpawn(h, a, 'a');
    await joinAndSpawn(h, b, 'b');
    const token = payloadOf<{ reconnectToken: string }>(seen, 'Welcome').reconnectToken;
    await h.step(3);
    a.take();
    b.take();
    return { h, a, b, token };
  }

  it('a link close while playing goes away and broadcasts SessionState(Away)', async () => {
    const { h, a, b } = await playing();
    const entity = h.session.players()[0]?.entity as number;
    a.link.remoteClose(1006);
    expect(players(b.take())[0]).toEqual({
      playerId: 0,
      name: 'a',
      state: PlayerState.Away,
      entity,
    });
    await h.step(6);
    expect(h.session.world.alive(entity)).toBe(true);
    expect(h.session.players()[0]?.state).toBe(PlayerState.Away);
    expect(h.session.ctx.inputs(0)).toBeUndefined();
  });

  it('grace expiry runs the leave: onPlayerLeave, entity destroyed, slot freed', async () => {
    const { h, a, b } = await playing();
    const entity = h.session.players()[0]?.entity as number;
    a.link.remoteClose(1006);
    await h.step(100); // 1.67 s
    expect(h.hooks.onPlayerLeave).not.toHaveBeenCalled();
    await h.step(30);
    expect(h.hooks.onPlayerLeave).toHaveBeenCalledTimes(1);
    expect(h.session.world.alive(entity)).toBe(false);
    expect(h.session.players().map((p) => p.playerId)).toEqual([1]);
    expect(players(b.take()).map((p) => p.name)).toEqual(['b']);
  });

  it('a reconnect Hello from away rebinds: Welcome, SessionState, RegionSet, Spawned, then a FULL snapshot once it reports', async () => {
    const { h, a, b, token } = await playing();
    const entity = h.session.players()[0]?.entity as number;
    a.link.remoteClose(1006);
    b.take();
    await h.step(10);

    const again = h.client();
    again.hello({ displayName: 'a', reconnectToken: token });
    const got = again.take();
    expect(got.map((m) => m.name)).toEqual(['Welcome', 'SessionState', 'RegionSet', 'Spawned']);
    expect(got.map((m) => m.seq)).toEqual([0, 1, 2, 3]);
    expect(got[0]?.payload).toMatchObject({ playerId: 0, reconnectToken: token });
    expect(got[3]?.payload).toEqual({ playerId: 0, entity, regionId: SPAWN_REGION });
    expect(players(b.take())[0]?.state).toBe(PlayerState.Playing);
    expect(h.session.players()).toHaveLength(2);

    await h.step(3); // no snapshot before the client re-reports its regions
    expect(again.names()).toEqual([]);
    again.regionLoadState(payloadOf<{ active: string[] }>(got, 'RegionSet').active);
    await h.step(3);
    const snap = again.take().find((m) => m.name === 'Snapshot');
    expect(snap?.payload).toMatchObject({ header: { flags: 1, baselineTick: 0 } });
    expect(h.hooks.onPlayerJoin).toHaveBeenCalledTimes(2);
    expect(h.hooks.onPlayerLeave).not.toHaveBeenCalled();
  });

  it('a reconnect while the old link is still bound kicks it with Replaced and 4006', async () => {
    const { h, a, token } = await playing();
    const again = h.client();
    again.hello({ displayName: 'a', reconnectToken: token });
    expect(a.take()).toMatchObject([{ name: 'Kicked', payload: { reason: KickReason.Replaced } }]);
    expect(a.link.closedWith?.code).toBe(CloseCode.Replaced);
    expect(again.names()).toEqual(['Welcome', 'SessionState', 'RegionSet', 'Spawned']);
    await flushMicrotasks(); // the old link's close report must not move the player away
    expect(h.session.players()[0]?.state).toBe(PlayerState.Playing);
  });

  it('an unknown token or another account token is a fresh join', async () => {
    const h = await createHarness({ verifier: null });
    const a = h.client({ identity: identity('acc-a', 'a') });
    const seen = await joinAndSpawn(h, a, 'a');
    const token = payloadOf<{ reconnectToken: string }>(seen, 'Welcome').reconnectToken;
    const stranger = h.client({ identity: identity('acc-z', 'z') });
    stranger.hello({ displayName: 'z', reconnectToken: token });
    expect(payloadOf<{ playerId: number }>(stranger.take(), 'Welcome').playerId).toBe(1);
    const unknown = h.client({ identity: identity('acc-a', 'a') });
    unknown.hello({ displayName: 'a', reconnectToken: 'no-such-token' });
    expect(payloadOf<{ playerId: number }>(unknown.take(), 'Welcome').playerId).toBe(2);
    expect(a.link.closedWith).toBeNull();
  });
});

describe('stop', () => {
  it('sends Kicked{ServerShutdown} and closes 1001 on every bound link', async () => {
    const onSave = vi.fn(() => new Uint8Array([7]));
    const h = await createHarness({ hooks: { onSave } });
    const a = h.client();
    await joinAndSpawn(h, a);
    const pending = h.client();
    a.take();
    await h.session.stop();
    expect(a.take()).toMatchObject([
      { name: 'Kicked', payload: { reason: KickReason.ServerShutdown } },
    ]);
    expect(a.link.closedWith?.code).toBe(CloseCode.Shutdown);
    expect(pending.link.closedWith?.code).toBe(CloseCode.Shutdown);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(await (await openApplicationSave(h.store)).get('session', 'state')).toEqual(
      new Uint8Array([7]),
    );
    expect(h.session.players()).toEqual([]);
    expect(() => h.session.step()).toThrow(/stopp/);
    await h.session.stop(); // idempotent
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});

describe('message acceptance by state', () => {
  it('ignores and counts messages that are not accepted in the current state', async () => {
    const h = await createHarness();
    const a = h.client();
    a.hello();
    a.take();
    a.input([1, 2]); // Input only while playing
    a.ack(3); // Ack only while playing
    a.regionLoadState(['cell/1_1']); // only loading, ready, playing
    expect(h.session.stats.ignoredMessages).toBe(3);
    expect(a.link.closedWith).toBeNull();
    a.ping(1234); // answered in joined, immediately
    expect(a.take()).toMatchObject([
      { name: 'Pong', payload: { clientTimeMs: 1234, serverTick: 0 } },
    ]);
  });

  it('ignores s2c kinds from a client and skips unknown kinds', async () => {
    const h = await createHarness();
    const a = h.client();
    a.hello();
    a.take();
    a.sendMessage(Notice, { code: 4 });
    const fw = new FrameWriter();
    fw.begin();
    fw.message(200, 0, a.seq++, (w) => w.u8(1));
    a.link.receive(fw.finish());
    expect(h.session.stats.ignoredMessages).toBe(1);
    expect(h.session.stats.unknownKinds).toBe(1);
    expect(a.link.closedWith).toBeNull();
  });

  it('dispatches c2s game messages to onMessage before systems, capped per client per tick', async () => {
    const order: string[] = [];
    const onMessage = vi.fn((player: PlayerInfo, def: { name: string }, payload: unknown) => {
      order.push(`msg:${player.playerId}:${def.name}:${(payload as { text: string }).text}`);
    });
    const probe = defineSystem('probe', 'input', (ctx) => order.push(`system:${ctx.tick}`));
    const h = await createHarness({ hooks: { onMessage }, systems: [probe] });
    const a = h.client();
    a.hello();
    a.sendMessage(Shout, { text: 'one' }); // accepted in joined
    a.sendMessage(Chat, { text: 'two' });
    expect(onMessage).not.toHaveBeenCalled(); // queued, dispatched in the tick
    await h.step();
    expect(order).toEqual(['msg:0:Shout:one', 'msg:0:Chat:two', 'system:1']);
    for (let i = 0; i < MAX_GAME_MESSAGES_PER_TICK + 5; i++) a.sendMessage(Shout, { text: `${i}` });
    await h.step();
    expect(onMessage).toHaveBeenCalledTimes(2 + MAX_GAME_MESSAGES_PER_TICK);
    expect(h.session.stats.gameMessagesDropped).toBe(5);
  });

  it('delivers s2c game messages from send/broadcast in the next frame', async () => {
    const h = await createHarness();
    const a = h.client();
    const b = h.client();
    a.hello({ displayName: 'a' });
    b.hello({ displayName: 'b' });
    a.take();
    b.take();
    h.session.send(1, Notice, { code: 9 });
    h.session.broadcast(Chat, { text: 'hi all' });
    expect(a.take()).toEqual([]);
    expect(() => h.session.send(0, Shout, { text: 'x' })).toThrow(RangeError);
    await h.step(); // tick 1: no snapshot, own frame at the end of the tick
    expect(a.take()).toMatchObject([{ name: 'Chat', payload: { text: 'hi all' } }]);
    expect(b.take()).toMatchObject([
      { name: 'Notice', payload: { code: 9 }, frame: 2 },
      { name: 'Chat', payload: { text: 'hi all' }, frame: 2 },
    ]);
  });
});
