/// <reference lib="dom" />
import { createCompatibilityDescriptor, defineSchema, f } from '@conduit/protocol';
import { createCommandJournal, defineSystem } from '@conduit/sim';
import { expect, it } from 'vitest';
import { defineExternalCommand } from '../src/session.ts';
import { createHarness, testGame } from './harness.ts';
const compatibility = createCompatibilityDescriptor('testgame');
it('quarantines failed tick records and reports bounded recording overflow explicitly', async () => {
  const journal = createCommandJournal({
    compatibility,
    stateSchemaHash: testGame().registry.stateSchemaHash,
    capacity: 8,
    seed: 0xc0ffee,
    tickRate: 60,
    sessionEpoch: 'epoch',
    maxRecords: 1,
  });
  const h = await createHarness({
    session: { journal },
    systems: [defineSystem('valid', 'sim', () => {})],
  });
  await h.step();
  expect(journal.finalTick).toBe(0);
  expect(journal.ticks).toEqual([]);
  expect(journal.failures).toMatchObject([{ tick: 1, phase: 'authoritative' }]);
  expect(h.session.fault?.message).toContain('journal full');
  await h.session.stop();
});
it('validates and bounds queued asynchronous results before they enter simulation', async () => {
  const command = defineExternalCommand('result', defineSchema({ value: f.f32 }), () => {});
  const h = await createHarness({ session: { externalCommands: [command] } });
  expect(() => h.session.enqueueExternalCommand('missing', {})).toThrow('Unknown external');
  expect(() => h.session.enqueueExternalCommand('result', { value: NaN })).toThrow('finite');
  expect(() => h.session.enqueueExternalCommand('result', { value: 1 }, { tick: 0 })).toThrow(
    'bound',
  );
  for (let i = 0; i < 256; i++) h.session.enqueueExternalCommand('result', { value: i });
  expect(() => h.session.enqueueExternalCommand('result', { value: 1 })).toThrow('bound');
  await h.session.stop();
});

it('coalesces adjacent dropped ticks and checks live skip budgets before advancing', async () => {
  const journal = createCommandJournal({
    compatibility,
    stateSchemaHash: testGame().registry.stateSchemaHash,
    capacity: 8,
    seed: 0xc0ffee,
    tickRate: 60,
    sessionEpoch: 'skip-epoch',
    maxRecords: 1,
  });
  const h = await createHarness({ session: { journal } });
  h.session.skip(2);
  h.session.skip(3);
  expect(journal.skips).toEqual([{ first: 1, count: 5 }]);
  expect(journal.finalTick).toBe(5);
  await h.step(); // second record exceeds budget; no completed tick is committed
  expect(h.session.fault).not.toBeNull();
  expect(journal.finalTick).toBe(5);
  expect(journal.failures).toHaveLength(1);
  await h.session.stop();
});
