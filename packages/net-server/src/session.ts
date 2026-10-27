import { diagnosticNow, observeDiagnostic, type DiagnosticOptions } from '@conduit/math';
import { EgressBudget, type EgressReservation } from './egress-budget.ts';
import {
  ReplicationPlanner,
  ReplicationCapacityError,
  type ReplicationOptions,
  type ReplicationGroup,
} from './replication-planner.ts';
import type { SessionToken, TokenVerifier } from '@conduit/auth';
import {
  GenerationStore,
  type GenerationStoreOptions,
  migrateGameSave,
  validateGameSaveSchema,
  type GameSaveSchema,
  type BlobStore,
} from '@conduit/persist';
import {
  type AckPayload,
  ByteWriter,
  CoreKind,
  DEFAULT_SESSION_CAPACITY,
  QUALIFIED_SESSION_CAPACITY,
  createCompatibilityDescriptor,
  copyCompatibilityDescriptor,
  compatibilityDifferences,
  type CompatibilityDescriptor,
  DecodeError,
  decodeWith,
  EncodeError,
  encodeEvents,
  encodeWith,
  encodeSnapshot,
  encodeSnapshotPart,
  snapshotLimits,
  type SnapshotLimits,
  SNAPSHOT_PART_MAX_DATA,
  SNAPSHOT_PART_HEADER_BYTES,
  ENTITY_NONE,
  type EntityId,
  FrameWriter,
  type HelloPayload,
  type InputFrameBase,
  type InputPayload,
  KickedSchema,
  KickReason,
  MAX_PAYLOAD_BYTES,
  type MessageDef,
  type MessageHeader,
  MESSAGE_HEADER_BYTES,
  nextSeq,
  type PingPayload,
  PlayerState,
  PongSchema,
  readFrame,
  type RegionLoadStatePayload,
  type RegionSetPayload,
  RegionSetSchema,
  RejectedSchema,
  RejectReason,
  type Schema,
  type SchemaRegistry,
  SEQ_MODULO,
  SessionStateSchema,
  type SessionStatePayload,
  type SnapshotData,
  SpawnedSchema,
  utf8Length,
  WelcomeSchema,
} from '@conduit/protocol';
import {
  assertFiniteData,
  captureRegisteredState,
  validateRegisteredState,
  firstStateDifference,
  type SerializedState,
  type StateSerializer,
  type WorldCheckpoint,
  type SimulationCheckpoint,
  cloneExactState,
  encodeExactState,
  type CommandActor,
  type CommandJournal,
  type JournalAction,
  type JournalRecord,
  type ComponentType,
  validateCommandJournal,
  validateJournalAction,
  FixedLoop,
  type InputLog,
  type LifecycleEvent,
  recordInputs,
  type ReplicatedEvent,
  type SimContext,
  Simulation,
  SimulationFault,
  slotOf,
  type SpatialApi,
  type System,
  World,
} from '@conduit/sim';
import {
  InterestPolicy,
  RegionManager,
  BLOB_NAMESPACE,
  decodeBlob,
  encodeBlob,
  type RegionBlob,
  type RegionId,
  type RegionCheckpoint,
  type RegionActivationDecision,
  type RegionLoader,
  SpatialIndex,
  stringCompare,
  type WorldGraph,
} from '@conduit/world';
import { ackTimedOut, halvedRateSkips, shouldSkip, updateDivisor } from './backpressure.ts';
import {
  type ClientConn,
  type ConnState,
  createConn,
  graceExpired,
  markAway,
  matchesReconnect,
  rebindConn,
  recordAck,
  recordSent,
  transition,
} from './client-conn.ts';
import {
  ACK_TIMEOUT_MS,
  CloseCode,
  DEFAULT_MAX_SIMULATION_INTEREST_REGIONS,
  HANDSHAKE_TIMEOUT_MS,
  MAX_GAME_MESSAGES_PER_TICK,
  RECONNECT_GRACE_MS,
  SIMULATION_INTEREST_REGIONS_LIMIT,
} from './constants.ts';
import { eventsData, queueEvent, wantsEvent } from './events-outbox.ts';
import { rejectCloseCode, rejectDetail, resolveIdentity, validateHello } from './hello.ts';
import { acceptInput, drainInput, type InputQueueBounds } from './input-queue.ts';
import type { ClientLink } from './link.ts';
import { ServerClock } from './server-clock.ts';
import { buildSnapshot, commitSnapshot, type SnapshotSource } from './snapshot-builder.ts';
import {
  createStats,
  LatenessHistogram,
  RateMeter,
  type SessionStats,
  TickTimes,
  type WakeLatenessStats,
} from './stats.ts';
import { newReconnectToken } from './tokens.ts';

/** BlobStore namespace and key of the session blob (`onSave`/`onLoad`). */
export const SESSION_STATE_NAMESPACE = 'session';
export const SESSION_STATE_KEY = 'state';

/** Most UTF-8 bytes of a player name on the wire (`PlayerEntry.name`). */
const MAX_NAME_BYTES = 32;

/** The game as the Session needs it; `defineGame`'s output satisfies it (docs/net.md A.5). */
export interface SessionGameDef {
  readonly compatibility?: CompatibilityDescriptor;
  readonly id: string;
  /** u16, checked against `Hello.protocolVersion`. */
  readonly protocolVersion: number;
  /** Sim Hz, integer 1..255 (`Welcome.simTickRate` is a u8). */
  readonly tickRate: number;
  /** Snapshot every Nth tick, integer 1..255. */
  readonly snapshotEvery: number;
  /** u32: the sim's `ctx.rng` seed, `world(seed)` and `Welcome.worldSeed`. */
  readonly seed: number;
  readonly registry: SchemaRegistry;
  readonly input: Schema<InputFrameBase>;
  /** Registered in this order. */
  readonly systems: readonly System[];
  readonly components: readonly ComponentType<unknown>[];
  world(seed: number): WorldGraph;
}

export interface PlayerInfo {
  playerId: number;
  accountId: string;
  displayName: string;
  state: PlayerState;
  /** `ENTITY_NONE` until spawned. */
  entity: EntityId;
}

/** `onPlayerJoin`'s answer: the spawn region now, the entity once that region is active. */
export interface PlayerSpawn {
  regionId: RegionId;
  /** Called once `regionId` is active; must return an alive entity located in an active region. */
  spawn(ctx: HookContext): EntityId;
}

/** The Session's single `SimContext` plus a back-reference; built once in `start()`. */
export interface HookContext extends SimContext {
  readonly session: Session;
}

export interface SessionHooks {
  /** Pure consumer policy; permissions/relevance are applied before these declarations. */
  replicationGroups?(player: PlayerInfo, ctx: HookContext): readonly ReplicationGroup[];
  replicationPriority?(player: PlayerInfo, group: ReplicationGroup, ctx: HookContext): number;
  eventDependencies?(
    player: PlayerInfo,
    event: Readonly<ReplicatedEvent>,
    ctx: HookContext,
  ): readonly EntityId[];
  /** Fresh session: no `session`/`state` blob in the store. */
  onInit?(ctx: HookContext): void;
  /** The `session`/`state` blob exists; `blob` is what `onSave` returned (never `null` in practice). */
  onLoad?(ctx: HookContext, blob: Uint8Array | null): void;
  /** Stored as `session`/`state` by `flushAll`. */
  onSave?(ctx: HookContext): Uint8Array;
  /** Choose the spawn region now; the entity is created later through `PlayerSpawn.spawn`. */
  onPlayerJoin(player: PlayerInfo, ctx: HookContext): PlayerSpawn;
  /** The entity is still alive; the Session destroys it afterwards if it still is. */
  onPlayerLeave?(player: PlayerInfo, ctx: HookContext): void;
  /**
   * A bounded entity moved off the world (docs/world.md 6.1): it was clamped back inside its region
   * during the membership pass of the tick. A throw is logged and the pass goes on.
   */
  onWorldEdge?(entity: EntityId, ctx: HookContext): void;
  /**
   * Entities of `player`'s interest regions (`wanted ∩ reported`) it rejects are not replicated to
   * that player (a known entity it starts rejecting is destroyed on the client). A throw fails that
   * player's snapshot for the tick.
   */
  relevance?(player: PlayerInfo, entity: EntityId, ctx: HookContext): boolean;
  /** c2s/both game messages, dispatched in arrival order before the tick's systems. */
  onMessage?(player: PlayerInfo, def: MessageDef, payload: unknown, ctx: HookContext): void;
  /**
   * Regions the game needs simulated independent of players and pending spawns (docs/net.md A.5,
   * docs/world.md §5.2). Called once per tick between steps, after lifecycle, input intake, game
   * messages and external commands, immediately before `regions.update`, which keeps exactly these
   * regions wanted (not their neighbourhood): they load, stay active and an entity crossing into
   * one waits at the border while it loads instead of being inboxed. Must be a deterministic
   * function of simulation state and must not change it: it is not journaled, and a replay calls it
   * at the same point. The result must be an array of region ids of the world graph, at most
   * `SessionOptions.maxSimulationInterestRegions` distinct ones, in any order; a throw or any other
   * result faults the session. Never changes a client's RegionSet, replication, relevance or
   * permissions. Absent: no interest regions.
   */
  simulationInterest?(ctx: HookContext): readonly RegionId[];
}

export type LogLevel = 'info' | 'warn' | 'error';
/** The same shape as `ServerContext.log` (docs/game.md 2): `data` is extra context or an error. */
export type SessionLog = (level: LogLevel, msg: string, data?: unknown) => void;

export interface SessionTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Periodic saves while the session runs (docs/net.md A.5); `@conduit/persist`'s `Autosaver`
 * (docs/persist.md 1.8) satisfies it.
 */
export interface SessionAutosaver {
  /** Called once `start()` has loaded the session and started the loop. */
  start(): void;
  /**
   * Called once by `stop()`, after the clients were kicked: cancels the periodic saves and performs
   * one final save, which is the shutdown flush (so it never overlaps a periodic one).
   */
  stop(): Promise<void>;
}

export interface SpawnPlanSerializer {
  readonly version: number;
  capture(plan: PlayerSpawn, player: PlayerInfo): unknown;
  validate(value: unknown): void;
  restore(value: unknown, player: PlayerInfo, ctx: HookContext): PlayerSpawn;
}
export interface LogicalPlayerCheckpoint {
  readonly playerId: number;
  readonly actorId: string;
  readonly displayName: string;
  readonly state: ConnState;
  readonly entity: EntityId;
  readonly awaySince: number;
  readonly joinQueued: boolean;
  readonly joinRan: boolean;
  readonly readyPending: boolean;
  readonly spawnQueued: boolean;
  readonly leaveQueued: boolean;
  readonly inputQueue: readonly { readonly frame: InputFrameBase; readonly seq: number }[];
  readonly held: InputFrameBase | undefined;
  readonly appliedTick: number;
  readonly appliedSeq: number;
  readonly lastInputSeq: number;
  readonly lastInputTick: number;
  readonly plan: { readonly version: number; readonly value: unknown } | null;
}
/** Full continuation image, separate from application persist-only world saves. */
export interface ExactSessionCheckpoint {
  readonly kind: 'exact-simulation';
  readonly version: 1;
  readonly completedTick: number;
  readonly generation: number;
  readonly capacity: number;
  readonly stateSchemaHash: number;
  readonly sessionEpoch: string;
  readonly compatibility: CompatibilityDescriptor;
  readonly world: WorldCheckpoint;
  readonly simulation: SimulationCheckpoint;
  readonly regions: RegionCheckpoint;
  readonly session: {
    readonly players: readonly LogicalPlayerCheckpoint[];
    readonly scheduledExternal: readonly ScheduledExternalCommand[];
    readonly externalSequence: number;
    readonly messages: readonly {
      readonly playerId: number;
      readonly name: string;
      readonly payload: unknown;
    }[];
  };
  readonly game: readonly SerializedState[];
}

/** A schema-validated external result; replay invokes the handler, never its original service. */
export interface ExternalCommand {
  readonly name: string;
  readonly schema: Schema<unknown>;
  run(payload: unknown, ctx: HookContext, actor: CommandActor | null): void;
}
export function defineExternalCommand<T>(
  name: string,
  schema: Schema<T>,
  run: (payload: T, ctx: HookContext, actor: CommandActor | null) => void,
): ExternalCommand {
  if (name.length === 0 || typeof run !== 'function')
    throw new TypeError('External command requires name and handler');
  return Object.freeze({
    name,
    schema: schema as Schema<unknown>,
    run: (payload: unknown, ctx: HookContext, actor: CommandActor | null) =>
      run(payload as T, ctx, actor),
  });
}
interface ScheduledExternalCommand {
  readonly tick: number;
  readonly sequence: number;
  readonly name: string;
  readonly payload: unknown;
  readonly actor: CommandActor | null;
}

export interface SessionOptions {
  replication?: ReplicationOptions;
  snapshotLimits?: Partial<SnapshotLimits>;
  diagnostics?: DiagnosticOptions | undefined;
  /** Optional game-owned application-save schema and ordered migrations; legacy saves are v0. */
  saveSchema?: GameSaveSchema;
  saveLimits?: GenerationStoreOptions;
  /** Explicit app-save registry transition; unrelated to live admission or exact replay. */
  saveRegistryAdapter?: (storedHash: number, currentHash: number) => boolean;
  /** Explicit app-save adapter, never used for admission or exact replay. */
  saveCompatibilityAdapter?: (
    stored: CompatibilityDescriptor,
    current: CompatibilityDescriptor,
  ) => boolean;
  sessionEpoch?: string | undefined;
  /** Offline diagnostic mode: no admission, autosaves or live region-load decisions. */
  replayExternal?: boolean | undefined;
  stateSerializers?: readonly StateSerializer[] | undefined;
  spawnPlanSerializer?: SpawnPlanSerializer | undefined;
  /** V2 exact-decision recording; bounded overflow faults rather than silently dropping records. */
  journal?: CommandJournal | undefined;
  /** Explicit simulation-changing c2s/both message declarations. Other messages are unrecorded. */
  simulationMessages?: readonly MessageDef[] | undefined;
  externalCommands?: readonly ExternalCommand[] | undefined;
  inputQueue?: Omit<InputQueueBounds, 'serverTick'> | undefined;
  /**
   * Most distinct regions `hooks.simulationInterest` may return in one tick; more fault the
   * session. Integer in 0..`SIMULATION_INTEREST_REGIONS_LIMIT` (`RangeError` otherwise); default
   * `DEFAULT_MAX_SIMULATION_INTEREST_REGIONS`. A replay of the session must use the same value.
   */
  maxSimulationInterestRegions?: number | undefined;
  /** Receives the first authoritative failure. The session permanently stops stepping. */
  onFault?: ((fault: SimulationFault) => void) | undefined;
  store: BlobStore;
  regionLoader: RegionLoader;
  hooks: SessionHooks;
  /** Required when `attach` is called without an identity (createServer path; docs/persist.md 2.4). */
  verifier?: TokenVerifier | undefined;
  /** Must equal `SessionToken.sessionId` of joiners; default `game.id` (createServer passes 'dev'). */
  sessionId?: string | undefined;
  /** 1..MAX_PLAYERS; default MAX_PLAYERS. */
  maxPlayers?: number | undefined;
  /** Milliseconds; default `performance.now`. */
  now?: (() => number) | undefined;
  /** Handshake timers and the FixedLoop's timers; default the globals. */
  timers?: SessionTimers | undefined;
  /** true: no FixedLoop; tests call `step()`. */
  manualLoop?: boolean | undefined;
  /** How long an away player keeps its slot and entity; ms, >= 0; default `RECONNECT_GRACE_MS`. */
  reconnectGraceMs?: number | undefined;
  /** Default `ACK_TIMEOUT_MS`; ms, >= 0. */
  ackTimeoutMs?: number | undefined;
  /** Default: warnings and errors to the console. */
  log?: SessionLog | undefined;
  /**
   * The Autosaver hookup: called once by the constructor with the save function (`flushAll`: region
   * saves, then `onSave` into `session`/`state`). The Session starts the saver in `start()` and
   * stops it in `stop()`, whose final save is the shutdown flush. For example
   * `autosaver: (save) => new Autosaver(save, AUTOSAVE_INTERVAL_MS, { onError })`.
   */
  autosaver?: ((save: () => Promise<void>) => SessionAutosaver) | undefined;
  /**
   * Replay recording (docs/sim.md 2.11): an empty version 1 log with the game's `seed` and
   * `tickRate` (`RangeError` otherwise). The Session records into it every frame change its steps
   * consume (sim's `recordInputs`), the tick of every lifecycle *join*, *spawn* and *leave* it runs
   * and the ticks its loop drops, so `replay` through `@conduit/game`'s `createReplayRun` rebuilds
   * the session's world.
   */
  recordLog?: InputLog | undefined;
}

