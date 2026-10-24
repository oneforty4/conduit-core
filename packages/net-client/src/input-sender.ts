import {
  INPUT_FRAMES_PER_MESSAGE,
  type InputFrameBase,
  type InputPayload,
  type Schema,
} from '@conduit/protocol';
import { INPUT_RING } from './constants.ts';

/**
 * The last `capacity` input frames, oldest first (docs/net.md B.6). Frame objects are created once
 * per slot and reused: `slotForNext()` hands out the object the next frame is written into and
 * `commit()` makes it the newest frame.
 */
export class InputRing {
  readonly capacity: number;
  private readonly schema: Schema<InputFrameBase>;
  private readonly frames: InputFrameBase[] = [];
  /** Physical index of the oldest frame. */
  private head = 0;
  private count = 0;

  constructor(schema: Schema<InputFrameBase>, capacity = INPUT_RING) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`InputRing: capacity must be an integer >= 1, got ${capacity}`);
    }
    this.schema = schema;
    this.capacity = capacity;
  }

  get length(): number {
    return this.count;
  }

  /** The reusable object the next committed frame will be (the oldest frame's once full). */
  slotForNext(): InputFrameBase {
    const index = (this.head + this.count) % this.capacity;
    let frame = this.frames[index];
    if (frame === undefined) {
      frame = this.schema.create();
      this.frames[index] = frame;
    }
    return frame;
  }

  /** Makes the `slotForNext()` object the newest frame, evicting the oldest when full. */
  commit(): void {
    this.slotForNext();
    if (this.count < this.capacity) this.count++;
    else this.head = (this.head + 1) % this.capacity;
  }

  /** Frame `i`, 0 = oldest. */
  at(i: number): InputFrameBase {
    if (!Number.isInteger(i) || i < 0 || i >= this.count) {
      throw new RangeError(`InputRing.at(${i}): index outside 0..${this.count - 1}`);
    }
    return this.frames[(this.head + i) % this.capacity] as InputFrameBase;
  }

  newest(): InputFrameBase | undefined {
    return this.count === 0 ? undefined : this.at(this.count - 1);
  }

  /** The newest `min(n, length)` frames, oldest first. */
  last(n: number): InputFrameBase[] {
    const k = Math.min(n, this.count);
    const out: InputFrameBase[] = [];
    for (let i = this.count - k; i < this.count; i++) out.push(this.at(i));
    return out;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }
}

export interface InputSampleContext {
  targetTick: number;
  sampleTimeMs: number;
  /** Actual elapsed seconds since the previous successful sample; 0 on the first. */
  dt: number;
}

export interface InputSenderOptions {
  now?: () => number;
  /** A forward jump larger than this clears retained frames and prediction history. Default 32. */
  discontinuityTicks?: number;
  onDiscontinuity?: (previousTick: number, targetTick: number) => void;
  /** Called when `sampleInput` throws; the frame is still sent, holding the previous input. */
  onSampleError?: (err: unknown) => void;
}

/**
 * Produces one `Input` message per client tick carrying the newest frame and up to three before it
 * (docs/net.md B.6). Frame ticks come from `clock.inputTick()`; they never repeat or go backwards
 * within a connection. Wakes do not advance the clock.
 */
export class InputSender {
  private readonly schema: Schema<InputFrameBase>;
  private readonly sendMessage: (msg: InputPayload) => void;
  private readonly clock: { inputTick(): number };
  private readonly sampleInput:
    ((frame: InputFrameBase, context: InputSampleContext) => void) | undefined;
  private readonly opts: InputSenderOptions;
  private lastSampleMs: number | null = null;
  suppressed = 0;
  late = 0;
  private readonly onSampleError: ((err: unknown) => void) | undefined;
  private readonly ring: InputRing;
  /** What `setFrame` last stored (schema defaults until then). */
  private readonly pending: InputFrameBase;
  private readonly defaults: InputFrameBase;
  private lastTick = 0;

  constructor(
    schema: Schema<InputFrameBase>,
    send: (msg: InputPayload) => void,
    clock: { inputTick(): number },
    sampleInput?: (frame: InputFrameBase, context: InputSampleContext) => void,
    opts: InputSenderOptions = {},
  ) {
    if (
      opts.discontinuityTicks !== undefined &&
      (!Number.isInteger(opts.discontinuityTicks) ||
        opts.discontinuityTicks < 1 ||
        opts.discontinuityTicks > 256)
    ) {
      throw new RangeError('InputSender: discontinuityTicks must be an integer in 1..256');
    }
    this.opts = opts;
    this.schema = schema;
    this.sendMessage = send;
    this.clock = clock;
    this.sampleInput = sampleInput;
    this.onSampleError = opts.onSampleError;
    this.ring = new InputRing(schema);
    this.pending = schema.create();
    this.defaults = schema.create();
  }

  /** Tick of the newest frame sent; 0 before the first. */
  get lastSentTick(): number {
    return this.lastTick;
  }

  /** Stores a copy of `frame` as the input for the next client ticks (`tick` is ignored). */
  setFrame(frame: InputFrameBase): void {
    this.schema.copy(frame, this.pending);
  }

  /** A wake-up samples at most one current target. Earlier or duplicate targets wait. */
  tick(nowMs = this.opts.now?.() ?? performance.now()): boolean {
    if (!Number.isFinite(nowMs) || (this.lastSampleMs !== null && nowMs < this.lastSampleMs)) {
      this.suppressed++;
      return false;
    }
    const t = this.clock.inputTick();
    if (!Number.isSafeInteger(t) || t > 0xffffffff || t <= this.lastTick) {
      this.suppressed++;
      return false;
    }
    if (this.lastTick > 0 && t > this.lastTick + 1) this.late++;
    if (this.lastTick > 0 && t - this.lastTick > (this.opts.discontinuityTicks ?? 32)) {
      this.ring.clear();
      try {
        this.opts.onDiscontinuity?.(this.lastTick, t);
      } catch (err) {
        this.reportSampleError(err);
      }
    }
    const ring = this.ring;
    const frame = ring.slotForNext();
    this.schema.copy(this.pending, frame);
    if (this.sampleInput !== undefined) {
      try {
        this.sampleInput(frame, {
          targetTick: t,
          sampleTimeMs: nowMs,
          dt: this.lastSampleMs === null ? 0 : Math.max(0, nowMs - this.lastSampleMs) / 1000,
        });
        this.lastSampleMs = nowMs;
      } catch (err) {
        this.schema.copy(ring.newest() ?? this.pending, frame);
        this.reportSampleError(err);
      }
    }
    frame.tick = t;
    this.lastTick = t;
    ring.commit();
    const frames = ring.last(INPUT_FRAMES_PER_MESSAGE);
    this.sendMessage({ firstTick: (frames[0] as InputFrameBase).tick, frames });
    return true;
  }

  private reportSampleError(err: unknown): void {
    try {
      this.onSampleError?.(err);
    } catch {
      // Diagnostic callbacks cannot stop input scheduling.
    }
  }

  /** Forgets sent frames and the tick floor (a new connection); pending input is cleared. */
  reset(): void {
    this.ring.clear();
    this.lastTick = 0;
    this.lastSampleMs = null;
    this.suppressed = 0;
    this.late = 0;
    this.schema.copy(this.defaults, this.pending);
  }
}
