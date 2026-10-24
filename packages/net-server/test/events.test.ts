import {
  ByteReader,
  ByteWriter,
  decodeEvents,
  EncodeError,
  encodeEvents,
  type EventsData,
  nextSeq,
  readFrame,
  REGION_IDX_NONE,
} from '@conduit/protocol';
import { Owner, Region, type ReplicatedEvent, Transform } from '@conduit/sim';
import { describe, expect, it } from 'vitest';
import { createConn } from '../src/client-conn.ts';
import { BACKPRESSURE_SKIP_BYTES, PENDING_EVENTS_MAX } from '../src/constants.ts';
import {
  eventsData,
  queueEvent,
  splitEvents,
  takeEvents,
  wantsEvent,
} from '../src/events-outbox.ts';
import type { PlayerInfo, PlayerSpawn } from '../src/session.ts';
import { createStats } from '../src/stats.ts';
import { FakeLink } from './fake-link.ts';
import {
  createHarness,
  eventsOf,
  type Harness,
  Horn,
  joinAndSpawn,
  Log,
  Notice,
  payloadOf,
  scriptedEvents,
  SPAWN_REGION,
  testGame,
  Weather,
} from './harness.ts';

const FAR_REGION = 'cell/3_3';
const SHARED_REGION = 'cell/2_2';

function event(tick: number, regionId: string | undefined, typeId = 0): ReplicatedEvent {
  return { typeId, tick, regionId, payload: { entity: 1, pitch: tick % 256 } };
}

/** Steps until the last simulated tick is a snapshot tick. */
async function alignToSnapshot(h: Harness): Promise<void> {
  while (h.session.tick % h.game.snapshotEvery !== 0) await h.step();
}

/** The entity of the player with `playerId`. */
function entityOf(h: Harness, playerId: number): number {
  const player = h.session.players().find((p) => p.playerId === playerId);
  if (player === undefined) throw new Error(`no player ${playerId}`);
  return player.entity;
}

