import { type InputLog, type LifecycleEntry } from '@conduit/sim';
import { describe, expect, it } from 'vitest';
import { RECONNECT_GRACE_MS } from '../src/constants.ts';
import { createHarness, joinAndSpawn, payloadOf } from './harness.ts';

// SessionOptions.recordLog (docs/net.md A.5, docs/sim.md 2.11): the frames the steps consume and the
// ticks of the lifecycle steps the Session runs.

const SEED = 0xc0ffee;

function emptyLog(): InputLog {
  return { version: 1, seed: SEED, tickRate: 60, entries: [] };
}

describe('Session recordLog', () => {
  it('records frame changes as steps consume them and every join, spawn and leave with its tick', async () => {
    const log = emptyLog();
    const h = await createHarness({ session: { recordLog: log } });
    const lifecycle = (): LifecycleEntry[] => log.lifecycle ?? [];

    const a = h.client();
    await joinAndSpawn(h, a, 'A');
    const spawnedA = h.session.tick;
    expect(lifecycle()).toEqual([
      [1, 0, { type: 'join', accountId: 'dev:a', displayName: 'A' }],
      [spawnedA, 0, { type: 'spawn' }],
    ]);
    expect(log.entries).toEqual([]);

    const t = h.session.tick;
    a.input([t + 1], 50);
    await h.step(); // t + 1: a new frame
    a.input([t + 2], 50);
    await h.step(); // t + 2: the tick field changed, so the frame did
    await h.step(); // t + 3: no input, the frame is held: nothing
    a.input([t + 4, t + 5], -20);
    await h.step(2); // t + 4, t + 5
    a.input([t + 3], 99); // late: never accepted, never consumed
    a.input([t + 6], -20);
    a.link.remoteClose(1006);
    await h.step(); // t + 6: away, the frame is released
    await h.step(); // t + 7: still none
    expect(log.entries).toEqual([
      [t + 1, 0, { tick: t + 1, throttle: 50 }],
      [t + 2, 0, { tick: t + 2, throttle: 50 }],
      [t + 4, 0, { tick: t + 4, throttle: -20 }],
      [t + 5, 0, { tick: t + 5, throttle: -20 }],
      [t + 6, 0, null],
    ]);

    const b = h.client();
    b.hello({ displayName: 'B' });
    await h.step();
    const joinedB = h.session.tick;
    b.ready();
    b.regionLoadState(payloadOf<{ active: string[] }>(b.take(), 'RegionSet').active);
    await h.step();
    const spawnedB = h.session.tick;
    b.input([spawnedB + 1], 7);
    await h.step();
    b.leave();
    await h.step();
    const leftB = h.session.tick;

    h.clock.advance(RECONNECT_GRACE_MS);
    await h.step();
    const leftA = h.session.tick;
    expect(lifecycle()).toEqual([
      [1, 0, { type: 'join', accountId: 'dev:a', displayName: 'A' }],
      [spawnedA, 0, { type: 'spawn' }],
      [joinedB, 1, { type: 'join', accountId: 'dev:b', displayName: 'B' }],
      [spawnedB, 1, { type: 'spawn' }],
      [leftB, 1, { type: 'leave' }],
      [leftA, 0, { type: 'leave' }],
    ]);
    expect(log.entries.slice(5)).toEqual([
      [spawnedB + 1, 1, { tick: spawnedB + 1, throttle: 7 }],
      [leftB, 1, null],
    ]);
    expect(h.session.players()).toEqual([]);
    expect(JSON.parse(JSON.stringify(log))).toEqual(log);
  });

  it('does not commit lifecycle records from a failed authoritative join', async () => {
    const log = emptyLog();
    const h = await createHarness({
      session: { recordLog: log },
      hooks: {
        onPlayerJoin: () => {
          throw new Error('no Z');
        },
      },
    });
    const z = h.client();
    z.hello({ displayName: 'Z' });
    await h.step();
    expect(h.session.fault).toMatchObject({ tick: 1, system: 'onPlayerJoin' });
    expect(log.lifecycle ?? []).toEqual([]);
    expect(log.entries).toEqual([]);
    expect(() => h.session.step()).toThrow('faulted');
  });

  it('installs nothing without a recordLog and rejects a log that does not fit the game', async () => {
    const plain = await createHarness();
    expect(plain.session.simulation.onInputsPlaced).toBeUndefined();

    const bad = (patch: Record<string, unknown>): InputLog =>
      ({ ...emptyLog(), ...patch }) as InputLog;
    for (const recordLog of [
      bad({ version: 2 }),
      bad({ seed: SEED + 1 }),
      bad({ tickRate: 30 }),
      bad({ entries: [[1, 0, null]] }),
      bad({ entries: undefined }),
      bad({ lifecycle: [[1, 0, { type: 'leave' }]] }),
    ]) {
      await expect(createHarness({ session: { recordLog }, start: false })).rejects.toThrow(
        RangeError,
      );
    }
    const ok = await createHarness({ session: { recordLog: { ...emptyLog(), lifecycle: [] } } });
    expect(ok.session.simulation.onInputsPlaced).toBeTypeOf('function');
  });
});
