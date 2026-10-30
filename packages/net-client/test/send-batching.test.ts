import { type InputPayload, SNAPSHOT_FLAG_FULL, type SnapshotData } from '@conduit/protocol';
import { describe, expect, it } from 'vitest';
import {
  type ClientTimers,
  DEFERRED_SEND_TICKS,
  MemoryTransport,
  NetClient,
  type NetClientOptions,
  QUICK_PING_MS,
} from '../src/index.ts';
import { ManualTimers, ScriptedServer, testGame, testRegistry } from './helpers.ts';

const TICK_MS = 1000 / 60;

/** Client timers that never fire: a hidden tab's, throttled far past a tick. */
class FrozenTimers implements ClientTimers {
  setTimeout(): unknown {
    return {};
  }
  clearTimeout(): void {}
  setInterval(): unknown {
    return {};
  }
  clearInterval(): void {}
}

function harness(opts: Partial<NetClientOptions> = {}, clientTimers?: ClientTimers) {
  const timers = new ManualTimers();
  const registry = testRegistry();
  const servers: ScriptedServer[] = [];
  const transports: MemoryTransport[] = [];
  const client = new NetClient({
    url: 'memory://session/dev',
    game: testGame(registry),
    token: 'dev-token',
    displayName: 'Ann',
    transport: () => {
      const t = new MemoryTransport({ timers });
      transports.push(t);
      servers.push(new ScriptedServer(t.link, registry));
      return t;
    },
    now: timers.nowFn,
    timers: clientTimers ?? timers,
    log: () => {},
    batchSends: true,
    ...opts,
  });
  const server = (): ScriptedServer => servers.at(-1)!;
  return { timers, registry, client, servers, transports, server };
}
type Harness = ReturnType<typeof harness>;

async function playing(h: Harness): Promise<void> {
  const p = h.client.connect();
  h.timers.flush();
  h.server().welcome();
  h.timers.flush();
  await p;
  h.server().regionSet(['cell/1_1']);
  h.timers.flush();
  h.server().spawned(2, 1234);
  h.timers.flush();
  expect(h.client.state).toBe('Playing');
}

/** An empty snapshot at `tick` on the client's latest one (FULL when it has none). */
function snapshot(h: Harness, tick: number, ack?: { tick: number; seq: number }): SnapshotData {
  const baselineTick = h.client.mirror.latestTick;
  return {
    header: {
      serverTick: tick,
      serverTimeMs: Math.round((tick * 1000) / 60),
      baselineTick,
      lastInputSeq: ack?.seq ?? 0,
      lastInputTick: ack?.tick ?? 0,
      flags: baselineTick === 0 ? SNAPSHOT_FLAG_FULL : 0,
    },
    regions: [],
    creates: [],
    updates: [],
    destroys: [],
  };
}

