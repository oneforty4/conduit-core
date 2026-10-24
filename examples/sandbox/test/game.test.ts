// @vitest-environment node
// (a real createServer and headless createClient run below; jsdom's WebSocket is not needed)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Region, Transform } from '@conduit/game';
import { createClient, type GameClient } from '@conduit/game/client';
import {
  createServer,
  openApplicationSave,
  type GameServer,
  MemoryStore,
  type PlayerInfo,
  type ServerContext,
  type ServerHooks,
  type ServerLog,
} from '@conduit/game/server';
import type { Vec3 } from '@conduit/math';
import { ByteWriter, encodeWith } from '@conduit/protocol';
import type { SimContext } from '@conduit/sim';
import type { RegionBlob, RegionDef, RegionLoader } from '@conduit/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHooks } from '../src/server/hooks.ts';
import { SandboxLoader } from '../src/server/loader.ts';
import { Crate, Wanderer } from '../src/shared/components.ts';
import type * as ComponentsModule from '../src/shared/components.ts';
import { SPAWN_REGION, WANDERER_START } from '../src/shared/constants.ts';
import type * as EventsModule from '../src/shared/events.ts';
import { Horn } from '../src/shared/events.ts';
import { game } from '../src/shared/game.ts';
import type * as GameModule from '../src/shared/game.ts';
import type * as InputModule from '../src/shared/input.ts';
import type { SandboxInput } from '../src/shared/input.ts';
import type * as MessagesModule from '../src/shared/messages.ts';
import {
  Chat,
  CHAT_MAX_BYTES,
  chatLine,
  clipUtf8,
  Joins,
  type JoinsMessage,
} from '../src/shared/messages.ts';
import type * as SystemsModule from '../src/shared/systems.ts';
import { player } from './harness.ts';

/**
 * `game.registryHash`, checked in every Hello. Changing a replicated schema changes it and forces
 * every open tab to refresh (`Rejected: SchemaMismatch`, PLAN.md Spike 5); update it deliberately.
 * M4 added the `Joins` message (was 0xb82e70c1); the core `Transform.vel` became `f32` (was
 * 0x4bf19379). Wire 3 adds snapshot-limit negotiation and SnapshotPart; wire 4 adds capacity
 * admission. `persist` flags are not part of this wire hash (they are included in the
 * independent state schema hash).
 */
const REGISTRY_HASH = 0x8a68c0f8;

interface SharedModules {
  game: typeof GameModule;
  components: typeof ComponentsModule;
  systems: typeof SystemsModule;
  input: typeof InputModule;
  messages: typeof MessagesModule;
  events: typeof EventsModule;
}

/** Loads the shared modules into a fresh module registry, in the given order. */
async function freshImport(order: readonly (keyof SharedModules)[]): Promise<SharedModules> {
  vi.resetModules();
  const loaded: Partial<SharedModules> = {};
  for (const name of order) {
    switch (name) {
      case 'game':
        loaded.game = await import('../src/shared/game.ts');
        break;
      case 'components':
        loaded.components = await import('../src/shared/components.ts');
        break;
      case 'systems':
        loaded.systems = await import('../src/shared/systems.ts');
        break;
      case 'input':
        loaded.input = await import('../src/shared/input.ts');
        break;
      case 'messages':
        loaded.messages = await import('../src/shared/messages.ts');
        break;
      case 'events':
        loaded.events = await import('../src/shared/events.ts');
        break;
    }
  }
  return loaded as SharedModules;
}

function idsOf(g: typeof game): [string, number][] {
  return g.components.map((c) => [c.name, g.registry.componentId(c)]);
}