/** `Session.attach`'s third argument (gateway path). */
export interface AttachOptions {
  /**
   * The gateway's verdict on `identity`'s token (docs/host.md 17): true when it had expired and the
   * Hello was let through because it carries a reconnect token. Such an identity only rebinds the
   * player its reconnect token names (docs/net.md A.6); a fresh join is `Rejected{BadToken}`.
   * Default (and without an identity): decided from `identity.exp` when the Hello arrives.
   */
  tokenExpired?: boolean | undefined;
}

export interface ClientTickStats {
  playerId: number;
  rttMs: number;
  buffered: number;
  outstanding: number;
  bytesOutPerSec: number;
}

export interface TickStats {
  tick: number;
  players: number;
  entities: number;
  regionsActive: number;
  /** Over the last 64 ticks. */
  tickMsAvg: number;
  tickMsMax: number;
  /** Ticks the FixedLoop dropped (0 with `manualLoop`). */
  dropped: number;
  /**
   * The FixedLoop's `lastLateMs` at the first tick of each wake since `start()`, as a cumulative
   * histogram (no wakes with `manualLoop`).
   */
  wakeLateness: WakeLatenessStats;
  bytesOutPerSec: number;
  perClient: ClientTickStats[];
  /** A copy of the cumulative counters. */
  counters: SessionStats;
}

/**
 * The spatial index slot of the tick tail, structurally: sim's `SpatialApi` plus `rebuild(ctx)`.
 * `Session.spatial`, `@conduit/world`'s `SpatialIndex` (docs/world.md 8.2), satisfies it.
 */
export interface SessionSpatial extends SpatialApi {
  rebuild(ctx: SimContext): void;
}

interface DecodedMessage {
  header: MessageHeader;
  def: MessageDef;
  /** `undefined` when the message is not accepted from clients (s2c kinds); it is ignored. */
  payload: unknown;
}

interface QueuedGameMessage {
  conn: ClientConn;
  def: MessageDef;
  payload: unknown;
}

type Phase = 'faulted' | 'new' | 'starting' | 'running' | 'stopping' | 'stopped';

function defaultNow(): number {
  return performance.now();
}

const DEFAULT_TIMERS: SessionTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function defaultLog(level: LogLevel, msg: string, data?: unknown): void {
  if (level === 'info') return;
  const line = `[conduit/net-server] ${msg}`;
  const out = level === 'error' ? console.error : console.warn;
  if (data === undefined) out(line);
  else out(line, data);
}

/** `name` cut to at most `MAX_NAME_BYTES` UTF-8 bytes on a code point boundary. */
function clipName(name: string): string {
  if (utf8Length(name) <= MAX_NAME_BYTES) return name;
  let out = '';
  for (const ch of name) {
    if (utf8Length(out + ch) > MAX_NAME_BYTES) break;
    out += ch;
  }
  return out;
}

function isInSession(conn: ClientConn): boolean {
  return (
    conn.state === 'joined' ||
    conn.state === 'loading' ||
    conn.state === 'ready' ||
    conn.state === 'playing'
  );
}

function sameSet(set: ReadonlySet<string>, items: readonly string[]): boolean {
  if (set.size !== new Set(items).size) return false;
  for (const item of items) if (!set.has(item)) return false;
  return true;
}

function isSubset(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

/**
 * `SessionOptions.recordLog` must be an empty version 1 log of this game's seed and tick rate: a
 * replay creates its run from them and starts at tick 1.
 */
function checkRecordLog(log: InputLog, game: SessionGameDef): void {
  const raw = log as Partial<InputLog> | null;
  if (typeof raw !== 'object' || raw === null || raw.version !== 1) {
    throw new RangeError('Session: recordLog must be an InputLog of version 1');
  }
  if (raw.seed !== game.seed || raw.tickRate !== game.tickRate) {
    throw new RangeError(
      `Session: recordLog must have the game's seed ${game.seed} and tickRate ${game.tickRate}, got ${String(raw.seed)} and ${String(raw.tickRate)}`,
    );
  }
  if (
    !Array.isArray(raw.entries) ||
    raw.entries.length > 0 ||
    (raw.lifecycle?.length ?? 0) > 0 ||
    (raw.skips?.length ?? 0) > 0
  ) {
    throw new RangeError('Session: recordLog must be empty (no entries, no lifecycle, no skips)');
  }
}

function includesSorted(sorted: readonly string[], id: string): boolean {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((sorted[mid] as string) < id) lo = mid + 1;
    else hi = mid;
  }
  return sorted[lo] === id;
}

/**
 * One authoritative game session (docs/net.md A.5): owns the World, Simulation and RegionManager,
 * drives them from sim's FixedLoop (or `step()` with `manualLoop`), runs the client state machine
 * (A.6), input intake (A.7), snapshots (A.8) and backpressure (A.10) over `ClientLink`s.
 */
interface PendingReplication {
  id: number;
  data: SnapshotData;
  bytes: Uint8Array;
  entities: ReadonlySet<EntityId>;
  chunk: number;
  count: number;
  next: number;
  began: number;
  full: boolean;
  sentBytes: number;
  commit(): void;
}
interface ReplicationPeer {
  link: ClientLink;
  epoch: number;
  limits: Readonly<SnapshotLimits>;
  budget: EgressBudget;
  planner: ReplicationPlanner;
  pending: PendingReplication | null;
  nextId: number;
  sideNeeded: number;
  history: Set<EntityId>;
  stateTicks: Map<EntityId, number>;
  sideTick: number;
  sideEventOffset: number;
  sideMessageOffset: number;
}
interface FrameDelivery {
  reservation: EgressReservation;
  data: boolean;
  onSent?: () => void;
  onDrop?: () => void;
}

export class Session {
  readonly id: string;
  readonly world: World;
  readonly graph: WorldGraph;
  readonly regions: RegionManager;
  readonly simulation: Simulation;
  readonly compatibility: CompatibilityDescriptor;
  readonly sessionEpoch: string;
  /**
   * `ctx.spatial`: per-region grids of `Transform.pos` (docs/world.md 8.2), rebuilt in every step
   * after the membership pass. Queries see positions and regions as of the last rebuild; a region
   * activated since then has an empty grid until the next one. Satisfies `SessionSpatial`.
   */
  readonly spatial: SpatialIndex;
  readonly interest: InterestPolicy;
  /** Cumulative counters (also copied into `tickStats().counters`). */
  readonly stats: SessionStats = createStats();

  private readonly inputQueueBounds: Omit<InputQueueBounds, 'serverTick'>;
  private readonly game: SessionGameDef;
  private readonly registry: SchemaRegistry;
  private readonly hooks: SessionHooks;
  private readonly store: GenerationStore;
  private readonly saveSchema: GameSaveSchema | undefined;
  private readonly saveCompatibilityAdapter: SessionOptions['saveCompatibilityAdapter'];
  private readonly saveRegistryAdapter: SessionOptions['saveRegistryAdapter'];
  private readonly verifier: TokenVerifier | undefined;
  private readonly maxPlayers: number;
  private readonly maxSimulationInterestRegions: number;
  private readonly now: () => number;
  private readonly diagnostics: DiagnosticOptions | undefined;
  private readonly timers: SessionTimers;
  private readonly reconnectGraceMs: number;
  private readonly ackTimeoutMs: number;
  private readonly log: SessionLog;
  private readonly clock: ServerClock;
  private readonly loop: FixedLoop | null;
  private readonly autosaver: SessionAutosaver | null;
  /** `SessionOptions.recordLog`: lifecycle steps are appended to it. */
  private readonly recordLog: InputLog | null;
  private readonly journal: CommandJournal | null;
  private readonly replayExternal: boolean;
  private readonly stateSerializers: readonly StateSerializer[];
  private readonly spawnPlanSerializer: SpawnPlanSerializer | undefined;
  private checkpointGeneration = 0;
  private restorationFailed = false;
  private readonly simulationMessages: ReadonlySet<MessageDef>;
  private readonly externalDefinitions = new Map<string, ExternalCommand>();
  private scheduledExternal: ScheduledExternalCommand[] = [];
  private externalSequence = 0;
  private journalRecords: JournalRecord[] = [];
  private journalRecordCount = 0;
  private journalByteCount = 0;

  private readonly frameBytes = new ByteWriter(4096);
  private readonly frame = new FrameWriter(this.frameBytes);
  private readonly scratch = new ByteWriter(256);
  /** Every attached conn, attach order. */
  private conns: ClientConn[] = [];
  private readonly byLink = new Map<ClientLink, ClientConn>();
  /** Index = playerId. */
  private readonly slots: (ClientConn | null)[];
  private messageQueue: QueuedGameMessage[] = [];
  private readonly baseSource: SnapshotSource;
  private hookCtx: HookContext | null = null;
  private failure: SimulationFault | null = null;
  get fault(): SimulationFault | null {
    return this.failure;
  }
  private readonly onFault: ((fault: SimulationFault) => void) | undefined;
  private pendingCloses: Array<{ link: ClientLink; code: number; reason: string }> = [];
  private pendingFrames: Array<{
    conn: ClientConn;
    link: ClientLink;
    buf: Uint8Array;
    delivery: FrameDelivery;
  }> = [];
  private readonly replicationOptions: ReplicationOptions | undefined;
  private readonly serverSnapshotLimits: Readonly<SnapshotLimits>;
  private readonly replicationPeers = new WeakMap<ClientConn, ReplicationPeer>();
  private readonly linkSnapshotLimits = new WeakMap<ClientLink, Readonly<SnapshotLimits>>();
  private nextReplicationEpoch = 0;
  private phase: Phase = 'new';
  /** `start()`'s load of the session blob, while it is the latest thing `stop()` must wait for. */
  private loading: Promise<void> | null = null;
  /** `onLoad`/`onInit` completed: only a loaded session's state is ever saved. */
  private loaded = false;
  private stopping: Promise<void> | null = null;
  /** The latest `flushAll` call; the next one runs after it settles. */
  private flushing: Promise<void> = Promise.resolve();
  private flushActive = false;
  private flushQueued: Promise<void> | null = null;
  private inTick = false;
  private readonly tickTimes = new TickTimes();
  private readonly wakeLateness = new LatenessHistogram();
  /** `loop.stats().wakes` at the last recorded wake. */
  private lastWake = 0;
  private readonly bytesOut = new RateMeter();
  private readonly connBytesOut = new WeakMap<ClientConn, RateMeter>();
  /** `attach`'s `tokenExpired` per conn: the gateway's verdict on its identity's token. */
  private readonly tokenVerdicts = new WeakMap<ClientConn, boolean>();

  constructor(game: SessionGameDef, opts: SessionOptions) {
    this.replicationOptions = opts.replication;
    this.serverSnapshotLimits = snapshotLimits(opts.snapshotLimits);
    new EgressBudget(opts.replication, 0); // Validate before any session state is allocated.
    new ReplicationPlanner(opts.replication);
    this.diagnostics = opts.diagnostics;
    this.compatibility =
      game.compatibility === undefined
        ? createCompatibilityDescriptor(game.id)
        : copyCompatibilityDescriptor(game.compatibility);
    if (this.compatibility.gameId !== game.id)
      throw new RangeError('Session: compatibility gameId must equal game.id');
    this.journal = opts.journal ?? null;
    this.sessionEpoch =
      opts.sessionEpoch ?? this.journal?.sessionEpoch ?? opts.sessionId ?? game.id;
    this.replayExternal = opts.replayExternal ?? false;
    this.stateSerializers = opts.stateSerializers ?? [];
    this.spawnPlanSerializer = opts.spawnPlanSerializer;
    if (this.replayExternal && opts.autosaver !== undefined)
      throw new TypeError('Diagnostic replay cannot enable autosaving');
    if (this.journal !== null) {
      validateCommandJournal(this.journal, this.compatibility);
      this.journalByteCount = encodeExactState(this.journal).byteLength;
      if (
        this.journal.capacity !== (opts.maxPlayers ?? DEFAULT_SESSION_CAPACITY) ||
        this.journal.stateSchemaHash !== game.registry.stateSchemaHash ||
        this.journal.tickRate !== game.tickRate ||
        this.journal.seed !== game.seed ||
        this.journal.finalTick !== 0 ||
        this.journal.ticks.length !== 0 ||
        this.journal.initialCheckpoint !== null
      )
        throw new TypeError('Session: journal must be empty and match initial game configuration');
    }
    this.simulationMessages = new Set(
      (opts.simulationMessages ?? []).map((definition) => {
        const registered = game.registry.message(game.registry.messageKind(definition));
        if (registered === undefined)
          throw new TypeError(`Unknown simulation command ${definition.name}`);
        return registered;
      }),
    );
    for (const definition of this.simulationMessages) {
      game.registry.messageKind(definition);
      if (definition.core || definition.direction === 's2c' || opts.hooks.onMessage === undefined)
        throw new TypeError(
          `Simulation command ${definition.name} requires a replayable c2s handler`,
        );
    }
    for (const command of opts.externalCommands ?? []) {
      if (this.externalDefinitions.has(command.name))
        throw new TypeError(`Duplicate external command ${command.name}`);
      this.externalDefinitions.set(command.name, command);
    }
    this.inputQueueBounds = { ...opts.inputQueue };
    for (const [name, value, max] of [
      ['maxFutureTicks', opts.inputQueue?.maxFutureTicks ?? 32, 256],
      ['maxStaleTicks', opts.inputQueue?.maxStaleTicks ?? 2, 256],
      ['capacity', opts.inputQueue?.capacity ?? 35, 513],
    ] as const) {
      if (!Number.isInteger(value) || value < (name === 'capacity' ? 1 : 0) || value > max)
        throw new RangeError(`Session: invalid inputQueue.${name}`);
    }
    const maxPlayers = opts.maxPlayers ?? DEFAULT_SESSION_CAPACITY;
    if (
      !Number.isInteger(maxPlayers) ||
      maxPlayers < 1 ||
      maxPlayers > QUALIFIED_SESSION_CAPACITY
    ) {
      throw new RangeError(
        `Session: maxPlayers must be an integer in 1..${QUALIFIED_SESSION_CAPACITY}`,
      );
    }
    const maxInterest =
      opts.maxSimulationInterestRegions ?? DEFAULT_MAX_SIMULATION_INTEREST_REGIONS;
    if (
      !Number.isInteger(maxInterest) ||
      maxInterest < 0 ||
      maxInterest > SIMULATION_INTEREST_REGIONS_LIMIT
    ) {
      throw new RangeError(
        `Session: maxSimulationInterestRegions must be an integer in 0..${SIMULATION_INTEREST_REGIONS_LIMIT}, got ${maxInterest}`,
      );
    }
    for (const [name, value] of [
      ['tickRate', game.tickRate],
      ['snapshotEvery', game.snapshotEvery],
    ] as const) {
      if (!Number.isInteger(value) || value < 1 || value > 255) {
        throw new RangeError(`Session: game.${name} must be an integer in 1..255, got ${value}`);
      }
    }
    for (const [name, value] of [
      ['reconnectGraceMs', opts.reconnectGraceMs],
      ['ackTimeoutMs', opts.ackTimeoutMs],
    ] as const) {
      if (value !== undefined && !(value >= 0)) {
        throw new RangeError(`Session: ${name} must be a number of ms >= 0, got ${value}`);
      }
    }
    const recordLog = opts.recordLog ?? null;
    if (recordLog !== null) checkRecordLog(recordLog, game);
    this.game = game;
    this.registry = game.registry;
    this.hooks = opts.hooks;
    this.store = new GenerationStore(opts.store, opts.saveLimits);
    if (opts.saveSchema !== undefined) validateGameSaveSchema(opts.saveSchema);
    this.saveSchema =
      opts.saveSchema === undefined
        ? undefined
        : Object.freeze({
            ...opts.saveSchema,
            migrations: Object.freeze(
              opts.saveSchema.migrations.map((migration) => Object.freeze({ ...migration })),
            ),
          });
    this.saveCompatibilityAdapter = opts.saveCompatibilityAdapter;
    this.saveRegistryAdapter = opts.saveRegistryAdapter;
    this.verifier = opts.verifier;
    this.maxPlayers = maxPlayers;
    this.maxSimulationInterestRegions = maxInterest;
    this.now = opts.now ?? defaultNow;
    this.timers = opts.timers ?? DEFAULT_TIMERS;
    this.reconnectGraceMs = opts.reconnectGraceMs ?? RECONNECT_GRACE_MS;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    this.log = opts.log ?? defaultLog;
    this.id = opts.sessionId ?? game.id;
    this.slots = new Array<ClientConn | null>(maxPlayers).fill(null);

    this.world = new World(game.registry);
    this.graph = game.world(game.seed);
    this.regions = new RegionManager({
      graph: this.graph,
      world: this.world,
      loader: opts.regionLoader,
      store: this.store,
      tickRate: game.tickRate,
      log: (level, msg, err) => this.log(level, msg, err),
      onWorldEdge: (e) => this.callHook('onWorldEdge', () => this.hooks.onWorldEdge?.(e, this.ctx)),
    });
    this.spatial = new SpatialIndex({
      regions: this.regions,
      world: this.world,
      graph: this.graph,
    });
    this.simulation = new Simulation({
      diagnostics:
        opts.diagnostics === undefined
          ? undefined
          : { observer: opts.diagnostics.observer, now: opts.diagnostics.now ?? this.now },
      world: this.world,
      tickRate: game.tickRate,
      seed: game.seed,
      regionRng: (id) => this.regions.regionRng(id),
      regions: this.regions,
      spatial: this.spatial,
      maxPlayers,
    });
    for (const system of game.systems) this.simulation.register(system);
    // Core postSim tail (docs/sim.md 2.9): membership, then the spatial rebuild, so the grids file
    // every entity under the region membership just gave it.
    this.simulation.tail.push((ctx) => this.regions.membershipSystem.run(ctx));
    this.simulation.tail.push((ctx) => this.spatial.rebuild(ctx));
    // Every step reports the frames it consumes (docs/sim.md 2.11); lifecycle steps are recorded
    // where they run (runLifecycle, runLeave).
    this.recordLog = recordLog;
    if (recordLog !== null) recordInputs(this.simulation, recordLog);
    this.interest = new InterestPolicy({ graph: this.graph, regions: this.regions });
    this.clock = new ServerClock(this.now);

    const stores = this.world.stores();
    this.baseSource = {
      registry: this.registry,
      entitiesIn: (region) => this.regions.entitiesIn(region),
      regionOf: (e) => this.regions.regionOf(e),
      entityAlive: (e) => this.world.alive(e),
      store: (compId) => {
        const store = stores[compId];
        if (store === undefined) throw new RangeError(`Session: no component ${compId}`);
        return store;
      },
      slot: slotOf,
    };

    const timers = opts.timers;
    this.loop =
      opts.manualLoop === true
        ? null
        : new FixedLoop({
            tickRate: game.tickRate,
            onTick: () => {
              this.recordWake();
              this.runTick();
            },
            onOverrun: (n) => this.dropTicks(n),
            now: opts.now,
            setTimeout: timers === undefined ? undefined : (fn, ms) => timers.setTimeout(fn, ms),
            clearTimeout: timers === undefined ? undefined : (h) => timers.clearTimeout(h),
          });
    this.onFault = opts.onFault;
    this.autosaver =
      opts.autosaver?.(() =>
        this.fault === null ? this.flushAll() : this.flushing.catch(() => undefined),
      ) ?? null;
  }

