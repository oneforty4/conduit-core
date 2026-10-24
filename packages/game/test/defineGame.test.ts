import type { Manifest } from '@conduit/assets';
import type { ClientGameDef } from '@conduit/net-client';
import type { SessionGameDef } from '@conduit/net-server';
import { defineSchema } from '@conduit/protocol';
import { RegionChanged } from '@conduit/sim';
import { fromJson } from '@conduit/world';
import { describe, expect, it } from 'vitest';
import {
  CORE_COMPONENTS,
  defineComponent,
  defineEvent,
  defineGame,
  defineInput,
  defineMessage,
  defineSystem,
  f,
  type GameDefErrorCode,
  GameDefError,
  type GameDefInput,
  GridWorld,
  Model,
  Name,
  NodeWorld,
  Owner,
  Region,
  Transform,
} from '../src/index.ts';

const Input = defineInput({ tick: f.u32, throttle: f.i8, steer: f.i8 });
const Vehicle = defineComponent('Vehicle', { throttle: f.i8, colour: f.u32 });
const Wanderer = defineComponent('Wanderer', { speed: f.fixed16(0.01) }, { replicate: false });
const Zone = defineComponent('Zone', { radius: f.f32 });
const Shout = defineEvent('Shout', { text: f.str(16) });
const Zap = defineEvent('Zap', { entity: f.entity() }, { replicate: false });
const Chat = defineMessage('Chat', 'both', { text: f.str(200) });
const Notice = defineMessage('Notice', 's2c', { code: f.u16 });
const Ping2 = defineMessage('Ping2', 'c2s', { n: f.u8 });
const move = defineSystem('move', 'sim', () => {});
const steer = defineSystem('steer', 'input', () => {});

function world(seed: number): GridWorld {
  return new GridWorld({ cellSize: 64, cols: 4, rows: 3, wantedDepth: 1, worldSeed: seed });
}

function def(overrides: Partial<GameDefInput<ReturnType<typeof Input.create>>> = {}) {
  return {
    id: 'test-game',
    name: 'Test Game',
    protocolVersion: 1,
    seed: 1234,
    components: [Vehicle, Wanderer],
    messages: [Chat, Notice],
    events: [Shout],
    input: Input,
    systems: [steer, move],
    world,
    ...overrides,
  };
}

function codeOf(fn: () => unknown): GameDefErrorCode | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof GameDefError) {
      expect(err.message.startsWith(`${err.code}: `)).toBe(true);
      expect(err.name).toBe('GameDefError');
      return err.code;
    }
    throw err;
  }
  return undefined;
}

