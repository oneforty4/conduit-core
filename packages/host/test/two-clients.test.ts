// @conduit/lobby-client and @conduit/net-client are isomorphic and their sources name DOM types;
// type-checking them from this Node package needs the DOM lib.
/// <reference lib="dom" />
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { LobbyClient } from '@conduit/lobby-client';
import { NetClient } from '@conduit/net-client';
import type { EntityId } from '@conduit/protocol';
import { Transform } from '@conduit/sim';
import { afterEach, describe, expect, it } from 'vitest';
import type { WorkerToMain } from '../src/port-protocol.ts';
import { type GatewayClient, SessionManager } from '../src/session-manager.ts';
import { Chat, type FixtureInput, game } from './fixtures/game.ts';
import {
  PASSWORD,
  sleep,
  startHost,
  type TestHost,
  waitFor,
  WORKER_EXEC_ARGV,
} from './fixtures/helpers.ts';

const hosts: TestHost[] = [];
const clients: NetClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  for (const host of hosts.splice(0)) await host.close();
});

/** A NetClient for a lobby join, logging nothing. */
function netClient(join: { token: string; wsUrl: string }, displayName: string): NetClient {
  const client = new NetClient({
    url: join.wsUrl,
    game,
    token: join.token,
    displayName,
    log: () => undefined,
  });
  clients.push(client);
  return client;
}

/** Two accounts through the lobby API: A creates a private session, B joins it with the invite code. */
async function lobbyPair(target: TestHost): Promise<{
  sessionId: string;
  joinA: { token: string; wsUrl: string };
  joinB: { token: string; wsUrl: string };
}> {
  const lobbyA = new LobbyClient({ baseUrl: target.url });
  const lobbyB = new LobbyClient({ baseUrl: target.url });
  await lobbyA.register('alice', PASSWORD, 'Alice');
  await lobbyA.login('alice', PASSWORD);
  await lobbyB.register('bob', PASSWORD, 'Bob');
  await lobbyB.login('bob', PASSWORD);
  const { session, inviteCode } = await lobbyA.createSession({
    gameId: game.id,
    name: 'duo',
    visibility: 'private',
    maxPlayers: 2,
  });
  const joinA = await lobbyA.join(session.id);
  const joinB = await lobbyB.join(session.id, inviteCode.toLowerCase());
  return { sessionId: session.id, joinA, joinB };
}

describe('two clients through the lobby and the host', () => {
  it('join the same worker, chat and see each other move; one leaving keeps the other playing', async () => {
    const target = await startHost();
    hosts.push(target);
    const { sessionId, joinA, joinB } = await lobbyPair(target);
    expect(joinA.wsUrl).toBe(`ws://127.0.0.1:${target.port}/session/${sessionId}`);

    const a = netClient(joinA, 'Alice');
    const b = netClient(joinB, 'Bob');
    const welcomes: string[] = [];
    a.on('welcome', () => welcomes.push('a'));
    b.on('welcome', () => welcomes.push('b'));
    await Promise.all([a.connect(), b.connect()]);
    await waitFor(() => a.state === 'Playing' && b.state === 'Playing', 'both playing');
    expect(welcomes.sort()).toEqual(['a', 'b']);
    expect(a.playerId).not.toBe(b.playerId);

    const health = target.host.sessions.health();
    expect(health).toHaveLength(1);
    expect(health[0]).toMatchObject({ sessionId, state: 'running', clients: 2 });
    expect(target.host.sessions.has(sessionId)).toBe(true);

    // A's chat reaches B through the one worker.
    const heard: string[] = [];
    b.on('message', (m) => {
      if (m.def.name === 'Chat') heard.push((m.payload as { text: string }).text);
    });
    a.send(Chat, { text: 'hello bob' });
    await waitFor(() => heard.includes('Alice: hello bob'), 'the chat echo');

    // A drives; B's replica sees A's entity move, and A sees B's.
    const aEntity: EntityId = a.entity;
    await waitFor(() => b.mirror.read(aEntity, Transform) !== undefined, "A's entity on B");
    const startX = b.mirror.read(aEntity, Transform)?.pos.x ?? 0;
    a.sendInput({ tick: 0, throttle: 127 } as FixtureInput);
    await waitFor(
      () => (b.mirror.read(aEntity, Transform)?.pos.x ?? 0) > startX + 1,
      "A's move on B",
    );
    expect(a.mirror.read(b.entity, Transform)).toBeDefined();

    // A leaves; B stays connected and the worker keeps running.
    a.disconnect();
    await waitFor(() => target.host.sessions.health()[0]?.clients === 1, "A's socket closed");
    await waitFor(
      () => (b.mirror.get(aEntity)?.destroyedTick ?? null) !== null,
      "A's entity destroyed on B",
    );
    expect(b.state).toBe('Playing');
    expect(target.host.sessions.isRunning(sessionId)).toBe(true);
    const before = b.stats().snapshots;
    await waitFor(() => b.stats().snapshots > before + 5, 'B still receiving snapshots');
    const tick = target.host.sessions.health()[0]?.tick;
    if (tick !== null && tick !== undefined) expect(tick.bytesOutPerSec).toBeGreaterThan(0);
  });
});