  /** `world.tick`: the last simulated tick. */
  get capacity(): number {
    return this.maxPlayers;
  }

  get tick(): number {
    return this.world.tick;
  }

  /** Valid after `start()`. */
  get ctx(): HookContext {
    if (this.hookCtx === null) throw new Error('Session.ctx is only valid after start()');
    return this.hookCtx;
  }

  /** True between a completed `start()` and `stop()`. */
  get running(): boolean {
    return this.phase === 'running';
  }

  /**
   * Builds the hook context, loads the `session`/`state` blob (`onLoad(ctx, blob)` when present,
   * else `onInit(ctx)`), starts the loop (unless `manualLoop`), then the autosaver. A `stop()` that
   * comes first wins: the load completes, nothing starts, and `stop()` saves what was loaded.
   */
  async start(): Promise<void> {
    if (this.phase !== 'new') throw new Error(`Session.start: session is already ${this.phase}`);
    this.phase = 'starting';
    const ctx = Object.create(this.simulation.ctx, {
      session: { value: this, enumerable: true },
    }) as HookContext;
    this.hookCtx = ctx;
    const loading = this.load(ctx);
    this.loading = loading;
    try {
      await loading;
    } catch (err) {
      if (this.phase === 'starting') this.phase = 'stopped';
      throw err;
    } finally {
      if (this.loading === loading) this.loading = null;
    }
    if (this.phase !== 'starting') return; // stop() was called meanwhile
    this.clock.start();
    this.phase = 'running';
    this.loop?.start();
    if (this.replayExternal)
      this.regions.restoreCheckpoint(this.regions.captureCheckpoint(), this.ctx, {
        replayExternal: true,
      });
    this.autosaver?.start();
  }

  /**
   * Stops the loop, sends `Kicked{ServerShutdown}` and closes 1001 on every bound link (no
   * `onPlayerLeave`, for connected and away players alike), then saves: the autosaver's final save
   * when there is one, else `flushAll()`. Resolves once that save completed (rejects when it
   * failed). A session that never loaded saves nothing. Idempotent.
   */
  stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  /** Runs exactly one tick. Only with `manualLoop`, after `start()`. */
  step(): void {
    if (this.loop !== null) throw new Error('Session.step: only available with manualLoop');
    if (this.phase !== 'running') throw new Error(`Session.step: session is ${this.phase}`);
    this.runTick();
  }

  /**
   * Skips `n` ticks, as the loop does with those it drops (`dropTicks`): none runs, the next step
   * takes the number after them, and a `recordLog` records them. Only with `manualLoop`, after
   * `start()`.
   */
  skip(n: number): void {
    if (this.loop !== null) throw new Error('Session.skip: only available with manualLoop');
    if (this.phase !== 'running') throw new Error(`Session.skip: session is ${this.phase}`);
    this.skipTicks(n);
  }

  /**
   * Binds a client link (docs/net.md A.5): its first message must be `Hello` within
   * `HANDSHAKE_TIMEOUT_MS`. `identity` (gateway path) is authoritative, and `opts.tokenExpired` is
   * the gateway's verdict on its expiry; without it the Hello's token is verified through
   * `SessionOptions.verifier`, and `attach` throws when there is none.
   */
  attach(link: ClientLink, identity?: SessionToken, opts: AttachOptions = {}): void {
    if (this.replayExternal) {
      link.close(CloseCode.SessionNotRunning, 'diagnostic replay');
      return;
    }
    if (this.fault !== null) {
      link.close(CloseCode.SessionFault, 'session faulted');
      return;
    }
    if (identity === undefined && this.verifier === undefined) {
      throw new Error(
        'Session.attach: no identity given and no SessionOptions.verifier to check Hello',
      );
    }
    if (this.byLink.has(link))
      throw new Error(`Session.attach: link ${link.id} is already attached`);
    const conn = createConn(link, identity ?? null, this.now());
    if (identity !== undefined && opts.tokenExpired !== undefined) {
      this.tokenVerdicts.set(conn, opts.tokenExpired);
    }
    this.conns.push(conn);
    this.byLink.set(link, conn);
    conn.handshakeTimer = this.timers.setTimeout(() => {
      conn.handshakeTimer = undefined;
      if (conn.state === 'handshaking' && conn.link === link) {
        this.dropLink(conn, CloseCode.HandshakeTimeout, 'handshake timeout');
      }
    }, HANDSHAKE_TIMEOUT_MS);
    link.onClose(() => {
      const bound = this.byLink.get(link);
      if (bound !== undefined && bound.link === link) this.linkLost(bound);
    });
    link.onMessage((buf) => this.onFrame(link, buf));
  }

  captureCheckpoint(generation = this.checkpointGeneration): ExactSessionCheckpoint {
    if (this.inTick || this.fault !== null || !this.loaded)
      throw new Error('Exact checkpoint requires a healthy loaded completed-tick boundary');
    const players: LogicalPlayerCheckpoint[] = [];
    for (const conn of this.slots) {
      if (conn === null) continue;
      let plan: LogicalPlayerCheckpoint['plan'] = null;
      if (conn.plan !== null && (conn.entity === ENTITY_NONE || conn.spawnQueued)) {
        const adapter = this.spawnPlanSerializer;
        if (adapter === undefined)
          throw new TypeError(
            `Player ${conn.playerId} has a pending spawn closure; register spawnPlanSerializer`,
          );
        const value = cloneExactState(adapter.capture(conn.plan, this.playerInfo(conn)));
        adapter.validate(value);
        plan = { version: adapter.version, value };
      }
      players.push({
        playerId: conn.playerId,
        actorId: conn.identity?.accountId ?? conn.actorId ?? '',
        displayName: conn.displayName,
        state: conn.state,
        entity: conn.entity,
        awaySince: conn.awaySince,
        joinQueued: conn.joinQueued,
        joinRan: conn.joinRan,
        readyPending: conn.readyPending,
        spawnQueued: conn.spawnQueued,
        leaveQueued: conn.leaveQueued,
        inputQueue: conn.inputQueue,
        held: conn.held,
        appliedTick: conn.appliedTick,
        appliedSeq: conn.appliedSeq,
        lastInputSeq: conn.lastInputSeq,
        lastInputTick: conn.lastInputTick,
        plan,
      });
    }
    return cloneExactState({
      kind: 'exact-simulation',
      version: 1,
      completedTick: this.world.tick,
      generation,
      stateSchemaHash: this.registry.stateSchemaHash,
      capacity: this.capacity,
      sessionEpoch: this.sessionEpoch,
      compatibility: this.compatibility,
      world: this.world.captureCheckpoint(),
      simulation: this.simulation.captureCheckpoint(),
      regions: this.regions.captureCheckpoint(),
      session: {
        players,
        scheduledExternal: this.scheduledExternal,
        externalSequence: this.externalSequence,
        messages: this.messageQueue
          .filter((message) => this.simulationMessages.has(message.def))
          .map((message) => ({
            playerId: message.conn.playerId,
            name: message.def.name,
            payload: message.payload,
          })),
      },
      game: captureRegisteredState(this.stateSerializers),
    });
  }

  /** Restoring is deliberately offline; authentication/network state is never resurrected. */
  restoreCheckpoint(input: ExactSessionCheckpoint): void {
    if (this.restorationFailed)
      throw new Error('Checkpoint adapter previously failed; create a fresh offline run');
    if (!this.replayExternal || this.inTick || this.byLink.size !== 0)
      throw new Error('Exact restoration requires an offline diagnostic session');
    const state = cloneExactState(input);
    if (
      state.kind !== 'exact-simulation' ||
      state.version !== 1 ||
      state.capacity !== this.capacity ||
      state.stateSchemaHash !== this.registry.stateSchemaHash ||
      state.completedTick !== state.world.tick ||
      state.completedTick !== state.simulation.tick ||
      state.completedTick !== state.regions.completedTick ||
      state.sessionEpoch !== this.sessionEpoch ||
      firstStateDifference(state.compatibility, this.compatibility) !== null
    )
      throw new TypeError('Exact checkpoint header/compatibility/epoch mismatch');
    const world = new World(this.registry);
    world.restoreCheckpoint(state.world);
    this.simulation.validateCheckpoint(state.simulation);
    this.regions.validateCheckpoint(state.regions, state.world);
    validateRegisteredState(this.stateSerializers, state.game);
    const playerIds = new Set<number>();
    for (const player of state.session.players) {
      if (
        !Number.isInteger(player.playerId) ||
        player.playerId < 0 ||
        player.playerId >= this.slots.length ||
        playerIds.has(player.playerId) ||
        typeof player.actorId !== 'string' ||
        typeof player.displayName !== 'string' ||
        !['joined', 'loading', 'ready', 'playing', 'away', 'closed'].includes(player.state) ||
        (player.entity !== ENTITY_NONE && !world.alive(player.entity))
      )
        throw new TypeError('Invalid exact checkpoint player');
      playerIds.add(player.playerId);
      if (
        !Number.isFinite(player.awaySince) ||
        player.inputQueue.length > 513 ||
        ['joinQueued', 'joinRan', 'readyPending', 'spawnQueued', 'leaveQueued'].some(
          (key) => typeof Reflect.get(player, key) !== 'boolean',
        )
      )
        throw new TypeError('Invalid checkpoint player lifecycle');
      for (const [field, value] of [
        ['appliedSeq', player.appliedSeq],
        ['lastInputSeq', player.lastInputSeq],
      ] as const)
        if (!Number.isInteger(value) || value < 0 || value >= SEQ_MODULO)
          throw new TypeError(`Invalid checkpoint ${field}`);
      if (
        !Number.isSafeInteger(player.appliedTick) ||
        player.appliedTick < 0 ||
        player.appliedTick > state.completedTick ||
        !Number.isSafeInteger(player.lastInputTick) ||
        player.lastInputTick < 0 ||
        player.lastInputTick > state.completedTick + (this.inputQueueBounds.maxFutureTicks ?? 32)
      )
        throw new TypeError('Invalid checkpoint input tick');
      let priorInputTick = -1;
      for (const queued of player.inputQueue) {
        if (
          !Number.isSafeInteger(queued.frame.tick) ||
          queued.frame.tick <= priorInputTick ||
          queued.frame.tick <
            Math.max(0, state.completedTick - (this.inputQueueBounds.maxStaleTicks ?? 2)) ||
          queued.frame.tick > state.completedTick + (this.inputQueueBounds.maxFutureTicks ?? 32)
        )
          throw new TypeError('Invalid checkpoint input queue order/range');
        priorInputTick = queued.frame.tick;
        const writer = new ByteWriter(256);
        encodeWith(writer, this.game.input, queued.frame);
        if (!Number.isInteger(queued.seq) || queued.seq < 0 || queued.seq >= SEQ_MODULO)
          throw new TypeError('Invalid checkpoint queued input sequence');
      }
      if (player.held !== undefined) {
        const writer = new ByteWriter(256);
        encodeWith(writer, this.game.input, player.held);
      }
      if (firstStateDifference(player.held, state.simulation.inputs[player.playerId]) !== null)
        throw new TypeError('Checkpoint player held input differs from simulation');
      if (player.plan !== null) {
        if (
          this.spawnPlanSerializer === undefined ||
          player.plan.version !== this.spawnPlanSerializer.version
        )
          throw new TypeError('Exact checkpoint spawn serializer mismatch');
        this.spawnPlanSerializer.validate(player.plan.value);
      }
    }
    // Cross-check region entity identity and Region values before changing the target.
    const regionType = this.game.components.find((component) => component.name === 'Region');
    for (const record of state.regions.records)
      for (const entity of record.entities) {
        const value = regionType === undefined ? undefined : world.tryGet(entity, regionType);
        if (
          !world.alive(entity) ||
          value === undefined ||
          Reflect.get(value as object, 'id') !== record.id
        )
          throw new TypeError(`Exact checkpoint membership mismatch ${record.id}/${entity}`);
      }
    if (
      !Number.isSafeInteger(state.generation) ||
      state.generation < 0 ||
      !Number.isSafeInteger(state.session.externalSequence) ||
      state.session.externalSequence < 0 ||
      state.session.scheduledExternal.length > 256
    )
      throw new TypeError('Invalid checkpoint generation/external sequence');
    const sequences = new Set<number>();
    let previousCommand: ScheduledExternalCommand | null = null;
    for (const command of state.session.scheduledExternal) {
      const definition = this.externalDefinitions.get(command.name);
      if (
        definition === undefined ||
        !Number.isSafeInteger(command.tick) ||
        command.tick <= state.completedTick ||
        command.tick > state.completedTick + 1024 ||
        !Number.isSafeInteger(command.sequence) ||
        command.sequence < 0 ||
        command.sequence >= state.session.externalSequence ||
        sequences.has(command.sequence) ||
        (previousCommand !== null &&
          (command.tick < previousCommand.tick ||
            (command.tick === previousCommand.tick &&
              command.sequence <= previousCommand.sequence)))
      )
        throw new TypeError(`Invalid or missing external replay handler ${command.name}`);
      sequences.add(command.sequence);
      previousCommand = command;
      const writer = new ByteWriter(256);
      encodeWith(writer, definition.schema, command.payload);
      if (
        command.actor !== null &&
        (!Number.isInteger(command.actor.playerId) ||
          command.actor.playerId < 0 ||
          command.actor.playerId >= this.slots.length ||
          typeof command.actor.actorId !== 'string' ||
          typeof command.actor.displayName !== 'string')
      )
        throw new TypeError('Invalid checkpoint external actor');
    }
    if (state.session.messages.length > this.slots.length * MAX_GAME_MESSAGES_PER_TICK)
      throw new TypeError('Checkpoint message queue limit exceeded');
    for (const message of state.session.messages) {
      const definition = this.registry.messages.find(
        (candidate) => candidate?.name === message.name && this.simulationMessages.has(candidate),
      );
      if (definition === undefined || !playerIds.has(message.playerId))
        throw new TypeError(`Missing simulation message replay handler/player ${message.name}`);
      const writer = new ByteWriter(256);
      encodeWith(writer, definition.schema, message.payload);
    }
    try {
      this.world.restoreCheckpoint(state.world);
      this.simulation.restoreCheckpoint(state.simulation);
      this.regions.restoreCheckpoint(state.regions, this.ctx, { replayExternal: true });
      this.slots.fill(null);
      this.conns = [];
      for (const player of state.session.players) {
        const conn = createConn(null, null, this.now());
        Object.assign(conn, {
          ...player,
          actorId: player.actorId,
          inputQueue: [...player.inputQueue],
          plan: null,
        });
        if (player.plan !== null)
          conn.plan = this.spawnPlanSerializer!.restore(
            player.plan.value,
            this.playerInfo(conn),
            this.ctx,
          );
        this.slots[player.playerId] = conn;
        this.conns.push(conn);
      }
      this.scheduledExternal = [...state.session.scheduledExternal];
      this.externalSequence = state.session.externalSequence;
      this.messageQueue = state.session.messages.map((message) => ({
        conn: this.slots[message.playerId]!,
        def: this.registry.messages.find((definition) => definition?.name === message.name)!,
        payload: message.payload,
      }));
      for (const saved of state.game)
        this.stateSerializers
          .find((serializer) => serializer.name === saved.name)!
          .restore(saved.value);
      this.spatial.rebuild(this.ctx);
      this.checkpointGeneration = state.generation;
      this.failure = null;
      this.phase = 'running';
    } catch (cause) {
      this.restorationFailed = true;
      const failure = new SimulationFault(
        state.completedTick,
        'checkpoint adapter',
        'restore',
        cause,
      );
      this.fail(failure);
      throw failure;
    }
  }