describe('NetClient send batching (docs/net.md B.6)', () => {
  it('an Ack rides in the next Input frame, ahead of it; the Input is not held back', async () => {
    const h = harness();
    await playing(h);
    h.timers.advance(TICK_MS * 4);
    const inputsBefore = h.server().all('Input').length;
    h.server().snapshot(snapshot(h, h.client.clock.serverTickNow()));
    h.timers.flush();
    expect(h.server().all('Ack')).toHaveLength(0); // waits for the Input
    h.timers.advance(TICK_MS);
    expect(h.server().all('Input')).toHaveLength(inputsBefore + 1); // on time
    expect(h.server().frames.at(-1)).toEqual(['Ack', 'Input']);
    const [ack, input] = h.server().received.slice(-2);
    expect(input!.header.seq).toBe(ack!.header.seq + 1);
    // Once playing, a frame is a tick's Input (and an Ack, when a snapshot came) or a Ping.
    h.timers.advance(2000);
    const since = h.server().frames.slice(-120);
    const shapes = new Set(since.map((names) => names.join(' ')));
    expect([...shapes].sort()).toEqual(['Input', 'Ping']);
  });

  it(`an Ack goes on its own after ${DEFERRED_SEND_TICKS} ticks when no Input comes`, async () => {
    const h = harness({ inputScheduling: 'manual' });
    await playing(h);
    h.timers.advance(1000); // the quick Pings, which go on their own too
    const frames = h.server().frames.length;
    h.server().snapshot(snapshot(h, 200));
    h.timers.flush();
    h.timers.advance(DEFERRED_SEND_TICKS * TICK_MS - 1);
    expect(h.server().frames.length).toBe(frames);
    h.timers.advance(1);
    expect(h.server().frames.slice(frames)).toEqual([['Ack']]);
  });

  it('acks only the newest of the snapshots it got meanwhile: Acks are cumulative', async () => {
    const h = harness({ inputScheduling: 'manual' });
    await playing(h);
    h.timers.advance(1000);
    h.server().snapshot(snapshot(h, 200));
    h.timers.flush();
    h.server().snapshot(snapshot(h, 203));
    h.timers.flush();
    h.timers.advance(DEFERRED_SEND_TICKS * TICK_MS);
    expect(
      h
        .server()
        .all('Ack')
        .map((m) => m.payload),
    ).toEqual([{ lastSnapshotTick: 203 }]);
  });

  it('never holds a Ping back, a clock sample, but lets it take a waiting Ack along', async () => {
    const h = harness({ inputScheduling: 'manual' });
    const p = h.client.connect();
    h.timers.flush();
    h.server().welcome();
    h.timers.flush();
    await p;
    const welcomedAt = h.timers.now;
    expect(h.server().frames).toEqual([['Hello'], ['Ready'], ['Ping']]); // the Welcome's, at once
    h.server().regionSet(['cell/1_1']);
    h.server().spawned(2, 1234);
    h.timers.advance(80);
    h.server().snapshot(snapshot(h, 200));
    h.timers.flush(); // its Ack waits, until welcomedAt + 80 + 2 ticks
    h.timers.advance(30); // the second quick Ping, at welcomedAt + QUICK_PING_MS
    expect(h.server().frames.at(-1)).toEqual(['Ack', 'Ping']);
    const ping = h.server().last('Ping')!.payload as { clientTimeMs: number };
    expect(ping.clientTimeMs).toBe(Math.round(welcomedAt + QUICK_PING_MS));
    expect(h.server().last('Ack')!.payload).toEqual({ lastSnapshotTick: 200 });
  });

  it('a frame from the server sends what a throttled timer held back past its time', async () => {
    const h = harness({}, new FrozenTimers()); // no Input ever: the client tick is a timer too
    await playing(h);
    h.server().snapshot(snapshot(h, 200));
    h.timers.flush();
    expect(h.server().all('Ack')).toHaveLength(0);
    h.timers.advance(DEFERRED_SEND_TICKS * TICK_MS + 1);
    expect(h.server().all('Ack')).toHaveLength(0); // the timer did not fire
    h.server().snapshot(snapshot(h, 203));
    h.timers.flush();
    expect(
      h
        .server()
        .all('Ack')
        .map((m) => m.payload),
    ).toEqual([{ lastSnapshotTick: 200 }]);
  });

  it('sends the Hello alone, and drops what was deferred when the connection goes', async () => {
    const h = harness({ inputScheduling: 'manual' });
    await playing(h);
    h.server().snapshot(snapshot(h, 200));
    h.timers.flush();
    h.transports.at(-1)!.drop(1006);
    h.timers.flush();
    expect(h.client.state).toBe('Reconnecting');
    h.timers.advance(10_000);
    expect(h.servers).toHaveLength(2);
    expect(h.servers[0]!.all('Ack')).toHaveLength(0);
    expect(h.server().frames[0]).toEqual(['Hello']);
    expect(h.server().all('Ack')).toHaveLength(0);
  });

  it('tells the reconciliation stub the seq its Input got in a batched frame', async () => {
    const recorded: { tick: number; seq: number }[] = [];
    const h = harness({
      prediction: { enabled: true, predictor: { inputSent: (p) => recorded.push({ ...p }) } },
    });
    await playing(h);
    h.timers.advance(TICK_MS * 3);
    h.server().snapshot(snapshot(h, h.client.clock.serverTickNow()));
    h.timers.flush();
    h.timers.advance(TICK_MS);
    expect(h.server().frames.at(-1)).toEqual(['Ack', 'Input']);
    const input = h.server().last('Input')!;
    expect(h.server().last('Ack')!.header.seq).toBe(input.header.seq - 1);
    const newest = (input.payload as InputPayload).frames.at(-1)!;
    // The seq the server stores with the frame, and echoes in lastInputSeq (docs/net.md A.7).
    expect(recorded.at(-1)).toMatchObject({ tick: newest.tick, seq: input.header.seq });
  });

  it('batchSends: false sends every message in its own frame at once', async () => {
    const h = harness({ batchSends: false, inputScheduling: 'manual' });
    await playing(h);
    expect(h.server().frames.slice(0, 3)).toEqual([['Hello'], ['Ready'], ['Ping']]);
    h.server().snapshot(snapshot(h, 200));
    h.timers.flush();
    expect(h.server().frames.at(-1)).toEqual(['Ack']);
    expect(h.server().frames.every((names) => names.length === 1)).toBe(true);
  });
});
