import { devVerifier, hmacVerifier, mintToken, type SessionToken } from '@conduit/auth';
import {
  AckSchema,
  CoreKind,
  createCompatibilityDescriptor,
  encodeWith,
  FrameWriter,
  HelloSchema,
  type HelloPayload,
  RejectReason,
} from '@conduit/protocol';
import { describe, expect, it } from 'vitest';
import { CloseCode } from '../src/constants.ts';
import {
  type HelloCheck,
  peekHello,
  resolveIdentity,
  validateHello,
  rejectDetail,
} from '../src/hello.ts';
import { FakeLink } from './fake-link.ts';
import { createHarness, payloadOf, testGame, defaultHooks, joinAndSpawn } from './harness.ts';

const SECRET = 'a-test-secret-that-is-at-least-32-bytes-long';
const game = testGame();

function hello(fields: Partial<HelloPayload> = {}): HelloPayload {
  return {
    protocolVersion: game.protocolVersion,
    registryHash: game.registry.hash,
    sessionToken: 'tok',
    reconnectToken: '',
    displayName: 'Ada',
    ...fields,
  };
}

function identity(fields: Partial<SessionToken> = {}): SessionToken {
  return {
    accountId: 'acc-1',
    displayName: 'Ada',
    sessionId: 'dev',
    exp: Math.floor(Date.now() / 1000) + 600,
    ...fields,
  };
}

function check(fields: Partial<HelloCheck> = {}): HelloCheck {
  return {
    identity: identity(),
    sessionId: 'dev',
    nowMs: Date.now(),
    running: true,
    reconnect: false,
    activePlayers: 0,
    maxPlayers: 8,
    ...fields,
  };
}

function frameOf(...messages: [kind: number, write: (fw: FrameWriter) => void][]): Uint8Array {
  const fw = new FrameWriter();
  fw.begin();
  for (const [, write] of messages) write(fw);
  return fw.finish();
}