/** `CONDUIT_SLOW=1`: a 30 s window and the Spike 7 pass criteria asserted (PLAN.md M5). */
const SLOW = process.env.CONDUIT_SLOW === '1';
const WINDOW_MS = SLOW ? 30_000 : 3_000;
const TICK_BUDGET_MS = 1000 / game.tickRate;

interface BotStats {
  snapshots: number;
  bytesIn: number;
  bytesOut: number;
}

/** A NetClient in a worker thread (`fixtures/bot.ts`), so its work stays off this thread. */
function bot(join: { token: string; wsUrl: string }, name: string) {
  const worker = new Worker(new URL('./fixtures/bot.ts', import.meta.url), {
    workerData: { url: join.wsUrl, token: join.token, name },
    execArgv: WORKER_EXEC_ARGV,
  });
  const playing = new Promise<void>((resolve, reject) => {
    worker.on('message', (msg: { t: string }) => {
      if (msg.t === 'playing') resolve();
    });
    worker.once('error', reject);
  });
  return {
    playing,
    reset: () => worker.postMessage({ t: 'reset' }),
    stop: () =>
      new Promise<BotStats>((resolve) => {
        worker.on('message', (msg: { t: string } & BotStats) => {
          if (msg.t === 'stats') resolve(msg);
        });
        worker.postMessage({ t: 'stop' });
      }),
    terminate: () => worker.terminate(),
  };
}

