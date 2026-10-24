import { fnv1a32 } from './fnv.ts';

/**
 * Seeded mulberry32 generator (docs/sim.md 1.9). All arithmetic is 32-bit, so a given seed yields
 * the same sequence on every engine.
 */
export class Rng {
  private a: number;

  constructor(seed: number) {
    this.a = seed >>> 0;
  }

  /** Next u32 in `[0, 2^32)`. */
  next(): number {
    this.a = (this.a + 0x6d2b79f5) | 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = t ^ (t + Math.imul(t ^ (t >>> 7), t | 61));
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Float in `[0, 1)`. */
  float(): number {
    return this.next() / 4294967296;
  }

  /** Integer in `[lo, hi]`, inclusive at both ends. Throws `RangeError` if `lo > hi`. */
  int(lo: number, hi: number): number {
    if (!(lo <= hi)) throw new RangeError(`Rng.int: lo (${lo}) must be <= hi (${hi})`);
    return lo + Math.floor(this.float() * (hi - lo + 1));
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.float() < p;
  }

  /** A uniformly chosen element, or `undefined` (without drawing) for an empty array. */
  pick<T>(arr: readonly T[]): T | undefined {
    return arr.length === 0 ? undefined : arr[this.int(0, arr.length - 1)];
  }

  /**
   * An independent child stream. Advances this stream by one draw, so two forks with the same label
   * differ, and both are reproducible from this stream's state.
   */
  fork(label: string): Rng {
    const salt = this.next();
    return new Rng(fnv1a32(label, salt));
  }

  /** Current u32 state. */
  state(): number {
    return this.a >>> 0;
  }

  /** Sets the state (as returned by `state()`). */
  restore(s: number): void {
    this.a = s >>> 0;
  }
}
