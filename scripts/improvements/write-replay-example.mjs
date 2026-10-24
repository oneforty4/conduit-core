import { writeFile } from 'node:fs/promises';
import { createCompatibilityDescriptor } from '../../packages/protocol/src/index.ts';
import {
  attachJournalDiagnostic,
  cloneExactState,
  createCommandJournal,
  encodeCommandJournal,
} from '../../packages/sim/src/index.ts';
const journal = createCommandJournal({
  compatibility: createCompatibilityDescriptor('replay-example', {
    simulationRevision: 'example-v1',
    gameplayDigests: { rules: 'one' },
  }),
  stateSchemaHash: 0,
  capacity: 8,
  tickRate: 60,
  seed: 123,
  sessionEpoch: 'artifact-example',
});
journal.finalTick = 8;
journal.ticks.push({
  tick: 2,
  records: [
    {
      order: 0,
      action: { kind: 'external', name: 'database-result', actor: null, payload: { item: 7 } },
    },
  ],
});
journal.ticks.push({
  tick: 5,
  records: [
    {
      order: 0,
      action: {
        kind: 'message',
        name: 'SelectItem',
        actor: { playerId: 0, actorId: 'opaque-player', displayName: 'example' },
        payload: { index: 1 },
      },
    },
  ],
});
journal.ticks.push({ tick: 8, records: [] });
await attachJournalDiagnostic(journal, 8, { inventory: [7], selected: 1 });
await writeFile(
  'artifacts/improvements/step5/example-journal.exact',
  encodeCommandJournal(journal),
);
const divergent = cloneExactState(journal);
divergent.ticks[0] = {
  tick: 2,
  records: [
    {
      order: 0,
      action: { kind: 'external', name: 'database-result', actor: null, payload: { item: 8 } },
    },
  ],
};
await writeFile(
  'artifacts/improvements/step5/example-divergent-journal.exact',
  encodeCommandJournal(divergent),
);
