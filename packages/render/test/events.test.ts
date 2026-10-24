import { defineEvent, f, type EventDef } from '@conduit/protocol';
import { Region } from '@conduit/sim';
import type { RegionId } from '@conduit/world';
import { describe, expect, it } from 'vitest';
import type { EntityView, ReplicatedEvent, RenderWorld } from '../src/index.ts';
import { createWorld, regionOf } from './replica-fixture.ts';

const DT = 1 / 60;

const Horn = defineEvent('Horn', { entity: f.entity() }, { replicate: true });
const Explosion = defineEvent(
  'Explosion',
  { at: f.vec3(f.f32), radius: f.f32 },
  { replicate: true },
);
/** A field named `entity` that is not of kind entity names no subject. */
const Score = defineEvent('Score', { entity: f.u32, points: f.u16 }, { replicate: true });

function event<T>(
  def: EventDef<T>,
  tick: number,
  payload: T,
  regionId: RegionId | null = null,
): ReplicatedEvent {
  return { def: def as EventDef, tick, regionId, payload };
}

interface Seen {
  name: string;
  tick: number;
  view: EntityView | null;
  label: unknown;
}

/** Subscribes to `names` and records every dispatch; `label` reads the payload's `n` if any. */
function record(world: RenderWorld, names: readonly string[]): Seen[] {
  const seen: Seen[] = [];
  for (const name of names) {
    world.onEvent(name, (evt, view, w) => {
      expect(w).toBe(world);
      seen.push({
        name: evt.def.name,
        tick: evt.tick,
        view,
        label: (evt.payload as { n?: unknown }).n,
      });
    });
  }
  return seen;
}