describe('defineGame', () => {
  it('merges and dedupes the core components and events, and sorts every list by name', () => {
    const game = defineGame(def({ components: [Vehicle, Transform, Wanderer, Vehicle] }));
    expect(game.components.map((c) => c.name)).toEqual([
      'Model',
      'Name',
      'Owner',
      'Region',
      'Transform',
      'Vehicle',
      'Wanderer',
    ]);
    expect(game.components.filter((c) => c === Transform)).toHaveLength(1);
    game.components.forEach((c, i) => expect(game.registry.componentId(c)).toBe(i));
    expect(
      [Model, Name, Owner, Region, Transform].map((c) => game.registry.componentId(c)),
    ).toEqual([0, 1, 2, 3, 4]);

    const withCore = defineGame(def({ events: [Zap, RegionChanged, Shout, Zap] }));
    expect(withCore.events.map((e) => e.name)).toEqual(['RegionChanged', 'Shout', 'Zap']);
    withCore.events.forEach((e, i) => expect(withCore.registry.eventId(e)).toBe(i));

    expect(game.messages.map((m) => m.name)).toEqual(['Chat', 'Notice']);
    expect(game.registry.messageKind(Chat)).toBe(128);
    expect(game.registry.messageKind(Notice)).toBe(129);
    expect(game.systems).toEqual([steer, move]);
  });

  it('fills defaults, exposes lookups and freezes the result', () => {
    const game = defineGame(def());
    expect(game.tickRate).toBe(60);
    expect(game.snapshotEvery).toBe(3);
    expect(game.registryHash).toBe(game.registry.hash);
    expect(game.input).toBe(Input);
    expect(game.component('Vehicle')).toBe(Vehicle);
    expect(game.component('Transform')).toBe(Transform);
    expect(game.component('Nope')).toBeUndefined();
    expect(game.message('Chat')).toBe(Chat);
    expect(game.event('RegionChanged')).toBe(RegionChanged);
    expect(Object.isFrozen(game)).toBe(true);
    expect(Object.isFrozen(game.components)).toBe(true);
    // The Session and NetClient accept a Game as it is.
    const serverDef: SessionGameDef = game;
    const clientDef: ClientGameDef = game;
    expect(serverDef.registry).toBe(clientDef.registry);
  });

  it('keeps the optional asset manifest as given, and leaves it out when absent', () => {
    const manifest: Manifest = {
      version: 1,
      baseUrl: '/assets/',
      assets: {},
      groups: {},
      regions: {},
    };
    const withAssets = defineGame(def({ assets: manifest }));
    expect(withAssets.assets).toBe(manifest);
    expect(withAssets.registryHash).toBe(defineGame(def()).registryHash); // not on the wire
    expect('assets' in defineGame(def())).toBe(false);
    expect('assets' in defineGame(def({ assets: undefined }))).toBe(false);
  });

  it('assigns identical ids and hashes whatever order the lists come in', () => {
    const orders = [
      def({
        components: [Vehicle, Wanderer, Zone],
        messages: [Chat, Notice, Ping2],
        events: [Shout, Zap],
      }),
      def({
        components: [Zone, Vehicle, Wanderer],
        messages: [Ping2, Chat, Notice],
        events: [Zap, Shout],
      }),
      def({
        components: [Wanderer, Zone, Vehicle],
        messages: [Notice, Ping2, Chat],
        events: [Shout, Zap],
      }),
    ];
    const snapshots = orders.map((d) => {
      const game = defineGame(d);
      return {
        hash: game.registryHash,
        components: game.components.map((c) => [
          c.name,
          game.registry.componentId(c),
          game.registry.componentId(c),
        ]),
        messages: game.messages.map((m) => [m.name, game.registry.messageKind(m)]),
        events: game.events.map((e) => [
          e.name,
          game.registry.eventId(e),
          game.registry.eventId(e),
        ]),
      };
    });
    expect(snapshots[1]).toEqual(snapshots[0]);
    expect(snapshots[2]).toEqual(snapshots[0]);
    expect(snapshots[0]?.components).toContainEqual(['Zone', 7, 7]);
    expect(snapshots[0]?.events).toEqual([
      ['RegionChanged', 0, 0],
      ['Shout', 1, 1],
      ['Zap', 2, 2],
    ]);
  });

  it('changes registryHash when a component field changes, not when protocolVersion does', () => {
    const base = defineGame(def());
    const bumped = defineGame(def({ protocolVersion: 2 }));
    expect(bumped.registryHash).toBe(base.registryHash);

    const Vehicle16 = defineComponent('Vehicle', { throttle: f.i16, colour: f.u32 });
    const changed = defineGame(def({ components: [Vehicle16, Wanderer] }));
    expect(changed.registryHash).not.toBe(base.registryHash);
    expect(changed.registry.componentId(Vehicle16)).toBe(base.registry.componentId(Vehicle));
  });

  it('throws each GameDefErrorCode for its trigger', () => {
    const cases: [GameDefErrorCode, () => unknown][] = [
      ['badId', () => defineGame(def({ id: 'Test Game' }))],
      ['badId', () => defineGame(def({ id: 'a' }))],
      ['badProtocolVersion', () => defineGame(def({ protocolVersion: 0 }))],
      ['badProtocolVersion', () => defineGame(def({ protocolVersion: 65536 }))],
      ['badTickRate', () => defineGame(def({ tickRate: 0 }))],
      ['badTickRate', () => defineGame(def({ tickRate: 241 }))],
      ['badTickRate', () => defineGame(def({ tickRate: 30.5 }))],
      ['badSnapshotEvery', () => defineGame(def({ snapshotEvery: 0 }))],
      ['badSnapshotEvery', () => defineGame(def({ snapshotEvery: 256 }))],
      ['badSeed', () => defineGame(def({ seed: -1 }))],
      ['badSeed', () => defineGame(def({ seed: 2 ** 32 }))],
      [
        'duplicateComponent',
        () => defineGame(def({ components: [Vehicle, defineComponent('Vehicle', { x: f.u8 })] })),
      ],
      [
        'duplicateComponent',
        () => defineGame(def({ components: [defineComponent('Transform', { x: f.u8 })] })),
      ],
      ['duplicateEvent', () => defineGame(def({ events: [Zap, defineEvent('Zap', {})] }))],
      ['duplicateMessage', () => defineGame(def({ messages: [Chat, Chat] }))],
      [
        'duplicateSystem',
        () => defineGame(def({ systems: [move, defineSystem('move', 'postSim', () => {})] })),
      ],
      [
        'inputLacksTick',
        () => defineGame(def({ input: badInput({ throttle: f.i8, tick: f.u32 }) })),
      ],
      ['inputLacksTick', () => defineGame(def({ input: badInput({ tick: f.u16 }) }))],
      [
        'badInterpolate',
        () =>
          defineGame(
            def({
              components: [defineComponent('Wobble', { on: f.bool }, { interpolate: ['on'] })],
            }),
          ),
      ],
      [
        'badInterpolate',
        () =>
          defineGame(
            def({ components: [defineComponent('Wobble', { x: f.f32 }, { interpolate: ['y'] })] }),
          ),
      ],
      [
        'badExtrapolate',
        () =>
          defineGame(
            def({
              components: [
                defineComponent(
                  'Wobble',
                  { pos: f.vec3(f.f32), vel: f.vec2(f.f32) },
                  { interpolate: ['pos'], extrapolateWith: 'vel' },
                ),
              ],
            }),
          ),
      ],
      [
        'badExtrapolate',
        () =>
          defineGame(
            def({
              components: [
                defineComponent(
                  'Wobble',
                  { pos: f.vec2(f.f32) },
                  { interpolate: ['pos'], extrapolateWith: 'v' },
                ),
              ],
            }),
          ),
      ],
    ];
    for (const [code, trigger] of cases) expect(codeOf(trigger)).toBe(code);
  });

  it('allows 255 components including the core ones and rejects 256', () => {
    const extra = (n: number) =>
      Array.from({ length: n }, (_, i) => defineComponent(`Z${String(i).padStart(3, '0')}`, {}));
    expect(codeOf(() => defineGame(def({ components: extra(256 - CORE_COMPONENTS.length) })))).toBe(
      'tooManyComponents',
    );
    const game = defineGame(def({ components: extra(255 - CORE_COMPONENTS.length) }));
    expect(game.components).toHaveLength(255);
    expect(game.registry.componentId(game.components[254]!)).toBe(254);
  });

  it('shares immutable definitions between differently ordered games', () => {
    const first = defineGame(def());
    const Alpha = defineComponent('Alpha', { a: f.u8 });
    const Aardvark = defineEvent('Aardvark', {});
    const second = defineGame(def({ components: [Alpha, Vehicle], events: [Aardvark] }));
    expect(first.registry.componentId(Model)).toBe(0);
    expect(second.registry.componentId(Model)).toBe(1);
    expect(first.registry.eventId(RegionChanged)).toBe(0);
    expect(second.registry.eventId(RegionChanged)).toBe(1);
    expect('id' in Alpha).toBe(false);
    expect('id' in RegionChanged).toBe(false);
  });

  it('caches graphJson per seed and round-trips it through fromJson', () => {
    const game = defineGame(def());
    const json = game.graphJson();
    expect(game.graphJson()).toBe(json);
    expect(game.graphJson(game.seed)).toBe(json);
    const other = game.graphJson(99);
    expect(other).not.toBe(json);
    expect(game.graphJson(99)).toBe(other);
    expect(json).toEqual(game.world(game.seed).toJson());
    expect(fromJson(json).toJson()).toEqual(json);
    expect(json.grid?.worldSeed).toBe(1234);
    expect(other.grid?.worldSeed).toBe(99);
  });

  it('accepts a NodeWorld from the root entry and round-trips its graphJson', () => {
    const system = (id: string, neighbors: string[], x: number) => ({
      id,
      kind: 'system',
      bounds: { kind: 'node' as const, origin: { x, y: 0, z: 0 } },
      neighbors,
      assets: [],
      seed: x,
    });
    const nodes = () =>
      new NodeWorld([
        system('system/sol', ['system/vega'], 0),
        system('system/vega', ['system/sol', 'system/wolf'], 1e9),
        system('system/wolf', ['system/vega'], 2e9),
      ]);
    const game = defineGame(def({ world: nodes }));
    const json = game.graphJson();
    expect(json.kind).toBe('node');
    expect(fromJson(json)).toBeInstanceOf(NodeWorld);
    expect(fromJson(json).toJson()).toEqual(json);
    expect(game.world(game.seed).wanted('system/sol')).toEqual(['system/sol', 'system/vega']);
  });
});

