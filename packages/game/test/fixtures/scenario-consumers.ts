import type {
  PredictionAdapter,
  PredictionStep,
  ReconcileView,
  AuthoritativePrediction,
} from '@conduit/net-client';
import type { DeepReadonly } from '@conduit/sim';
import {
  defineComponent,
  defineEvent,
  defineGame,
  defineInput,
  defineMessage,
  defineSystem,
  f,
  GridWorld,
} from '../../src/index.ts';

export const VehicleState = defineComponent(
  'VehicleState',
  { distance: f.f32, throttle: f.f32 },
  { persist: true },
);
export const CharacterState = defineComponent('AbruptCharacter', {
  position: f.f32,
  moving: f.bool,
});
export const InventoryState = defineComponent(
  'InventoryState',
  { items: f.array(f.u16, 32), revision: f.u32 },
  { replicate: false, persist: true },
);
export const VehicleEvent = defineEvent('VehicleCommand', { value: f.f32 });
export const CharacterEvent = defineEvent('AbruptTeleport', { position: f.f32 });
export const InventoryView = defineComponent('InventoryView', { count: f.u16, revision: f.u32 });
export const InventoryAddMessage = defineMessage('AddInventory', 'c2s', { item: f.u16 });
export const InventoryAdd = defineEvent('InventoryAdd', { item: f.u16 }, { replicate: false });
export const InventoryEvent = defineEvent('ItemAdded', { item: f.u16 }, { replicate: false });
export const ScenarioInput = defineInput({ tick: f.u32, value: f.f32, command: f.bool });
type Frame = ReturnType<typeof ScenarioInput.create>;

export function publicConsumers() {
  const common = {
    protocolVersion: 3,
    seed: 0xc0ffee,
    tickRate: 60,
    snapshotEvery: 3,
    input: ScenarioInput,
    messages: [],
    world: (seed: number) =>
      new GridWorld({ cellSize: 64, cols: 1, rows: 1, wantedDepth: 0, worldSeed: seed }),
  };
  const vehicle = defineGame({
    ...common,
    id: 'scenario-vehicle',
    name: 'Continuous vehicle',
    components: [VehicleState],
    events: [VehicleEvent],
    systems: [
      defineSystem('vehicleMotion', 'sim', (ctx) => {
        const frame = ctx.inputs(0) as Frame | undefined;
        for (const entity of ctx.world.query(VehicleState))
          ctx.world.mutate(entity, VehicleState, (state) => {
            if (frame) state.throttle = frame.value;
            state.distance += state.throttle * ctx.dt;
          });
      }),
    ],
  });
  const character = defineGame({
    ...common,
    id: 'scenario-character',
    name: 'Abrupt character',
    components: [CharacterState],
    events: [CharacterEvent],
    systems: [
      defineSystem('characterMotion', 'sim', (ctx) => {
        const frame = ctx.inputs(0) as Frame | undefined;
        for (const entity of ctx.world.query(CharacterState))
          ctx.world.mutate(entity, CharacterState, (state) => {
            if (frame?.command) {
              state.position = frame.value;
              ctx.events.emit(CharacterEvent, { position: state.position });
            } else if (frame) state.moving = frame.value !== 0;
            if (state.moving) state.position += ctx.dt;
          });
      }),
    ],
  });
  const inventory = defineGame({
    ...common,
    id: 'scenario-inventory',
    name: 'Command inventory',
    messages: [InventoryAddMessage],
    components: [InventoryState, InventoryView],
    events: [InventoryAdd, InventoryEvent],
    systems: [
      defineSystem('inventoryCommands', 'sim', (ctx) => {
        for (const command of ctx.events.consume(InventoryAdd))
          for (const entity of ctx.world.query(InventoryState))
            ctx.world.mutate(entity, InventoryState, (state) => {
              state.items.push(command.payload.item);
              state.revision++;
              if (ctx.world.has(entity, InventoryView))
                ctx.world.mutate(entity, InventoryView, (view) => {
                  view.count = state.items.length;
                  view.revision = state.revision;
                });
              ctx.events.emit(InventoryEvent, { item: command.payload.item });
            });
      }),
    ],
  });
  return { vehicle, character, inventory };
}

export interface ConsumerAuthority<S> extends AuthoritativePrediction<Frame> {
  state: DeepReadonly<S>;
}
export type VehiclePredictionState = ReturnType<typeof VehicleState.create>;
export type CharacterPredictionState = ReturnType<typeof CharacterState.create>;
export type InventoryPredictionState = ReturnType<typeof InventoryState.create>;
export type InventoryCommand = { item: number };

/** All game rules and authoritative hidden-state declarations live in these fixture adapters. */
export function consumerPredictionAdapters(authority: {
  vehicle(view: ReconcileView): ConsumerAuthority<VehiclePredictionState>;
  character(view: ReconcileView): ConsumerAuthority<CharacterPredictionState>;
  inventory(view: ReconcileView): ConsumerAuthority<InventoryPredictionState>;
}) {
  const vehicle: PredictionAdapter<VehiclePredictionState, Frame, VehiclePredictionState> = {
    createState: () => VehicleState.create(),
    copyState: (source, out) => {
      VehicleState.copy(out, source);
    },
    readAuthoritative: (view, out) => {
      const declared = authority.vehicle(view);
      VehicleState.copy(out, declared.state);
      return declared;
    },
    step: (state, ctx) => {
      if (ctx.input) state.throttle = ctx.input.value;
      state.distance += state.throttle * ctx.dt;
    },
    equals: (a, b) => Math.abs(a.distance - b.distance) <= 1e-5 && a.throttle === b.throttle,
    sample: (a, b, alpha, out) => {
      out.distance = a.distance + (b.distance - a.distance) * alpha;
      out.throttle = b.throttle;
    },
  };
  const character: PredictionAdapter<CharacterPredictionState, Frame, CharacterPredictionState> = {
    createState: () => CharacterState.create(),
    copyState: (source, out) => {
      CharacterState.copy(out, source);
    },
    readAuthoritative: (view, out) => {
      const declared = authority.character(view);
      CharacterState.copy(out, declared.state);
      return declared;
    },
    step: (state, ctx) => {
      if (ctx.input?.command) state.position = ctx.input.value;
      else if (ctx.input) state.moving = ctx.input.value !== 0;
      if (state.moving) state.position += ctx.dt;
    },
    equals: (a, b) => Math.abs(a.position - b.position) <= 1e-5 && a.moving === b.moving,
    sample: (_, b, __, out) => {
      CharacterState.copy(out, b);
    },
  };
  const inventory: PredictionAdapter<
    InventoryPredictionState,
    Frame,
    InventoryPredictionState,
    InventoryCommand
  > = {
    createState: () => InventoryState.create(),
    copyState: (source, out) => {
      InventoryState.copy(out, source);
    },
    readAuthoritative: (view, out) => {
      const declared = authority.inventory(view);
      InventoryState.copy(out, declared.state);
      return declared;
    },
    step: (state, ctx: PredictionStep<Frame, InventoryCommand>) => {
      for (const command of ctx.commands) {
        state.items.push(command.item);
        state.revision++;
      }
    },
    equals: (a, b) =>
      a.revision === b.revision &&
      a.items.length === b.items.length &&
      a.items.every((item, index) => item === b.items[index]),
    sample: (_, b, __, out) => {
      InventoryState.copy(out, b);
    },
  };
  return { vehicle, character, inventory };
}