describe('events-outbox', () => {
  it('wantsEvent: global events always; regional ones need the region wanted and reported', () => {
    const conn = createConn(new FakeLink(1), null, 0);
    conn.wantedRegions = new Set(['a', 'b']);
    conn.reportedRegions = new Set(['b', 'c']);
    expect(wantsEvent(conn, { regionId: undefined })).toBe(true);
    expect(wantsEvent(conn, { regionId: 'a' })).toBe(false); // wanted, not reported yet
    expect(wantsEvent(conn, { regionId: 'b' })).toBe(true);
    expect(wantsEvent(conn, { regionId: 'c' })).toBe(false); // reported, no longer wanted
    expect(wantsEvent(conn, { regionId: 'd' })).toBe(false);
  });

  it(`queueEvent keeps the newest ${PENDING_EVENTS_MAX} in order and counts the dropped oldest`, () => {
    const conn = createConn(new FakeLink(1), null, 0);
    const stats = createStats();
    for (let t = 1; t <= PENDING_EVENTS_MAX; t++) queueEvent(conn, event(t, 'r'), stats);
    expect(conn.pendingEvents).toHaveLength(PENDING_EVENTS_MAX);
    expect(stats.eventsDropped).toBe(0);
    for (let t = PENDING_EVENTS_MAX + 1; t <= PENDING_EVENTS_MAX + 10; t++) {
      queueEvent(conn, event(t, 'r'), stats);
    }
    expect(conn.pendingEvents).toHaveLength(PENDING_EVENTS_MAX);
    expect(stats.eventsDropped).toBe(10);
    expect(conn.pendingEvents.map((e) => e.tick)).toEqual(
      Array.from({ length: PENDING_EVENTS_MAX }, (_, i) => i + 11),
    );
    queueEvent(conn, event(999, 'r')); // without stats: still capped
    expect(conn.pendingEvents).toHaveLength(PENDING_EVENTS_MAX);
  });

  it('takeEvents empties the queue into one payload: first-use region table, NONE for global, eventId = typeId', () => {
    const registry = testGame().registry;
    const horn = registry.eventId(Horn);
    const weather = registry.eventId(Weather);
    const conn = createConn(new FakeLink(1), null, 0);
    const queued: ReplicatedEvent[] = [
      { typeId: horn, tick: 5, regionId: 'cell/1_1', payload: { entity: 7, pitch: 1 } },
      { typeId: weather, tick: 5, regionId: undefined, payload: { kind: 'rain' } },
      { typeId: horn, tick: 6, regionId: 'cell/0_0', payload: { entity: 8, pitch: 2 } },
      { typeId: horn, tick: 6, regionId: 'cell/1_1', payload: { entity: 7, pitch: 3 } },
    ];
    for (const ev of queued) queueEvent(conn, ev);
    const pending = conn.pendingEvents;
    const data = takeEvents(conn);
    expect(conn.pendingEvents).toEqual([]);
    expect(conn.pendingEvents).not.toBe(pending);
    expect(data).toEqual({
      regions: ['cell/1_1', 'cell/0_0'],
      events: [
        { eventId: horn, tick: 5, regionIdx: 0, payload: { entity: 7, pitch: 1 } },
        { eventId: weather, tick: 5, regionIdx: REGION_IDX_NONE, payload: { kind: 'rain' } },
        { eventId: horn, tick: 6, regionIdx: 1, payload: { entity: 8, pitch: 2 } },
        { eventId: horn, tick: 6, regionIdx: 0, payload: { entity: 7, pitch: 3 } },
      ],
    });
    expect(data.events[0]?.payload).toBe(queued[0]?.payload); // shared, not copied
    const w = new ByteWriter();
    encodeEvents(w, registry, data);
    expect(decodeEvents(new ByteReader(w.finish()), registry)).toEqual(data);
    expect(takeEvents(conn)).toEqual({ regions: [], events: [] });
  });

  it('splitEvents halves a payload in order, each half with its own region table', () => {
    const data = eventsData([
      event(1, 'r1'),
      event(1, 'r2'),
      event(2, undefined),
      event(2, 'r2'),
      event(3, 'r3'),
    ]);
    const [first, second] = splitEvents(data);
    expect(first).toEqual(eventsData([event(1, 'r1'), event(1, 'r2')]));
    expect(second).toEqual(eventsData([event(2, undefined), event(2, 'r2'), event(3, 'r3')]));
    expect(second.regions).toEqual(['r2', 'r3']);
    expect(second.events.map((e) => e.regionIdx)).toEqual([REGION_IDX_NONE, 0, 1]);
    expect(() => splitEvents(eventsData([event(1, 'r1')]))).toThrow(RangeError);
  });
});

