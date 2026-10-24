import { Rng } from '@conduit/math';
import { defineInput, f } from '@conduit/protocol';
import { describe, expect, it } from 'vitest';
import {
  defineComponent,
  defineEvent,
  defineSystem,
  DuplicateSystem,
  type EntityId,
  MAX_PLAYERS,
  PHASES,
  type RegionId,
  type SimContext,
  Simulation,
  type SimulationOpts,
  slotOf,
  TickOrder,
  World,
} from '../src/index.ts';
import { noRegions, noSpatial, registryOf } from './helpers.ts';

const Health = defineComponent('Health', { hp: f.u16 });
const Ping = defineEvent('Ping', { n: f.u8 });
const Input = defineInput({ tick: f.u32, throttle: f.i8 });

function setup(opts: Partial<SimulationOpts> = {}): { world: World; sim: Simulation } {
  const world = new World(registryOf([Health], [Ping], Input));
  const sim = new Simulation({
    world,
    seed: 42,
    regionRng: () => new Rng(1),
    regions: noRegions,
    spatial: noSpatial,
    ...opts,
  });
  return { world, sim };
}

describe('Simulation.step', () => {
  it('runs phases in PHASES order, registration order within a phase, then the tail', () => {
    const { sim } = setup();
    const log: string[] = [];
    const probe = (name: string, phase: (typeof PHASES)[number]) =>
      defineSystem(name, phase, (ctx) => log.push(`${ctx.tick}:${phase}:${name}`));
    sim.register(probe('a', 'sim'));
    sim.register(probe('b', 'input'));
    sim.register(probe('c', 'postSim'));
    sim.register(probe('d', 'preSim'));
    sim.register(probe('e', 'sim'));
    sim.register(probe('f', 'input'));
    sim.tail.push((ctx) => log.push(`${ctx.tick}:tail:1`));
    sim.tail.push((ctx) => log.push(`${ctx.tick}:tail:2`));
    expect(PHASES).toEqual(['input', 'preSim', 'sim', 'postSim']);
    expect(sim.systems('sim').map((s) => s.name)).toEqual(['a', 'e']);
    expect(sim.systems('input').map((s) => s.name)).toEqual(['b', 'f']);
    sim.step(1);
    sim.step(2);
    const once = [
      'input:b',
      'input:f',
      'preSim:d',
      'sim:a',
      'sim:e',
      'postSim:c',
      'tail:1',
      'tail:2',
    ];
    expect(log).toEqual([...once.map((s) => `1:${s}`), ...once.map((s) => `2:${s}`)]);
  });

  it('the tail runs after postSim and before destroys apply; events end after the tail', () => {
    const { world, sim } = setup();
    const e = world.create();
    world.add(e, Health, { hp: 1 });
    const observed: string[] = [];
    sim.register(
      defineSystem('killer', 'postSim', (ctx) => {
        ctx.world.destroy(e);
        ctx.events.emit(Ping, { n: 1 });
      }),
    );
    sim.tail.push((ctx) => {
      observed.push(`alive=${ctx.world.alive(e)}`);
      observed.push(`has=${ctx.world.has(e, Health)}`);
      observed.push(`destroyed=${ctx.world.destroyedThisTick().join(',')}`);
      observed.push(`pings=${ctx.events.consume(Ping).length}`);
    });
    sim.step(1);
    expect(observed).toEqual(['alive=true', 'has=true', `destroyed=${e}`, 'pings=1']);
    expect(world.alive(e)).toBe(false);
    expect(world.destroyedThisTick()).toEqual([]);
    expect(sim.events.consume(Ping)).toEqual([]);
    expect(sim.events.drainOutbox()).toEqual([
      { typeId: world.registry.eventId(Ping), tick: 1, regionId: undefined, payload: { n: 1 } },
    ]);
  });

  it('step with the wrong tick throws TickOrder and changes nothing', () => {
    const { world, sim } = setup();
    let runs = 0;
    sim.register(defineSystem('count', 'sim', () => runs++));
    expect(() => sim.step(0)).toThrow(TickOrder);
    expect(() => sim.step(2)).toThrow(TickOrder);
    expect(world.tick).toBe(0);
    expect(runs).toBe(0);
    sim.step(1);
    expect(() => sim.step(1)).toThrow(TickOrder);
    expect(() => sim.step(3)).toThrow(TickOrder);
    try {
      sim.step(5);
    } catch (err) {
      expect(err).toBeInstanceOf(TickOrder);
      expect((err as TickOrder).expected).toBe(2);
      expect((err as TickOrder).actual).toBe(5);
    }
    sim.step(2);
    expect(world.tick).toBe(2);
    expect(runs).toBe(2);
  });

  it('inputs(p) returns the placed frames and is never cleared by the sim', () => {
    const { sim } = setup({ maxPlayers: 4 });
    expect(sim.inputFrames).toEqual([undefined, undefined, undefined, undefined]);
    const seen: (string | undefined)[] = [];
    sim.register(
      defineSystem('read', 'input', (ctx) => {
        const frame = ctx.inputs(1) as { tick: number; throttle: number } | undefined;
        seen.push(frame === undefined ? undefined : `${frame.tick}/${frame.throttle}`);
        seen.push(ctx.inputs(0) === undefined ? 'none' : 'p0');
        seen.push(ctx.inputs(MAX_PLAYERS) === undefined ? 'none' : 'oob');
      }),
    );
    const frame = { tick: 1, throttle: 100 };
    sim.inputFrames[1] = frame;
    sim.step(1);
    sim.step(2);
    expect(seen).toEqual(['1/100', 'none', 'none', '1/100', 'none', 'none']);
    expect(sim.inputFrames[1]).toBe(frame);
    expect(sim.ctx.inputs(1)).toBe(frame);
  });

  it('onInputsPlaced sees every player frame of the tick, after successful phases, while stepping', () => {
    const { world, sim } = setup({ maxPlayers: 3 });
    const log: string[] = [];
    sim.register(defineSystem('read', 'input', (ctx) => log.push(`${ctx.tick}:input`)));
    sim.step(1); // no hook installed: nothing reported
    sim.onInputsPlaced = (tick, player, frame) => {
      const placed = frame as { tick: number; throttle: number } | undefined;
      const seen = placed === undefined ? 'none' : `${placed.tick}/${placed.throttle}`;
      log.push(`${tick}:p${player}=${seen}:${world.tick}:${world.stepping}`);
    };
    const frame = { tick: 2, throttle: -5 };
    sim.inputFrames[2] = frame;
    sim.step(2);
    const next = { tick: 3, throttle: 9 };
    sim.inputFrames[0] = next;
    sim.step(3);
    expect(log).toEqual([
      '1:input',
      '2:input',
      '2:p0=none:2:true',
      '2:p1=none:2:true',
      '2:p2=2/-5:2:true',
      '3:input',
      '3:p0=3/9:3:true',
      '3:p1=none:3:true',
      '3:p2=2/-5:3:true',
    ]);

    // A throwing hook propagates like a throwing system: the tick advanced, no phase ran.
    sim.onInputsPlaced = () => {
      throw new Error('hook');
    };
    expect(() => sim.step(4)).toThrow('hook');
    expect(world.tick).toBe(4);
    expect(world.stepping).toBe(false);
    expect(log.at(-1)).toBe('4:input');
  });

  it('register throws DuplicateSystem on a repeated name and Error after the first step', () => {
    const { sim } = setup();
    sim.register(defineSystem('move', 'sim', () => {}));
    expect(() => sim.register(defineSystem('move', 'postSim', () => {}))).toThrow(DuplicateSystem);
    expect(() => sim.register({ name: 'weird', phase: 'late' as 'sim', run: () => {} })).toThrow(
      RangeError,
    );
    sim.step(1);
    let thrown: unknown;
    try {
      sim.register(defineSystem('late', 'sim', () => {}));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(DuplicateSystem);
    expect(sim.systems('sim').map((s) => s.name)).toEqual(['move']);
  });

  it('ctx exposes the world, tick, dt, seeded rng, regionRng, regions, spatial and events', () => {
    const regionStreams = new Map<RegionId, Rng>();
    const regionRng = (id: RegionId): Rng => {
      let rng = regionStreams.get(id);
      if (rng === undefined) regionStreams.set(id, (rng = new Rng(id.length)));
      return rng;
    };
    const { world, sim } = setup({ tickRate: 20, regionRng });
    const ctx: SimContext = sim.ctx;
    expect(ctx.world).toBe(world);
    expect(ctx.tick).toBe(0);
    expect(ctx.dt).toBe(1 / 20);
    expect(ctx.events).toBe(sim.events);
    expect(ctx.regions).toBe(noRegions);
    expect(ctx.spatial).toBe(noSpatial);
    expect(ctx.rng.next()).toBe(new Rng(42).next());
    expect(ctx.regionRng('abc')).toBe(regionRng('abc'));
    const ticks: number[] = [];
    sim.register(defineSystem('t', 'preSim', (c) => ticks.push(c.tick, c.world.tick)));
    sim.step(1);
    expect(ticks).toEqual([1, 1]);
    expect(ctx.tick).toBe(1);
    expect(ctx.dt).toBe(0.05);
  });

  it('validates options and defaults tickRate to 60 and maxPlayers to MAX_PLAYERS', () => {
    const { sim } = setup();
    expect(sim.ctx.dt).toBe(1 / 60);
    expect(sim.inputFrames).toHaveLength(MAX_PLAYERS);
    expect(MAX_PLAYERS).toBe(8);
    expect(() => setup({ tickRate: 0 })).toThrow(RangeError);
    expect(() => setup({ maxPlayers: 9 })).toThrow(RangeError);
    expect(() => setup({ maxPlayers: 0 })).toThrow(RangeError);
    expect(() => defineSystem('x', 'nope' as 'sim', () => {})).toThrow(RangeError);
    expect(() => defineSystem('', 'sim', () => {})).toThrow(RangeError);
  });

  it('a throwing system quarantines partial state and prevents continuation', () => {
    const { world, sim } = setup();
    const e: EntityId = world.create();
    let fail = true;
    sim.register(
      defineSystem('flaky', 'sim', (ctx) => {
        if (ctx.tick === 1) {
          ctx.world.destroy(e);
          ctx.events.emit(Ping, { n: 7 });
        }
        if (fail) throw new Error('boom');
      }),
    );
    expect(() => sim.step(1)).toThrow('boom');
    expect(world.tick).toBe(1);
    expect(world.stepping).toBe(false);
    expect(world.alive(e)).toBe(true);
    fail = false;
    expect(() => sim.step(2)).toThrow('boom');
    expect(sim.fault).toMatchObject({ tick: 1, system: 'flaky', phase: 'sim' });
    expect(world.alive(e)).toBe(true);
    expect(sim.events.drainOutbox()).toEqual([]);
  });

  it('stamps writes with the current tick inside step and the coming tick between steps', () => {
    const { world, sim } = setup();
    const store = world.store(Health);
    const a = world.create();
    const b = world.create();
    world.add(a, Health); // e.g. onInit, before the first step
    expect(store.version[slotOf(a)]).toBe(1);
    const seen: boolean[] = [];
    sim.register(
      defineSystem('touch', 'sim', (ctx) => {
        seen.push(ctx.world.stepping);
        if (ctx.tick === 1) ctx.world.write(a, Health).hp = 1;
        if (ctx.tick === 2) ctx.world.add(b, Health);
      }),
    );
    sim.step(1);
    expect(store.version[slotOf(a)]).toBe(1);
    expect(world.stepping).toBe(false);
    world.write(a, Health).hp = 2; // e.g. an onMessage hook dispatched before step 2
    expect(store.version[slotOf(a)]).toBe(2);
    sim.step(2);
    expect(store.version[slotOf(b)]).toBe(2);
    world.remove(b, Health); // between steps 2 and 3
    expect(store.removedAt[slotOf(b)]).toBe(3);
    expect(seen).toEqual([true, true]);
  });

  it('step is not re-entrant', () => {
    const { world, sim } = setup();
    sim.register(defineSystem('nested', 'sim', (ctx) => sim.step(ctx.tick + 1)));
    expect(() => sim.step(1)).toThrow(/re-entrant/);
    expect(world.stepping).toBe(false);
    expect(world.tick).toBe(1);
  });
});

describe('Simulation.skip', () => {
  it('moves the tick on without a step: no phase, no tail, no frames; the next step follows it', () => {
    const { world, sim } = setup();
    const ran: number[] = [];
    const placed: number[] = [];
    sim.register(defineSystem('probe', 'sim', (ctx) => ran.push(ctx.tick)));
    sim.tail.push((ctx) => ran.push(-ctx.tick));
    sim.onInputsPlaced = (tick, player) => {
      if (player === 0) placed.push(tick);
    };
    sim.step(1);
    sim.skip(13);
    expect(world.tick).toBe(14);
    expect(sim.ctx.tick).toBe(14);
    expect(ran).toEqual([1, -1]);
    expect(placed).toEqual([1]);
    expect(() => sim.step(2)).toThrow(TickOrder);
    sim.step(15);
    expect(ran).toEqual([1, -1, 15, -15]);
    expect(placed).toEqual([1, 15]);
  });

  it('keeps the stamps of what was written and emitted between steps, for the next step', () => {
    const { world, sim } = setup();
    const store = world.store(Health);
    const seen: number[] = [];
    sim.register(
      defineSystem('pings', 'sim', (ctx) => {
        for (const ping of ctx.events.consume(Ping)) seen.push(ping.payload.n);
      }),
    );
    const a = world.create();
    world.add(a, Health);
    sim.step(1);
    world.write(a, Health).hp = 5; // between steps: the coming tick's, 2
    sim.events.emit(Ping, { n: 3 }); // the last tick's, 1
    sim.skip(4);
    expect(store.version[slotOf(a)]).toBe(2);
    world.write(a, Health).hp = 6; // after the skip the coming tick is 6
    expect(store.version[slotOf(a)]).toBe(6);
    sim.step(6);
    expect(seen).toEqual([3]);
    expect(sim.events.drainOutbox()).toMatchObject([{ tick: 1, payload: { n: 3 } }]);
  });

  it('takes a whole count of at least one, not while stepping, and closes registration', () => {
    const { world, sim } = setup();
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => sim.skip(bad)).toThrow(RangeError);
    }
    expect(world.tick).toBe(0);
    sim.register(defineSystem('nested', 'sim', () => sim.skip(1)));
    expect(() => sim.step(1)).toThrow(/not while stepping/);
    expect(world.tick).toBe(1);
    const { sim: fresh } = setup();
    fresh.skip(3);
    expect(() => fresh.register(defineSystem('late', 'sim', () => {}))).toThrow(
      /before the first step/,
    );
  });
});

it('measures system boundaries without changing outcomes when timing/sinks throw', () => {
  for (const diagnostics of [
    undefined,
    {
      now: () => {
        throw Error('diagnostic clock');
      },
      observer: {
        observe() {
          throw Error('sink');
        },
      },
    },
    {
      now: () => NaN,
      observer: {
        observe() {
          throw Error('sink');
        },
      },
    },
  ]) {
    const { world, sim } = setup({ diagnostics });
    const entity = world.create();
    world.add(entity, Health, { hp: 10 });
    sim.register(
      defineSystem('increment', 'sim', (ctx) =>
        ctx.world.mutate(entity, Health, (h) => {
          h.hp++;
        }),
      ),
    );
    sim.step(1);
    sim.step(2);
    expect(world.get(entity, Health).hp).toBe(12);
    expect(sim.fault).toBeNull();
  }
});
