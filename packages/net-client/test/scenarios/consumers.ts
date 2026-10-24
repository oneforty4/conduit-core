import type { Consumer, Scenario } from './runner.ts';

/** Consumer policy lives here, never in the runner. Distinct state shapes are deliberate. */
export const vehicle: Consumer<{ distance: number; throttle: number }> = {
  initial: () => ({ distance: 0, throttle: 0 }),
  apply: (state, _kind, value) => {
    state.throttle = value;
  },
  step: (state, dt) => {
    state.distance += state.throttle * dt;
  },
  copy: (state) => ({ ...state }),
};
export const character: Consumer<{ position: number; moving: boolean }> = {
  initial: () => ({ position: 0, moving: false }),
  apply: (state, kind, value) => {
    if (kind === 'command') state.position = value;
    else state.moving = value !== 0;
  },
  step: (state, dt) => {
    if (state.moving) state.position += dt;
  },
  copy: (state) => ({ ...state }),
};
export const inventory: Consumer<{ items: number[]; revision: number }> = {
  initial: () => ({ items: [], revision: 0 }),
  apply: (state, kind, value) => {
    if (kind === 'command') {
      state.items.push(value);
      state.revision++;
    }
  },
  step: () => {},
  copy: (state) => ({ items: [...state.items], revision: state.revision }),
};
export function fixture(adapter: string): Scenario {
  return {
    version: 1,
    seed: 0xc0ffee,
    adapter,
    duration: 1000,
    tickRate: 60,
    renderRate: 144,
    c2s: { latency: 20, jitter: 15, bytesPerSecond: 100_000, maxBytes: 100_000 },
    s2c: { latency: 40, jitter: 30, bytesPerSecond: 100_000, maxBytes: 100_000 },
    stalls: [
      { lane: 'client', at: 200, duration: 200 },
      { lane: 'server', at: 600, duration: 100 },
    ],
    events: [
      { at: 0, kind: 'input', value: 1 },
      { at: 450, kind: 'input', value: 0 },
      { at: 500, kind: 'command', value: 10 },
    ],
  };
}