  /** Recorded decisions enter the same pipeline; no client transports or original services exist. */
  applyRecordedAction(action: JournalAction): void {
    if (!this.replayExternal || this.inTick)
      throw new Error('Recorded decisions require offline replay between ticks');
    validateJournalAction(action, this.world.tick + 1, this.capacity);
    if (action.kind === 'connections') {
      for (const player of action.players) {
        const conn = this.slots[player.actor.playerId];
        if (conn === null || conn === undefined) {
          if (player.joinQueued) continue;
          if (player.leaveQueued) continue;
          throw new TypeError('Recorded connection transition without player');
        }
        if (conn.entity !== player.entity)
          throw new TypeError('Recorded connection entity differs from simulation');
        if (!['joined', 'loading', 'ready', 'playing', 'away', 'closed'].includes(player.state))
          throw new TypeError('Invalid recorded connection state');
        conn.state = player.state as ConnState;
        conn.actorId = player.actor.actorId;
        conn.displayName = player.actor.displayName;
        conn.joinQueued = player.joinQueued;
        conn.joinRan = player.joinRan;
        conn.readyPending = player.readyPending;
        conn.spawnQueued = player.spawnQueued;
        conn.leaveQueued = player.leaveQueued;
        conn.inputQueue = cloneExactState([...player.inputQueue]);
      }
      return;
    }
    if (action.kind === 'scheduled-external') {
      for (const command of action.commands) {
        const definition = this.externalDefinitions.get(command.name);
        if (definition === undefined)
          throw new TypeError(`Missing external replay handler ${command.name}`);
        const writer = new ByteWriter(256);
        encodeWith(writer, definition.schema, command.payload);
      }
      this.scheduledExternal = cloneExactState([...action.commands]);
      this.externalSequence = action.nextSequence;
      return;
    }
    if (action.kind === 'region') {
      this.regions.injectDecision(action.decision as RegionActivationDecision);
      return;
    }
    if (action.kind === 'external') {
      if (
        !this.scheduledExternal.some(
          (command) =>
            command.tick <= this.world.tick + 1 &&
            command.name === action.name &&
            firstStateDifference(command.payload, action.payload) === null,
        )
      )
        this.enqueueExternalCommand(action.name, action.payload, { actor: action.actor });
      return;
    }
    if (action.kind === 'lifecycle') {
      let conn = this.slots[action.playerId];
      if (action.event.type === 'join') {
        if (conn !== null && conn !== undefined)
          throw new TypeError('Recorded player already joined');
        conn = createConn(null, null, this.now());
        conn.playerId = action.playerId;
        conn.actorId = action.event.accountId;
        conn.displayName = action.event.displayName;
        conn.state = 'joined';
        conn.joinQueued = true;
        this.slots[action.playerId] = conn;
        this.conns.push(conn);
      } else {
        if (conn === undefined || conn === null) {
          if (action.event.type === 'leave') return;
          throw new TypeError('Recorded spawn without player');
        }
        if (action.event.type === 'spawn') {
          conn.state = 'ready';
          conn.spawnQueued = true;
        } else this.closeAndLeave(conn);
      }
      return;
    }
    const player = action.kind === 'input' ? action.playerId : action.actor.playerId;
    if (!Number.isInteger(player) || player < 0 || player >= this.slots.length)
      throw new TypeError('Invalid recorded player');
    const conn = this.slots[player];
    if (action.kind === 'input') {
      if (action.frame !== undefined) {
        const writer = new ByteWriter(256);
        encodeWith(writer, this.game.input, action.frame);
        if (action.frame.tick > this.world.tick + 1)
          throw new TypeError('Recorded consumed input is in the future');
      }
      if (conn !== null && conn !== undefined) conn.held = cloneExactState(action.frame);
      else if (action.frame !== undefined) throw new TypeError('Recorded input without player');
      return;
    }
    const definition = this.registry.messages.find((message) => message?.name === action.name);
    if (
      definition === undefined ||
      !this.simulationMessages.has(definition) ||
      conn === null ||
      conn === undefined
    )
      throw new TypeError(`Missing simulation message replay handler ${action.name}`);
    this.messageQueue.push({ conn, def: definition, payload: cloneExactState(action.payload) });
  }

  /** Diagnostic disposal has no autosave or account/service writes. */
  disposeReplay(): void {
    if (!this.replayExternal) throw new Error('disposeReplay only supports offline runs');
    this.loop?.stop();
    this.phase = 'stopped';
    this.conns = [];
    this.slots.fill(null);
    this.messageQueue = [];
    this.scheduledExternal = [];
  }

  /** Queue a validated external decision for a future simulation boundary, bounded to 256 pending. */
  enqueueExternalCommand(
    name: string,
    payload: unknown,
    options: { tick?: number; actor?: CommandActor | null } = {},
  ): void {
    if (this.fault !== null) throw this.fault;
    const definition = this.externalDefinitions.get(name);
    if (definition === undefined)
      throw new TypeError(
        `Unknown external command ${name}; register its schema and replay handler`,
      );
    if (
      options.actor !== undefined &&
      options.actor !== null &&
      (!Number.isInteger(options.actor.playerId) ||
        options.actor.playerId < 0 ||
        options.actor.playerId >= this.slots.length ||
        typeof options.actor.actorId !== 'string' ||
        options.actor.actorId.length > 256 ||
        typeof options.actor.displayName !== 'string' ||
        options.actor.displayName.length > 128)
    )
      throw new TypeError('Invalid external command actor');
    const tick = options.tick ?? this.world.tick + 1;
    if (
      !Number.isSafeInteger(tick) ||
      tick <= this.world.tick ||
      tick > this.world.tick + 1024 ||
      this.scheduledExternal.length >= 256
    )
      throw new RangeError('External command queue/tick bound exceeded');
    assertFiniteData(payload, `external command ${name}`);
    const writer = new ByteWriter(256);
    encodeWith(writer, definition.schema, payload);
    const copied = definition.schema.copy(payload, definition.schema.create());
    this.scheduledExternal.push({
      tick,
      sequence: this.externalSequence++,
      name,
      payload: cloneExactState(copied),
      actor: cloneExactState(options.actor ?? null),
    });
    this.scheduledExternal.sort((a, b) => a.tick - b.tick || a.sequence - b.sequence);
  }

  private appendJournal(action: JournalAction): void {
    if (this.journal === null) return;
    if (this.journalRecords.length >= 4096)
      throw new RangeError('Command journal per-tick record budget exceeded');
    validateJournalAction(
      action,
      this.world.stepping ? this.world.tick : this.world.tick + 1,
      this.capacity,
    );
    this.journalRecords.push({
      order: this.journalRecords.length,
      action: cloneExactState(action),
    });
  }

  private commitJournal(tick: number): void {
    if (this.journal === null) return;
    const count = Math.max(1, this.journalRecords.length);
    this.journalByteCount = Math.max(this.journalByteCount, this.journal.encodedBytes);
    const bytes = encodeExactState({ tick, records: this.journalRecords }).byteLength;
    if (
      this.journal.ticks.length >= this.journal.maxTicks ||
      this.journalByteCount + bytes + 1 > this.journal.maxBytes - 4096 ||
      this.journalRecordCount + count > this.journal.maxRecords
    )
      throw new RangeError('Command journal full; exact recording stopped');
    this.journal.ticks.push({ tick, records: this.journalRecords });
    this.journalRecordCount += count;
    this.journalByteCount += bytes + 1;
    this.journal.encodedBytes = this.journalByteCount;
    this.journal.finalTick = tick;
    this.journalRecords = [];
  }

  /** Players holding a slot (away players included, leaving ones not), ascending `playerId`. */
  players(): readonly PlayerInfo[] {
    const out: PlayerInfo[] = [];
    for (const conn of this.slots) {
      if (conn !== null && conn.state !== 'closed') out.push(this.playerInfo(conn));
    }
    return out;
  }

  /**
   * Queues an s2c/both game message for `playerId`'s next frame (the next snapshot, or its own frame
   * at the end of the tick). Throws `RangeError` for a message that is not an s2c/both game message
   * of the registry and `EncodeError` for a payload that does not encode; silently dropped when the
   * player has no connected client.
   */
  send<T>(playerId: number, def: MessageDef<T>, payload: T): void {
    const { kind, bytes } = this.encodeGameMessage(def, payload);
    const conn = this.slots[playerId];
    if (conn === undefined || conn === null || conn.link === null || !isInSession(conn)) return;
    this.queueGameMessage(conn, { def: def as MessageDef, payload, kind, bytes });
  }

  /** `send` to every connected player. */
  broadcast<T>(def: MessageDef<T>, payload: T): void {
    const { kind, bytes } = this.encodeGameMessage(def, payload);
    for (const conn of this.slots) {
      if (conn === null || conn.link === null || !isInSession(conn)) continue;
      this.queueGameMessage(conn, { def: def as MessageDef, payload, kind, bytes });
    }
  }

  private queueGameMessage(conn: ClientConn, message: ClientConn['outbox'][number]): void {
    const bytes = conn.outbox.reduce((sum, entry) => sum + entry.bytes.byteLength, 0);
    if (conn.outbox.length >= 1024 || bytes + message.bytes.byteLength > 1024 * 1024) {
      if (conn.link !== null)
        this.failReplication(conn, conn.link, 'game message queue capacity exceeded');
      return;
    }
    conn.outbox.push(message);
  }

  /** Sends `Kicked{reason}`, closes the link with 4011 and queues *leave* (no reconnect grace). */
  kick(playerId: number, reason: KickReason): void {
    const conn = this.slots[playerId];
    if (conn === undefined || conn === null || conn.state === 'closed') return;
    const link = conn.link;
    if (link !== null) {
      this.unbind(conn);
      this.sendOn(link, conn, CoreKind.Kicked, KickedSchema, { reason });
    }
    this.closeAndLeave(conn);
    if (link !== null) this.closeTransport(link, CloseCode.Kicked, 'kicked');
  }

  tickStats(): TickStats {
    const now = this.now();
    const perClient: ClientTickStats[] = [];
    for (const conn of this.slots) {
      if (conn === null || conn.state === 'closed') continue;
      perClient.push({
        playerId: conn.playerId,
        rttMs: conn.rttMs,
        buffered: conn.link?.bufferedAmount() ?? 0,
        outstanding: conn.outstandingSnapshots(),
        bytesOutPerSec: this.connBytesOut.get(conn)?.perSecond(now) ?? 0,
      });
    }
    return {
      tick: this.world.tick,
      players: perClient.length,
      entities: this.world.count(),
      regionsActive: this.regions.active().length,
      tickMsAvg: this.tickTimes.average(),
      tickMsMax: this.tickTimes.max(),
      dropped: this.loop?.stats().droppedTicks ?? 0,
      wakeLateness: this.wakeLateness.stats(),
      bytesOutPerSec: this.bytesOut.perSecond(now),
      perClient,
      counters: { ...this.stats },
    };
  }

  /**
   * `regions.flushAll()`, then `onSave` into the store's `session`/`state` (skipped until `start()`
   * has loaded the session, so state that was never loaded never overwrites the stored blob). Calls
   * never overlap: one made while another is in flight runs after it settles, so everything written
   * before the call is in what it saves. The save function handed to `SessionOptions.autosaver`.
   */
  flushAll(): Promise<void> {
    if (this.fault !== null) return Promise.reject(this.fault);
    if (this.flushQueued !== null) return this.flushQueued;
    if (this.flushActive) {
      const queued = this.flushing
        .catch(() => undefined)
        .then(() => {
          this.flushQueued = null;
          return this.startFlush();
        });
      this.flushQueued = queued;
      return queued;
    }
    return this.startFlush();
  }

  private startFlush(): Promise<void> {
    this.flushActive = true;
    const run = Promise.resolve()
      .then(() => (this.diagnostics === undefined ? this.flushOnce() : this.observedFlush()))
      .finally(() => {
        this.flushActive = false;
      });
    this.flushing = run;
    return run;
  }

  private async observedFlush(): Promise<void> {
    const diagnostics = this.diagnostics!;
    const started = diagnosticNow(diagnostics.now ?? this.now);
    let failed = false;
    try {
      await this.flushOnce();
    } catch (cause) {
      failed = true;
      throw cause;
    } finally {
      this.observeSave('total', started, failed);
    }
  }

  private observeSave(name: string, started: number | undefined, failed = false): void {
    const diagnostics = this.diagnostics;
    if (diagnostics === undefined) return;
    const ended = diagnosticNow(diagnostics.now ?? this.now);
    if (ended !== undefined)
      observeDiagnostic(diagnostics.observer, {
        version: 1,
        category: 'save',
        name,
        timeMs: ended,
        tick: this.world.tick,
        durationMs: started === undefined ? undefined : Math.max(0, ended - started),
        status: failed ? 'error' : started === undefined || ended < started ? 'unavailable' : 'ok',
      });
  }

  /** The `session`/`state` blob into `onLoad`, or `onInit` without one. */
  private async load(ctx: HookContext): Promise<void> {
    const manifest = await this.store.open();
    if (
      this.journal !== null &&
      (manifest !== null || (await this.store.list('region')).length > 0)
    )
      throw new Error(
        'Exact journaling an existing application save requires an initial exact checkpoint adapter; application save is not an exact checkpoint',
      );
    if (manifest !== null) {
      if (
        manifest.stateSchemaHash !== this.registry.stateSchemaHash &&
        this.saveRegistryAdapter?.(manifest.stateSchemaHash, this.registry.stateSchemaHash) !== true
      )
        throw new Error(
          'Session: saved state schema hash mismatch; an explicit application-save migration adapter is required',
        );
      const stored = copyCompatibilityDescriptor(manifest.compatibility as CompatibilityDescriptor);
      const differences = compatibilityDifferences(this.compatibility, stored);
      if (
        differences.length > 0 &&
        this.saveCompatibilityAdapter?.(stored, copyCompatibilityDescriptor(this.compatibility)) !==
          true
      )
        throw new Error(`Session: saved compatibility mismatch: ${differences.join(', ')}`);
    }
    const storedVersion = manifest?.gameSaveVersion ?? 0;
    if (storedVersion > (this.saveSchema?.version ?? 0))
      throw new Error('Session: newer game save schema requires a migration adapter');
    const blob = await this.store.get(SESSION_STATE_NAMESPACE, SESSION_STATE_KEY);
    if (this.journal !== null && blob !== null)
      throw new Error(
        'Exact journaling an existing application save requires an initial exact checkpoint adapter; application save is not an exact checkpoint',
      );
    if (blob !== null)
      this.hooks.onLoad?.(
        ctx,
        this.saveSchema === undefined
          ? blob
          : migrateGameSave(blob, storedVersion, this.saveSchema),
      );
    else this.hooks.onInit?.(ctx);
    this.loaded = true;
  }