describe('peekHello', () => {
  it('reads the Hello of a valid frame', () => {
    const buf = frameOf([
      CoreKind.Hello,
      (fw) => fw.message(CoreKind.Hello, 0, 0, (w) => encodeWith(w, HelloSchema, hello())),
    ]);
    const peeked = peekHello(buf);
    expect(peeked?.header).toMatchObject({ kind: CoreKind.Hello, tick: 0, seq: 0 });
    expect(peeked?.hello).toEqual(hello());
  });

  it('returns null when the first message is not Hello', () => {
    const buf = frameOf(
      [
        CoreKind.Ack,
        (fw) =>
          fw.message(CoreKind.Ack, 0, 0, (w) => encodeWith(w, AckSchema, { lastSnapshotTick: 1 })),
      ],
      [
        CoreKind.Hello,
        (fw) => fw.message(CoreKind.Hello, 0, 1, (w) => encodeWith(w, HelloSchema, hello())),
      ],
    );
    expect(peekHello(buf)).toBeNull();
  });

  it('returns null on garbage, an empty frame and a truncated Hello', () => {
    expect(peekHello(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBeNull();
    expect(peekHello(new Uint8Array(0))).toBeNull();
    expect(peekHello(frameOf())).toBeNull();
    const truncated = frameOf([
      CoreKind.Hello,
      (fw) => fw.message(CoreKind.Hello, 0, 0, (w) => w.u16(3)), // protocolVersion only
    ]);
    expect(peekHello(truncated)).toBeNull();
  });
});

describe('validateHello', () => {
  it('accepts a valid Hello', () => {
    expect(validateHello(hello(), game, game.registry)).toBeNull();
    expect(validateHello(hello(), game, game.registry, check())).toBeNull();
  });

  it('returns each RejectReason', () => {
    expect(validateHello(hello({ protocolVersion: 2 }), game, game.registry)).toBe(
      RejectReason.ProtocolVersion,
    );
    expect(validateHello(hello({ registryHash: 1 }), game, game.registry)).toBe(
      RejectReason.SchemaMismatch,
    );
    expect(validateHello(hello(), game, game.registry, check({ identity: null }))).toBe(
      RejectReason.BadToken,
    );
    const otherSession = check({ identity: identity({ sessionId: 'elsewhere' }) });
    expect(validateHello(hello(), game, game.registry, otherSession)).toBe(RejectReason.BadToken);
    const expired = check({ identity: identity({ exp: Math.floor(Date.now() / 1000) - 5 }) });
    expect(validateHello(hello(), game, game.registry, expired)).toBe(RejectReason.BadToken);
    expect(validateHello(hello(), game, game.registry, check({ running: false }))).toBe(
      RejectReason.SessionNotRunning,
    );
    expect(validateHello(hello(), game, game.registry, check({ activePlayers: 8 }))).toBe(
      RejectReason.SessionFull,
    );
  });

  it('checks in the A.6 order and lets a reconnect past a full session', () => {
    const everythingWrong = check({ identity: null, running: false, activePlayers: 8 });
    expect(validateHello(hello({ protocolVersion: 9 }), game, game.registry, everythingWrong)).toBe(
      RejectReason.BadToken,
    );
    const stopping = check({ running: false, activePlayers: 8 });
    expect(validateHello(hello({ registryHash: 5 }), game, game.registry, stopping)).toBe(
      RejectReason.SchemaMismatch,
    );
    expect(validateHello(hello(), game, game.registry, stopping)).toBe(
      RejectReason.SessionNotRunning,
    );
    const full = check({ activePlayers: 8, reconnect: true });
    expect(validateHello(hello(), game, game.registry, full)).toBeNull();
  });

  it('lets an expired identity reconnect only; an explicit verdict wins over exp', () => {
    const stale = identity({ exp: Math.floor(Date.now() / 1000) - 3600 });
    const cases: [string, Partial<HelloCheck>, RejectReason | null][] = [
      ['expired by exp, fresh join', { identity: stale }, RejectReason.BadToken],
      ['expired by exp, reconnect', { identity: stale, reconnect: true }, null],
      [
        'exp exactly now is expired',
        { identity: identity({ exp: 1000 }), nowMs: 1_000_000 },
        RejectReason.BadToken,
      ],
      [
        'exp one second ahead is valid',
        { identity: identity({ exp: 1001 }), nowMs: 1_000_999 },
        null,
      ],
      ['verdict expired, fresh join', { expired: true }, RejectReason.BadToken],
      ['verdict expired, reconnect', { expired: true, reconnect: true }, null],
      ['verdict valid despite exp', { identity: stale, expired: false }, null],
      [
        'expired reconnect, other session',
        { identity: identity({ ...stale, sessionId: 'x' }), reconnect: true },
        RejectReason.BadToken,
      ],
      [
        'expired reconnect, not running',
        { expired: true, reconnect: true, running: false },
        RejectReason.SessionNotRunning,
      ],
    ];
    for (const [label, fields, expected] of cases) {
      expect(validateHello(hello(), game, game.registry, check(fields)), label).toBe(expected);
    }
  });
});

describe('resolveIdentity', () => {
  it('prefers the attach identity, else asks the verifier', () => {
    const given = identity({ accountId: 'from-gateway' });
    const verifier = devVerifier({ warn: () => {} });
    expect(resolveIdentity(hello(), given, verifier)).toBe(given);
    expect(resolveIdentity(hello({ displayName: ' Bob ' }), null, verifier)).toMatchObject({
      accountId: 'dev:bob',
      displayName: 'Bob',
      sessionId: 'dev',
    });
    expect(resolveIdentity(hello(), null, hmacVerifier(SECRET))).toBeNull();
    expect(resolveIdentity(hello(), null, undefined)).toBeNull();
  });

  it('verifies with allowExpired only when the Hello carries a reconnect token', () => {
    const verifier = hmacVerifier(SECRET);
    const now = 2_000_000_000;
    const expired = mintToken(identity({ exp: now - 60 }), SECRET);
    const fresh = mintToken(identity({ exp: now + 60 }), SECRET);
    expect(resolveIdentity(hello({ sessionToken: expired }), null, verifier, now)).toBeNull();
    expect(
      resolveIdentity(
        hello({ sessionToken: expired, reconnectToken: 'r'.repeat(32) }),
        null,
        verifier,
        now,
      ),
    ).toEqual(identity({ exp: now - 60 }));
    expect(resolveIdentity(hello({ sessionToken: fresh }), null, verifier, now)).toEqual(
      identity({ exp: now + 60 }),
    );
    const forged = mintToken(identity({ exp: now - 60 }), 'f'.repeat(32));
    expect(
      resolveIdentity(
        hello({ sessionToken: forged, reconnectToken: 'r'.repeat(32) }),
        null,
        verifier,
        now,
      ),
    ).toBeNull();
  });
});

describe('Session.attach handshake', () => {
  it('with devVerifier accepts any token and derives the identity from displayName', async () => {
    const h = await createHarness();
    const a = h.client();
    a.hello({ sessionToken: '', displayName: 'Grace' });
    expect(a.names()).toEqual(['Welcome', 'SessionState']);
    await h.step();
    expect(h.hooks.onPlayerJoin).toHaveBeenCalledTimes(1);
    expect(h.hooks.onPlayerJoin.mock.calls[0]?.[0]).toMatchObject({
      playerId: 0,
      accountId: 'dev:grace',
      displayName: 'Grace',
    });
    const b = h.client();
    b.hello({ sessionToken: 'anything at all', displayName: 'Linus' });
    const welcome = payloadOf<{ playerId: number; reconnectToken: string }>(b.take(), 'Welcome');
    expect(welcome.playerId).toBe(1);
    expect(welcome.reconnectToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('with hmacVerifier rejects a bad token with Rejected{BadToken} and 4008', async () => {
    const h = await createHarness({ verifier: hmacVerifier(SECRET) });
    const bad = h.client();
    bad.hello({ sessionToken: 'not-a-token' });
    const got = bad.take();
    expect(got.map((m) => m.name)).toEqual(['Rejected']);
    expect(got[0]?.payload).toEqual({ reason: RejectReason.BadToken, detail: 'bad token' });
    expect(bad.link.closedWith?.code).toBe(CloseCode.BadToken);
    expect(h.session.players()).toEqual([]);

    const wrongSession = h.client();
    const exp = Math.floor(Date.now() / 1000) + 600;
    wrongSession.hello({
      sessionToken: mintToken(
        { accountId: 'a', displayName: 'A', sessionId: 'other', exp },
        SECRET,
      ),
    });
    expect(wrongSession.link.closedWith?.code).toBe(CloseCode.BadToken);

    const good = h.client();
    good.hello({
      sessionToken: mintToken(
        { accountId: 'acc-7', displayName: 'Tok', sessionId: 'dev', exp },
        SECRET,
      ),
      displayName: '',
    });
    expect(good.names()).toEqual(['Welcome', 'SessionState']);
    expect(h.session.players()).toMatchObject([
      { playerId: 0, accountId: 'acc-7', displayName: 'Tok' },
    ]);
  });

  it('uses an attach identity as authoritative without a verifier', async () => {
    const h = await createHarness({ verifier: null });
    const c = h.client({ identity: identity({ accountId: 'gw-1', displayName: 'Gate' }) });
    c.hello({ sessionToken: 'ignored', displayName: '' });
    expect(c.names()).toEqual(['Welcome', 'SessionState']);
    expect(h.session.players()).toMatchObject([{ accountId: 'gw-1', displayName: 'Gate' }]);
  });

  it('throws when attach gets neither an identity nor a verifier', async () => {
    const h = await createHarness({ verifier: null });
    expect(() => h.session.attach(new FakeLink(999))).toThrow(/verifier/);
  });

  it('rejects a protocol version or schema mismatch with the matching close code', async () => {
    const h = await createHarness();
    const old = h.client();
    old.hello({ protocolVersion: 2 });
    expect(old.take()[0]?.payload).toEqual({
      reason: RejectReason.ProtocolVersion,
      detail: 'server=3 client=2',
    });
    expect(old.link.closedWith?.code).toBe(CloseCode.ProtocolVersion);

    const stale = h.client();
    stale.hello({ registryHash: (h.game.registry.hash + 1) >>> 0 });
    expect(stale.take()[0]?.payload).toEqual({
      reason: RejectReason.SchemaMismatch,
      detail: 'please refresh',
    });
    expect(stale.link.closedWith?.code).toBe(CloseCode.SchemaMismatch);
  });

  it('rejects an expired gateway identity and a session that is not running', async () => {
    const h = await createHarness({ verifier: null });
    const expired = h.client({ identity: identity({ exp: 1 }) });
    expired.hello();
    expect(expired.take()[0]?.payload).toMatchObject({ reason: RejectReason.BadToken });

    await h.session.stop();
    const late = h.client({ identity: identity() });
    late.hello();
    expect(late.take()[0]?.payload).toMatchObject({ reason: RejectReason.SessionNotRunning });
    expect(late.link.closedWith?.code).toBe(CloseCode.SessionNotRunning);
  });
});

it('rejects declared rule/data mismatches before join and pins admission across reconnects', async () => {
  let joins = 0;
  const compatibility = createCompatibilityDescriptor('testgame', {
    simulationRevision: 'rules-1',
    gameplayDigests: { mapping: 'map-1', physics: 'physics-1' },
  });
  const h = await createHarness({
    compatibility,
    hooks: {
      onPlayerJoin: (player, ctx) => {
        joins++;
        return defaultHooks().onPlayerJoin(player, ctx);
      },
    },
  });
  const wrong = h.client();
  wrong.hello({
    compatibility: createCompatibilityDescriptor('testgame', {
      simulationRevision: 'rules-1',
      gameplayDigests: { mapping: 'map-2', physics: 'physics-1' },
    }),
  });
  expect(payloadOf(wrong.take(), 'Rejected')).toMatchObject({
    reason: RejectReason.Compatibility,
    detail: 'update required: gameplayDigests.mapping',
  });
  expect(joins).toBe(0);
  const legacy = h.client();
  legacy.hello();
  expect(payloadOf(legacy.take(), 'Rejected')).toMatchObject({
    reason: RejectReason.Compatibility,
  });
  const accepted = h.client();
  accepted.hello({ compatibility });
  expect(payloadOf(accepted.take(), 'Welcome')).toMatchObject({ compatibility });
  expect(h.session.compatibility).toEqual(compatibility);
  expect(h.session.compatibility).not.toBe(compatibility);
  await h.session.stop();
});

it('clips actionable Unicode mismatch details to the wire byte limit', () => {
  const entries = Object.fromEntries(
    Array.from({ length: 16 }, (_, i) => [`名${i}`.padEnd(20, '字'), 'old']),
  );
  const compatibility = createCompatibilityDescriptor('testgame', {
    simulationRevision: 'sim',
    gameplayDigests: entries,
  });
  const actual = createCompatibilityDescriptor('testgame', {
    simulationRevision: 'sim',
    gameplayDigests: Object.fromEntries(Object.keys(entries).map((name) => [name, 'new'])),
  });
  const detail = rejectDetail(RejectReason.Compatibility, hello({ compatibility: actual }), {
    ...game,
    compatibility,
  });
  expect(new TextEncoder().encode(detail).length).toBeLessThanOrEqual(256);
  expect(detail).not.toContain('\uFFFD');
  expect(detail).toContain('gameplayDigests.名');
});

it('rechecks the pinned declaration on reconnect without consuming the away identity', async () => {
  const compatibility = createCompatibilityDescriptor('testgame', {
    simulationRevision: 'sim-1',
    gameplayDigests: { table: 'table-1' },
  });
  const h = await createHarness({ compatibility });
  const first = h.client();
  const joined = await joinAndSpawn(h, first, 'Ada', { compatibility });
  const welcome = payloadOf<{ playerId: number; reconnectToken: string }>(joined, 'Welcome');
  first.link.remoteClose();
  const changed = h.client();
  changed.hello({
    displayName: 'Ada',
    reconnectToken: welcome.reconnectToken,
    compatibility: createCompatibilityDescriptor('testgame', {
      simulationRevision: 'sim-2',
      gameplayDigests: { table: 'table-1' },
    }),
  });
  expect(payloadOf(changed.take(), 'Rejected')).toMatchObject({
    reason: RejectReason.Compatibility,
  });
  const resumed = h.client();
  resumed.hello({ displayName: 'Ada', reconnectToken: welcome.reconnectToken, compatibility });
  expect(payloadOf(resumed.take(), 'Welcome')).toMatchObject({
    playerId: welcome.playerId,
    compatibility,
  });
  await h.session.stop();
});
