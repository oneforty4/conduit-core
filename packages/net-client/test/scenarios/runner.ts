import { ScenarioClock, type Stall } from './clock.ts';

export interface ChannelOptions {
  latency: number;
  jitter: number;
  bytesPerSecond: number;
  maxBytes: number;
}
export interface Scenario {
  version: 1;
  seed: number;
  adapter: string;
  duration: number;
  tickRate: number;
  renderRate: number;
  c2s: ChannelOptions;
  s2c: ChannelOptions;
  stalls: Stall[];
  events: { at: number; kind: 'input' | 'command' | 'disconnect' | 'reconnect'; value: number }[];
}
export interface Consumer<S> {
  initial(): S;
  apply(state: S, kind: 'input' | 'command', value: number): void;
  step(state: S, dt: number): void;
  copy(state: S): S;
}
export interface Trace {
  at: number;
  kind: string;
  value: unknown;
}

export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Reliable FIFO with serialization and head-of-line delay; saturation fails explicitly. */
export class OrderedChannel<T> {
  private available = 0;
  private lastArrival = 0;
  queuedBytes = 0;
  peakBytes = 0;
  readonly latencies: number[] = [];
  constructor(
    private clock: ScenarioClock,
    private options: ChannelOptions,
    private random: () => number,
    private lane: 'client' | 'server',
  ) {}
  send(value: T, bytes: number, receive: (value: T) => void): void {
    const { latency, jitter, bytesPerSecond, maxBytes } = this.options;
    if (this.queuedBytes + bytes > maxBytes) throw new Error('scenario queue capacity exceeded');
    const sent = this.clock.now;
    this.queuedBytes += bytes;
    this.peakBytes = Math.max(this.peakBytes, this.queuedBytes);
    this.available = Math.max(sent, this.available) + (bytes / bytesPerSecond) * 1000;
    this.lastArrival = Math.max(
      this.lastArrival,
      this.available + Math.max(0, latency + (this.random() * 2 - 1) * jitter),
    );
    this.clock.at(this.lastArrival, 'network', 'transit', () => {
      this.clock.at(this.clock.now, this.lane, 'delivery', () => {
        this.queuedBytes -= bytes;
        this.latencies.push(this.clock.now - sent);
        receive(value);
      });
    });
  }
}

export function runScenario<S>(scenario: Scenario, adapter: Consumer<S>) {
  if (
    scenario.version !== 1 ||
    !Number.isFinite(scenario.duration) ||
    scenario.duration <= 0 ||
    scenario.duration > 60_000 ||
    scenario.events.length > 10_000 ||
    scenario.stalls.length > 10_000 ||
    !Number.isInteger(scenario.seed) ||
    scenario.seed < 0 ||
    scenario.seed > 0xffffffff ||
    typeof scenario.adapter !== 'string' ||
    scenario.adapter.length > 128 ||
    ![scenario.tickRate, scenario.renderRate].every((n) => Number.isFinite(n) && n > 0 && n <= 1000)
  )
    throw new Error('unsupported scenario bounds');
  for (const channel of [scenario.c2s, scenario.s2c]) {
    if (
      ![channel.latency, channel.jitter, channel.bytesPerSecond, channel.maxBytes].every(
        Number.isFinite,
      ) ||
      channel.latency < 0 ||
      channel.jitter < 0 ||
      channel.bytesPerSecond <= 0 ||
      channel.maxBytes <= 0
    )
      throw new Error('invalid channel');
  }
  for (const stall of scenario.stalls)
    if (
      !['client', 'server', 'network'].includes(stall.lane) ||
      !Number.isFinite(stall.at) ||
      !Number.isFinite(stall.duration) ||
      stall.at < 0 ||
      stall.duration < 0
    )
      throw new Error('invalid stall');
  for (const event of scenario.events) {
    if (
      !Number.isFinite(event.at) ||
      event.at < 0 ||
      event.at > scenario.duration ||
      !Number.isFinite(event.value) ||
      !['input', 'command', 'disconnect', 'reconnect'].includes(event.kind)
    )
      throw new Error('invalid event');
  }
  const clock = new ScenarioClock(scenario.stalls);
  const random = seeded(scenario.seed);
  const up = new OrderedChannel<Scenario['events'][number]>(clock, scenario.c2s, random, 'server');
  const down = new OrderedChannel<S>(clock, scenario.s2c, random, 'client');
  const state = adapter.initial();
  let replica = adapter.copy(state);
  let connected = true;
  let generation = 0;
  const trace: Trace[] = [];
  const pending: { event: Scenario['events'][number]; epoch: number }[] = [];
  const record = (kind: string, value: unknown) => trace.push({ at: clock.now, kind, value });
  for (const event of scenario.events)
    clock.at(event.at, 'client', event.kind, () => {
      if (event.kind === 'disconnect' || event.kind === 'reconnect') {
        connected = event.kind === 'reconnect';
        generation++;
        record(event.kind, generation);
        return;
      }
      if (!connected) return;
      const epoch = generation;
      up.send(event, 16, (delivered) => {
        if (!connected || epoch !== generation) return;
        pending.push({ event: delivered, epoch });
        record('received', delivered);
      });
    });
  for (let tick = 1; (tick * 1000) / scenario.tickRate <= scenario.duration; tick++) {
    clock.at((tick * 1000) / scenario.tickRate, 'server', 'step', () => {
      for (const { event, epoch } of pending.splice(0)) {
        if (
          connected &&
          epoch === generation &&
          (event.kind === 'input' || event.kind === 'command')
        ) {
          adapter.apply(state, event.kind, event.value);
          record('applied', event);
        }
      }
      adapter.step(state, 1 / scenario.tickRate);
      const snapshot = adapter.copy(state);
      record('state', snapshot);
      if (!connected) return;
      const epoch = generation;
      down.send(snapshot, JSON.stringify(snapshot).length, (delivered) => {
        if (connected && epoch === generation) {
          replica = delivered;
          record('snapshot', delivered);
        }
      });
    });
  }
  for (let frame = 1; (frame * 1000) / scenario.renderRate <= scenario.duration; frame++)
    clock.at((frame * 1000) / scenario.renderRate, 'client', 'render', () =>
      record('render', adapter.copy(replica)),
    );
  clock.run(scenario.duration);
  return {
    version: 1 as const,
    scenario,
    schedule: clock.schedule,
    trace,
    final: adapter.copy(state),
    replica,
    metrics: {
      c2sLatencies: up.latencies,
      s2cLatencies: down.latencies,
      queuePeakBytes: { c2s: up.peakBytes, s2c: down.peakBytes },
    },
  };
}