  private async flushOnce(): Promise<void> {
    if (this.fault !== null) throw this.fault;
    if (this.inTick) throw new Error('Session.flushAll: capture requires a tick boundary');
    if (!this.loaded) return;
    await this.regions.waitForSaves();
    if (this.fault !== null) throw this.fault;
    if (this.inTick) throw new Error('Session.flushAll: capture requires a tick boundary');
    const ctx = this.hookCtx;
    const captureStarted =
      this.diagnostics === undefined ? undefined : diagnosticNow(this.diagnostics.now ?? this.now);
    // Both captures are synchronous at this same completed boundary, before the first I/O await.
    const regions = this.regions.captureSave();
    const capturedValue = ctx !== null && this.loaded ? this.hooks.onSave?.(ctx) : undefined;
    const captured = capturedValue === undefined ? undefined : new Uint8Array(capturedValue);
    if (captured !== undefined && this.saveSchema !== undefined)
      this.saveSchema.validate(this.saveSchema.version, new Uint8Array(captured));
    const image = this.store.capture(
      regions.completedTick,
      this.compatibility,
      [
        ...regions.writes.map((write) => ({
          namespace: BLOB_NAMESPACE,
          key: write.id,
          bytes: write.bytes,
        })),
        ...(captured === undefined
          ? []
          : [{ namespace: SESSION_STATE_NAMESPACE, key: SESSION_STATE_KEY, bytes: captured }]),
      ],
      this.saveSchema?.version ?? 0,
      this.registry.stateSchemaHash,
    );
    this.observeSave('capture', captureStarted);
    const publicationStarted =
      this.diagnostics === undefined ? undefined : diagnosticNow(this.diagnostics.now ?? this.now);
    const merged = new Map<string, RegionBlob>();
    for (const arrival of regions.arrivals) {
      const base =
        arrival.base ??
        decodeBlob(await this.store.readCaptured(image, BLOB_NAMESPACE, arrival.id));
      const blob: RegionBlob =
        base === null || base.inboxOnly === true
          ? {
              version: 1,
              savedTick: regions.completedTick,
              entities: [...(base?.entities ?? []), ...arrival.entities],
              rngState: arrival.seed >>> 0,
              inboxOnly: true,
            }
          : {
              ...base,
              savedTick: regions.completedTick,
              entities: [...base.entities, ...arrival.entities],
            };
      merged.set(arrival.id, blob);
      image.writes.push({ namespace: BLOB_NAMESPACE, key: arrival.id, bytes: encodeBlob(blob) });
    }
    // An earlier valid detached image may finish after a later tick faults; it remains valid.
    await this.store.publish(image);
    regions.acknowledge(merged);
    this.observeSave('publication', publicationStarted);
  }

  // ---------------------------------------------------------------------------------------------
  // Tick pipeline (docs/net.md A.5, docs/sim.md 2.9)

  private runTick(): void {
    if (this.phase !== 'running' || this.inTick) return;
    this.inTick = true;
    if (this.journal !== null) this.journalRecords = [];
    const t = this.world.tick + 1;
    const startMs = this.clock.tickStart();
    const diagnosticStart =
      this.diagnostics === undefined ? undefined : diagnosticNow(this.diagnostics.now ?? this.now);
    const ctx = this.ctx;
    const log = this.recordLog;
    const entries = log?.entries.length ?? 0;
    const lifecycle = log?.lifecycle?.length ?? 0;
    try {
      if (this.journal !== null) {
        this.appendJournal({
          kind: 'connections',
          players: this.slots
            .filter((conn): conn is ClientConn => conn !== null)
            .map((conn) => ({
              actor: {
                playerId: conn.playerId,
                actorId: conn.identity?.accountId ?? conn.actorId ?? '',
                displayName: conn.displayName,
              },
              state: conn.state,
              entity: conn.entity,
              joinQueued: conn.joinQueued,
              joinRan: conn.joinRan,
              readyPending: conn.readyPending,
              spawnQueued: conn.spawnQueued,
              leaveQueued: conn.leaveQueued,
              inputQueue: conn.inputQueue,
            })),
        });
        this.appendJournal({
          kind: 'scheduled-external',
          commands: this.scheduledExternal,
          nextSequence: this.externalSequence,
        });
      }
      this.guard(t, 'lifecycle', () => this.runLifecycle(t));
      this.guard(t, 'input', () => this.intake(t));
      this.guard(t, 'regions.update', () => {
        const interest = this.simulationInterest();
        this.regions.update(this.playerEntities(), ctx, this.pendingSpawnRegions(), interest);
      });
      if (this.journal !== null)
        for (const decision of this.regions.drainDecisions())
          this.appendJournal({ kind: 'region', decision });
      this.guard(t, 'simulation.step', () => this.simulation.step(t));
      this.guard(t, 'events', () => this.queueEvents());
      if (t % this.game.snapshotEvery === 0) this.guard(t, 'snapshots', () => this.snapshots(t));
      this.guard(t, 'outbox', () => this.flushOutboxes());
      this.commitJournal(t);
      const pending = this.pendingFrames;
      const closes = this.pendingCloses;
      this.pendingFrames = [];
      this.pendingCloses = [];
      this.inTick = false;
      for (const item of pending) {
        try {
          this.sendFrame(item.conn, item.link, item.buf, item.delivery);
        } catch (err) {
          item.delivery.reservation.refund();
          item.delivery.onDrop?.();
          this.failedDelivery(item.conn, item.link, err);
        }
      }
      for (const close of closes) {
        try {
          close.link.close(close.code, close.reason);
        } catch (err) {
          this.log('error', 'client close failed', err);
        }
      }
    } catch (cause) {
      for (const frame of this.pendingFrames) {
        frame.delivery.reservation.refund();
        frame.delivery.onDrop?.();
      }
      const quarantinedLinks = new Set([
        ...this.pendingFrames.map((item) => item.link),
        ...this.pendingCloses.map((item) => item.link),
      ]);
      this.pendingFrames = [];
      this.pendingCloses = [];
      for (const link of quarantinedLinks) {
        try {
          link.close(CloseCode.SessionFault, 'session faulted');
        } catch {
          /* already gone */
        }
      }
      if (log !== null) {
        log.entries.length = entries;
        if (log.lifecycle !== undefined) log.lifecycle.length = lifecycle;
      }
      if (this.journal !== null) this.journalRecords = [];
      this.fail(
        cause instanceof SimulationFault
          ? cause
          : new SimulationFault(t, 'session', 'authoritative', cause),
      );
    } finally {
      this.inTick = false;
      this.tickTimes.record(this.now() - startMs);
      const diagnostics = this.diagnostics;
      if (diagnostics !== undefined) {
        const ended = diagnosticNow(diagnostics.now ?? this.now);
        if (ended !== undefined) {
          observeDiagnostic(diagnostics.observer, {
            version: 1,
            category: 'pipeline',
            name: 'tick',
            timeMs: ended,
            tick: t,
            durationMs:
              diagnosticStart === undefined || ended < diagnosticStart
                ? undefined
                : ended - diagnosticStart,
            status: this.fault === null ? 'ok' : 'error',
          });
          observeDiagnostic(diagnostics.observer, {
            version: 1,
            category: 'input',
            name: 'missing-total',
            timeMs: ended,
            tick: t,
            value: this.stats.missingInputs,
            unit: 'count',
          });
          observeDiagnostic(diagnostics.observer, {
            version: 1,
            category: 'input',
            name: 'overflow-total',
            timeMs: ended,
            tick: t,
            value: this.stats.inputOverflow,
            unit: 'count',
          });
        }
      }
    }
  }

  /**
   * The loop fell so far behind that it drops `n` ticks (docs/sim.md 2.10): the world skips them,
   * none run, and the next tick takes the number its time gives it. So ticks keep to the server's
   * clock, onto which each client maps them (docs/net.md B.4): numbered on from where the loop
   * stalled, every later tick would lag the clock by the stall, every client would draw ahead of
   * the snapshots it gets and send its inputs for ticks that far ahead, held at their last until the
   * server came up to them. Recorded, so a replay skips them too.
   */
  private dropTicks(n: number): void {
    this.log('warn', 'dropped ticks', { n });
    if (this.phase === 'running' && !this.inTick) this.skipTicks(n);
  }

  /** `n` ticks numbered and never run (`Simulation.skip`), recorded for a replay. */
  private skipTicks(n: number): void {
    if (!Number.isSafeInteger(n) || n < 1 || !Number.isSafeInteger(this.world.tick + n))
      throw new RangeError('Session.skip: invalid tick count');
    const first = this.world.tick + 1;
    const journal = this.journal;
    const previous = journal?.skips.at(-1);
    const coalesce = previous !== undefined && previous.first + previous.count === first;
    let bytes = 0;
    if (journal !== null && !coalesce) {
      this.journalByteCount = Math.max(this.journalByteCount, journal.encodedBytes);
      bytes = encodeExactState({ first, count: n }).byteLength + 1;
      if (
        this.journalRecordCount + 1 > journal.maxRecords ||
        journal.skips.length >= journal.maxTicks ||
        this.journalByteCount + bytes > journal.maxBytes - 4096
      ) {
        this.fail(
          new SimulationFault(
            first,
            'command journal',
            'skip',
            new RangeError('Command journal skip budget exceeded'),
          ),
        );
        return;
      }
    }
    this.simulation.skip(n);
    if (journal !== null) {
      if (coalesce)
        journal.skips[journal.skips.length - 1] = {
          first: previous!.first,
          count: previous!.count + n,
        };
      else {
        journal.skips.push({ first, count: n });
        this.journalRecordCount++;
        this.journalByteCount += bytes;
        journal.encodedBytes = this.journalByteCount;
      }
      journal.finalTick = this.world.tick;
    }
    if (this.recordLog !== null) (this.recordLog.skips ??= []).push([first, n]);
  }

  /** Records the loop's lateness once per wake: `onTick` runs up to `MAX_CATCH_UP_TICKS` per wake. */
  private recordWake(): void {
    const s = this.loop?.stats();
    if (s === undefined || s.wakes === this.lastWake) return;
    this.lastWake = s.wakes;
    this.wakeLateness.record(s.lastLateMs);
  }

  private fail(fault: SimulationFault): void {
    if (this.fault !== null) return;
    this.failure = fault;
    if (this.journal !== null && this.journal.failures.length < 64) {
      this.journal.failures.push({
        tick: fault.tick,
        system: fault.system.slice(0, 128),
        phase: fault.phase.slice(0, 32),
        message: fault.message.slice(0, 512),
      });
      this.journal.encodedBytes = encodeExactState(this.journal).byteLength;
    }
    this.phase = 'faulted';
    this.loop?.stop();
    this.stats.tickErrors++;
    this.log('error', 'session faulted', fault);
    for (const conn of [...this.conns]) {
      conn.pendingEvents = [];
      conn.outbox = [];
      const link = conn.link;
      this.clearHandshakeTimer(conn);
      this.unbind(conn);
      if (link !== null) {
        try {
          link.close(CloseCode.SessionFault, 'session faulted');
        } catch {
          /* already disconnected */
        }
      }
    }
    try {
      this.onFault?.(fault);
    } catch (err) {
      this.log('error', 'fault reporter failed', err);
    }
  }

  private guard(t: number, stage: string, fn: () => void): void {
    const diagnostics = this.diagnostics;
    const started =
      diagnostics === undefined ? undefined : diagnosticNow(diagnostics.now ?? this.now);
    let failed = false;
    try {
      fn();
    } catch (cause) {
      failed = true;
      throw cause instanceof SimulationFault
        ? cause
        : new SimulationFault(t, stage, 'session', cause);
    } finally {
      if (diagnostics !== undefined) {
        const ended = diagnosticNow(diagnostics.now ?? this.now);
        if (ended !== undefined)
          observeDiagnostic(diagnostics.observer, {
            version: 1,
            category: 'pipeline',
            name: stage,
            timeMs: ended,
            tick: t,
            durationMs: started === undefined || ended < started ? undefined : ended - started,
            status: failed
              ? 'error'
              : started === undefined || ended < started
                ? 'unavailable'
                : 'ok',
          });
      }
    }
  }

  private callHook(name: string, fn: () => void): boolean {
    try {
      fn();
      return true;
    } catch (cause) {
      throw new SimulationFault(
        this.world.tick + (this.world.stepping ? 0 : 1),
        name,
        'hook',
        cause,
      );
    }
  }

  /** Pipeline step 2 of tick `t`: joins, spawns, grace expiries and leaves, each in playerId order. */
  private runLifecycle(t: number): void {
    const ctx = this.ctx;
    for (const conn of this.slots) {
      if (conn === null || !conn.joinQueued) continue;
      conn.joinQueued = false;
      if (conn.state !== 'joined') continue; // left before the join ran
      this.recordLifecycle(t, conn.playerId, {
        type: 'join',
        accountId: conn.identity?.accountId ?? conn.actorId ?? '',
        displayName: conn.displayName,
      });
      let plan: PlayerSpawn | undefined;
      const ok = this.callHook('onPlayerJoin', () => {
        plan = this.hooks.onPlayerJoin(this.playerInfo(conn), ctx);
        if (
          plan === null ||
          typeof plan !== 'object' ||
          typeof plan.spawn !== 'function' ||
          this.graph.get(plan.regionId) === undefined
        ) {
          throw new Error(
            `onPlayerJoin must return a PlayerSpawn with a region of the world graph, got region ${String(plan?.regionId)}`,
          );
        }
      });
      if (!ok || plan === undefined) {
        this.kick(conn.playerId, KickReason.ByHost);
        continue;
      }
      conn.plan = plan;
      conn.joinRan = true;
      if (conn.readyPending) {
        conn.readyPending = false;
        this.beginLoading(conn);
      }
    }

    const active = this.regions.active();
    for (const conn of this.slots) {
      if (conn === null || !conn.spawnQueued || conn.state !== 'ready' || conn.plan === null)
        continue;
      if (!includesSorted(active, conn.plan.regionId)) continue; // retried next tick
      conn.spawnQueued = false;
      const plan = conn.plan;
      this.recordLifecycle(t, conn.playerId, { type: 'spawn' });
      const ok = this.callHook('PlayerSpawn.spawn', () => {
        const entity = plan.spawn(ctx);
        if (this.world.alive(entity))
          conn.entity = entity; // destroyed by *leave* if invalid below
        else throw new Error(`PlayerSpawn.spawn returned entity ${entity}, which is not alive`);
        const region = this.regions.regionOf(entity);
        if (region === undefined || !includesSorted(this.regions.active(), region)) {
          throw new Error(
            `PlayerSpawn.spawn: entity ${entity} is not in an active region (${String(region)})`,
          );
        }
      });
      if (!ok) {
        this.kick(conn.playerId, KickReason.ByHost);
        continue;
      }
      transition(conn, 'playing', this);
      conn.fullNext = true;
      conn.lastAckAtMs = this.now();
      const spawned = {
        playerId: conn.playerId,
        entity: conn.entity,
        regionId: this.regions.regionOf(conn.entity) ?? '',
      };
      for (const other of this.conns) {
        if (other.state === 'loading' || other.state === 'ready' || other.state === 'playing') {
          this.sendMessage(other, CoreKind.Spawned, SpawnedSchema, spawned);
        }
      }
      this.broadcastSessionState();
    }

    const now = this.now();
    for (const conn of this.slots) {
      // Grace expiry: the *leave* runs below, in this lifecycle pass.
      if (!this.replayExternal && conn !== null && graceExpired(conn, now, this.reconnectGraceMs))
        this.closeAndLeave(conn);
    }
    for (const conn of this.slots) {
      if (conn !== null && conn.leaveQueued) this.runLeave(conn, t);
    }
  }

  /** Appends a lifecycle step of tick `t` to `recordLog`, if recording (docs/sim.md 2.11). */
  private recordLifecycle(t: number, playerId: number, event: LifecycleEvent): void {
    if (this.journal !== null) this.appendJournal({ kind: 'lifecycle', playerId, event });
    const log = this.recordLog;
    if (log === null) return;
    (log.lifecycle ??= []).push([t, playerId, event]);
  }

  /**
   * Lifecycle *leave* in tick `t`: `onPlayerLeave` (only if *join* ran), destroy the entity, free
   * the slot.
   */
  private runLeave(conn: ClientConn, t: number): void {
    conn.leaveQueued = false;
    this.recordLifecycle(t, conn.playerId, { type: 'leave' });
    if (conn.joinRan) {
      this.callHook('onPlayerLeave', () =>
        this.hooks.onPlayerLeave?.(this.playerInfo(conn), this.ctx),
      );
    }
    if (conn.entity !== ENTITY_NONE && this.world.alive(conn.entity)) {
      this.world.destroy(conn.entity);
    }
    if (this.slots[conn.playerId] === conn) {
      this.slots[conn.playerId] = null;
      this.simulation.inputFrames[conn.playerId] = undefined;
    }
    this.removeConn(conn);
    this.broadcastSessionState();
  }