describe('RenderWorld replicated events', () => {
  it('an event with tick 15 dispatches once when renderTick reaches 15, not before', () => {
    const { fixture, world } = createWorld();
    const seen = record(world, ['Horn']);
    const evt = event(Horn, 15, { entity: 0 }, 'cell/0_0');
    world.pushEvent(evt);
    const dispatched: ReplicatedEvent[] = [];
    world.onEvent('Horn', (e) => dispatched.push(e));

    for (const tick of [10, 14, 14.95]) {
      fixture.setRenderTick(tick);
      world.update(DT);
    }
    expect(seen).toEqual([]);

    fixture.setRenderTick(15);
    world.update(DT);
    expect(seen.map((s) => s.tick)).toEqual([15]);
    expect(dispatched).toEqual([evt]);
    expect(dispatched[0]).toBe(evt); // the pushed object itself, regionId included

    fixture.setRenderTick(16);
    world.update(DT);
    world.update(DT);
    expect(seen).toHaveLength(1);
  });

  it('dispatches in tick order, arrival order within a tick: 12 then 11 pushed -> 11 first', () => {
    const { fixture, world } = createWorld();
    const order: string[] = [];
    world.onEvent('Horn', (evt) =>
      order.push(`${evt.tick}:${(evt.payload as { tag: string }).tag}`),
    );
    const push = (tick: number, tag: string): void =>
      world.pushEvent({ def: Horn as EventDef, tick, regionId: null, payload: { entity: 0, tag } });

    push(12, 'a');
    push(11, 'b');
    fixture.setRenderTick(12);
    world.update(DT);
    expect(order).toEqual(['11:b', '12:a']);

    order.length = 0;
    push(20, 'c');
    push(18, 'd');
    push(20, 'e');
    push(18, 'f');
    push(19, 'g');
    push(25, 'h'); // not due yet
    fixture.setRenderTick(20);
    world.update(DT);
    expect(order).toEqual(['18:d', '18:f', '19:g', '20:c', '20:e']);

    // A late event whose tick is already behind the render tick dispatches on the next update.
    order.length = 0;
    push(3, 'late');
    world.update(DT);
    expect(order).toEqual(['3:late']);
    fixture.setRenderTick(25);
    world.update(DT);
    expect(order).toEqual(['3:late', '25:h']);
  });

  it('handlers are keyed by def.name and run in subscription order; unsubscribe is idempotent', () => {
    const { fixture, world } = createWorld();
    const log: string[] = [];
    world.onEvent('Horn', () => log.push('horn 1'));
    const off = world.onEvent('Horn', () => log.push('horn 2'));
    world.onEvent('Explosion', () => log.push('explosion'));
    world.onEvent('Nothing', () => log.push('never'));

    // Another def object with the same name (e.g. a second registry) reaches the same handlers.
    const HornAgain = defineEvent('Horn', { entity: f.entity() }, { replicate: true });
    world.pushEvent(event(Horn, 1, { entity: 0 }));
    world.pushEvent(event(Explosion, 1, { at: { x: 1, y: 2, z: 3 }, radius: 4 }));
    world.pushEvent(event(HornAgain, 1, { entity: 0 }));
    world.pushEvent(event(Score, 1, { entity: 0, points: 3 })); // no handler: dropped
    fixture.setRenderTick(1);
    world.update(DT);
    expect(log).toEqual(['horn 1', 'horn 2', 'explosion', 'horn 1', 'horn 2']);

    log.length = 0;
    off();
    off();
    world.pushEvent(event(Horn, 1, { entity: 0 }));
    world.update(DT);
    expect(log).toEqual(['horn 1']);
  });

  it('passes the view of a visible payload.entity, and null for absent, destroyed or non-entity subjects', () => {
    const { fixture, world } = createWorld();
    const seen = record(world, ['Horn', 'Explosion', 'Score']);
    fixture.snapshot(3, {
      creates: [5, 6].map((entity) => ({ entity, components: [regionOf('cell/0_0')] })),
    });
    fixture.snapshot(6, { destroys: [6] });
    fixture.setRenderTick(3);
    world.update(DT);
    const five = world.view(5)!;

    world.pushEvent(event(Horn, 3, { entity: 5, n: 'visible' } as { entity: number }));
    world.pushEvent(event(Horn, 3, { entity: 99, n: 'unknown' } as { entity: number }));
    world.pushEvent(event(Horn, 3, { entity: 0, n: 'none' } as { entity: number }));
    world.pushEvent(
      event(Explosion, 3, { at: { x: 0, y: 0, z: 0 }, radius: 1, n: 'no field' } as {
        at: { x: number; y: number; z: number };
        radius: number;
      }),
    );
    world.pushEvent(
      event(Score, 3, { entity: 5, points: 1, n: 'u32 field' } as {
        entity: number;
        points: number;
      }),
    );
    world.update(DT);
    expect(seen.map((s) => [s.label, s.view])).toEqual([
      ['visible', five],
      ['unknown', null],
      ['none', null],
      ['no field', null],
      ['u32 field', null],
    ]);

    // Entity 6 is destroyed at tick 6: the view is gone before events of that frame dispatch.
    seen.length = 0;
    world.pushEvent(event(Horn, 6, { entity: 6, n: 'destroyed' } as { entity: number }));
    world.pushEvent(event(Horn, 6, { entity: 5, n: 'still here' } as { entity: number }));
    fixture.setRenderTick(6);
    world.update(DT);
    expect(seen.map((s) => [s.label, s.view])).toEqual([
      ['destroyed', null],
      ['still here', five],
    ]);
  });

  it('an event for an entity created on the same tick sees its view; events run after binders and before the camera', () => {
    const { fixture, world } = createWorld();
    const log: string[] = [];
    world.registerBinder({
      component: Region,
      onUpdate: (view) => log.push(`binder ${view.id}`),
    });
    world.setCamera({
      attach: () => {},
      detach: () => {},
      update: () => log.push('camera'),
    });
    world.onEvent('Horn', (evt, view) => log.push(`horn ${evt.tick} view ${view?.id ?? 'null'}`));
    world.pushEvent(event(Horn, 10, { entity: 8 }));
    fixture.snapshot(10, { creates: [{ entity: 8, components: [regionOf('cell/2_2')] }] });
    fixture.setRenderTick(10);
    world.update(DT);
    expect(log).toEqual(['binder 8', 'horn 10 view 8', 'camera']);
  });

  it('handlers may subscribe, unsubscribe and push due events during a dispatch', () => {
    const { fixture, world } = createWorld();
    const log: string[] = [];
    let offSecond = (): void => {};
    world.onEvent('Horn', (evt) => {
      const tag = (evt.payload as { tag: string }).tag;
      log.push(`first ${tag}`);
      if (tag === 'a') {
        offSecond(); // takes effect for this very event
        world.onEvent('Horn', (e) => log.push(`late ${(e.payload as { tag: string }).tag}`));
        world.pushEvent({ def: Horn as EventDef, tick: 4, regionId: null, payload: { tag: 'c' } });
        world.pushEvent({ def: Horn as EventDef, tick: 9, regionId: null, payload: { tag: 'd' } });
      }
    });
    offSecond = world.onEvent('Horn', () => log.push('second'));
    world.pushEvent({ def: Horn as EventDef, tick: 5, regionId: null, payload: { tag: 'a' } });
    world.pushEvent({ def: Horn as EventDef, tick: 5, regionId: null, payload: { tag: 'b' } });
    fixture.setRenderTick(5);
    world.update(DT);
    expect(log).toEqual(['first a', 'first c', 'late c', 'first b', 'late b']);
    fixture.setRenderTick(9);
    world.update(DT);
    expect(log.slice(5)).toEqual(['first d', 'late d']);
  });

  it('dispose from a handler stops the dispatch; later pushes and updates do nothing', () => {
    const { fixture, world } = createWorld();
    const log: string[] = [];
    world.onEvent('Horn', (evt) => {
      log.push(`horn ${evt.tick}`);
      world.dispose();
    });
    world.onEvent('Horn', () => log.push('second'));
    world.pushEvent(event(Horn, 1, { entity: 0 }));
    world.pushEvent(event(Horn, 2, { entity: 0 }));
    fixture.setRenderTick(2);
    world.update(DT);
    expect(log).toEqual(['horn 1']);
    world.pushEvent(event(Horn, 2, { entity: 0 }));
    world.update(DT);
    expect(log).toEqual(['horn 1']);
  });
});
