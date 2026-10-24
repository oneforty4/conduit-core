import { devVerifier } from '@conduit/auth';
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
  defineInput,
  ENTITY_NONE,
  type EntityId,
  f,
  type InputPayload,
  REGION_IDX_NONE,
  type Schema,
  SchemaRegistry,
  SNAPSHOT_FLAG_FULL,
  type SnapshotData,
  type SnapshotHeader,
  type WelcomePayload,
} from '@conduit/protocol';
import {
  type ComponentType,
  CORE_COMPONENTS,
  defineSystem,
  Name,
  Owner,
  Region,
  RegionChanged,
  Transform,
} from '@conduit/sim';
import { GridWorld, type RegionLoader } from '@conduit/world';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ClientGameDef,
  INPUT_RING,
  type LogLevel,
  type MemoryLink,
  MemoryTransport,
  NetClient,
  PREDICTION_RING,
  type PredictionOptions,
  type Predictor,
  type PredictorHook,
  RECONNECT_DELAYS_MS,
  type ReconcileView,
  Reconciler,
  ReplicaWorld,
} from '../src/index.ts';
import {
  Chat,
  ManualTimers,
  Notice,
  ScriptedServer,
  Shout,
  TEST_COMPONENTS,
  TestInput,
  testGame,
  testRegistry,
} from './helpers.ts';

type TestFrame = ReturnType<typeof TestInput.create>;

/** The own entity the scripted server spawns, and another one in view. */
const OWN = 1234;
const OTHER = 1300;

afterEach(() => {
  vi.restoreAllMocks();
});

function replicaWorld(registry: SchemaRegistry = testRegistry()): ReplicaWorld {
  return new ReplicaWorld(registry, TEST_COMPONENTS, {
    tickRate: 60,
    snapshotEvery: 3,
    log: () => {},
  });
}

/** An Input message whose frames carry `ticks` (ascending, the newest last) and `throttle`. */
function inputMessage(ticks: number[], throttle = 0): InputPayload<TestFrame> {
  return {
    firstTick: ticks[0] ?? 0,
    frames: ticks.map((tick) => ({ tick, throttle, buttons: 0 })),
  };
}

function header(serverTick: number, lastInputTick = 0, lastInputSeq = 0): SnapshotHeader {
  return {
    serverTick,
    serverTimeMs: Math.round((serverTick * 1000) / 60),
    baselineTick: 0,
    lastInputSeq,
    lastInputTick,
    flags: 0,
  };
}

/** A snapshot at `serverTick` acknowledging `ack`, creating `creates` and destroying `destroys`. */
function snapshotData(
  registry: SchemaRegistry,
  serverTick: number,
  opts: {
    full?: boolean;
    baselineTick?: number;
    creates?: EntityId[];
    destroys?: EntityId[];
    ack?: { tick: number; seq: number };
  } = {},
): SnapshotData {
  const transformId = registry.componentId(Transform);
  return {
    header: {
      ...header(serverTick, opts.ack?.tick ?? 0, opts.ack?.seq ?? 0),
      flags: opts.full === true ? SNAPSHOT_FLAG_FULL : 0,
      baselineTick: opts.full === true ? 0 : (opts.baselineTick ?? 0),
    },
    regions: [],
    creates: (opts.creates ?? []).map((entity) => ({
      entity,
      regionIdx: REGION_IDX_NONE,
      components: [
        {
          id: transformId,
          value: {
            pos: { x: entity % 100, y: 0, z: serverTick % 100 },
            rot: { x: 0, y: 0, z: 0, w: 1 },
            vel: { x: 0, y: 0, z: 0 },
          },
        },
      ],
    })),
    updates: [],
    destroys: opts.destroys ?? [],
  };
}

/** `tick`, `seq` and `throttle` of each pending frame, oldest first. */
function pendingOf(stub: Reconciler): { tick: number; seq: number; throttle: number }[] {
  const out: { tick: number; seq: number; throttle: number }[] = [];
  for (let i = 0; i < stub.pending.length; i++) {
    const p = stub.pending.at(i);
    out.push({ tick: p.tick, seq: p.seq, throttle: (p.frame as TestFrame).throttle });
  }
  return out;
}

/** Everything a replica holds, for deep comparison. */
function replicaState(mirror: ReplicaWorld): unknown {
  return {
    latestTick: mirror.latestTick,
    entities: [...mirror.entities()].map((e) => ({
      id: e.id,
      regionId: e.regionId,
      createdTick: e.createdTick,
      destroyedTick: e.destroyedTick,
      latest: [...e.latest.entries()],
      samples: [...e.samples.entries()].map(([id, ring]) => [
        id,
        Array.from({ length: ring.length }, (_, i) => ring.at(i)),
      ]),
    })),
  };
}

