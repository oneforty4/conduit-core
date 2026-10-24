import { createCompatibilityDescriptor } from '@conduit/protocol';
import { describe, expect, it } from 'vitest';
import {
  createCommandJournal,
  decodeCommandJournal,
  encodeCommandJournal,
  fullStateDigest,
  replayCommandJournal,
  validateCommandJournal,
  type JournalReplayRun,
} from '../src/index.ts';

const compatibility = createCompatibilityDescriptor('journal-test', {
  simulationRevision: 'v1',
  gameplayDigests: { rules: 'one' },
});
function empty() {
  return createCommandJournal({
    compatibility,
    stateSchemaHash: 0,
    capacity: 8,
    tickRate: 60,
    seed: 1,
    sessionEpoch: 'epoch',
  });
}

describe('versioned command journals', () => {
  it('retains undefined/signed zero payloads, explicit idle tails and skips, and always disposes', async () => {
    const journal = empty();
    journal.finalTick = 7;
    journal.ticks.push({
      tick: 1,
      records: [
        {
          order: 0,
          action: {
            kind: 'external',
            name: 'result',
            actor: null,
            payload: { value: -0, optional: undefined },
          },
        },
      ],
    });
    journal.skips.push({ first: 3, count: 2 });
    const decoded = decodeCommandJournal(encodeCommandJournal(journal));
    expect(decoded).toEqual(journal);
    const seen: number[] = [];
    let disposed = 0;
    const run: JournalReplayRun = {
      tick: 0,
      compatibility,
      stateSchemaHash: 0,
      capacity: 8,
      apply() {},
      async step(tick) {
        seen.push(tick);
      },
      skip(count) {
        seen.push(-count);
      },
      capture: () => ({}),
      restore() {},
      dispose() {
        disposed++;
      },
    };
    expect(await replayCommandJournal({ createRun: async () => run }, decoded)).toEqual({
      ok: true,
      finalTick: 7,
    });
    expect(seen).toEqual([1, 2, -2, 5, 6, 7]);
    expect(disposed).toBe(1);
  });

  it('reports the first divergent hidden field, rejects unknown handlers and disposes on failure', async () => {
    const journal = empty();
    journal.finalTick = 2;
    const state = { rng: { global: 12 }, hidden: { inventory: [3] } };
    journal.ticks.push({ tick: 1, records: [], digest: await fullStateDigest(state), state });
    let disposed = 0;
    const run: JournalReplayRun = {
      tick: 0,
      compatibility,
      stateSchemaHash: 0,
      capacity: 8,
      apply() {
        throw new TypeError('Missing simulation command handler');
      },
      async step() {},
      skip() {},
      capture: () => ({ rng: { global: 12 }, hidden: { inventory: [4] } }),
      restore() {},
      dispose() {
        disposed++;
      },
    };
    expect(await replayCommandJournal({ createRun: async () => run }, journal)).toMatchObject({
      ok: false,
      tick: 1,
      reason: 'divergence',
      difference: { path: '$.hidden.inventory.0', expected: 3, actual: 4 },
    });
    expect(disposed).toBe(1);
    const commands = empty();
    commands.finalTick = 1;
    commands.ticks.push({
      tick: 1,
      records: [
        { order: 0, action: { kind: 'external', name: 'missing', actor: null, payload: 1 } },
      ],
    });
    expect(await replayCommandJournal({ createRun: async () => run }, commands)).toMatchObject({
      ok: false,
      reason: 'fault',
      message: 'Missing simulation command handler',
    });
    expect(disposed).toBe(2);
  });

  it('rejects incompatible revisions, unknown formats, bad order and record/byte budgets', () => {
    const journal = empty();
    expect(() =>
      validateCommandJournal({ ...journal, version: 9 } as unknown as typeof journal),
    ).toThrow('Unsupported');
    expect(() =>
      validateCommandJournal(
        journal,
        createCompatibilityDescriptor('journal-test', {
          simulationRevision: 'v2',
          gameplayDigests: { rules: 'one' },
        }),
      ),
    ).toThrow('simulationRevision');
    journal.finalTick = 1;
    journal.ticks.push({
      tick: 1,
      records: [{ order: 2, action: { kind: 'input', playerId: 0, frame: undefined } }],
    });
    expect(() => validateCommandJournal(journal)).toThrow('ordering');
    expect(() =>
      createCommandJournal({
        compatibility,
        stateSchemaHash: 0,
        capacity: 8,
        tickRate: 60,
        seed: 1,
        sessionEpoch: 'x',
        maxRecords: Infinity,
      }),
    ).toThrow();
    expect(() =>
      validateCommandJournal({ ...journal, ticks: [{ tick: 1, records: [] }], maxBytes: 1 }),
    ).toThrow();
  });
  it('bounds missing-tick work, overflowed skips, failures and mislabeled seek checkpoints', async () => {
    const journal = empty();
    expect(() => validateCommandJournal({ ...journal, finalTick: 1e12 })).toThrow('work/span');
    expect(() =>
      validateCommandJournal({
        ...journal,
        finalTick: Number.MAX_SAFE_INTEGER,
        skips: [{ first: Number.MAX_SAFE_INTEGER, count: 2 }],
      }),
    ).toThrow('skip');
    expect(() =>
      validateCommandJournal({
        ...journal,
        failures: [{ tick: 1, system: 'x', phase: 'sim', message: 'x'.repeat(2049) }],
      }),
    ).toThrow('diagnostic');
    journal.finalTick = 2;
    const state = { tick: 1 };
    let disposed = false;
    const run: JournalReplayRun = {
      tick: 1,
      compatibility,
      stateSchemaHash: 0,
      capacity: 8,
      apply() {},
      async step() {},
      skip() {},
      capture: () => state,
      restore() {},
      dispose() {
        disposed = true;
      },
    };
    expect(
      await replayCommandJournal({ createRun: async () => run }, journal, {
        checkpoint: { tick: 2, state, digest: await fullStateDigest(state) },
      }),
    ).toMatchObject({
      ok: false,
      reason: 'fault',
      message: 'Restored checkpoint tick differs from seek reference',
    });
    expect(disposed).toBe(true);
  });
});
