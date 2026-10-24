import { KickReason, PlayerState, type SnapshotData } from '@conduit/protocol';
import { defineSystem, Region, Transform } from '@conduit/sim';
import { describe, expect, it } from 'vitest';
import { ackTimedOut, halvedRateSkips, shouldSkip, updateDivisor } from '../src/backpressure.ts';
import { createConn, recordSent } from '../src/client-conn.ts';
import {
  ACK_TIMEOUT_MS,
  BACKPRESSURE_HALVE_OUTSTANDING,
  BACKPRESSURE_SKIP_BYTES,
  CloseCode,
} from '../src/constants.ts';
import { FakeLink } from './fake-link.ts';
import {
  Crate,
  createHarness,
  eventsOf,
  Horn,
  joinAndSpawn,
  Notice,
  scriptedEvents,
  snapshotsOf,
  SPAWN_REGION,
  Weather,
} from './harness.ts';

describe('backpressure rules', () => {
  it('shouldSkip above BACKPRESSURE_SKIP_BYTES buffered', () => {
    const link = new FakeLink(1);
    const conn = createConn(link, null, 0);
    link.buffered = BACKPRESSURE_SKIP_BYTES;
    expect(shouldSkip(conn)).toBe(false);
    link.buffered = BACKPRESSURE_SKIP_BYTES + 1;
    expect(shouldSkip(conn)).toBe(true);
    conn.link = null;
    expect(shouldSkip(conn)).toBe(false);
  });

  it('updateDivisor halves above 20 outstanding with a fixed phase and restores at 20', () => {
    const conn = createConn(new FakeLink(1), null, 0);
    for (let i = 1; i <= 21; i++) recordSent(conn, { tick: i * 3, sentAtMs: 0, bytes: 1 });
    expect(conn.outstandingSnapshots()).toBe(21);
    updateDivisor(conn, 66, 3);
    expect(conn.snapshotDivisor).toBe(2);
    expect(conn.snapshotPhase).toBe(22 % 2);
    expect(halvedRateSkips(conn, 66, 3)).toBe(false);
    expect(halvedRateSkips(conn, 69, 3)).toBe(true);
    expect(halvedRateSkips(conn, 72, 3)).toBe(false);
    updateDivisor(conn, 69, 3); // still above: the phase does not move
    expect(conn.snapshotPhase).toBe(0);
    conn.lastAckedTick = 3; // 20 outstanding
    expect(conn.outstandingSnapshots()).toBe(BACKPRESSURE_HALVE_OUTSTANDING);
    updateDivisor(conn, 72, 3);
    expect(conn.snapshotDivisor).toBe(1);
    expect(halvedRateSkips(conn, 75, 3)).toBe(false);
  });

  it('outstandingSnapshots stays correct after the ring evicts', () => {
    const conn = createConn(new FakeLink(1), null, 0);
    for (let i = 1; i <= 40; i++) recordSent(conn, { tick: i, sentAtMs: 0, bytes: 1 });
    expect(conn.sentLog).toHaveLength(32);
    expect(conn.outstandingSnapshots()).toBe(32);
    conn.lastAckedTick = 30;
    expect(conn.outstandingSnapshots()).toBe(10);
  });

  it('ackTimedOut needs outstanding snapshots and more than the timeout since the last ack', () => {
    const conn = createConn(new FakeLink(1), null, 1000);
    expect(ackTimedOut(conn, 1000 + ACK_TIMEOUT_MS + 1)).toBe(false);
    recordSent(conn, { tick: 3, sentAtMs: 1000, bytes: 1 });
    expect(ackTimedOut(conn, 1000 + ACK_TIMEOUT_MS)).toBe(false);
    expect(ackTimedOut(conn, 1000 + ACK_TIMEOUT_MS + 1)).toBe(true);
    expect(ackTimedOut(conn, 1500, 400)).toBe(true);
  });
});

