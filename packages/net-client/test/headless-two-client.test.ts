import { devVerifier } from '@conduit/auth';
import { Rng } from '@conduit/math';
import {
  type ClientLink,
  type HookContext,
  type PlayerInfo,
  type PlayerSpawn,
  Session,
  type SessionGameDef,
} from '@conduit/net-server';
import { MemoryStore } from '@conduit/persist';
import {
  ByteWriter,
  defineInput,
  type EntityId,
  f,
  type Schema,
  SchemaRegistry,
} from '@conduit/protocol';
import {
  type ComponentType,
  CORE_COMPONENTS,
  defineComponent,
  defineEvent,
  defineSystem,
  Name,
  Owner,
  Region,
  RegionChanged,
  Transform,
} from '@conduit/sim';
import { GridWorld, type RegionLoader } from '@conduit/world';
import { describe, expect, it } from 'vitest';
import {
  type ClientGameDef,
  gcLagTicks,
  type MemoryLink,
  MemoryTransport,
  NetClient,
  type ReplicatedEventInfo,
} from '../src/index.ts';
import { ManualTimers } from './helpers.ts';

const CELL = 64;
const SPAWN_REGION = 'cell/1_1';
/** Outside the wanted regions of `SPAWN_REGION` (4 x 4 grid, wanted depth 1). */
const FAR_REGION = 'cell/3_3';
const Input = defineInput({ tick: f.u32, throttle: f.i8, horn: f.bool });
type Frame = ReturnType<typeof Input.create>;
const Horn = defineEvent('Horn', { entity: f.entity(), pitch: f.u8 });
const Boom = defineEvent('Boom', { entity: f.entity() });

/** Server-side record of every event the systems below emitted. */
const emitted: { name: string; tick: number; entity: EntityId; regionId: string }[] = [];
const hornDown = new Map<EntityId, boolean>();
/** Entities the `demolish` system destroys next tick, emitting `Boom` for each. */
const demolitions: EntityId[] = [];

/** Moves each player's entity along +x at `throttle` m/s while its input says so. */
const drive = defineSystem('drive', 'sim', (ctx) => {
  for (const e of ctx.world.query(Owner, Transform)) {
    const input = ctx.inputs(ctx.world.get(e, Owner).player) as Frame | undefined;
    const throttle = input?.throttle ?? 0;
    if (throttle === 0 && ctx.world.get(e, Transform).vel.x === 0) continue;
    const t = ctx.world.write(e, Transform);
    t.pos.x += throttle * ctx.dt;
    t.vel.x = throttle;
  }
});

/** Emits `Horn` in the region of a player's entity when its horn button goes down. */
const horn = defineSystem('horn', 'input', (ctx) => {
  for (const e of ctx.world.query(Owner, Region)) {
    const input = ctx.inputs(ctx.world.get(e, Owner).player) as Frame | undefined;
    const down = input?.horn === true;
    if (down && hornDown.get(e) !== true) {
      const regionId = ctx.world.get(e, Region).id;
      ctx.events.emit(Horn, { entity: e, pitch: 7 }, regionId);
      emitted.push({ name: 'Horn', tick: ctx.tick, entity: e, regionId });
    }
    hornDown.set(e, down);
  }
});

/** Destroys the queued entities and emits `Boom` naming each, in the same tick. */
const demolish = defineSystem('demolish', 'sim', (ctx) => {
  for (const e of demolitions.splice(0)) {
    const regionId = ctx.world.get(e, Region).id;
    ctx.events.emit(Boom, { entity: e }, regionId);
    ctx.world.destroy(e);
    emitted.push({ name: 'Boom', tick: ctx.tick, entity: e, regionId });
  }
});

const components: ComponentType<unknown>[] = [...CORE_COMPONENTS];
const registry = new SchemaRegistry({
  components,
  messages: [],
  events: [RegionChanged, Horn, Boom],
  input: Input,
});
const game: SessionGameDef & ClientGameDef = {
  id: 'headless',
  protocolVersion: 1,
  tickRate: 60,
  snapshotEvery: 3,
  seed: 1234,
  registry,
  input: Input,
  systems: [drive, horn, demolish],
  components,
  world: (seed) =>
    new GridWorld({ cellSize: CELL, cols: 4, rows: 4, wantedDepth: 1, worldSeed: seed }),
};