/** An input schema built without defineInput (which would refuse it). */
function badInput(fields: Parameters<typeof defineSchema>[0]): typeof Input {
  return defineSchema(fields) as unknown as typeof Input;
}

it('declares simulation separately from schemas and optional presentation assets', () => {
  const gameplayDigests = { collision: 'collision-1', compactIds: 'ids-1' };
  const first = defineGame(
    def({ compatibility: { simulationRevision: 'rules-1', gameplayDigests } }),
  );
  gameplayDigests.collision = 'changed-after-construction';
  expect(
    first.compatibility.gameplayDigests.find((entry) => entry.name === 'collision')?.digest,
  ).toBe('collision-1');
  const second = defineGame(
    def({
      compatibility: {
        simulationRevision: 'rules-2',
        gameplayDigests: { collision: 'collision-1', compactIds: 'ids-1' },
      },
    }),
  );
  expect(first.registryHash).toBe(second.registryHash);
  expect(first.compatibility).not.toEqual(second.compatibility);
  const cosmetic = defineGame(
    def({
      compatibility: {
        simulationRevision: 'rules-1',
        gameplayDigests: { collision: 'collision-1', compactIds: 'ids-1' },
      },
      assets: { version: 1, baseUrl: '/new-cosmetics/', groups: {}, assets: {}, regions: {} },
    }),
  );
  expect(cosmetic.compatibility).toEqual(first.compatibility);
  expect(defineGame(def()).compatibility.mode).toBe('schema-only');
});
