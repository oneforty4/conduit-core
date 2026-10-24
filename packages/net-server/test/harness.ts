import type { SessionToken, TokenVerifier } from '@conduit/auth';
import { devVerifier } from '@conduit/auth';
import { MemoryStore } from '@conduit/persist';
import { SnapshotAssembly } from '@conduit/net-client';
import {
  type CompatibilityDescriptor,
  CoreKind,
  decodeEvents,
  decodeSnapshot,
  decodeSnapshotPart,
  decodeWith,
  defineInput,
  defineMessage,
  encodeWith,
  type EntityId,
  type EventsData,
  f,
  FrameWriter,
  type InputPayload,
  type InputFrameBase,
  type MessageDef,
  readFrame,
  REGION_IDX_NONE,
  type Schema,
  SchemaRegistry,
  type SnapshotData,
} from '@conduit/protocol';
import {
  CORE_COMPONENTS,
  defineComponent,
  defineEvent,
  defineSystem,
  type EventType,
  Name,
  Owner,
  Region,
  RegionChanged,
  type SimContext,
  type System,
  Transform,
} from '@conduit/sim';
import { GridWorld, type RegionLoader, type WorldGraph } from '@conduit/world';
import { vi } from 'vitest';
import {
  type HookContext,
  type PlayerInfo,
  type PlayerSpawn,
  Session,
  type SessionGameDef,
  type SessionHooks,
  type SessionLog,
  type SessionOptions,
  type SessionTimers,
} from '../src/session.ts';
import { FakeLink } from './fake-link.ts';

export const TestInput = defineInput({ tick: f.u32, throttle: f.i8 });
export type TestFrame = ReturnType<typeof TestInput.create>;
export const Crate = defineComponent('Crate', {}, { replicate: true, persist: true });
export const Chat = defineMessage('Chat', 'both', { text: f.str(200) });
export const Shout = defineMessage('Shout', 'c2s', { text: f.str(32) });
export const Notice = defineMessage('Notice', 's2c', { code: f.u16 });
/** A replicated event games emit in a region. */
export const Horn = defineEvent('Horn', { entity: f.entity(), pitch: f.u8 });
/** A replicated event games emit without a region (global). */
export const Weather = defineEvent('Weather', { kind: f.str(16) });
/** A replicated event with a large payload (batches of it do not fit one Events message). */
export const Log = defineEvent('Log', { line: f.str(4096) });

export const SPAWN_REGION = 'cell/1_1';
export const CELL = 64;

export interface TestGameOptions {
  systems?: System[];
  input?: Schema<InputFrameBase>;
  messages?: MessageDef<unknown>[];
  compatibility?: CompatibilityDescriptor;
  protocolVersion?: number;
  tickRate?: number;
  snapshotEvery?: number;
  /** Grid size in cells (`CELL` m each, wanted depth 1); default 4 x 4. */
  cols?: number;
  rows?: number;
}

export function testGame(opts: TestGameOptions = {}): SessionGameDef {
  const components = [...CORE_COMPONENTS, Crate];
  const registry = new SchemaRegistry({
    components,
    messages: opts.messages ?? [Chat, Shout, Notice],
    events: [RegionChanged, Horn, Weather, Log],
    input: opts.input ?? TestInput,
  });
  return {
    id: 'testgame',
    ...(opts.compatibility === undefined ? {} : { compatibility: opts.compatibility }),
    protocolVersion: opts.protocolVersion ?? 3,
    tickRate: opts.tickRate ?? 60,
    snapshotEvery: opts.snapshotEvery ?? 3,
    seed: 0xc0ffee,
    registry,
    input: opts.input ?? TestInput,
    systems: opts.systems ?? [],
    components,
    world: (seed: number): WorldGraph =>
      new GridWorld({
        cellSize: CELL,
        cols: opts.cols ?? 4,
        rows: opts.rows ?? 4,
        wantedDepth: 1,
        worldSeed: seed,
      }),
  };
}

