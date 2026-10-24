import type { InputFrameBase, InputPayload } from '@conduit/protocol';
import { describe, expect, it } from 'vitest';
import { createConn } from '../src/client-conn.ts';
import { INPUT_QUEUE_MAX } from '../src/constants.ts';
import { acceptInput, drainInput } from '../src/input-queue.ts';
import { createStats } from '../src/stats.ts';
import { FakeLink } from './fake-link.ts';

interface Frame extends InputFrameBase {
  throttle: number;
}

function msg(...ticks: number[]): InputPayload<Frame> {
  return { firstTick: ticks[0] ?? 0, frames: ticks.map((tick) => ({ tick, throttle: tick * 10 })) };
}

function setup() {
  return { conn: createConn(new FakeLink(1), null, 0), stats: createStats() };
}

function queuedTicks(conn: ReturnType<typeof setup>['conn']): number[] {
  return conn.inputQueue.map((q) => q.frame.tick);
}

describe('acceptInput', () => {
  it('ignores duplicates carried by the 4-frame redundancy', () => {
    const { conn, stats } = setup();
    expect(acceptInput(conn, msg(10, 11, 12, 13), 1, stats)).toBe(true);
    expect(acceptInput(conn, msg(11, 12, 13, 14), 2, stats)).toBe(true);
    expect(acceptInput(conn, msg(12, 13, 14, 15), 3, stats)).toBe(true);
    expect(queuedTicks(conn)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(conn.inputQueue.map((q) => q.seq)).toEqual([1, 1, 1, 1, 2, 3]);
    expect(conn.lastInputTick).toBe(15);
    expect(conn.lastInputSeq).toBe(3);
    expect(stats.inputOverflow).toBe(0);
  });

  it('caps the queue at INPUT_QUEUE_MAX by dropping the oldest', () => {
    const { conn, stats } = setup();
    acceptInput(conn, msg(1, 2, 3, 4), 0, stats);
    acceptInput(conn, msg(5, 6, 7, 8), 1, stats);
    expect(INPUT_QUEUE_MAX).toBe(6);
    expect(queuedTicks(conn)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(stats.inputOverflow).toBe(2);
  });

  it('rejects empty, mislabelled and non-ascending messages', () => {
    const { conn, stats } = setup();
    expect(acceptInput(conn, { firstTick: 3, frames: [] }, 0, stats)).toBe(false);
    expect(acceptInput(conn, { firstTick: 4, frames: msg(3, 4).frames }, 1, stats)).toBe(false);
    expect(acceptInput(conn, msg(5, 5), 2, stats)).toBe(false);
    expect(acceptInput(conn, msg(7, 6), 3, stats)).toBe(false);
    expect(stats.badInput).toBe(4);
    expect(conn.inputQueue).toEqual([]);
    expect(conn.lastInputSeq).toBe(0);
  });

  it('skips frames at or below the highest accepted tick (late arrivals)', () => {
    const { conn, stats } = setup();
    acceptInput(conn, msg(20), 5, stats);
    acceptInput(conn, msg(17, 18, 19), 4, stats);
    expect(queuedTicks(conn)).toEqual([20]);
    expect(conn.lastInputSeq).toBe(4);
  });
});

describe('drainInput', () => {
  it('drops stale frames and applies the frame for the tick', () => {
    const { conn, stats } = setup();
    acceptInput(conn, msg(8, 9, 10, 11), 3, stats);
    expect(drainInput(conn, 10, stats)).toBe(true);
    expect(stats.staleInputs).toBe(2);
    expect(conn.held).toEqual({ tick: 10, throttle: 100 });
    expect(conn.appliedTick).toBe(10);
    expect(conn.appliedSeq).toBe(3);
    expect(queuedTicks(conn)).toEqual([11]);
  });

  it('holds the last frame across missing ticks and updates applied* only on a hit', () => {
    const { conn, stats } = setup();
    expect(drainInput(conn, 1, stats)).toBe(false);
    expect(conn.held).toBeUndefined();
    expect(conn.appliedTick).toBe(0);

    acceptInput(conn, msg(2), 7, stats);
    expect(drainInput(conn, 2, stats)).toBe(true);
    const held = conn.held;

    acceptInput(conn, msg(5, 6), 8, stats);
    expect(drainInput(conn, 3, stats)).toBe(false);
    expect(drainInput(conn, 4, stats)).toBe(false);
    expect(conn.held).toBe(held);
    expect(conn.appliedTick).toBe(2);
    expect(conn.appliedSeq).toBe(7);
    expect(stats.missingInputs).toBe(3);

    expect(drainInput(conn, 5, stats)).toBe(true);
    expect(conn.held).toEqual({ tick: 5, throttle: 50 });
    expect(conn.appliedTick).toBe(5);
    expect(conn.appliedSeq).toBe(8);
  });

  it('keeps future frames queued until their tick', () => {
    const { conn, stats } = setup();
    acceptInput(conn, msg(30, 31), 1, stats);
    expect(drainInput(conn, 28, stats)).toBe(false);
    expect(drainInput(conn, 29, stats)).toBe(false);
    expect(queuedTicks(conn)).toEqual([30, 31]);
    expect(drainInput(conn, 30, stats)).toBe(true);
    expect(drainInput(conn, 31, stats)).toBe(true);
    expect(conn.inputQueue).toEqual([]);
    expect(stats.staleInputs).toBe(0);
  });
});

it('rejects future/stale targets without poisoning the watermark and retains a supported lead', () => {
  const { conn, stats } = setup();
  const bounds = { serverTick: 100, maxFutureTicks: 32, maxStaleTicks: 2 };
  acceptInput(conn, msg(10000), 1, stats, bounds);
  expect(conn.lastInputTick).toBe(0);
  acceptInput(conn, msg(1), 2, stats, bounds);
  expect(conn.lastInputTick).toBe(0);
  for (let tick = 101; tick <= 132; tick++) acceptInput(conn, msg(tick), tick, stats, bounds);
  expect(conn.inputQueue).toHaveLength(32);
  expect(stats.inputOverflow).toBe(0);
  expect(stats.badInput).toBe(2);
  expect(drainInput(conn, 101, stats)).toBe(true);
});
