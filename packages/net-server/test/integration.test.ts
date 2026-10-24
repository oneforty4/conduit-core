// @conduit/net-client is isomorphic and its sources name DOM event types; type-checking them
// from this Node package needs the DOM lib.
/// <reference lib="dom" />
import type { AddressInfo } from 'node:net';
import { devVerifier } from '@conduit/auth';
import { fnv1a32, fnv1a32u32, FNV_BASIS } from '@conduit/math';
import { NetClient } from '@conduit/net-client';
import { MemoryStore } from '@conduit/persist';
import {
  ByteWriter,
  defineInput,
  ENTITY_NONE,
  type EntityId,
  f,
  SchemaRegistry,
} from '@conduit/protocol';
import {
  CORE_COMPONENTS,
  defineComponent,
  defineSystem,
  Model,
  Name,
  Owner,
  Region,
  RegionChanged,
  Transform,
} from '@conduit/sim';
import { GridWorld, type RegionLoader } from '@conduit/world';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WebSocket, WebSocketServer } from 'ws';
import {
  type PlayerInfo,
  type PlayerSpawn,
  Session,
  type SessionGameDef,
  type SessionHooks,
} from '../src/session.ts';
import { createWsServer, WsLink } from '../src/ws-link.ts';

// A minimal game: vehicles driven by input, and 300 crates in the spawn region, any number of which
// drift every tick (Spike 1: bandwidth per client with 300 crates in view at snapshotEvery 3).

const Input = defineInput({ tick: f.u32, throttle: f.i8 });
type Frame = ReturnType<typeof Input.create>;
const Vehicle = defineComponent('Vehicle', { throttle: f.i8 }, { replicate: true });
const Crate = defineComponent('Crate', {}, { replicate: true });
const Drift = defineComponent(
  'Drift',
  { index: f.u16, baseX: f.f32, baseZ: f.f32 },
  { replicate: false },
);

const CRATES = 300;
const SPAWN = 'cell/1_1';
const TICK_RATE = 60;
/** How many crates drift (a test knob, not sim state). */
const motion = { moving: 0 };

const vehicleInput = defineSystem('vehicleInput', 'input', (ctx) => {
  for (const e of ctx.world.query(Owner, Vehicle)) {
    const frame = ctx.inputs(ctx.world.get(e, Owner).player) as Frame | undefined;
    const throttle = frame?.throttle ?? 0;
    if (ctx.world.get(e, Vehicle).throttle !== throttle) {
      ctx.world.write(e, Vehicle).throttle = throttle;
    }
  }
});

const vehicleMove = defineSystem('vehicleMove', 'sim', (ctx) => {
  for (const e of ctx.world.query(Vehicle, Transform)) {
    const throttle = ctx.world.get(e, Vehicle).throttle;
    if (throttle !== 0) ctx.world.write(e, Transform).pos.x += (throttle / 127) * 20 * ctx.dt;
  }
});

const crateDrift = defineSystem('crateDrift', 'sim', (ctx) => {
  for (const e of ctx.world.query(Drift, Transform)) {
    const d = ctx.world.get(e, Drift);
    if (d.index >= motion.moving) continue;
    const pos = ctx.world.write(e, Transform).pos;
    pos.x = d.baseX + Math.sin(ctx.tick * 0.05 + d.index) * 8;
    pos.z = d.baseZ + Math.cos(ctx.tick * 0.05 + d.index) * 8;
  }
});

const components = [...CORE_COMPONENTS, Vehicle, Crate, Drift];
const registry = new SchemaRegistry({
  components,
  messages: [],
  events: [RegionChanged],
  input: Input,
});
const game: SessionGameDef = {
  id: 'integration',
  protocolVersion: 1,
  tickRate: TICK_RATE,
  snapshotEvery: 3,
  seed: 7,
  registry,
  input: Input,
  systems: [vehicleInput, crateDrift, vehicleMove],
  components,
  world: (seed) =>
    new GridWorld({ cellSize: 256, cols: 3, rows: 3, wantedDepth: 1, worldSeed: seed }),
};

const loader: RegionLoader = {
  populate(region, _blob, ctx) {
    if (region.id !== SPAWN) return;
    for (let i = 0; i < CRATES; i++) {
      const baseX = 16 + (i % 20) * 11;
      const baseZ = 16 + Math.floor(i / 20) * 14;
      const e = ctx.world.create();
      ctx.world.add(e, Region, { id: region.id });
      ctx.world.add(e, Transform, { pos: { x: baseX, y: 0, z: baseZ } });
      ctx.world.add(e, Model, { asset: 'crate', variant: 0 });
      ctx.world.add(e, Crate, {});
      ctx.world.add(e, Drift, { index: i, baseX, baseZ });
    }
  },
};

