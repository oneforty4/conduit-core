import { game as fixtureGame } from './fixtures/game.ts';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mintToken, type SessionToken } from '@conduit/auth';
import { PresenceHub } from '@conduit/lobby';
import {
  CoreKind,
  createCompatibilityDescriptor,
  PingSchema,
  type RejectedPayload,
  RegionLoadStateSchema,
  ReadySchema,
  RejectReason,
  type RegionSetPayload,
  type SessionStatePayload,
  type WelcomePayload,
  FrameWriter,
  encodeWith,
  HelloSchema,
} from '@conduit/protocol';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GATEWAY_CLOSE, HELLO_TIMEOUT_MS } from '../src/constants.ts';
import { Gateway, readHello } from '../src/gateway.ts';
import type { GatewayClient } from '../src/session-manager.ts';
import {
  createSession,
  frameOf,
  GameSocket,
  helloFrame,
  joinAndConnect,
  joinSession,
  lobbyLogin,
  ManualTimers,
  recordingLogger,
  SECRET,
  startHost,
  type TestHost,
  waitFor,
} from './fixtures/helpers.ts';

const nowS = (): number => Math.floor(Date.now() / 1000);
const OTHER_ULID = '01J8ZK4A5B6C7D8E9F0G1H2J3K';

/** Status of a WebSocket upgrade request: 101 when upgraded, else the HTTP status. */
function upgradeStatus(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...headers,
      },
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('error', reject);
    req.end();
  });
}

/** Opens `/session/:id`, sends `first`, and resolves with the Rejected payload and the close. */
async function rejection(
  target: TestHost,
  sessionId: string,
  first: Uint8Array | string,
): Promise<{ rejected: RejectedPayload; code: number; reason: string; names: string[] }> {
  const socket = new GameSocket(`ws://127.0.0.1:${target.port}/session/${sessionId}`);
  await socket.opened;
  socket.send(first);
  const { code, reason } = await socket.closed;
  const rejected = socket.received.find((m) => m.name === 'Rejected')?.payload as RejectedPayload;
  return { rejected, code, reason, names: socket.names() };
}

function token(
  fields: Partial<SessionToken> & { accountId: string; sessionId: string },
  secret = SECRET,
): string {
  return mintToken({ displayName: 'someone', exp: nowS() + 600, ...fields }, secret);
}

let target: TestHost;
let alice: { cookie: string; accountId: string };
let carol: { cookie: string; accountId: string };
let running: string;
let dormant: string;

beforeAll(async () => {
  target = await startHost();
  alice = await lobbyLogin(target, 'alice');
  carol = await lobbyLogin(target, 'carol');
  running = (await createSession(target, alice.cookie)).id;
  await joinSession(target, alice.cookie, running);
  dormant = (await createSession(target, alice.cookie)).id; // alice is a member; never started
});

afterAll(async () => {
  await target.close();
});

describe('readHello', () => {
  it('returns the Hello of a one-message frame and throws for anything else', () => {
    const hello = helloFrame('tok', 'Ada');
    expect(readHello(hello)).toMatchObject({ sessionToken: 'tok', displayName: 'Ada' });
    expect(() => readHello(frameOf(CoreKind.Ping, PingSchema, { clientTimeMs: 1 }))).toThrow();
    expect(() => readHello(new Uint8Array([1, 2, 3]))).toThrow();
    const fw = new FrameWriter();
    fw.begin();
    const payload = {
      protocolVersion: 1,
      registryHash: 0,
      sessionToken: '',
      reconnectToken: '',
      displayName: '',
    };
    fw.message(CoreKind.Hello, 0, 0, (w) => encodeWith(w, HelloSchema, payload));
    fw.message(CoreKind.Hello, 0, 1, (w) => encodeWith(w, HelloSchema, payload));
    expect(() => readHello(fw.finish())).toThrow();
    fw.begin();
    fw.message(CoreKind.Hello, 0, 0, (w) => w.u16(1)); // truncated payload
    expect(() => readHello(fw.finish())).toThrow();
  });
});

