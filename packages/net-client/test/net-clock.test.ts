import { Rng } from '@conduit/math';
import { describe, expect, it } from 'vitest';
import {
  CLOCK_WINDOW,
  JITTER_MAX_MS,
  NetClock,
  RTT_ALPHA,
  SLEW_RATE,
  SNAP_THRESHOLD_MS,
  toU32Ms,
} from '../src/index.ts';

function clockAt(start = 1000): { clock: NetClock; time: { now: number } } {
  const time = { now: start };
  const clock = new NetClock({ now: () => time.now });
  clock.configure(60, 3);
  return { clock, time };
}

/** Sets the RTT estimate to exactly `rtt` with one Pong (the first sample is taken as is). */
function withRtt(clock: NetClock, rtt: number): void {
  clock.onPong(toU32Ms(1000), 5000, 300, 1000 + rtt);
}

describe('NetClock offset', () => {
  it('converges within 40 ms of the true offset after 16 samples under 10 + U(0,30) ms delays, and stays there', () => {
    const rng = new Rng(20260917);
    const delay = (): number => 10 + rng.float() * 30;
    const trueOffset = 12_345.5; // server ms = client ms + trueOffset
    const { clock, time } = clockAt(10_000);
    const tickMs = 1000 / 60;
    let samples = 0;
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      // A Ping round trip every 5th step, snapshot arrivals otherwise.
      const sentAt = time.now;
      if (i % 5 === 0) {
        const up = delay();
        const down = delay();
        const serverRecv = sentAt + up + trueOffset;
        const serverTimeMs = Math.floor(serverRecv);
        const serverTick = Math.floor(serverTimeMs / tickMs);
        clock.onPong(toU32Ms(sentAt), serverTimeMs, serverTick, sentAt + up + down);
      } else {
        const serverTick = Math.floor((sentAt + trueOffset) / tickMs / 3) * 3;
        const serverTimeMs = Math.floor(serverTick * tickMs);
        const arrival = serverTimeMs - trueOffset + delay();
        clock.onSnapshotArrival(serverTimeMs, serverTick, arrival);
      }
      samples++;
      time.now += 50;
      if (samples >= CLOCK_WINDOW) {
        worst = Math.max(worst, Math.abs(clock.offsetMs - trueOffset));
        expect(Math.abs(clock.offsetMs - trueOffset)).toBeLessThanOrEqual(40);
      }
    }
    expect(clock.synced).toBe(true);
    expect(clock.rttMs).toBeGreaterThan(20);
    expect(clock.rttMs).toBeLessThan(80);
    expect(worst).toBeGreaterThan(0);
  });

  it('takes the least delayed offset of the last CLOCK_WINDOW samples, the earliest epoch since reset', () => {
    const { clock } = clockAt();
    expect(clock.synced).toBe(false);
    expect(clock.offsetMs).toBe(0);
    clock.addSample(1100, 60, 700); // sees 400 (delivered late), e = 100 (a late tick start)
    expect(clock.synced).toBe(true);
    expect(clock.offsetMs).toBe(400);
    expect(clock.tickEpochMs).toBe(100);
    clock.addSample(1000, 60, 500); // sees 500, e = 0
    expect(clock.offsetMs).toBe(500);
    expect(clock.tickEpochMs).toBe(0);
    for (let i = 0; i < CLOCK_WINDOW - 1; i++) clock.addSample(2050, 120, 1600); // sees 450, e 50
    // The s = 500 sample is now the oldest of the window; one more push evicts it.
    expect(clock.offsetMs).toBe(500);
    clock.addSample(2050, 120, 1600);
    expect(clock.offsetMs).toBe(450);
    // The on-time tick start is long out of the window, and still the epoch.
    expect(clock.tickEpochMs).toBe(0);
    expect(clock.samples()).toHaveLength(CLOCK_WINDOW);
  });

  it('keeps its offset through a hitch: the messages the page handles late do not pull it down', () => {
    // Regression: the offset was the lowest sample, the most delayed one, so the snapshots a
    // 120 ms hitch held back set it 120 ms low for the window's 0.8 s; the server tick it put
    // inputs on trailed the server by 7 ticks, every input frame came too late to apply, and the
    // vehicle held its last orders for most of a second after every hitch.
    // Server ms = client ms + 4000; tick T starts at server ms 50 T / 3 (epoch 0); a snapshot of
    // tick T is sent as it starts and comes 1 ms later (half the 2 ms round trip).
    const { clock, time } = clockAt(0);
    withRtt(clock, 2);
    const arrive = (tick: number, late: number): void => {
      const sent = (tick * 50) / 3;
      time.now = sent - 4000 + 1 + late;
      clock.onSnapshotArrival(sent, tick, time.now);
    };
    for (let tick = 3; tick <= 3 * CLOCK_WINDOW; tick += 3) arrive(tick, 0);
    expect(clock.offsetMs).toBe(4000);
    expect(clock.tickEpochMs).toBe(0);
    // The page stalls for 120 ms: the snapshots that came meanwhile are handled at its end.
    const stall = 3 * CLOCK_WINDOW;
    for (const [tick, late] of [
      [stall + 3, 117],
      [stall + 6, 67],
      [stall + 9, 17],
    ] as const) {
      arrive(tick, late);
    }
    expect(clock.offsetMs).toBe(4000);
    // So inputs go on the tick the server is at, not 7 ticks behind it.
    expect(clock.serverTickNow()).toBe(Math.floor(((time.now + 4000) * 60) / 1000 + 1e-6));
  });

  it('adds half the RTT as it is now to the best sample: a Welcome before any Pong counts too', () => {
    const { clock } = clockAt();
    // Welcome-like sample: no RTT yet, so the offset is what it saw, 20 ms (the way back) low.
    clock.addSample(1000, 60, 1020);
    expect(clock.offsetMs).toBe(-20);
    expect(clock.tickEpochMs).toBe(0);
    // Ping sent at 1000, server stamps 1020 (tick 61 started at 1016.67), Pong back at 1040.
    clock.onPong(toU32Ms(1000), 1020, 61, 1040);
    expect(clock.rttMs).toBe(40);
    expect(clock.offsetMs).toBe(0);
    expect(clock.tickEpochMs).toBe(0); // the Welcome's on-time epoch survives the Pong's later one
    expect(clock.samples()).toHaveLength(2);
    // A later sample delivered 10 ms late does not lower it; later Pongs keep the window.
    clock.addSample(1100, 66, 1130); // sees -30
    clock.onPong(toU32Ms(1200), 1220, 73, 1240);
    expect(clock.offsetMs).toBe(0);
    expect(clock.samples()).toHaveLength(4);
  });

  it('follows the RTT at once: one Pong handled late does not leave the offset high', () => {
    // Regression: each sample once kept the RTT estimate it was taken with, so the samples taken
    // after a first Pong handled ~300 ms late (the page building its renderer) put the server
    // ~150 ms ahead for the window's length after the next Pong had put the RTT right, and every
    // input frame, stamped that far ahead, overflowed the server's queue.
    const { clock, time } = clockAt(0);
    // Server ms = client ms + 4000; a Pong comes back 2 ms after its Ping, the first one 300 ms.
    const ping = (sentAt: number, late: number): void => {
      time.now = sentAt + 2 + late;
      clock.onPong(
        toU32Ms(sentAt),
        sentAt + 4001,
        Math.floor(((sentAt + 4001) * 60) / 1000),
        time.now,
      );
    };
    ping(0, 300);
    expect(clock.offsetMs).toBeCloseTo(4001 - 302 + 302 / 2, 9); // what the late Pong saw, plus rtt/2
    for (let i = 1; i <= 10; i++) {
      time.now = i * 50;
      clock.onSnapshotArrival(i * 50 + 4000 - 1, Math.floor(((i * 50 + 3999) * 60) / 1000), i * 50);
    }
    expect(clock.offsetMs).toBeGreaterThan(4100); // the RTT is still 302 ms
    ping(1000, 0);
    expect(clock.rttMs).toBe(2);
    expect(clock.offsetMs).toBeCloseTo(4000, 9);
  });

  it('a stalled first Pong does not hold RTT and inputLead up: lower samples replace the estimate, higher ones are smoothed', () => {
    // Regression: the first Pong of a browser client is handled while the page builds its WebGL
    // renderer. With plain smoothing a 294 ms sample decayed at RTT_ALPHA per 1 Hz Pong, so
    // inputLead stayed ~10 ticks for half a minute and the server's 6-frame input queue dropped
    // every frame before its tick: the vehicle ignored input after load.
    const { clock } = clockAt();
    clock.onPong(toU32Ms(1000), 5000, 300, 1000 + 294);
    expect(clock.rttMs).toBe(294);
    expect(clock.inputLead).toBe(10);
    clock.onPong(toU32Ms(2000), 6000, 360, 2001);
    expect(clock.rttMs).toBe(1);
    expect(clock.inputLead).toBe(2);
    clock.onPong(toU32Ms(3000), 7000, 420, 3000 + 11);
    expect(clock.rttMs).toBeCloseTo(1 + RTT_ALPHA * 10, 9);
    clock.onPong(toU32Ms(4000), 8000, 480, 4000 + 1.5);
    expect(clock.rttMs).toBe(1.5);
  });

  it('computes RTT from Pongs across u32 wrap of clientTimeMs', () => {
    const { clock } = clockAt();
    const sent = 2 ** 32 - 10; // wraps to a small value by the time the Pong arrives
    clock.onPong(toU32Ms(sent), 100, 6, sent + 30);
    expect(clock.rttMs).toBe(30);
    clock.onPong(toU32Ms(sent + 1000), 1100, 66, sent + 1050);
    expect(clock.rttMs).toBeCloseTo(32, 10);
  });
});

