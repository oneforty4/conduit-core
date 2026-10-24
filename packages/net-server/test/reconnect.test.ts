import { hmacVerifier, mintToken, type SessionToken } from '@conduit/auth';
import { type BlobStore, MemoryStore, openApplicationSave } from '@conduit/persist';
import {
  ByteWriter,
  DEFAULT_SNAPSHOT_LIMITS,
  ENTITY_NONE,
  type EntityId,
  KickReason,
  type MessageDef,
  PlayerState,
  type RegionSetPayload,
  RejectReason,
  type SchemaRegistry,
  type SessionStatePayload,
  SNAPSHOT_FLAG_FULL,
  type SnapshotData,
  type SpawnedPayload,
  type WelcomePayload,
} from '@conduit/protocol';
import { defineSystem, Owner, Region, type System, Transform } from '@conduit/sim';
import { stringCompare } from '@conduit/world';
import { describe, expect, it, vi } from 'vitest';
import {
  type ClientConn,
  ConnStateError,
  createConn,
  graceExpired,
  markAway,
  matchesReconnect,
  rebindConn,
  transition,
} from '../src/client-conn.ts';
import { CloseCode, RECONNECT_GRACE_MS } from '../src/constants.ts';
import type { PlayerInfo, PlayerSpawn, SessionAutosaver } from '../src/session.ts';
import { FakeLink } from './fake-link.ts';
import {
  CELL,
  createHarness,
  eventsOf,
  type Harness,
  type HarnessOptions,
  Horn,
  joinAndSpawn,
  Notice,
  payloadOf,
  type ReceivedMessage,
  scriptedEvents,
  snapshotsOf,
  SPAWN_REGION,
  type TestClient,
  type TestFrame,
  Weather,
} from './harness.ts';

// ---------------------------------------------------------------------------------------------
// Helpers

/** Entity -> replicated component id -> the value's wire encoding (hex). */
type WireState = Record<number, Record<number, string>>;

const scratch = new ByteWriter(256);

function wire(registry: SchemaRegistry, compId: number, value: unknown): string {
  const def = registry.component(compId);
  if (def === undefined) throw new Error(`no component ${compId}`);
  scratch.reset();
  def.schema.encode(scratch, value);
  return Buffer.from(scratch.view()).toString('hex');
}

/** What a client holds after applying snapshots in order: entity -> component id -> value. */
class Mirror {
  readonly entities = new Map<EntityId, Map<number, unknown>>();

  apply(s: SnapshotData): void {
    if ((s.header.flags & SNAPSHOT_FLAG_FULL) !== 0) this.entities.clear();
    for (const c of s.creates) {
      this.entities.set(c.entity, new Map(c.components.map((x) => [x.id, x.value])));
    }
    for (const u of s.updates) {
      const ent = this.entities.get(u.entity);
      if (ent === undefined) throw new Error(`update for unknown entity ${u.entity}`);
      for (const x of u.components) ent.set(x.id, x.value);
      for (const id of u.removed) ent.delete(id);
    }
    for (const e of s.destroys) this.entities.delete(e);
  }

  has(e: EntityId): boolean {
    return this.entities.has(e);
  }

  state(registry: SchemaRegistry): WireState {
    const out: WireState = {};
    for (const [e, comps] of this.entities) {
      const row: Record<number, string> = {};
      for (const [id, value] of comps) row[id] = wire(registry, id, value);
      out[e] = row;
    }
    return out;
  }
}

/** A `TestClient` that applies every snapshot it receives to a `Mirror` and acks the newest. */
class Peer {
  readonly client: TestClient;
  readonly mirror = new Mirror();
  /** Every snapshot received, in order. */
  readonly snapshots: SnapshotData[] = [];
  private inbox: ReceivedMessage[] = [];

  constructor(client: TestClient) {
    this.client = client;
  }

  /** Takes what the Session sent (or `messages`, already taken), applying and acking snapshots. */
  receive(messages: ReceivedMessage[] = this.client.take()): void {
    const snapshots = snapshotsOf(messages);
    for (const s of snapshots) {
      this.mirror.apply(s);
      this.snapshots.push(s);
    }
    const newest = snapshots.at(-1);
    if (newest !== undefined) this.client.ack(newest.header.serverTick);
    this.inbox.push(...messages);
  }

  /** Everything received since the last `take`. */
  take(): ReceivedMessage[] {
    this.receive();
    return this.inbox.splice(0);
  }

  names(): string[] {
    return this.take().map((m) => m.name);
  }
}

/** `ticks` steps; every peer receives (and acks) after each. */
async function run(h: Harness, peers: readonly Peer[], ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await h.step();
    for (const peer of peers) peer.receive();
  }
}

/** Steps until `peer` receives its next snapshot, right after the tick that built it. */
async function nextSnapshot(
  h: Harness,
  peer: Peer,
  others: readonly Peer[] = [],
): Promise<SnapshotData> {
  const count = peer.snapshots.length;
  for (let i = 0; i < 2 * h.game.snapshotEvery; i++) {
    await run(h, [peer, ...others], 1);
    const snapshot = peer.snapshots[count];
    if (snapshot !== undefined) return snapshot;
  }
  throw new Error('no snapshot arrived');
}

