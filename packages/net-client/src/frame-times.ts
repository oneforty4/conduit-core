import {
  FRAME_STALL_MS,
  REFRESH_BAND,
  REFRESH_BAND_MS,
  REFRESH_FIT,
  REFRESH_MIN_FRAMES,
  REFRESH_PULL,
  REFRESH_WINDOW,
} from './constants.ts';

/** The shortest refresh period, ms, frames are taken to be shown on: a 333 Hz display. */
const MIN_PERIOD_MS = 3;
/** The most refresh periods an interval a fit starts from is taken to span. */
const MAX_SPAN = 4;
/**
 * The intervals fits start from: this far up them, shortest first. Each is a refresh or a few,
 * but which depends on how often frames keep to every refresh, and noise makes the shortest
 * shorter than one.
 */
const SEED_RANKS = [0.5, 0.25, 0.1] as const;
/** Rounds of fitting a period: each counts the periods in every interval, then fits them anew. */
const FIT_ROUNDS = 3;
/**
 * An interval this far from a whole number of periods, as a share of one, lies between refreshes;
 * a period with more than `BETWEEN_SHARE` of the intervals between its refreshes does not fit,
 * however well the misses cancel out. (Noise of a millisecond and a half either side on a 120 Hz
 * display puts one interval in 35 there.)
 */
const BETWEEN = 0.3;
const BETWEEN_SHARE = 0.1;

/** Whole refresh periods in an interval, at least one. */
const periodsIn = (interval: number, period: number): number =>
  Math.max(1, Math.round(interval / period));

/**
 * When each frame is shown, from the timestamps `requestAnimationFrame` gives its frames (docs/net.md
 * B.4). A display shows a frame on its refresh, a whole number of refresh periods after the one
 * before -- one, or two or three where frames were dropped -- while the timestamps carry a
 * millisecond or so of noise, successive intervals anti-correlated. So each frame is put the whole
 * number of periods on that its timestamp is nearest, then moved `REFRESH_PULL` of the way to the
 * timestamp to keep in phase, and never more than the band (`REFRESH_BAND`, `REFRESH_BAND_MS`)
 * from it. The period is fitted to the last `REFRESH_WINDOW` intervals as whole numbers of it
 * (`period`), and taken only where the frames lie near enough to its refreshes (`REFRESH_FIT`): at
 * some 55 frames a second on a 120 Hz display, two and three periods of 8.3 ms. Where none fits,
 * or a frame comes under half a period after the one before (as an uncapped frame rate lets it),
 * the frame is shown at its timestamp.
 */
export class FrameTimes {
  private readonly intervals = new Float64Array(REFRESH_WINDOW);
  /** Where each timestamp lies off the refresh, scratch for `miss`. */
  private readonly drift = new Float64Array(REFRESH_WINDOW);
  /** The intervals in order, scratch for `period`. */
  private readonly sorted = new Float64Array(REFRESH_WINDOW);
  private count = 0;
  private stamp = Number.NaN;
  private shown = Number.NaN;
  private refresh: number | undefined;

  /** The refresh period the last frame was put on, ms; undefined while none fits. */
  get refreshMs(): number | undefined {
    return this.refresh;
  }

  /**
   * The time the frame stamped `stampMs` is shown at, ms on the same clock: never sooner than the
   * frame before, unless its timestamp went back or came after a stall.
   */
  at(stampMs: number): number {
    const interval = stampMs - this.stamp;
    if (!(interval >= 0 && interval <= FRAME_STALL_MS)) {
      this.count = 0;
      this.stamp = this.shown = stampMs;
      this.refresh = undefined;
      return stampMs;
    }
    const period = (this.refresh = this.period());
    const steps = period === undefined ? 1 : Math.round((stampMs - this.shown) / period);
    // Too soon to be on the refresh: shown at its timestamp, and otherwise passed over.
    if (steps < 1) return Math.max(stampMs, this.shown);
    this.intervals[this.count++ % REFRESH_WINDOW] = interval;
    this.stamp = stampMs;
    if (period === undefined) return (this.shown = Math.max(stampMs, this.shown));
    const placed = this.shown + steps * period;
    const band = Math.min(REFRESH_BAND_MS, REFRESH_BAND * period);
    const pulled = placed + REFRESH_PULL * (stampMs - placed);
    this.shown = Math.min(stampMs + band, Math.max(stampMs - band, pulled));
    return this.shown;
  }