  /** Pipeline step 3: input frames for the tick, then queued game messages. */
  private intake(t: number): void {
    const diagnostics = this.diagnostics;
    let queued = 0;
    let peakLead = 0;
    const frames = this.simulation.inputFrames;
    for (let p = 0; p < this.slots.length; p++) {
      const conn = this.slots[p] as ClientConn | null;
      if (conn !== null && conn.state === 'playing') {
        if (diagnostics !== undefined) {
          queued += conn.inputQueue.length;
          const last = conn.inputQueue.at(-1);
          if (last !== undefined) peakLead = Math.max(peakLead, last.frame.tick - t);
        }
        drainInput(conn, t, this.stats);
      }
      frames[p] = conn?.held;
      if (this.journal !== null)
        this.appendJournal({ kind: 'input', playerId: p, frame: frames[p] });
    }
    if (diagnostics !== undefined) {
      const time = diagnosticNow(diagnostics.now ?? this.now);
      if (time !== undefined) {
        observeDiagnostic(diagnostics.observer, {
          version: 1,
          category: 'input',
          name: 'queued',
          timeMs: time,
          tick: t,
          value: queued,
          unit: 'count',
        });
        observeDiagnostic(diagnostics.observer, {
          version: 1,
          category: 'input',
          name: 'queue-lead',
          timeMs: time,
          tick: t,
          value: peakLead,
          unit: 'ticks',
        });
      }
    }
    const queue = this.messageQueue;
    this.messageQueue = [];
    for (const conn of this.slots) if (conn !== null) conn.gameMessagesQueued = 0;
    for (const m of queue) {
      if (!isInSession(m.conn) || this.slots[m.conn.playerId] !== m.conn) continue;
      if (this.journal !== null && this.simulationMessages.has(m.def))
        this.appendJournal({
          kind: 'message',
          actor: {
            playerId: m.conn.playerId,
            actorId: m.conn.identity?.accountId ?? m.conn.actorId ?? '',
            displayName: m.conn.displayName,
          },
          name: m.def.name,
          payload: m.payload,
        });
      this.callHook('onMessage', () =>
        this.hooks.onMessage?.(this.playerInfo(m.conn), m.def, m.payload, this.ctx),
      );
    }
    const applied = this.scheduledExternal.filter((command) => command.tick <= t);
    this.scheduledExternal = this.scheduledExternal.filter((command) => command.tick > t);
    for (const command of applied) {
      const definition = this.externalDefinitions.get(command.name)!;
      if (this.journal !== null)
        this.appendJournal({
          kind: 'external',
          name: command.name,
          payload: command.payload,
          actor: command.actor,
        });
      this.callHook(`external:${command.name}`, () =>
        definition.run(command.payload, this.ctx, command.actor),
      );
    }
  }

  /** Entities of players that have one (playing, away, leaving): kept wanted by `regions.update`. */
  private playerEntities(): EntityId[] {
    const out: EntityId[] = [];
    for (const conn of this.slots) {
      if (conn !== null && conn.entity !== ENTITY_NONE && this.world.alive(conn.entity)) {
        out.push(conn.entity);
      }
    }
    return out;
  }

  /**
   * Pipeline step 4 (A.5), right before `regions.update`: `hooks.simulationInterest`, deduplicated
   * and ascending (`stringCompare`); `[]` without the hook. A throw, or a result that is not an
   * array of region ids the world graph knows, at most `maxSimulationInterestRegions` distinct, is a
   * `SimulationFault` (system `simulationInterest`, phase `hook`) that faults the session: never
   * truncated or skipped, which would silently change the simulation. Protected so that
   * `@conduit/game`'s replay run calls it at the same point of its own pipeline.
   */
  protected simulationInterest(): readonly RegionId[] {
    const hooks = this.hooks;
    if (hooks.simulationInterest === undefined) return [];
    const max = this.maxSimulationInterestRegions;
    let interest: RegionId[] = [];
    this.callHook('simulationInterest', () => {
      const result: unknown = hooks.simulationInterest?.(this.ctx);
      if (!Array.isArray(result)) {
        throw new TypeError(`simulationInterest must return an array, got ${String(result)}`);
      }
      const ids = new Set<RegionId>();
      for (const id of result as unknown[]) {
        if (typeof id !== 'string' || this.graph.get(id) === undefined) {
          const shown = typeof id === 'string' ? `'${id}'` : String(id);
          throw new RangeError(`simulationInterest: ${shown} is not a region of the world graph`);
        }
        ids.add(id);
        if (ids.size > max) {
          throw new RangeError(
            `simulationInterest: more than ${max} regions (maxSimulationInterestRegions)`,
          );
        }
      }
      interest = [...ids].sort(stringCompare);
    });
    return interest;
  }

  /** `plan.regionId` of conns in joined/loading/ready. */
  private pendingSpawnRegions(): RegionId[] {
    const out: RegionId[] = [];
    for (const conn of this.slots) {
      if (conn === null || conn.plan === null) continue;
      if (conn.state === 'joined' || conn.state === 'loading' || conn.state === 'ready') {
        out.push(conn.plan.regionId);
      }
    }
    return out;
  }

  /**
   * Pipeline step 6 (A.8.3): this tick's replicated events into the queue of every playing client
   * that wants them. An event that cannot be sent (see `checkEvent`) is dropped once, here.
   */
  private queueEvents(): void {
    const events = this.simulation.events.drainOutbox();
    for (const ev of events) {
      if (!this.checkEvent(ev)) continue;
      for (const conn of this.slots) {
        if (conn !== null && conn.state === 'playing' && wantsEvent(conn, ev)) {
          queueEvent(conn, ev, this.stats);
        }
      }
    }
  }

  /**
   * True when `ev` encodes as an Events payload of its own within `MAX_PAYLOAD_BYTES`: a replicated
   * registry event whose payload fits its schema and whose region id fits the region table. Anything
   * else is a game bug; it is logged and counted in `tickErrors`, and no client gets the event.
   */
  private checkEvent(ev: ReplicatedEvent): boolean {
    const w = this.scratch;
    w.reset();
    try {
      encodeEvents(w, this.registry, eventsData([ev]));
      if (w.length > MAX_PAYLOAD_BYTES) {
        throw new EncodeError('payload', `${w.length} bytes exceed MAX_PAYLOAD_BYTES`);
      }
      return true;
    } catch (err) {
      this.stats.tickErrors++;
      const name = this.registry.event(ev.typeId)?.name ?? `#${ev.typeId}`;
      this.log('error', `tick ${ev.tick}: replicated event ${name} dropped`, err);
      return false;
    } finally {
      w.reset();
    }
  }

  /**
   * Pipeline step 7 for every playing client: ack timeout, rate, RegionSet, snapshot (queued events
   * ride in its frame). A client that got no snapshot frame (halved rate, snapshot too large or
   * failed) and is not backpressured gets its queued events in their own frame. A rebound client
   * that has not re-reported its regions yet gets neither (A.6): its FULL snapshot waits for the
   * report, so it covers the regions the client has.
   */
  private snapshots(t: number): void {
    const now = this.now();
    const every = this.game.snapshotEvery;
    for (const conn of this.slots) {
      if (conn === null || conn.state !== 'playing' || conn.link === null) continue;
      if (ackTimedOut(conn, now, this.ackTimeoutMs)) {
        this.stats.ackTimeouts++;
        this.sendMessage(conn, CoreKind.Kicked, KickedSchema, { reason: KickReason.AckTimeout });
        this.dropLink(conn, CloseCode.AckTimeout, 'ack timeout');
        continue;
      }
      updateDivisor(conn, t, every);
      this.refreshRegionSet(conn);
      if (!conn.regionsReported) continue;
      this.buildAndSend(conn, t);
    }
  }

  /**
   * A.8.2: the RegionSet of the client's region (`wantedForRegion` as `active`, `prefetchForRegion`
   * as `prefetch`), sent in its own frame before the snapshot when either set changed since the last
   * one sent.
   */
  private refreshRegionSet(conn: ClientConn): void {
    const region = this.regionFor(conn);
    if (region === undefined) return;
    const set = this.regionSetFor(region);
    if (sameSet(conn.wantedRegions, set.active) && sameSet(conn.prefetchRegions, set.prefetch)) {
      return;
    }
    this.sendRegionSet(conn, set);
  }

  /**
   * The region a client's RegionSet is built around: its entity's region (so the set is `wantedFor`
   * and `prefetchFor` of the entity), else the planned spawn region.
   */
  private regionFor(conn: ClientConn): RegionId | undefined {
    const placed = conn.entity === ENTITY_NONE ? undefined : this.regions.regionOf(conn.entity);
    return placed ?? conn.plan?.regionId;
  }

  /** `wantedForRegion(region)` and `prefetchForRegion(region)`, each de-duplicated and sorted. */
  private regionSetFor(region: RegionId): RegionSetPayload {
    return {
      active: [...new Set(this.interest.wantedForRegion(region))].sort(stringCompare),
      prefetch: [...new Set(this.interest.prefetchForRegion(region))].sort(stringCompare),
    };
  }

  /** Sends `set` in its own frame and records it as the client's wanted and prefetch regions. */
  private sendRegionSet(conn: ClientConn, set: RegionSetPayload): void {
    conn.wantedRegions = new Set(set.active);
    conn.prefetchRegions = new Set(set.prefetch);
    this.sendMessage(conn, CoreKind.RegionSet, RegionSetSchema, set);
  }

  /**
   * The regions a client's snapshot covers (A.8.1): `wantedRegions ∩ reportedRegions`, ascending. A
   * region the client has not reported loaded yet, or reports but is not sent, contributes nothing.
   */
  private interestRegions(conn: ClientConn): RegionId[] {
    const out: RegionId[] = [];
    for (const region of conn.wantedRegions) {
      if (conn.reportedRegions.has(region)) out.push(region);
    }
    return out.sort(stringCompare);
  }

  private snapshotSource(conn: ClientConn): SnapshotSource {
    const hooks = this.hooks;
    if (hooks.relevance === undefined) return this.baseSource;
    const player = this.playerInfo(conn);
    const ctx = this.ctx;
    return { ...this.baseSource, relevance: (e) => hooks.relevance?.(player, e, ctx) !== false };
  }

  /**
   * A.8.1: build, encode (creates bounded by `SNAPSHOT_SOFT_LIMIT_BYTES`), queued events and game
   * messages after the Snapshot message, send, commit. Returns whether a snapshot frame was sent.
   */
  private buildAndSend(conn: ClientConn, t: number): boolean {
    const link = conn.link;
    if (link === null) return false;
    if (shouldSkip(conn)) {
      this.stats.skipped++;
      return false;
    }
    if (halvedRateSkips(conn, t, this.game.snapshotEvery)) return false;
    const peer = this.replicationPeer(conn, link);
    if (peer.pending !== null) return true;
    if (peer.sideNeeded > 0) return false;
    try {
      const source = this.snapshotSource(conn);
      const interest = this.interestRegions(conn);
      const header = {
        serverTimeMs: this.clock.serverTimeMs(),
        lastInputSeq: conn.appliedSeq,
        lastInputTick: conn.appliedTick,
      };
      let data: SnapshotData;
      let bytes: Uint8Array;
      let commit: () => void;
      let entities: ReadonlySet<EntityId>;
      if (this.replicationOptions === undefined) {
        data = buildSnapshot(source, conn, interest, t, header);
        const writer = new ByteWriter();
        encodeSnapshot(writer, this.registry, data);
        bytes = new Uint8Array(writer.view());
        const frozen = data;
        commit = () => commitSnapshot(conn, frozen, frozen.creates.length);
        entities = new Set([
          ...data.creates.map((create) => create.entity),
          ...data.updates.map((update) => update.entity),
        ]);
      } else {
        const player = this.playerInfo(conn);
        const prepared = peer.planner.prepare(
          source,
          conn,
          interest,
          t,
          header,
          Math.min(peer.budget.maxFrameBytes, peer.budget.burstBytes),
          peer.limits.maxBytes,
          {
            ...(this.hooks.replicationGroups === undefined
              ? {}
              : { groups: this.hooks.replicationGroups(player, this.ctx) }),
            ...(this.hooks.replicationPriority === undefined
              ? {}
              : {
                  priority: (group: ReplicationGroup) =>
                    this.hooks.replicationPriority!(player, group, this.ctx),
                }),
          },
        );
        data = prepared.data;
        bytes = prepared.bytes;
        commit = prepared.commit;
        entities = prepared.entities;
        this.replicationMetric('deferred-groups', prepared.deferred);
        this.replicationMetric('oldest-deferred-ticks', prepared.oldestDeferredTicks, 'ticks');
      }
      if (bytes.byteLength > peer.limits.maxBytes)
        throw new ReplicationCapacityError(
          'snapshot exceeds negotiated transaction bytes; increase snapshot limits or reduce state',
        );
      const progressFrame =
        peer.budget.bytesPerSecond === Infinity
          ? Infinity
          : Math.floor((peer.budget.bytesPerSecond * peer.limits.inactivityMs * 0.8) / 1000);
      const frameSize = Math.min(peer.budget.maxFrameBytes, peer.budget.burstBytes, progressFrame);
      const direct =
        bytes.byteLength + MESSAGE_HEADER_BYTES + 2 <=
        Math.min(peer.budget.maxFrameBytes, peer.budget.burstBytes);
      const chunk = direct
        ? bytes.byteLength
        : Math.min(
            SNAPSHOT_PART_MAX_DATA,
            Math.floor(frameSize) - MESSAGE_HEADER_BYTES - 2 - SNAPSHOT_PART_HEADER_BYTES,
          );
      if (chunk < 1)
        throw new ReplicationCapacityError(
          'egress budget cannot sustain fragment progress before inactivity timeout',
        );
      const count = direct ? 1 : Math.ceil(bytes.byteLength / chunk);
      const wireBytes =
        bytes.byteLength +
        count * (MESSAGE_HEADER_BYTES + 2 + (direct ? 0 : SNAPSHOT_PART_HEADER_BYTES));
      if (count > peer.limits.maxParts || !peer.budget.canFinish(wireBytes, peer.limits.lifetimeMs))
        throw new ReplicationCapacityError(
          'snapshot cannot complete within negotiated parts/lifetime at configured egress budget',
        );
      peer.pending = {
        id: peer.nextId++ >>> 0,
        data,
        bytes,
        entities,
        chunk: direct ? bytes.byteLength : chunk,
        count,
        next: 0,
        began: this.now(),
        full: (data.header.flags & 1) !== 0,
        sentBytes: 0,
        commit,
      };
      this.replicationMetric('queued-bytes', bytes.byteLength, 'bytes');
      return true;
    } catch (cause) {
      this.stats.tickErrors++;
      this.log('error', `snapshot for player ${conn.playerId} failed`, cause);
      if (cause instanceof ReplicationCapacityError || cause instanceof EncodeError)
        this.failReplication(conn, link, cause.message);
      return false;
    }
  }