describe('NetClock jitter', () => {
  it('settles in 5..30 ms for a 50 ms cadence with ±20 ms jitter', () => {
    const rng = new Rng(7);
    const { clock } = clockAt();
    for (let k = 0; k < 600; k++) {
      const arrival = 100_000 + 50 * k + (rng.float() * 40 - 20);
      clock.onSnapshotArrival(50 * k, 3 * k, arrival);
      if (k >= 60) {
        expect(clock.jitterMs).toBeGreaterThanOrEqual(5);
        expect(clock.jitterMs).toBeLessThanOrEqual(30);
      }
    }
  });

  it('clamps at JITTER_MAX_MS for wild input', () => {
    const { clock } = clockAt();
    let t = 100_000;
    for (let k = 0; k < 200; k++) {
      t += k % 2 === 0 ? 0 : 500;
      clock.onSnapshotArrival(50 * k, 3 * k, t);
    }
    expect(clock.jitterMs).toBe(JITTER_MAX_MS);
  });

  it('resetJitter forgets jitter but keeps the offset window and RTT', () => {
    const { clock } = clockAt();
    withRtt(clock, 40);
    clock.onSnapshotArrival(0, 0, 100);
    clock.onSnapshotArrival(50, 3, 250);
    expect(clock.jitterMs).toBeGreaterThan(0);
    const offset = clock.offsetMs;
    clock.resetJitter();
    expect(clock.jitterMs).toBe(0);
    expect(clock.offsetMs).toBe(offset);
    expect(clock.rttMs).toBe(40);
    clock.onSnapshotArrival(100, 6, 400); // first arrival after reset: no interval yet
    expect(clock.jitterMs).toBe(0);
  });
});

