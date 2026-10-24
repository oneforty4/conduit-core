import { defineEvent as defineProtocolEvent, f, SchemaRegistry } from '@conduit/protocol';
import { describe, expect, it } from 'vitest';
import { defineEvent, EventBus, MAX_OUTBOX, RegionChanged, World } from '../src/index.ts';
import { registryOf, TestInput } from './helpers.ts';

const Boom = defineEvent('Boom', { power: f.u8, at: f.vec3(f.f32) });
const Chime = defineEvent('Chime', { note: f.u8 });
const Thought = defineEvent('Thought', { n: f.u16 }, { replicate: false });

const eventRegistry = registryOf([], [Thought, RegionChanged, Chime, Boom]);

function setup(): { world: World; bus: EventBus } {
  const world = new World(eventRegistry);
  return { world, bus: new EventBus(world) };
}

describe('defineEvent', () => {
  it('defaults replicate to true; RegionChanged is local', () => {
    expect(Boom.replicate).toBe(true);
    expect(Thought.replicate).toBe(false);
    expect(RegionChanged.replicate).toBe(false);
    expect(RegionChanged.schema.descriptor).toBe('struct{entity:entity,from:str(64),to:str(64)}');
    expect(Boom.create()).toEqual({ power: 0, at: { x: 0, y: 0, z: 0 } });
    expect(() => defineEvent('bad name', {})).toThrow(RangeError);
  });

  it('EventBus takes ids from the registry (sorted by name)', () => {
    setup();
    expect([
      eventRegistry.eventId(Boom),
      eventRegistry.eventId(Chime),
      eventRegistry.eventId(RegionChanged),
      eventRegistry.eventId(Thought),
    ]).toEqual([0, 1, 2, 3]);
  });
});

