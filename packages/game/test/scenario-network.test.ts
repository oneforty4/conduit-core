import { writeFileSync } from 'node:fs';
import { devVerifier } from '@conduit/auth';
import { NetClient, MemoryTransport, type ClientTimers, type Transport } from '@conduit/net-client';
import { Session, type ClientLink } from '@conduit/net-server';
import { MemoryStore } from '@conduit/persist';
import { Region } from '@conduit/sim';
import { afterAll, describe, expect, it } from 'vitest';
import { ScenarioClock } from '../../net-client/test/scenarios/clock.ts';
import { OrderedChannel, seeded } from '../../net-client/test/scenarios/runner.ts';
import {
  CharacterState,
  InventoryAdd,
  InventoryAddMessage,
  InventoryState,
  InventoryView,
  publicConsumers,
  VehicleState,
} from './fixtures/scenario-consumers.ts';

const artifacts: unknown[] = [];
afterAll(() => {
  const path = process.env['CONDUIT_NETWORK_SCENARIO_ARTIFACT'];
  if (path) writeFileSync(path, JSON.stringify({ version: 1, runs: artifacts }, null, 2) + '\n');
});
function clientTimers(clock: ScenarioClock): ClientTimers {
  const base = clock.timers('client', 1);
  return {
    ...base,
    setInterval(fn, ms) {
      const entry = { active: true, handle: undefined as unknown };
      const wake = () => {
        if (!entry.active) return;
        fn();
        entry.handle = base.setTimeout(wake, ms);
      };
      entry.handle = base.setTimeout(wake, ms);
      return entry;
    },
    clearInterval(handle) {
      const entry = handle as { active: boolean; handle: unknown };
      entry.active = false;
      base.clearTimeout(entry.handle);
    },
  };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('three full public NetClient/Session consumers through deterministic reliable timing', () => {
  for (const kind of ['vehicle', 'character', 'inventory'] as const)
    for (const profile of [
      'jitter-resync',
      'zero',
      'asymmetric',
      'bandwidth',
      'long-main-thread-stall',
      'clock-correction',
      'server-overrun',
    ] as const)
      for (const fps of profile === 'jitter-resync' ? [30, 60, 120, 144] : [60])
        it(`${kind} ${fps}Hz ${profile}`, async () => {
          const game = publicConsumers()[kind];
          const duration = profile === 'jitter-resync' ? 2000 : 3000;
          const stalls =
            profile === 'jitter-resync'
              ? [{ lane: 'client' as const, at: 350, duration: 180 }]
              : profile === 'long-main-thread-stall'
                ? [{ lane: 'client' as const, at: 350, duration: 700 }]
                : profile === 'server-overrun'
                  ? [{ lane: 'server' as const, at: 550, duration: 350 }]
                  : [];
          const clock = new ScenarioClock(stalls);
          const channels: OrderedChannel<() => void>[] = [];
          const random = seeded(42);
          const transports: MemoryTransport[] = [];
          let entity = 0;
          let spawns = 0;
          const session = new Session(game, {
            store: new MemoryStore(),
            sessionId: 'dev',
            manualLoop: profile !== 'server-overrun',
            now: () => clock.now,
            timers: clock.timers('server'),
            verifier: devVerifier({ warn() {} }),
            regionLoader: { populate() {} },
            hooks: {
              onPlayerJoin: () => ({
                regionId: 'cell/0_0',
                spawn: (ctx) => {
                  spawns++;
                  entity = ctx.world.create();
                  ctx.world.add(entity, Region, { id: 'cell/0_0' });
                  if (kind === 'vehicle') ctx.world.add(entity, VehicleState);
                  else if (kind === 'character') ctx.world.add(entity, CharacterState);
                  else {
                    ctx.world.add(entity, InventoryState);
                    ctx.world.add(entity, InventoryView);
                  }
                  return entity;
                },
              }),
              onMessage: (_player, definition, payload, ctx) => {
                if (definition.name === InventoryAddMessage.name)
                  ctx.events.emit(InventoryAdd, payload as { item: number });
              },
            },
          });
          await session.start();
          const timers = clientTimers(clock);
          const factory = (): Transport => {
            const options = (direction: 'c2s' | 's2c') => ({
              latency:
                profile === 'zero'
                  ? 0
                  : profile === 'asymmetric'
                    ? direction === 'c2s'
                      ? 80
                      : 10
                    : 10,
              jitter: profile === 'zero' ? 0 : 5,
              bytesPerSecond:
                profile === 'bandwidth' ? (direction === 'c2s' ? 3500 : 2500) : 1_000_000,
              maxBytes: 256_000,
            });
            const c2s = new OrderedChannel<() => void>(clock, options('c2s'), random, 'server');
            const s2c = new OrderedChannel<() => void>(clock, options('s2c'), random, 'client');
            channels.push(c2s, s2c);
            const base = new MemoryTransport({ timers: clock.timers('network'), latencyMs: 0 });
            transports.push(base);
            const link: ClientLink = {
              id: base.link.id,
              send: (buf) =>
                s2c.send(
                  () => {
                    if (!base.closed) base.link.send(buf);
                  },
                  buf.byteLength,
                  (task) => task(),
                ),
              bufferedAmount: () => base.link.bufferedAmount() + s2c.queuedBytes,
              close: (code, reason) =>
                s2c.send(
                  () => base.link.close(code, reason),
                  0,
                  (task) => task(),
                ),
              onMessage: (callback) =>
                base.link.onMessage((buf) => {
                  clock.at(clock.now, 'server', 'process-input', () => callback(buf));
                }),
              onClose: (callback) =>
                base.link.onClose((code, reason) => {
                  clock.at(clock.now, 'server', 'server-close', () => callback(code, reason));
                }),
            };
            session.attach(link);
            return {
              send: (buf) =>
                c2s.send(
                  () => {
                    if (!base.closed) base.send(buf);
                  },
                  buf.byteLength,
                  (task) => task(),
                ),
              close: (code, reason) =>
                c2s.send(
                  () => base.close(code, reason),
                  0,
                  (task) => task(),
                ),
              onOpen: (callback) =>
                base.onOpen(() => {
                  clock.at(clock.now, 'client', 'open', callback);
                }),
              onMessage: (callback) =>
                base.onMessage((buf) => {
                  clock.at(clock.now, 'client', 'process-snapshot', () => callback(buf));
                }),
              onClose: (callback) =>
                base.onClose((code, reason) => {
                  clock.at(clock.now, 'client', 'client-close', () => callback(code, reason));
                }),
              onError: (callback) => base.onError(callback),
            };
          };
          let value = kind === 'vehicle' ? 1 : 0;
          let teleport = false;
          const client = new NetClient({
            url: 'memory://scenario',
            game,
            token: 'fixture',
            displayName: kind,
            now: () => clock.now,
            timers,
            transport: factory,
            sampleInput: (frame) => {
              Object.assign(frame, { value, command: teleport });
            },
            log() {},
          });
          const states: string[] = [];
          client.on('state', (state) => states.push(state));
          const connected = client.connect();
          void connected.catch(() => {});
          if (profile !== 'server-overrun')
            for (let tick = 1; tick <= (duration * 60) / 1000; tick++)
              clock.at((tick * 1000) / 60, 'server', 'tick', () => session.step());
          for (let frame = 0; frame < (fps * duration) / 1000; frame++)
            clock.at((frame * 1000) / fps, 'client', 'frame', () => {
              client.pulseInput();
              client.update(clock.now);
            });
          clock.at(600, 'client', 'stop', () => {
            value = 0;
          });
          clock.at(profile === 'asymmetric' ? 500 : 200, 'client', 'command', () => {
            if (kind === 'inventory') client.send(InventoryAddMessage, { item: 7 });
            if (kind === 'character') {
              value = 50;
              teleport = true;
            }
          });
          clock.at(profile === 'asymmetric' ? 550 : 250, 'client', 'release', () => {
            if (kind === 'character') {
              teleport = false;
              value = 0;
            }
          });
          clock.at(750, 'client', 'second-command', () => {
            if (kind === 'inventory') client.send(InventoryAddMessage, { item: 8 });
          });
          if (profile === 'clock-correction') {
            clock.at(650, 'client', 'late-pong', () => client.clock.onPong(150, 170, 10, 650));
            clock.at(750, 'client', 'fresh-pong', () => client.clock.onPong(730, 740, 44, 750));
          }
          if (profile === 'jitter-resync')
            clock.at(900, 'network', 'disconnect', () => {
              value = 0;
              transports.at(-1)!.link.drop(1006);
            });
          try {
            for (let time = 0; time <= duration; time += 5) {
              clock.run(time);
              await settle();
              clock.run(time);
            }
            await connected;
            expect(client.state).toBe('Playing');
            if (profile === 'jitter-resync') {
              expect(states).toContain('Reconnecting');
              expect(states).toContain('Resyncing');
            }
            expect(client.entity).toBe(entity);
            expect(session.fault).toBeNull();
            expect(transports).toHaveLength(profile === 'jitter-resync' ? 2 : 1);
            expect(spawns).toBe(1);
            expect(session.stats.inputOverflow).toBe(0);
            if (profile === 'jitter-resync' || profile === 'zero')
              expect(session.stats.badInput).toBe(0);
            if (kind === 'vehicle')
              expect(session.world.get(entity, VehicleState).distance).toBeGreaterThan(0.2);
            if (kind === 'character')
              expect(session.world.get(entity, CharacterState)).toEqual({
                position: 50,
                moving: false,
              });
            if (kind === 'inventory')
              expect(session.world.get(entity, InventoryState)).toEqual({
                items: [7, 8],
                revision: 2,
              });
            expect(client.mirror.read(entity, Region)).toEqual(session.world.get(entity, Region));
            if (kind === 'vehicle')
              expect(client.mirror.read(entity, VehicleState)?.distance).toBeCloseTo(
                session.world.get(entity, VehicleState).distance,
                5,
              );
            if (kind === 'character')
              expect(client.mirror.read(entity, CharacterState)?.position).toBeCloseTo(
                session.world.get(entity, CharacterState).position,
                5,
              );
            if (kind === 'inventory') {
              expect(client.mirror.read(entity, InventoryState)).toBeUndefined();
              expect(client.mirror.read(entity, InventoryView)).toEqual(
                session.world.get(entity, InventoryView),
              );
            }
            if (profile === 'server-overrun')
              expect(session.tickStats().dropped).toBeGreaterThan(0);
            if (profile === 'bandwidth')
              expect(Math.max(...channels.map((channel) => channel.peakBytes))).toBeGreaterThan(
                100,
              );
            artifacts.push({
              profile,
              stalls,
              peakQueuedBytes: Math.max(...channels.map((channel) => channel.peakBytes)),
              kind,
              fps,
              seed: 42,
              states,
              schedule: clock.schedule,
              counters: { ...session.stats },
              connections: transports.length,
              spawns,
            });
          } finally {
            client.disconnect();
            clock.run(clock.now + 20);
            await settle();
            await session.stop();
          }
        });
});