describe('NetClock render clock', () => {
  it('starts at the target, then slews within ±2% per update and converges', () => {
    const { clock, time } = clockAt(0);
    for (let i = 0; i < CLOCK_WINDOW; i++) clock.addSample(10_000, 600, 0); // offset 10 000
    expect(clock.renderTick()).toBe(0);
    clock.update(time.now);
    const delay = clock.interpDelayTicks * clock.tickMs;
    expect(clock.renderTimeMs).toBeCloseTo(10_000 - delay, 9);

    // Lower the offset by 100 ms (the window's every sample 100 ms later than before): the target
    // drops, the render clock runs slow until it catches up.
    for (let i = 0; i < CLOCK_WINDOW; i++) clock.addSample(9_900, 594, 0);
    const dt = 16;
    let previous = clock.renderTimeMs!;
    let slowUpdates = 0;
    for (let i = 0; i < 400; i++) {
      time.now += dt;
      clock.update(time.now);
      const advance = clock.renderTimeMs! - previous;
      previous = clock.renderTimeMs!;
      expect(advance).toBeGreaterThanOrEqual(dt * (1 - SLEW_RATE) - 1e-9);
      expect(advance).toBeLessThanOrEqual(dt * (1 + SLEW_RATE) + 1e-9);
      if (advance < dt - 1e-9) slowUpdates++;
    }
    expect(slowUpdates).toBeGreaterThan(250);
    const target = time.now + clock.offsetMs - delay;
    expect(Math.abs(target - clock.renderTimeMs!)).toBeLessThanOrEqual(1);
    expect(clock.snaps).toBe(0);

    // A sample 100 ms earlier: the target jumps +100 ms and the clock runs fast.
    clock.addSample(10_000 + time.now, 600, time.now);
    time.now += dt;
    const before = clock.renderTimeMs!;
    clock.update(time.now);
    expect(clock.renderTimeMs! - before).toBeCloseTo(dt * (1 + SLEW_RATE), 9);
  });

  it('advances by a smoothed frame interval, keeping timestamp noise out of rendered motion', () => {
    // A display running at a dead-steady 60 Hz still reports intervals a millisecond or two either
    // side of 16.667, and successive ones come out anti-correlated: it is noise on the timestamps,
    // not the frames really arriving early and late. Advancing by the raw interval would put that
    // straight into how far the world moves each frame, which reads as shimmer.
    const { clock, time } = clockAt(0);
    for (let i = 0; i < CLOCK_WINDOW; i++) clock.addSample(10_000, 600, 0);
    clock.update(time.now);
    const noise = [2, -2, 1.9, -1.8, 1.6, -2, 2, -1.5, 1.8, -1.9];
    let previous = clock.renderTimeMs as number;
    const advances: number[] = [];
    for (let i = 0; i < 240; i++) {
      time.now += 1000 / 60 + (noise[i % noise.length] as number);
      clock.update(time.now);
      const advance = (clock.renderTimeMs as number) - previous;
      previous = clock.renderTimeMs as number;
      if (i >= 60) advances.push(advance); // once the smoothing has settled
    }
    // The raw intervals span 4 ms; what the clock advances by must not.
    expect(Math.max(...advances) - Math.min(...advances)).toBeLessThan(1);
    for (const advance of advances) expect(advance).toBeCloseTo(1000 / 60, 0);
    expect(clock.snaps).toBe(0);

    // A real change of cadence is not smoothed away: a dropped frame advances the clock by the
    // whole interval, because the display really did hold the previous frame for it.
    time.now += 1000 / 30;
    const before = clock.renderTimeMs as number;
    clock.update(time.now);
    expect((clock.renderTimeMs as number) - before).toBeGreaterThan(1000 / 30 - 1);
  });

  it('tracks the target without snapping when updates are throttled to 1 Hz', () => {
    const { clock, time } = clockAt(0);
    clock.addSample(10_000, 600, 0);
    clock.update(0);
    for (let i = 0; i < 10; i++) {
      time.now += 1000;
      clock.update(time.now);
      const target = time.now + clock.offsetMs - clock.interpDelayTicks * clock.tickMs;
      expect(Math.abs(target - clock.renderTimeMs!)).toBeLessThanOrEqual(1e-6);
    }
    expect(clock.snaps).toBe(0);
  });

  it(`snaps when the error exceeds ${SNAP_THRESHOLD_MS} ms`, () => {
    const { clock, time } = clockAt(0);
    clock.addSample(10_000, 600, 0);
    clock.update(0);
    clock.addSample(10_300, 618, 0); // offset +300 ms
    time.now = 16;
    clock.update(16);
    expect(clock.snaps).toBe(1);
    expect(clock.renderTimeMs).toBeCloseTo(16 + 10_300 - clock.interpDelayTicks * clock.tickMs, 9);
  });

  it('renderTick is fractional ticks since the epoch and 0 before the first update', () => {
    const { clock } = clockAt(0);
    expect(clock.renderTick()).toBe(0);
    clock.update(0); // not synced: no-op
    expect(clock.renderTimeMs).toBeNull();
    clock.addSample(1000, 60, 0); // offset 1000, epoch 0
    clock.update(8);
    // target = 8 + 1000 - 6 ticks (100 ms) = 908 ms = 54.48 ticks
    expect(clock.interpDelayTicks).toBe(6);
    expect(clock.renderTick()).toBeCloseTo(54.48, 9);
  });

  it('interpolation delay is 2 snapshot intervals plus jitter, rounded up to ticks', () => {
    const { clock } = clockAt();
    expect(clock.snapshotIntervalMs).toBe(50);
    expect(clock.interpDelayMs).toBe(100);
    expect(clock.interpDelayTicks).toBe(6);
    clock.onSnapshotArrival(0, 0, 0);
    clock.onSnapshotArrival(50, 3, 60); // deviation 10 → jitter 1
    expect(clock.jitterMs).toBeCloseTo(1, 9);
    expect(clock.interpDelayTicks).toBe(7);
  });
});