describe('Gateway: upgrades', () => {
  it('refuses unknown paths with 404 and /lobby without a login with 401', async () => {
    expect(await upgradeStatus(target.port, '/other')).toBe(404);
    expect(await upgradeStatus(target.port, '/session/not-a-ulid')).toBe(404);
    expect(await upgradeStatus(target.port, `/session/${running}/extra`)).toBe(404);
    expect(await upgradeStatus(target.port, '/lobby')).toBe(401);
    expect(await upgradeStatus(target.port, '/lobby', { cookie: 'conduit_sid=forged' })).toBe(401);
  });

  it('hands an authenticated /lobby socket to the presence hub', async () => {
    const attach = vi.spyOn(PresenceHub.prototype, 'attach');
    expect(await upgradeStatus(target.port, '/lobby', { cookie: alice.cookie })).toBe(101);
    await waitFor(() => attach.mock.calls.length === 1, 'presence attach');
    expect(attach.mock.calls[0]?.[1]).toMatchObject({ id: alice.accountId, username: 'alice' });
    attach.mockRestore();
  });

  it('upgrades a well-formed /session/:id and passes a valid Hello to the worker', async () => {
    const socket = await joinAndConnect(target, alice.cookie, running, 'alice');
    const welcome = await socket.next('Welcome');
    expect(welcome.payload).toMatchObject({
      playerId: expect.any(Number),
      simTickRate: 60,
      snapshotEvery: 3,
    });
    socket.ws.close();
    await socket.closed;
  });
});