const hooks: SessionHooks = {
  onPlayerJoin(player: PlayerInfo): PlayerSpawn {
    return {
      regionId: SPAWN,
      spawn(ctx) {
        const e = ctx.world.create();
        ctx.world.add(e, Region, { id: SPAWN });
        ctx.world.add(e, Transform, { pos: { x: 100 + 10 * player.playerId, y: 0, z: 100 } });
        ctx.world.add(e, Model, { asset: 'vehicle', variant: 0 });
        ctx.world.add(e, Owner, { player: player.playerId });
        ctx.world.add(e, Name, { value: player.displayName });
        ctx.world.add(e, Vehicle, { throttle: 0 });
        return e;
      },
    };
  },
};

/** Counts what the Session sends on a link (application frames, no WebSocket framing). */
class CountingLink extends WsLink {
  bytes = 0;
  frames = 0;
  largest = 0;

  override send(buf: Uint8Array): void {
    this.bytes += buf.byteLength;
    this.frames++;
    this.largest = Math.max(this.largest, buf.byteLength);
    super.send(buf);
  }
}

function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
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

const writer = new ByteWriter(256);

function mix(h: number, e: EntityId, compId: number, value: unknown): number {
  const def = registry.component(compId);
  if (def === undefined) throw new Error(`no component ${compId}`);
  writer.reset();
  def.schema.encode(writer, value);
  return fnv1a32(writer.view(), fnv1a32u32(fnv1a32u32(h, e), compId));
}

/** The server's replicated stores for the entities of `regions`, as the wire quantizes them. */
function serverHash(
  session: Session,
  regions: readonly string[],
): { hash: number; entities: number } {
  const ids = regions.flatMap((r) => [...session.regions.entitiesIn(r)]).sort((x, y) => x - y);
  let h = FNV_BASIS;
  for (const e of ids) {
    for (const def of registry.replicated) {
      const id = registry.componentId(def);
      const store = session.world.stores()[id];
      if (store?.has(e) === true) h = mix(h, e, id, store.read(e));
    }
  }
  return { hash: h, entities: ids.length };
}

/** A client's mirror: latest value of every component of every live replica entity. */
function mirrorHash(client: NetClient): { hash: number; entities: number } {
  const live = [...client.mirror.entities()]
    .filter((ent) => ent.destroyedTick === null)
    .sort((x, y) => x.id - y.id);
  let h = FNV_BASIS;
  for (const ent of live) {
    const ids = [...ent.latest.keys()].sort((x, y) => x - y);
    for (const id of ids) h = mix(h, ent.id, id, ent.latest.get(id));
  }
  return { hash: h, entities: live.length };
}