describe('a slow client', () => {
  async function playingClient() {
    const throttles: (number | undefined)[] = [];
    const probe = defineSystem('probe', 'input', (ctx) => {
      throttles.push((ctx.inputs(0) as { throttle?: number } | undefined)?.throttle);
    });
    const script = scriptedEvents();
    const h = await createHarness({ systems: [probe, script.system] });
    const a = h.client();
    const b = h.client();
    await joinAndSpawn(h, a, 'a');
    await joinAndSpawn(h, b, 'b');
    await h.step(3);
    a.take();
    b.take();
    return { h, a, b, throttles, script };
  }

  function lastSnapshot(snaps: SnapshotData[]): SnapshotData {
    const snap = snaps.at(-1);
    if (snap === undefined) throw new Error('no snapshot');
    return snap;
  }

  it('skips snapshots above 64 KB buffered without touching known; queued events and messages follow', async () => {
    const { h, a, script } = await playingClient();
    const world = h.session.world;
    await h.step(3);
    const before = lastSnapshot(snapshotsOf(a.take()));
    const baseline = before.header.serverTick;
    a.ack(baseline);

    a.link.buffered = BACKPRESSURE_SKIP_BYTES + 1;
    const crate = h.session.regions.entitiesIn(SPAWN_REGION).find((e) => world.has(e, Crate));
    expect(crate).toBeDefined();
    world.destroy(crate as number);
    const fresh = world.create();
    world.add(fresh, Region, { id: SPAWN_REGION });
    world.add(fresh, Transform, { pos: { x: 10, y: 0, z: 10 } });
    world.add(fresh, Crate, {});
    const t0 = h.session.tick;
    script.at(t0 + 1, Horn, { entity: fresh, pitch: 1 }, SPAWN_REGION);
    script.at(t0 + 4, Weather, { kind: 'wind' });
    script.at(t0 + 8, Horn, { entity: fresh, pitch: 2 }, SPAWN_REGION);
    h.session.send(0, Notice, { code: 1 });
    await h.step(6);
    h.session.send(0, Notice, { code: 2 });
    await h.step(3);
    expect(snapshotsOf(a.take())).toEqual([]);
    expect(h.session.stats.skipped).toBe(3);
    expect(a.link.closedWith).toBeNull();

    a.link.buffered = 0;
    await h.step(3);
    const got = a.take();
    expect(got.map((m) => m.name)).toEqual(['Snapshot', 'Events', 'Notice', 'Notice']);
    expect(new Set(got.map((m) => m.frame)).size).toBe(1);
    expect(eventsOf(h.game.registry, got)).toEqual([
      { name: 'Horn', tick: t0 + 1, region: SPAWN_REGION, payload: { entity: fresh, pitch: 1 } },
      { name: 'Weather', tick: t0 + 4, region: null, payload: { kind: 'wind' } },
      { name: 'Horn', tick: t0 + 8, region: SPAWN_REGION, payload: { entity: fresh, pitch: 2 } },
    ]);
    expect(got.slice(2).map((m) => m.payload)).toEqual([{ code: 1 }, { code: 2 }]);
    const after = got[0]?.payload as SnapshotData;
    expect(after.header.baselineTick).toBe(baseline);
    expect(after.destroys).toEqual([crate]);
    expect(after.creates.map((c) => c.entity)).toEqual([fresh]);
  });

  it('halves the rate at 21 outstanding snapshots and restores it at 20', async () => {
    const { h, a } = await playingClient();
    const sentTicks: number[] = [];
    const collect = () => {
      for (const s of snapshotsOf(a.take())) sentTicks.push(s.header.serverTick);
    };
    // Ack everything so far, then stop acking.
    await h.step(3);
    collect();
    a.ack(sentTicks.at(-1) as number);
    sentTicks.length = 0;
    for (let i = 0; i < 21 * 3; i++) {
      await h.step();
      collect();
    }
    expect(sentTicks).toHaveLength(21);
    const step = async () => {
      await h.step(3);
      collect();
    };
    for (let i = 0; i < 7; i++) await step();
    const halved = sentTicks.slice(21);
    expect(halved).toHaveLength(4); // every other snapshot tick: sent, skipped, sent, ...
    for (let i = 1; i < halved.length; i++) {
      expect((halved[i] as number) - (halved[i - 1] as number)).toBe(6);
    }

    // The next snapshot tick would be skipped at the halved rate. An ack that leaves exactly 20
    // outstanding restores the full rate before it.
    const all = [...sentTicks];
    a.ack(all[all.length - 21] as number);
    const lastSent = all.at(-1) as number;
    sentTicks.length = 0;
    await step();
    expect(sentTicks).toEqual([lastSent + 3]); // a tick the halved rate skips
  });

  it('kicks with AckTimeout and 4007 after 10 s without an Ack, and the player goes away', async () => {
    const { h, a, b } = await playingClient();
    b.link.buffered = 0;
    // b keeps acking so only a times out.
    let kicked = false;
    for (let i = 0; i < 700 && !kicked; i++) {
      await h.step();
      const bSnaps = snapshotsOf(b.take());
      const last = bSnaps.at(-1);
      if (last !== undefined) b.ack(last.header.serverTick);
      kicked = a.link.closedWith !== null;
    }
    expect(kicked).toBe(true);
    expect(h.clock.ms).toBeGreaterThan(ACK_TIMEOUT_MS);
    const got = a.take();
    expect(got.at(-1)).toMatchObject({
      name: 'Kicked',
      payload: { reason: KickReason.AckTimeout },
    });
    expect(a.link.closedWith?.code).toBe(CloseCode.AckTimeout);
    expect(h.session.stats.ackTimeouts).toBe(1);
    expect(h.session.players().map((p) => p.state)).toEqual([
      PlayerState.Away,
      PlayerState.Playing,
    ]);
    expect(b.link.closedWith).toBeNull();
  });

  it('consumes input while skipped or halved', async () => {
    const { h, a, throttles } = await playingClient();
    a.link.buffered = BACKPRESSURE_SKIP_BYTES * 4;
    throttles.length = 0;
    const next = h.session.tick + 1;
    for (let i = 0; i < 30; i++) {
      a.input([next + i], i + 1);
      await h.step();
    }
    expect(throttles).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(snapshotsOf(a.take())).toEqual([]);
    expect(h.session.stats.skipped).toBe(10);
  });
});