/** One crate per activated region, so B's replica holds more than the two players. */
const loader: RegionLoader = {
  populate(region, _blob, ctx) {
    const rng = ctx.regionRng(region.id);
    const e = ctx.world.create();
    ctx.world.add(e, Region, { id: region.id });
    ctx.world.add(e, Transform, {
      pos: { x: 8 + rng.float() * 48, y: 0, z: 8 + rng.float() * 48 },
    });
    ctx.world.add(e, Name, { value: 'crate' });
  },
};

/**
 * Resolves after a macrotask turn, once every queued promise callback has run. The drivers below
 * await it after each frame: the Session's region loads (`store.get`) resolve between frames, as
 * they do under a real event loop, and activate at the next tick's `regions.update`.
 */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function spawnAt(
  player: PlayerInfo,
  regionId = SPAWN_REGION,
  x = 20 + 4 * player.playerId,
): PlayerSpawn {
  return {
    regionId,
    spawn: (ctx: HookContext): EntityId => {
      const e = ctx.world.create();
      ctx.world.add(e, Region, { id: regionId });
      ctx.world.add(e, Transform, { pos: { x, y: 0, z: 32 } });
      ctx.world.add(e, Owner, { player: player.playerId });
      ctx.world.add(e, Name, { value: player.displayName });
      return e;
    },
  };
}

