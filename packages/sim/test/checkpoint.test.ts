import { Rng } from '@conduit/math';
import { f } from '@conduit/protocol';
import { describe, expect, it } from 'vitest';
import {
  cloneExactState,
  decodeExactState,
  defineComponent,
  defineEvent,
  defineSystem,
  encodeExactState,
  firstStateDifference,
  fullStateDigest,
  Simulation,
  World,
} from '../src/index.ts';
import { noRegions, noSpatial, registryOf } from './helpers.ts';

const Hidden = defineComponent(
  'Hidden',
  { n: f.f32, maybe: f.optional(f.f32) },
  { replicate: false },
);
const Signal = defineEvent('Signal', { value: f.u8 });
function setup() {
  const world = new World(registryOf([Hidden], [Signal]), { capacity: 4 });
  const sim = new Simulation({
    world,
    seed: 3,
    regionRng: () => new Rng(4),
    regions: noRegions,
    spatial: noSpatial,
  });
  sim.register(
    defineSystem('advance', 'sim', (ctx) => {
      for (const entity of ctx.world.query(Hidden))
        ctx.world.mutate(entity, Hidden, (value) => {
          value.n += ctx.rng.float();
        });
    }),
  );
  return { world, sim };
}

describe('exact state codec', () => {
  it('retains raw float precision, signed zero, undefined presence, bytes and canonical key ordering', () => {
    const value = {
      z: -0,
      a: [undefined, 1 / 3],
      bytes: new Uint8Array([0, 255]),
      optional: undefined,
    };
    const decoded = decodeExactState(encodeExactState(value)) as typeof value;
    expect(Object.is(decoded.z, -0)).toBe(true);
    expect(decoded.a[1]).toBe(1 / 3);
    expect(Object.hasOwn(decoded, 'optional')).toBe(true);
    expect(decoded.bytes).toEqual(value.bytes);
    expect(encodeExactState({ b: 2, a: 1 })).toEqual(encodeExactState({ a: 1, b: 2 }));
    expect(firstStateDifference(new Uint8Array([1]), { 0: 1 })?.path).toContain(
      'type bytes vs object',
    );
    expect(firstStateDifference({}, { x: undefined })?.path).toBe('$.x');
  });

  it('rejects unsupported or lossy values instead of silently dropping state', () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    const accessor = {
      get n() {
        throw new Error('getter must never run');
      },
    };
    const extra = [1];
    Object.defineProperty(extra, 'extra', { value: 2, enumerable: true });
    for (const value of [
      NaN,
      Infinity,
      cycle,
      () => {},
      new Map(),
      { [Symbol('key')]: 1 },
      accessor,
      Array(2),
      extra,
    ])
      expect(() => encodeExactState(value)).toThrow();
    expect(() =>
      decodeExactState(new TextEncoder().encode('["number","7ff0000000000000"]')),
    ).toThrow();
  });
});

describe('full simulation checkpoints', () => {
  it('restores allocator free-list/dense order, hidden components, events, RNG and future behavior', async () => {
    const source = setup();
    const a = source.world.create();
    const b = source.world.create();
    const c = source.world.create();
    for (const entity of [a, b, c]) source.world.add(entity, Hidden, { n: 1 / 3 });
    source.world.destroy(b);
    source.world.applyDestroys();
    source.world.destroy(a); // queued destruction order is continuation state
    source.sim.events.emit(Signal, { value: 7 });
    source.sim.inputFrames[0] = { tick: 1 };
    const worldState = source.world.captureCheckpoint();
    const simState = source.sim.captureCheckpoint();
    const restored = setup();
    const store = restored.world.store(Hidden);
    restored.world.restoreCheckpoint(worldState);
    restored.sim.restoreCheckpoint(simState);
    expect(restored.world.store(Hidden)).toBe(store);
    expect(restored.world.captureCheckpoint()).toEqual(worldState);
    expect(restored.sim.captureCheckpoint()).toEqual(simState);
    expect(restored.world.create()).toBe(source.world.create());
    source.sim.step(1);
    restored.sim.step(1);
    expect(restored.world.captureCheckpoint()).toEqual(source.world.captureCheckpoint());
    expect(restored.sim.captureCheckpoint()).toEqual(source.sim.captureCheckpoint());
    const wire = source.world.hash();
    const before = await fullStateDigest(source.world.captureCheckpoint());
    source.world.write(c, Hidden).n += 1e-12;
    expect(source.world.hash()).toBe(wire);
    expect(await fullStateDigest(source.world.captureCheckpoint())).not.toBe(before);
  });

  it('prevalidates invalid allocator images without changing a target', () => {
    const source = setup();
    const e = source.world.create();
    source.world.add(e, Hidden);
    const target = setup();
    const before = target.world.captureCheckpoint();
    const broken = cloneExactState(source.world.captureCheckpoint());
    const invalid = { ...broken, live: 99 };
    expect(() => target.world.restoreCheckpoint(invalid)).toThrow('live');
    expect(target.world.captureCheckpoint()).toEqual(before);
  });
});

it.each(['free', 'pending'] as const)(
  'restores a valid allocator with %s slots beyond the JavaScript argument limit',
  (state) => {
    const source = new World(registryOf([]), { capacity: 131072 });
    for (let index = 1; index < 131072; index++) source.destroy(source.create());
    if (state === 'free') source.applyDestroys();
    const checkpoint = source.captureCheckpoint();
    const target = new World(registryOf([]));
    expect(() => target.restoreCheckpoint(checkpoint)).not.toThrow();
    expect(target.count()).toBe(source.count());
    target.applyDestroys();
    source.applyDestroys();
    expect(target.count()).toBe(0);
    expect(target.create()).toBe(source.create());
  },
);