describe('sandbox game definition', () => {
  it('matches the content spec', () => {
    expect(game).toMatchObject({
      id: 'sandbox',
      name: 'Sandbox',
      protocolVersion: 1,
      tickRate: 60,
      snapshotEvery: 3,
      seed: 0xc0ffee,
    });
    expect(idsOf(game)).toEqual([
      ['Crate', 0],
      ['Model', 1],
      ['Name', 2],
      ['Owner', 3],
      ['Region', 4],
      ['Transform', 5],
      ['Vehicle', 6],
      ['Wanderer', 7],
    ]);
    const flags = (name: string) => {
      const c = game.component(name);
      return c && { replicate: c.replicate, persist: c.persist };
    };
    expect(flags('Vehicle')).toEqual({ replicate: true, persist: false });
    expect(game.component('Vehicle')?.schema.fieldNames).toEqual([
      'throttle',
      'steer',
      'buttons',
      'colour',
    ]);
    expect(flags('Wanderer')).toEqual({ replicate: false, persist: true });
    expect(flags('Crate')).toEqual({ replicate: true, persist: true });
    expect(game.input.fieldNames).toEqual(['tick', 'throttle', 'steer', 'buttons']);
    expect(game.systems.map((s) => `${s.phase}:${s.name}`)).toEqual([
      'input:vehicleInput',
      'sim:vehicleKinematics',
      'sim:wandererAi',
    ]);
    expect(game.messages).toEqual([Chat, Joins]);
    expect(Chat.direction).toBe('both');
    expect(game.registry.messageKind(Chat)).toBe(128);
    expect(Joins.direction).toBe('s2c');
    expect(Joins.schema.fieldNames).toEqual(['total']);
    expect(game.registry.messageKind(Joins)).toBe(129);
    expect(game.events.map((e) => [e.name, game.registry.eventId(e), e.replicate])).toEqual([
      ['Horn', 0, true],
      ['RegionChanged', 1, false],
    ]);
    expect(game.event('Horn')).toBe(Horn);
    // The manifest is fetched by the browser client at runtime, not part of the definition.
    expect(game.assets).toBeUndefined();
  });

  it('builds a 16 x 16 grid of 256 m cells around the spawn cell', () => {
    const graph = game.world(game.seed);
    expect(graph.get(SPAWN_REGION)?.bounds.origin).toEqual({ x: 2048, y: 0, z: 2048 });
    expect(graph.get('cell/15_15')).toBeDefined();
    expect(graph.get('cell/16_0')).toBeUndefined();
    expect(graph.locate({ x: 2048 + 3, y: 0, z: 2048 + 250 })).toBe(SPAWN_REGION);
    expect(graph.wanted(SPAWN_REGION)).toHaveLength(9);
    expect(graph.get('cell/3_12')?.assets).toEqual(['crate']);
    expect(game.graphJson().grid).toMatchObject({ cellSize: 256, cols: 16, rows: 16, plane: 'xz' });
  });

  it('commits world.json as game.graphJson() (regenerate with pnpm world)', () => {
    // Not `new URL(..., import.meta.url)`: Vite rewrites that into a dev-server asset URL.
    const committed: unknown = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'world.json'), 'utf8'),
    );
    expect(committed).toEqual(game.graphJson());
  });

  it('pins the registry hash', () => {
    expect(game.registryHash >>> 0).toBe(REGISTRY_HASH);
  });

  it('assigns the same ids and registry hash whatever the import order', async () => {
    const orders: (keyof SharedModules)[][] = [
      ['game', 'components', 'systems', 'input', 'messages', 'events'],
      ['events', 'components', 'input', 'messages', 'systems', 'game'],
      ['systems', 'messages', 'input', 'events', 'components', 'game'],
    ];
    for (const order of orders) {
      const fresh = await freshImport(order);
      expect(fresh.game.game).not.toBe(game); // a separate module graph
      expect(idsOf(fresh.game.game), order.join(' > ')).toEqual(idsOf(game));
      expect(fresh.game.game.registryHash >>> 0).toBe(REGISTRY_HASH);
    }
  });

  it('assigns the same ids and registry hash whatever the order of the component list', async () => {
    const { components, systems, input, messages, events } = await freshImport([
      'components',
      'systems',
      'input',
      'messages',
      'events',
    ]);
    const { defineGame, GridWorld } = await import('@conduit/game');
    const reordered = defineGame({
      id: 'sandbox',
      name: 'Sandbox',
      protocolVersion: 1,
      seed: 0xc0ffee,
      components: [components.Crate, components.Wanderer, components.Vehicle],
      messages: [messages.Joins, messages.Chat],
      events: [events.Horn],
      input: input.InputFrame,
      systems: [systems.vehicleInput, systems.vehicleKinematics, systems.wandererAi],
      world: (seed) => new GridWorld({ cellSize: 256, cols: 16, rows: 16, worldSeed: seed }),
    });
    expect(idsOf(reordered)).toEqual(idsOf(game));
    expect(reordered.registryHash >>> 0).toBe(REGISTRY_HASH);
  });
});