/** `cratesPerRegion` crates at deterministic positions in every region that activates. */
export function crateLoader(cratesPerRegion = 2): RegionLoader & { populated: string[] } {
  const populated: string[] = [];
  return {
    populated,
    populate(region, _blob, ctx) {
      populated.push(region.id);
      const rng = ctx.regionRng(region.id);
      for (let i = 0; i < cratesPerRegion; i++) {
        const e = ctx.world.create();
        ctx.world.add(e, Region, { id: region.id });
        ctx.world.add(e, Transform, {
          pos: { x: 4 + rng.float() * (CELL - 8), y: 0, z: 4 + rng.float() * (CELL - 8) },
        });
        ctx.world.add(e, Crate, {});
      }
    },
  };
}

/** Spawns a player entity at the centre of `SPAWN_REGION`. */
export function spawnPlayer(player: PlayerInfo, ctx: HookContext): EntityId {
  const e = ctx.world.create();
  ctx.world.add(e, Region, { id: SPAWN_REGION });
  ctx.world.add(e, Transform, { pos: { x: 32 + player.playerId, y: 0, z: 32 } });
  ctx.world.add(e, Owner, { player: player.playerId });
  ctx.world.add(e, Name, { value: player.displayName });
  return e;
}

export function defaultHooks(): SessionHooks & {
  onPlayerJoin: ReturnType<typeof vi.fn<(p: PlayerInfo, ctx: HookContext) => PlayerSpawn>>;
  onPlayerLeave: ReturnType<typeof vi.fn<(p: PlayerInfo, ctx: HookContext) => void>>;
} {
  return {
    onPlayerJoin: vi.fn((player: PlayerInfo, _ctx: HookContext): PlayerSpawn => ({
      regionId: SPAWN_REGION,
      spawn: (ctx) => spawnPlayer(player, ctx),
    })),
    onPlayerLeave: vi.fn<(p: PlayerInfo, ctx: HookContext) => void>(),
  };
}

/** A virtual clock whose timers fire in deadline order as it advances. */
export class FakeClock implements SessionTimers {
  ms = 1000;
  private seq = 0;
  private timers: { id: number; at: number; fn: () => void }[] = [];

  now = (): number => this.ms;

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.push({ id, at: this.ms + Math.max(0, ms), fn });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.timers = this.timers.filter((t) => t.id !== handle);
  };

  pending(): number {
    return this.timers.length;
  }

  advance(ms: number): void {
    const end = this.ms + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.timers[0];
      if (next === undefined || next.at > end) break;
      this.timers.shift();
      this.ms = next.at;
      next.fn();
    }
    this.ms = end;
  }
}

export interface Harness {
  session: Session;
  game: SessionGameDef;
  clock: FakeClock;
  hooks: ReturnType<typeof defaultHooks>;
  store: MemoryStore;
  log: ReturnType<typeof vi.fn<SessionLog>>;
  loader: ReturnType<typeof crateLoader>;
  /**
   * `n` times: `session.step()`, advance the clock by one tick, then let pending promises settle
   * (region loads resolve between ticks, as they do under a real loop).
   */
  step(n?: number): Promise<void>;
  /** A `FakeLink` attached with `identity` (gateway path) and the gateway's `tokenExpired` verdict. */
  client(opts?: { identity?: SessionToken; tokenExpired?: boolean }): TestClient;
}

/** Resolves once every queued promise callback has run (a macrotask turn). */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface HarnessOptions extends TestGameOptions {
  hooks?: Partial<SessionHooks>;
  session?: Partial<SessionOptions>;
  verifier?: TokenVerifier | null;
  cratesPerRegion?: number;
  start?: boolean;
}