describe('two NetClients against a Session over WsLink with a real FixedLoop', () => {
  let wss: WebSocketServer;
  let session: Session;
  let url: string;
  const links: CountingLink[] = [];
  const clientErrors: string[] = [];
  const serverErrors: string[] = [];
  let a: NetClient;
  let b: NetClient;

  function client(name: string): NetClient {
    return new NetClient({
      url,
      game,
      token: 'dev',
      displayName: name,
      log: (level, msg) => {
        if (level === 'error') clientErrors.push(`${name}: ${msg}`);
      },
    });
  }

  async function waitTicks(n: number): Promise<void> {
    const target = session.tick + n;
    await waitFor(() => session.tick >= target, `tick ${target}`, 10_000 + n * 50);
  }

  beforeAll(async () => {
    session = new Session(game, {
      store: new MemoryStore(),
      regionLoader: loader,
      hooks,
      verifier: devVerifier({ warn: () => {} }),
      sessionId: 'dev',
      log: (level, msg, data) => {
        if (level === 'error') serverErrors.push(`${msg} ${String(data)}`);
      },
    });
    await session.start();
    wss = createWsServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
    let nextId = 1;
    wss.on('connection', (socket: WebSocket) => {
      const link = new CountingLink(socket, nextId++, { log: () => {} });
      links.push(link);
      session.attach(link);
    });
  });

  afterAll(async () => {
    a?.disconnect();
    b?.disconnect();
    await session.stop();
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  it('both clients reach Playing', { timeout: 20_000 }, async () => {
    a = client('A');
    await a.connect();
    b = client('B');
    await b.connect();
    await waitFor(() => a.state === 'Playing' && b.state === 'Playing', 'both Playing');
    expect(a.entity).not.toBe(ENTITY_NONE);
    expect(b.entity).not.toBe(ENTITY_NONE);
    expect(links).toHaveLength(2);
    await waitFor(() => b.players.length === 2 && a.players.length === 2, 'SessionState of 2');
    expect(session.players().map((p) => p.displayName)).toEqual(['A', 'B']);
  });

  it(
    "A's input moves A's entity as seen by B within 10 snapshots",
    { timeout: 20_000 },
    async () => {
      const entity = a.entity;
      await waitFor(() => b.mirror.read(entity, Transform) !== undefined, "A's entity on B");
      const startX = (b.mirror.read(entity, Transform) as { pos: { x: number } }).pos.x;
      let snapshots = 0;
      const off = b.on('snapshot', () => snapshots++);
      a.sendInput({ tick: 0, throttle: 127 } as Frame);
      await waitFor(
        () => (b.mirror.read(entity, Transform)?.pos.x ?? startX) > startX + 0.05,
        "A's movement on B",
      );
      off();
      a.sendInput({ tick: 0, throttle: 0 } as Frame);
      expect(snapshots).toBeLessThanOrEqual(10);
      expect(b.mirror.read(entity, Vehicle)?.throttle).toBe(127);
    },
  );

  it(
    "B's mirror equals the server's replicated stores after quiescing",
    { timeout: 20_000 },
    async () => {
      motion.moving = 0;
      a.sendInput({ tick: 0, throttle: 0 } as Frame);
      await waitTicks(30);
      const quiet = session.tick;
      await waitFor(() => b.stats().lastSnapshotTick >= quiet + 6, 'snapshots after quiescing');
      const wanted = session.interest.wantedForRegion(SPAWN);
      const server = serverHash(session, wanted);
      const mirror = mirrorHash(b);
      expect(server.entities).toBe(CRATES + 2);
      expect(mirror).toEqual(server);
      expect(mirrorHash(a)).toEqual(server);
    },
  );

  it(
    'Spike 1: bytes per client per second with 300 crates in view',
    { timeout: 30_000 },
    async () => {
      const window = 180; // ticks: 3 s of game time
      async function measure(moving: number) {
        motion.moving = moving;
        await waitTicks(12);
        const t0 = session.tick;
        const start = links.map((l) => l.bytes);
        const up0 = [a.stats().bytesOut, b.stats().bytesOut];
        const wall0 = performance.now();
        await waitTicks(window);
        const ticks = session.tick - t0;
        const seconds = ticks / TICK_RATE;
        const wallSeconds = (performance.now() - wall0) / 1000;
        const down = links.map((l, i) => (l.bytes - (start[i] as number)) / seconds / 1000);
        const up = [
          a.stats().bytesOut - (up0[0] as number),
          b.stats().bytesOut - (up0[1] as number),
        ];
        return {
          moving,
          downKBps: down,
          wallKBps: links.map((l, i) => (l.bytes - (start[i] as number)) / wallSeconds / 1000),
          upKBps: up.map((bytes) => bytes / wallSeconds / 1000),
        };
      }
      const typical = await measure(8);
      const worst = await measure(CRATES);
      motion.moving = 0;
      const fmt = (xs: number[]) => xs.map((x) => x.toFixed(1)).join(' / ');
      const line = (label: string, m: typeof typical) =>
        `  ${label} (${m.moving} of ${CRATES} crates moving): server->client ${fmt(m.downKBps)} KB/s ` +
        `per game second (A / B), ${fmt(m.wallKBps)} KB/s wall clock; client->server ${fmt(m.upKBps)} KB/s`;
      console.log(
        [
          `Spike 1: bandwidth per client, snapshotEvery ${game.snapshotEvery} at ${TICK_RATE} Hz, ${CRATES} crates in view`,
          line('typical', typical),
          line('worst  ', worst),
          `  largest frame: ${Math.max(...links.map((l) => l.largest))} bytes (the FULL snapshot on join)`,
        ].join('\n'),
      );
      for (const kbps of typical.downKBps) expect(kbps).toBeLessThan(60);
      // (240 since `Transform.vel` is f32: 35 bytes per moved crate. As fixed16(0.01) it was
      // 29, and the limit 200.)
      for (const kbps of worst.downKBps) expect(kbps).toBeLessThan(240);
    },
  );

  it('disconnect of A despawns A on B', { timeout: 20_000 }, async () => {
    const entity = a.entity;
    expect(b.mirror.has(entity)).toBe(true);
    a.disconnect();
    await waitFor(() => {
      const ent = b.mirror.get(entity);
      return ent === undefined || ent.destroyedTick !== null;
    }, "A's destroy on B");
    expect(session.world.alive(entity)).toBe(false);
    await waitFor(() => b.players.length === 1, 'SessionState of 1');
    expect(b.players.map((p) => p.name)).toEqual(['B']);
    expect(b.state).toBe('Playing');
    expect(clientErrors).toEqual([]);
    expect(serverErrors).toEqual([]);
  });
});