/** Lets pending promise callbacks run (one macrotask turn). */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function settleUntil(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${label}`);
}

function sorted(ids: Iterable<string>): string[] {
  return [...ids].sort(stringCompare);
}

function entityOf(h: Harness, playerId: number): EntityId {
  const player = h.session.players().find((p) => p.playerId === playerId);
  if (player === undefined) throw new Error(`no player ${playerId}`);
  return player.entity;
}

/** Entities the server lists in `regions`, ascending. */
function entitiesOf(h: Harness, regions: Iterable<string>): EntityId[] {
  return [...regions].flatMap((r) => [...h.session.regions.entitiesIn(r)]).sort((x, y) => x - y);
}

/** The server's replicated stores for the entities of `regions`, as the wire encodes them. */
function serverState(h: Harness, regions: Iterable<string>): WireState {
  const registry = h.game.registry;
  const stores = h.session.world.stores();
  const out: WireState = {};
  for (const e of entitiesOf(h, regions)) {
    const row: Record<number, string> = {};
    for (const def of registry.replicated) {
      const id = registry.componentId(def);
      const store = stores[id];
      if (store?.has(e) === true) row[id] = wire(registry, id, store.read(e));
    }
    out[e] = row;
  }
  return out;
}

/** The state a client holds after applying `snapshot` alone. */
function stateOf(h: Harness, snapshot: SnapshotData): WireState {
  const mirror = new Mirror();
  mirror.apply(snapshot);
  return mirror.state(h.game.registry);
}

function lastPlayers(messages: readonly ReceivedMessage[]): SessionStatePayload['players'] {
  const last = messages.filter((m) => m.name === 'SessionState').at(-1);
  if (last === undefined) {
    throw new Error(`no SessionState in [${messages.map((m) => m.name).join(', ')}]`);
  }
  return (last.payload as SessionStatePayload).players;
}

function identity(accountId: string, displayName: string): SessionToken {
  return { accountId, displayName, sessionId: 'dev', exp: Math.floor(Date.now() / 1000) + 600 };
}

/** Records `ctx.inputs(0)?.throttle` for every tick. */
function inputProbe(): { system: System; throttles: Map<number, number | undefined> } {
  const throttles = new Map<number, number | undefined>();
  const system = defineSystem('inputProbe', 'input', (ctx) => {
    throttles.set(ctx.tick, (ctx.inputs(0) as TestFrame | undefined)?.throttle);
  });
  return { system, throttles };
}

/** `onPlayerJoin` spawning every player in `regionId`. */
function spawnAt(regionId: string): (player: PlayerInfo) => PlayerSpawn {
  return (player) => ({
    regionId,
    spawn: (ctx) => {
      const e = ctx.world.create();
      ctx.world.add(e, Region, { id: regionId });
      ctx.world.add(e, Transform, { pos: { x: 32 + player.playerId, y: 0, z: 32 } });
      ctx.world.add(e, Owner, { player: player.playerId });
      return e;
    },
  });
}

/** Cell ids of an 8 x 8 grid within Chebyshev distance `depth` of `(ix, iy)`, sorted. */
function cellsAround(ix: number, iy: number, depth: number): string[] {
  const out: string[] = [];
  for (let y = Math.max(0, iy - depth); y <= Math.min(7, iy + depth); y++) {
    for (let x = Math.max(0, ix - depth); x <= Math.min(7, ix + depth); x++) {
      out.push(`cell/${x}_${y}`);
    }
  }
  return sorted(out);
}

/** A BlobStore over a `MemoryStore` whose `get`/`put` calls on held keys wait for a release. */
class GatedStore implements BlobStore {
  readonly inner = new MemoryStore();
  /** `'<op> <ns>/<key>'` of every call that had to wait, in order. */
  readonly waited: string[] = [];
  private holds: {
    op: 'get' | 'put';
    ns: string;
    match: (key: string) => boolean;
    open: Promise<void>;
  }[] = [];

  /** Holds matching calls (the ones already waiting and later ones) until the returned release. */
  hold(op: 'get' | 'put', ns: string, match: (key: string) => boolean = () => true): () => void {
    let release = (): void => {};
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entry = { op, ns, match, open };
    this.holds.push(entry);
    return () => {
      this.holds = this.holds.filter((x) => x !== entry);
      release();
    };
  }

  async get(ns: string, key: string): Promise<Uint8Array | null> {
    await this.pass('get', ns, key);
    return this.inner.get(ns, key);
  }

  async put(ns: string, key: string, blob: Uint8Array): Promise<void> {
    await this.pass('put', ns, key);
    return this.inner.put(ns, key, blob);
  }

  delete(ns: string, key: string): Promise<void> {
    return this.inner.delete(ns, key);
  }

  list(ns: string, prefix?: string): Promise<string[]> {
    return this.inner.list(ns, prefix);
  }

  transaction<T>(fn: (tx: BlobStore) => T | Promise<T>): Promise<T> {
    return this.inner.transaction((tx) => {
      const gated: BlobStore = {
        get: (ns, key) => tx.get(ns, key),
        put: async (ns, key, bytes) => {
          await this.pass('put', ns, key);
          await tx.put(ns, key, bytes);
        },
        delete: (ns, key) => tx.delete(ns, key),
        list: (ns, prefix) => tx.list(ns, prefix),
        transaction: (nested) => tx.transaction(nested),
      };
      return fn(gated);
    });
  }

  private async pass(op: 'get' | 'put', ns: string, key: string): Promise<void> {
    const hold = this.holds.find((x) => x.op === op && x.ns === ns && x.match(key));
    if (hold === undefined) return;
    this.waited.push(`${op} ${ns}/${key}`);
    await hold.open;
  }
}

interface Pair {
  h: Harness;
  a: Peer;
  b: Peer;
  /** `a`'s reconnect token. */
  token: string;
  /** `a`'s entity. */
  entity: EntityId;
}

/** Players `a` (0) and `b` (1) playing, every snapshot so far acked. */
async function playingPair(opts: HarnessOptions = {}): Promise<Pair> {
  const h = await createHarness(opts);
  const a = new Peer(h.client());
  const b = new Peer(h.client());
  const seen = await joinAndSpawn(h, a.client, 'a');
  a.receive(seen);
  b.receive(await joinAndSpawn(h, b.client, 'b'));
  await run(h, [a, b], 6);
  a.take();
  b.take();
  const token = payloadOf<WelcomePayload>(seen, 'Welcome').reconnectToken;
  return { h, a, b, token, entity: entityOf(h, 0) };
}

/** A new link sending `a`'s reconnect Hello. */
function reconnect(h: Harness, token: string, name = 'a'): Peer {
  const peer = new Peer(h.client());
  peer.client.hello({ displayName: name, reconnectToken: token });
  return peer;
}

const REBIND_BURST = ['Welcome', 'SessionState', 'RegionSet', 'Spawned'];

// ---------------------------------------------------------------------------------------------

describe('away, then a reconnect within the grace', () => {
  it('keeps slot, entity and token and releases the input; the rebind resumes the player with a FULL snapshot equal to the server stores', async () => {
    const probe = inputProbe();
    const { h, a, b, token, entity } = await playingPair({ systems: [probe.system] });
    const entityB = entityOf(h, 1);
    const t0 = h.session.tick;
    a.client.input([t0 + 1, t0 + 2], 5);
    await run(h, [a, b], 2);
    expect(probe.throttles.get(t0 + 2)).toBe(5);

    a.client.link.remoteClose(1006);
    expect(lastPlayers(b.take())).toEqual([
      { playerId: 0, name: 'a', state: PlayerState.Away, entity },
      { playerId: 1, name: 'b', state: PlayerState.Playing, entity: entityB },
    ]);
    const t1 = h.session.tick;
    h.clock.advance(RECONNECT_GRACE_MS - 1000); // the default grace, nearly spent
    await run(h, [b], 6);
    for (let t = t1 + 1; t <= t1 + 6; t++) expect(probe.throttles.get(t)).toBeUndefined();
    expect(h.session.world.alive(entity)).toBe(true);
    expect(h.session.players()).toMatchObject([
      { playerId: 0, state: PlayerState.Away, entity },
      { playerId: 1, state: PlayerState.Playing, entity: entityB },
    ]);
    expect(snapshotsOf(b.take()).flatMap((s) => s.destroys)).toEqual([]);

    const a2 = reconnect(h, token);
    const burst = a2.take();
    expect(burst.map((m) => m.name)).toEqual(REBIND_BURST);
    expect(burst.map((m) => m.seq)).toEqual([0, 1, 2, 3]);
    expect(burst[0]?.payload).toEqual({
      sessionCapacity: h.session.capacity,
      snapshotLimits: DEFAULT_SNAPSHOT_LIMITS,
      compatibility: h.session.compatibility,
      playerId: 0,
      reconnectToken: token,
      simTickRate: h.game.tickRate,
      snapshotEvery: h.game.snapshotEvery,
      serverTick: h.session.tick,
      serverTimeMs: expect.any(Number),
      worldSeed: h.game.seed,
    });
    expect(lastPlayers(burst)).toEqual([
      { playerId: 0, name: 'a', state: PlayerState.Playing, entity },
      { playerId: 1, name: 'b', state: PlayerState.Playing, entity: entityB },
    ]);
    const set = payloadOf<RegionSetPayload>(burst, 'RegionSet');
    expect(set).toEqual({
      active: sorted(h.session.interest.wantedForRegion(SPAWN_REGION)),
      prefetch: sorted(h.session.interest.prefetchForRegion(SPAWN_REGION)),
    });
    expect(payloadOf<SpawnedPayload>(burst, 'Spawned')).toEqual({
      playerId: 0,
      entity,
      regionId: SPAWN_REGION,
    });
    expect(lastPlayers(b.take())[0]).toEqual({
      playerId: 0,
      name: 'a',
      state: PlayerState.Playing,
      entity,
    });

    await run(h, [a2, b], 6); // nothing is replicated before the client re-reports its regions
    expect(a2.names()).toEqual([]);
    a2.client.regionLoadState(set.active);
    const full = await nextSnapshot(h, a2, [b]);
    expect(full.header).toMatchObject({
      serverTick: h.session.tick,
      baselineTick: 0,
      flags: SNAPSHOT_FLAG_FULL,
    });
    expect(full.updates).toEqual([]);
    expect(full.destroys).toEqual([]);
    const server = serverState(h, set.active);
    expect(Object.keys(server)).toHaveLength(9 * 2 + 2); // the crates of nine cells, both players
    expect(stateOf(h, full)).toEqual(server);

    const delta = await nextSnapshot(h, a2, [b]);
    expect(delta.header).toMatchObject({ baselineTick: full.header.serverTick, flags: 0 });
    expect(a2.mirror.state(h.game.registry)).toEqual(serverState(h, set.active));

    const t2 = h.session.tick;
    a2.client.input([t2 + 1], 7);
    await run(h, [a2, b], 1);
    expect(probe.throttles.get(t2 + 1)).toBe(7);
    expect(b.mirror.has(entity)).toBe(true);
    expect(h.session.players()).toMatchObject([
      { playerId: 0, state: PlayerState.Playing, entity },
      { playerId: 1, state: PlayerState.Playing, entity: entityB },
    ]);
    expect(h.hooks.onPlayerJoin).toHaveBeenCalledTimes(2);
    expect(h.hooks.onPlayerLeave).not.toHaveBeenCalled();
  });

  it('holds snapshots and events until the report; events emitted meanwhile ride the FULL snapshot frame', async () => {
    const script = scriptedEvents();
    const { h, a, b, token, entity } = await playingPair({ systems: [script.system] });
    a.client.link.remoteClose(1006);
    await run(h, [b], 2);

    const a2 = reconnect(h, token);
    const set = payloadOf<RegionSetPayload>(a2.take(), 'RegionSet');
    const t = h.session.tick;
    script.at(t + 1, Weather, { kind: 'fog' }); // global: queued for the rebound client
    script.at(t + 1, Horn, { entity, pitch: 2 }, SPAWN_REGION); // its region is not reported yet
    await run(h, [a2, b], 6);
    expect(a2.names()).toEqual([]);

    a2.client.regionLoadState(set.active);
    const t2 = h.session.tick;
    script.at(t2 + 1, Horn, { entity, pitch: 3 }, SPAWN_REGION);
    await nextSnapshot(h, a2, [b]);
    const got = a2.take();
    expect(got.map((m) => m.name)).toEqual(['Snapshot', 'Events']);
    expect(new Set(got.map((m) => m.frame)).size).toBe(1);
    expect((got[0]?.payload as SnapshotData).header.flags).toBe(SNAPSHOT_FLAG_FULL);
    expect(eventsOf(h.game.registry, got)).toEqual([
      { name: 'Weather', tick: t + 1, region: null, payload: { kind: 'fog' } },
      { name: 'Horn', tick: t2 + 1, region: SPAWN_REGION, payload: { entity, pitch: 3 } },
    ]);
  });
});

describe('a second Hello with the token while the first link is open', () => {
  it('displaces that link with Kicked{Replaced} and 4006, keeps the player and starts a new input stream', async () => {
    const probe = inputProbe();
    const { h, a, b, token, entity } = await playingPair({ systems: [probe.system] });
    const t0 = h.session.tick;
    a.client.input([t0 + 20, t0 + 21], 3); // far ahead: the old stream's newest tick is t0 + 21

    const a2 = reconnect(h, token);
    expect(a.take()).toMatchObject([{ name: 'Kicked', payload: { reason: KickReason.Replaced } }]);
    expect(a.client.link.closedWith).toEqual({ code: CloseCode.Replaced, reason: 'replaced' });
    const burst = a2.take();
    expect(burst.map((m) => m.name)).toEqual(REBIND_BURST);
    expect(payloadOf<WelcomePayload>(burst, 'Welcome')).toMatchObject({
      playerId: 0,
      reconnectToken: token,
    });
    expect(payloadOf<SpawnedPayload>(burst, 'Spawned')).toEqual({
      playerId: 0,
      entity,
      regionId: SPAWN_REGION,
    });
    expect(lastPlayers(b.take())[0]).toMatchObject({
      playerId: 0,
      state: PlayerState.Playing,
      entity,
    });
    await settle(); // the displaced link reports its close: the player does not go away
    expect(h.session.players()[0]).toMatchObject({
      playerId: 0,
      state: PlayerState.Playing,
      entity,
    });

    const set = payloadOf<RegionSetPayload>(burst, 'RegionSet');
    a2.client.regionLoadState(set.active);
    a2.client.input([t0 + 2], 4); // below the displaced stream's newest tick, and still accepted
    await run(h, [a2, b], 21);
    expect(probe.throttles.get(t0 + 2)).toBe(4);
    expect(probe.throttles.get(t0 + 21)).toBe(4); // the displaced link's queued frames are gone
    expect(a2.snapshots[0]?.header).toMatchObject({ baselineTick: 0, flags: SNAPSHOT_FLAG_FULL });
    expect(a2.mirror.state(h.game.registry)).toEqual(serverState(h, set.active));
    a2.take();

    // The token stays valid: a third link displaces the second the same way.
    const a3 = reconnect(h, token);
    expect(a2.take()).toMatchObject([{ name: 'Kicked', payload: { reason: KickReason.Replaced } }]);
    expect(a2.client.link.closedWith?.code).toBe(CloseCode.Replaced);
    expect(a3.names()).toEqual(REBIND_BURST);
    await run(h, [a3, b], 3);
    expect(h.session.world.alive(entity)).toBe(true);
    expect(b.mirror.has(entity)).toBe(true);
    expect(h.hooks.onPlayerJoin).toHaveBeenCalledTimes(2);
    expect(h.hooks.onPlayerLeave).not.toHaveBeenCalled();
  });
});

describe('grace expiry', () => {
  it('after RECONNECT_GRACE_MS runs the leave: onPlayerLeave, the entity destroyed for other clients, the slot freed; the stale token then joins fresh', async () => {
    const { h, a, b, token, entity } = await playingPair();
    a.client.link.remoteClose(1006);
    await run(h, [b], 1);
    h.clock.advance(RECONNECT_GRACE_MS - 100);
    await run(h, [b], 3);
    expect(h.hooks.onPlayerLeave).not.toHaveBeenCalled();
    expect(h.session.players()[0]).toMatchObject({ playerId: 0, state: PlayerState.Away, entity });
    b.take();

    h.clock.advance(100);
    await run(h, [b], 1); // the lifecycle finds the grace spent and runs the leave in this tick
    expect(h.hooks.onPlayerLeave).toHaveBeenCalledTimes(1);
    const [info, ctx] = h.hooks.onPlayerLeave.mock.calls[0] ?? [];
    expect(info).toMatchObject({ playerId: 0, accountId: 'dev:a', displayName: 'a', entity });
    expect(ctx?.session).toBe(h.session);
    expect(h.session.world.alive(entity)).toBe(false);
    expect(h.session.players().map((p) => p.playerId)).toEqual([1]);
    await run(h, [b], h.game.snapshotEvery);
    const got = b.take();
    expect(lastPlayers(got).map((p) => p.name)).toEqual(['b']);
    expect(snapshotsOf(got).flatMap((s) => s.destroys)).toEqual([entity]);
    expect(b.mirror.has(entity)).toBe(false);

    // The stale token matches nothing: a fresh join. It gets the freed slot 0 again, so a client
    // tells it from a rebind by the new reconnect token.
    const late = reconnect(h, token);
    const burst = late.take();
    expect(burst.map((m) => m.name)).toEqual(['Welcome', 'SessionState']);
    const welcome = payloadOf<WelcomePayload>(burst, 'Welcome');
    expect(welcome.playerId).toBe(0);
    expect(welcome.reconnectToken).not.toBe(token);
    expect(lastPlayers(burst)[0]).toEqual({
      playerId: 0,
      name: 'a',
      state: PlayerState.Joined,
      entity: ENTITY_NONE,
    });
    await run(h, [late, b], 1);
    expect(h.hooks.onPlayerJoin).toHaveBeenCalledTimes(3);
    expect(h.hooks.onPlayerLeave).toHaveBeenCalledTimes(1);
  });

  it('honours reconnectGraceMs and rejects a negative one', async () => {
    const { h, a, b } = await playingPair({ session: { reconnectGraceMs: 500 } });
    a.client.link.remoteClose(1006);
    h.clock.advance(499);
    await run(h, [b], 1); // the lifecycle runs 499 ms after the drop
    expect(h.hooks.onPlayerLeave).not.toHaveBeenCalled();
    await run(h, [b], 1); // one tick later
    expect(h.hooks.onPlayerLeave).toHaveBeenCalledTimes(1);
    await expect(createHarness({ session: { reconnectGraceMs: -1 } })).rejects.toThrow(RangeError);
  });
});

describe('Hellos that match no player', () => {
  it('another account, an unknown token or no token join fresh and leave the away player alone', async () => {
    const h = await createHarness({ verifier: null });
    const a = new Peer(h.client({ identity: identity('acc-a', 'a') }));
    const seen = await joinAndSpawn(h, a.client, 'a');
    const token = payloadOf<WelcomePayload>(seen, 'Welcome').reconnectToken;
    const entity = entityOf(h, 0);
    a.client.link.remoteClose(1006);

    const attempts = [
      { id: identity('acc-z', 'z'), reconnectToken: token }, // someone else's token
      { id: identity('acc-a', 'a'), reconnectToken: 'x'.repeat(32) }, // an unknown token
      { id: identity('acc-a', 'a'), reconnectToken: '' }, // no token: an account may hold two slots
    ];
    for (const [i, attempt] of attempts.entries()) {
      const peer = new Peer(h.client({ identity: attempt.id }));
      peer.client.hello({
        displayName: attempt.id.displayName,
        reconnectToken: attempt.reconnectToken,
      });
      const burst = peer.take();
      expect(burst.map((m) => m.name)).toEqual(['Welcome', 'SessionState']);
      const welcome = payloadOf<WelcomePayload>(burst, 'Welcome');
      expect(welcome.playerId).toBe(i + 1);
      expect(welcome.reconnectToken).not.toBe(token);
    }
    expect(h.session.players()[0]).toMatchObject({ playerId: 0, state: PlayerState.Away, entity });

    const back = new Peer(h.client({ identity: identity('acc-a', 'a') }));
    back.client.hello({ displayName: 'a', reconnectToken: token });
    expect(back.names()).toEqual(REBIND_BURST);
    expect(h.session.players()).toHaveLength(4);
  });

  it('the token of a player that has not spawned resumes nothing', async () => {
    const h = await createHarness();
    const early = new Peer(h.client());
    early.client.hello({ displayName: 'e' });
    const token = payloadOf<WelcomePayload>(early.take(), 'Welcome').reconnectToken;
    await h.step(); // joined, not playing
    const twin = reconnect(h, token, 'e');
    const welcome = payloadOf<WelcomePayload>(twin.take(), 'Welcome');
    expect(welcome.playerId).toBe(1);
    expect(early.client.link.closedWith).toBeNull();
  });

  it('a full session still takes a reconnect, and refuses a fresh join', async () => {
    const { h, a, b, token } = await playingPair({ session: { maxPlayers: 2 } });
    a.client.link.remoteClose(1006);
    const stranger = new Peer(h.client());
    stranger.client.hello({ displayName: 'c' });
    expect(stranger.take()).toMatchObject([{ name: 'Rejected' }]);
    expect(stranger.client.link.closedWith?.code).toBe(CloseCode.SessionFull);
    expect(reconnect(h, token).names()).toEqual(REBIND_BURST);
    expect(b.client.link.closedWith).toBeNull();
  });
});

describe('expired session tokens (docs/net.md A.6)', () => {
  const nowS = (): number => Math.floor(Date.now() / 1000);
  const expiredIdentity = (accountId: string, name: string): SessionToken => ({
    ...identity(accountId, name),
    exp: nowS() - 3600,
  });

  function expectBadToken(peer: Peer): void {
    expect(peer.take()).toMatchObject([
      { name: 'Rejected', payload: { reason: RejectReason.BadToken, detail: 'bad token' } },
    ]);
    expect(peer.client.link.closedWith?.code).toBe(CloseCode.BadToken);
  }

  it('gateway path: an identity marked tokenExpired only rebinds the player its reconnect token names', async () => {
    const h = await createHarness({ verifier: null });
    const a = new Peer(h.client({ identity: identity('acc-a', 'a') }));
    const token = payloadOf<WelcomePayload>(
      await joinAndSpawn(h, a.client, 'a'),
      'Welcome',
    ).reconnectToken;
    const entity = entityOf(h, 0);

    // While the player still plays, a fresh join with an expired token is refused.
    const fresh = new Peer(
      h.client({ identity: expiredIdentity('acc-a', 'a'), tokenExpired: true }),
    );
    fresh.client.hello({ displayName: 'a' });
    expectBadToken(fresh);

    a.client.link.remoteClose(1006);
    await h.step();
    const attempts = [
      { id: expiredIdentity('acc-a', 'a'), reconnectToken: 'x'.repeat(32) }, // unknown token
      { id: expiredIdentity('acc-z', 'z'), reconnectToken: token }, // another account's token
    ];
    for (const attempt of attempts) {
      const peer = new Peer(h.client({ identity: attempt.id, tokenExpired: true }));
      peer.client.hello({
        displayName: attempt.id.displayName,
        reconnectToken: attempt.reconnectToken,
      });
      expectBadToken(peer);
    }
    expect(h.session.players()).toMatchObject([{ playerId: 0, state: PlayerState.Away, entity }]);

    const back = new Peer(
      h.client({ identity: expiredIdentity('acc-a', 'a'), tokenExpired: true }),
    );
    back.client.hello({ displayName: 'a', reconnectToken: token });
    const burst = back.take();
    expect(burst.map((m) => m.name)).toEqual(REBIND_BURST);
    expect(payloadOf<WelcomePayload>(burst, 'Welcome')).toMatchObject({
      playerId: 0,
      reconnectToken: token,
    });
    expect(h.session.players()).toMatchObject([
      { playerId: 0, state: PlayerState.Playing, entity },
    ]);
    expect(h.hooks.onPlayerJoin).toHaveBeenCalledTimes(1);
  });

  it('gateway path: the verdict wins over the clock, and without one the clock decides', async () => {
    const h = await createHarness({ verifier: null });
    // Expired by the clock, but the gateway judged the token valid (it expired in flight).
    const late = new Peer(
      h.client({ identity: expiredIdentity('acc-l', 'l'), tokenExpired: false }),
    );
    late.client.hello({ displayName: 'l' });
    expect(late.names()).toEqual(['Welcome', 'SessionState']);
    // No verdict: decided from exp.
    const stale = new Peer(h.client({ identity: expiredIdentity('acc-s', 's') }));
    stale.client.hello({ displayName: 's' });
    expectBadToken(stale);
    const valid = new Peer(h.client({ identity: identity('acc-v', 'v') }));
    valid.client.hello({ displayName: 'v' });
    expect(valid.names()).toEqual(['Welcome', 'SessionState']);
  });

  it('after the grace an expired token resumes nothing and cannot join fresh', async () => {
    const h = await createHarness({ verifier: null, session: { reconnectGraceMs: 1000 } });
    const a = new Peer(h.client({ identity: identity('acc-a', 'a') }));
    const token = payloadOf<WelcomePayload>(
      await joinAndSpawn(h, a.client, 'a'),
      'Welcome',
    ).reconnectToken;
    a.client.link.remoteClose(1006);
    h.clock.advance(1000);
    await h.step(2);
    expect(h.session.players()).toEqual([]);
    const back = new Peer(
      h.client({ identity: expiredIdentity('acc-a', 'a'), tokenExpired: true }),
    );
    back.client.hello({ displayName: 'a', reconnectToken: token });
    expectBadToken(back);
    // A fresh token joins fresh with the stale reconnect token.
    const renewed = new Peer(h.client({ identity: identity('acc-a', 'a'), tokenExpired: false }));
    renewed.client.hello({ displayName: 'a', reconnectToken: token });
    const welcome = payloadOf<WelcomePayload>(renewed.take(), 'Welcome');
    expect(welcome.reconnectToken).not.toBe(token);
  });

  it('createServer path: a Hello with a reconnect token is verified with allowExpired', async () => {
    const secret = 'a-test-secret-that-is-at-least-32-bytes-long';
    const mint = (accountId: string, exp: number, key = secret): string =>
      mintToken({ accountId, displayName: accountId, sessionId: 'dev', exp }, key);
    const h = await createHarness({ verifier: hmacVerifier(secret) });
    const a = new Peer(h.client());
    const seen = await joinAndSpawn(h, a.client, '', { sessionToken: mint('acc-a', nowS() + 600) });
    const token = payloadOf<WelcomePayload>(seen, 'Welcome').reconnectToken;
    const entity = entityOf(h, 0);
    a.client.link.remoteClose(1006);
    await h.step();

    const expired = mint('acc-a', nowS() - 3600);
    const attempts: [string, Record<string, unknown>][] = [
      ['no reconnect token', { sessionToken: expired }],
      ['an unknown reconnect token', { sessionToken: expired, reconnectToken: 'x'.repeat(32) }],
      [
        'a forged token',
        { sessionToken: mint('acc-a', nowS() - 3600, 'w'.repeat(32)), reconnectToken: token },
      ],
      [
        'another session',
        {
          sessionToken: mintToken(
            { accountId: 'acc-a', displayName: 'a', sessionId: 'other', exp: nowS() - 3600 },
            secret,
          ),
          reconnectToken: token,
        },
      ],
    ];
    for (const [label, fields] of attempts) {
      const peer = new Peer(h.client());
      peer.client.hello({ displayName: '', ...fields });
      expect(
        peer.take().map((m) => m.name),
        label,
      ).toEqual(['Rejected']);
      expect(peer.client.link.closedWith?.code, label).toBe(CloseCode.BadToken);
    }
    expect(h.session.players()).toMatchObject([{ playerId: 0, state: PlayerState.Away, entity }]);

    const back = new Peer(h.client());
    back.client.hello({ displayName: '', sessionToken: expired, reconnectToken: token });
    expect(back.names()).toEqual(REBIND_BURST);
    expect(h.session.players()).toMatchObject([
      { playerId: 0, accountId: 'acc-a', state: PlayerState.Playing, entity },
    ]);
  });
});

describe('reconnecting during region loading', () => {
  it('a client still loading some regions gets a FULL snapshot of those it reported, then the others as creates', async () => {
    const { h, a, b, token } = await playingPair();
    a.client.link.remoteClose(1006);
    await run(h, [b], 3);

    const a2 = reconnect(h, token);
    const set = payloadOf<RegionSetPayload>(a2.take(), 'RegionSet');
    const loaded = set.active.filter((id) => id.endsWith('_1'));
    const loading = set.active.filter((id) => !id.endsWith('_1'));
    expect(loaded).toContain(SPAWN_REGION);
    expect(loaded).toHaveLength(3);
    a2.client.regionLoadState(loaded, loading);
    const full = await nextSnapshot(h, a2, [b]);
    expect(full.header).toMatchObject({ baselineTick: 0, flags: SNAPSHOT_FLAG_FULL });
    expect(stateOf(h, full)).toEqual(serverState(h, loaded));

    a2.client.regionLoadState(set.active);
    const rest = await nextSnapshot(h, a2, [b]);
    expect(rest.header).toMatchObject({ baselineTick: full.header.serverTick, flags: 0 });
    expect(rest.creates.map((c) => c.entity)).toEqual(entitiesOf(h, loading));
    expect(a2.mirror.state(h.game.registry)).toEqual(serverState(h, set.active));
  });

  it('while the server still loads regions around the away entity, they reach the rebound client as creates once active', async () => {
    const store = new GatedStore();
    const { h, a, b, token, entity } = await playingPair({
      cols: 8,
      rows: 8,
      hooks: { onPlayerJoin: vi.fn(spawnAt('cell/3_3')) },
      session: { store },
    });
    const column5 = ['cell/5_2', 'cell/5_3', 'cell/5_4'];
    const release = store.hold('get', 'region', (id) => id.startsWith('cell/5_'));
    a.client.link.remoteClose(1006);
    h.session.world.write(entity, Transform).pos.x = CELL + 8; // pushed into cell/4_3 while away
    await run(h, [b], 2); // membership moves it; the next update wants column 5, whose loads wait
    expect(h.session.regions.regionOf(entity)).toBe('cell/4_3');
    for (const id of column5) expect(h.session.regions.state(id)).toBe('loading');
    expect(store.waited).toEqual(column5.map((id) => `get region/${id}`));

    const a2 = reconnect(h, token);
    const burst = a2.take();
    expect(burst.map((m) => m.name)).toEqual(REBIND_BURST);
    const set = payloadOf<RegionSetPayload>(burst, 'RegionSet');
    expect(set.active).toEqual(cellsAround(4, 3, 1));
    expect(payloadOf<SpawnedPayload>(burst, 'Spawned')).toEqual({
      playerId: 0,
      entity,
      regionId: 'cell/4_3',
    });
    a2.client.regionLoadState(set.active); // this client has every region (no assets)
    const full = await nextSnapshot(h, a2, [b]);
    expect(full.header.flags).toBe(SNAPSHOT_FLAG_FULL);
    expect(entitiesOf(h, column5)).toEqual([]);
    expect(stateOf(h, full)).toEqual(serverState(h, set.active));

    release();
    await run(h, [a2, b], 2 * h.game.snapshotEvery);
    for (const id of column5) expect(h.session.regions.state(id)).toBe('active');
    const arrived = entitiesOf(h, column5);
    expect(arrived).toHaveLength(6);
    const later = a2.snapshots.slice(1);
    expect(later.every((s) => s.header.flags === 0)).toBe(true);
    expect(later.flatMap((s) => s.creates.map((c) => c.entity))).toEqual(arrived);
    expect(a2.mirror.state(h.game.registry)).toEqual(serverState(h, set.active));
  });

  it('a link lost before spawn has no grace: its token is dead and a Hello with it joins fresh', async () => {
    const h = await createHarness();
    const a = new Peer(h.client());
    a.client.hello({ displayName: 'a' });
    const token = payloadOf<WelcomePayload>(a.take(), 'Welcome').reconnectToken;
    await h.step(); // the join runs
    a.client.ready();
    expect(a.names()).toEqual(['RegionSet']); // loading, regions not reported yet
    a.client.link.remoteClose(1006);

    const again = reconnect(h, token);
    const burst = again.take();
    expect(burst.map((m) => m.name)).toEqual(['Welcome', 'SessionState']);
    const welcome = payloadOf<WelcomePayload>(burst, 'Welcome');
    expect(welcome.playerId).toBe(1); // slot 0 is freed by the leave, in the next tick
    expect(welcome.reconnectToken).not.toBe(token);
    await h.step();
    expect(h.hooks.onPlayerLeave).toHaveBeenCalledTimes(1);
    expect(h.hooks.onPlayerLeave.mock.calls[0]?.[0]).toMatchObject({
      playerId: 0,
      entity: ENTITY_NONE,
    });
    expect(h.session.players().map((p) => p.playerId)).toEqual([1]);
  });
});

describe('stop()', () => {
  it('kicks every bound link with ServerShutdown and 1001 first, then flushes regions and session state, and resolves after the flush', async () => {
    const store = new GatedStore();
    const onSave = vi.fn(() => new Uint8Array([4, 2]));
    const { h, a, b } = await playingPair({ hooks: { onSave }, session: { store } });
    b.client.link.remoteClose(1006); // away: nothing to send it
    expect(lastPlayers(a.take())[1]).toMatchObject({ playerId: 1, state: PlayerState.Away });
    const pending = new Peer(h.client()); // still handshaking
    const release = store.hold('put', 'save_data');

    let stopped = false;
    const stopping = h.session.stop().then(() => {
      stopped = true;
    });
    for (const peer of [a, pending]) {
      expect(peer.take()).toMatchObject([
        { name: 'Kicked', payload: { reason: KickReason.ServerShutdown } },
      ]);
      expect(peer.client.link.closedWith).toEqual({
        code: CloseCode.Shutdown,
        reason: 'server shutdown',
      });
    }
    expect(onSave).not.toHaveBeenCalled(); // kicked before anything is saved
    expect(h.session.running).toBe(false);

    await settleUntil(() => store.waited.length > 0, 'the session state put');
    expect(store.waited).toEqual([expect.stringMatching(/^put save_data\//)]);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(await store.inner.get('save_manifest', 'current')).toBeNull(); // no partial generation is visible
    await settle();
    expect(stopped).toBe(false);
    expect(await (await openApplicationSave(store.inner)).get('session', 'state')).toBeNull();

    release();
    await stopping;
    expect(await (await openApplicationSave(store.inner)).get('session', 'state')).toEqual(
      new Uint8Array([4, 2]),
    );
    expect(h.hooks.onPlayerLeave).not.toHaveBeenCalled();
    expect(h.session.players()).toEqual([]);
    await h.session.stop(); // idempotent
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('runs the autosaver: started once the session is loaded, its final save is the shutdown flush', async () => {
    const calls: string[] = [];
    let save: (() => Promise<void>) | undefined;
    const player: { client?: TestClient } = {};
    const autosaver: SessionAutosaver = {
      start: vi.fn(() => {
        calls.push('autosaver.start');
      }),
      stop: vi.fn(async () => {
        calls.push(`autosaver.stop (link closed ${player.client?.link.closedWith?.code})`);
        await save?.();
        calls.push('autosaver.stopped');
      }),
    };
    const h = await createHarness({
      start: false,
      hooks: {
        onInit: () => {
          calls.push('onInit');
        },
        onSave: () => {
          calls.push('onSave');
          return new Uint8Array([calls.length]);
        },
      },
      session: {
        autosaver: (fn) => {
          save = fn;
          calls.push('created');
          return autosaver;
        },
      },
    });
    expect(calls).toEqual(['created']);
    await h.session.start();
    expect(calls).toEqual(['created', 'onInit', 'autosaver.start']);

    player.client = h.client();
    await joinAndSpawn(h, player.client, 'a');
    await save?.(); // a periodic save: region blobs and the session blob
    expect(calls.at(-1)).toBe('onSave');
    expect(await (await openApplicationSave(h.store)).list('region')).toContain(SPAWN_REGION);
    expect(await (await openApplicationSave(h.store)).get('session', 'state')).not.toBeNull();

    calls.length = 0;
    await h.session.stop();
    expect(calls).toEqual([
      `autosaver.stop (link closed ${CloseCode.Shutdown})`,
      'onSave',
      'autosaver.stopped',
    ]);
    expect(await (await openApplicationSave(h.store)).get('session', 'state')).toEqual(
      new Uint8Array([2]),
    );
    await h.session.stop();
    expect(autosaver.start).toHaveBeenCalledTimes(1);
    expect(autosaver.stop).toHaveBeenCalledTimes(1);
  });

  it('never overlaps saves: flushes requested while one is in flight run after it, in order', async () => {
    const store = new GatedStore();
    let saves = 0;
    const onSave = vi.fn(() => new Uint8Array([++saves]));
    const h = await createHarness({ hooks: { onSave }, session: { store } });
    const release = store.hold('put', 'save_data');
    const first = h.session.flushAll();
    await settleUntil(() => store.waited.length === 1, 'the first put');
    const second = h.session.flushAll();
    const stopping = h.session.stop();
    for (let i = 0; i < 5; i++) await settle();
    expect(onSave).toHaveBeenCalledTimes(1); // the second save waits for the first to settle
    release();
    await Promise.all([first, second, stopping]);
    expect(onSave).toHaveBeenCalledTimes(2); // explicit flush and shutdown share the pending save
    expect(await (await openApplicationSave(store.inner)).get('session', 'state')).toEqual(
      new Uint8Array([2]),
    );
  });

  it('saves nothing when the load failed, and lets a load in progress finish before saving it', async () => {
    const store = new MemoryStore();
    await store.put('session', 'state', new Uint8Array([9]));
    const onSave = vi.fn(() => new Uint8Array([0]));
    const broken = await createHarness({
      start: false,
      hooks: {
        onLoad: () => {
          throw new Error('corrupt');
        },
        onSave,
      },
      session: { store },
    });
    await expect(broken.session.start()).rejects.toThrow('corrupt');
    await broken.session.flushAll();
    await broken.session.stop();
    expect(onSave).not.toHaveBeenCalled();
    expect(await (await openApplicationSave(store)).get('session', 'state')).toEqual(
      new Uint8Array([9]),
    );

    const gated = new GatedStore();
    await gated.inner.put('session', 'state', new Uint8Array([5]));
    const release = gated.hold('get', 'session');
    const order: string[] = [];
    let save: (() => Promise<void>) | undefined;
    const autosaver: SessionAutosaver = {
      start: vi.fn(),
      stop: vi.fn(async () => {
        order.push('autosaver.stop');
        await save?.();
      }),
    };
    const h = await createHarness({
      start: false,
      hooks: {
        onLoad: (_ctx, blob) => {
          order.push(`onLoad ${blob?.[0]}`);
        },
        onSave: () => {
          order.push('onSave');
          return new Uint8Array([6]);
        },
      },
      session: {
        store: gated,
        autosaver: (fn) => {
          save = fn;
          return autosaver;
        },
      },
    });
    const starting = h.session.start();
    const stopping = h.session.stop();
    await settle();
    expect(order).toEqual([]);
    release();
    await Promise.all([starting, stopping]);
    expect(order).toEqual(['onLoad 5', 'autosaver.stop', 'onSave']);
    expect(autosaver.start).not.toHaveBeenCalled();
    expect(h.session.running).toBe(false);
    expect(await (await openApplicationSave(gated.inner)).get('session', 'state')).toEqual(
      new Uint8Array([6]),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The pure state-machine helpers of client-conn.ts

function playingConn(link = new FakeLink(1)): ClientConn {
  const conn = createConn(link, identity('acc-1', 'one'), 0);
  for (const to of ['joined', 'loading', 'ready', 'playing'] as const) transition(conn, to);
  conn.playerId = 3;
  conn.reconnectToken = 'tok';
  conn.entity = 42;
  return conn;
}

describe('client-conn reconnect helpers', () => {
  it('markAway: playing -> away, the link dropped, the grace started, input released, queues emptied', () => {
    const conn = playingConn();
    conn.inputQueue.push({ frame: { tick: 9 }, seq: 1 });
    conn.held = { tick: 8 };
    conn.pendingEvents.push({ typeId: 0, tick: 8, regionId: undefined, payload: {} });
    conn.outbox.push({
      def: Notice as MessageDef,
      payload: { code: 1 },
      kind: 0,
      bytes: new Uint8Array(2),
    });
    markAway(conn, 1234);
    expect(conn).toMatchObject({
      state: 'away',
      link: null,
      awaySince: 1234,
      inputQueue: [],
      held: undefined,
      pendingEvents: [],
      outbox: [],
      playerId: 3,
      entity: 42,
      reconnectToken: 'tok',
    });
    expect(() => markAway(conn, 2000)).toThrow(ConnStateError);
  });

  it('graceExpired: only an away conn, from exactly graceMs (default RECONNECT_GRACE_MS)', () => {
    const conn = playingConn();
    expect(graceExpired(conn, 1e12)).toBe(false);
    markAway(conn, 1000);
    expect(graceExpired(conn, 1000 + RECONNECT_GRACE_MS - 1)).toBe(false);
    expect(graceExpired(conn, 1000 + RECONNECT_GRACE_MS)).toBe(true);
    expect(graceExpired(conn, 1499, 500)).toBe(false);
    expect(graceExpired(conn, 1500, 500)).toBe(true);
  });

  it('matchesReconnect: the conn token and account, playing or away only', () => {
    const conn = playingConn();
    expect(matchesReconnect(conn, 'tok', 'acc-1')).toBe(true);
    expect(matchesReconnect(conn, 'tok', 'acc-2')).toBe(false);
    expect(matchesReconnect(conn, 'other', 'acc-1')).toBe(false);
    markAway(conn, 0);
    expect(matchesReconnect(conn, 'tok', 'acc-1')).toBe(true);
    transition(conn, 'closed');
    expect(matchesReconnect(conn, 'tok', 'acc-1')).toBe(false);

    const loading = createConn(new FakeLink(2), identity('acc-1', 'one'), 0);
    transition(loading, 'joined');
    transition(loading, 'loading');
    loading.reconnectToken = 'tok';
    expect(matchesReconnect(loading, 'tok', 'acc-1')).toBe(false);
    const handshaking = createConn(new FakeLink(3), identity('acc-1', 'one'), 0);
    expect(matchesReconnect(handshaking, '', 'acc-1')).toBe(false);
  });

  it('rebindConn: takes the link, restarts seqOut, resets replication and the input stream, away -> playing', () => {
    const conn = playingConn();
    Object.assign(conn, {
      seqOut: 500,
      seqIn: 77,
      rttMs: 42,
      baselineTick: 30,
      lastAckedTick: 27,
      fullNext: false,
      regionsReported: true,
      lastInputTick: 90,
      lastInputSeq: 12,
      appliedTick: 29,
      appliedSeq: 11,
      snapshotDivisor: 2,
      snapshotPhase: 1,
    });
    conn.known.add(5);
    conn.sentLog.push({ tick: 30, sentAtMs: 1, bytes: 10 });
    conn.reportedRegions.add('r');
    conn.wantedRegions.add('r');
    conn.prefetchRegions.add('p');
    markAway(conn, 100);

    const link = new FakeLink(9);
    const id = identity('acc-1', 'one');
    rebindConn(conn, link, 1, id, 5000);
    expect(conn).toMatchObject({
      state: 'playing',
      link,
      id: 9,
      seqOut: 0,
      seqIn: 1,
      identity: id,
      awaySince: 0,
      playerId: 3,
      entity: 42,
      reconnectToken: 'tok',
      rttMs: 42,
      baselineTick: 0,
      lastAckedTick: 0,
      lastAckAtMs: 5000,
      sentLog: [],
      fullNext: true,
      regionsReported: false,
      lastInputTick: 0,
      lastInputSeq: 0,
      appliedTick: 0,
      appliedSeq: 0,
      snapshotDivisor: 1,
      snapshotPhase: 0,
    });
    for (const set of [
      conn.known,
      conn.reportedRegions,
      conn.wantedRegions,
      conn.prefetchRegions,
    ]) {
      expect(set.size).toBe(0);
    }
    expect(conn.outstandingSnapshots()).toBe(0);

    rebindConn(conn, new FakeLink(10), 4, id, 6000); // a still-bound playing conn (Replaced)
    expect(conn).toMatchObject({ state: 'playing', id: 10, seqIn: 4, lastAckAtMs: 6000 });

    const joined = createConn(new FakeLink(11), id, 0);
    transition(joined, 'joined');
    expect(() => rebindConn(joined, new FakeLink(12), 1, id, 0)).toThrow(ConnStateError);
    expect(joined.link?.id).toBe(11);
  });
});
