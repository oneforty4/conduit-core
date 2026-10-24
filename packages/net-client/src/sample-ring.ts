import { SAMPLE_RING } from './constants.ts';

/** One timestamped component value. */
export interface Sample {
  readonly tick: number;
  readonly value: unknown;
}

/** Borrowed read-only history; mutating methods and reusable backing slots are hidden. */
export interface SampleRingReader {
  readonly capacity: number;
  readonly length: number;
  readonly complete: boolean;
  at(i: number): Sample;
  tickAt(i: number): number;
  oldest(): Sample | undefined;
  newest(): Sample | undefined;
  indexAtOrBefore(tick: number): number;
  bracket(tick: number): { a: number; b: number } | null;
}

interface Slot {
  tick: number;
  value: unknown;
}

/**
 * Fixed-capacity ring of `(tick, value)` samples in ascending tick order (docs/net.md B.5). Pushing
 * into a full ring evicts the oldest sample. Values are owned by the ring and treated as immutable.
 */
export class SampleRing {
  readonly capacity: number;
  /** Physical storage; slot objects are reused as samples are evicted. */
  private readonly slots: Slot[] = [];
  /** Physical index of the oldest sample. */
  private head = 0;
  private count = 0;
  private whole = true;

  constructor(capacity = SAMPLE_RING) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`SampleRing: capacity must be an integer >= 1, got ${capacity}`);
    }
    this.capacity = capacity;
  }

  get length(): number {
    return this.count;
  }

  /** Whether every sample pushed since the last `clear` is held: none pushed out of a full ring. */
  get complete(): boolean {
    return this.whole;
  }

  /**
   * Appends a sample. A tick older than the newest is ignored; a tick equal to the newest replaces
   * that sample's value.
   */
  push(tick: number, value: unknown): void {
    if (this.count > 0) {
      const newest = this.slotAt(this.count - 1);
      if (tick < newest.tick) return;
      if (tick === newest.tick) {
        newest.value = value;
        return;
      }
    }
    if (this.count < this.capacity) {
      const index = (this.head + this.count) % this.capacity;
      const slot = this.slots[index];
      if (slot === undefined) this.slots[index] = { tick, value };
      else {
        slot.tick = tick;
        slot.value = value;
      }
      this.count++;
      return;
    }
    const slot = this.slots[this.head] as Slot;
    slot.tick = tick;
    slot.value = value;
    this.head = (this.head + 1) % this.capacity;
    this.whole = false;
  }

  /** Sample `i`, 0 = oldest. The returned object is reused once the sample is evicted. */
  at(i: number): Sample {
    if (!Number.isInteger(i) || i < 0 || i >= this.count) {
      throw new RangeError(`SampleRing.at(${i}): index outside 0..${this.count - 1}`);
    }
    return this.slotAt(i);
  }

  tickAt(i: number): number {
    return this.at(i).tick;
  }

  oldest(): Sample | undefined {
    return this.count === 0 ? undefined : this.slotAt(0);
  }

  newest(): Sample | undefined {
    return this.count === 0 ? undefined : this.slotAt(this.count - 1);
  }

  /**
   * Index of the newest sample whose tick is `<= tick`, or -1 when `tick` is before the oldest
   * sample (or the ring is empty).
   */
  indexAtOrBefore(tick: number): number {
    for (let i = this.count - 1; i >= 0; i--) {
      if (this.slotAt(i).tick <= tick) return i;
    }
    return -1;
  }

  /**
   * Indices `a`, `b` with `at(a).tick <= tick <= at(b).tick`: `b = a + 1` strictly between two
   * samples, `a = b` on an exact tick. `null` when `tick` lies outside `[oldest, newest]`.
   */
  bracket(tick: number): { a: number; b: number } | null {
    const a = this.indexAtOrBefore(tick);
    if (a < 0) return null;
    if (this.slotAt(a).tick === tick) return { a, b: a };
    if (a + 1 >= this.count) return null;
    return { a, b: a + 1 };
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.whole = true;
    for (const slot of this.slots) slot.value = undefined;
  }

  private slotAt(i: number): Slot {
    return this.slots[(this.head + i) % this.capacity] as Slot;
  }
}
