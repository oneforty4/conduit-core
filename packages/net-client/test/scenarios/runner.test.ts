import { describe, expect, it } from 'vitest';
import { MemoryTransport } from '../../src/transport.ts';
import { ScenarioClock } from './clock.ts';
import { character, fixture, inventory, vehicle } from './consumers.ts';
import { OrderedChannel, runScenario } from './runner.ts';

describe('deterministic scenario tooling', () => {
  it('drives the public reliable transport with lane-specific virtual timers', () => {
    const clock = new ScenarioClock();
    const transport = new MemoryTransport({ timers: clock.timers('network'), latencyMs: 10 });
    const received: number[] = [];
    transport.link.onMessage((bytes) => received.push(bytes[0] ?? -1));
    clock.run(0);
    transport.send(new Uint8Array([1]));
    transport.send(new Uint8Array([2]));
    clock.run(10);
    expect(received).toEqual([1, 2]);
    transport.close();
    clock.run(20);
    expect(transport.closed).toBe(true);
  });
  it('reproduces the complete effective schedule and state from JSON', () => {
    const scenario = fixture('vehicle');
    const first = runScenario(scenario, vehicle);
    expect(runScenario(JSON.parse(JSON.stringify(scenario)), vehicle)).toEqual(first);
    expect(first.metrics.queuePeakBytes.s2c).toBeGreaterThan(0);
  });
  it('preserves FIFO despite jitter and holds client processing during stalls', () => {
    const clock = new ScenarioClock([{ lane: 'client', at: 0, duration: 100 }]);
    let sample = 0;
    const channel = new OrderedChannel<number>(
      clock,
      { latency: 20, jitter: 20, bytesPerSecond: 1000, maxBytes: 100 },
      () => (sample++ === 0 ? 1 : 0),
      'client',
    );
    const seen: number[] = [];
    channel.send(1, 1, (n) => seen.push(n));
    channel.send(2, 1, (n) => seen.push(n));
    clock.run(99);
    expect(seen).toEqual([]);
    clock.run(100);
    expect(seen).toEqual([1, 2]);
    expect(channel.latencies).toEqual([100, 100]);
  });
  it('holds timers independently and bounds runaway zero-delay callbacks', () => {
    const clock = new ScenarioClock([{ lane: 'client', at: 0, duration: 200 }], 5);
    const seen: string[] = [];
    clock.timers('client', 16).setTimeout(() => seen.push('client'), 1);
    clock.timers('server').setTimeout(() => seen.push('server'), 1);
    clock.run(199);
    expect(seen).toEqual(['server']);
    clock.run(200);
    expect(seen).toEqual(['server', 'client']);
    const loop = () => clock.timers('network').setTimeout(loop, 0);
    loop();
    expect(() => clock.run(201)).toThrow('limit exceeded');
  });
  it('runs abrupt stop/teleport and command-driven consumers', () => {
    const stopped = runScenario(fixture('character'), character);
    expect(stopped.final).toEqual({ position: 10, moving: false });
    expect(runScenario(fixture('inventory'), inventory).final).toEqual({
      items: [10],
      revision: 1,
    });
  });
  it('fails explicitly under capacity pressure instead of losing messages', () => {
    const scenario = fixture('vehicle');
    scenario.s2c.maxBytes = 1;
    expect(() => runScenario(scenario, vehicle)).toThrow('queue capacity');
  });
  it('never applies outage inputs to a new connection generation', () => {
    const scenario = fixture('inventory');
    scenario.events = [
      { at: 0, kind: 'command', value: 1 },
      { at: 1, kind: 'disconnect', value: 0 },
      { at: 2, kind: 'reconnect', value: 0 },
      { at: 3, kind: 'command', value: 2 },
    ];
    expect(runScenario(scenario, inventory).final.items).toEqual([2]);
  });
});
