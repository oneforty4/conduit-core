/// <reference lib="dom" />
import { devVerifier } from '@conduit/auth';
import { Session, defineExternalCommand, executionStateOfCheckpoint } from '@conduit/net-server';
import { MemoryStore } from '@conduit/persist';
import { PlayerState, defineSchema, defineMessage, defineInput, f } from '@conduit/protocol';
import {
  createCommandJournal,
  defineComponent,
  defineSystem,
  fullStateDigest,
  firstStateDifference,
  replayCommandJournal,
  type StateSerializer,
} from '@conduit/sim';
import { GridWorld } from '@conduit/world';
import { expect, it } from 'vitest';
import { FakeLink } from '../../net-server/test/fake-link.ts';
import { TestClient, payloadOf } from '../../net-server/test/harness.ts';
import { defineGame, Owner, Region, Transform } from '../src/index.ts';
import { createJournalReplayRun } from '../src/replayRun.ts';
import { adaptHooks } from '../src/serverContext.ts';
import type { ServerHooks } from '../src/types.ts';

const Inventory = defineComponent(
  'JournalInventory',
  { items: f.array(f.u16, 32), selected: f.u16, awayObserved: f.bool, raw: f.f32 },
  { replicate: false },
);
const Add = defineMessage('AddItem', 'c2s', { item: f.u16 });
// A compatible copied-module/mutable-shell declaration resolves to the registry-owned definition.
const DeclaredAdd = { ...Add, schema: defineSchema({ item: f.u16 }) };
const Select = defineMessage('SelectItem', 'c2s', { index: f.u16 });
const Input = defineInput({ tick: f.u32, throttle: f.i8 });
const game = defineGame({
  id: 'journal-game',
  name: 'Journal game',
  protocolVersion: 3,
  compatibility: { simulationRevision: 'journal-v1', gameplayDigests: { rules: 'inventory-v1' } },
  seed: 0xc0ffee,
  tickRate: 60,
  snapshotEvery: 1,
  components: [Inventory],
  messages: [Add, Select],
  events: [],
  input: Input,
  systems: [
    defineSystem('hidden-rng', 'sim', (ctx) => {
      for (const e of ctx.world.query(Inventory))
        ctx.world.mutate(e, Inventory, (v) => {
          v.raw += ctx.rng.float() / 1000;
        });
    }),
  ],
  world: (seed) =>
    new GridWorld({ cellSize: 64, cols: 1, rows: 1, wantedDepth: 0, worldSeed: seed }),
});
const external = defineExternalCommand(
  'database-result',
  defineSchema({ value: f.u16 }),
  (payload, ctx) => {
    const e = [...ctx.world.query(Inventory)][0]!;
    ctx.world.mutate(e, Inventory, (v) => {
      v.items.push(payload.value);
      v.awayObserved = ctx.session.players()[0]?.state === PlayerState.Away;
    });
  },
);
function adapters() {
  let commands = 0;
  const serializers: StateSerializer[] = [
    {
      name: 'game-owned',
      version: 1,
      capture: () => ({ commands }),
      validate(value) {
        if (
          value === null ||
          typeof value !== 'object' ||
          !Number.isInteger(Reflect.get(value, 'commands'))
        )
          throw new TypeError('invalid game state');
      },
      restore(value) {
        commands = Reflect.get(value as object, 'commands') as number;
      },
    },
  ];
  const hooks: ServerHooks<ReturnType<typeof Input.create>> = {
    onInit(ctx) {
      ctx.world.add(ctx.world.create(), Inventory, { raw: -0 });
    },
    onPlayerJoin: (player) => ({
      regionId: 'cell/0_0',
      spawn(ctx) {
        const e = ctx.world.create();
        ctx.world.add(e, Region, { id: 'cell/0_0' });
        ctx.world.add(e, Transform, { pos: { x: 1, y: 0, z: 1 } });
        ctx.world.add(e, Owner, { player: player.playerId });
        return e;
      },
    }),
    onMessage: {
      AddItem(_player, payload, ctx) {
        const e = [...ctx.world.query(Inventory)][0]!;
        ctx.world.mutate(e, Inventory, (v) => {
          v.items.push((payload as { item: number }).item);
        });
        commands++;
      },
      SelectItem(_player, payload, ctx) {
        const e = [...ctx.world.query(Inventory)][0]!;
        ctx.world.mutate(e, Inventory, (v) => {
          v.selected = (payload as { index: number }).index;
        });
        commands++;
      },
    },
  };
  return { hooks, serializers };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

it('records inventory/selection/external results, away and reconnect state, idle tails and exact seek', async () => {
  const journal = createCommandJournal({
    compatibility: game.compatibility,
    stateSchemaHash: game.registry.stateSchemaHash,
    capacity: 8,
    tickRate: 60,
    seed: game.seed,
    sessionEpoch: 'epoch-1',
  });
  const sourceAdapters = adapters();
  const session = new Session(game, {
    store: new MemoryStore(),
    regionLoader: { populate() {} },
    hooks: adaptHooks(sourceAdapters.hooks, game),
    manualLoop: true,
    sessionId: 'dev',
    verifier: devVerifier({ warn() {} }),
    journal,
    simulationMessages: [DeclaredAdd, Select],
    externalCommands: [external],
    stateSerializers: sourceAdapters.serializers,
  });
  await session.start();
  const link = new FakeLink(1);
  session.attach(link);
  const client = new TestClient(game.registry, link);
  client.hello({ compatibility: game.compatibility });
  const welcome = payloadOf<{ reconnectToken: string }>(client.take(), 'Welcome');
  const step = async () => {
    session.step();
    if (session.fault !== null) throw session.fault;
    await settle();
  };
  await step();
  expect(() => session.captureCheckpoint()).toThrow('spawnPlanSerializer');
  client.ready();
  const regionSet = payloadOf<{ active: string[] }>(client.take(), 'RegionSet');
  client.regionLoadState(regionSet.active);
  for (let i = 0; i < 4 && session.players()[0]?.state !== PlayerState.Playing; i++) await step();
  client.take();
  client.sendMessage(Add, { item: 11 });
  client.sendMessage(Select, { index: 1 });
  await step();
  session.enqueueExternalCommand('database-result', { value: 22 }, { tick: session.tick + 3 });
  await step();
  const checkpoint = session.captureCheckpoint();
  const sourceState = executionStateOfCheckpoint(checkpoint);
  expect(await fullStateDigest(executionStateOfCheckpoint(session.captureCheckpoint()))).toBe(
    await fullStateDigest(sourceState),
  );
  link.remoteClose();
  await step();
  await step(); // external result sees Away, without repeating the database request
  const reconnectLink = new FakeLink(2);
  session.attach(reconnectLink);
  const reconnect = new TestClient(game.registry, reconnectLink);
  reconnect.hello({ reconnectToken: welcome.reconnectToken, compatibility: game.compatibility });
  await step();
  reconnect.take();
  session.skip(2);
  await step();
  await step();
  const expected = executionStateOfCheckpoint(session.captureCheckpoint());
  const runs: Awaited<ReturnType<typeof createJournalReplayRun>>[] = [];
  const factory = {
    async createRun() {
      const a = adapters();
      const run = await createJournalReplayRun(game, journal, {
        regionLoader: { populate() {} },
        hooks: () => a.hooks,
        simulationMessages: [DeclaredAdd, Select],
        externalCommands: [external],
        stateSerializers: a.serializers,
      });
      runs.push(run);
      return run;
    },
  };
  const run = await factory.createRun();
  for (const tick of journal.ticks) {
    if (tick.tick > run.session.tick + 1) run.skip(tick.tick - run.session.tick - 1);
    for (const record of tick.records) run.apply(record.action);
    await run.step(tick.tick);
  }
  const actual = run.capture();
  expect(firstStateDifference(expected, actual)).toBeNull();
  await run.dispose();
  expect(
    await replayCommandJournal(factory, journal, {
      checkpoint: {
        tick: checkpoint.completedTick,
        state: checkpoint,
        digest: await fullStateDigest(checkpoint),
      },
    }),
  ).toEqual({ ok: true, finalTick: journal.finalTick });
  expect(runs.at(-1)?.session.tick).toBe(journal.finalTick);
  const fromInitial = {
    ...journal,
    initialCheckpoint: {
      id: 'intermediate-exact',
      tick: checkpoint.completedTick,
      digest: await fullStateDigest(checkpoint),
    },
    ticks: journal.ticks.filter((tick) => tick.tick > checkpoint.completedTick),
    skips: journal.skips.filter((skip) => skip.first > checkpoint.completedTick),
  };
  expect(
    await replayCommandJournal({ ...factory, loadCheckpoint: async () => checkpoint }, fromInitial),
  ).toEqual({ ok: true, finalTick: journal.finalTick });
  const restored = await factory.createRun();
  const beforeInvalid = restored.capture();
  const corrupted = {
    ...checkpoint,
    session: {
      ...checkpoint.session,
      messages: [{ playerId: 99, name: 'AddItem', payload: { item: 1 } }],
    },
  };
  expect(() => restored.restore(corrupted)).toThrow('handler/player');
  expect(firstStateDifference(beforeInvalid, restored.capture())).toBeNull();
  restored.restore(checkpoint);
  expect(firstStateDifference(sourceState, restored.capture())).toBeNull();
  for (const tick of journal.ticks.filter((entry) => entry.tick > checkpoint.completedTick)) {
    if (tick.tick > restored.session.tick + 1) restored.skip(tick.tick - restored.session.tick - 1);
    for (const record of tick.records) restored.apply(record.action);
    await restored.step(tick.tick);
  }
  expect(firstStateDifference(expected, restored.capture())).toBeNull();
  restored.dispose();
  const inventory = session.world.get([...session.world.query(Inventory)][0]!, Inventory);
  expect(inventory.items).toEqual([11, 22]);
  expect(inventory.selected).toBe(1);
  expect(inventory.awayObserved).toBe(true);
  await session.stop();
});