describe('chat', () => {
  /** The hooks' `onMessage.Chat` with a context that records broadcasts. */
  function chatHook(): {
    send: (from: PlayerInfo, text: string) => void;
    broadcasts: unknown[][];
  } {
    const hooks = createHooks();
    const broadcasts: unknown[][] = [];
    const ctx = {
      broadcast: (...args: unknown[]) => broadcasts.push(args),
    } as unknown as ServerContext<SandboxInput>;
    const handler = hooks.onMessage?.['Chat'];
    if (handler === undefined) throw new Error('no onMessage.Chat hook');
    return { send: (from, text) => handler(from, { text }, ctx), broadcasts };
  }

  it("broadcasts '<displayName>: <text>' to every player and drops blank text", () => {
    const { send, broadcasts } = chatHook();
    send(player(0, 'alice'), '  hello there ');
    send(player(1, 'bob'), '   ');
    send(player(1, 'bob'), 'hi');
    expect(broadcasts).toEqual([
      [Chat, { text: 'alice: hello there' }],
      [Chat, { text: 'bob: hi' }],
    ]);
  });

  it("clips the line to Chat.text's 200 UTF-8 bytes without splitting a character", () => {
    const encoded = (text: string) => new TextEncoder().encode(text).byteLength;
    const { send, broadcasts } = chatHook();
    const name = 'n'.repeat(32);
    send(player(0, name), '\u{E9}'.repeat(200)); // 400 bytes of text
    const line = (broadcasts[0]?.[1] as { text: string }).text;
    expect(line.startsWith(`${name}: \u{E9}`)).toBe(true);
    expect(encoded(line)).toBeLessThanOrEqual(CHAT_MAX_BYTES);
    expect(encoded(line)).toBeGreaterThan(CHAT_MAX_BYTES - 2);
    expect(() => encodeWith(new ByteWriter(256), Chat.schema, { text: line })).not.toThrow();
    expect(chatLine('a', 'b')).toBe('a: b');
    expect(clipUtf8('a\u{1F600}b', 4)).toBe('a');
    expect(clipUtf8('a\u{1F600}b', 5)).toBe('a\u{1F600}');
    expect(clipUtf8('\u{D800}xy', 4)).toBe('\u{D800}x'); // a lone surrogate encodes as 3 bytes
  });
});

describe('session state hooks', () => {
  /** A context that records broadcasts and logs. */
  function context(): {
    ctx: ServerContext<SandboxInput>;
    broadcasts: unknown[][];
    logs: string[];
  } {
    const broadcasts: unknown[][] = [];
    const logs: string[] = [];
    const ctx = {
      broadcast: (...args: unknown[]) => broadcasts.push(args),
      log: (level: string, msg: string) => logs.push(`${level}: ${msg}`),
    } as unknown as ServerContext<SandboxInput>;
    return { ctx, broadcasts, logs };
  }

  it('counts joins, broadcasts the total, saves { joins } and continues from what onLoad restored', () => {
    const hooks = createHooks();
    const { ctx, broadcasts, logs } = context();
    hooks.onInit?.(ctx);
    hooks.onPlayerJoin(player(0, 'alice'), ctx);
    hooks.onPlayerJoin(player(1, 'bob'), ctx);
    expect(broadcasts).toEqual([
      [Joins, { total: 1 }],
      [Joins, { total: 2 }],
    ]);
    expect(hooks.onSave?.(ctx)).toEqual({ joins: 2 });

    const restarted = createHooks();
    restarted.onLoad?.(ctx, { joins: 7 });
    restarted.onPlayerJoin(player(0, 'alice'), ctx);
    expect(broadcasts.at(-1)).toEqual([Joins, { total: 8 }]);
    expect(restarted.onSave?.(ctx)).toEqual({ joins: 8 });
    expect(logs.filter((line) => !line.startsWith('info'))).toEqual([]);

    const damaged = createHooks();
    damaged.onLoad?.(ctx, { joins: -1 });
    expect(damaged.onSave?.(ctx)).toEqual({ joins: 0 });
    expect(logs.at(-1)).toBe('warn: sandbox: ignoring a malformed saved session');
  });
});