describe('Reconciler (docs/net.md B.10)', () => {
  it('records the newest frame of each Input message with its seq, skips a tick not above the newest recorded, and evicts the oldest frame of a full ring', () => {
    const stub = new Reconciler(TestInput, replicaWorld(), { capacity: 4 });
    stub.onInputSent(inputMessage([100], 1), 3);
    stub.onInputSent(inputMessage([100, 101], 2), 5); // seq 4 went to an Ack in between
    stub.onInputSent(inputMessage([100, 101, 120], 3), 6); // inputTick() jumped ahead
    // InputSender followed the clock back (B.6): the server ignores ticks up to 120 (A.7), and so
    // does the stub.
    stub.onInputSent(inputMessage([103], 4), 7);
    stub.onInputSent(inputMessage([103, 104], 5), 8);
    expect(pendingOf(stub)).toEqual([
      { tick: 100, seq: 3, throttle: 1 },
      { tick: 101, seq: 5, throttle: 2 },
      { tick: 120, seq: 6, throttle: 3 },
    ]);
    stub.onInputSent(inputMessage([103, 104, 121], 6), 9);
    stub.onInputSent(inputMessage([104, 121, 122], 7), 10); // a fifth frame: the oldest goes
    expect(pendingOf(stub)).toEqual([
      { tick: 101, seq: 5, throttle: 2 },
      { tick: 120, seq: 6, throttle: 3 },
      { tick: 121, seq: 9, throttle: 6 },
      { tick: 122, seq: 10, throttle: 7 },
    ]);
    expect(stub.stats()).toEqual({
      pendingFrames: 4,
      lastAckedTick: 0,
      lastAckedSeq: 0,
      authoritativeTick: 0,
      ackedFrames: 0,
      missedFrames: 0,
      droppedFrames: 1,
    });
    expect(() => stub.pending.at(4)).toThrow(RangeError);
    expect(() => stub.pending.at(-1)).toThrow(RangeError);
  });

  it(`keeps ${PREDICTION_RING} frames by default`, () => {
    const stub = new Reconciler(TestInput, replicaWorld());
    for (let tick = 1; tick <= PREDICTION_RING + 3; tick++) {
      stub.onInputSent(inputMessage([tick]), tick);
    }
    expect(stub.stats()).toMatchObject({ pendingFrames: PREDICTION_RING, droppedFrames: 3 });
    expect(stub.pending.at(0).tick).toBe(4);
    expect(() => new Reconciler(TestInput, replicaWorld(), { capacity: 0 })).toThrow(RangeError);
    expect(() => new Reconciler(TestInput, replicaWorld(), { capacity: 2.5 })).toThrow(RangeError);
  });

  it('a snapshot prunes every frame at or below its serverTick, counts those above its lastInputTick as missed, and never lowers the acknowledgement', () => {
    const stub = new Reconciler(TestInput, replicaWorld());
    for (let tick = 10; tick <= 15; tick++) stub.onInputSent(inputMessage([tick]), 2 * tick);
    stub.onSnapshot(header(9), ENTITY_NONE); // before every frame, and no input applied yet
    expect(stub.stats()).toMatchObject({ pendingFrames: 6, lastAckedTick: 0, ackedFrames: 0 });

    stub.onSnapshot(header(12, 12, 24), ENTITY_NONE);
    expect(pendingOf(stub).map((p) => p.tick)).toEqual([13, 14, 15]);
    expect(stub.stats()).toMatchObject({
      pendingFrames: 3,
      lastAckedTick: 12,
      lastAckedSeq: 24,
      ackedFrames: 3,
      missedFrames: 0,
    });

    // The server applied 13, but 14 and 15 came too late: it held 13 through tick 15 (A.7).
    stub.onSnapshot(header(15, 13, 26), ENTITY_NONE);
    expect(stub.stats()).toMatchObject({
      pendingFrames: 0,
      lastAckedTick: 13,
      lastAckedSeq: 26,
      ackedFrames: 6,
      missedFrames: 2,
    });

    // No server sends an older acknowledgement on one connection; the stub keeps the highest.
    stub.onInputSent(inputMessage([16]), 40);
    stub.onSnapshot(header(16, 11, 22), ENTITY_NONE);
    expect(stub.stats()).toMatchObject({
      pendingFrames: 0,
      lastAckedTick: 13,
      lastAckedSeq: 26,
      ackedFrames: 7,
      missedFrames: 3,
    });
  });

  it('sets authoritativeTick only from snapshots holding the local entity alive, and leaves the replica untouched', () => {
    const registry = testRegistry();
    const replica = replicaWorld(registry);
    const stub = new Reconciler(registry.input, replica);
    const apply = (data: SnapshotData, entity: EntityId): void => {
      replica.applySnapshot(data);
      const before = replicaState(replica);
      stub.onSnapshot(data.header, entity);
      expect(replicaState(replica)).toEqual(before);
    };
    // Before the own Spawned there is no local entity.
    apply(snapshotData(registry, 30, { full: true, creates: [OWN, OTHER] }), ENTITY_NONE);
    expect(stub.stats().authoritativeTick).toBe(0);
    apply(snapshotData(registry, 33), OWN); // unchanged components are still the server's values
    expect(stub.stats().authoritativeTick).toBe(33);
    apply(snapshotData(registry, 36, { destroys: [OWN] }), OWN);
    expect(replica.get(OWN)?.destroyedTick).toBe(36);
    expect(stub.stats().authoritativeTick).toBe(33);
    apply(snapshotData(registry, 39), 4321); // not in the replica
    expect(stub.stats().authoritativeTick).toBe(33);
  });

  it('reset forgets the connection (pending frames, newest tick, acknowledgement) and keeps the counters', () => {
    let resets = 0;
    const stub = new Reconciler(TestInput, replicaWorld(), {
      capacity: 2,
      predictor: { reset: () => resets++ },
    });
    stub.onInputSent(inputMessage([500]), 1);
    stub.onInputSent(inputMessage([501]), 2);
    stub.onInputSent(inputMessage([502]), 3); // evicts 500
    stub.onSnapshot(header(501, 501, 2), ENTITY_NONE);
    const before = stub.stats();
    expect(before).toEqual({
      pendingFrames: 1,
      lastAckedTick: 501,
      lastAckedSeq: 2,
      authoritativeTick: 0,
      ackedFrames: 1,
      missedFrames: 0,
      droppedFrames: 1,
    });
    stub.reset();
    expect(stub.stats()).toEqual({
      ...before,
      pendingFrames: 0,
      lastAckedTick: 0,
      lastAckedSeq: 0,
    });
    expect(resets).toBe(1);
    // A new connection starts its seqs over, and a restarted session its ticks.
    stub.onInputSent(inputMessage([7], 9), 4);
    expect(pendingOf(stub)).toEqual([{ tick: 7, seq: 4, throttle: 9 }]);
  });

  it('copies each frame into at most `capacity` frame objects, created once and reused', () => {
    let created = 0;
    const counting: Schema<TestFrame> = {
      ...TestInput,
      create: () => {
        created++;
        return TestInput.create();
      },
    };
    const stub = new Reconciler(counting, replicaWorld(), { capacity: 8 });
    const frame: TestFrame = { tick: 0, throttle: 0, buttons: 0 };
    const objects = new Set<unknown>();
    for (let tick = 1; tick <= 200; tick++) {
      frame.tick = tick;
      frame.throttle = tick % 100;
      stub.onInputSent({ firstTick: tick, frames: [frame] }, tick);
      frame.throttle = -1; // InputSender reuses its frame objects: the stub holds its own copy
      const newest = stub.pending.at(stub.pending.length - 1);
      expect((newest.frame as TestFrame).throttle).toBe(tick % 100);
      objects.add(newest.frame);
      if (tick % 3 === 0) stub.onSnapshot(header(tick - 2, tick - 2, tick - 2), ENTITY_NONE);
    }
    expect(created).toBe(8);
    expect(objects.size).toBe(8);
  });

  it('hands a predictor each recorded frame and, after each snapshot, one reused view whose pending frames are all above serverTick', () => {
    const registry = testRegistry();
    const replica = replicaWorld(registry);
    const sent: { tick: number; seq: number; throttle: number }[] = [];
    const views: unknown[] = [];
    const viewObjects = new Set<ReconcileView>();
    const predictor: Predictor = {
      inputSent: (input) =>
        sent.push({
          tick: input.tick,
          seq: input.seq,
          throttle: (input.frame as TestFrame).throttle,
        }),
      reconcile: (view) => {
        viewObjects.add(view);
        expect(view.replica).toBe(replica);
        const pending: number[] = [];
        for (let i = 0; i < view.pending.length; i++) pending.push(view.pending.at(i).tick);
        for (const tick of pending) expect(tick).toBeGreaterThan(view.serverTick);
        views.push({
          serverTick: view.serverTick,
          ackedTick: view.ackedTick,
          ackedSeq: view.ackedSeq,
          entity: view.entity,
          authoritative: view.authoritative === undefined ? null : view.authoritative.id,
          sameRecord: view.authoritative === replica.get(view.entity),
          pending,
        });
      },
    };
    const stub = new Reconciler(registry.input, replica, { predictor });
    for (let tick = 60; tick <= 65; tick++)
      stub.onInputSent(inputMessage([tick], tick - 59), tick + 100);
    expect(sent.map((s) => [s.tick, s.seq, s.throttle])).toEqual([
      [60, 160, 1],
      [61, 161, 2],
      [62, 162, 3],
      [63, 163, 4],
      [64, 164, 5],
      [65, 165, 6],
    ]);

    const first = snapshotData(registry, 62, {
      full: true,
      creates: [OWN],
      ack: { tick: 61, seq: 161 },
    });
    replica.applySnapshot(first);
    stub.onSnapshot(first.header, OWN);
    const second = snapshotData(registry, 65, { destroys: [OWN], ack: { tick: 65, seq: 165 } });
    replica.applySnapshot(second);
    stub.onSnapshot(second.header, OWN);
    expect(views).toEqual([
      {
        serverTick: 62,
        ackedTick: 61,
        ackedSeq: 161,
        entity: OWN,
        authoritative: OWN,
        sameRecord: true,
        pending: [63, 64, 65],
      },
      {
        serverTick: 65,
        ackedTick: 65,
        ackedSeq: 165,
        entity: OWN,
        authoritative: null, // destroyed at 65
        sameRecord: false,
        pending: [],
      },
    ]);
    expect(viewObjects.size).toBe(1);
  });

  it('reports a throwing predictor hook and carries on as if it had returned', () => {
    const boom = new Error('predictor bug');
    const reported: [unknown, PredictorHook][] = [];
    const throwing: Predictor = {
      inputSent: () => {
        throw boom;
      },
      reconcile: () => {
        throw boom;
      },
      reset: () => {
        throw boom;
      },
    };
    const stub = new Reconciler(TestInput, replicaWorld(), {
      predictor: throwing,
      onPredictorError: (err, hook) => reported.push([err, hook]),
    });
    stub.onInputSent(inputMessage([5]), 1);
    stub.onInputSent(inputMessage([6]), 2);
    stub.onSnapshot(header(5, 5, 1), ENTITY_NONE);
    expect(stub.stats()).toMatchObject({ pendingFrames: 1, lastAckedTick: 5, ackedFrames: 1 });
    stub.reset();
    expect(stub.stats()).toMatchObject({ pendingFrames: 0, lastAckedTick: 0, ackedFrames: 1 });
    expect(reported).toEqual([
      [boom, 'inputSent'],
      [boom, 'inputSent'],
      [boom, 'reconcile'],
      [boom, 'reset'],
    ]);

    // Without onPredictorError the hook's error goes to the console.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    new Reconciler(TestInput, replicaWorld(), { predictor: throwing }).reset();
    expect(consoleError).toHaveBeenCalledWith('[conduit/net-client] predictor.reset threw', {
      err: boom,
    });
  });
});

