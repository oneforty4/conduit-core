import { describe, expect, it } from 'vitest';
import { Mutex } from '../src/index.ts';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Mutex', () => {
  it('runs 10 queued calls one at a time in FIFO order', async () => {
    const mutex = new Mutex();
    const log: string[] = [];
    let active = 0;
    let maxActive = 0;
    const runs = Array.from({ length: 10 }, (_, i) =>
      mutex.run(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        log.push(`start ${i}`);
        await delay(10 - i); // later calls are faster: without the lock they would finish first
        log.push(`end ${i}`);
        active--;
        return i;
      }),
    );
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(maxActive).toBe(1);
    expect(log).toEqual(Array.from({ length: 10 }, (_, i) => [`start ${i}`, `end ${i}`]).flat());
  });

  it('accepts synchronous fns and resolves with their value', async () => {
    const mutex = new Mutex();
    const object = { value: 1 };
    await expect(mutex.run(() => 42)).resolves.toBe(42);
    await expect(mutex.run(() => object)).resolves.toBe(object);
  });

  it('a throwing fn releases the lock', async () => {
    const mutex = new Mutex();
    const syncErr = new Error('sync');
    const asyncErr = new Error('async');
    const results = await Promise.allSettled([
      mutex.run(() => {
        throw syncErr;
      }),
      mutex.run(async () => {
        await delay(1);
        throw asyncErr;
      }),
      mutex.run(() => 'after'),
    ]);
    expect(results).toEqual([
      { status: 'rejected', reason: syncErr },
      { status: 'rejected', reason: asyncErr },
      { status: 'fulfilled', value: 'after' },
    ]);
    expect(mutex.locked).toBe(false);
    await expect(mutex.run(() => 'still usable')).resolves.toBe('still usable');
  });

  it('locked reflects state', async () => {
    const mutex = new Mutex();
    expect(mutex.locked).toBe(false);

    let open = (): void => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const lockedInside: boolean[] = [];
    const first = mutex.run(async () => {
      lockedInside.push(mutex.locked);
      await gate;
    });
    expect(mutex.locked).toBe(true); // taken as soon as run() is called
    const second = mutex.run(() => {
      lockedInside.push(mutex.locked);
    });
    await delay(5);
    expect(mutex.locked).toBe(true);
    expect(lockedInside).toEqual([true]); // the second fn is still waiting

    open();
    await Promise.all([first, second]);
    expect(lockedInside).toEqual([true, true]);
    expect(mutex.locked).toBe(false);
  });
});
