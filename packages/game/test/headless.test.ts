import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BroadcastChannel } from 'node:worker_threads';
import { DEV_AUTH_WARNING } from '@conduit/auth';
import { LobbyClient } from '@conduit/lobby-client';
import { FNV_BASIS, fnv1a32, fnv1a32u32, type Vec3 } from '@conduit/math';
import { type PredictionStats, ReplicaWorld, type ReplicatedEventInfo } from '@conduit/net-client';
import { openNodeSqlite } from '@conduit/persist';
import { ByteWriter, encodeWith, REGION_IDX_NONE, type SnapshotData } from '@conduit/protocol';
import { type EntityId, slotOf } from '@conduit/sim';
import { type RegionId, stringCompare } from '@conduit/world';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Crate, Vehicle } from '../../../examples/sandbox/src/shared/components.ts';
import {
  COLOURS,
  CRATES_PER_REGION,
  SPAWN_REGION,
} from '../../../examples/sandbox/src/shared/constants.ts';
import { Horn } from '../../../examples/sandbox/src/shared/events.ts';
import { BUTTON_HORN, type SandboxInput } from '../../../examples/sandbox/src/shared/input.ts';
import { Chat } from '../../../examples/sandbox/src/shared/messages.ts';
import {
  createClient,
  type CreateClientOpts,
  type FrameContext,
  type GameClient,
} from '../src/client.ts';
import { createHost } from '../src/host.ts';
import { Name, Region, Transform } from '../src/index.ts';
import { createServer } from '../src/server.ts';
import {
  CRATES_IN_VIEW,
  CrowdedLoader,
  FAR_REGION,
  game,
  hooksWithDistantC,
  PROBE_CHANNEL,
  type ProbeMessage,
  type ProbeRequest,
  reportingTail,
  type ServerReport,
} from './fixtures/headless-game.ts';

// The CONCEPT.md integration row (docs/game.md 6, PLAN.md M1-M5) on the sandbox game, run through
// an in-process createServer, and through createHost (session worker, SQLite scratch file) with
// every player joining via the lobby (@conduit/lobby-client: register, login, createSession, join).
// Headless createClients A and B play next to each other (the replicated Horn event and Chat
// message included), C far away. The createServer run happens twice (M6): with the default
// options, and with every client's prediction stub on (docs/net.md B.10), which must change nothing.

const GRAPH = game.world(game.seed);
/** The regions a client in `id` plays in (`RegionSet.active`) and prefetches (the ring around them). */
function regionSetOf(id: RegionId): { active: RegionId[]; prefetch: RegionId[] } {
  const active = GRAPH.wanted(id).sort(stringCompare);
  const prefetch = GRAPH.wanted(id, GRAPH.wantedDepth + 1)
    .filter((r) => !active.includes(r))
    .sort(stringCompare);
  return { active, prefetch };
}
const WANTED = regionSetOf(SPAWN_REGION).active;
const PREFETCH = regionSetOf(SPAWN_REGION).prefetch;
const FAR = regionSetOf(FAR_REGION);
const TICK_RATE = game.tickRate;
/** 48 bytes. */
const HOST_SECRET = 'game-headless-secret-0123456789abcdef-0123456789';
const PASSWORD = 'headless-password';
/** The Session's FixedLoop overrun warning, in-process or relayed from a worker (`[session <id>] `). */
const DROPPED_TICKS = /^(\[session [0-9A-Z]{26}\] )?dropped ticks$/;

type Player = 'A' | 'B' | 'C';
type Snapshot = Extract<ServerReport, { t: 'hash' }>;

/** What the suite reads on the server side, whichever deployment runs the session. */
interface ServerView {
  /** The session's latest tick. */
  tick(): number;
  /** Display names in ascending `playerId`. */
  players(): string[];
  active(): RegionId[];
  /** `e` is a vehicle alive in the session's world. */
  vehicleAlive(e: EntityId): boolean;
  /** `world.hash()` and the entity count at the end of snapshot ticks, by tick (`reportingTail`). */
  readonly snapshots: Map<number, Snapshot>;
  /** Resolves once the view reflects the session at a moment after the call. */
  sync(): Promise<void>;
}

interface LogLine {
  level: string;
  msg: string;
  data: unknown;
}