  /** Forgets the frames before. */
  reset(): void {
    this.count = 0;
    this.stamp = this.shown = Number.NaN;
    this.refresh = undefined;
  }

  /**
   * The refresh period the intervals fit, ms, or undefined when none fits well enough
   * (`REFRESH_FIT`). A display keeps its refresh, so the period the frame before was put on is
   * kept, fitted afresh, for as long as it fits. Otherwise each fit starts from an interval
   * (`SEED_RANKS`) taken to be a whole number of periods (up to `MAX_SPAN`), and of the periods
   * that fit, the one taken misses least for its length, so one twice as long may miss twice as
   * far (as a share of it). A fraction of the true period fits as well as it wherever it fits, and
   * noise can fit one better; a multiple of it fits only by its misses cancelling out, which they
   * rarely do well.
   */
  private period(): number | undefined {
    const n = Math.min(this.count, REFRESH_WINDOW);
    if (n < REFRESH_MIN_FRAMES) return undefined;
    if (this.refresh !== undefined) {
      const held = this.fitted(this.refresh, n);
      if (this.miss(held, n) <= REFRESH_FIT) return held;
    }
    // In order, those not yet recorded last.
    const sorted = this.sorted;
    sorted.set(this.intervals);
    sorted.fill(Infinity, n);
    sorted.sort();
    let best: number | undefined;
    let bestScore = Infinity;
    for (const rank of SEED_RANKS) {
      const seed = sorted[Math.floor(rank * (n - 1))] as number;
      for (let span = 1; span <= MAX_SPAN && seed / span >= MIN_PERIOD_MS; span++) {
        const period = this.fitted(seed / span, n);
        const miss = this.miss(period, n);
        // Longer periods come first, and keep their place on a tie.
        if (miss <= REFRESH_FIT && miss / period < bestScore - 1e-9) {
          best = period;
          bestScore = miss / period;
        }
      }
    }
    return best;
  }

  /** The period the last `n` intervals fit as whole numbers of it, from `start`, by least squares. */
  private fitted(start: number, n: number): number {
    let period = start;
    for (let round = 0; round < FIT_ROUNDS; round++) {
      let weighted = 0;
      let squares = 0;
      for (let i = 0; i < n; i++) {
        const interval = this.intervals[i] as number;
        const periods = periodsIn(interval, period);
        weighted += periods * interval;
        squares += periods * periods;
      }
      period = weighted / squares;
    }
    return period;
  }

  /**
   * How far the last `n` timestamps lie from a refresh of `period`, on average, as a share of it:
   * each put the whole number of periods after the one before that its interval is nearest, and
   * taken from where they lie on average; or the intervals' own mean distance from a whole number
   * of periods, where that is further. The timestamps tell frames that keep to no refresh, which
   * wander ever further from one; the intervals tell a period whose misses cancel out, too long
   * by a fraction, as alternate intervals of two and three 120 Hz refreshes fit 20 ms. Infinite
   * where too many intervals lie between refreshes (`BETWEEN`).
   */
  private miss(period: number, n: number): number {
    const first = this.count > REFRESH_WINDOW ? this.count % REFRESH_WINDOW : 0;
    let off = 0;
    let sum = 0;
    let between = 0;
    let missed = 0;
    for (let i = 0; i < n; i++) {
      const interval = this.intervals[(first + i) % REFRESH_WINDOW] as number;
      const miss = interval - period * periodsIn(interval, period);
      if (Math.abs(miss) > BETWEEN * period) between++;
      missed += Math.abs(miss);
      off += miss;
      this.drift[i] = off;
      sum += off;
    }
    if (between > BETWEEN_SHARE * n) return Infinity;
    const mean = sum / n;
    let drift = 0;
    for (let i = 0; i < n; i++) drift += Math.abs((this.drift[i] as number) - mean);
    return Math.max(drift, missed) / (n * period);
  }
}
