import { performance } from 'node:perf_hooks';
import { Session } from '../../packages/net-server/src/index.ts';
import { MemoryStore } from '../../packages/persist/src/index.ts';
import { defineGame, defineInput, f, GridWorld } from '../../packages/game/src/index.ts';
import { createCommandJournal } from '../../packages/sim/src/index.ts';
const game = defineGame({
  id: 'journal-benchmark',
  name: 'Journal benchmark',
  protocolVersion: 1,
  tickRate: 60,
  seed: 1,
  components: [],
  messages: [],
  events: [],
  input: defineInput({ tick: f.u32 }),
  systems: [],
  world: (seed) =>
    new GridWorld({ cellSize: 64, cols: 1, rows: 1, wantedDepth: 0, worldSeed: seed }),
});
const results = [];
for (const enabled of [false, true]) {
  const journal = enabled
    ? createCommandJournal({
        compatibility: game.compatibility,
        stateSchemaHash: game.registry.stateSchemaHash,
        capacity: 8,
        tickRate: 60,
        seed: 1,
        sessionEpoch: 'bench',
      })
    : undefined;
  const session = new Session(game, {
    store: new MemoryStore(),
    regionLoader: { populate() {} },
    hooks: {
      onPlayerJoin() {
        throw new Error('no benchmark players');
      },
    },
    manualLoop: true,
    ...(journal ? { journal } : {}),
  });
  await session.start();
  const sample = () => {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) session.step();
    return performance.now() - start;
  };
  sample();
  const samples = Array.from({ length: 5 }, sample).sort((a, b) => a - b);
  results.push({
    journalEnabled: enabled,
    ticksPerSample: 1000,
    medianMs: +samples[2].toFixed(3),
    journalRecords: journal?.ticks.reduce((count, tick) => count + tick.records.length, 0) ?? 0,
    encodedBytes: journal?.encodedBytes ?? 0,
  });
  await session.stop();
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      scope:
        'empty Session current implementation: disabled branch baseline versus optional collection, not a historical before/after overhead estimate',
      results,
    },
    null,
    2,
  ),
);