  private replicationPeer(conn: ClientConn, link: ClientLink): ReplicationPeer {
    const previous = this.replicationPeers.get(conn);
    if (previous?.link === link) return previous;
    const peer: ReplicationPeer = {
      link,
      epoch: ++this.nextReplicationEpoch,
      limits: this.linkSnapshotLimits.get(link) ?? this.serverSnapshotLimits,
      budget: new EgressBudget(this.replicationOptions, this.now()),
      planner: new ReplicationPlanner(this.replicationOptions),
      pending: null,
      nextId: 1,
      sideNeeded: 0,
      history: new Set(),
      stateTicks: new Map(),
      sideTick: -1,
      sideEventOffset: 0,
      sideMessageOffset: 0,
    };
    this.replicationPeers.set(conn, peer);
    return peer;
  }
  private failReplication(conn: ClientConn, link: ClientLink, detail: string): void {
    this.replicationMetric('capacity-failure', 1);
    this.dropLink(conn, CloseCode.MalformedFrame, detail.slice(0, 120));
  }
  private replicationMetric(
    name: string,
    value: number,
    unit: 'count' | 'bytes' | 'ticks' = 'count',
  ): void {
    const diagnostics = this.diagnostics;
    if (diagnostics === undefined) return;
    const time = diagnosticNow(diagnostics.now ?? this.now);
    if (time !== undefined)
      observeDiagnostic(diagnostics.observer, {
        version: 1,
        category: 'replication',
        name,
        timeMs: time,
        tick: this.world.tick,
        value,
        unit,
      });
  }
  private pumpReplication(t: number): void {
    for (const conn of this.slots) {
      const link = conn?.link;
      if (
        conn === null ||
        link === null ||
        link === undefined ||
        !isInSession(conn) ||
        shouldSkip(conn)
      )
        continue;
      const peer = this.replicationPeer(conn, link);
      if (conn.state !== 'playing' || !conn.regionsReported) {
        try {
          this.flushSideChannel(conn, peer, t, undefined, true);
        } catch (cause) {
          if (cause instanceof ReplicationCapacityError)
            this.failReplication(conn, link, cause.message);
          else {
            this.stats.tickErrors++;
            this.log('error', 'side-channel policy failed', cause);
          }
        }
        continue;
      }
      const transaction = peer.pending;
      if (transaction !== null) {
        if (this.now() - transaction.began > peer.limits.lifetimeMs) {
          this.failReplication(conn, link, 'snapshot transaction lifetime exceeded');
          continue;
        }
        let allowed = true;
        const regions = new Set(this.interestRegions(conn));
        const source = this.snapshotSource(conn);
        try {
          for (const entity of transaction.entities) {
            const region = source.regionOf(entity);
            if (
              source.relevance?.(entity) === false ||
              (region !== undefined && region !== null && !regions.has(region))
            ) {
              allowed = false;
              break;
            }
          }
        } catch {
          allowed = false;
        }
        if (!allowed) {
          peer.pending = null;
          peer.planner.reset();
          conn.fullNext = true;
          this.replicationMetric('assembly-reset', 1);
          continue;
        }
        for (let work = 0; work < 4 && transaction.next < transaction.count; work++) {
          const index = transaction.next;
          const raw = new ByteWriter();
          const writer = new FrameWriter(raw);
          writer.begin();
          const direct =
            transaction.count === 1 &&
            transaction.bytes.byteLength + MESSAGE_HEADER_BYTES + 2 <=
              Math.min(peer.budget.maxFrameBytes, peer.budget.burstBytes);
          if (direct)
            writer.message(
              CoreKind.Snapshot,
              transaction.data.header.serverTick,
              conn.seqOut,
              (w) => w.bytes(transaction.bytes),
            );
          else
            writer.message(
              CoreKind.SnapshotPart,
              transaction.data.header.serverTick,
              conn.seqOut,
              (w) =>
                encodeSnapshotPart(w, {
                  id: transaction.id,
                  tick: transaction.data.header.serverTick,
                  baselineTick: transaction.data.header.baselineTick,
                  index,
                  count: transaction.count,
                  totalBytes: transaction.bytes.byteLength,
                  reset: transaction.full,
                  data: transaction.bytes.subarray(
                    index * transaction.chunk,
                    Math.min(transaction.bytes.byteLength, (index + 1) * transaction.chunk),
                  ),
                }),
            );
          const final = index + 1 === transaction.count;
          let side: ReturnType<Session['appendSideToFrame']> | undefined;
          if (final) {
            try {
              side = this.appendSideToFrame(
                conn,
                peer,
                t,
                writer,
                raw.length,
                nextSeq(conn.seqOut),
                transaction,
              );
            } catch (cause) {
              if (cause instanceof ReplicationCapacityError) {
                this.failReplication(conn, link, cause.message);
                break;
              }
              this.stats.tickErrors++;
              this.log('error', 'side-channel policy failed', cause);
            }
          }
          const frame = writer.finish();
          const reservation = peer.budget.reserve(frame.byteLength, this.now());
          if (reservation === null) break;
          const bytes = frame.byteLength;
          const sent = this.sendFrame(conn, link, frame, {
            reservation,
            data: true,
            onSent: () => {
              if (
                this.replicationPeers.get(conn) !== peer ||
                conn.link !== link ||
                peer.pending !== transaction
              )
                return;
              transaction.sentBytes += bytes;
              this.replicationMetric('snapshot-frame-bytes', bytes, 'bytes');
              if (final) {
                transaction.commit();
                if (transaction.full) {
                  peer.history.clear();
                  peer.stateTicks.clear();
                }
                for (const record of [...transaction.data.creates, ...transaction.data.updates])
                  peer.stateTicks.set(
                    record.entity,
                    record.stateTick ?? transaction.data.header.serverTick,
                  );
                for (const entity of transaction.data.destroys)
                  peer.stateTicks.set(entity, transaction.data.header.serverTick);
                for (const entity of [
                  ...transaction.data.creates.map((create) => create.entity),
                  ...transaction.data.destroys,
                ])
                  peer.history.add(entity);
                while (peer.history.size > (this.replicationOptions?.maxEntities ?? 65535)) {
                  const expired = [...peer.history].find((entity) => !conn.known.has(entity));
                  if (expired === undefined) break;
                  peer.history.delete(expired);
                  peer.stateTicks.delete(expired);
                }

                recordSent(conn, {
                  tick: transaction.data.header.serverTick,
                  sentAtMs: this.now(),
                  bytes: transaction.sentBytes,
                });
                this.stats.snapshotsSent++;
                peer.pending = null;
                side?.commit();
              }
            },
            onDrop: () => {
              if (peer.pending === transaction) {
                peer.pending = null;
                peer.planner.reset();
                conn.fullNext = true;
              }
            },
          });
          if (sent === 0) break;
          side?.queued();
          conn.seqOut = side?.nextSequence ?? nextSeq(conn.seqOut);
          transaction.next++;
          if (!direct) this.replicationMetric('snapshot-fragments', 1);
        }
        if (transaction.next === transaction.count) {
          try {
            for (let work = 0; work < 3; work++)
              if (!this.flushSideChannel(conn, peer, t, transaction)) break;
          } catch (cause) {
            if (cause instanceof ReplicationCapacityError)
              this.failReplication(conn, link, cause.message);
            else {
              this.stats.tickErrors++;
              this.log('error', 'side-channel policy failed', cause);
            }
          }
        }
      } else {
        try {
          this.flushSideChannel(conn, peer, t);
        } catch (cause) {
          if (cause instanceof ReplicationCapacityError)
            this.failReplication(conn, link, cause.message);
          else {
            this.stats.tickErrors++;
            this.log('error', 'side-channel policy failed', cause);
          }
        }
      }
    }
  }