// Spike 7 (PLAN.md M5, CONCEPT.md risk 7). Two measures of the main thread's cost:
// - relay time per frame: the time in the relay code itself (the worker `send` handler with its
//   `ws.send`, and the socket `message` listener copying a frame and posting it to the worker),
//   divided by the frames relayed in both directions. Pass: < 0.1 ms.
// - share of the tick budget: all of the main thread's event-loop activity (`eventLoopUtilization`,
//   which includes socket reads and writes any server pays, and every wake-up) per sim tick, over
//   the 16.7 ms budget. Pass: < 5 %. Divided by the frames, it is an upper bound per frame.
describe('Spike 7: MessagePort relay cost', () => {
  it(
    'measures main-thread time per relayed frame at 2 clients x 20 snapshots/s',
    async () => {
      const target = await startHost();
      hosts.push(target);

      const proto = SessionManager.prototype as unknown as {
        onWorkerMessage(rec: unknown, msg: WorkerToMain): void;
        attach(sessionId: string, client: GatewayClient): void;
      };
      const counts = { out: 0, outMs: 0, in: 0, inMs: 0 };
      const onWorkerMessage = proto.onWorkerMessage;
      const attach = proto.attach;
      proto.onWorkerMessage = function (this: unknown, rec, msg) {
        if (msg.t !== 'send') return onWorkerMessage.call(this, rec, msg);
        const t0 = performance.now();
        onWorkerMessage.call(this, rec, msg);
        counts.outMs += performance.now() - t0;
        counts.out++;
      };
      proto.attach = function (this: unknown, sessionId, client) {
        const ws = client.ws as unknown as {
          on(event: string, listener: (...args: unknown[]) => void): unknown;
        };
        const on = ws.on.bind(ws);
        ws.on = (event, listener) => {
          if (event !== 'message') return on(event, listener);
          return on(event, (...args) => {
            const t0 = performance.now();
            listener(...args);
            counts.inMs += performance.now() - t0;
            counts.in++;
          });
        };
        attach.call(this, sessionId, client);
      };

      const bots: ReturnType<typeof bot>[] = [];
      try {
        const { joinA, joinB } = await lobbyPair(target);
        bots.push(bot(joinA, 'Alice'), bot(joinB, 'Bob'));
        await Promise.all(bots.map((b) => b.playing));
        await sleep(1000); // warm up

        for (const b of bots) b.reset();
        counts.out = counts.outMs = counts.in = counts.inMs = 0;
        const elu0 = performance.eventLoopUtilization();
        const t0 = performance.now();
        await sleep(WINDOW_MS);
        const elu = performance.eventLoopUtilization(elu0);
        const elapsedMs = performance.now() - t0;
        const window = { ...counts };
        const stats = await Promise.all(bots.map((b) => b.stop()));

        const frames = window.out + window.in;
        const ticks = elapsedMs / TICK_BUDGET_MS;
        const relayMsPerFrame = (window.outMs + window.inMs) / frames;
        const relayShare = (window.outMs + window.inMs) / ticks / TICK_BUDGET_MS;
        const loopMsPerFrame = elu.active / frames;
        const loopShare = elu.active / ticks / TICK_BUDGET_MS;
        const snapshotsPerSec = stats.map((st) => (st.snapshots * 1000) / elapsedMs);
        const fmt = (n: number, digits = 4) => n.toFixed(digits);
        const rate = (n: number) => fmt((n * 1000) / elapsedMs, 1);
        console.log(
          [
            `Spike 7: MessagePort relay cost, 2 clients, ${fmt(elapsedMs / 1000, 1)} s window`,
            `  snapshots/s per client: ${snapshotsPerSec.map((n) => fmt(n, 1)).join(' / ')}`,
            `  frames relayed: ${window.out} worker->socket (${rate(window.out)}/s), ${window.in} socket->worker (${rate(window.in)}/s)`,
            `  relay time: ${fmt(window.outMs / Math.max(1, window.out))} ms per outbound frame (incl. ws.send), ${fmt(window.inMs / Math.max(1, window.in))} ms per inbound frame, ${fmt(relayMsPerFrame)} ms per frame; ${fmt(relayShare * 100, 3)} % of the tick budget`,
            `  main-thread event loop: ${fmt(elu.active, 1)} ms active (${fmt(elu.utilization * 100, 2)} %), ${fmt(loopShare * 100, 3)} % of the tick budget, ${fmt(loopMsPerFrame)} ms per relayed frame (upper bound)`,
            `  pass (relay < 0.1 ms per frame, event loop < 5 % of the tick budget): ${relayMsPerFrame < 0.1 && loopShare < 0.05 ? 'yes' : 'no'}`,
          ].join('\n'),
        );

        for (const perSec of snapshotsPerSec) expect(perSec).toBeGreaterThan(15);
        expect(window.out).toBeGreaterThan(0);
        expect(window.in).toBeGreaterThan(0);
        // A loose regression bound in every run; the pass criteria need a quiet machine.
        expect(relayMsPerFrame).toBeLessThan(1);
        if (SLOW) {
          expect(relayMsPerFrame).toBeLessThan(0.1);
          expect(loopShare).toBeLessThan(0.05);
        }
      } finally {
        proto.onWorkerMessage = onWorkerMessage;
        proto.attach = attach;
        await Promise.all(bots.map((b) => b.terminate()));
      }
    },
    WINDOW_MS + 30_000,
  );
});