describe('replicated events through a Session (docs/net.md A.8.3)', () => {
  it('ride in the frame of the next snapshot, right after the Snapshot message, in tick then emission order', async () => {
    const script = scriptedEvents();
    const h = await createHarness({ systems: [script.system] });
    const a = h.client();
    await joinAndSpawn(h, a, 'a');
    const entity = entityOf(h, 0);
    await alignToSnapshot(h);
    a.take();
    const t0 = h.session.tick;
    script.at(t0 + 1, Horn, { entity, pitch: 1 }, SPAWN_REGION);
    script.at(t0 + 2, Weather, { kind: 'rain' });
    script.at(t0 + 2, Horn, { entity, pitch: 2 }, SPAWN_REGION);
    await h.step(2);
    expect(a.names()).toEqual([]); // not snapshot ticks: the events wait
    h.session.send(0, Notice, { code: 9 });
    await h.step();

    const got = a.take();
    expect(got.map((m) => m.name)).toEqual(['Snapshot', 'Events', 'Notice']);
    expect(new Set(got.map((m) => m.frame)).size).toBe(1);
    expect(got.map((m) => m.tick)).toEqual([t0 + 3, t0 + 3, t0 + 3]);
    expect(got[1]?.seq).toBe(nextSeq(got[0]?.seq as number));
    const registry = h.game.registry;
    expect(payloadOf<EventsData>(got, 'Events')).toEqual({
      regions: [SPAWN_REGION],
      events: [
        {
          eventId: registry.eventId(Horn),
          tick: t0 + 1,
          regionIdx: 0,
          payload: { entity, pitch: 1 },
        },
        {
          eventId: registry.eventId(Horn),
          tick: t0 + 2,
          regionIdx: 0,
          payload: { entity, pitch: 2 },
        },
        {
          eventId: registry.eventId(Weather),
          tick: t0 + 2,
          regionIdx: REGION_IDX_NONE,
          payload: { kind: 'rain' },
        },
      ],
    });

    await h.step(3); // nothing new: the next snapshot carries no Events
    expect(a.names()).toEqual(['Snapshot']);
  });

  it('filter regional events by wanted ∩ reported; global events reach every playing client and no one else', async () => {
    const script = scriptedEvents();
    const spawnIn =
      (regionId: string) =>
      (player: PlayerInfo): PlayerSpawn => ({
        regionId,
        spawn: (ctx) => {
          const e = ctx.world.create();
          ctx.world.add(e, Region, { id: regionId });
          ctx.world.add(e, Transform, { pos: { x: 32, y: 0, z: 32 } });
          ctx.world.add(e, Owner, { player: player.playerId });
          return e;
        },
      });
    const h = await createHarness({
      systems: [script.system],
      hooks: {
        onPlayerJoin: (player) =>
          spawnIn(player.displayName === 'far' ? FAR_REGION : SPAWN_REGION)(player),
      },
    });
    const near = h.session.interest.wantedForRegion(SPAWN_REGION);
    const far = h.session.interest.wantedForRegion(FAR_REGION);
    expect(near).toContain(SHARED_REGION);
    expect(far).toContain(SHARED_REGION);
    expect(far).not.toContain(SPAWN_REGION);
    const unreported = near.find((r) => r !== SPAWN_REGION && r !== SHARED_REGION) as string;
    expect(far).not.toContain(unreported);

    const a = h.client();
    const b = h.client();
    const c = h.client();
    await joinAndSpawn(h, a, 'a');
    await joinAndSpawn(h, b, 'b');
    await joinAndSpawn(h, c, 'far');
    const joinedOnly = h.client();
    joinedOnly.hello({ displayName: 'd' }); // joined, never Ready: no events
    b.regionLoadState(near.filter((r) => r !== unreported));
    await alignToSnapshot(h);
    for (const client of [a, b, c, joinedOnly]) client.take();

    const t = h.session.tick + 1;
    const entity = entityOf(h, 0);
    script.at(t, Horn, { entity, pitch: 1 }, SPAWN_REGION);
    script.at(t, Horn, { entity, pitch: 2 }, unreported);
    script.at(t, Horn, { entity, pitch: 3 }, SHARED_REGION);
    script.at(t, Horn, { entity, pitch: 4 }, FAR_REGION);
    script.at(t, Weather, { kind: 'snow' });
    await h.step(3);

    const horn = (pitch: number, region: string) => ({
      name: 'Horn',
      tick: t,
      region,
      payload: { entity, pitch },
    });
    const weather = { name: 'Weather', tick: t, region: null, payload: { kind: 'snow' } };
    const registry = h.game.registry;
    expect(eventsOf(registry, a.take())).toEqual([
      horn(1, SPAWN_REGION),
      horn(2, unreported),
      horn(3, SHARED_REGION),
      weather,
    ]);
    expect(eventsOf(registry, b.take())).toEqual([
      horn(1, SPAWN_REGION),
      horn(3, SHARED_REGION),
      weather,
    ]);
    expect(eventsOf(registry, c.take())).toEqual([
      horn(3, SHARED_REGION),
      horn(4, FAR_REGION),
      weather,
    ]);
    expect(joinedOnly.names()).not.toContain('Events');
    expect(h.session.stats.eventsDropped).toBe(0);
  });

  it(`a backpressured client keeps the newest ${PENDING_EVENTS_MAX} events and gets them with its next snapshot`, async () => {
    const script = scriptedEvents();
    const h = await createHarness({ systems: [script.system] });
    const a = h.client();
    await joinAndSpawn(h, a, 'a');
    const entity = entityOf(h, 0);
    await alignToSnapshot(h);
    a.take();
    const t0 = h.session.tick;
    const perTick = 50;
    for (let i = 1; i <= 6; i++) {
      for (let pitch = 0; pitch < perTick; pitch++) {
        script.at(t0 + i, Horn, { entity, pitch }, SPAWN_REGION);
      }
    }
    a.link.buffered = BACKPRESSURE_SKIP_BYTES + 1;
    await h.step(6);
    expect(a.names()).toEqual([]);
    expect(h.session.stats.skipped).toBe(2);
    const dropped = 6 * perTick - PENDING_EVENTS_MAX;
    expect(h.session.stats.eventsDropped).toBe(dropped);

    a.link.buffered = 0;
    await h.step(3);
    const got = a.take();
    expect(got.map((m) => m.name)).toEqual(['Snapshot', 'Events']);
    const expected: [number, number][] = [];
    for (let i = 1; i <= 6; i++) {
      for (let pitch = 0; pitch < perTick; pitch++) expected.push([t0 + i, pitch]);
    }
    expect(
      eventsOf(h.game.registry, got).map((e) => [e.tick, (e.payload as { pitch: number }).pitch]),
    ).toEqual(expected.slice(dropped));
  });

  it('a client on the halved rate gets its events in their own frame on the snapshot ticks it skips, unless backpressured', async () => {
    const script = scriptedEvents();
    const h = await createHarness({ systems: [script.system] });
    const a = h.client();
    await joinAndSpawn(h, a, 'a');
    const entity = entityOf(h, 0);
    // No acks: past 20 outstanding snapshots the rate halves.
    const sent: number[] = [];
    for (let i = 0; i < 30 * 3; i++) {
      await h.step();
      if (a.names().includes('Snapshot')) sent.push(h.session.tick);
    }
    expect((sent.at(-1) as number) - (sent.at(-2) as number)).toBe(6);
    let got = a.take();
    while (!got.some((m) => m.name === 'Snapshot')) {
      await h.step();
      got = a.take();
    }
    const s = h.session.tick; // a tick the halved rate sends; s + 3 is one it skips

    script.at(s + 1, Horn, { entity, pitch: 1 }, SPAWN_REGION);
    await h.step(3);
    const own = a.take();
    expect(own.map((m) => m.name)).toEqual(['Events']);
    expect(own[0]?.tick).toBe(s + 3);
    expect(eventsOf(h.game.registry, own)).toEqual([
      { name: 'Horn', tick: s + 1, region: SPAWN_REGION, payload: { entity, pitch: 1 } },
    ]);

    script.at(s + 4, Horn, { entity, pitch: 2 }, SPAWN_REGION);
    a.link.buffered = BACKPRESSURE_SKIP_BYTES + 1;
    await h.step(6); // s + 6 skipped for backpressure, s + 9 by the halved rate while still backpressured
    expect(a.names()).toEqual([]);
    a.link.buffered = 0;
    await h.step(3);
    const next = a.take();
    expect(next.map((m) => m.name)).toEqual(['Snapshot', 'Events']);
    expect(eventsOf(h.game.registry, next)).toEqual([
      { name: 'Horn', tick: s + 4, region: SPAWN_REGION, payload: { entity, pitch: 2 } },
    ]);
  });

  it('drops an event that does not encode once, with one error, and still sends the rest', async () => {
    const script = scriptedEvents();
    const h = await createHarness({ systems: [script.system] });
    const a = h.client();
    const b = h.client();
    await joinAndSpawn(h, a, 'a');
    await joinAndSpawn(h, b, 'b');
    const entity = entityOf(h, 0);
    await alignToSnapshot(h);
    a.take();
    b.take();
    const errors = h.session.stats.tickErrors;
    const t = h.session.tick + 1;
    script.at(t, Horn, { entity, pitch: 300 }, SPAWN_REGION); // u8 out of range
    script.at(t, Weather, { kind: 'fog' });
    await h.step(3);
    expect(h.session.stats.tickErrors).toBe(errors + 1);
    const errorLogs = h.log.mock.calls.filter(([level]) => level === 'error');
    expect(errorLogs).toEqual([
      ['error', `tick ${t}: replicated event Horn dropped`, expect.any(EncodeError)],
    ]);
    for (const client of [a, b]) {
      const got = client.take();
      expect(got.map((m) => m.name)).toEqual(['Snapshot', 'Events']);
      expect(eventsOf(h.game.registry, got)).toEqual([
        { name: 'Weather', tick: t, region: null, payload: { kind: 'fog' } },
      ]);
    }
  });

  it('splits events that do not fit one payload into several Events messages, in order', async () => {
    const script = scriptedEvents();
    const h = await createHarness({ systems: [script.system] });
    const a = h.client();
    await joinAndSpawn(h, a, 'a');
    await alignToSnapshot(h);
    a.take();
    const t = h.session.tick + 1;
    const lines = Array.from({ length: 40 }, (_, i) => `${i}:`.padEnd(4000, 'x'));
    for (const line of lines) script.at(t, Log, { line }, SPAWN_REGION);
    await h.step(3);
    for (const frame of a.link.sent) {
      expect(frame.byteLength).toBeLessThanOrEqual(65546);
      readFrame(frame, (header) => {
        expect(header.length).toBeLessThanOrEqual(65535);
      });
    }
    const got = a.take();
    // The hard frame budget packs complete ordered event prefixes into three bounded frames.
    expect(got.map((m) => m.name)).toEqual(['Snapshot', 'Events', 'Events', 'Events']);
    expect(new Set(got.map((m) => m.frame)).size).toBe(3);
    const events = eventsOf(h.game.registry, got);
    expect(events.map((e) => (e.payload as { line: string }).line)).toEqual(lines);
    expect(events.every((e) => e.region === SPAWN_REGION && e.tick === t)).toBe(true);
    expect(h.session.stats.tickErrors).toBe(0);
  });

  it('after a reconnect, no event queued before or during the outage is delivered', async () => {
    const script = scriptedEvents();
    const h = await createHarness({ systems: [script.system] });
    const a = h.client();
    const seen = await joinAndSpawn(h, a, 'a');
    const token = payloadOf<{ reconnectToken: string }>(seen, 'Welcome').reconnectToken;
    const entity = entityOf(h, 0);
    await alignToSnapshot(h);
    a.take();
    const t0 = h.session.tick;
    script.at(t0 + 1, Horn, { entity, pitch: 1 }, SPAWN_REGION); // queued, then the link drops
    script.at(t0 + 2, Weather, { kind: 'hail' }); // while away
    await h.step();
    a.link.remoteClose(1006);
    await h.step(5);

    const again = h.client();
    again.hello({ displayName: 'a', reconnectToken: token });
    const regionSet = payloadOf<{ active: string[] }>(again.take(), 'RegionSet');
    again.regionLoadState(regionSet.active);
    const t1 = h.session.tick + 1;
    script.at(t1, Horn, { entity, pitch: 3 }, SPAWN_REGION);
    await alignToSnapshot(h);
    if (h.session.tick < t1) await h.step(3);
    expect(eventsOf(h.game.registry, again.take())).toEqual([
      { name: 'Horn', tick: t1, region: SPAWN_REGION, payload: { entity, pitch: 3 } },
    ]);
  });
});