// --- Through NetClient, against a scripted server (docs/net.md B.3 harness).

type Harness = ReturnType<typeof harness>;

/**
 * A NetClient on manual timers whose connections each get a `ScriptedServer`. Its input schema
 * counts `create` and `copy` calls, so the test sees every input frame object made or filled.
 */
function harness(prediction?: PredictionOptions) {
  const timers = new ManualTimers();
  const counts = { create: 0, copy: 0 };
  const input: Schema<TestFrame> = Object.freeze({
    ...TestInput,
    create: () => {
      counts.create++;
      return TestInput.create();
    },
    copy: (v: TestFrame, out: TestFrame) => {
      counts.copy++;
      return TestInput.copy(v, out);
    },
  });
  const registry = new SchemaRegistry({
    components: TEST_COMPONENTS,
    messages: [Chat, Notice, Shout],
    events: [],
    input,
  });
  const servers: ScriptedServer[] = [];
  const transports: MemoryTransport[] = [];
  const logs: { level: LogLevel; msg: string }[] = [];
  const errors: unknown[] = [];
  const client = new NetClient({
    url: 'memory://session/dev',
    game: testGame(registry),
    token: 'dev-token',
    displayName: 'Ann',
    transport: () => {
      const t = new MemoryTransport({ timers });
      transports.push(t);
      servers.push(new ScriptedServer(t.link, registry));
      return t;
    },
    now: timers.nowFn,
    timers,
    log: (level, msg) => logs.push({ level, msg }),
    prediction,
  });
  client.on('error', (err) => errors.push(err));
  const server = (): ScriptedServer => {
    const s = servers.at(-1);
    if (s === undefined) throw new Error('no connection yet');
    return s;
  };
  return { timers, counts, registry, client, servers, transports, logs, errors, server };
}

