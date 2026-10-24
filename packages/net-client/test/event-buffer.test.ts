import {
  type EventsData,
  CoreKind,
  encodeEvents,
  FrameWriter,
  f,
  REGION_IDX_NONE,
  SchemaRegistry,
  SNAPSHOT_FLAG_FULL,
  type SnapshotData,
} from '@conduit/protocol';
import { defineEvent, Transform } from '@conduit/sim';
import { describe, expect, it } from 'vitest';
import {
  EVENT_BUFFER_MAX,
  EventBuffer,
  gcLagTicks,
  MemoryTransport,
  NetClient,
  RECONNECT_DELAYS_MS,
  type ReplicatedEventInfo,
} from '../src/index.ts';
import {
  Chat,
  ManualTimers,
  Notice,
  ScriptedServer,
  Shout,
  TEST_COMPONENTS,
  testGame,
  TestInput,
} from './helpers.ts';

const Horn = defineEvent('Horn', { entity: f.entity(), pitch: f.u8 });
const Quake = defineEvent('Quake', { strength: f.u8 });
const Local = defineEvent('Local', { n: f.u8 }, { replicate: false });

function eventRegistry(): SchemaRegistry {
  return new SchemaRegistry({
    components: TEST_COMPONENTS,
    messages: [Chat, Notice, Shout],
    events: [Horn, Local, Quake],
    input: TestInput,
  });
}

function horn(registry: SchemaRegistry, tick: number, pitch: number, regionIdx = REGION_IDX_NONE) {
  return { eventId: registry.eventId(Horn), tick, regionIdx, payload: { entity: 9, pitch } };
}

/** Pitches of the events `buffer.shiftDue(renderTick)` hands out. */
function drain(buffer: EventBuffer, renderTick: number): number[] {
  const out: number[] = [];
  for (let ev = buffer.shiftDue(renderTick); ev !== undefined; ev = buffer.shiftDue(renderTick)) {
    out.push((ev.payload as { pitch: number }).pitch);
  }
  return out;
}