describe('two headless NetClients against one Session over MemoryTransport', () => {
  it('merges masked Session wire deltas into owned vector/scalar/optional/array state', async () => {
    const Mixed = defineComponent('Mixed', {
      position: f.vec3(f.f32),
      velocity: f.vec3(f.f32),
      scalar: f.u16,
      note: f.optional(f.str(16)),
      values: f.array(f.u16, 8),
      label: f.str(16),
    });
    const ownComponents = [...components, Mixed];
    const ownRegistry = new SchemaRegistry({
      components: ownComponents,
      messages: [],
      events: [RegionChanged, Horn, Boom],
      input: Input,
    });
    const ownGame = { ...game, registry: ownRegistry, components: ownComponents, snapshotEvery: 1 };
    const timers = new ManualTimers();
    const errors: unknown[] = [];
    const session = new Session(ownGame, {
      store: new MemoryStore(),
      regionLoader: loader,
      manualLoop: true,
      replication: { bytesPerSecond: 100000, burstBytes: 100000, maxFrameBytes: 2048 },
      hooks: {
        onPlayerJoin: (player) => {
          const base = spawnAt(player);
          return {
            ...base,
            spawn: (ctx) => {
              const entity = base.spawn(ctx);
              ctx.world.add(entity, Mixed, {
                position: { x: 1, y: 2, z: 3 },
                velocity: { x: 8, y: 9, z: 10 },
                scalar: 7,
                note: 'present',
                values: [1, 2],
                label: 'initial',
              });
              return entity;
            },
          };
        },
      },
      verifier: devVerifier({ warn: () => {} }),
      sessionId: 'dev',
      timers,
      now: timers.nowFn,
      log: () => {},
    });
    await session.start();
    const client = new NetClient({
      url: 'memory://dev',
      game: ownGame,
      token: 'dev',
      displayName: 'a',
      transport: MemoryTransport.factory((link) => session.attach(link), { timers }),
      timers,
      now: timers.nowFn,
      log: () => {},
    });
    client.on('error', (error) => errors.push(error));
    const frame = async () => {
      timers.advance(17);
      session.step();
      await settle();
      timers.flush();
    };
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 120 && !done(); i++) await frame();
      expect(done()).toBe(true);
    };
    const connected = client.connect();
    await until(
      () => client.state === 'Playing' && client.mirror.read(client.entity, Mixed) !== undefined,
    );
    await connected;
    const entity = client.entity;
    session.world.mutate(entity, Mixed, (value) => {
      value.position.x = 15;
    });
    await until(() => client.mirror.read(entity, Mixed)?.position.x === 15);
    expect(client.mirror.read(entity, Mixed)).toEqual({
      position: { x: 15, y: 2, z: 3 },
      velocity: { x: 8, y: 9, z: 10 },
      scalar: 7,
      note: 'present',
      values: [1, 2],
      label: 'initial',
    });
    session.world.mutate(entity, Mixed, (value) => {
      value.scalar = 0;
      value.note = undefined;
      value.values = [];
      value.label = '';
    });
    await until(() => client.mirror.read(entity, Mixed)?.scalar === 0);
    expect(client.mirror.read(entity, Mixed)).toEqual({
      position: { x: 15, y: 2, z: 3 },
      velocity: { x: 8, y: 9, z: 10 },
      scalar: 0,
      note: undefined,
      values: [],
      label: '',
    });
    expect(errors).toEqual([]);
    client.disconnect();
    await session.stop();
  });
  it('both play; A drives and B sees it interpolated; B never shows an entity early; A leaving is a destroy on B after the delay', async () => {
    const timers = new ManualTimers();
    const errors: unknown[] = [];
    const serverLogs: { level: string; msg: string }[] = [];
    const session = new Session(game, {
      store: new MemoryStore(),
      regionLoader: loader,
      hooks: { onPlayerJoin: (player) => spawnAt(player) },
      verifier: devVerifier({ warn: () => {} }),
      sessionId: 'dev',
      now: timers.nowFn,
      timers,
      log: (level, msg) => serverLogs.push({ level, msg }),
    });
    await session.start();

    const links: MemoryLink[] = [];
    const transport = MemoryTransport.factory(
      (link) => {
        const asClientLink: ClientLink = link; // MemoryLink implements net-server's ClientLink
        links.push(link);
        session.attach(asClientLink);
      },
      { timers, latencyMs: 10 },
    );
    const client = (displayName: string): NetClient => {
      const c = new NetClient({
        url: 'memory://dev',
        game,
        token: 'dev',
        displayName,
        transport,
        now: timers.nowFn,
        timers,
        log: (level, msg, data) => {
          if (level === 'error' || level === 'warn') errors.push({ displayName, level, msg, data });
        },
      });
      c.on('error', (err) => errors.push({ displayName, err }));
      return c;
    };
    const a = client('A');
    const b = client('B');

    // B's visibility log: the render tick at which each entity first became visible.
    const firstVisible = new Map<EntityId, { renderTick: number; createdTick: number }>();
    const frame = async (): Promise<void> => {
      timers.advance(16);
      a.update();
      b.update();
      const renderTick = b.clock.renderTick();
      for (const ent of b.mirror.visibleAt(renderTick)) {
        expect(ent.createdTick).toBeLessThanOrEqual(renderTick);
        if (!firstVisible.has(ent.id)) {
          firstVisible.set(ent.id, { renderTick, createdTick: ent.createdTick });
        }
      }
      await settle();
    };
    const runUntil = async (done: () => boolean, maxFrames: number): Promise<void> => {
      for (let i = 0; i < maxFrames && !done(); i++) await frame();
      expect(done()).toBe(true);
    };

    // --- Both reach Playing.
    const connected = Promise.all([a.connect(), b.connect()]);
    await runUntil(() => a.state === 'Playing' && b.state === 'Playing', 300);
    await connected;
    expect(a.playerId).not.toBe(b.playerId);
    expect(links).toHaveLength(2);
    expect(
      session
        .players()
        .map((p) => p.displayName)
        .sort(),
    ).toEqual(['A', 'B']);
    const aEntity = a.entity;
    expect(session.world.alive(aEntity)).toBe(true);

    // B's render clock settles and A's entity becomes visible on B, later than it was created.
    await runUntil(
      () => [...b.mirror.visibleAt(b.clock.renderTick())].some((e) => e.id === aEntity),
      120,
    );
    expect(b.mirror.latestTick).toBeGreaterThan(b.clock.renderTick());
    const startX = b.mirror.sample(aEntity, Transform, b.clock.renderTick(), Transform.create())!
      .pos.x;
    expect(startX).toBe(20 + 4 * a.playerId);

    // --- A throttles; B's sampled Transform of A moves forward smoothly, behind the server.
    const forward: Frame = { tick: 0, throttle: 5, horn: false };
    a.sendInput(forward);
    let previousX = startX;
    let maxStep = 0;
    for (let i = 0; i < 75; i++) {
      await frame();
      const x = b.mirror.sample(aEntity, Transform, b.clock.renderTick(), Transform.create())!.pos
        .x;
      expect(x).toBeGreaterThanOrEqual(previousX - 1e-9);
      maxStep = Math.max(maxStep, x - previousX);
      previousX = x;
    }
    const serverX = session.world.get(aEntity, Transform).pos.x;
    expect(previousX - startX).toBeGreaterThan(1);
    expect(serverX).toBeGreaterThan(previousX);
    expect(maxStep).toBeLessThan(0.5);
    expect(a.stats().rttMs).toBeGreaterThanOrEqual(19);

    // --- Quiesce: B's replica equals the server's replicated stores for every entity it holds.
    const idle: Frame = { tick: 0, throttle: 0, horn: false };
    a.sendInput(idle);
    for (let i = 0; i < 30; i++) await frame();
    const interest = new Set(session.graph.wanted(SPAWN_REGION));
    const serverEntities = [...interest]
      .flatMap((r) => [...session.regions.entitiesIn(r)])
      .sort((x, y) => x - y);
    const alive = [...b.mirror.entities()].filter((e) => e.destroyedTick === null);
    expect(alive.map((e) => e.id).sort((x, y) => x - y)).toEqual(serverEntities);
    const encode = (schema: Schema<unknown>, value: unknown): number[] => {
      const w = new ByteWriter();
      schema.encode(w, value);
      return [...w.finish()];
    };
    for (const ent of alive) {
      for (const c of registry.replicated) {
        const id = registry.componentId(c);
        const server = session.world.tryGet(ent.id, c as ComponentType<unknown>);
        const mirror = ent.latest.get(id);
        expect(mirror === undefined, `${ent.id}/${c.name} presence`).toBe(server === undefined);
        if (server !== undefined) {
          expect(encode(c.schema, mirror), `${ent.id}/${c.name}`).toEqual(encode(c.schema, server));
        }
      }
    }

    // --- A leaves: B applies the destroy while its render tick is still behind it, keeps showing
    // A's entity until the render tick reaches the destroy tick, then gc drops it after the lag.
    a.disconnect();
    expect(a.state).toBe('Disconnected');
    await runUntil(() => b.mirror.get(aEntity)?.destroyedTick != null, 60);
    const destroyedTick = b.mirror.get(aEntity)!.destroyedTick!;
    expect(session.world.alive(aEntity)).toBe(false);
    expect(b.clock.renderTick()).toBeLessThan(destroyedTick);
    let sawVisibleAfterDestroyArrived = false;
    await runUntil(() => {
      const visible = [...b.mirror.visibleAt(b.clock.renderTick())].some((e) => e.id === aEntity);
      if (visible) sawVisibleAfterDestroyArrived = true;
      return !visible;
    }, 60);
    expect(sawVisibleAfterDestroyArrived).toBe(true);
    expect(b.clock.renderTick()).toBeGreaterThanOrEqual(destroyedTick);
    await runUntil(() => !b.mirror.has(aEntity), 60);
    expect(Math.floor(b.clock.renderTick()) - gcLagTicks(game.snapshotEvery)).toBeGreaterThan(
      destroyedTick,
    );
    expect(session.players().map((p) => p.displayName)).toEqual(['B']);
    expect(b.players.map((p) => p.name)).toEqual(['B']);

    // --- No entity became visible on B before the snapshot that created it.
    for (const [id, seen] of firstVisible) {
      expect(seen.renderTick, `entity ${id}`).toBeGreaterThanOrEqual(seen.createdTick);
    }
    expect(firstVisible.size).toBeGreaterThanOrEqual(interest.size + 2);

    await session.stop();
    timers.advance(100);
    // Kicked{ServerShutdown} + 1001 is reconnectable (docs/net.md A.3): B waits to retry.
    expect(b.state).toBe('Reconnecting');
    b.disconnect();
    expect(b.state).toBe('Disconnected');
    expect(errors).toEqual([]);
    expect(serverLogs.filter((l) => l.level === 'error')).toEqual([]);
    // Clients' input ticks lead the server: no input ever arrived for a tick that had already run.
    expect(session.stats.staleInputs).toBe(0);
    expect(session.stats.badInput).toBe(0);
  });
  it('drives soon after a stalled first Pong (inflated RTT must not lock input frames beyond the server queue)', async () => {
    // Regression: a browser client handles its first Pong while it builds the WebGL renderer, so the
    // first RTT sample is ~300 ms. Its snapshot offsets then over-estimated the server tick by ~9
    // ticks and inputLead was ~10: frames were stamped ~19 ticks ahead, the never-regress rule held
    // that lead, and the server's input queue (INPUT_QUEUE_MAX 6) dropped every frame before its
    // tick. Modelled by handing the first Pong to the clock 294 ms late.
    const timers = new ManualTimers();
    const session = new Session(game, {
      store: new MemoryStore(),
      regionLoader: loader,
      hooks: { onPlayerJoin: (player) => spawnAt(player) },
      verifier: devVerifier({ warn: () => {} }),
      sessionId: 'dev',
      now: timers.nowFn,
      timers,
      log: () => {},
    });
    await session.start();
    const transport = MemoryTransport.factory((link) => session.attach(link), {
      timers,
      latencyMs: 1,
    });
    const a = new NetClient({
      url: 'memory://dev',
      game,
      token: 'dev',
      displayName: 'A',
      transport,
      now: timers.nowFn,
      timers,
      log: () => {},
    });
    const clock = a.clock;
    const onPong = clock.onPong.bind(clock);
    let pongs = 0;
    clock.onPong = (clientTimeMs, serverTimeMs, serverTick, recvMs) =>
      onPong(clientTimeMs, serverTimeMs, serverTick, recvMs + (pongs++ === 0 ? 294 : 0));
    const frames = async (n: number): Promise<void> => {
      for (let i = 0; i < n; i++) {
        timers.advance(16);
        a.update();
        await settle();
      }
    };

    const connected = a.connect();
    for (let i = 0; i < 300 && a.state !== 'Playing'; i++) await frames(1);
    await connected;
    expect(a.state).toBe('Playing');
    await frames(90); // 1.4 s: past the first Pong's eviction from the offset window and the second Pong
    expect(pongs).toBeGreaterThanOrEqual(2);
    expect(clock.rttMs).toBeLessThan(10);

    const entity = a.entity;
    const startX = session.world.get(entity, Transform).pos.x;
    a.sendInput({ tick: 0, throttle: 5 } as Frame);
    await frames(60); // 1 s
    expect(session.world.get(entity, Transform).pos.x).toBeGreaterThan(startX + 2);
    expect(session.stats.inputOverflow).toBeLessThan(40);

    a.disconnect();
    await session.stop();
  });

  it("replicated events: B gets A's horn once, on the frame its render tick reaches the event tick; a client whose interest excludes the region gets none", async () => {
    emitted.length = 0;
    hornDown.clear();
    demolitions.length = 0;
    const timers = new ManualTimers();
    const errors: unknown[] = [];
    const session = new Session(game, {
      store: new MemoryStore(),
      regionLoader: loader,
      hooks: {
        onPlayerJoin: (player) =>
          spawnAt(player, player.displayName === 'C' ? FAR_REGION : SPAWN_REGION),
      },
      verifier: devVerifier({ warn: () => {} }),
      sessionId: 'dev',
      now: timers.nowFn,
      timers,
      log: (level, msg, data) => {
        if (level !== 'info') errors.push({ level, msg, data });
      },
    });
    await session.start();
    expect(session.interest.wantedForRegion(FAR_REGION)).not.toContain(SPAWN_REGION);
    const transport = MemoryTransport.factory((link) => session.attach(link), {
      timers,
      latencyMs: 10,
    });

    interface Seen {
      ev: ReplicatedEventInfo;
      /** Render tick when emitted, and before this frame's `update()`. */
      renderTick: number;
      previous: number;
      /** Whether the event's entity was in the mirror when the listener ran. */
      entityInMirror: boolean;
    }
    const clients: NetClient[] = [];
    const seen = new Map<NetClient, Seen[]>();
    const previous = new Map<NetClient, number>();
    const client = (displayName: string): NetClient => {
      const c = new NetClient({
        url: 'memory://dev',
        game,
        token: 'dev',
        displayName,
        transport,
        now: timers.nowFn,
        timers,
        log: (level, msg, data) => {
          if (level === 'error' || level === 'warn') errors.push({ displayName, level, msg, data });
        },
      });
      const log: Seen[] = [];
      c.on('event', (ev) => {
        const entity = (ev.payload as { entity: EntityId }).entity;
        log.push({
          ev,
          renderTick: c.clock.renderTick(),
          previous: previous.get(c) ?? 0,
          entityInMirror: c.mirror.has(entity),
        });
      });
      c.on('error', (err) => errors.push({ displayName, err }));
      clients.push(c);
      seen.set(c, log);
      return c;
    };
    const a = client('A');
    const b = client('B');
    const c = client('C');
    const frame = async (): Promise<void> => {
      timers.advance(16);
      for (const each of clients) {
        previous.set(each, each.clock.renderTick());
        each.update();
      }
      await settle();
    };
    const runUntil = async (done: () => boolean, maxFrames: number): Promise<void> => {
      for (let i = 0; i < maxFrames && !done(); i++) await frame();
      expect(done()).toBe(true);
    };
    const press = (who: NetClient, down: boolean): void => {
      const input: Frame = { tick: 0, throttle: 0, horn: down };
      who.sendInput(input);
    };

    const connected = Promise.all(clients.map((each) => each.connect()));
    await runUntil(() => clients.every((each) => each.state === 'Playing'), 300);
    await connected;
    const aEntity = a.entity;
    await runUntil(
      () => [...b.mirror.visibleAt(b.clock.renderTick())].some((e) => e.id === aEntity),
      120,
    );
    for (let i = 0; i < 30; i++) await frame();
    const logA = seen.get(a) as Seen[];
    const logB = seen.get(b) as Seen[];
    const logC = seen.get(c) as Seen[];

    // --- A honks in its region.
    press(a, true);
    await runUntil(() => emitted.length === 1, 60);
    press(a, false);
    for (let i = 0; i < 60; i++) await frame(); // 1 s: well past the interpolation delay
    const honk = emitted[0] as (typeof emitted)[number];
    expect(honk).toEqual({
      name: 'Horn',
      tick: honk.tick,
      entity: aEntity,
      regionId: SPAWN_REGION,
    });
    const expected: ReplicatedEventInfo = {
      def: Horn,
      tick: honk.tick,
      regionId: SPAWN_REGION,
      payload: { entity: aEntity, pitch: 7 },
    };
    for (const log of [logB, logA]) {
      expect(log.map((x) => x.ev)).toMatchObject([expected]); // once, with the right payload
      const [only] = log;
      expect(only?.ev.def).toBe(Horn);
      expect(only?.renderTick).toBeGreaterThanOrEqual(honk.tick); // at render time...
      expect(only?.previous).toBeLessThan(honk.tick); // ...on the first frame that reached it
    }
    expect(logC).toEqual([]); // SPAWN_REGION is outside C's interest

    // --- C honks in its own region: C hears it, A and B do not.
    press(c, true);
    await runUntil(() => emitted.length === 2, 60);
    press(c, false);
    for (let i = 0; i < 60; i++) await frame();
    const farHonk = emitted[1] as (typeof emitted)[number];
    expect(farHonk).toMatchObject({ name: 'Horn', entity: c.entity, regionId: FAR_REGION });
    expect(logC.map((x) => x.ev)).toMatchObject([
      {
        def: Horn,
        tick: farHonk.tick,
        regionId: FAR_REGION,
        payload: { entity: c.entity, pitch: 7 },
      },
    ]);
    expect(logA).toHaveLength(1);
    expect(logB).toHaveLength(1);

    // --- An event naming an entity destroyed in the same tick (docs/net.md B.1 GC_LAG_TICKS): B's
    // mirror still holds the entity when the event is emitted and after that frame's update (gc
    // included), so a RenderWorld handler in the same frame can read it; gc drops it later.
    const crate = session.regions
      .entitiesIn(SPAWN_REGION)
      .find((e) => session.world.tryGet(e, Name)?.value === 'crate') as EntityId;
    expect(b.mirror.has(crate)).toBe(true);
    demolitions.push(crate);
    await runUntil(() => logB.length === 2, 120);
    const boom = emitted[2] as (typeof emitted)[number];
    expect(boom).toEqual({ name: 'Boom', tick: boom.tick, entity: crate, regionId: SPAWN_REGION });
    const heard = logB[1] as Seen;
    expect(heard.ev).toMatchObject({
      def: Boom,
      tick: boom.tick,
      regionId: SPAWN_REGION,
      payload: { entity: crate },
    });
    expect(heard.previous).toBeLessThan(boom.tick);
    expect(heard.entityInMirror).toBe(true);
    expect(b.mirror.has(crate)).toBe(true); // after the whole update, gc included
    const destroyedTick = b.mirror.get(crate)?.destroyedTick as number;
    expect(destroyedTick).toBeGreaterThanOrEqual(boom.tick);
    await runUntil(() => !b.mirror.has(crate), 60);
    expect(Math.floor(b.clock.renderTick()) - gcLagTicks(game.snapshotEvery)).toBeGreaterThan(
      destroyedTick,
    );
    expect(logC).toHaveLength(1);
    expect(logA.map((x) => x.ev.def.name)).toEqual(['Horn', 'Boom']);

    for (const each of clients) each.disconnect();
    await session.stop();
    expect(errors).toEqual([]);
    expect(session.stats.eventsDropped).toBe(0);
  });

  it('Spike 3: under 10 + U(0, 30) ms delays and a 1 s stall of B without update(), B never sees A jump more than 0.5 m between frames after the stall', async () => {
    const SPEED = 12; // m/s along +x, from x = 2: stays inside the 64 m cell for the whole run
    const FRAME_MS = 16;
    const rng = new Rng(0x5b1e3);
    const timers = new ManualTimers();
    const session = new Session(game, {
      store: new MemoryStore(),
      regionLoader: loader,
      hooks: { onPlayerJoin: (player) => spawnAt(player, SPAWN_REGION, 2 + 4 * player.playerId) },
      verifier: devVerifier({ warn: () => {} }),
      sessionId: 'dev',
      now: timers.nowFn,
      timers,
      log: () => {},
    });
    await session.start();
    const transport = MemoryTransport.factory((link) => session.attach(link), {
      timers,
      latencyMs: () => 10 + rng.float() * 30, // each message and close, both directions
    });
    const client = (displayName: string): NetClient =>
      new NetClient({
        url: 'memory://dev',
        game,
        token: 'dev',
        displayName,
        transport,
        now: timers.nowFn,
        timers,
        log: () => {},
      });
    const a = client('A');
    const b = client('B');
    const frame = async (updateB = true): Promise<void> => {
      timers.advance(FRAME_MS);
      a.update();
      if (updateB) b.update();
      await settle();
    };

    const connected = Promise.all([a.connect(), b.connect()]);
    for (let i = 0; i < 300 && (a.state !== 'Playing' || b.state !== 'Playing'); i++) {
      await frame();
    }
    await connected;
    expect([a.state, b.state]).toEqual(['Playing', 'Playing']);
    const aEntity = a.entity;
    for (let i = 0; i < 120; i++) await frame(); // 2 s: clock window, jitter and RTT settle
    const out = Transform.create();
    const sampleX = (): number => {
      const t = b.mirror.sample(aEntity, Transform, b.clock.renderTick(), out);
      if (t === undefined) throw new Error("A's Transform is not in B's mirror");
      return t.pos.x;
    };
    const startX = sampleX();

    const driving: Frame = { tick: 0, throttle: SPEED, horn: false };
    a.sendInput(driving);
    let x = sampleX();
    for (let i = 0; i < 60; i++) {
      await frame();
      x = sampleX();
    }
    const snapsBefore = b.clock.snaps;
    // B's tab in the background: no update() for 1 s, while the server and A carry on.
    for (let i = 0; i < Math.round(1000 / FRAME_MS); i++) await frame(false);
    await frame();
    const afterStall = sampleX();
    const stallJump = afterStall - x;
    x = afterStall;
    let maxJump = 0;
    let minStep = Infinity;
    const post = 120;
    for (let i = 0; i < post; i++) {
      await frame();
      const next = sampleX();
      maxJump = Math.max(maxJump, Math.abs(next - x));
      minStep = Math.min(minStep, next - x);
      x = next;
    }
    const serverX = session.world.get(aEntity, Transform).pos.x;
    const perFrame = (SPEED * FRAME_MS) / 1000;
    console.log(
      [
        `Spike 3: B samples A driving ${SPEED} m/s (${perFrame.toFixed(3)} m per ${FRAME_MS} ms frame), delays 10 + U(0, 30) ms, 1 s stall of B`,
        `  max frame-to-frame jump over ${post} frames after the stall: ${maxJump.toFixed(3)} m (smallest step ${minStep.toFixed(3)} m)`,
        `  jump across the stall: ${stallJump.toFixed(2)} m; render-clock snaps after the stall: ${b.clock.snaps - snapsBefore}`,
        `  B: rtt ${b.clock.rttMs.toFixed(1)} ms, jitter ${b.clock.jitterMs.toFixed(1)} ms, interpolation delay ${b.clock.interpDelayTicks} ticks`,
      ].join('\n'),
    );
    expect(x - startX).toBeGreaterThan(20);
    expect(serverX).toBeLessThan(CELL); // no migration to the next cell mid-run
    expect(b.clock.snaps).toBe(snapsBefore);
    expect(maxJump).toBeLessThanOrEqual(0.5); // the spike's pass criterion
    // Constant velocity extrapolates exactly, so lateness barely shows in the maximum alone: also keep
    // every step within 25 % of the nominal motion (measured -6 % .. +2 %; a render clock running
    // ahead of the snapshots, interpolation delay 0.25 intervals, gives about +-50 %).
    expect(maxJump).toBeLessThanOrEqual(perFrame * 1.25);
    expect(minStep).toBeGreaterThanOrEqual(perFrame * 0.75);

    a.disconnect();
    b.disconnect();
    await session.stop();
  });

  it('a server held up 300 ms drops the ticks it missed: B sees A stop and go on, never running ahead or back in time, and A steers as promptly after', async () => {
    const SPEED = 12; // m/s along +x
    const FRAME_MS = 16;
    const timers = new ManualTimers();
    // The Session's timers: one due while the server is held up -- a long GC, a process swapped
    // out -- fires when it is let go, and its loop wakes that late.
    let heldUntil = 0;
    const serverTimers = {
      setTimeout: (fn: () => void, ms: number): unknown =>
        timers.setTimeout(function due() {
          if (timers.now < heldUntil) timers.setTimeout(due, heldUntil - timers.now);
          else fn();
        }, ms),
      clearTimeout: (handle: unknown): void => timers.clearTimeout(handle),
    };
    const session = new Session(game, {
      store: new MemoryStore(),
      regionLoader: loader,
      hooks: { onPlayerJoin: (player) => spawnAt(player, SPAWN_REGION, 2 + 4 * player.playerId) },
      verifier: devVerifier({ warn: () => {} }),
      sessionId: 'dev',
      now: timers.nowFn,
      timers: serverTimers,
      log: () => {},
    });
    await session.start();
    const transport = MemoryTransport.factory((link) => session.attach(link), {
      timers,
      latencyMs: 20,
    });
    const client = (displayName: string): NetClient =>
      new NetClient({
        url: 'memory://dev',
        game,
        token: 'dev',
        displayName,
        transport,
        now: timers.nowFn,
        timers,
        log: () => {},
      });
    const a = client('A');
    const b = client('B');
    const frame = async (): Promise<void> => {
      timers.advance(FRAME_MS);
      a.update();
      b.update();
      await settle();
    };
    const connected = Promise.all([a.connect(), b.connect()]);
    for (let i = 0; i < 300 && (a.state !== 'Playing' || b.state !== 'Playing'); i++) {
      await frame();
    }
    await connected;
    for (let i = 0; i < 120; i++) await frame(); // 2 s: clock window, jitter and RTT settle
    const aEntity = a.entity;
    const out = Transform.create();
    const sampleX = (): number => {
      const t = b.mirror.sample(aEntity, Transform, b.clock.renderTick(), out);
      if (t === undefined) throw new Error("A's Transform is not in B's mirror");
      return t.pos.x;
    };
    /** Frames until A's new throttle moves A on the server. */
    const steer = async (throttle: number): Promise<number> => {
      const input: Frame = { tick: 0, throttle, horn: false };
      a.sendInput(input);
      for (let i = 1; i <= 60; i++) {
        await frame();
        if (session.world.get(aEntity, Transform).vel.x === throttle) return i;
      }
      return Infinity;
    };
    const before = await steer(SPEED);
    for (let i = 0; i < 60; i++) await frame();
    const epoch = b.clock.tickEpochMs;
    const snaps = b.clock.snaps;
    const dropped = session.tickStats().dropped;

    heldUntil = timers.now + 300;
    let x = sampleX();
    let tick = b.clock.renderTick();
    let maxStep = -Infinity;
    let minStep = Infinity;
    let minAdvance = Infinity;
    for (let i = 0; i < 90; i++) {
      // Through the 300 ms and the 1.1 s after: past B's clock window of samples (16 snapshots).
      await frame();
      const nextX = sampleX();
      const nextTick = b.clock.renderTick();
      maxStep = Math.max(maxStep, nextX - x);
      minStep = Math.min(minStep, nextX - x);
      minAdvance = Math.min(minAdvance, nextTick - tick);
      x = nextX;
      tick = nextTick;
    }
    const tickMs = 1000 / game.tickRate;
    const perFrame = (SPEED * FRAME_MS) / 1000;
    expect(session.tickStats().dropped - dropped).toBeGreaterThanOrEqual(10);
    // The server numbered on past the ticks it dropped, so they stay where B's clock puts them:
    // nothing for B to correct, its render clock never turned back.
    expect(Math.abs(b.clock.tickEpochMs - epoch)).toBeLessThanOrEqual(tickMs);
    expect(b.clock.snaps).toBe(snaps);
    expect(minAdvance).toBeGreaterThan(0);
    // A never moved faster than it drives, and back no farther than B had drawn it on past the
    // last snapshot before the stall (one snapshot interval of extrapolation).
    expect(maxStep).toBeLessThanOrEqual(perFrame * 1.25);
    expect(minStep).toBeGreaterThanOrEqual((-SPEED * game.snapshotEvery * tickMs) / 1000);
    // A's inputs still reach the ticks they are meant for: steering as prompt as before.
    expect(await steer(SPEED / 2)).toBeLessThanOrEqual(before + 1);

    a.disconnect();
    b.disconnect();
    await session.stop();
  });
});