interface Deployment {
  /** For log lines: `createServer` or `createHost`. */
  readonly name: string;
  readonly server: ServerView;
  /** How `name` connects: the options its client is created with. */
  connection(
    name: Player,
  ): Promise<Pick<CreateClientOpts<SandboxInput>, 'url' | 'displayName' | 'lobby' | 'sessionId'>>;
  /** Warn and error lines of the server. */
  readonly problems: LogLine[];
  /** Info lines of the server; the game's hooks log through the deployment's log too. */
  readonly infos: string[];
  /** What the deployment's log puts before a hook's line: `[session <id>] ` in a host worker. */
  readonly hookPrefix: string;
  /** The replica exists as soon as a headless `connect()` returns (no lobby join to wait for). */
  readonly replicaAtConnect: boolean;
  close(): Promise<void>;
}

function remember(snapshots: Map<number, Snapshot>, report: ServerReport): void {
  if (report.t !== 'hash') return;
  snapshots.set(report.tick, report);
  snapshots.delete(report.tick - 200 * game.snapshotEvery);
}

/** `createServer` in this process with dev auth; the view reads the Session directly. */
async function direct(): Promise<Deployment> {
  const problems: LogLine[] = [];
  const infos: string[] = [];
  const server = await createServer(game, {
    devAuth: true,
    reconnectGraceMs: 0,
    regionLoader: new CrowdedLoader(),
    hooks: hooksWithDistantC(),
    log: (level, msg, data) => {
      if (level === 'info') infos.push(msg);
      else if (msg !== DEV_AUTH_WARNING) problems.push({ level, msg, data });
    },
  });
  const { session } = server;
  const snapshots = new Map<number, Snapshot>();
  session.simulation.tail.push(reportingTail(session, (report) => remember(snapshots, report)));
  return {
    name: 'createServer',
    server: {
      tick: () => session.tick,
      players: () => session.players().map((p) => p.displayName),
      active: () => [...session.regions.active()],
      vehicleAlive: (e) => session.world.alive(e) && session.world.has(e, Vehicle),
      snapshots,
      sync: async () => {},
    },
    connection: async (name) => ({ url: server.url, displayName: name }),
    problems,
    infos,
    hookPrefix: '',
    replicaAtConnect: true,
    close: () => server.close(),
  } satisfies Deployment;
}

/** The session worker's reports (`fixtures/headless-game.ts`), received over `PROBE_CHANNEL`. */
class ReportedServer implements ServerView {
  readonly snapshots = new Map<number, Snapshot>();
  private readonly channel = new BroadcastChannel(PROBE_CHANNEL);
  private readonly sessionId: string;
  private last: Extract<ServerReport, { t: 'tick' }> | null = null;
  private nextSync = 1;
  private readonly syncs = new Map<number, () => void>();

  constructor(sessionId: string) {
    this.sessionId = sessionId;
    this.channel.onmessage = (event) => {
      const msg = event.data as ProbeMessage;
      if (msg.sessionId !== this.sessionId) return;
      if (msg.t === 'synced') this.syncs.get(msg.id)?.();
      else if (msg.t === 'tick') this.last = msg;
      else remember(this.snapshots, msg);
    };
  }

  tick(): number {
    return this.last?.tick ?? 0;
  }

  players(): string[] {
    return this.last?.players ?? [];
  }

  active(): RegionId[] {
    return this.last?.active ?? [];
  }

  vehicleAlive(e: EntityId): boolean {
    return this.last?.vehicles.includes(e) ?? false;
  }

  /** The worker answers between ticks, after the report of the tick it completed last. */
  sync(): Promise<void> {
    const id = this.nextSync++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.syncs.delete(id);
        reject(new Error('the session worker did not answer sync'));
      }, 10_000);
      this.syncs.set(id, () => {
        clearTimeout(timer);
        this.syncs.delete(id);
        resolve();
      });
      const request: ProbeRequest = { t: 'sync', id };
      this.channel.postMessage(request);
    });
  }

  close(): void {
    this.channel.close();
  }
}

/**
 * `createHost` on a SQLite scratch file with the fixture module; A, B and C register and log in
 * through `LobbyClient`, A creates a private session, and B and C join it with the invite code
 * before their clients connect (each `connect()` then joins again, as a member).
 */