describe('EventBuffer', () => {
  it('turns an Events payload into { def, tick, regionId, payload } with the registry def and region names', () => {
    const registry = eventRegistry();
    const buffer = new EventBuffer(registry);
    const quake = {
      eventId: registry.eventId(Quake),
      tick: 7,
      regionIdx: 1,
      payload: { strength: 3 },
    };
    const data: EventsData = {
      regions: ['cell/0_0', 'cell/1_1'],
      events: [horn(registry, 7, 1, 0), quake, horn(registry, 8, 2)],
    };
    buffer.push(data);
    expect(buffer.length).toBe(3);
    const first = buffer.shiftDue(7);
    expect(first).toEqual({
      def: Horn,
      tick: 7,
      regionId: 'cell/0_0',
      payload: { entity: 9, pitch: 1 },
    });
    expect(first?.def).toBe(Horn);
    expect(Object.keys(first ?? {}).sort()).toEqual(['def', 'payload', 'regionId', 'tick']);
    const second = buffer.shiftDue(7);
    expect(second).toEqual({ def: Quake, tick: 7, regionId: 'cell/1_1', payload: { strength: 3 } });
    expect(second?.payload).toEqual(quake.payload);
    expect(second?.payload).not.toBe(quake.payload);
    expect(buffer.shiftDue(7)).toBeUndefined();
    expect(buffer.shiftDue(8)).toEqual({
      def: Horn,
      tick: 8,
      regionId: null,
      payload: { entity: 9, pitch: 2 },
    });
    expect(buffer.length).toBe(0);
  });

  it('dispatches in tick order, then arrival order, across batches', () => {
    const registry = eventRegistry();
    const buffer = new EventBuffer(registry);
    buffer.push({ regions: [], events: [horn(registry, 10, 1), horn(registry, 12, 2)] });
    buffer.push({ regions: [], events: [horn(registry, 10, 3), horn(registry, 11, 4)] });
    buffer.push({ regions: [], events: [horn(registry, 9, 5), horn(registry, 12, 6)] });
    expect(buffer.peek()?.tick).toBe(9);
    expect(drain(buffer, 100)).toEqual([5, 1, 3, 4, 2, 6]);
  });

  it('hands out nothing before the render tick reaches the event tick', () => {
    const registry = eventRegistry();
    const buffer = new EventBuffer(registry);
    buffer.push({ regions: [], events: [horn(registry, 10, 1), horn(registry, 11, 2)] });
    expect(drain(buffer, 0)).toEqual([]);
    expect(drain(buffer, 9.999)).toEqual([]);
    expect(drain(buffer, Number.NaN)).toEqual([]);
    expect(drain(buffer, 10)).toEqual([1]);
    expect(drain(buffer, 10.99)).toEqual([]);
    expect(drain(buffer, 11.01)).toEqual([2]);
  });

  it(`drops the oldest (tick, arrival) beyond the capacity (default ${EVENT_BUFFER_MAX}) and counts it`, () => {
    const registry = eventRegistry();
    expect(new EventBuffer(registry).capacity).toBe(EVENT_BUFFER_MAX);
    const buffer = new EventBuffer(registry, 4);
    buffer.push({ regions: [], events: [20, 21, 22, 23].map((t) => horn(registry, t, t)) });
    expect(buffer.dropped).toBe(0);
    buffer.push({ regions: [], events: [horn(registry, 24, 24), horn(registry, 21, 121)] });
    expect(buffer.length).toBe(4);
    expect(buffer.dropped).toBe(2);
    buffer.add({ def: Horn, tick: 5, regionId: null, payload: { entity: 9, pitch: 5 } }); // older than all: dropped itself
    expect(buffer.dropped).toBe(3);
    expect(drain(buffer, 100)).toEqual([121, 22, 23, 24]);
    expect(() => new EventBuffer(registry, 0)).toThrow(RangeError);
  });

  it('clear() forgets everything (resync); a payload with a bad event or region index buffers nothing', () => {
    const registry = eventRegistry();
    const buffer = new EventBuffer(registry);
    buffer.push({ regions: [], events: [horn(registry, 1, 1), horn(registry, 2, 2)] });
    buffer.clear();
    expect(buffer.length).toBe(0);
    expect(buffer.shiftDue(100)).toBeUndefined();
    const local = {
      eventId: registry.eventId(Local),
      tick: 3,
      regionIdx: REGION_IDX_NONE,
      payload: { n: 1 },
    };
    expect(() => buffer.push({ regions: [], events: [horn(registry, 3, 3), local] })).toThrow(
      RangeError,
    );
    expect(() => buffer.push({ regions: ['a'], events: [horn(registry, 3, 3, 1)] })).toThrow(
      RangeError,
    );
    expect(buffer.length).toBe(0);
  });
});