let nextLinkId = 1;

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const game = testGame(opts);
  const clock = new FakeClock();
  const hooks = { ...defaultHooks(), ...opts.hooks } as ReturnType<typeof defaultHooks>;
  const store = new MemoryStore();
  const log = vi.fn<SessionLog>();
  const loader = crateLoader(opts.cratesPerRegion ?? 2);
  const verifier =
    opts.verifier === null ? undefined : (opts.verifier ?? devVerifier({ warn: () => {} }));
  const session = new Session(game, {
    store,
    regionLoader: loader,
    hooks,
    verifier,
    sessionId: 'dev',
    manualLoop: true,
    now: clock.now,
    timers: clock,
    log,
    ...opts.session,
  });
  if (opts.start !== false) await session.start();
  const tickMs = 1000 / game.tickRate;
  return {
    session,
    game,
    clock,
    hooks,
    store,
    log,
    loader,
    async step(n = 1) {
      for (let i = 0; i < n; i++) {
        session.step();
        clock.advance(tickMs);
        await settle();
      }
    },
    client(clientOpts = {}) {
      const link = new FakeLink(nextLinkId++);
      if (clientOpts.identity !== undefined) {
        session.attach(link, clientOpts.identity, { tokenExpired: clientOpts.tokenExpired });
      } else {
        session.attach(link);
      }
      return new TestClient(game.registry, link, clock.now);
    },
  };
}

export interface ReceivedMessage {
  kind: number;
  name: string;
  tick: number;
  seq: number;
  payload: unknown;
  /** Index of the frame the message arrived in. */
  frame: number;
}

/** The client side of a `FakeLink`: encodes frames into the Session, decodes what it sends back. */
export class TestClient {
  private readonly assembly = new SnapshotAssembly();
  private readonly now: () => number;
  readonly registry: SchemaRegistry;
  readonly link: FakeLink;
  seq = 0;
  private frames = 0;
  private readonly writer = new FrameWriter();

  constructor(registry: SchemaRegistry, link: FakeLink, now: () => number = () => 0) {
    this.now = now;
    this.registry = registry;
    this.link = link;
  }

  frame(messages: { kind: number; schema: Schema<unknown>; payload: unknown }[]): Uint8Array {
    this.writer.begin();
    for (const m of messages) {
      this.writer.message(m.kind, 0, this.seq, (w) => encodeWith(w, m.schema, m.payload));
      this.seq = (this.seq + 1) % 65536;
    }
    return this.writer.finish();
  }

  sendMessage<T>(def: MessageDef<T>, payload: T): void {
    const kind = this.registry.messageKind(def);
    this.link.receive(this.frame([{ kind, schema: def.schema as Schema<unknown>, payload }]));
  }

  private core(name: string, payload: unknown): void {
    const def = this.registry.message(this.registry.messageKind(name)) as MessageDef;
    this.sendMessage(def, payload);
  }

  hello(fields: Partial<Record<string, unknown>> = {}): void {
    this.core('Hello', {
      protocolVersion: 3,
      registryHash: this.registry.hash,
      sessionToken: 'dev',
      reconnectToken: '',
      displayName: 'tester',
      ...fields,
    });
  }

  ready(): void {
    this.core('Ready', {});
  }

  regionLoadState(loaded: string[], loading: string[] = []): void {
    this.core('RegionLoadState', { loaded, loading });
  }

  input(ticks: number[], throttle = 0): void {
    const payload: InputPayload<TestFrame> = {
      firstTick: ticks[0] ?? 0,
      frames: ticks.map((tick) => ({ tick, throttle })),
    };
    this.core('Input', payload);
  }

  ack(lastSnapshotTick: number): void {
    this.core('Ack', { lastSnapshotTick });
  }

  ping(clientTimeMs: number): void {
    this.core('Ping', { clientTimeMs });
  }

  leave(): void {
    this.core('Leave', {});
  }