  private appendSideToFrame(
    conn: ClientConn,
    peer: ReplicationPeer,
    t: number,
    writer: FrameWriter,
    initialBytes: number,
    startSequence: number,
    queued?: PendingReplication,
    prePlay = false,
  ): { nextSequence: number; queued(): void; commit(): void } {
    if (peer.sideTick !== t) {
      peer.sideTick = t;
      peer.sideEventOffset = 0;
      peer.sideMessageOffset = 0;
    }
    const eventsAllowed = !prePlay && (t % this.game.snapshotEvery === 0 || queued !== undefined);
    conn.pendingEvents = conn.pendingEvents.filter((event) => wantsEvent(conn, event));
    const maximum = Math.min(
      peer.budget.available(this.now()),
      peer.budget.maxFrameBytes,
      peer.budget.burstBytes,
    );
    let bytes = initialBytes;
    let sequence = startSequence;
    const events: ReplicatedEvent[] = [];
    const messages: typeof conn.outbox = [];
    const player = this.playerInfo(conn);
    const candidates = eventsAllowed ? conn.pendingEvents.slice(peer.sideEventOffset) : [];
    let eligible = 0;
    for (const event of candidates) {
      const dependencies = this.hooks.eventDependencies?.(player, event, this.ctx) ?? [];
      if (dependencies.length > (this.replicationOptions?.maxEntities ?? 65535))
        throw new ReplicationCapacityError('event dependency count exceeds configured bound');
      const dependencyReady = dependencies.every((entity) => {
        if (!Number.isInteger(entity) || entity < 0 || entity > 0xffffffff)
          throw new ReplicationCapacityError('invalid event dependency entity');
        if (entity === 0) return true;
        const record =
          queued?.data.creates.find((create) => create.entity === entity) ??
          queued?.data.updates.find((update) => update.entity === entity);
        const known = conn.known.has(entity) || peer.history.has(entity) || record !== undefined;
        const stamp = queued?.data.destroys.includes(entity)
          ? queued.data.header.serverTick
          : (record?.stateTick ??
            (record
              ? queued!.data.header.serverTick
              : this.replicationOptions === undefined && conn.known.has(entity)
                ? conn.baselineTick
                : peer.stateTicks.get(entity)));
        return known && stamp !== undefined && stamp >= event.tick;
      });
      if (!dependencyReady) break;
      eligible++;
    }
    const encodePrefix = (count: number): Uint8Array => {
      const payload = new ByteWriter();
      encodeEvents(payload, this.registry, eventsData(candidates.slice(0, count)));
      return new Uint8Array(payload.view());
    };
    if (eligible > 0) {
      const first = encodePrefix(1);
      const cap = Math.min(peer.budget.maxFrameBytes, peer.budget.burstBytes);
      if (first.byteLength + MESSAGE_HEADER_BYTES + 2 > cap)
        throw new ReplicationCapacityError(
          'indivisible event exceeds configured frame/burst capacity',
        );
      let low = 0,
        high = eligible;
      let payload: Uint8Array | undefined;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        let value: Uint8Array | undefined;
        try {
          value = encodePrefix(mid);
        } catch (cause) {
          if (!(cause instanceof EncodeError)) throw cause;
        }
        if (
          value !== undefined &&
          value.length <= MAX_PAYLOAD_BYTES &&
          bytes + MESSAGE_HEADER_BYTES + value.length <= maximum
        ) {
          low = mid;
          payload = value;
        } else high = mid - 1;
      }
      if (low > 0) {
        payload = encodePrefix(low);
        writer.message(CoreKind.Events, t, sequence, (w) => w.bytes(payload!));
        sequence = nextSeq(sequence);
        bytes += MESSAGE_HEADER_BYTES + payload.length;
        events.push(...candidates.slice(0, low));
      }
      if (low < eligible) peer.sideNeeded = first.length + MESSAGE_HEADER_BYTES + 2;
      else peer.sideNeeded = 0;
    }
    const eventPrefixFinished = eligible === 0 || events.length === candidates.length;
    if (eventPrefixFinished)
      for (const message of conn.outbox.slice(
        peer.sideMessageOffset,
        peer.sideMessageOffset + 64,
      )) {
        const cost = MESSAGE_HEADER_BYTES + message.bytes.byteLength;
        if (cost + 2 > Math.min(peer.budget.maxFrameBytes, peer.budget.burstBytes))
          throw new ReplicationCapacityError(
            `message ${message.def.name} exceeds configured frame/burst capacity`,
          );
        if (bytes + cost > maximum) {
          peer.sideNeeded = Math.max(peer.sideNeeded, cost + 2);
          break;
        }
        writer.message(message.kind, t, sequence, (w) => w.bytes(message.bytes));
        sequence = nextSeq(sequence);
        bytes += cost;
        messages.push(message);
      }
    if (
      conn.pendingEvents.length === peer.sideEventOffset + events.length &&
      conn.outbox.length === peer.sideMessageOffset + messages.length
    )
      peer.sideNeeded = 0;
    return {
      nextSequence: sequence,
      queued: () => {
        peer.sideEventOffset += events.length;
        peer.sideMessageOffset += messages.length;
      },
      commit: () => {
        if (conn.link !== peer.link || this.replicationPeers.get(conn) !== peer) return;
        for (const event of events) if (conn.pendingEvents[0] === event) conn.pendingEvents.shift();
        for (const message of messages) if (conn.outbox[0] === message) conn.outbox.shift();
        this.replicationMetric('event-records', events.length);
        this.replicationMetric('game-messages', messages.length);
      },
    };
  }
  private flushSideChannel(
    conn: ClientConn,
    peer: ReplicationPeer,
    t: number,
    queued?: PendingReplication,
    prePlay = false,
  ): boolean {
    const link = conn.link;
    if (link === null || (conn.fullNext && queued === undefined && !prePlay)) return false;
    const raw = new ByteWriter();
    const writer = new FrameWriter(raw);
    writer.begin();
    const side = this.appendSideToFrame(
      conn,
      peer,
      t,
      writer,
      raw.length,
      conn.seqOut,
      queued,
      prePlay,
    );
    if (writer.count === 0) {
      writer.abort();
      return false;
    }
    const frame = writer.finish();
    const reservation = peer.budget.reserve(frame.length, this.now());
    if (reservation === null) return false;
    const sent = this.sendFrame(conn, link, frame, {
      reservation,
      data: true,
      onSent: side.commit,
    });
    if (sent === 0) return false;
    side.queued();
    conn.seqOut = side.nextSequence;
    return true;
  }

  /** End of tick: game messages of clients that got no snapshot frame, unless backpressured. */
  private flushOutboxes(): void {
    this.pumpReplication(this.world.tick);
  }

  // ---------------------------------------------------------------------------------------------
  // Inbound frames (docs/net.md A.6)

  private onFrame(link: ClientLink, buf: Uint8Array): void {
    const conn = this.byLink.get(link);
    if (conn === undefined || conn.link !== link) return;
    let messages: DecodedMessage[];
    try {
      messages = this.decodeFrame(conn, buf);
    } catch (err) {
      this.stats.badFrames++;
      const version = err instanceof DecodeError && err.code === 'version';
      this.log(
        'warn',
        `link ${link.id}: ${version ? 'wire version mismatch' : 'malformed frame'}`,
        err,
      );
      this.dropLink(
        conn,
        version ? CloseCode.WireVersion : CloseCode.MalformedFrame,
        version ? 'wire version' : 'malformed frame',
      );
      return;
    }
    for (const m of messages) {
      const current = this.byLink.get(link);
      if (current === undefined || current.link !== link) return; // closed or rebound meanwhile
      this.onMessage(current, m);
    }
  }

  /** Decodes every message first, so a frame that fails to decode is discarded whole. */
  private decodeFrame(conn: ClientConn, buf: Uint8Array): DecodedMessage[] {
    const out: DecodedMessage[] = [];
    let seqIn = conn.seqIn;
    let gaps = 0;
    readFrame(buf, (header, payload) => {
      if (header.seq !== seqIn) gaps++;
      seqIn = (header.seq + 1) % SEQ_MODULO;
      const def = this.registry.message(header.kind);
      if (def === undefined) {
        this.stats.unknownKinds++;
        return;
      }
      const accepted = def.direction !== 's2c';
      const decoded = accepted ? decodeWith(payload, def.schema) : undefined;
      try {
        assertFiniteData(decoded, 'network payload');
      } catch {
        throw new DecodeError(
          'range',
          payload.offset,
          'network payload must contain finite numbers',
        );
      }
      out.push({ header, def, payload: decoded });
    });
    conn.seqIn = seqIn;
    this.stats.seqGaps += gaps;
    return out;
  }

  private onMessage(conn: ClientConn, m: DecodedMessage): void {
    const kind = m.header.kind;
    if (conn.state === 'handshaking') {
      if (kind === CoreKind.Hello) this.onHello(conn, m.payload as HelloPayload);
      else this.protocolViolation(conn, `message kind ${kind} before Hello`);
      return;
    }
    const state = conn.state;
    switch (kind) {
      case CoreKind.Hello:
        this.protocolViolation(conn, 'Hello outside the handshake');
        return;
      case CoreKind.Ready:
        if (state === 'joined') this.onReady(conn);
        else this.stats.ignoredMessages++;
        return;
      case CoreKind.Input:
        if (state === 'playing')
          acceptInput(conn, m.payload as InputPayload, m.header.seq, this.stats, {
            ...this.inputQueueBounds,
            serverTick: this.tick,
          });
        else this.stats.ignoredMessages++;
        return;
      case CoreKind.Ack:
        if (state === 'playing') {
          const ack = m.payload as AckPayload;
          recordAck(conn, ack.lastSnapshotTick, this.now());
        } else {
          this.stats.ignoredMessages++;
        }
        return;
      case CoreKind.Ping:
        if (isInSession(conn)) {
          const ping = m.payload as PingPayload;
          this.sendMessage(conn, CoreKind.Pong, PongSchema, {
            clientTimeMs: ping.clientTimeMs,
            serverTimeMs: this.clock.nowMs(),
            serverTick: this.world.tick,
          });
        } else {
          this.stats.ignoredMessages++;
        }
        return;
      case CoreKind.RegionLoadState:
        if (state === 'loading' || state === 'ready' || state === 'playing') {
          this.onRegionLoadState(conn, m.payload as RegionLoadStatePayload);
        } else {
          this.stats.ignoredMessages++;
        }
        return;
      case CoreKind.Leave:
        if (isInSession(conn)) this.onLeave(conn);
        else this.stats.ignoredMessages++;
        return;
      default:
        if (m.def.core || m.payload === undefined || !isInSession(conn)) {
          this.stats.ignoredMessages++;
        } else if (conn.gameMessagesQueued >= MAX_GAME_MESSAGES_PER_TICK) {
          this.stats.gameMessagesDropped++;
        } else {
          conn.gameMessagesQueued++;
          this.messageQueue.push({ conn, def: m.def, payload: m.payload });
        }
    }
  }

  private onHello(conn: ClientConn, hello: HelloPayload): void {
    try {
      const offered = snapshotLimits(hello.snapshotLimits);
      const configured = this.serverSnapshotLimits;
      const accepted = snapshotLimits({
        maxBytes: Math.min(offered.maxBytes, configured.maxBytes),
        maxParts: Math.min(offered.maxParts, configured.maxParts),
        inactivityMs: Math.min(offered.inactivityMs, configured.inactivityMs),
        lifetimeMs: Math.min(offered.lifetimeMs, configured.lifetimeMs),
      });
      if (conn.link !== null) this.linkSnapshotLimits.set(conn.link, accepted);
    } catch {
      this.dropLink(conn, CloseCode.MalformedFrame, 'unsupported snapshot assembly limits');
      return;
    }
    // Token expiry is wall-clock time (unix seconds), like the gateway's and the lobby's.
    const nowMs = Date.now();
    const identity = resolveIdentity(hello, conn.identity, this.verifier, Math.floor(nowMs / 1000));
    if (identity !== null) conn.identity = identity;
    const target =
      identity === null || hello.reconnectToken === ''
        ? undefined
        : this.reconnectTarget(conn, hello.reconnectToken, identity.accountId);
    const reason = validateHello(
      hello,
      { protocolVersion: this.game.protocolVersion, compatibility: this.compatibility },
      this.registry,
      {
        identity,
        sessionId: this.id,
        nowMs,
        expired: this.tokenVerdicts.get(conn),
        running: this.phase === 'running',
        reconnect: target !== undefined,
        activePlayers: this.slots.reduce((n, c) => (c === null ? n : n + 1), 0),
        maxPlayers: this.maxPlayers,
      },
    );
    if (reason !== null || identity === null) {
      this.reject(conn, reason ?? RejectReason.BadToken, hello);
      return;
    }
    this.clearHandshakeTimer(conn);
    if (target !== undefined) this.rebind(target, conn, identity);
    else this.join(conn, hello, identity);
  }

  /** The playing or away conn of the same account holding `token`, if any (`matchesReconnect`). */
  private reconnectTarget(
    fresh: ClientConn,
    token: string,
    accountId: string,
  ): ClientConn | undefined {
    for (const conn of this.slots) {
      if (conn !== null && conn !== fresh && matchesReconnect(conn, token, accountId)) return conn;
    }
    return undefined;
  }

  private reject(conn: ClientConn, reason: RejectReason, hello: HelloPayload): void {
    const detail = rejectDetail(reason, hello, {
      protocolVersion: this.game.protocolVersion,
      compatibility: this.compatibility,
    });
    this.sendMessage(conn, CoreKind.Rejected, RejectedSchema, { reason, detail });
    this.dropLink(conn, rejectCloseCode(reason), detail);
  }

  /** Fresh join: lowest free slot, Welcome, lifecycle *join* queued, SessionState to all. */
  private join(conn: ClientConn, hello: HelloPayload, identity: SessionToken): void {
    const playerId = this.slots.indexOf(null);
    if (playerId < 0) throw new Error('Session: no free player slot'); // validateHello checked
    conn.playerId = playerId;
    this.slots[playerId] = conn;
    conn.reconnectToken = newReconnectToken();
    conn.displayName = clipName(
      hello.displayName !== '' ? hello.displayName : identity.displayName,
    );
    transition(conn, 'joined', this);
    this.sendWelcome(conn);
    if (conn.state !== 'joined' || conn.link === null) return;
    conn.joinQueued = true;
    this.broadcastSessionState();
  }

  /**
   * Reconnect path (A.6): `target` takes over the new link; the fresh conn is discarded. A still
   * bound old link is kicked with `Replaced`/4006. The new link gets Welcome (the conn's `playerId`
   * and `reconnectToken`), SessionState, the recomputed RegionSet and Spawned; its snapshots start,
   * FULL, once it re-reports its regions.
   */
  private rebind(target: ClientConn, fresh: ClientConn, identity: SessionToken): void {
    const link = fresh.link as ClientLink;
    transition(fresh, 'closed', this);
    fresh.link = null;
    this.removeConn(fresh);
    const old = target.link;
    if (old !== null) {
      this.unbind(target);
      this.sendOn(old, target, CoreKind.Kicked, KickedSchema, { reason: KickReason.Replaced });
      this.closeTransport(old, CloseCode.Replaced, 'replaced');
    }
    rebindConn(target, link, fresh.seqIn, identity, this.now(), this);
    this.byLink.set(link, target);
    this.sendWelcome(target);
    this.sendMessage(target, CoreKind.SessionState, SessionStateSchema, this.sessionState());
    const region = this.regionFor(target);
    if (region !== undefined) this.sendRegionSet(target, this.regionSetFor(region));
    if (target.entity !== ENTITY_NONE) {
      this.sendMessage(target, CoreKind.Spawned, SpawnedSchema, {
        playerId: target.playerId,
        entity: target.entity,
        regionId: region ?? '',
      });
    }
    this.broadcastSessionState(target);
  }

  private onReady(conn: ClientConn): void {
    if (!conn.joinRan) {
      conn.readyPending = true; // handled right after the join runs
      return;
    }
    this.beginLoading(conn);
  }

  /** joined -> loading: RegionSet (active and prefetch) for the spawn region. */
  private beginLoading(conn: ClientConn): void {
    const plan = conn.plan as PlayerSpawn;
    this.sendRegionSet(conn, this.regionSetFor(plan.regionId));
    if (conn.state === 'joined' && conn.link !== null) transition(conn, 'loading', this);
  }

  /**
   * Stores `loaded` as the client's reported regions (A.6); snapshots and events cover
   * `wanted ∩ reported` from now on (for a rebound client, the first report releases its FULL
   * snapshot). A loading client whose report covers every wanted region is ready to spawn.
   * `loading` is informational only.
   */
  private onRegionLoadState(conn: ClientConn, state: RegionLoadStatePayload): void {
    conn.reportedRegions = new Set(state.loaded);
    conn.regionsReported = true;
    if (conn.state === 'loading' && isSubset(conn.wantedRegions, conn.reportedRegions)) {
      transition(conn, 'ready', this);
      conn.spawnQueued = true;
      this.broadcastSessionState();
    }
  }

  private onLeave(conn: ClientConn): void {
    const link = conn.link;
    this.unbind(conn);
    this.closeAndLeave(conn);
    if (link !== null) this.closeTransport(link, CloseCode.Normal, 'leave');
  }

  private protocolViolation(conn: ClientConn, detail: string): void {
    this.log('warn', `link ${conn.id}: protocol violation: ${detail}`);
    this.dropLink(conn, CloseCode.ProtocolViolation, 'protocol violation');
  }

  // ---------------------------------------------------------------------------------------------
  // Connection bookkeeping

  /** Closes the conn's link from the server side; the conn transitions as for a link close. */
  private dropLink(conn: ClientConn, code: number, reason: string): void {
    const link = conn.link;
    if (link === null) return;
    this.linkLost(conn);
    this.closeTransport(link, code, reason);
  }

  /** Transport termination follows committed buffered messages, including Kicked. */
  private closeTransport(link: ClientLink, code: number, reason: string): void {
    if (this.inTick) this.pendingCloses.push({ link, code, reason });
    else link.close(code, reason);
  }

  /** The conn lost its link: handshaking -> closed, joined..ready -> closed + *leave*, playing -> away. */
  private linkLost(conn: ClientConn): void {
    this.unbind(conn);
    switch (conn.state) {
      case 'handshaking':
        this.clearHandshakeTimer(conn);
        transition(conn, 'closed', this);
        this.removeConn(conn);
        return;
      case 'joined':
      case 'loading':
      case 'ready':
        this.closeAndLeave(conn);
        return;
      case 'playing':
        markAway(conn, this.now(), this);
        this.broadcastSessionState();
        return;
      case 'away':
      case 'closed':
        return;
    }
  }

  private unbind(conn: ClientConn): void {
    const link = conn.link;
    if (link === null) return;
    if (this.byLink.get(link) === conn) this.byLink.delete(link);
    conn.link = null;
  }

  /** -> closed with lifecycle *leave* queued (runs at the next tick). */
  private closeAndLeave(conn: ClientConn): void {
    if (conn.state === 'closed') return;
    transition(conn, 'closed', this);
    conn.joinQueued = false;
    conn.readyPending = false;
    conn.spawnQueued = false;
    conn.leaveQueued = true;
    conn.inputQueue = [];
    conn.held = undefined;
    conn.pendingEvents = [];
    conn.outbox = [];
  }

  private removeConn(conn: ClientConn): void {
    this.clearHandshakeTimer(conn);
    const i = this.conns.indexOf(conn);
    if (i >= 0) this.conns.splice(i, 1);
  }

  private clearHandshakeTimer(conn: ClientConn): void {
    if (conn.handshakeTimer === undefined) return;
    this.timers.clearTimeout(conn.handshakeTimer);
    conn.handshakeTimer = undefined;
  }

  private async shutdown(): Promise<void> {
    const loading = this.loading;
    this.phase = 'stopping';
    this.loop?.stop();
    for (const conn of [...this.conns]) {
      const link = conn.link;
      this.clearHandshakeTimer(conn);
      if (link !== null) {
        this.unbind(conn);
        this.sendOn(link, conn, CoreKind.Kicked, KickedSchema, {
          reason: KickReason.ServerShutdown,
        });
        link.close(CloseCode.Shutdown, 'server shutdown');
      }
      if (conn.state !== 'closed') transition(conn, 'closed', this);
    }
    this.conns = [];
    this.byLink.clear();
    this.slots.fill(null);
    this.messageQueue = [];
    try {
      // A start() still loading finishes first, so what it loaded is saved, never overwritten.
      if (loading !== null) await loading.catch(() => undefined);
      if (!this.loaded) return;
      if (this.autosaver !== null) await this.autosaver.stop();
      else if (this.fault === null) await this.flushAll();
      else await this.flushing.catch(() => undefined);
    } finally {
      this.phase = 'stopped';
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Outbound

  private playerInfo(conn: ClientConn): PlayerInfo {
    return {
      playerId: conn.playerId,
      accountId: conn.identity?.accountId ?? conn.actorId ?? '',
      displayName: conn.displayName,
      state: this.playerState(conn),
      entity: conn.entity,
    };
  }

  private playerState(conn: ClientConn): PlayerState {
    switch (conn.state) {
      case 'ready':
        return PlayerState.Ready;
      case 'playing':
        return PlayerState.Playing;
      case 'away':
        return PlayerState.Away;
      case 'closed':
        return conn.entity !== ENTITY_NONE ? PlayerState.Playing : PlayerState.Joined;
      default:
        return PlayerState.Joined;
    }
  }

  private sessionState(): SessionStatePayload {
    const players: SessionStatePayload['players'] = [];
    for (const conn of this.slots) {
      if (conn === null || conn.state === 'closed') continue;
      players.push({
        playerId: conn.playerId,
        name: conn.displayName,
        state: this.playerState(conn),
        entity: conn.entity,
      });
    }
    return { players };
  }

  /** SessionState to every bound conn past the handshake (except `except`). */
  private broadcastSessionState(except?: ClientConn): void {
    const payload = this.sessionState();
    for (const conn of this.conns) {
      if (conn === except || conn.link === null || !isInSession(conn)) continue;
      this.sendMessage(conn, CoreKind.SessionState, SessionStateSchema, payload);
    }
  }

  private sendWelcome(conn: ClientConn): void {
    this.sendMessage(conn, CoreKind.Welcome, WelcomeSchema, {
      snapshotLimits: this.replicationPeer(conn, conn.link!).limits,
      sessionCapacity: this.maxPlayers,
      playerId: conn.playerId,
      reconnectToken: conn.reconnectToken,
      simTickRate: this.game.tickRate,
      snapshotEvery: this.game.snapshotEvery,
      serverTick: this.world.tick,
      serverTimeMs: this.clock.serverTimeMs(),
      worldSeed: this.game.seed,
      compatibility: this.compatibility,
    });
  }

  /** One message in its own frame, now. */
  private sendMessage<T>(conn: ClientConn, kind: number, schema: Schema<T>, payload: T): void {
    const link = conn.link;
    if (link !== null) this.sendOn(link, conn, kind, schema, payload);
  }

  private sendOn<T>(
    link: ClientLink,
    conn: ClientConn,
    kind: number,
    schema: Schema<T>,
    payload: T,
  ): void {
    const fw = this.frame;
    fw.begin();
    fw.message(kind, this.world.tick, conn.seqOut, (w) => encodeWith(w, schema, payload));
    conn.seqOut = nextSeq(conn.seqOut);
    this.sendFrame(conn, link, fw.finish());
  }

  /**
   * Sends one finished frame and counts its bytes; returns the byte count. `buf` belongs to the link
   * once sent (a `PortLink` transfers its buffer, leaving `buf` empty), so it is measured first.
   */
  private sendFrame(
    conn: ClientConn,
    link: ClientLink,
    buf: Uint8Array,
    delivery?: FrameDelivery,
  ): number {
    const first = buf[2] ?? 0;
    const data =
      delivery?.data ??
      (first === CoreKind.Snapshot ||
        first === CoreKind.SnapshotPart ||
        first === CoreKind.Events ||
        first >= 128);
    const reservation =
      delivery?.reservation ??
      this.replicationPeer(conn, link).budget.reserve(buf.byteLength, this.now(), !data);
    if (reservation === null) {
      if (!data) this.failReplication(conn, link, 'mandatory control egress reserve exhausted');
      return 0;
    }
    const transaction: FrameDelivery = delivery ?? { reservation, data };
    if (this.inTick) {
      this.pendingFrames.push({ conn, link, buf: new Uint8Array(buf), delivery: transaction });
      return buf.byteLength;
    }
    if (data && conn.link !== link) {
      reservation.refund();
      transaction.onDrop?.();
      return 0;
    }
    const bytes = buf.byteLength;
    const now = this.now();
    try {
      link.send(buf);
    } catch (cause) {
      reservation.refund();
      transaction.onDrop?.();
      this.failedDelivery(conn, link, cause);
      return 0;
    }
    reservation.commit();
    transaction.onSent?.();
    conn.bytesOut += bytes;
    this.bytesOut.add(bytes, now);
    let meter = this.connBytesOut.get(conn);
    if (meter === undefined) {
      meter = new RateMeter();
      this.connBytesOut.set(conn, meter);
    }
    meter.add(bytes, now);
    const diagnostics = this.diagnostics;
    if (diagnostics !== undefined) {
      const time = diagnosticNow(diagnostics.now ?? this.now);
      if (time !== undefined)
        observeDiagnostic(diagnostics.observer, {
          version: 1,
          category: 'replication',
          name: 'frame-bytes',
          timeMs: time,
          tick: this.world.tick,
          value: bytes,
          unit: 'bytes',
        });
    }
    return bytes;
  }

  /** A failed delivery must release the connection even if transport close never calls back. */
  private failedDelivery(conn: ClientConn, link: ClientLink, cause: unknown): void {
    this.log('error', 'client transport send failed', cause);
    // Sending is a transport boundary, including outside ticks (Welcome/Pong). Release
    // held input and start reconnect grace rather than leaving a disconnected playing slot.
    // Unbind before broadcasting Away so another failed transport can be isolated recursively.
    if (conn.link === link) this.linkLost(conn);
    try {
      link.close(CloseCode.Shutdown, 'transport send failed');
    } catch (err) {
      this.log('error', 'client transport close failed', err);
    }
  }

  private encodeGameMessage<T>(
    def: MessageDef<T>,
    payload: T,
  ): { kind: number; bytes: Uint8Array } {
    const kind = this.registry.messageKind(def);
    const registered = this.registry.message(kind);
    if (registered === undefined || registered.core || registered.direction === 'c2s') {
      throw new RangeError(`Session.send: ${def.name} is not an s2c or both game message`);
    }
    const w = this.scratch;
    w.reset();
    encodeWith(w, def.schema, payload);
    if (w.length > MAX_PAYLOAD_BYTES) {
      w.reset();
      throw new EncodeError('payload', `${def.name} payload exceeds MAX_PAYLOAD_BYTES`);
    }
    return { kind, bytes: w.finish() };
  }
}

/** Simulation comparison excludes publication metadata, transport clocks/acks and unobserved I/O. */
export function executionStateOfCheckpoint(checkpoint: ExactSessionCheckpoint): unknown {
  return {
    completedTick: checkpoint.completedTick,
    world: checkpoint.world,
    simulation: checkpoint.simulation,
    regions: { ...checkpoint.regions, pendingDecisions: [] },
    session: {
      ...checkpoint.session,
      players: checkpoint.session.players.map(
        ({
          awaySince: _awaySince,
          appliedSeq: _appliedSeq,
          lastInputSeq: _lastInputSeq,
          lastInputTick: _lastInputTick,
          appliedTick: _appliedTick,
          inputQueue,
          ...player
        }) => ({ ...player, inputQueue: inputQueue.map((input) => input.frame) }),
      ),
    },
    game: checkpoint.game,
  };
}