/** What a region holds: crate positions (sorted) and its wanderer's position and target. */
interface RegionContents {
  crates: Vec3[];
  wanderers: { pos: Vec3; target: Vec3 }[];
}

function byXz(a: Vec3, b: Vec3): number {
  return a.x - b.x || a.z - b.z;
}

/** The crates and wanderers of region `id` in `ctx.world`, from `Region` (not the region manager). */
function contentsOf(ctx: SimContext, id: string): RegionContents {
  const { world } = ctx;
  const crates: Vec3[] = [];
  const wanderers: RegionContents['wanderers'] = [];
  for (const e of world.query(Region, Transform)) {
    if (world.get(e, Region).id !== id) continue;
    const pos = { ...world.get(e, Transform).pos };
    if (world.has(e, Crate)) crates.push(pos);
    if (world.has(e, Wanderer))
      wanderers.push({ pos, target: { ...world.get(e, Wanderer).target } });
  }
  return { crates: crates.sort(byXz), wanderers };
}

/** `SandboxLoader`, recording for each region whether it was restored and what it held right then. */
class RecordingLoader implements RegionLoader {
  private readonly inner = new SandboxLoader();
  readonly seeded: string[] = [];
  readonly restored = new Map<string, RegionContents>();

  populate(region: RegionDef, blob: RegionBlob | null, ctx: SimContext): void {
    // A restored region's persisted entities exist before populate runs (docs/world.md 5.3).
    if (blob === null) this.seeded.push(region.id);
    else this.restored.set(region.id, contentsOf(ctx, region.id));
    this.inner.populate(region, blob, ctx);
  }

  onDeactivate(): undefined {
    return this.inner.onDeactivate();
  }
}

/** `createHooks()` recording `onInit` calls and what `onLoad` received. */
function recordingHooks(): {
  hooks: ServerHooks<SandboxInput>;
  inits: number[];
  loaded: unknown[];
} {
  const hooks = createHooks();
  const inits: number[] = [];
  const loaded: unknown[] = [];
  return {
    inits,
    loaded,
    hooks: {
      ...hooks,
      onInit(ctx) {
        inits.push(ctx.tick);
        hooks.onInit?.(ctx);
      },
      onLoad(ctx, saved) {
        loaded.push(saved);
        hooks.onLoad?.(ctx, saved);
      },
    },
  };
}

function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (predicate()) resolve();
      else if (performance.now() > deadline) reject(new Error(`timed out waiting for ${label}`));
      else setTimeout(poll, 5);
    };
    poll();
  });
}