  /** Decodes and removes everything the Session sent so far. */
  take(): ReceivedMessage[] {
    const out: ReceivedMessage[] = [];
    for (const buf of this.link.take()) {
      const frame = this.frames++;
      readFrame(buf, (h, r) => {
        if (h.kind === CoreKind.SnapshotPart) {
          const payload = this.assembly.accept(decodeSnapshotPart(r), this.now(), this.registry);
          if (payload !== null)
            out.push({
              kind: CoreKind.Snapshot,
              name: 'Snapshot',
              tick: payload.header.serverTick,
              seq: h.seq,
              payload,
              frame,
            });
          return;
        }
        const def = this.registry.message(h.kind);
        const name = def?.name ?? `kind${h.kind}`;
        let payload: unknown;
        if (h.kind === CoreKind.Snapshot) payload = decodeSnapshot(r, this.registry);
        else if (h.kind === CoreKind.Events) payload = decodeEvents(r, this.registry);
        else if (def !== undefined) payload = decodeWith(r, def.schema);
        out.push({ kind: h.kind, name, tick: h.tick, seq: h.seq, payload, frame });
      });
    }
    return out;
  }

  /** Names of `take()`. */
  names(): string[] {
    return this.take().map((m) => m.name);
  }
}

export function payloadOf<T>(messages: ReceivedMessage[], name: string): T {
  const m = messages.find((x) => x.name === name);
  if (m === undefined) throw new Error(`no ${name} in [${messages.map((x) => x.name).join(', ')}]`);
  return m.payload as T;
}

export function snapshotsOf(messages: ReceivedMessage[]): SnapshotData[] {
  return messages.filter((m) => m.kind === CoreKind.Snapshot).map((m) => m.payload as SnapshotData);
}

/** A replicated event as a client received it, with names instead of ids and indices. */
export interface ReceivedEvent {
  name: string;
  tick: number;
  region: string | null;
  payload: unknown;
}

/** Every event of the Events messages in `messages`, in order. */
export function eventsOf(registry: SchemaRegistry, messages: ReceivedMessage[]): ReceivedEvent[] {
  return messages
    .filter((m) => m.kind === CoreKind.Events)
    .flatMap((m) => {
      const data = m.payload as EventsData;
      return data.events.map((ev) => ({
        name: registry.event(ev.eventId)?.name ?? `#${ev.eventId}`,
        tick: ev.tick,
        region: ev.regionIdx === REGION_IDX_NONE ? null : (data.regions[ev.regionIdx] ?? '?'),
        payload: ev.payload,
      }));
    });
}

/** A `sim` system that emits the events scheduled with `at(tick, ...)` during that tick. */
export function scriptedEvents(): {
  system: System;
  at<T>(tick: number, type: EventType<T>, payload: T, regionId?: string): void;
} {
  const byTick = new Map<number, ((ctx: SimContext) => void)[]>();
  return {
    system: defineSystem('scriptedEvents', 'sim', (ctx) => {
      for (const emit of byTick.get(ctx.tick) ?? []) emit(ctx);
    }),
    at(tick, type, payload, regionId) {
      const list = byTick.get(tick) ?? [];
      list.push((ctx) => ctx.events.emit(type, payload, regionId));
      byTick.set(tick, list);
    },
  };
}

/**
 * Drives `client` from attach to playing: Hello, a tick for the join, Ready, RegionLoadState for the
 * RegionSet, ticks until Spawned. Returns everything received on the way.
 */
export async function joinAndSpawn(
  h: Harness,
  client: TestClient,
  displayName = 'tester',
  hello: Partial<Record<string, unknown>> = {},
): Promise<ReceivedMessage[]> {
  const seen: ReceivedMessage[] = [];
  client.hello({ displayName, ...hello });
  await h.step();
  client.ready();
  seen.push(...client.take());
  const regionSet = payloadOf<{ active: string[] }>(seen, 'RegionSet');
  client.regionLoadState(regionSet.active);
  for (let i = 0; i < 10 && !seen.some((m) => m.name === 'Spawned'); i++) {
    await h.step();
    seen.push(...client.take());
  }
  if (!seen.some((m) => m.name === 'Spawned')) throw new Error('client never spawned');
  return seen;
}
