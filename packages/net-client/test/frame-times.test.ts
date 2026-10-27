import { Rng } from '@conduit/math';
import { describe, expect, it } from 'vitest';
import { FrameTimes } from '../src/index.ts';

/**
 * `count` frames shown on a refresh of `period` ms, each `steps` periods after the one before as
 * `pick` chooses, and their timestamps up to `noise` ms either side of when they were shown.
 */
function frames(count: number, period: number, pick: (r: number) => number, noise: number) {
  const rng = new Rng(7);
  const shown: number[] = [];
  let at = 1000;
  for (let i = 0; i < count; i++) shown.push((at += period * pick(rng.float())));
  return { shown, stamps: shown.map((t) => t + (rng.float() * 2 - 1) * noise) };
}

/**
 * The most that `got` steps from frame to frame otherwise than `want` does, and that it strays
 * from `want`, from frame `from` on.
 */
function worst(got: number[], want: number[], from: number) {
  let step = 0;
  let off = 0;
  for (let i = from; i < got.length; i++) {
    step = Math.max(step, Math.abs(got[i]! - got[i - 1]! - (want[i]! - want[i - 1]!)));
    off = Math.max(off, Math.abs(got[i]! - want[i]!));
  }
  return { step, off };
}

/** The timestamp of the `i`th frame on a 120 Hz refresh: 0.3 ms early or late by turns. */
const onRefresh = (i: number): number => 1000 + (i * 1000) / 120 + (i % 2 ? 0.3 : -0.3);

const CADENCES: [string, number, (r: number) => number][] = [
  ['60 Hz', 1000 / 60, () => 1],
  ['60 Hz dropping one frame in twenty', 1000 / 60, (r) => (r < 0.05 ? 2 : 1)],
  ['120 Hz', 1000 / 120, () => 1],
  ['120 Hz dropping a third of its frames', 1000 / 120, (r) => (r < 0.25 ? 2 : r < 0.3 ? 3 : 1)],
  ['120 Hz at some 55 frames a second', 1000 / 120, (r) => (r < 0.6 ? 2 : 3)],
  // A MacBook's 120 Hz display drawn at full resolution: frames 8.3, 16.7 and 25 ms apart.
  [
    '120 Hz one, two and three refreshes apart',
    1000 / 120,
    (r) => (r < 0.5 ? 1 : r < 0.85 ? 2 : 3),
  ],
  ['144 Hz dropping one frame in five', 1000 / 144, (r) => (r < 0.2 ? 2 : 1)],
];

describe('FrameTimes', () => {
  // Timestamp noise either side, ms, and how far frames may then step and stray at worst, ms. The
  // timestamps themselves step by up to twice the noise, and stray by the noise.
  const NOISE: [string, number, number, number][] = [
    ['puts frames on the refresh through half a millisecond of timestamp noise', 0.5, 0.3, 0.6],
    ['puts frames on the refresh through a millisecond of timestamp noise', 1, 1.2, 1.2],
    ['is never worse than the timestamps through a millisecond and a half', 1.5, 3, 1.55],
  ];
  for (const [title, noise, stepMs, offMs] of NOISE)
    for (const [name, period, pick] of CADENCES)
      it(`${title}: ${name}`, () => {
        const { shown, stamps } = frames(3000, period, pick, noise);
        const times = new FrameTimes();
        const { step, off } = worst(
          stamps.map((stamp) => times.at(stamp)),
          shown,
          100,
        );
        expect(step).toBeLessThan(stepMs);
        expect(off).toBeLessThan(offMs);
      });

  it('fits the refresh, not a fraction of it, though noise fits a fraction better', () => {
    // A dead-steady 60 Hz display's intervals, anti-correlated noise of up to 2 ms: they come out
    // near alternate multiples of 3.7 ms, and a period of 3.7 ms would misplace every frame.
    const noise = [2, -2, 1.9, -1.8, 1.6, -2, 2, -1.5, 1.8, -1.9];
    const times = new FrameTimes();
    let stamp = 0;
    for (let i = 0; i < 240; i++) times.at((stamp += 1000 / 60 + noise[i % noise.length]!));
    expect(times.refreshMs).toBeCloseTo(1000 / 60, 0);
  });

  it('fits the refresh, not a multiple of it, at two and three refreshes a frame', () => {
    const { stamps } = frames(600, 1000 / 120, (r) => (r < 0.6 ? 2 : 3), 1);
    const times = new FrameTimes();
    const refreshes = new Set<string>();
    for (const [i, stamp] of stamps.entries()) {
      times.at(stamp);
      if (i >= 100) refreshes.add(times.refreshMs?.toFixed(1) ?? 'none');
    }
    expect([...refreshes].sort()).toEqual(['8.3', '8.4']);
  });

  it('moves on by a dropped frame at once', () => {
    const times = new FrameTimes();
    let stamp = 0;
    for (let i = 0; i < 100; i++) times.at((stamp += 1000 / 120));
    const before = times.at((stamp += 1000 / 120));
    expect(times.at((stamp += 2000 / 120)) - before).toBeCloseTo(2000 / 120, 6);
    expect(times.at((stamp += 1000 / 120)) - stamp).toBeCloseTo(0, 6);
  });

  it('takes a frame that comes too soon to be on the refresh at its timestamp', () => {
    const times = new FrameTimes();
    let stamp = 0;
    for (let i = 0; i < 100; i++) times.at((stamp += 1000 / 60));
    expect(times.at(stamp + 0.6)).toBe(stamp + 0.6);
    expect(times.at(stamp + 1000 / 60)).toBeCloseTo(stamp + 1000 / 60, 6);
  });

  it('never shows a frame sooner than the one before, though its timestamp is', () => {
    const times = new FrameTimes();
    for (let i = 0; i < 100; i++) times.at(onRefresh(i));
    // Stamped early, so put after its timestamp; then frames stamped between the two.
    let shown = times.at(onRefresh(100));
    expect(shown).toBeGreaterThan(onRefresh(100));
    for (const early of [0.05, 0.1, 0.2]) {
      const next = times.at(onRefresh(100) + early);
      expect(next).toBeGreaterThanOrEqual(shown);
      shown = next;
    }
  });

  it('takes a frame after a stall, or on a clock that went back, at its timestamp', () => {
    const times = new FrameTimes();
    let stamp = 0;
    for (let i = 0; i < 100; i++) times.at((stamp += 1000 / 60 + (i % 2 ? 0.8 : -0.8)));
    expect(times.at(stamp + 700.3)).toBe(stamp + 700.3);
    expect(times.refreshMs).toBeUndefined();
    expect(times.at(12.5)).toBe(12.5);
  });

  it('keeps within two milliseconds of timestamps with no refresh to keep to', () => {
    const rng = new Rng(3);
    const times = new FrameTimes();
    let stamp = 0;
    for (let i = 0; i < 2000; i++) {
      stamp += 12 + 10 * rng.float();
      expect(Math.abs(times.at(stamp) - stamp)).toBeLessThanOrEqual(2);
    }
  });
});
