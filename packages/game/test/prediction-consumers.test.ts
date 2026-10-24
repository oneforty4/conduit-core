import { Rng } from '@conduit/math';
import { expect, it } from 'vitest';
import { PredictionDriver, ReplicaWorld, Reconciler } from '@conduit/net-client';
import { REGION_IDX_NONE, type SnapshotHeader } from '@conduit/protocol';
import { Simulation, World, type RegionsApi, type SpatialApi } from '@conduit/sim';
import {
  CharacterState,
  consumerPredictionAdapters,
  InventoryAdd,
  InventoryState,
  publicConsumers,
  ScenarioInput,
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
  queryRadiusAcross: (_ids, _p, _r, out) => out,
  nearest: () => undefined,
};
const header = (tick: number): SnapshotHeader => ({
  serverTick: tick,
  serverTimeMs: (tick * 1000) / 60,
  baselineTick: 0,
  lastInputTick: 0,
  lastInputSeq: 0,
  flags: 0,
});
type Frame = ReturnType<typeof ScenarioInput.create>;

for (const fps of [30, 60, 120, 144])
  it(`predicts three public consumers at ${fps} rendered frames/s with explicit inventory commands`, () => {
    const games = publicConsumers();
    const make = (game: typeof games.vehicle) => {
      const world = new World(game.registry, { mutationGuards: true });
      const entity = world.create();
      const simulation = new Simulation({
        world,
        seed: game.seed,
        tickRate: 60,
        regionRng: () => new Rng(game.seed),
        regions,
        spatial,
      });
      game.systems.forEach((system) => simulation.register(system));
      const replica = new ReplicaWorld(game.registry, game.components, {
        tickRate: 60,
        snapshotEvery: 3,
      });
      replica.applySnapshot({
        header: header(0),
        regions: [],
        creates: [{ entity, regionIdx: REGION_IDX_NONE, components: [] }],
        updates: [],
        destroys: [],
      });
      return { world, entity, simulation, replica };
    };
    const vehicle = make(games.vehicle),
      character = make(games.character),
      inventory = make(games.inventory);
    vehicle.world.add(vehicle.entity, VehicleState);
    character.world.add(character.entity, CharacterState);
    inventory.world.add(inventory.entity, InventoryState);
    let authoritativeTick = 0;
    let heldVehicle: Frame | undefined, heldCharacter: Frame | undefined;
    let boundary = 'spawn';
    const declared = (heldInput: Frame | undefined) => ({
      coherent: true,
      authoritativeTick,
      boundaryKey: boundary,
      regionId: 'cell/0_0',
      heldInput,
    });
    const adapters = consumerPredictionAdapters({
      vehicle: () => ({
        ...declared(heldVehicle),
        state: vehicle.world.get(vehicle.entity, VehicleState),
      }),
      character: () => ({
        ...declared(heldCharacter),
        state: character.world.get(character.entity, CharacterState),
      }),
      inventory: () => ({
        ...declared(undefined),
        state: inventory.world.get(inventory.entity, InventoryState),
        commandOutcomes:
          authoritativeTick >= 10 ? [{ id: 'inventory-add-1', outcome: 'confirmed' }] : [],
      }),
    });
    const vehicleDriver = new PredictionDriver({
      adapter: adapters.vehicle,
      inputSchema: ScenarioInput,
      tickRate: 60,
    });
    const characterDriver = new PredictionDriver({
      adapter: adapters.character,
      inputSchema: ScenarioInput,
      tickRate: 60,
    });
    const effects: string[] = [];
    const inventoryDriver = new PredictionDriver({
      adapter: adapters.inventory,
      inputSchema: ScenarioInput,
      tickRate: 60,
      copyCommand: (command) => ({ ...command }),
      onCommandOutcome: (id, outcome) => effects.push(`${id}:${outcome}`),
    });
    const reconciliations = [
      new Reconciler(ScenarioInput, vehicle.replica, { predictor: vehicleDriver }),
      new Reconciler(ScenarioInput, character.replica, { predictor: characterDriver }),
      new Reconciler(ScenarioInput, inventory.replica, { predictor: inventoryDriver }),
    ];
    const reconcile = () =>
      reconciliations.forEach((reconciler, index) =>
        reconciler.onSnapshot(
          header(authoritativeTick),
          [vehicle, character, inventory][index]!.entity,
        ),
      );
    reconcile();
    const vehicleOut = VehicleState.create(),
      characterOut = CharacterState.create(),
      inventoryOut = InventoryState.create();
    for (let tick = 1; tick <= 60; tick++) {
      heldVehicle = { tick, value: tick < 31 ? 1 : 0, command: false };
      heldCharacter = { tick, value: tick < 20 ? 1 : tick === 40 ? 100 : 0, command: tick === 40 };
      if (tick === 10) {
        inventoryDriver.recordCommand('inventory-add-1', tick, { item: 7 });
        inventory.simulation.events.emit(InventoryAdd, { item: 7 });
      }
      vehicleDriver.recordInput(heldVehicle);
      characterDriver.recordInput(heldCharacter);
      inventoryDriver.recordInput({ tick, value: 0, command: false });
      vehicle.simulation.inputFrames[0] = heldVehicle;
      character.simulation.inputFrames[0] = heldCharacter;
      for (const model of [vehicle, character, inventory]) model.simulation.step(tick);
      authoritativeTick = tick;
      if (tick === 40) boundary = 'teleport';
      if (tick % 3 === 0) reconcile();
      for (
        let frame = Math.floor(((tick - 1) * fps) / 60);
        frame < Math.floor((tick * fps) / 60);
        frame++
      ) {
        vehicleDriver.sample(tick, vehicleOut);
        characterDriver.sample(tick, characterOut);
        inventoryDriver.sample(tick, inventoryOut);
      }
      vehicleDriver.sample(tick, vehicleOut);
      characterDriver.sample(tick, characterOut);
      inventoryDriver.sample(tick, inventoryOut);
      expect(vehicleOut.distance).toBeCloseTo(
        vehicle.world.get(vehicle.entity, VehicleState).distance,
        5,
      );
      expect(characterOut.position).toBeCloseTo(
        character.world.get(character.entity, CharacterState).position,
        5,
      );
      expect(inventoryOut.items).toEqual(
        inventory.world.get(inventory.entity, InventoryState).items,
      );
    }
    expect(vehicleOut.distance).toBeCloseTo(0.5, 5);
    expect(characterOut.position).toBe(100);
    expect(inventoryOut).toEqual({ items: [7], revision: 1 });
    expect(effects).toEqual(['inventory-add-1:confirmed']);
  });