describe('NetClock ticks', () => {
  it.each([
    [0, 1],
    [16, 2],
    [100, 4],
  ])('inputLead for RTT %i ms at 60 Hz is %i', (rtt, lead) => {
    const { clock } = clockAt();
    if (rtt > 0) withRtt(clock, rtt);
    expect(clock.rttMs).toBe(rtt);
    expect(clock.inputLead).toBe(lead);
  });

  it('serverTickNow floors estimated server time; inputTick adds inputLead; 0 until synced', () => {
    const { clock, time } = clockAt(1000);
    expect(clock.serverTickNow()).toBe(0);
    expect(clock.inputTick()).toBe(1);
    clock.addSample(5000, 300, 1000); // offset 4000, epoch 0
    expect(clock.serverTimeNow()).toBe(5000);
    expect(clock.serverTickNow()).toBe(300);
    time.now += 50; // exactly 3 ticks later
    expect(clock.serverTickNow()).toBe(303);
    time.now += 16;
    expect(clock.serverTickNow()).toBe(303);
    expect(clock.inputTick()).toBe(304);
  });

  it('serverTickNow never runs backwards across a window shift', () => {
    const { clock, time } = clockAt(0);
    // Window full of promptly delivered samples: offset 0, epoch 0.
    for (let i = 0; i < CLOCK_WINDOW; i++) clock.addSample(0, 0, 0);
    time.now = 1670; // 100.2 ticks
    expect(clock.serverTickNow()).toBe(100);
    // Samples delivered 10 ms late push the prompt ones out: the offset estimate falls.
    let last = clock.serverTickNow();
    for (let i = 0; i < CLOCK_WINDOW; i++) {
      clock.addSample(1000, 60, 1010); // offset -10, epoch 0
      const tick = clock.serverTickNow();
      expect(tick).toBeGreaterThanOrEqual(last);
      last = tick;
    }
    expect(clock.offsetMs).toBe(-10);
    const raw = Math.floor(((clock.serverTimeNow() - clock.tickEpochMs) * 60) / 1000);
    expect(raw).toBe(99);
    expect(clock.serverTickNow()).toBe(100);
    time.now += 50;
    expect(clock.serverTickNow()).toBe(102);
  });

  it('keeps the earliest epoch however long the server starts its ticks late: no step back', () => {
    // Regression: the epoch was the lowest of the window, so a server starting every tick 10 ms
    // late for longer than the window's 0.8 s raised it by 10 ms, and the render tick -- and
    // everything drawn by it -- stepped back by 0.6 of a tick in one frame.
    const { clock, time } = clockAt(0);
    clock.addSample(0, 0, 0);
    clock.update(0);
    for (let i = 1; i <= 3 * CLOCK_WINDOW; i++) {
      time.now = i * 50;
      clock.addSample(i * 50 + 10, i * 3, i * 50 + 10); // every tick start 10 ms late
      const before = clock.renderTick();
      clock.update(time.now);
      expect(clock.tickEpochMs).toBe(0);
      expect(clock.renderTick()).toBeGreaterThan(before);
    }
  });

  it('reset forgets samples, RTT, the render clock and the monotonic floor', () => {
    const { clock, time } = clockAt(0);
    withRtt(clock, 30);
    clock.addSample(100_000, 6000, 0);
    time.now = 10;
    clock.update(10);
    expect(clock.serverTickNow()).toBeGreaterThan(0);
    clock.reset();
    expect(clock.synced).toBe(false);
    expect(clock.rttMs).toBe(0);
    expect(clock.renderTimeMs).toBeNull();
    expect(clock.serverTickNow()).toBe(0);
    clock.addSample(100, 6, 10);
    expect(clock.serverTickNow()).toBe(6);
  });

  it('configure validates rates', () => {
    const { clock } = clockAt();
    expect(() => clock.configure(0, 3)).toThrow(RangeError);
    expect(() => clock.configure(60, 0)).toThrow(RangeError);
    expect(() => clock.configure(60, 1.5)).toThrow(RangeError);
    clock.configure(30, 2);
    expect(clock.tickMs).toBeCloseTo(33.333, 3);
    expect(clock.snapshotIntervalMs).toBeCloseTo(66.667, 3);
  });
});