async function playing(h: Harness, entity: EntityId = OWN): Promise<void> {
  const p = h.client.connect();
  h.timers.flush();
  h.server().welcome();
  h.timers.flush();
  await p;
  h.server().regionSet(['cell/1_1']);
  h.timers.flush();
  h.server().spawned(2, entity);
  h.timers.flush();
  expect(h.client.state).toBe('Playing');
}

/** A Welcome consistent with the first one (server ms = tick × 1000 / 60). */
function welcomeNow(h: Harness, overrides: Partial<WelcomePayload> = {}): void {
  const serverTick = 120 + Math.round(((h.timers.now - 1000) * 60) / 1000);
  h.server().welcome({
    serverTick,
    serverTimeMs: Math.round((serverTick * 1000) / 60),
    ...overrides,
  });
}

/** Drops the live connection and runs the first backoff: the attempt's Hello arrived. */
function dropAndRetry(h: Harness): ScriptedServer {
  h.transports.at(-1)?.drop(1006);
  h.timers.flush();
  expect(h.client.state).toBe('Reconnecting');
  h.timers.advance(RECONNECT_DELAYS_MS[0]!);
  const s = h.server();
  expect(s.names()).toEqual(['Hello']);
  return s;
}

/** The newest frame's tick and the envelope seq of each Input message `server` received. */
function inputsOf(server: ScriptedServer): { tick: number; seq: number }[] {
  return server.all('Input').map((m) => ({
    tick: (m.payload as InputPayload).frames.at(-1)?.tick ?? -1,
    seq: m.header.seq,
  }));
}