describe('Gateway: the Hello check', () => {
  it('carries bounded declarations to the worker and rejects a declared client against schema-only session', async () => {
    const valid = token({ accountId: alice.accountId, sessionId: running });
    const first = frameOf(CoreKind.Hello, HelloSchema, {
      protocolVersion: fixtureGame.protocolVersion,
      registryHash: fixtureGame.registry.hash,
      sessionToken: valid,
      reconnectToken: '',
      displayName: 'alice',
      compatibility: createCompatibilityDescriptor(fixtureGame.id, {
        simulationRevision: 'different-rules',
        gameplayDigests: { collision: 'different' },
      }),
    });
    expect(await rejection(target, running, first)).toMatchObject({
      code: 4013,
      rejected: { reason: RejectReason.Compatibility },
    });
  });

  it('rejects a text first frame, a Ping and a malformed frame with 4108', async () => {
    const expected = { reason: RejectReason.ProtocolVersion, detail: 'expected Hello' };
    const text = await rejection(target, running, 'hello?');
    expect(text).toMatchObject({
      rejected: expected,
      code: GATEWAY_CLOSE.BAD_FRAME,
      reason: 'expected Hello',
    });
    expect(text.names).toEqual(['Rejected']);
    const ping = await rejection(
      target,
      running,
      frameOf(CoreKind.Ping, PingSchema, { clientTimeMs: 5 }),
    );
    expect(ping).toMatchObject({ rejected: expected, code: GATEWAY_CLOSE.BAD_FRAME });
    const garbage = await rejection(target, running, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    expect(garbage).toMatchObject({ rejected: expected, code: GATEWAY_CLOSE.BAD_FRAME });
  });

  it('rejects a garbage token and one signed with another secret with 4101', async () => {
    for (const bad of [
      'garbage',
      token({ accountId: alice.accountId, sessionId: running }, 'z'.repeat(48)),
    ]) {
      const got = await rejection(target, running, helloFrame(bad, 'alice'));
      expect(got).toMatchObject({
        rejected: { reason: RejectReason.BadToken, detail: 'bad token' },
        code: GATEWAY_CLOSE.BAD_TOKEN,
        reason: 'bad token',
      });
    }
  });

  it('rejects an expired token without a reconnect token with 4102', async () => {
    const expired = token({ accountId: alice.accountId, sessionId: running, exp: nowS() - 1 });
    expect(await rejection(target, running, helloFrame(expired, 'alice'))).toMatchObject({
      rejected: { reason: RejectReason.BadToken, detail: 'token expired' },
      code: GATEWAY_CLOSE.TOKEN_EXPIRED,
    });
  });

  it('rejects a token for another session with 4103, even an expired one with a reconnect token', async () => {
    const other = token({ accountId: alice.accountId, sessionId: dormant });
    const expected = {
      rejected: { reason: RejectReason.BadToken, detail: 'token is for another session' },
      code: GATEWAY_CLOSE.SESSION_MISMATCH,
    };
    expect(await rejection(target, running, helloFrame(other, 'alice'))).toMatchObject(expected);
    const stale = token({ accountId: alice.accountId, sessionId: OTHER_ULID, exp: nowS() - 60 });
    expect(
      await rejection(target, running, helloFrame(stale, 'alice', 'r'.repeat(32))),
    ).toMatchObject(expected);
  });

  it('rejects a member of a session that is not running with 4104', async () => {
    const valid = token({ accountId: alice.accountId, sessionId: dormant });
    expect(await rejection(target, dormant, helloFrame(valid, 'alice'))).toMatchObject({
      rejected: { reason: RejectReason.SessionNotRunning, detail: 'session not running' },
      code: GATEWAY_CLOSE.SESSION_NOT_RUNNING,
    });
  });

  it('rejects a valid token of a non-member with 4109', async () => {
    const valid = token({ accountId: carol.accountId, sessionId: running });
    expect(await rejection(target, running, helloFrame(valid, 'carol'))).toMatchObject({
      rejected: { reason: RejectReason.BadToken, detail: 'not a member' },
      code: GATEWAY_CLOSE.NOT_MEMBER,
    });
  });

  it('lets an expired token through only with a reconnect token, and the worker only rebinds', async () => {
    // Alice plays, then her connection drops without a Leave.
    const first = await joinAndConnect(target, alice.cookie, running, 'alice');
    const welcome = (await first.next('Welcome')).payload as WelcomePayload;
    first.send(frameOf(CoreKind.Ready, ReadySchema, {}, 1));
    const set = (await first.next('RegionSet')).payload as RegionSetPayload;
    first.send(
      frameOf(
        CoreKind.RegionLoadState,
        RegionLoadStateSchema,
        { loaded: set.active, loading: [] },
        2,
      ),
    );
    await first.next('Spawned');
    first.ws.terminate();
    await first.closed;
    await waitFor(
      () => target.host.sessions.health()[0]?.clients === 0,
      'the drop reaching the worker',
    );

    // An expired token with an unknown reconnect token passes the gateway; the Session refuses it.
    const expired = token({ accountId: alice.accountId, sessionId: running, exp: nowS() - 3600 });
    const unknown = await rejection(target, running, helloFrame(expired, 'alice', 'u'.repeat(32)));
    expect(unknown).toMatchObject({
      rejected: { reason: RejectReason.BadToken, detail: 'bad token' },
      code: 4008, // the Session's Rejected{BadToken} close
    });

    // With her reconnect token it resumes her player.
    const back = new GameSocket(`ws://127.0.0.1:${target.port}/session/${running}`);
    await back.opened;
    back.send(helloFrame(expired, 'alice', welcome.reconnectToken));
    const again = (await back.next('Welcome')).payload as WelcomePayload;
    expect(again).toMatchObject({
      playerId: welcome.playerId,
      reconnectToken: welcome.reconnectToken,
    });
    await back.next('Spawned');
    const state = back.received.find((m) => m.name === 'SessionState')
      ?.payload as SessionStatePayload;
    expect(state.players).toContainEqual(
      expect.objectContaining({ playerId: welcome.playerId, state: 2 }),
    );
    back.ws.close();
    await back.closed;
  });
});

describe('Gateway: timers, verdicts and shutdown', () => {
  let server: Server;
  let port: number;
  let timers: ManualTimers;
  let attached: GatewayClient[];
  let gateway: Gateway;

  beforeAll(async () => {
    timers = new ManualTimers();
    attached = [];
    gateway = new Gateway({
      secret: SECRET,
      service: { authenticate: () => null, isMember: () => true },
      presence: { attach: () => undefined },
      sessions: {
        isRunning: () => true,
        attach: (_id, client) => {
          attached.push(client);
        },
      },
      logger: recordingLogger(),
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    server = createServer();
    server.on('upgrade', (req, socket, head: Buffer) => gateway.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    gateway.closeAll(1001, 'bye');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('closes a socket that sends no Hello within HELLO_TIMEOUT_MS with 4107', async () => {
    const socket = new GameSocket(`ws://127.0.0.1:${port}/session/${OTHER_ULID}`);
    await socket.opened;
    await waitFor(() => timers.pending() === 1, 'the hello timer');
    timers.advance(HELLO_TIMEOUT_MS - 1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(socket.closeInfo).toBeNull();
    timers.advance(1);
    expect(await socket.closed).toEqual({
      code: GATEWAY_CLOSE.HELLO_TIMEOUT,
      reason: 'hello timeout',
    });
    expect(socket.received.map((m) => m.payload)).toEqual([
      { reason: RejectReason.BadToken, detail: 'hello timeout' },
    ]);
  });

  it('passes the identity, the Hello frame and the expiry verdict to sessions.attach', async () => {
    const valid = token({ accountId: 'acc-1', sessionId: OTHER_ULID, displayName: 'One' });
    const expired = token({ accountId: 'acc-2', sessionId: OTHER_ULID, exp: nowS() - 5 });
    const helloA = helloFrame(valid, 'One');
    const helloB = helloFrame(expired, 'Two', 'r'.repeat(32));
    for (const hello of [helloA, helloB]) {
      const socket = new GameSocket(`ws://127.0.0.1:${port}/session/${OTHER_ULID}`);
      await socket.opened;
      socket.send(hello);
    }
    await waitFor(() => attached.length === 2, 'two attaches');
    const [a, b] = attached as [GatewayClient, GatewayClient];
    expect(a.identity).toEqual({
      accountId: 'acc-1',
      displayName: 'One',
      sessionId: OTHER_ULID,
      exp: expect.any(Number),
    });
    expect(a.tokenExpired).toBe(false);
    expect([...new Uint8Array(a.helloFrame)]).toEqual([...helloA]);
    expect(b.identity.accountId).toBe('acc-2');
    expect(b.tokenExpired).toBe(true);
    expect(b.clientId).toBeGreaterThan(a.clientId);
    for (const client of attached) client.ws.close();
  });

  it('refuses upgrades with 503 after stopAccepting()', async () => {
    expect(gateway.accepting).toBe(true);
    gateway.stopAccepting();
    expect(gateway.accepting).toBe(false);
    expect(await upgradeStatus(port, `/session/${OTHER_ULID}`)).toBe(503);
    expect(await upgradeStatus(port, '/lobby')).toBe(503);
  });
});

it('admits matching declarations and rejects schema-only through a declared worker', async () => {
  const declaration = {
    simulationRevision: 'worker-rules-1',
    gameplayDigests: { collision: 'collision-1' },
  };
  const declaredHost = await startHost({ workerExtra: { compatibility: declaration } });
  try {
    const member = await lobbyLogin(declaredHost, 'declared');
    const session = (await createSession(declaredHost, member.cookie)).id;
    await joinSession(declaredHost, member.cookie, session);
    const valid = token({ accountId: member.accountId, sessionId: session });
    expect(await rejection(declaredHost, session, helloFrame(valid, 'declared'))).toMatchObject({
      code: 4013,
      rejected: { reason: RejectReason.Compatibility },
    });
    const socket = new GameSocket(`ws://127.0.0.1:${declaredHost.port}/session/${session}`);
    await socket.opened;
    const compatibility = createCompatibilityDescriptor(fixtureGame.id, declaration);
    socket.send(
      frameOf(CoreKind.Hello, HelloSchema, {
        protocolVersion: fixtureGame.protocolVersion,
        registryHash: fixtureGame.registry.hash,
        sessionToken: valid,
        reconnectToken: '',
        displayName: 'declared',
        compatibility,
      }),
    );
    expect((await socket.next('Welcome')).payload).toMatchObject({ compatibility });
    socket.ws.close();
    await socket.closed;
  } finally {
    await declaredHost.close();
  }
});