async function hosted(): Promise<Deployment> {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-game-headless-'));
  const problems: LogLine[] = [];
  const infos: string[] = [];
  const host = await createHost(
    [{ game, module: new URL('./fixtures/headless-game.ts', import.meta.url) }],
    {
      port: 0,
      dbPath: join(dir, 'host.sqlite'),
      secret: HOST_SECRET,
      log: (level, msg, data) => {
        if (level === 'info') infos.push(msg);
        else problems.push({ level, msg, data });
      },
    },
  );
  let view: ReportedServer | null = null;
  try {
    const lobbies = new Map<Player, LobbyClient>();
    for (const name of ['A', 'B', 'C'] as const) {
      const lobby = new LobbyClient({ baseUrl: host.url });
      const username = `player_${name.toLowerCase()}`;
      await lobby.register(username, PASSWORD, name);
      await lobby.login(username, PASSWORD);
      lobbies.set(name, lobby);
    }
    const owner = lobbies.get('A') as LobbyClient;
    const { session, inviteCode } = await owner.createSession({
      gameId: game.id,
      name: 'headless',
      visibility: 'private',
      maxPlayers: 8,
    });
    const reported = new ReportedServer(session.id);
    view = reported;
    return {
      name: 'createHost',
      server: reported,
      async connection(name) {
        const lobby = lobbies.get(name) as LobbyClient;
        if (name !== 'A') await lobby.join(session.id, inviteCode); // now a member
        return { lobby, sessionId: session.id };
      },
      problems,
      infos,
      hookPrefix: `[session ${session.id}] `,
      replicaAtConnect: false,
      async close() {
        try {
          await host.close();
        } finally {
          reported.close();
          rmSync(dir, { recursive: true, force: true });
        }
      },
    };
  } catch (err) {
    view?.close();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

interface AppliedSnapshots {
  /** Every create, with its region-table entry (`null` for none). */
  creates: { entity: EntityId; region: RegionId | null }[];
  /** Entities that received an update. */
  updated: Set<EntityId>;
  stop(): void;
}

/**
 * Records what `applySnapshot` applies from now on (the wire content NetClient decoded) to every
 * replica `accept` picks, including one created later (a lobby client builds its NetClient only once
 * the join answered).
 */
function recordSnapshots(accept: (replica: ReplicaWorld) => boolean): AppliedSnapshots {
  const original = ReplicaWorld.prototype.applySnapshot;
  const applied: AppliedSnapshots = { creates: [], updated: new Set(), stop: () => {} };
  const spy = vi.spyOn(ReplicaWorld.prototype, 'applySnapshot').mockImplementation(function (
    this: ReplicaWorld,
    s: SnapshotData,
  ) {
    if (accept(this)) {
      for (const create of s.creates) {
        const region =
          create.regionIdx === REGION_IDX_NONE ? null : (s.regions[create.regionIdx] ?? null);
        applied.creates.push({ entity: create.entity, region });
      }
      for (const update of s.updates) applied.updated.add(update.entity);
    }
    original.call(this, s);
  });
  applied.stop = () => spy.mockRestore();
  return applied;
}

/** Polls `probe` until it returns a value. */
function waitForValue<T>(
  probe: () => T | undefined,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      const value = probe();
      if (value !== undefined) resolve(value);
      else if (performance.now() > deadline) reject(new Error(`timed out waiting for ${label}`));
      else setTimeout(poll, 2);
    };
    poll();
  });
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs?: number): Promise<void> {
  await waitForValue(() => (predicate() ? true : undefined), label, timeoutMs);
}

const scratch = new ByteWriter(256);

/**
 * `hashWorld` (docs/sim.md 2.6) rebuilt from a replica: per replicated component in id order its id
 * and holder count, then per holder in ascending slot order the id and the encoded latest value.
 * Covers every live replica entity, i.e. the client's visible set as of `replica.latestTick`.
 */
function replicaHash(replica: ReplicaWorld): { hash: number; entities: number } {
  const live = [...replica.entities()]
    .filter((ent) => ent.destroyedTick === null)
    .sort((x, y) => slotOf(x.id) - slotOf(y.id));
  let h = FNV_BASIS;
  for (const c of game.components) {
    if (!c.replicate) continue;
    const holders = live.filter((ent) => ent.latest.has(game.registry.componentId(c)));
    h = fnv1a32u32(h, game.registry.componentId(c));
    h = fnv1a32u32(h, holders.length);
    for (const ent of holders) {
      h = fnv1a32u32(h, ent.id);
      scratch.reset();
      encodeWith(scratch, c.schema, ent.latest.get(game.registry.componentId(c)));
      h = fnv1a32(scratch.view(), h);
    }
  }
  return { hash: h, entities: live.length };
}