describe('persistence across a server restart on one store', () => {
  const servers: GameServer[] = [];
  const clients: GameClient<SandboxInput>[] = [];
  const errors: unknown[] = [];
  const log: ServerLog = (level, msg, data) => {
    if (level === 'error') errors.push([msg, data]);
  };

  afterEach(async () => {
    for (const client of clients.splice(0)) client.dispose();
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  async function serve(store: MemoryStore, loader: RegionLoader, hooks: ServerHooks<SandboxInput>) {
    const server = await createServer(game, {
      devAuth: true,
      store,
      regionLoader: loader,
      hooks,
      log,
    });
    servers.push(server);
    return server;
  }

  /** A headless driver at full throttle; `totals` collects the `Joins` broadcasts it receives. */
  function driver(server: GameServer, name: string, totals: number[]): GameClient<SandboxInput> {
    const client = createClient(game, {
      url: server.url,
      displayName: name,
      sampleInput: (ctx) => ({ tick: ctx.tick, throttle: 127, steer: 0, buttons: 0 }),
      onMessage: { Joins: (msg) => totals.push((msg as JoinsMessage).total) },
    });
    clients.push(client);
    return client;
  }

  it('onLoad gets { joins } and the counter continues; region blobs restore crates and wanderers instead of reseeding', async () => {
    const store = new MemoryStore();
    const first = recordingHooks();
    const firstLoader = new RecordingLoader();
    const s1 = await serve(store, firstLoader, first.hooks);
    expect(first.inits).toHaveLength(1);
    const totals1: number[] = [];
    const a = driver(s1, 'driver', totals1);
    const joined = await a.connect();
    const world1 = s1.session.world;
    const z0 = world1.get(joined.localEntity, Transform).pos.z;
    // Drive: the vehicle moves along +Z while the wanderers walk away from their start.
    await waitFor(() => world1.get(joined.localEntity, Transform).pos.z > z0 + 4, 'driving 4 m');
    expect(totals1).toEqual([1]);
    expect(firstLoader.seeded).toHaveLength(9); // the spawn cell and its neighbours, all fresh
    a.dispose();
    await s1.close();

    // What the shutdown save wrote: every region active at close, from the stopped world.
    const saved = new Map(
      s1.session.regions.active().map((id) => [id, contentsOf(s1.session.ctx, id)] as const),
    );
    expect([...saved.keys()].sort()).toEqual([...firstLoader.seeded].sort());
    expect((await (await openApplicationSave(store)).list('region')).sort()).toEqual(
      [...saved.keys()].sort(),
    );
    for (const contents of saved.values()) {
      expect(contents.crates).toHaveLength(8);
      expect(contents.wanderers).toHaveLength(1);
      // Walked away from the start, where a reseeded region would put it back.
      expect(contents.wanderers[0]?.pos).not.toEqual({
        x: WANDERER_START,
        y: 0,
        z: WANDERER_START,
      });
    }

    const second = recordingHooks();
    const secondLoader = new RecordingLoader();
    const s2 = await serve(store, secondLoader, second.hooks);
    expect(second.inits).toEqual([]);
    expect(second.loaded).toEqual([{ joins: 1 }]);
    const totals2: number[] = [];
    await driver(s2, 'returning', totals2).connect();
    await waitFor(() => totals2.length > 0, 'the Joins broadcast');
    expect(totals2).toEqual([2]); // continued, not reset

    // Every region came back from its blob: the loader seeded nothing, and at restore time each held
    // exactly what was saved (crates in place, wanderers where they had walked to).
    expect(secondLoader.seeded).toEqual([]);
    expect([...secondLoader.restored.keys()].sort()).toEqual([...saved.keys()].sort());
    for (const [id, contents] of saved) expect(secondLoader.restored.get(id), id).toEqual(contents);
    await s2.close();
    expect(
      JSON.parse(
        new TextDecoder().decode(
          (await (await openApplicationSave(store)).get('session', 'state')) ?? undefined,
        ),
      ),
    ).toEqual({
      joins: 2,
    });
    expect(errors).toEqual([]);
  });
});

describe('server game module', () => {
  it('exports exactly game and a sessionFactory giving each session its own loader and hooks', async () => {
    vi.resetModules();
    const mod = await import('../src/server/game.ts');
    expect(Object.keys(mod).sort()).toEqual(['game', 'sessionFactory']);
    const first = mod.sessionFactory('one');
    const second = mod.sessionFactory('two');
    expect(typeof first.regionLoader.populate).toBe('function');
    expect(typeof first.hooks.onPlayerJoin).toBe('function');
    expect(typeof first.hooks.relevance).toBe('function');
    expect(typeof first.hooks.onSave).toBe('function');
    expect(second.hooks).not.toBe(first.hooks);
    expect(second.regionLoader).not.toBe(first.regionLoader);
  });
});
