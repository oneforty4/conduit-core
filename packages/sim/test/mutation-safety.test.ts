import { Rng } from '@conduit/math';
import { f } from '@conduit/protocol';
import { describe, expect, it } from 'vitest';
import { defineComponent, defineEvent, defineSystem, Simulation, World } from '../src/index.ts';
import { noRegions, noSpatial, registryOf } from './helpers.ts';

const Nested = defineComponent('Nested', { pos: f.vec3(f.f32), items: f.array(f.u8, 8) });

describe('guarded component mutation', () => {
  it('caches recursive readonly views without freezing tracked writes', () => {
    const world = new World(registryOf([Nested]), { mutationGuards: true });
    const e = world.create();
    world.add(e, Nested);
    const read = world.get(e, Nested);
    expect(world.get(e, Nested)).toBe(read);
    expect(read.pos).toBe(read.pos);
    expect(() => Reflect.set(read.pos, 'x', 1)).toThrow('immutable');
    const descriptor = Object.getOwnPropertyDescriptor(read, 'pos')!;
    expect(() => {
      descriptor.value.x = 2;
    }).toThrow('immutable');
    expect(() => Reflect.set(read.items, '0', 1)).toThrow('immutable');
    world.mutate(e, Nested, (value) => {
      value.pos.x = 3;
      value.items.push(4);
    });
    expect(read.pos.x).toBe(3);
    expect(read.items).toEqual([4]);
    const external = { x: 9, y: 0, z: 0 };
    world.mutate(e, Nested, (value) => {
      value.pos = external;
    });
    external.x = 100;
    expect(read.pos.x).toBe(9);
  });

  it('expires scoped nested references and legacy writes across ticks', () => {
    const world = new World(registryOf([Nested]), { mutationGuards: true });
    const e = world.create();
    world.add(e, Nested);
    let escaped: { x: number } | undefined;
    world.mutate(e, Nested, (value) => {
      escaped = value.pos;
    });
    expect(() => {
      escaped!.x = 5;
    }).toThrow('scope expired');
    const legacy = world.write(e, Nested);
    world.tick++;
    expect(() => {
      legacy.pos.x = 6;
    }).toThrow('expired');
    world.write(e, Nested).pos.x = 7;
    expect(world.get(e, Nested).pos.x).toBe(7);
  });

  it('validates nonfinite optional arrays/structs and rejects cyclic declared data', () => {
    const Complex = defineComponent('ComplexFinite', {
      detail: f.optional(f.struct({ values: f.array(f.f32, 4) })),
    });
    const world = new World(registryOf([Complex]));
    const entity = world.create();
    world.add(entity, Complex);
    expect(() =>
      world.mutate(entity, Complex, (value) => {
        value.detail = { values: [NaN] };
      }),
    ).toThrow('ComplexFinite.detail.values.0');
    world.write(entity, Complex).detail = { values: [1] };
    const detail = world.write(entity, Complex).detail!;
    Reflect.set(detail, 'cycle', detail);
    expect(() => world.store(Complex).validateWrites()).not.toThrow(); // between-step stamp is next tick
    world.tick++;
    expect(() => world.store(Complex).validateWrites()).toThrow('cyclic');
  });

  it('guards input frames and event lists through context reads', () => {
    const Signal = defineEvent('Signal', { pos: f.vec3(f.f32) });
    const world = new World(registryOf([Nested], [Signal]), { mutationGuards: true });
    const sim = new Simulation({
      world,
      seed: 1,
      regionRng: () => new Rng(1),
      regions: noRegions,
      spatial: noSpatial,
    });
    sim.inputFrames[0] = { tick: 1 };
    sim.register(
      defineSystem('guard-check', 'sim', (ctx) => {
        expect(() => Reflect.set(ctx.inputs(0)!, 'tick', 9)).toThrow('immutable');
        ctx.events.emit(Signal, { pos: { x: 1, y: 2, z: 3 } });
        const emitted = ctx.events.consume(Signal);
        expect(() => Reflect.set(emitted, 'length', 0)).toThrow('immutable');
        expect(() => Reflect.set(emitted[0]!.payload.pos, 'x', 5)).toThrow('immutable');
      }),
    );
    sim.step(1);
    expect(sim.events.drainOutbox()[0]?.payload).toEqual({ pos: { x: 1, y: 2, z: 3 } });
  });

  it('rejects nonfinite tracked mutation with field diagnostics', () => {
    const world = new World(registryOf([Nested]));
    const e = world.create();
    expect(() => world.add(e, Nested, { pos: { x: NaN, y: 0, z: 0 } })).toThrow('Nested.pos.x');
    expect(world.has(e, Nested)).toBe(false);
    world.add(e, Nested);
    expect(() =>
      world.mutate(e, Nested, (v) => {
        v.pos.x = Infinity;
      }),
    ).toThrow('Nested.pos.x');
  });
});

// Compile-time contract: nested vectors and arrays remain readonly through optional boundaries.
function readonlyContract(world: World, entity: number): void {
  const value = world.tryGet(entity, Nested);
  if (value !== undefined) {
    // @ts-expect-error nested vector write requires tracked mutation
    value.pos.x = 2;
    // @ts-expect-error readonly arrays cannot be appended
    value.items.push(1);
  }
}
void readonlyContract;