function liveCrates(replica: ReplicaWorld): number {
  let n = 0;
  for (const ent of replica.entities()) {
    if (ent.destroyedTick === null && ent.latest.has(game.registry.componentId(Crate))) n++;
  }
  return n;
}

function distance(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Why the createHost run is skipped in this process, or null when node:sqlite is available. */
function nodeSqliteSkipReason(): string | null {
  try {
    openNodeSqlite(':memory:').close();
    return null;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ERR_UNKNOWN_BUILTIN_MODULE') {
      console.warn(`Skipping the createHost run. ${err.message}`);
      return err.message;
    }
    throw err;
  }
}

/** What a client's reconciliation stub reported, sampled on every frame of a prediction run. */
interface StubObservation {
  frames: number;
  /** Frames on which `lastAckedTick` was lower than on the frame before (none expected). */
  regressions: number;
  maxPending: number;
  latest: PredictionStats | undefined;
}

interface SuiteOptions {
  /**
   * Every client runs with `prediction: { enabled: true }` (docs/net.md B.10). Absent in the other
   * runs, which checks the default: the same scenarios pass either way.
   */
  prediction: boolean;
}

function integrationSuite(
  label: string,
  deploy: () => Promise<Deployment>,
  { prediction }: SuiteOptions,
): void {
  // Every case chains several waits on ticks and deliveries; on a machine running the whole suite
  // they can take several times their usual second.
  describe(label, { timeout: 30_000 }, () => {
    let d: Deployment;
    const clients: GameClient<SandboxInput>[] = [];
    const consoleErrors: unknown[][] = [];
    const controls = {
      A: { throttle: 0, steer: 0, buttons: 0 },
      B: { throttle: 0, steer: 0, buttons: 0 },
      C: { throttle: 0, steer: 0, buttons: 0 },
    };
    /** Replicated events and s2c chat lines each client received, in order. */
    const received = {
      A: { events: [] as ReplicatedEventInfo[], chat: [] as unknown[] },
      B: { events: [] as ReplicatedEventInfo[], chat: [] as unknown[] },
      C: { events: [] as ReplicatedEventInfo[], chat: [] as unknown[] },
    };
    /** Each client's latest `FrameContext.regions`. */
    const frameRegions: Partial<Record<Player, FrameContext<SandboxInput>['regions']>> = {};
    let a: GameClient<SandboxInput>;
    let b: GameClient<SandboxInput>;
    let joinTick = 0;
    const stubs: Record<Player, StubObservation> = {
      A: { frames: 0, regressions: 0, maxPending: 0, latest: undefined },
      B: { frames: 0, regressions: 0, maxPending: 0, latest: undefined },
      C: { frames: 0, regressions: 0, maxPending: 0, latest: undefined },
    };

    function horns(name: Player): ReplicatedEventInfo[] {
      return received[name].events.filter((ev) => ev.def === Horn);
    }

    function observeStub(name: Player, c: GameClient<SandboxInput>): void {
      const stats = c.net.prediction?.stats();
      if (stats === undefined) return;
      const seen = stubs[name];
      seen.frames++;
      if (seen.latest !== undefined && stats.lastAckedTick < seen.latest.lastAckedTick) {
        seen.regressions++;
      }
      seen.maxPending = Math.max(seen.maxPending, stats.pendingFrames);
      seen.latest = stats;
    }

    async function client(name: Player): Promise<GameClient<SandboxInput>> {
      const c = createClient(game, {
        ...(await d.connection(name)),
        ...(prediction ? { prediction: { enabled: true } } : {}),
        sampleInput: (ctx) => ({ tick: ctx.tick, ...controls[name] }),
        onMessage: { Chat: (msg) => received[name].chat.push(msg) },
        onFrame: (frame) => {
          frameRegions[name] = frame.regions;
          if (prediction) observeStub(name, c);
        },
      });
      c.on('event', (e) => received[name].events.push(e));
      clients.push(c);
      return c;
    }

    async function waitTicks(n: number): Promise<void> {
      const target = d.server.tick() + n;
      await waitFor(() => d.server.tick() >= target, `tick ${target}`, 5_000 + n * 50);
    }

    beforeAll(async () => {
      vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
        consoleErrors.push(args);
      });
      d = await deploy();
    }, 30_000);

    afterAll(async () => {
      for (const c of clients.splice(0)) c.dispose();
      await d?.close();
      vi.restoreAllMocks();
      // A FixedLoop that woke more than MAX_CATCH_UP_TICKS late reports `dropped ticks`: the machine
      // was too busy (the whole suite runs in parallel), not a fault of the path under test, whose
      // checks above are exact per tick. Every other warning or error fails the suite.
      const dropped = d?.problems.filter((line) => DROPPED_TICKS.test(line.msg)) ?? [];
      if (dropped.length > 0) console.log(`${label}: the session loop dropped ticks`, dropped);
      expect(d?.problems.filter((line) => !DROPPED_TICKS.test(line.msg))).toEqual([]);
      expect(consoleErrors).toEqual([]);
    }, 30_000);

    it('both players spawn in the spawn cell and see its nine cells with 300 crates', async () => {
      a = await client('A');
      b = await client('B');
      const joinedA = await a.connect();
      const joinedB = await b.connect();
      await d.server.sync();
      joinTick = d.server.tick();
      expect([joinedA.playerId, joinedB.playerId]).toEqual([0, 1]);
      expect(d.server.players()).toEqual(['A', 'B']);
      expect(d.server.active()).toEqual(WANTED);
      // The sandbox hooks' ctx.log lines arrive through the deployment's log (a worker's included).
      await waitFor(
        () => d.infos.includes(`${d.hookPrefix}sandbox: B joined as player 1`),
        "the hooks' join log lines",
      );
      expect(d.infos).toContain(`${d.hookPrefix}sandbox: A joined as player 0`);

      const aEntity = joinedA.localEntity;
      const bEntity = joinedB.localEntity;
      await waitFor(
        () =>
          liveCrates(a.replica) === CRATES_IN_VIEW &&
          liveCrates(b.replica) === CRATES_IN_VIEW &&
          b.replica.read(aEntity, Vehicle) !== undefined &&
          a.replica.read(bEntity, Vehicle) !== undefined,
        '300 crates and both vehicles in both replicas',
      );
      // Each client loaded the nine cells it plays in, and the prefetch ring around them (16 cells).
      expect(WANTED).toHaveLength(9);
      expect(PREFETCH).toHaveLength(16);
      for (const c of [a, b]) {
        const loaded = c.regions.loaded();
        expect(loaded.filter((id) => WANTED.includes(id))).toEqual(WANTED);
        expect(loaded.filter((id) => !WANTED.includes(id))).toEqual(PREFETCH);
        expect(c.regions.loading()).toEqual([]);
      }
      for (const name of ['A', 'B'] as const) {
        await waitFor(() => frameRegions[name]?.loaded.length === 25, `${name}'s frame regions`);
        expect(frameRegions[name]).toEqual({
          loaded: [...WANTED, ...PREFETCH].sort(stringCompare),
          loading: [],
          wanted: WANTED,
          prefetch: PREFETCH,
        });
      }
      // The sandbox hooks: named, tinted vehicles at the spawn cell's origin, 2 m apart.
      expect(b.replica.read(aEntity, Name)?.value).toBe('A');
      expect(b.replica.read(aEntity, Vehicle)?.colour).toBe(COLOURS[0]);
      expect(a.replica.read(bEntity, Vehicle)?.colour).toBe(COLOURS[1]);
      expect(b.replica.read(aEntity, Region)?.id).toBe(SPAWN_REGION);
      expect(b.replica.read(aEntity, Transform)?.pos).toEqual({ x: 0, y: 0, z: 0 });
      expect(b.replica.read(bEntity, Transform)?.pos).toEqual({ x: 2, y: 0, z: 0 });
    });

    it(
      'Spike 1: bytes received per client over 10 s with 300 crates in view are under 60 KB/s',
      { timeout: 30_000 },
      async () => {
        // Typical play: B drives along +Z (it stays in the spawn cell), the nine wanderers walk.
        controls.B.throttle = 127;
        await waitTicks(12);
        const t0 = d.server.tick();
        const wall0 = performance.now();
        const in0 = [a.net.stats().bytesIn, b.net.stats().bytesIn];
        const out0 = [a.net.stats().bytesOut, b.net.stats().bytesOut];
        await waitTicks(10 * TICK_RATE);
        const gameSeconds = (d.server.tick() - t0) / TICK_RATE;
        const wallSeconds = (performance.now() - wall0) / 1000;
        const down = [a, b].map((c, i) => c.net.stats().bytesIn - (in0[i] as number));
        const up = [a, b].map((c, i) => c.net.stats().bytesOut - (out0[i] as number));
        controls.B.throttle = 0;

        const kbps = (bytes: number[], seconds: number) =>
          bytes.map((n) => (n / seconds / 1000).toFixed(1)).join(' / ');
        console.log(
          [
            `Spike 1 (sandbox game, ${d.name}): bandwidth per client, snapshotEvery ${game.snapshotEvery} at ${TICK_RATE} Hz, ${CRATES_IN_VIEW} crates in view, B driving, 9 wanderers walking`,
            `  server->client ${kbps(down, gameSeconds)} KB/s per game second (A / B), ${kbps(down, wallSeconds)} KB/s wall clock over ${wallSeconds.toFixed(1)} s`,
            `  client->server ${kbps(up, wallSeconds)} KB/s wall clock`,
          ].join('\n'),
        );
        expect(gameSeconds).toBeGreaterThanOrEqual(10);
        for (const bytes of down) {
          expect(bytes).toBeGreaterThan(0);
          expect(bytes / gameSeconds / 1000).toBeLessThan(60);
        }
        expect(b.replica.read(b.localEntity as EntityId, Region)?.id).toBe(SPAWN_REGION);
      },
    );

    it('after 300 ticks the server world.hash() equals the hash built from each replica (delta-equals-full)', async () => {
      expect(d.server.tick() - joinTick).toBeGreaterThanOrEqual(300);
      for (const [name, c] of [
        ['A', a],
        ['B', b],
      ] as const) {
        const compared = new Set<number>();
        while (compared.size < 3) {
          // Read in one synchronous probe: no snapshot can apply between latestTick and the hash.
          const { tick, expected, replica } = await waitForValue(() => {
            const t = c.replica.latestTick;
            const recorded = d.server.snapshots.get(t);
            if (compared.has(t) || recorded === undefined) return undefined;
            return { tick: t, expected: recorded, replica: replicaHash(c.replica) };
          }, `a new snapshot on ${name}`);
          compared.add(tick);
          expect(replica.entities, `${name}: entities at tick ${tick}`).toBe(expected.count);
          expect(replica.hash, `${name}: hash at tick ${tick}`).toBe(expected.hash);
          // The comparison is sensitive: the walking wanderers change the world between snapshots.
          const previous = d.server.snapshots.get(tick - game.snapshotEvery);
          if (previous !== undefined) expect(replica.hash).not.toBe(previous.hash);
        }
      }
    });

    it("A's throttle moves A's entity in B's replica by more than 1 m within 60 ticks", async () => {
      const e = a.localEntity as EntityId;
      const start = { ...(b.replica.read(e, Transform)?.pos ?? { x: NaN, y: NaN, z: NaN }) };
      const sampled = Transform.create();
      const t0 = d.server.tick();
      controls.A.throttle = 127;
      await waitFor(() => {
        const pos = b.replica.read(e, Transform)?.pos;
        return pos !== undefined && distance(pos, start) > 1;
      }, "A's movement on B");
      const ticks = d.server.tick() - t0;
      expect(b.replica.read(e, Vehicle)?.throttle).toBe(127);
      // What B renders (the interpolated sample) follows.
      await waitFor(() => {
        const pos = b.replica.sample(e, Transform, b.clock.renderTick(), sampled)?.pos;
        return pos !== undefined && distance(pos, start) > 1;
      }, "A's sampled movement on B");
      controls.A.throttle = 0;
      expect(ticks).toBeLessThanOrEqual(60);
    });

    it("B receives A's Horn event with A's entity, once per press, when its render tick reaches it", async () => {
      const e = a.localEntity as EntityId;
      expect(horns('B')).toEqual([]);
      const renderTicks: number[] = [];
      const off = b.on('event', (ev) => {
        if (ev.def === Horn) renderTicks.push(b.clock.renderTick());
      });

      controls.A.buttons = BUTTON_HORN; // held for 20 ticks: one rising edge
      await waitTicks(20);
      controls.A.buttons = 0;
      await waitFor(
        () => horns('B').length === 1 && horns('A').length === 1,
        'the Horn on A and B',
      );
      const [horn] = horns('B');
      expect(horn?.payload).toEqual({ entity: e });
      expect(horn?.regionId).toBe(SPAWN_REGION);
      expect(horns('A')[0]?.tick).toBe(horn?.tick);
      // Emitted at render time: B's render clock had reached the event's server tick.
      expect(renderTicks[0]).toBeGreaterThanOrEqual(horn?.tick as number);

      await waitTicks(10);
      controls.A.buttons = BUTTON_HORN; // a second press
      await waitTicks(10);
      controls.A.buttons = 0;
      await waitFor(() => horns('B').length === 2, 'the second Horn on B');
      expect(horns('B')[1]?.payload).toEqual({ entity: e });
      expect(horns('B')[1]?.tick).toBeGreaterThan(horn?.tick as number);
      await waitTicks(30);
      expect(horns('B')).toHaveLength(2);
      off();
    });

    it("A's Chat reaches both players as '<name>: <text>'", async () => {
      a.send(Chat, { text: 'hello from A' });
      await waitFor(
        () => received.A.chat.length === 1 && received.B.chat.length === 1,
        'the chat broadcast',
      );
      expect(received.B.chat).toEqual([{ text: 'A: hello from A' }]);
      expect(received.A.chat).toEqual([{ text: 'A: hello from A' }]);
    });

    it('distant client C receives nothing: no Snapshot creates for A or B, no Events from their region', async () => {
      const theirs = new Set([a.replica, b.replica]);
      const applied = recordSnapshots((replica) => !theirs.has(replica));
      const c = await client('C');
      const connecting = c.connect();
      if (d.replicaAtConnect) {
        // Headless and without a lobby, the replica exists as soon as connect() returns.
        expect(c.replica.latestTick).toBe(0);
      } else {
        // connect() joins through the lobby first; the NetClient follows the answer.
        expect(() => c.replica).toThrow(/call connect\(\) first/);
      }
      const { localEntity: cEntity } = await connecting;
      const aEntity = a.localEntity as EntityId;
      const bEntity = b.localEntity as EntityId;
      expect(FAR.active.filter((id) => [...WANTED, ...PREFETCH].includes(id))).toEqual([]);
      expect(FAR.prefetch.filter((id) => [...WANTED, ...PREFETCH].includes(id))).toEqual([]);

      // C plays in its own nine cells: its vehicle and their 72 crates.
      await waitFor(
        () =>
          liveCrates(c.replica) === FAR.active.length * CRATES_PER_REGION &&
          c.replica.read(cEntity, Vehicle) !== undefined,
        "C's vehicle and crates",
      );
      expect(c.replica.read(cEntity, Region)?.id).toBe(FAR_REGION);
      expect(c.regions.loaded()).toEqual([...FAR.active, ...FAR.prefetch].sort(stringCompare));

      // A drives and honks, B honks; then C honks in its own cell (the control for C's event path).
      const heardByA = horns('A').length;
      const heardByB = horns('B').length;
      controls.A.throttle = 127;
      controls.A.buttons = BUTTON_HORN;
      controls.B.buttons = BUTTON_HORN;
      await waitTicks(20);
      controls.A.buttons = 0;
      controls.B.buttons = 0;
      await waitTicks(10);
      controls.A.throttle = 0;
      controls.C.buttons = BUTTON_HORN;
      await waitTicks(20);
      controls.C.buttons = 0;
      await waitFor(
        () =>
          horns('A').length === heardByA + 2 &&
          horns('B').length === heardByB + 2 &&
          horns('C').length === 1,
        'the three Horns',
      );
      // C dispatches events in tick order at its render tick, and its own Horn came last: an earlier
      // one from A's region would already have been dispatched. A few more snapshots for good measure.
      await waitTicks(4 * game.snapshotEvery);
      applied.stop();

      expect(horns('C').map((ev) => [ev.payload, ev.regionId])).toEqual([
        [{ entity: cEntity }, FAR_REGION],
      ]);
      expect(received.C.events.filter((ev) => ev.regionId !== FAR_REGION)).toEqual([]);
      expect(received.A.events.filter((ev) => ev.regionId === FAR_REGION)).toEqual([]);
      expect(received.B.events.filter((ev) => ev.regionId === FAR_REGION)).toEqual([]);
      expect(applied.creates.some((cr) => cr.entity === cEntity)).toBe(true);
      const others = [aEntity, bEntity];
      expect(applied.creates.filter((cr) => others.includes(cr.entity))).toEqual([]);
      expect([...applied.updated].filter((e) => others.includes(e))).toEqual([]);
      expect(
        applied.creates.filter((cr) => cr.region === null || !FAR.active.includes(cr.region)),
      ).toEqual([]);
      expect(b.replica.get(cEntity)).toBeUndefined();

      c.disconnect();
      await waitFor(() => d.server.players().length === 2, 'C leaving the session');
    });

    it(
      prediction
        ? "each client's prediction stub followed the acknowledgements: acked tick rising, pending frames bounded"
        : 'the prediction stub is off by default',
      async () => {
        if (!prediction) {
          for (const c of [a, b]) {
            expect(c.net.prediction).toBeNull();
            expect(c.net.stats()).not.toHaveProperty('prediction');
          }
          return;
        }
        // A live window: while A drives, both stubs keep receiving acknowledgements.
        const before = {
          A: a.net.stats().prediction as PredictionStats,
          B: b.net.stats().prediction as PredictionStats,
        };
        controls.A.throttle = 127;
        await waitTicks(30);
        controls.A.throttle = 0;
        await d.server.sync();
        const serverTick = d.server.tick();
        for (const [name, c] of [
          ['A', a],
          ['B', b],
        ] as const) {
          const now = c.net.stats().prediction as PredictionStats;
          expect(now.lastAckedTick, name).toBeGreaterThan(before[name].lastAckedTick);
          expect(now.lastAckedTick, name).toBeLessThanOrEqual(serverTick);
          expect(now.ackedFrames, name).toBeGreaterThan(before[name].ackedFrames);
          expect(now.authoritativeTick, name).toBeGreaterThan(before[name].authoritativeTick);
        }
        // Over the whole run, sampled on every frame (C's until it left): the acknowledged tick
        // never went back, and pruning kept up. Pending frames are the input lead plus the ticks
        // since the last snapshot (about 8 at most here); half a second of input leaves room for a
        // busy machine, while without pruning the PREDICTION_RING frames fill within two seconds.
        for (const name of ['A', 'B', 'C'] as const) {
          const seen = stubs[name];
          expect(seen.frames, name).toBeGreaterThan(0);
          expect(seen.regressions, name).toBe(0);
          expect(seen.maxPending, name).toBeLessThanOrEqual(TICK_RATE / 2);
          expect(seen.latest?.droppedFrames, name).toBe(0);
        }
      },
    );

    it("A's disconnect() destroys A's entity in B's replica", async () => {
      const e = a.localEntity as EntityId;
      a.disconnect();
      expect(a.state).toBe('closed');
      await waitFor(() => {
        const ent = b.replica.get(e);
        return ent === undefined || ent.destroyedTick !== null;
      }, "A's destroy on B");
      await d.server.sync();
      expect(d.server.vehicleAlive(e)).toBe(false);
      await waitFor(() => d.server.players().length === 1, 'A leaving the session');
      expect(d.server.players()).toEqual(['B']);
      expect(b.state).toBe('spawned');
    });
  });
}

// The createServer run twice: with the default options, then with the prediction stub on (M6,
// docs/net.md B.10), which must change nothing the scenarios observe.
for (const prediction of [false, true]) {
  integrationSuite(
    `sandbox game: createServer, headless createClients A and B nearby and C far away${prediction ? ', prediction stub on' : ''}`,
    direct,
    { prediction },
  );
}

const sqliteSkipReason = nodeSqliteSkipReason();
describe.skipIf(sqliteSkipReason !== null)('through createHost', () => {
  integrationSuite(
    'sandbox game: createHost on a SQLite file, lobby joins, headless createClients A and B nearby and C far away',
    hosted,
    { prediction: false },
  );
});
