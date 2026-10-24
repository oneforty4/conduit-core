import { Rng } from '@conduit/math';
import { ReplicaWorld } from '@conduit/net-client';
import {
  ByteReader,
  ByteWriter,
  decodeSnapshot,
  encodeSnapshot,
  REGION_IDX_NONE,
  SNAPSHOT_FLAG_FULL,
  type SnapshotData,
} from '@conduit/protocol';
import {
  EventBus,
  Simulation,
  World,
  RegionChanged,
  type ComponentType,
  type RegionsApi,
  type SpatialApi,
} from '@conduit/sim';
import { describe, expect, it } from 'vitest';
import { defineComponent, defineEvent, defineGame, f, Model } from '../src/index.ts';
import { ScenarioClock } from '../../net-client/test/scenarios/clock.ts';
import { OrderedChannel, seeded } from '../../net-client/test/scenarios/runner.ts';
import {
  CharacterState,
  InventoryState,
  InventoryAdd,
  publicConsumers,
  VehicleState,
} from './fixtures/scenario-consumers.ts';

const regions: RegionsApi = {
  regionOf: () => undefined,
  entitiesIn: () => [],
  active: () => [],
  def: () => undefined,
  migrate: () => 'notMember',
};
const spatial: SpatialApi = {
  queryRadius: (_id, _p, _r, out) => out,
  queryAABB: (_id, _a, _b, out) => out,
  queryRadiusAcross: (_id, _p, _r, out) => out,
  nearest: () => undefined,
};

describe('registry-local definition identity', () => {
  for (const reversed of [false, true])
    it(`isolates shared definitions in both construction orders (${reversed})`, () => {
      const { compatibility: _compatibility, ...base } = publicConsumers().vehicle;
      const extraComponent = defineComponent('Aardvark', { value: f.u8 });
      const extraEvent = defineEvent('AardvarkEvent', { value: f.u8 });
      const make = (extra: boolean) =>
        defineGame({
          ...base,
          components: [...base.components, ...(extra ? [extraComponent] : [])],
          events: [...base.events, ...(extra ? [extraEvent] : [])],
        });
      const first = make(reversed);
      const second = make(!reversed);
      for (const [game, extra] of [
        [first, reversed],
        [second, !reversed],
      ] as const) {
        expect(game.registry.componentId(Model)).toBe(extra ? 1 : 0);
        expect(game.registry.eventId(RegionChanged)).toBe(extra ? 1 : 0);
        const world = new World(game.registry);
        const entity = world.create();
        world.add(entity, VehicleState, { distance: 3, throttle: 1 });
        // A structurally equal definition represents a separate module's factory invocation.
        const moduleCopy = defineComponent(
          'VehicleState',
          { distance: f.f32, throttle: f.f32 },
          { persist: true },
        );
        expect(world.get(entity, moduleCopy).distance).toBe(3);
        expect(world.store(moduleCopy)).toBe(world.store(VehicleState));
        expect(() =>
          world.store(
            defineComponent('VehicleState', { distance: f.u8, throttle: f.f32 }, { persist: true }),
          ),
        ).toThrow('conflicting component');
        const events = new EventBus(world);
        events.emit(
          defineEvent(
            'RegionChanged',
            { entity: f.entity(), from: f.str(64), to: f.str(64) },
            { replicate: false },
          ),
          { entity, from: 'a', to: 'b' },
        );
        expect(events.consume(RegionChanged)).toHaveLength(1);
        expect(() => events.consume(defineEvent('RegionChanged', { entity: f.u8 }))).toThrow(
          'conflicting event',
        );
        const { compatibility: _compatibility, ...definition } = game;
        expect(defineGame(definition).registry.hash).toBe(game.registry.hash);
        const before = world.hash();
        world.mutate(entity, VehicleState, (state) => {
          state.distance++;
        });
        expect(world.hash()).not.toBe(before);
        const replica = new ReplicaWorld(game.registry, game.components, {
          tickRate: game.tickRate,
          snapshotEvery: game.snapshotEvery,
        });
        const snapshot: SnapshotData = {
          header: {
            serverTick: 1,
            serverTimeMs: 16,
            baselineTick: 0,
            lastInputSeq: 0,
            lastInputTick: 0,
            flags: SNAPSHOT_FLAG_FULL,
          },
          regions: [],
          creates: [
            {
              entity,
              regionIdx: REGION_IDX_NONE,
              components: [
                {
                  id: game.registry.componentId(VehicleState),
                  value: world.get(entity, VehicleState),
                },
              ],
            },
          ],
          updates: [],
          destroys: [],
        };
        const writer = new ByteWriter();
        encodeSnapshot(writer, game.registry, snapshot);
        replica.applySnapshot(decodeSnapshot(new ByteReader(writer.view()), game.registry));
        expect(replica.read(entity, moduleCopy)?.distance).toBe(4);
      }
    });

  it('runs three public GameDefs with the same virtual timing and reliable channel', () => {
    const games = publicConsumers();
    const components: ComponentType<unknown>[] = [VehicleState, CharacterState, InventoryState];
    const outcomes: unknown[] = [];
    Object.values(games).forEach((game, index) => {
      const clock = new ScenarioClock([{ lane: 'client', at: 20, duration: 50 }]);
      const world = new World(game.registry, { mutationGuards: true });
      const type = components[index]!;
      const entity = world.create();
      world.add(entity, type);
      const simulation = new Simulation({
        world,
        seed: game.seed,
        tickRate: game.tickRate,
        regionRng: () => new Rng(game.seed),
        regions,
        spatial,
      });
      for (const system of game.systems) simulation.register(system);
      const channel = new OrderedChannel<{ tick: number; value: number; command: boolean }>(
        clock,
        { latency: 10, jitter: 5, bytesPerSecond: 100_000, maxBytes: 1000 },
        seeded(42),
        'server',
      );
      let pending: { tick: number; value: number; command: boolean } | undefined;
      channel.send({ tick: 1, value: 1, command: false }, 16, (frame) => {
        pending = frame;
      });
      clock.at(100, 'client', 'command', () =>
        channel.send({ tick: 7, value: 10, command: true }, 16, (frame) => {
          pending = frame;
        }),
      );
      clock.at(50, 'client', 'stop', () =>
        channel.send({ tick: 4, value: 0, command: false }, 16, (frame) => {
          pending = frame;
        }),
      );
      for (let tick = 1; tick <= 60; tick++)
        clock.at((tick * 1000) / 60, 'server', 'tick', () => {
          simulation.inputFrames[0] = pending;
          if (index === 2 && pending?.command)
            simulation.events.emit(InventoryAdd, { item: pending.value });
          pending = undefined;
          simulation.step(tick);
        });
      clock.run(1000);
      outcomes.push(world.get(entity, type));
      expect(simulation.fault).toBeNull();
    });
    expect(outcomes[0]).toMatchObject({ throttle: 10 });
    expect(outcomes[1]).toEqual({ position: 10, moving: false });
    expect(outcomes[2]).toEqual({ items: [10], revision: 1 });
  });
});
