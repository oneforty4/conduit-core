import type { InputFrameBase, InputPayload } from '@conduit/protocol';
import { describe, expect, it } from 'vitest';
import { INPUT_RING, InputRing, InputSender } from '../src/index.ts';
import { TestInput } from './helpers.ts';

type Frame = InputFrameBase & { throttle: number; buttons: number };

interface Sent {
  firstTick: number;
  ticks: number[];
  throttles: number[];
  objects: InputFrameBase[];
}

function sender(
  ticks: number[] | (() => number),
  sampleInput?: (frame: InputFrameBase) => void,
  onSampleError?: (err: unknown) => void,
): { sent: Sent[]; input: InputSender } {
  const sent: Sent[] = [];
  let i = 0;
  const clock = {
    inputTick: typeof ticks === 'function' ? ticks : () => ticks[Math.min(i++, ticks.length - 1)]!,
  };
  const record = (msg: InputPayload): void => {
    // The message references ring objects that are reused later: copy what the test needs now.
    sent.push({
      firstTick: msg.firstTick,
      ticks: msg.frames.map((fr) => fr.tick),
      throttles: msg.frames.map((fr) => (fr as Frame).throttle),
      objects: [...msg.frames],
    });
  };
  const input = new InputSender(
    TestInput,
    record,
    clock,
    sampleInput,
    onSampleError === undefined ? {} : { onSampleError },
  );
  return { sent, input };
}

describe('InputSender', () => {
  it('sends one message per tick with up to 4 ascending frames, newest last', () => {
    let tick = 100;
    const { sent, input } = sender(() => tick++);
    for (let k = 0; k < 6; k++) input.tick();
    expect(sent).toHaveLength(6);
    expect(sent.map((m) => m.ticks)).toEqual([
      [100],
      [100, 101],
      [100, 101, 102],
      [100, 101, 102, 103],
      [101, 102, 103, 104],
      [102, 103, 104, 105],
    ]);
    for (const m of sent) expect(m.firstTick).toBe(m.ticks[0]);
    expect(input.lastSentTick).toBe(105);
  });

  it('never regresses or repeats a tick when inputTick() dips by less than a message of frames or stalls', () => {
    const { sent, input } = sender([10, 12, 11, 11, 15, 13, 17]);
    for (let k = 0; k < 7; k++) input.tick();
    expect(sent.map((m) => m.ticks.at(-1))).toEqual([10, 12, 15, 17]);
    expect(sent.at(-1)?.ticks).toEqual([10, 12, 15, 17]);
  });

  it('waits through large backward corrections without regressing', () => {
    const { sent, input } = sender([100, 120, 103, 104, 120, 121]);
    for (let k = 0; k < 6; k++) input.tick();
    expect(sent.map((m) => m.ticks.at(-1))).toEqual([100, 120, 121]);
    expect(input.suppressed).toBe(3);
  });

  it('sends a copy of the last setFrame value', () => {
    let tick = 1;
    const { sent, input } = sender(() => tick++);
    const frame: Frame = { tick: 999, throttle: 50, buttons: 1 };
    input.setFrame(frame);
    frame.throttle = -50; // mutating the caller's object after setFrame has no effect
    input.tick();
    input.tick();
    expect(sent.map((m) => m.throttles.at(-1))).toEqual([50, 50]);
    expect(sent[0]!.ticks).toEqual([1]); // the tick is stamped, not copied
  });

  it('uses sampleInput when provided, starting from the pending frame', () => {
    let tick = 1;
    const seen: number[] = [];
    let next = 0;
    const { sent, input } = sender(
      () => tick++,
      (frame) => {
        seen.push((frame as Frame).buttons);
        (frame as Frame).throttle = ++next;
      },
    );
    input.setFrame({ tick: 0, throttle: 0, buttons: 3 } as Frame);
    input.tick();
    input.tick();
    expect(sent.map((m) => m.throttles)).toEqual([[1], [1, 2]]);
    expect(seen).toEqual([3, 3]);
  });

  it('re-sends the previous input under a new tick when sampleInput throws', () => {
    let tick = 1;
    let calls = 0;
    const errors: unknown[] = [];
    const { sent, input } = sender(
      () => tick++,
      (frame) => {
        calls++;
        (frame as Frame).throttle = 7;
        if (calls === 2) throw new Error('sampler bug');
      },
      (err) => errors.push(err),
    );
    input.tick();
    input.tick();
    expect(sent[1]!.ticks).toEqual([1, 2]);
    expect(sent[1]!.throttles).toEqual([7, 7]);
    expect(errors).toHaveLength(1);
  });

  it(`reuses at most ${INPUT_RING} frame objects`, () => {
    let tick = 1;
    const { sent, input } = sender(() => tick++);
    for (let k = 0; k < 50; k++) input.tick();
    const objects = new Set(sent.flatMap((m) => m.objects));
    expect(objects.size).toBe(INPUT_RING);
  });

  it('reset forgets sent frames and the tick floor', () => {
    let tick = 50;
    const { sent, input } = sender(() => tick);
    input.tick();
    input.tick();
    expect(sent).toHaveLength(1);
    input.reset();
    tick = 5;
    input.tick();
    expect(sent[1]!.ticks).toEqual([5]);
  });
});

describe('InputRing', () => {
  it('commits reusable slots oldest first and evicts beyond capacity', () => {
    const ring = new InputRing(TestInput, 3);
    expect(ring.length).toBe(0);
    expect(ring.newest()).toBeUndefined();
    const objects: InputFrameBase[] = [];
    for (let t = 1; t <= 5; t++) {
      const slot = ring.slotForNext();
      slot.tick = t;
      objects.push(slot);
      ring.commit();
    }
    expect(ring.length).toBe(3);
    expect([0, 1, 2].map((i) => ring.at(i).tick)).toEqual([3, 4, 5]);
    expect(ring.last(2).map((fr) => fr.tick)).toEqual([4, 5]);
    expect(ring.last(10).map((fr) => fr.tick)).toEqual([3, 4, 5]);
    expect(new Set(objects).size).toBe(3);
    expect(() => ring.at(3)).toThrow(RangeError);
    ring.clear();
    expect(ring.length).toBe(0);
    expect(() => new InputRing(TestInput, 0)).toThrow(RangeError);
  });
});