const steer = (throttle: number): TestFrame => ({ tick: 0, throttle, buttons: 0 });

describe('NetClient with the reconciliation stub, scripted server', () => {
  it('is off by default and with enabled: false: no Reconciler, no stats key, no stub work, no input frame beyond InputSender', async () => {
    const methods = ['onInputSent', 'onSnapshot', 'reset', 'stats'] as const;
    const spies = methods.map((m) => vi.spyOn(Reconciler.prototype, m));
    const hookCalls: string[] = [];
    const ignored: Predictor = {
      inputSent: () => hookCalls.push('inputSent'),
      reconcile: () => hookCalls.push('reconcile'),
      reset: () => hookCalls.push('reset'),
    };
    for (const option of [undefined, { enabled: false }, { enabled: false, predictor: ignored }]) {
      const h = harness(option);
      expect(h.client.prediction).toBeNull();
      await playing(h);
      h.client.sendInput(steer(5));
      h.timers.advance(250);
      const inputs = inputsOf(h.server());
      expect(inputs.length).toBeGreaterThan(INPUT_RING);
      const ack = inputs.at(-2)!;
      h.server().snapshot(snapshotData(h.registry, ack.tick, { full: true, creates: [OWN], ack }));
      h.timers.flush();
      expect(h.client.stats().snapshots).toBe(1);
      expect('prediction' in h.client.stats()).toBe(false);
      // Every reset point: the Welcome of a reconnect, disconnect() and connect().
      dropAndRetry(h);
      welcomeNow(h);
      h.timers.flush();
      expect(h.client.state).toBe('Resyncing');
      h.client.disconnect();
      const again = h.client.connect();
      h.client.disconnect();
      await expect(again).rejects.toMatchObject({ kind: 'aborted' });
      // InputSender's own frames only: its pending frame and ring, one copy per sendInput and tick.
      expect(h.counts.create).toBe(2 + INPUT_RING);
      expect(h.counts.copy).toBe(6 + inputs.length);
      expect(h.errors).toEqual([]);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(hookCalls).toEqual([]);
  });

  it('on: the counters follow the scripted acknowledgements, while the client sends the same frames and builds the same replica as with it off', async () => {
    const off = harness();
    const on = harness({ enabled: true });
    const stub = on.client.prediction as Reconciler;
    expect(stub).toBeInstanceOf(Reconciler);
    const both = [off, on];
    for (const h of both) await playing(h);
    expect(on.client.stats().prediction).toEqual({
      pendingFrames: 0,
      lastAckedTick: 0,
      lastAckedSeq: 0,
      authoritativeTick: 0,
      ackedFrames: 0,
      missedFrames: 0,
      droppedFrames: 0,
    });
    for (const h of both) {
      h.client.sendInput(steer(5));
      h.timers.advance(100);
    }
    const inputs = inputsOf(on.server());
    expect(inputsOf(off.server())).toEqual(inputs);
    expect(inputs.length).toBeGreaterThanOrEqual(5);
    expect(inputs.every((input, i) => i === 0 || input.tick > inputs[i - 1]!.tick)).toBe(true);
    // The stub holds a copy of each frame sent, with its Input message's envelope seq.
    expect(pendingOf(stub)).toEqual(inputs.map((i) => ({ ...i, throttle: 5 })));

    // The server applied the third frame and built the snapshot at its tick.
    const third = inputs[2]!;
    for (const h of both) {
      h.server().snapshot(
        snapshotData(h.registry, third.tick, { full: true, creates: [OWN, OTHER], ack: third }),
      );
      h.timers.flush();
    }
    expect(off.client.stats().prediction).toBeUndefined();
    expect(on.client.stats().prediction).toEqual({
      pendingFrames: inputs.length - 3,
      lastAckedTick: third.tick,
      lastAckedSeq: third.seq,
      authoritativeTick: third.tick,
      ackedFrames: 3,
      missedFrames: 0,
      droppedFrames: 0,
    });
    expect(pendingOf(stub).map((p) => p.tick)).toEqual(inputs.slice(3).map((i) => i.tick));

    // Three more client ticks; the next snapshot reaches the newest frame, whose predecessor was
    // the last one applied: the newest was passed over.
    for (const h of both) h.timers.advance(50);
    const more = inputsOf(on.server());
    expect(inputsOf(off.server())).toEqual(more);
    const newest = more.at(-1)!;
    const applied = more.at(-2)!;
    for (const h of both) {
      h.server().snapshot(
        snapshotData(h.registry, newest.tick, {
          ack: applied,
          baselineTick: h.client.mirror.latestTick,
        }),
      );
      h.timers.flush();
    }
    expect(on.client.stats().prediction).toEqual({
      pendingFrames: 0,
      lastAckedTick: applied.tick,
      lastAckedSeq: applied.seq,
      authoritativeTick: newest.tick,
      ackedFrames: more.length,
      missedFrames: 1,
      droppedFrames: 0,
    });

    // Behaviour is identical: the same client messages (headers and payloads), bytes and replica.
    expect(on.server().received).toEqual(off.server().received);
    expect(on.client.stats().bytesOut).toBe(off.client.stats().bytesOut);
    expect(replicaState(on.client.mirror)).toEqual(replicaState(off.client.mirror));
    expect(on.client.state).toBe('Playing');
    // The stub's only input frames: a copy per recorded frame, into one object per ring slot used.
    expect(on.counts.copy).toBe(off.counts.copy + more.length);
    expect(on.counts.create).toBe(off.counts.create + more.length);
    expect([on.errors, off.errors]).toEqual([[], []]);
  });

  it('resets on the Welcome of a resync and of a fresh join, and on disconnect(), keeping its counters', async () => {
    let resets = 0;
    const h = harness({ enabled: true, predictor: { reset: () => resets++ } });
    const stub = h.client.prediction as Reconciler;
    await playing(h);
    expect(resets).toBe(1); // connect()
    h.client.sendInput(steer(3));
    h.timers.advance(100);
    const inputs = inputsOf(h.server());
    const ack = inputs[1]!;
    h.server().snapshot(snapshotData(h.registry, ack.tick, { full: true, creates: [OWN], ack }));
    h.timers.flush();
    const lost = h.client.stats().prediction;
    expect(lost).toMatchObject({
      lastAckedTick: ack.tick,
      authoritativeTick: ack.tick,
      ackedFrames: 2,
    });
    expect(lost?.pendingFrames).toBe(inputs.length - 2);

    // Reconnecting keeps the lost connection's frames until the Welcome, which resets.
    let s = dropAndRetry(h);
    expect(h.client.stats().prediction).toEqual(lost);
    welcomeNow(h);
    h.timers.flush();
    expect(h.client.state).toBe('Resyncing');
    expect(resets).toBe(2);
    expect(h.client.stats().prediction).toEqual({
      ...lost,
      pendingFrames: 0,
      lastAckedTick: 0,
      lastAckedSeq: 0,
      authoritativeTick: 0,
    });

    // The resynced connection: its own seqs and acknowledgements.
    s.regionSet(['cell/1_1']);
    s.spawned(2, OWN);
    s.snapshot(
      snapshotData(h.registry, h.client.clock.serverTickNow(), { full: true, creates: [OWN] }),
    );
    h.timers.flush();
    expect(h.client.state).toBe('Playing');
    h.timers.advance(100);
    const resent = inputsOf(s);
    expect(pendingOf(stub).map(({ tick, seq }) => ({ tick, seq }))).toEqual(resent);
    const resentAck = resent[0]!;
    s.snapshot(
      snapshotData(h.registry, resentAck.tick, {
        ack: resentAck,
        baselineTick: h.client.mirror.latestTick,
      }),
    );
    h.timers.flush();
    expect(h.client.stats().prediction).toMatchObject({
      lastAckedTick: resentAck.tick,
      lastAckedSeq: resentAck.seq,
      authoritativeTick: resentAck.tick,
      pendingFrames: resent.length - 1,
      ackedFrames: 3,
    });

    // A fresh join (the server no longer knew the token) resets too.
    s = dropAndRetry(h);
    s.welcome({ reconnectToken: 'tok-new', serverTick: 30, serverTimeMs: 500 });
    h.timers.flush();
    expect(h.client.state).toBe('Joined');
    expect(resets).toBe(3);
    expect(h.client.stats().prediction).toMatchObject({
      pendingFrames: 0,
      lastAckedTick: 0,
      lastAckedSeq: 0,
      authoritativeTick: 0,
      ackedFrames: 3,
    });
    s.regionSet(['cell/2_2']);
    s.spawned(2, 77);
    h.timers.flush();
    expect(h.client.state).toBe('Playing');
    h.timers.advance(50);
    expect(h.client.stats().prediction?.pendingFrames).toBe(inputsOf(s).length);

    h.client.disconnect();
    expect(resets).toBe(4);
    expect(h.client.prediction).toBe(stub);
    expect(h.client.stats().prediction).toMatchObject({ pendingFrames: 0, lastAckedTick: 0 });
    expect(h.errors).toEqual([]);
  });

  it('logs a throwing predictor at most once per second; the client tick and snapshots carry on', async () => {
    const bug = (): never => {
      throw new Error('predictor bug');
    };
    const h = harness({ enabled: true, predictor: { inputSent: bug, reconcile: bug } });
    const snapshots: number[] = [];
    h.client.on('snapshot', (hdr) => snapshots.push(hdr.serverTick));
    await playing(h);
    for (let i = 0; i < 25; i++) {
      h.timers.advance(100);
      const newest = inputsOf(h.server()).at(-1)!;
      h.server().snapshot(
        snapshotData(h.registry, newest.tick, {
          full: i === 0,
          baselineTick: h.client.mirror.latestTick,
          creates: i === 0 ? [OWN] : [],
          ack: newest,
        }),
      );
      h.timers.flush();
    }
    expect(snapshots).toHaveLength(25);
    expect(h.server().all('Ack')).toHaveLength(25);
    const inputs = inputsOf(h.server());
    expect(inputs.length).toBeGreaterThanOrEqual(145);
    expect(h.client.stats().prediction).toMatchObject({
      pendingFrames: 0,
      lastAckedTick: inputs.at(-1)!.tick,
      ackedFrames: inputs.length,
    });
    const logged = h.logs.filter((l) => l.msg.startsWith('predictor.'));
    expect(logged.length).toBeGreaterThanOrEqual(2);
    expect(logged.length).toBeLessThanOrEqual(3);
    expect(logged[0]).toEqual({ level: 'error', msg: 'predictor.inputSent threw' });
    expect(h.client.state).toBe('Playing');
    expect(h.errors).toEqual([]);
  });
});

// --- Against a real Session: the acknowledgement the server echoes matches what the stub recorded.

const CELL = 64;
const SPAWN_REGION = 'cell/1_1';
const DriveInput = defineInput({ tick: f.u32, throttle: f.i8 });
type DriveFrame = ReturnType<typeof DriveInput.create>;

/** Moves each player's entity along +x at `throttle` m/s while its input says so. */
const drive = defineSystem('drive', 'sim', (ctx) => {
  for (const e of ctx.world.query(Owner, Transform)) {
    const input = ctx.inputs(ctx.world.get(e, Owner).player) as DriveFrame | undefined;
    const throttle = input?.throttle ?? 0;
    if (throttle !== 0) ctx.world.write(e, Transform).pos.x += throttle * ctx.dt;
  }
});

const sessionComponents: ComponentType<unknown>[] = [...CORE_COMPONENTS];
const sessionRegistry = new SchemaRegistry({
  components: sessionComponents,
  messages: [],
  events: [RegionChanged],
  input: DriveInput,
});
const sessionGame: SessionGameDef & ClientGameDef = {
  id: 'prediction',
  protocolVersion: 1,
  tickRate: 60,
  snapshotEvery: 3,
  seed: 42,
  registry: sessionRegistry,
  input: DriveInput,
  systems: [drive],
  components: sessionComponents,
  world: (seed) =>
    new GridWorld({ cellSize: CELL, cols: 4, rows: 4, wantedDepth: 1, worldSeed: seed }),
};
const emptyRegions: RegionLoader = { populate: () => {} };

function spawnAt(player: PlayerInfo): PlayerSpawn {
  return {
    regionId: SPAWN_REGION,
    spawn: (ctx: HookContext): EntityId => {
      const e = ctx.world.create();
      ctx.world.add(e, Region, { id: SPAWN_REGION });
      ctx.world.add(e, Transform, { pos: { x: 20, y: 0, z: 32 } });
      ctx.world.add(e, Owner, { player: player.playerId });
      ctx.world.add(e, Name, { value: player.displayName });
      return e;
    },
  };
}

/** A macrotask turn: the Session's region loads resolve between frames. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('NetClient with the reconciliation stub against a Session', () => {
  it('every lastInputSeq is the seq recorded for lastInputTick; the acknowledged tick advances with pending frames near the input lead; a reconnect starts it over', async () => {
    const timers = new ManualTimers();
    const problems: unknown[] = [];
    const session = new Session(sessionGame, {
      store: new MemoryStore(),
      regionLoader: emptyRegions,
      hooks: { onPlayerJoin: (player) => spawnAt(player) },
      verifier: devVerifier({ warn: () => {} }),
      sessionId: 'dev',
      now: timers.nowFn,
      timers,
      log: (level, msg, data) => {
        if (level !== 'info') problems.push({ level, msg, data });
      },
    });
    await session.start();
    const links: MemoryLink[] = [];
    const transport = MemoryTransport.factory(
      (link) => {
        const asClientLink: ClientLink = link;
        links.push(link);
        session.attach(asClientLink);
      },
      { timers, latencyMs: 10 },
    );

    /** Tick → seq of every frame the stub recorded on the current connection. */
    const seqByTick = new Map<number, number>();
    const predictor: Predictor = {
      inputSent: (input) => seqByTick.set(input.tick, input.seq),
      reset: () => seqByTick.clear(),
    };
    const client = new NetClient({
      url: 'memory://dev',
      game: sessionGame,
      token: 'dev',
      displayName: 'A',
      transport,
      now: timers.nowFn,
      timers,
      prediction: { enabled: true, predictor },
      log: (level, msg, data) => {
        if (level === 'warn' || level === 'error') problems.push({ level, msg, data });
      },
    });
    client.on('error', (err) => problems.push(err));
    const stub = client.prediction as Reconciler;

    const echoes: {
      lastInputTick: number;
      recordedSeq: number | undefined;
      lastInputSeq: number;
    }[] = [];
    const pendingAtSnapshot: number[] = [];
    let lastAcked = 0;
    client.on('snapshot', (h) => {
      const stats = client.stats().prediction;
      if (stats === undefined) throw new Error('prediction stats missing');
      if (h.lastInputTick !== 0) {
        echoes.push({
          lastInputTick: h.lastInputTick,
          recordedSeq: seqByTick.get(h.lastInputTick),
          lastInputSeq: h.lastInputSeq,
        });
      }
      expect(stats.lastAckedTick).toBeGreaterThanOrEqual(lastAcked);
      lastAcked = stats.lastAckedTick;
      for (let i = 0; i < stub.pending.length; i++) {
        expect(stub.pending.at(i).tick).toBeGreaterThan(h.serverTick);
      }
      if (client.state === 'Playing') pendingAtSnapshot.push(stats.pendingFrames);
    });
    const welcomes: unknown[] = [];
    client.on('welcome', () => {
      welcomes.push(client.stats().prediction);
      lastAcked = 0; // a new link: the server's appliedTick starts over (docs/net.md A.6)
    });

    const frame = async (): Promise<void> => {
      timers.advance(16);
      client.update();
      await settle();
    };
    const runUntil = async (done: () => boolean, maxFrames: number): Promise<void> => {
      for (let i = 0; i < maxFrames && !done(); i++) await frame();
      expect(done()).toBe(true);
    };

    const connected = client.connect();
    await runUntil(() => client.state === 'Playing', 300);
    await connected;
    const forward: DriveFrame = { tick: 0, throttle: 4 };
    client.sendInput(forward);
    const startTick = session.tick;
    for (let i = 0; i < 120; i++) await frame();
    expect(client.stats().prediction?.lastAckedTick).toBeGreaterThan(startTick + 100);
    expect(session.world.get(client.entity, Transform).pos.x).toBeGreaterThan(20 + 4 * 1.5);
    // When a snapshot arrives (10 ms after it was built) the frames above its tick are the input
    // lead's, give or take the tick that passed in transit.
    expect(pendingAtSnapshot.length).toBeGreaterThan(30);
    expect(Math.max(...pendingAtSnapshot)).toBeLessThanOrEqual(client.clock.inputLead + 1);

    // --- A reconnect: the Welcome resets the stub, and the new link's acknowledgements start over.
    const seen = echoes.length;
    links.at(-1)!.drop(1006);
    await runUntil(() => client.state === 'Reconnecting', 10);
    await runUntil(() => client.state === 'Playing', 300);
    expect(welcomes).toHaveLength(2);
    expect(welcomes.at(-1)).toMatchObject({ pendingFrames: 0, lastAckedTick: 0, lastAckedSeq: 0 });
    const resumed = session.tick;
    for (let i = 0; i < 60; i++) await frame();
    expect(client.stats().prediction?.lastAckedTick).toBeGreaterThan(resumed + 40);
    expect(echoes.length).toBeGreaterThan(seen);

    for (const echo of echoes) {
      expect(echo.recordedSeq, `seq for tick ${echo.lastInputTick}`).toBe(echo.lastInputSeq);
    }
    expect(Math.max(...pendingAtSnapshot)).toBeLessThanOrEqual(client.clock.inputLead + 1);
    // Every frame arrived in time: none was passed over, on either connection.
    expect(client.stats().prediction).toMatchObject({ missedFrames: 0, droppedFrames: 0 });
    expect(session.stats.staleInputs).toBe(0);
    await session.stop();
    client.disconnect();
    expect(problems).toEqual([]);
  });
});