describe('EventBus', () => {
  it('consume sees only this tick, in emit order, including events emitted a moment ago', () => {
    const { world, bus } = setup();
    world.tick = 4;
    bus.emit(Chime, { note: 1 });
    bus.emit(Boom, { power: 9, at: { x: 1, y: 2, z: 3 } }, 'cell/1_1');
    bus.emit(Chime, { note: 2 }, 'cell/0_0');
    expect(bus.consume(Chime)).toEqual([
      { tick: 4, regionId: undefined, payload: { note: 1 } },
      { tick: 4, regionId: 'cell/0_0', payload: { note: 2 } },
    ]);
    expect(bus.consume(Chime)).toBe(bus.consume(Chime));
    bus.emit(Chime, { note: 3 });
    expect(bus.consume(Chime).map((e) => e.payload.note)).toEqual([1, 2, 3]);
    expect(bus.consume(Boom)).toHaveLength(1);
    expect(bus.consume(Thought)).toEqual([]);
    bus.endTick();
    world.tick = 5;
    expect(bus.consume(Chime)).toEqual([]);
    bus.emit(Chime, { note: 4 });
    expect(bus.consume(Chime)).toEqual([{ tick: 5, regionId: undefined, payload: { note: 4 } }]);
  });

  it('emit copies the payload by value', () => {
    const { bus } = setup();
    const payload = { power: 1, at: { x: 1, y: 1, z: 1 } };
    bus.emit(Boom, payload);
    payload.power = 2;
    payload.at.x = 2;
    const [ev] = bus.consume(Boom);
    expect(ev?.payload).toEqual({ power: 1, at: { x: 1, y: 1, z: 1 } });
    expect(ev?.payload).not.toBe(payload);
    expect(ev?.payload.at).not.toBe(payload.at);
  });

  it('local events vanish at endTick and never reach the outbox', () => {
    const { world, bus } = setup();
    world.tick = 1;
    bus.emit(Thought, { n: 1 });
    bus.emit(RegionChanged, { entity: 5, from: 'a', to: 'b' });
    expect(bus.consume(Thought)).toHaveLength(1);
    bus.endTick();
    expect(bus.consume(Thought)).toEqual([]);
    expect(bus.consume(RegionChanged)).toEqual([]);
    expect(bus.drainOutbox()).toEqual([]);
  });

  it('replicated events reach drainOutbox with type id, tick and region, in type id then emit order', () => {
    const { world, bus } = setup();
    world.tick = 7;
    bus.emit(Chime, { note: 1 }, 'r1');
    bus.emit(Boom, { power: 3, at: { x: 0, y: 0, z: 0 } });
    bus.emit(Thought, { n: 9 });
    bus.emit(Chime, { note: 2 });
    bus.endTick();
    world.tick = 8;
    bus.emit(Boom, { power: 4, at: { x: 1, y: 0, z: 0 } }, 'r2');
    bus.endTick();
    const out = bus.drainOutbox();
    expect(out).toEqual([
      {
        typeId: eventRegistry.eventId(Boom),
        tick: 7,
        regionId: undefined,
        payload: { power: 3, at: { x: 0, y: 0, z: 0 } },
      },
      { typeId: eventRegistry.eventId(Chime), tick: 7, regionId: 'r1', payload: { note: 1 } },
      { typeId: eventRegistry.eventId(Chime), tick: 7, regionId: undefined, payload: { note: 2 } },
      {
        typeId: eventRegistry.eventId(Boom),
        tick: 8,
        regionId: 'r2',
        payload: { power: 4, at: { x: 1, y: 0, z: 0 } },
      },
    ]);
    expect(bus.drainOutbox()).toEqual([]);
    expect(bus.droppedEvents).toBe(0);
  });

  it('the outbox cap drops the oldest events and counts them', () => {
    const { world, bus } = setup();
    world.tick = 1;
    for (let i = 0; i < MAX_OUTBOX - 5; i++) bus.emit(Chime, { note: i % 256 });
    bus.endTick();
    expect(bus.droppedEvents).toBe(0);
    world.tick = 2;
    for (let i = 0; i < 15; i++) bus.emit(Boom, { power: i, at: { x: 0, y: 0, z: 0 } });
    bus.endTick();
    expect(bus.droppedEvents).toBe(10);
    const out = bus.drainOutbox();
    expect(out).toHaveLength(MAX_OUTBOX);
    expect(out[0]).toMatchObject({
      typeId: eventRegistry.eventId(Chime),
      tick: 1,
      payload: { note: 10 },
    });
    expect(out[MAX_OUTBOX - 16]).toMatchObject({ typeId: eventRegistry.eventId(Chime), tick: 1 });
    expect(out[MAX_OUTBOX - 15]).toMatchObject({
      typeId: eventRegistry.eventId(Boom),
      tick: 2,
      payload: { power: 0 },
    });
    expect(out[MAX_OUTBOX - 1]).toMatchObject({
      typeId: eventRegistry.eventId(Boom),
      tick: 2,
      payload: { power: 14 },
    });
    world.tick = 3;
    for (let i = 0; i < MAX_OUTBOX + 1; i++) bus.emit(Chime, { note: 0 });
    bus.endTick();
    expect(bus.droppedEvents).toBe(11);
    expect(bus.drainOutbox()).toHaveLength(MAX_OUTBOX);
  });

  it('rejects events outside the registry', () => {
    const { bus } = setup();
    const Stray = defineEvent('Stray', {});
    expect(() => bus.emit(Stray, {})).toThrow(RangeError);
    expect(() => bus.consume(Stray)).toThrow(RangeError);
  });

  it('accepts protocol EventDefs in the registry alongside sim event types', () => {
    const Raw = defineProtocolEvent('Raw', { n: f.u8 }, { replicate: true });
    const registry = new SchemaRegistry({
      components: [],
      messages: [],
      events: [Raw, Boom],
      input: TestInput,
    });
    const world = new World(registry);
    const bus = new EventBus(world);
    bus.emit(Boom, { power: 1, at: { x: 0, y: 0, z: 0 } });
    bus.endTick();
    expect(bus.drainOutbox().map((e) => e.typeId)).toEqual([0]);
  });
});