describe('NetClient replicated events (docs/net.md B.7)', () => {
  function harness() {
    const timers = new ManualTimers();
    const registry = eventRegistry();
    let server: ScriptedServer | null = null;
    const client = new NetClient({
      url: 'memory://dev',
      game: testGame(registry),
      token: 'dev',
      displayName: 'Ann',
      transport: () => {
        const t = new MemoryTransport({ timers });
        server = new ScriptedServer(t.link, registry);
        return t;
      },
      now: timers.nowFn,
      timers,
      log: () => {},
    });
    const emitted: { ev: ReplicatedEventInfo; renderTick: number; previous: number }[] = [];
    let previous = 0;
    client.on('event', (ev) => {
      emitted.push({ ev, renderTick: client.clock.renderTick(), previous });
    });
    const frame = (ms = 16): void => {
      timers.advance(ms);
      previous = client.clock.renderTick();
      client.update();
    };
    const srv = (): ScriptedServer => {
      if (server === null) throw new Error('not connected');
      return server;
    };
    return { timers, registry, client, emitted, frame, server: srv };
  }

  async function joined(h: ReturnType<typeof harness>): Promise<void> {
    const connected = h.client.connect();
    h.timers.flush();
    h.server().welcome(); // serverTick 120 at serverTimeMs 2000
    h.timers.flush();
    await connected;
    expect(h.client.state).toBe('Joined');
  }

  it('buffers Events on arrival and emits each once from update() when the render tick reaches its tick', async () => {
    const h = harness();
    await joined(h);
    h.frame();
    const start = h.client.clock.renderTick();
    expect(start).toBeGreaterThan(100);
    const t1 = Math.floor(start) + 4;
    const t2 = Math.floor(start) + 9;
    h.server().events(
      {
        regions: ['cell/1_1'],
        events: [horn(h.registry, t1, 1, 0), horn(h.registry, t2, 2), horn(h.registry, t2, 3, 0)],
      },
      t2,
    );
    h.timers.flush();
    expect(h.emitted).toEqual([]); // not on arrival
    for (let i = 0; i < 30; i++) h.frame();
    expect(h.emitted.map((e) => e.ev)).toMatchObject([
      { def: Horn, tick: t1, regionId: 'cell/1_1', payload: { entity: 9, pitch: 1 } },
      { def: Horn, tick: t2, regionId: null, payload: { entity: 9, pitch: 2 } },
      { def: Horn, tick: t2, regionId: 'cell/1_1', payload: { entity: 9, pitch: 3 } },
    ]);
    for (const { ev, renderTick, previous } of h.emitted) {
      expect(renderTick).toBeGreaterThanOrEqual(ev.tick); // never before the render tick reaches it
      expect(previous).toBeLessThan(ev.tick); // on the first update that reached it
    }

    // An event already behind the render tick when it arrives goes out on the next update.
    const late = Math.floor(h.client.clock.renderTick()) - 3;
    h.server().events({ regions: [], events: [horn(h.registry, late, 4)] }, late);
    h.timers.flush();
    expect(h.emitted).toHaveLength(3);
    h.frame();
    expect(h.emitted.map((e) => e.ev.tick)).toEqual([t1, t2, t2, late]);
  });

  it('shares immutable arrival/presentation identities and distinguishes u16 sequence wrap', async () => {
    const h = harness();
    await joined(h);
    h.frame();
    const arrivals: ReplicatedEventInfo[] = [];
    h.client.on('authoritativeEvent', (event) => arrivals.push(event));
    const tick = Math.floor(h.client.clock.renderTick()) + 3;
    const send = (seq: number, at: number, pitch: number) => {
      const writer = new FrameWriter();
      writer.begin();
      writer.message(CoreKind.Events, at, seq, (w) =>
        encodeEvents(w, h.registry, { regions: [], events: [horn(h.registry, at, pitch)] }),
      );
      const encoded = writer.finish();
      h.server().sendRaw(encoded);
      return encoded;
    };
    const repeated = send(65535, tick, 1);
    h.server().sendRaw(repeated);
    send(0, tick + 1, 2);
    h.timers.flush();
    expect(arrivals).toHaveLength(2);
    expect(h.emitted).toHaveLength(0);
    expect(arrivals[0]!.id).not.toBe(arrivals[1]!.id);
    expect(Object.isFrozen(arrivals[0])).toBe(true);
    expect(Object.isFrozen(arrivals[0]!.payload)).toBe(true);
    for (let frame = 0; frame < 20; frame++) h.frame();
    expect(h.emitted[0]!.ev).toBe(arrivals[0]);
    expect(h.emitted[1]!.ev).toBe(arrivals[1]);
    h.client.disconnect();
  });

  it('ignores Events before Welcome, and forgets buffered events on disconnect', async () => {
    const h = harness();
    const connected = h.client.connect();
    h.timers.flush();
    expect(h.client.state).toBe('Handshaking');
    h.server().events({ regions: [], events: [horn(h.registry, 1, 1)] });
    h.timers.flush();
    expect(h.client.stats().ignoredMessages).toBe(1);
    h.server().welcome();
    h.timers.flush();
    await connected;
    h.frame();
    const tick = Math.floor(h.client.clock.renderTick()) + 5;
    h.server().events({ regions: [], events: [horn(h.registry, tick, 2)] });
    h.timers.flush();
    h.client.disconnect();
    for (let i = 0; i < 30; i++) h.frame();
    expect(h.client.clock.renderTick()).toBeGreaterThan(tick);
    expect(h.emitted).toEqual([]);
  });

  it('the resync Welcome forgets events buffered from the lost connection; events of the new one go out as usual', async () => {
    const h = harness();
    await joined(h);
    h.server().regionSet(['cell/1_1']);
    h.server().spawned(2, 1);
    h.timers.flush();
    expect(h.client.state).toBe('Playing');
    h.frame();
    const lostTick = Math.floor(h.client.clock.renderTick()) + 60; // a second ahead of the render tick
    h.server().events({ regions: [], events: [horn(h.registry, lostTick, 1)] }, lostTick);
    h.timers.flush();
    h.server().link.drop(1006);
    h.timers.flush();
    expect(h.client.state).toBe('Reconnecting');
    h.timers.advance(RECONNECT_DELAYS_MS[0] as number); // the attempt opens and sends Hello
    const serverTick = 120 + Math.round(((h.timers.now - 1000) * 60) / 1000);
    h.server().welcome({ serverTick, serverTimeMs: Math.round((serverTick * 1000) / 60) });
    h.timers.flush();
    expect(h.client.state).toBe('Resyncing');
    h.server().events({ regions: [], events: [horn(h.registry, lostTick + 5, 2)] }, lostTick + 5);
    h.timers.flush();
    for (let i = 0; i < 90; i++) h.frame();
    expect(h.client.clock.renderTick()).toBeGreaterThan(lostTick + 5);
    expect(h.emitted.map((e) => (e.ev.payload as { pitch: number }).pitch)).toEqual([2]);
  });

  it('emits before gc in the same update: an entity destroyed at the event tick is still in the mirror for listeners', async () => {
    const h = harness();
    await joined(h);
    const tId = h.registry.componentId(Transform);
    const transform = {
      pos: { x: 1, y: 0, z: 2 },
      rot: { x: 0, y: 0, z: 0, w: 1 },
      vel: { x: 0, y: 0, z: 0 },
    };
    const snapshot = (tick: number, extra: Partial<SnapshotData>): SnapshotData => ({
      header: {
        serverTick: tick,
        serverTimeMs: Math.round((tick * 1000) / 60),
        baselineTick: 0,
        lastInputSeq: 0,
        lastInputTick: 0,
        flags: 0,
      },
      regions: [],
      creates: [],
      updates: [],
      destroys: [],
      ...extra,
    });
    h.server().regionSet(['cell/1_1']);
    h.server().spawned(2, 1);
    h.timers.flush();
    const created = snapshot(123, {
      creates: [
        { entity: 77, regionIdx: REGION_IDX_NONE, components: [{ id: tId, value: transform }] },
      ],
    });
    created.header.flags = SNAPSHOT_FLAG_FULL;
    h.server().snapshot(created);
    h.server().snapshot({
      ...snapshot(126, { destroys: [77] }),
      header: { ...snapshot(126, {}).header, baselineTick: 123 },
    });
    h.server().events({ regions: [], events: [horn(h.registry, 126, 1)] }, 126);
    h.timers.flush();
    expect(h.client.mirror.get(77)?.destroyedTick).toBe(126);

    let inMirror: boolean | null = null;
    h.client.on('event', () => {
      inMirror = h.client.mirror.has(77);
    });
    h.frame(1000); // a stalled tab: the render tick jumps far past 126 + GC_LAG_TICKS in one update
    expect(Math.floor(h.client.clock.renderTick()) - gcLagTicks(3)).toBeGreaterThan(126);
    expect(h.emitted.map((e) => e.ev.tick)).toEqual([126]);
    expect(inMirror).toBe(true);
    expect(h.client.mirror.has(77)).toBe(false); // collected after the event went out
  });
});
