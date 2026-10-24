import type { InputFrameBase } from '@conduit/protocol';
import { describe, expect, it } from 'vitest';
import { InputSender, NetClock } from '../src/index.ts';
import { TestInput } from './helpers.ts';
import { ScenarioClock } from './scenarios/clock.ts';

for (const fps of [30, 60, 120, 144]) {
  it(`shares timer and ${fps} Hz frame wakes without accelerating 60 Hz input`, () => {
    const time = new ScenarioClock();
    const clock = new NetClock({ now: () => time.now });
    clock.addSample(0, 0, 0);
    const sent: number[] = [];
    const input = new InputSender(TestInput, (m) => sent.push(m.frames.at(-1)!.tick), clock);
    const timers = time.timers('client', 16);
    const wake = () => {
      input.tick(time.now);
      timers.setTimeout(wake, Math.max(1, clock.nextInputDeadline(input.lastSentTick) - time.now));
    };
    timers.setTimeout(wake, 0);
    for (let frame = 0; frame < fps * 10; frame++)
      time.at((frame * 1000) / fps, 'client', 'frame', () => input.tick(time.now));
    time.run(10_000);
    expect(sent.length).toBeGreaterThanOrEqual(600);
    expect(sent.length).toBeLessThanOrEqual(601);
    expect(new Set(sent).size).toBe(sent.length);
    expect(Math.max(...sent)).toBeLessThanOrEqual(601);
  });
}

describe('sampling contract', () => {
  it('retains a consumer-owned short edge until an eligible sample and reports elapsed sample time', () => {
    let target = 1;
    let latched = false;
    const contexts: number[] = [];
    const buttons: number[] = [];
    const input = new InputSender(
      TestInput,
      (m) => buttons.push((m.frames.at(-1)! as InputFrameBase & { buttons: number }).buttons),
      { inputTick: () => target },
      (f, ctx) => {
        (f as InputFrameBase & { buttons: number }).buttons = latched ? 1 : 0;
        latched = false;
        contexts.push(ctx.dt);
      },
    );
    input.tick(0);
    latched = true; // press and release handlers latch an edge between pulses
    input.tick(5); // duplicate target must not consume the edge
    target = 2;
    input.tick(20);
    target = 20; // a delayed wake samples only current controls
    input.tick(1000);
    expect(buttons).toEqual([0, 1, 0]);
    expect(contexts).toEqual([0, 0.02, 0.98]);
  });

  it('bounds forward jump work and signals a discontinuity once', () => {
    let target = 1;
    let resets = 0;
    const lengths: number[] = [];
    const input = new InputSender(
      TestInput,
      (m) => lengths.push(m.frames.length),
      { inputTick: () => target },
      undefined,
      { onDiscontinuity: () => resets++ },
    );
    input.tick(0);
    target = 10000;
    input.tick(100000);
    input.tick(100001);
    expect(lengths).toEqual([1, 1]);
    expect(resets).toBe(1);
  });
});

it('resumes a stalled client with one current sample and no historical burst', () => {
  const time = new ScenarioClock([{ lane: 'client', at: 100, duration: 200 }]);
  const clock = new NetClock({ now: () => time.now });
  clock.addSample(0, 0, 0);
  const samples: { tick: number; time: number }[] = [];
  const input = new InputSender(
    TestInput,
    () => {},
    clock,
    (_, ctx) => samples.push({ tick: ctx.targetTick, time: ctx.sampleTimeMs }),
  );
  for (let at = 0; at <= 500; at += 16) time.at(at, 'client', 'wake', () => input.tick(time.now));
  time.run(500);
  expect(samples.filter((s) => s.time === 300)).toHaveLength(1);
  expect(samples.find((s) => s.time === 300)?.tick).toBe(19);
  expect(samples.at(-1)!.tick).toBeGreaterThan(29);
});

it('rejects invalid timestamps and wire tick overflow and contains diagnostic callback errors', () => {
  let target = 1;
  const sent: number[] = [];
  const input = new InputSender(
    TestInput,
    (m) => sent.push(m.frames.at(-1)!.tick),
    { inputTick: () => target },
    () => {
      throw Error('sample');
    },
    {
      onSampleError: () => {
        throw Error('diagnostic');
      },
      onDiscontinuity: () => {
        throw Error('reset');
      },
    },
  );
  expect(input.tick(NaN)).toBe(false);
  expect(input.tick(1)).toBe(true);
  target = 100;
  expect(input.tick(2)).toBe(true);
  target = 0x100000000;
  expect(input.tick(3)).toBe(false);
  expect(sent).toEqual([1, 100]);
});
