import { SnapshotAssembly } from './snapshot-assembly.ts';
import { diagnosticNow, observeDiagnostic, type DiagnosticOptions } from '@conduit/math';
import type { AssetLoader, Manifest } from '@conduit/assets';
import {
  AckSchema,
  CoreKind,
  DEFAULT_SESSION_CAPACITY,
  PROTOCOL_SESSION_CAPACITY_MAX,
  compatibilityDifferences,
  copyCompatibilityDescriptor,
  createCompatibilityDescriptor,
  type CompatibilityDescriptor,
  DecodeError,
  ENTITY_NONE,
  GAME_MESSAGE_KIND_BASE,
  HelloSchema,
  type InputFrameBase,
  type InputPayload,
  type KickedPayload,
  KickReason,
  LeaveSchema,
  type MessageDef,
  type MessageHeader,
  nextSeq,
  PingSchema,
  type PlayerEntryPayload,
  ReadySchema,
  type RegionLoadStatePayload,
  RegionLoadStateSchema,
  type RegionSetPayload,
  type RejectedPayload,
  RejectReason,
  type Schema,
  type SchemaRegistry,
  type SessionStatePayload,
  SNAPSHOT_FLAG_FULL,
  type SnapshotHeader,
  type SnapshotLimits,
  snapshotLimits,
  type SpawnedPayload,
  utf8Length,
  type WelcomePayload,
} from '@conduit/protocol';
import type { ComponentType, EntityId } from '@conduit/sim';
import { type RegionId, stringCompare, type WorldGraph } from '@conduit/world';
import {
  CONNECT_TIMEOUT_MS,
  consoleLog,
  DEFERRED_SEND_TICKS,
  gcLagTicks,
  isReconnectableClose,
  type LogFn,
  MAX_BAD_FRAMES,
  PING_INTERVAL_MS,
  QUICK_PING_MS,
  QUICK_PINGS,
  RECONNECT_DELAYS_MS,
} from './constants.ts';
import { EventBuffer, type ReplicatedEventInfo } from './event-buffer.ts';
import { dispatchFrame, FrameEncoderSession, type ServerMessageHandlers } from './frame-io.ts';
import { InputSender, type InputSampleContext } from './input-sender.ts';
import { NetClock, toU32Ms } from './net-clock.ts';
import {
  type PredictionOptions,
  type PredictionStats,
  type PredictorHook,
  Reconciler,
} from './prediction.ts';
import { RegionClient } from './region-client.ts';
import { ReplicaWorld } from './replica-world.ts';
import { assertTransition, type ClientState } from './state.ts';
import { type Transport, type TransportFactory, webSocketTransport } from './transport.ts';

/** The parts of a game definition the client needs; `defineGame`'s `Game` satisfies it. */
export interface ClientGameDef {
  readonly compatibility?: CompatibilityDescriptor;
  readonly id: string;
  readonly protocolVersion: number;
  readonly tickRate: number;
  readonly snapshotEvery: number;
  readonly registry: SchemaRegistry;
  /** Must be `registry.input` (or share its descriptor). */
  readonly input: Schema<InputFrameBase>;
  /** Client-side interpolation metadata for `ReplicaWorld`. */
  readonly components: readonly ComponentType<unknown>[];
  /** Builds the region graph for `Welcome.worldSeed`; the graph itself never crosses the wire. */
  world?(seed: number): WorldGraph;
}

export interface ClientTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface NetClientOptions {
  /** Peer membership capacity this client can decode,1..protocol ceiling; default16. */
  maxSessionCapacity?: number | undefined;
  snapshotLimits?: Partial<SnapshotLimits> | undefined;
  diagnostics?: DiagnosticOptions | undefined;
  url: string;
  game: ClientGameDef;
  /** Sent in `Hello.sessionToken` (≤ 2048 UTF-8 bytes). */
  token: string;
  /** Sent in `Hello.displayName` (≤ 32 UTF-8 bytes). */
  displayName: string;
  /** Default `webSocketTransport`. */
  transport?: TransportFactory;
  /** Milliseconds; default `performance.now`. */
  now?: () => number;
  /** Default the global timers. */
  timers?: ClientTimers;
  /** Fills each client tick's frame, starting from the last `sendInput` frame (tick is set by NetClient). */
  sampleInput?: (frame: InputFrameBase, context: InputSampleContext) => void;
  /** Default frame pulses plus absolute timer fallback. Manual disables the timer. */
  inputScheduling?: 'hybrid' | 'timer' | 'manual' | undefined;
  maxInputLeadTicks?: number | undefined;
  extrapolation?: { horizonMs: number; onLimit?: 'hold' | 'reset' } | undefined;
  /** Default true: send Ready right after Welcome. */
  autoReady?: boolean;
  /**
   * true: an Ack waits for the next frame the client sends, normally the next tick's Input, and
   * goes in it (docs/net.md B.6), so a playing client sends one frame per tick and a Ping a
   * second; it goes on its own after `DEFERRED_SEND_TICKS` ticks at most. Nothing else waits.
   * Default false: every message in its own frame, at once, as before.
   */
  batchSends?: boolean | undefined;
  /**
   * Default true: a reconnectable close (docs/net.md A.3) while Playing or Resyncing moves to
   * Reconnecting, which retries after `RECONNECT_DELAYS_MS` with the Welcome's reconnect token. With
   * false every close ends in Disconnected.
   */
  autoReconnect?: boolean;
  /**
   * The client's asset loader (M3, docs/assets.md 3), passed with `manifest` to `regions`: each
   * region then loads its `manifest.regions[id]` group before it is reported loaded, and Loading
   * waits for the active ones. Without both, every listed region counts as loaded at once.
   */
  assets?: AssetLoader | undefined;
  /** The manifest whose `regions` table names each region's assets; see `assets`. */
  manifest?: Manifest | undefined;
  /**
   * The reconciliation stub (M6, docs/net.md B.10). Absent or `{ enabled: false }` (the default):
   * nothing is built and `prediction` is `null`. `{ enabled: true }`: a `Reconciler` tracks the
   * snapshots' input acknowledgements against the frames sent and counts them in
   * `stats().prediction`; it replays nothing.
   */
  prediction?: PredictionOptions | undefined;
  log?: LogFn;
}

export type PlayerEntry = PlayerEntryPayload;

/** A game message from the server, on arrival. */
export interface GameMessageInfo {
  def: MessageDef;
  tick: number;
  payload: unknown;
}

export interface DisconnectInfo {
  /** The close code; 1006 when the connection failed or timed out without one, 1000 for `disconnect()`. */
  code: number;
  reason: string;
  /**
   * True when the client moved to Reconnecting and will try again; false when it is Disconnected
   * for good (including when the last reconnect attempt failed).
   */
  willReconnect: boolean;
}

export interface NetClientEvents {
  /** Authoritative arrival, before delayed visual dispatch. Never apply the same event twice across hooks. */
  authoritativeEvent: (e: ReplicatedEventInfo) => void;
  state: (s: ClientState, prev: ClientState) => void;
  welcome: (w: WelcomePayload) => void;
  sessionState: (s: SessionStatePayload) => void;
  spawned: (s: SpawnedPayload) => void;
  /** After the snapshot is applied and acked. */
  snapshot: (h: SnapshotHeader) => void;
  /** At render time: from `update()`, once the render tick reaches the event's tick (docs/net.md B.7). */
  event: (e: ReplicatedEventInfo) => void;
  message: (m: GameMessageInfo) => void;
  regionSet: (r: RegionSetPayload) => void;
  rejected: (r: RejectedPayload) => void;
  kicked: (k: KickedPayload) => void;
  disconnected: (info: DisconnectInfo) => void;
  error: (err: unknown) => void;
}

export interface NetClientStats {
  rttMs: number;
  jitterMs: number;
  /** Frame bytes received since construction. */
  bytesIn: number;
  /** Frame bytes sent since construction. */
  bytesOut: number;
  /** Frame bytes received in the last second (a rolling window ending now). */
  bytesInPerSec: number;
  /** Frame bytes sent in the last second (a rolling window ending now). */
  bytesOutPerSec: number;
  snapshots: number;
  seqGaps: number;
  lastSnapshotTick: number;
  badFrames: number;
  ignoredMessages: number;
  /** The reconciliation stub's counters (docs/net.md B.10); present only while it is enabled. */
  prediction?: PredictionStats;
}

export type ConnectErrorKind = 'rejected' | 'timeout' | 'closed' | 'error' | 'aborted';

/** Why `NetClient.connect()` rejected. */
export class ConnectError extends Error {
  override readonly name = 'ConnectError';
  readonly kind: ConnectErrorKind;
  /** The server's Rejected payload when `kind === 'rejected'`. */
  readonly rejected: RejectedPayload | undefined;
  /** The close code when `kind === 'closed'`. */
  readonly code: number | undefined;

  constructor(
    kind: ConnectErrorKind,
    message: string,
    extra: { rejected?: RejectedPayload; code?: number; cause?: unknown } = {},
  ) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause });
    this.kind = kind;
    this.rejected = extra.rejected;
    this.code = extra.code;
  }
}

function nameOf(table: Readonly<Record<string, number>>, value: number): string {
  for (const [name, v] of Object.entries(table)) if (v === value) return name;
  return `Unknown(${value})`;
}

/** `RejectReason` key for `reason`, or `Unknown(n)`. */
export function rejectReasonName(reason: number): string {
  return nameOf(RejectReason, reason);
}

/** `KickReason` key for `reason`, or `Unknown(n)`. */
export function kickReasonName(reason: number): string {
  return nameOf(KickReason, reason);
}

/** `Rejected: SchemaMismatch — please refresh`, the text a HUD shows for a Rejected. */
export function describeRejected(r: RejectedPayload): string {
  const name = rejectReasonName(r.reason);
  return r.detail === '' ? `Rejected: ${name}` : `Rejected: ${name} \u{2014} ${r.detail}`;
}

/** `Hello.sessionToken` is at most 2048 UTF-8 bytes. */
function checkToken(token: string): void {
  if (utf8Length(token) > 2048) {
    throw new RangeError('NetClient: token exceeds 2048 UTF-8 bytes');
  }
}

/** Kick reasons after which a client must not reconnect, whatever the close code. */
function isFinalKick(reason: number): boolean {
  return reason !== KickReason.ServerShutdown && reason !== KickReason.AckTimeout;
}

/** States in which the server has a connection record for us (messages other than Hello are legal). */
function serverKnows(s: ClientState): boolean {
  return s === 'Joined' || s === 'Loading' || s === 'Ready' || s === 'Playing' || s === 'Resyncing';
}

function uniqueSorted(ids: readonly RegionId[]): RegionId[] {
  return [...new Set(ids)].sort(stringCompare);
}

const defaultTimers: ClientTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as Parameters<typeof globalThis.clearTimeout>[0]),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) =>
    globalThis.clearInterval(h as Parameters<typeof globalThis.clearInterval>[0]),
};

function defaultNow(): number {
  return performance.now();
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Listener = (...args: unknown[]) => void;

/** Minimum gap between two logs of a throwing `sampleInput` (and, separately, predictor hook). */
const SAMPLE_ERROR_LOG_MS = 1000;

/** Entries a `RollingByteRate` keeps; bytes added beyond them join the newest entry. */
const RATE_ENTRIES_MAX = 4096;

/**
 * Bytes per second over a rolling window (`stats().bytesInPerSec`/`bytesOutPerSec`, docs/net.md B.3):
 * `perSecond(now)` counts the bytes added at times in `(now - windowMs, now]`. Entries sit in a ring
 * of typed arrays that grows only while a burst needs it; bytes added at the newest entry's time
 * (or beyond `RATE_ENTRIES_MAX` entries) join that entry.
 */
class RollingByteRate {
  private readonly windowMs: number;
  private times = new Float64Array(64);
  private sizes = new Float64Array(64);
  /** Ring index of the oldest entry. */
  private head = 0;
  private count = 0;
  private sum = 0;

  constructor(windowMs = 1000) {
    this.windowMs = windowMs;
  }

  add(bytes: number, nowMs: number): void {
    this.evict(nowMs);
    this.sum += bytes;
    if (this.count > 0) {
      const newest = (this.head + this.count - 1) % this.times.length;
      if (!((this.times[newest] as number) < nowMs) || this.count >= RATE_ENTRIES_MAX) {
        this.sizes[newest] = (this.sizes[newest] as number) + bytes;
        return;
      }
    }
    if (this.count === this.times.length) this.grow();
    const slot = (this.head + this.count) % this.times.length;
    this.times[slot] = nowMs;
    this.sizes[slot] = bytes;
    this.count++;
  }

  /** Bytes added in the window ending at `nowMs`, per second. */
  perSecond(nowMs: number): number {
    this.evict(nowMs);
    return (this.sum * 1000) / this.windowMs;
  }

  private evict(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    while (this.count > 0 && (this.times[this.head] as number) <= cutoff) {
      this.sum -= this.sizes[this.head] as number;
      this.head = (this.head + 1) % this.times.length;
      this.count--;
    }
    if (this.count === 0) this.sum = 0;
  }

  private grow(): void {
    const capacity = this.times.length;
    const times = new Float64Array(capacity * 2);
    const sizes = new Float64Array(capacity * 2);
    for (let i = 0; i < this.count; i++) {
      times[i] = this.times[(this.head + i) % capacity] as number;
      sizes[i] = this.sizes[(this.head + i) % capacity] as number;
    }
    this.times = times;
    this.sizes = sizes;
    this.head = 0;
  }
}

/**
 * One connection to a session (docs/net.md B.3): handshake, clock sync, replica, input and region
 * reporting. A reconnectable close while Playing moves to Reconnecting, which retries with the
 * reconnect token after `RECONNECT_DELAYS_MS`; the server's Welcome then leads to Resyncing (the
 * same player: replica, events and input reset, back to Playing after a FULL snapshot) or, when the
 * server no longer knew the token, to a fresh join through Joined.
 */
let nextEventSource = 0;

export class NetClient {
  readonly clock: NetClock;
  /** Accepted descriptor from Welcome; null before admission. */
  private readonly maxSessionCapacity: number;
  private sessionCapacityValue = 0;
  private acceptedCompatibility: CompatibilityDescriptor | null = null;
  private readonly offeredCompatibility: CompatibilityDescriptor;
  readonly mirror: ReplicaWorld;
  readonly regions: RegionClient;
  /** The reconciliation stub (docs/net.md B.10); `null` unless `opts.prediction.enabled`. */
  readonly prediction: Reconciler | null;

  private url: string;
  private readonly game: ClientGameDef;
  private readonly registry: SchemaRegistry;
  private token: string;
  private readonly displayName: string;
  private readonly factory: TransportFactory;
  private readonly now: () => number;
  private readonly offeredSnapshotLimits: Readonly<SnapshotLimits>;
  private readonly snapshotAssembly: SnapshotAssembly;
  private assemblyTimer: unknown = undefined;
  private readonly timers: ClientTimers;
  private readonly log: LogFn;
  private readonly autoReady: boolean;
  private readonly autoReconnect: boolean;
  private readonly batchSends: boolean;
  /** The newest snapshot tick to ack in the next frame (B.6); -1 for none. */
  private deferredAck = -1;
  /** When the waiting Ack began to wait. */
  private deferredSinceMs = 0;
  /** Sends the waiting Ack on its own if no frame took it first. */
  private deferredTimer: unknown = null;
  private readonly inputSchema: Schema<InputPayload>;
  private readonly diagnostics: DiagnosticOptions | undefined;
  private readonly inputSender: InputSender;
  private readonly eventSource = ++nextEventSource;
  private connectionEpoch = 0;
  private eventOrder = 0;
  private readonly eventMessages = new Set<string>();
  private readonly eventBuffer: EventBuffer;
  private readonly encoder = new FrameEncoderSession();
  private readonly listeners = new Map<keyof NetClientEvents, Set<Listener>>();

  private current: ClientState = 'Disconnected';
  private transport: Transport | null = null;
  private pendingConnect: Deferred | null = null;
  private connectTimer: unknown = null;
  private pingTimer: unknown = null;
  private tickTimer: unknown = null;
  private readonly inputScheduling: 'hybrid' | 'timer' | 'manual';
  /** The backoff before the next reconnect attempt (Reconnecting without a transport). */
  private reconnectTimer: unknown = null;
  /** Index into `RECONNECT_DELAYS_MS`: 0 on leaving Playing, +1 per failed attempt or resync. */
  private reconnectAttempt = 0;
  /** Resyncing: a FULL snapshot was applied / the own Spawned arrived on this connection. */
  private resyncFull = false;
  private resyncSpawned = false;
  private sessionTickRate: number;
  private sessionSnapshotEvery: number;
  private ownPlayerId = -1;
  private ownEntity: EntityId = ENTITY_NONE;
  private reconnectTokenValue = '';
  private playerList: readonly PlayerEntry[] = [];
  private worldGraph: WorldGraph | undefined = undefined;
  /** The `worldSeed` `worldGraph` was built for; `null` until a Welcome. */
  private graphSeed: number | null = null;
  private wantedActive: RegionId[] = [];
  private reportedLoaded = new Set<RegionId>();
  private readySent = false;
  private kickReason: number | null = null;
  private frameRecvMs = 0;
  private expectedSeqIn = 0;
  private badFrameStreak = 0;
  private lastSampleErrorMs = -Infinity;
  private lastPredictorErrorMs = -Infinity;
  private readonly counters = {
    bytesIn: 0,
    bytesOut: 0,
    snapshots: 0,
    seqGaps: 0,
    lastSnapshotTick: 0,
    badFrames: 0,
    ignoredMessages: 0,
  };
  private readonly bytesInRate = new RollingByteRate();
  private readonly bytesOutRate = new RollingByteRate();

  constructor(opts: NetClientOptions) {
    this.maxSessionCapacity = opts.maxSessionCapacity ?? PROTOCOL_SESSION_CAPACITY_MAX;
    if (
      !Number.isInteger(this.maxSessionCapacity) ||
      this.maxSessionCapacity < 1 ||
      this.maxSessionCapacity > PROTOCOL_SESSION_CAPACITY_MAX
    )
      throw new RangeError('NetClient: invalid maxSessionCapacity');
    this.diagnostics = opts.diagnostics;
    this.offeredSnapshotLimits = snapshotLimits(opts.snapshotLimits);
    this.snapshotAssembly = new SnapshotAssembly(this.offeredSnapshotLimits);
    const game = opts.game;
    this.offeredCompatibility =
      game.compatibility === undefined
        ? createCompatibilityDescriptor(game.id)
        : copyCompatibilityDescriptor(game.compatibility);
    if (this.offeredCompatibility.gameId !== game.id)
      throw new RangeError('NetClient: compatibility gameId must equal game.id');
    const registry = game.registry;
    if (game.input !== registry.input && game.input.descriptor !== registry.input.descriptor) {
      throw new RangeError('NetClient: game.input is not the registry input schema');
    }
    checkToken(opts.token);
    if (utf8Length(opts.displayName) > 32) {
      throw new RangeError('NetClient: displayName exceeds 32 UTF-8 bytes');
    }
    this.inputScheduling = opts.inputScheduling ?? 'hybrid';
    this.url = opts.url;
    this.game = game;
    this.registry = registry;
    this.token = opts.token;
    this.displayName = opts.displayName;
    this.factory = opts.transport ?? webSocketTransport;
    this.now = opts.now ?? defaultNow;
    this.timers = opts.timers ?? defaultTimers;
    this.log = opts.log ?? consoleLog;
    this.autoReady = opts.autoReady ?? true;
    this.autoReconnect = opts.autoReconnect ?? true;
    this.batchSends = opts.batchSends ?? false;
    this.sessionTickRate = game.tickRate;
    this.sessionSnapshotEvery = game.snapshotEvery;

    this.clock = new NetClock({ now: this.now, maxInputLeadTicks: opts.maxInputLeadTicks });
    this.clock.configure(game.tickRate, game.snapshotEvery);
    this.mirror = new ReplicaWorld(registry, game.components, {
      tickRate: game.tickRate,
      snapshotEvery: game.snapshotEvery,
      log: this.log,
      extrapolation: opts.extrapolation,
    });
    this.regions = new RegionClient({
      report: (loaded, loading) => this.reportRegions(loaded, loading),
      loader: opts.assets,
      manifest: opts.manifest,
      timers: this.timers,
      log: this.log,
    });
    this.eventBuffer = new EventBuffer(registry);
    this.inputSchema = (registry.message(CoreKind.Input) as MessageDef)
      .schema as Schema<InputPayload>;
    const prediction = opts.prediction;
    const stub =
      prediction?.enabled === true
        ? new Reconciler(registry.input, this.mirror, {
            predictor: prediction.predictor,
            onPredictorError: (err, hook) => this.onPredictorError(err, hook),
          })
        : null;
    this.prediction = stub;
    // Disabled, the input path is exactly the plain send (docs/net.md B.10).
    const sendInput =
      stub === null
        ? (msg: InputPayload): void => {
            this.sendMessage(CoreKind.Input, this.inputSchema, msg);
          }
        : (msg: InputPayload): void => {
            // The envelope seq the Input got, after a waiting Ack in its frame.
            const seq = this.sendMessage(CoreKind.Input, this.inputSchema, msg);
            if (seq >= 0) stub.onInputSent(msg, seq);
          };
    this.inputSender = new InputSender(registry.input, sendInput, this.clock, opts.sampleInput, {
      now: this.now,
      onDiscontinuity: () => this.prediction?.reset(),
      onSampleError: (err) => this.onSampleError(err),
    });
  }

  get sessionCapacity(): number {
    return this.sessionCapacityValue;
  }

  get compatibility(): CompatibilityDescriptor | null {
    return this.acceptedCompatibility;
  }

  get state(): ClientState {
    return this.current;
  }

  /** Own player id from Welcome; -1 before it and after disconnecting. */
  get playerId(): number {
    return this.ownPlayerId;
  }

  /** Own entity from Spawned; `ENTITY_NONE` before it and after disconnecting. */
  get entity(): EntityId {
    return this.ownEntity;
  }

  /** Session membership from the latest SessionState. */
  get players(): readonly PlayerEntry[] {
    return this.playerList;
  }

  /** `game.world(Welcome.worldSeed)`; `undefined` before Welcome or when the game has no `world`. */
  get graph(): WorldGraph | undefined {
    return this.worldGraph;
  }

  /** From Welcome; every reconnect attempt sends it back in Hello. */
  get reconnectToken(): string {
    return this.reconnectTokenValue;
  }

  /**
   * Replaces the URL and the `Hello.sessionToken` of the next `connect()`: a client that joins
   * through a lobby gets a new token per join, and a SessionToken expires 10 minutes after it was
   * minted (docs/persist.md 2.3). Only while Disconnected (`Error` otherwise), so a reconnect always
   * resumes with the token its connection joined with; `RangeError` for a token over 2048 UTF-8 bytes.
   */
  setTarget(url: string, token: string): void {
    if (this.current !== 'Disconnected') {
      throw new Error(`NetClient.setTarget: only while Disconnected, not ${this.current}`);
    }
    checkToken(token);
    this.url = url;
    this.token = token;
  }

  /** Opens a connection. Resolves on Joined; rejects with a `ConnectError`. */
  connect(): Promise<void> {
    if (this.pendingConnect !== null) return this.pendingConnect.promise;
    if (this.current !== 'Disconnected') return Promise.resolve();
    this.clock.reset();
    this.clock.configure(this.game.tickRate, this.game.snapshotEvery);
    this.mirror.reset();
    this.eventBuffer.clear();
    this.inputSender.reset();
    this.prediction?.reset();
    this.sessionTickRate = this.game.tickRate;
    this.sessionSnapshotEvery = this.game.snapshotEvery;
    this.worldGraph = undefined;
    this.graphSeed = null;
    this.reconnectTokenValue = '';
    this.reconnectAttempt = 0;
    this.kickReason = null;
    this.badFrameStreak = 0;
    let transport: Transport;
    try {
      transport = this.factory(this.url);
    } catch (err) {
      return Promise.reject(err);
    }
    const pending = deferred();
    this.pendingConnect = pending;
    this.transport = transport;
    this.bind(transport);
    this.setState('Connecting');
    this.connectTimer = this.timers.setTimeout(
      () => this.onConnectTimeout(transport),
      CONNECT_TIMEOUT_MS,
    );
    return pending.promise;
  }

  /** Sends Leave when the server knows us, closes with 1000 and never reconnects. */
  disconnect(): void {
    if (this.current === 'Disconnected') return;
    if (serverKnows(this.current)) this.sendMessage(CoreKind.Leave, LeaveSchema, {});
    this.enterDisconnected(
      { code: 1000, reason: 'client disconnect', willReconnect: false },
      new ConnectError('aborted', 'disconnect() called before Welcome'),
    );
  }

  /** Sends Ready (for `autoReady: false`); only in Joined, once per connection. */
  ready(): void {
    if (this.current !== 'Joined' || this.readySent) {
      this.log('warn', 'ready() ignored', { state: this.current, readySent: this.readySent });
      return;
    }
    this.sendReady();
  }

  /** Stores a copy of `frame` as the input for the next client ticks. */
  sendInput(frame: InputFrameBase): void {
    this.inputSender.setFrame(frame);
  }

  /** Sample/send eligible input before presentation. Safe alongside the fallback timer. */
  pulseInput(nowMs = this.now()): boolean {
    if (this.current !== 'Playing') return false;
    const sent = this.inputSender.tick(nowMs);
    const diagnostics = this.diagnostics;
    if (diagnostics !== undefined) {
      const time = diagnosticNow(diagnostics.now ?? this.now);
      if (time !== undefined) {
        observeDiagnostic(diagnostics.observer, {
          version: 1,
          category: 'input',
          name: sent ? 'sent' : 'suppressed',
          timeMs: time,
          tick: this.inputSender.lastSentTick,
          value: 1,
          unit: 'count',
        });
        observeDiagnostic(diagnostics.observer, {
          version: 1,
          category: 'input',
          name: 'lead',
          timeMs: time,
          value: this.clock.inputLead,
          unit: 'ticks',
        });
      }
    }
    return sent;
  }

  /**
   * Sends RegionLoadState now (sorted, de-duplicated; `loading` minus `loaded`) and re-checks
   * Loading → Ready against the latest RegionSet's `active`. `RegionClient` calls this on every
   * RegionSet, group completion and release; games may call it directly.
   */
  reportRegions(loaded: readonly RegionId[], loading: readonly RegionId[]): void {
    const loadedSorted = uniqueSorted(loaded);
    const loadedSet = new Set(loadedSorted);
    const payload: RegionLoadStatePayload = {
      loaded: loadedSorted,
      loading: uniqueSorted(loading).filter((id) => !loadedSet.has(id)),
    };
    this.reportedLoaded = loadedSet;
    if (serverKnows(this.current)) {
      this.sendMessage(CoreKind.RegionLoadState, RegionLoadStateSchema, payload);
    }
    this.checkRegionsReady();
  }

  /**
   * Sends a `c2s`/`both` game message in its own frame now. Throws `RangeError` for a message the
   * registry lacks or that is server-to-client; dropped with a warning before Joined.
   */
  send<T>(def: MessageDef<T>, payload: T): void {
    const kind = this.registry.messageKind(def);
    if (kind < GAME_MESSAGE_KIND_BASE || def.direction === 's2c') {
      throw new RangeError(`NetClient.send: ${def.name} is not a client-to-server game message`);
    }
    if (!serverKnows(this.current)) {
      this.log('warn', `send(${def.name}) dropped`, { state: this.current });
      return;
    }
    this.sendMessage(kind, def.schema, payload);
  }

  /**
   * Once per animation frame, before `RenderWorld.update`: slews the clock, emits `'event'` for every
   * buffered replicated event whose tick the render tick has reached (in tick, then arrival order),
   * then collects replica entities destroyed more than `GC_LAG_TICKS` before the render tick (the
   * only `gc` caller), so an event is always emitted before gc runs in the same update.
   */
  update(nowMs: number = this.now()): void {
    this.clock.update(nowMs);
    if (this.clock.renderTimeMs === null) return;
    const renderTick = this.clock.renderTick();
    for (;;) {
      const ev = this.eventBuffer.shiftDue(renderTick);
      if (ev === undefined) break;
      this.emit('event', ev);
    }
    const before = Math.floor(renderTick) - gcLagTicks(this.sessionSnapshotEvery);
    if (before > 0) this.mirror.gc(before);
  }

  on<K extends keyof NetClientEvents>(evt: K, cb: NetClientEvents[K]): () => void {
    let set = this.listeners.get(evt);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(evt, set);
    }
    const call = cb as unknown as Listener;
    const listener: Listener = (...args) => call(...args);
    set.add(listener);
    const owned = set;
    return () => {
      owned.delete(listener);
    };
  }

  stats(): NetClientStats {
    const now = this.now();
    const stats: NetClientStats = {
      rttMs: this.clock.rttMs,
      jitterMs: this.clock.jitterMs,
      ...this.counters,
      bytesInPerSec: this.bytesInRate.perSecond(now),
      bytesOutPerSec: this.bytesOutRate.perSecond(now),
    };
    if (this.prediction !== null) stats.prediction = this.prediction.stats();
    return stats;
  }

  private emit<K extends keyof NetClientEvents>(
    evt: K,
    ...args: Parameters<NetClientEvents[K]>
  ): void {
    const set = this.listeners.get(evt);
    if (set === undefined) return;
    for (const listener of [...set]) {
      try {
        listener(...args);
      } catch (err) {
        this.log('error', `'${evt}' listener threw`, { err });
      }
    }
  }

  private setState(next: ClientState): void {
    const prev = this.current;
    if (prev === next) return;
    assertTransition(prev, next);
    this.current = next;
    this.emit('state', next, prev);
  }

  private bind(t: Transport): void {
    const handlers = this.handlersFor(t);
    t.onOpen(() => {
      if (this.transport === t) this.onOpen(t);
    });
    t.onMessage((buf) => {
      if (this.transport === t) this.onFrame(t, buf, handlers);
    });
    t.onClose((code, reason) => {
      if (this.transport === t) this.onTransportClose(code, reason);
    });
    t.onError((err) => {
      if (this.transport === t) this.onTransportError(err);
    });
  }

  /** Sends Hello: a fresh join from Connecting, the stored reconnect token from Reconnecting. */
  private onOpen(t: Transport): void {
    this.connectionEpoch++;
    this.eventOrder = 0;
    this.eventMessages.clear();
    const state = this.current;
    if (state !== 'Connecting' && state !== 'Reconnecting') return;
    this.encoder.reset();
    this.clearDeferred();
    this.resetAssembly();
    this.expectedSeqIn = 0;
    this.sendMessage(CoreKind.Hello, HelloSchema, {
      snapshotLimits: this.offeredSnapshotLimits,
      protocolVersion: this.game.protocolVersion,
      maxSessionCapacity: this.maxSessionCapacity,
      compatibility: this.offeredCompatibility,
      registryHash: this.registry.hash,
      sessionToken: this.token,
      reconnectToken: state === 'Reconnecting' ? this.reconnectTokenValue : '',
      displayName: this.displayName,
    });
    // Reconnecting stays put until the Welcome.
    if (state === 'Connecting' && this.transport === t) this.setState('Handshaking');
  }

  private onFrame(t: Transport, buf: Uint8Array, handlers: ServerMessageHandlers): void {
    this.frameRecvMs = this.now();
    // A throttled timer (a hidden tab) must not hold the Ack back: frames keep arriving.
    if (
      this.deferredTimer !== null &&
      this.frameRecvMs - this.deferredSinceMs >= this.deferredSendMs()
    )
      this.flushDeferred();
    this.counters.bytesIn += buf.byteLength;
    this.bytesInRate.add(buf.byteLength, this.frameRecvMs);
    try {
      dispatchFrame(buf, this.registry, handlers);
      this.badFrameStreak = 0;
    } catch (err) {
      if (!(err instanceof DecodeError)) {
        this.log('error', 'frame handling failed', { err });
        this.emit('error', err);
        return;
      }
      this.counters.badFrames++;
      this.badFrameStreak++;
      this.log('warn', 'bad frame discarded', { err, streak: this.badFrameStreak });
      if (this.badFrameStreak >= MAX_BAD_FRAMES && this.transport === t) {
        this.emit('error', new Error(`${MAX_BAD_FRAMES} bad frames in a row`, { cause: err }));
        if (this.transport === t) this.disconnect();
      }
    }
  }

  private handlersFor(t: Transport): ServerMessageHandlers {
    const live = (): boolean => this.transport === t;
    const handlers: ServerMessageHandlers = {
      header: (h) => {
        if (live()) this.trackSeq(h);
      },
      welcome: (w) => {
        if (live()) this.onWelcome(t, w);
      },
      rejected: (r) => {
        if (live()) this.onRejected(r);
      },
      sessionState: (s) => {
        if (!live()) return;
        if (
          this.sessionCapacityValue > 0 &&
          (s.players.length > this.sessionCapacityValue ||
            s.players.some((player) => player.playerId >= this.sessionCapacityValue))
        )
          throw new DecodeError('count', 0, 'SessionState exceeds admitted capacity');
        this.playerList = s.players;
        this.emit('sessionState', s);
      },
      spawned: (s) => {
        if (live()) this.onSpawned(t, s);
      },
      snapshotPart: (part, header) => {
        if (!live()) return;
        let snapshot;
        try {
          snapshot = this.snapshotAssembly.accept(part, this.frameRecvMs, this.registry);
        } catch (cause) {
          this.counters.badFrames++;
          this.resetAssembly();
          this.rejectSnapshot(cause);
          return;
        }
        this.armAssemblyTimer();
        if (snapshot !== null) handlers.snapshot?.(snapshot, header);
      },
      snapshot: (s) => {
        if (!live()) return;
        if (!serverKnows(this.current)) {
          this.counters.ignoredMessages++;
          return;
        }
        const full = (s.header.flags & SNAPSHOT_FLAG_FULL) !== 0;
        if (
          (this.snapshotAssembly.pending && !full) ||
          s.header.serverTick < this.mirror.latestTick ||
          (full ? s.header.baselineTick !== 0 : s.header.baselineTick !== this.mirror.latestTick)
        ) {
          this.resetAssembly();
          this.rejectSnapshot(
            new Error(
              'Snapshot baseline gap or overlapping transaction; reconnect for a complete full resync',
            ),
          );
          return;
        }
        this.resetAssembly();
        try {
          this.mirror.applySnapshot(s);
        } catch (cause) {
          this.mirror.reset();
          this.prediction?.reset();
          this.rejectSnapshot(cause);
          return;
        }
        const previousOffset = this.diagnostics === undefined ? 0 : this.clock.offsetMs;
        this.clock.onSnapshotArrival(s.header.serverTimeMs, s.header.serverTick, this.frameRecvMs);
        if (this.diagnostics !== undefined) {
          const time = diagnosticNow(this.diagnostics.now ?? this.now);
          if (time !== undefined) {
            observeDiagnostic(this.diagnostics.observer, {
              version: 1,
              category: 'clock',
              name: 'correction',
              timeMs: time,
              tick: s.header.serverTick,
              value: this.clock.offsetMs - previousOffset,
              unit: 'ms',
            });
            observeDiagnostic(this.diagnostics.observer, {
              version: 1,
              category: 'replication',
              name: 'snapshot',
              timeMs: time,
              tick: s.header.serverTick,
              value: 1,
              unit: 'count',
            });
          }
        }
        this.sendAck(s.header.serverTick);
        this.counters.snapshots++;
        this.counters.lastSnapshotTick = s.header.serverTick;
        if (this.current === 'Resyncing' && (s.header.flags & SNAPSHOT_FLAG_FULL) !== 0) {
          this.resyncFull = true;
        }
        this.prediction?.onSnapshot(s.header, this.ownEntity); // docs/net.md B.10
        this.emit('snapshot', s.header);
        if (live()) this.checkResynced();
      },
      events: (e, header) => {
        if (!live()) return;
        if (!serverKnows(this.current)) {
          this.counters.ignoredMessages++;
          return;
        }
        if (this.eventMessages.has(`${header.tick}:${header.seq}`)) return;
        this.eventMessages.add(`${header.tick}:${header.seq}`);
        if (this.eventMessages.size > 128)
          this.eventMessages.delete(this.eventMessages.values().next().value!);
        this.eventBuffer.push(e, {
          identify: (index) => ({
            id: `${this.eventSource}:${this.connectionEpoch}:${header.tick}:${header.seq}:${this.eventOrder}:${index}`,
            connectionEpoch: this.connectionEpoch,
            order: ++this.eventOrder,
          }),
          onArrival: (event) => {
            if (live()) this.emit('authoritativeEvent', event);
          },
        });
      },
      pong: (p) => {
        if (live())
          this.clock.onPong(p.clientTimeMs, p.serverTimeMs, p.serverTick, this.frameRecvMs);
      },
      regionSet: (r) => {
        if (live()) this.onRegionSet(t, r);
      },
      kicked: (k) => {
        if (!live()) return;
        this.kickReason = k.reason;
        this.emit('kicked', k);
      },
      message: (def, payload, h) => {
        if (live()) this.emit('message', { def, tick: h.tick, payload });
      },
      ignored: () => {
        this.counters.ignoredMessages++;
      },
    };
    return handlers;
  }

  private trackSeq(h: MessageHeader): void {
    if (h.seq !== this.expectedSeqIn) this.counters.seqGaps++;
    this.expectedSeqIn = nextSeq(h.seq);
  }

  /**
   * Handshaking: a fresh join → Joined. Reconnecting: the resync reset, then Resyncing when the
   * Welcome repeats our `playerId` and reconnect token (the server rebound our player, docs/net.md
   * A.6), else a fresh join → Joined: the server no longer knew the token (grace expired, or a
   * restarted session hands out the same slot with a new token), so the old player and entity are gone.
   */
  private onWelcome(t: Transport, w: WelcomePayload): void {
    const state = this.current;
    if (state !== 'Handshaking' && state !== 'Reconnecting') {
      this.log('warn', 'unexpected Welcome ignored', { state });
      this.counters.ignoredMessages++;
      return;
    }
    if (w.simTickRate < 1 || w.snapshotEvery < 1) {
      const err = new Error(`invalid Welcome rates ${w.simTickRate}/${w.snapshotEvery}`);
      this.emit('error', err);
      this.enterDisconnected(
        { code: 1006, reason: 'invalid Welcome', willReconnect: false },
        new ConnectError('error', err.message, { cause: err }),
      );
      return;
    }
    const acceptedLimits = snapshotLimits(w.snapshotLimits);
    for (const key of ['maxBytes', 'maxParts', 'inactivityMs', 'lifetimeMs'] as const)
      if (acceptedLimits[key] > this.offeredSnapshotLimits[key])
        throw new Error('Welcome snapshot limits exceed client support');
    this.snapshotAssembly.configure(acceptedLimits);
    this.clearTimer('connectTimer');
    const resync =
      state === 'Reconnecting' &&
      w.playerId === this.ownPlayerId &&
      w.reconnectToken === this.reconnectTokenValue;
    if (state === 'Reconnecting') this.resetForResync(resync);
    const accepted =
      w.compatibility === undefined
        ? createCompatibilityDescriptor(this.game.id)
        : copyCompatibilityDescriptor(w.compatibility);
    const mismatches = compatibilityDifferences(this.offeredCompatibility, accepted);
    if (mismatches.length > 0) {
      const error = new ConnectError('error', `incompatible Welcome: ${mismatches.join(', ')}`);
      this.enterDisconnected({ code: 4013, reason: error.message, willReconnect: false }, error);
      return;
    }
    const capacity = w.sessionCapacity ?? DEFAULT_SESSION_CAPACITY;
    if (
      !Number.isInteger(capacity) ||
      capacity < 1 ||
      capacity > this.maxSessionCapacity ||
      w.playerId >= capacity
    ) {
      const error = new ConnectError('error', 'Welcome exceeds supported session capacity');
      this.enterDisconnected({ code: 4014, reason: error.message, willReconnect: false }, error);
      return;
    }
    this.sessionCapacityValue = capacity;
    this.acceptedCompatibility = accepted;
    this.ownPlayerId = w.playerId;
    this.reconnectTokenValue = w.reconnectToken;
    this.sessionTickRate = w.simTickRate;
    this.sessionSnapshotEvery = w.snapshotEvery;
    this.clock.configure(w.simTickRate, w.snapshotEvery);
    this.mirror.configure(w.simTickRate, w.snapshotEvery);
    if (!resync) {
      // A new clock: RTT 0 until the first Pong. A resync keeps its window; a Welcome's tick-start
      // time, sent between ticks, sees the offset low, and loses to any sample seeing it better.
      this.clock.addSample(w.serverTimeMs, w.serverTick, this.frameRecvMs);
    }
    if (this.graphSeed !== w.worldSeed) {
      this.worldGraph = this.buildGraph(w.worldSeed);
      this.graphSeed = w.worldSeed;
    }
    this.readySent = false;
    const pending = this.pendingConnect;
    this.pendingConnect = null;
    pending?.resolve(); // settles asynchronously, after the state below
    this.setState(resync ? 'Resyncing' : 'Joined');
    if (this.transport !== t) return;
    this.emit('welcome', w);
    if (this.transport !== t) return;
    if (!resync && this.autoReady) this.sendReady();
    this.startPings();
  }

  /**
   * A Ping now, `QUICK_PINGS` more `QUICK_PING_MS` apart -- one Pong handled late puts the RTT
   * estimate hundreds of ms high, and the next that measures less puts it right (B.4) -- then one
   * every `PING_INTERVAL_MS`.
   */
  private startPings(): void {
    this.sendPing();
    this.clearTimer('pingTimer');
    let quick = QUICK_PINGS;
    this.pingTimer = this.timers.setInterval(() => {
      this.sendPing();
      if (--quick > 0) return;
      this.clearTimer('pingTimer');
      this.pingTimer = this.timers.setInterval(() => this.sendPing(), PING_INTERVAL_MS);
    }, QUICK_PING_MS);
  }

  /**
   * The resync reset on a Welcome in Reconnecting (docs/net.md B.3): the replica, buffered events
   * and sent input frames belong to the lost connection. A resync keeps the clock's offset window
   * (the same session clock) and forgets only the jitter history. A fresh join also forgets the
   * old entity and the whole clock, since a restarted session starts its time and ticks over.
   * Regions stay held either way; the server's RegionSet re-reports them.
   */
  private resetForResync(resync: boolean): void {
    this.mirror.reset();
    this.eventBuffer.clear();
    this.inputSender.reset();
    this.prediction?.reset(); // the server restarts appliedTick/appliedSeq with the new link
    this.resyncFull = false;
    this.resyncSpawned = false;
    if (resync) {
      this.clock.resetJitter();
    } else {
      this.clock.reset();
      this.ownEntity = ENTITY_NONE;
    }
  }

  private buildGraph(seed: number): WorldGraph | undefined {
    if (this.game.world === undefined) return undefined;
    try {
      return this.game.world(seed);
    } catch (err) {
      this.log('error', 'game.world(seed) threw', { seed, err });
      this.emit('error', err);
      return undefined;
    }
  }

  private onRejected(r: RejectedPayload): void {
    // Rejected is final: no reconnect whatever the close code that follows (docs/net.md B.3).
    const message = describeRejected(r);
    this.log('warn', message);
    this.enterDisconnected(null, new ConnectError('rejected', message, { rejected: r }), () =>
      this.emit('rejected', r),
    );
  }

  private onSpawned(t: Transport, s: SpawnedPayload): void {
    if (this.ownPlayerId >= 0 && s.playerId === this.ownPlayerId) {
      this.ownEntity = s.entity;
      if (this.current === 'Ready') {
        this.enterPlaying();
      } else if (this.current === 'Resyncing') {
        this.resyncSpawned = true;
        this.checkResynced();
      }
    }
    if (this.transport === t) this.emit('spawned', s);
  }

  private onRegionSet(t: Transport, r: RegionSetPayload): void {
    if (!serverKnows(this.current)) {
      this.counters.ignoredMessages++;
      return;
    }
    this.wantedActive = uniqueSorted(r.active);
    this.regions.apply(r); // reports now, and again as each region's asset group completes
    if (this.transport !== t) return;
    this.emit('regionSet', r);
    if (this.transport !== t) return;
    if (this.current === 'Joined') this.setState('Loading');
    else if (this.current === 'Ready' && !this.regionsReady()) this.setState('Loading');
    this.checkRegionsReady();
  }

  /**
   * Whether the last reported `loaded` set covers the latest `active` set. When `RegionClient`
   * reports, that set is `regions.loaded()`, so Ready waits for every active region's asset group
   * (a failed group counts as loaded); prefetch regions never hold it back.
   */
  private regionsReady(): boolean {
    for (const id of this.wantedActive) if (!this.reportedLoaded.has(id)) return false;
    return true;
  }

  private checkRegionsReady(): void {
    if (this.current !== 'Loading' || !this.regionsReady()) return;
    const t = this.transport;
    this.setState('Ready');
    // `state`, not `current`: listeners of the transition above may have moved on.
    if (this.transport === t && this.state === 'Ready' && this.ownEntity !== ENTITY_NONE) {
      this.enterPlaying();
    }
  }

  /** Ready or Resyncing → Playing; starts the client tick (docs/net.md B.6). */
  private enterPlaying(): void {
    this.setState('Playing');
    if (this.state !== 'Playing' || this.tickTimer !== null) return;
    if (this.inputScheduling !== 'manual') this.scheduleInputWake();
  }

  private scheduleInputWake(): void {
    const deadline = this.clock.nextInputDeadline(this.inputSender.lastSentTick);
    // A stale estimate can put the deadline in the past; retry without spinning.
    const delay = Math.max(1, deadline - this.now());
    this.tickTimer = this.timers.setTimeout(() => {
      this.tickTimer = null;
      if (this.current !== 'Playing') return;
      this.pulseInput();
      if (this.current === 'Playing') this.scheduleInputWake();
    }, delay);
  }

  /** Resyncing → Playing once a FULL snapshot was applied and the own Spawned arrived. */
  private checkResynced(): void {
    if (this.current === 'Resyncing' && this.resyncFull && this.resyncSpawned) this.enterPlaying();
  }

  private sendReady(): void {
    this.readySent = true;
    this.sendMessage(CoreKind.Ready, ReadySchema, {});
  }

  /**
   * Never deferred, though it takes a waiting Ack along: a Ping is a clock sample, and one riding
   * in an Input frame measured a lower RTT on a jittery link than the input frames then met,
   * lowering the input lead (docs/net.md B.6).
   */
  private sendPing(): void {
    this.sendMessage(CoreKind.Ping, PingSchema, { clientTimeMs: toU32Ms(this.now()) });
  }

  /** Acks are cumulative, so of several waiting only the newest goes (docs/net.md B.6). */
  private sendAck(lastSnapshotTick: number): void {
    if (!this.batchSends) {
      this.sendMessage(CoreKind.Ack, AckSchema, { lastSnapshotTick });
      return;
    }
    this.deferredAck = Math.max(this.deferredAck, lastSnapshotTick);
    if (this.deferredTimer !== null) return;
    this.deferredSinceMs = this.now();
    this.deferredTimer = this.timers.setTimeout(() => {
      this.deferredTimer = null;
      this.flushDeferred();
    }, this.deferredSendMs());
  }

  private deferredSendMs(): number {
    return (DEFERRED_SEND_TICKS * 1000) / this.sessionTickRate;
  }

  /** Appends the waiting Ack to the open frame. */
  private addDeferred(tick: number): void {
    if (this.deferredAck >= 0)
      this.encoder.add(CoreKind.Ack, tick, AckSchema, { lastSnapshotTick: this.deferredAck });
  }

  private clearDeferred(): void {
    this.deferredAck = -1;
    this.clearTimer('deferredTimer');
  }

  /** The waiting Ack in a frame of its own, now. */
  private flushDeferred(): void {
    const t = this.transport;
    if (t === null || this.deferredAck < 0) {
      this.clearDeferred();
      return;
    }
    this.encoder.begin();
    try {
      this.addDeferred(this.clock.serverTickNow());
    } catch (err) {
      this.encoder.abort();
      throw err;
    }
    this.clearDeferred();
    this.transmit(t, this.encoder.finish());
  }

  /**
   * `payload` in a frame sent now, after a waiting Ack (B.6). Returns the message's envelope seq,
   * or -1 when there is no transport. On a throw nothing is consumed or sent.
   */
  private sendMessage<T>(kind: number, schema: Schema<T>, payload: T): number {
    const t = this.transport;
    if (t === null) return -1;
    const tick = this.clock.serverTickNow();
    const encoder = this.encoder;
    encoder.begin();
    let seq: number;
    try {
      this.addDeferred(tick);
      seq = encoder.seq;
      encoder.add(kind, tick, schema, payload);
    } catch (err) {
      encoder.abort();
      throw err;
    }
    this.clearDeferred();
    this.transmit(t, encoder.finish());
    return seq;
  }

  private transmit(t: Transport, buf: Uint8Array): void {
    t.send(buf);
    this.counters.bytesOut += buf.byteLength;
    this.bytesOutRate.add(buf.byteLength, this.now());
  }

  private onTransportClose(code: number, reason: string): void {
    const state = this.current;
    if (state === 'Connecting' || state === 'Handshaking') {
      const text = reason === '' ? `${code}` : `${code} ${reason}`;
      this.enterDisconnected(
        { code, reason, willReconnect: false },
        new ConnectError('closed', `connection closed before Welcome (${text})`, { code }),
      );
      return;
    }
    if (state === 'Reconnecting') {
      this.reconnectFailed(code, reason, this.mayReconnect(code));
      return;
    }
    if ((state === 'Playing' || state === 'Resyncing') && this.mayReconnect(code)) {
      this.enterReconnecting(code, reason, state === 'Resyncing');
      return;
    }
    // Joined, Loading and Ready: the server freed the slot. Playing, Resyncing: a final close.
    this.enterDisconnected({ code, reason, willReconnect: false }, null);
  }

  private rejectSnapshot(error: unknown): void {
    const transport = this.transport;
    this.emit('error', error);
    // Decode rejection is local: no remote close event will arrive to start recovery.
    if (transport !== null && this.transport === transport)
      this.onTransportClose(1006, 'Invalid snapshot; full resync required');
  }

  private onTransportError(err: unknown): void {
    const transport = this.transport;
    this.emit('error', err);
    if (transport === null || this.transport !== transport) return;
    const state = this.current;
    if (state === 'Reconnecting') {
      // A failed attempt; the transport is released, so the close event that follows is ignored.
      if (this.transport !== null) this.reconnectFailed(1006, 'transport error', true);
      return;
    }
    if (state !== 'Connecting' && state !== 'Handshaking') return; // the close event follows
    this.enterDisconnected(
      { code: 1006, reason: 'transport error', willReconnect: false },
      new ConnectError('error', 'transport error before Welcome', { cause: err }),
    );
  }

  private onConnectTimeout(t: Transport): void {
    this.connectTimer = null;
    if (this.transport !== t) return;
    if (this.current === 'Reconnecting') {
      this.reconnectFailed(1006, 'connect timeout', true);
      return;
    }
    if (this.current !== 'Connecting' && this.current !== 'Handshaking') return;
    this.enterDisconnected(
      { code: 1006, reason: 'connect timeout', willReconnect: false },
      new ConnectError('timeout', `no Welcome within ${CONNECT_TIMEOUT_MS} ms`),
    );
  }

  /**
   * Whether a close with `code` may lead to a reconnect attempt: `autoReconnect`, a reconnectable
   * code (docs/net.md A.3), and no Kicked with a final reason (anything but ServerShutdown or
   * AckTimeout) on this connection.
   */
  private mayReconnect(code: number): boolean {
    return (
      this.autoReconnect &&
      isReconnectableClose(code) &&
      (this.kickReason === null || !isFinalKick(this.kickReason))
    );
  }

  /**
   * Playing or Resyncing lost its connection (docs/net.md B.3): stops the client tick and pings,
   * keeps the reconnect token, player, entity, replica, regions and clock window, and schedules an
   * attempt. Leaving Playing starts the backoff over; a lost resync counts as a failed attempt, so a
   * server that keeps dropping the client during resync cannot hold it in a loop.
   */
  private enterReconnecting(code: number, reason: string, afterResync: boolean): void {
    this.releaseTransport(reason);
    this.reconnectAttempt = afterResync ? this.reconnectAttempt + 1 : 0;
    if (!this.scheduleReconnect()) {
      this.enterDisconnected({ code, reason, willReconnect: false }, null);
      return;
    }
    this.setState('Reconnecting');
    if (this.current !== 'Reconnecting') return; // a state listener called disconnect()
    this.emit('disconnected', { code, reason, willReconnect: true });
  }

  /** Schedules the attempt `reconnectAttempt` after its backoff; false once every delay was used. */
  private scheduleReconnect(): boolean {
    const delay = RECONNECT_DELAYS_MS[this.reconnectAttempt];
    if (delay === undefined) return false;
    this.reconnectTimer = this.timers.setTimeout(() => this.reconnectNow(), delay);
    return true;
  }

  /** The backoff ended: a new transport; its `onOpen` sends Hello with the reconnect token. */
  private reconnectNow(): void {
    this.reconnectTimer = null;
    if (this.current !== 'Reconnecting' || this.transport !== null) return;
    let transport: Transport;
    try {
      transport = this.factory(this.url);
    } catch (err) {
      this.log('warn', 'reconnect: the transport factory threw', { err });
      this.emit('error', err);
      if (this.current === 'Reconnecting') {
        this.reconnectFailed(1006, 'transport factory threw', true);
      }
      return;
    }
    this.transport = transport;
    this.kickReason = null;
    this.badFrameStreak = 0;
    this.bind(transport);
    this.connectTimer = this.timers.setTimeout(
      () => this.onConnectTimeout(transport),
      CONNECT_TIMEOUT_MS,
    );
  }

  /**
   * A reconnect attempt ended before its Welcome (close, transport error, connect timeout). Retries
   * after the next backoff when `retry` and a delay is left; otherwise gives up: Disconnected with
   * `willReconnect: false`.
   */
  private reconnectFailed(code: number, reason: string, retry: boolean): void {
    this.releaseTransport(reason);
    this.reconnectAttempt++;
    this.log('info', 'reconnect attempt failed', {
      attempt: this.reconnectAttempt,
      code,
      reason,
    });
    if (retry && this.scheduleReconnect()) return;
    this.enterDisconnected({ code, reason, willReconnect: false }, null);
  }

  /**
   * Detaches the transport (its later callbacks are ignored), closes it (a no-op when it already
   * closed) and stops the timers that belong to a connection.
   */
  private releaseTransport(reason: string): void {
    this.resetAssembly();
    const t = this.transport;
    this.transport = null;
    this.clearTimer('connectTimer');
    this.clearTimer('pingTimer');
    this.clearTimer('tickTimer');
    this.clearDeferred(); // a waiting Ack belongs to the connection
    t?.close(1000, reason);
  }

  private resetAssembly(): void {
    if (this.assemblyTimer !== undefined) this.timers.clearTimeout(this.assemblyTimer);
    this.assemblyTimer = undefined;
    this.snapshotAssembly.reset();
  }
  private armAssemblyTimer(): void {
    if (this.assemblyTimer !== undefined) this.timers.clearTimeout(this.assemblyTimer);
    this.assemblyTimer = undefined;
    const deadline = this.snapshotAssembly.deadline;
    if (deadline === undefined) return;
    this.assemblyTimer = this.timers.setTimeout(
      () => {
        this.assemblyTimer = undefined;
        if (this.snapshotAssembly.expire(this.now()))
          this.rejectSnapshot(
            new Error('Snapshot assembly progress/lifetime timeout; reconnect for full resync'),
          );
        else this.armAssemblyTimer();
      },
      Math.max(1, deadline - this.now()),
    );
  }

  private onSampleError(err: unknown): void {
    const now = this.now();
    if (now - this.lastSampleErrorMs < SAMPLE_ERROR_LOG_MS) return;
    this.lastSampleErrorMs = now;
    this.log('error', 'sampleInput threw; the previous input was sent', { err });
  }

  /** A predictor hook threw (docs/net.md B.10); logged at most once per `SAMPLE_ERROR_LOG_MS`. */
  private onPredictorError(err: unknown, hook: PredictorHook): void {
    const now = this.now();
    if (now - this.lastPredictorErrorMs < SAMPLE_ERROR_LOG_MS) return;
    this.lastPredictorErrorMs = now;
    this.log('error', `predictor.${hook} threw`, { err });
  }

  /**
   * Leaves the connection: detaches and closes the transport, stops timers (a pending reconnect
   * attempt included), releases regions, then moves to Disconnected, rejects a pending `connect()`
   * with `connectError`, runs `before` (the Rejected event) and emits `disconnected` when `info` is
   * given.
   */
  private enterDisconnected(
    info: DisconnectInfo | null,
    connectError: ConnectError | null,
    before?: () => void,
  ): void {
    const pending = this.pendingConnect;
    this.pendingConnect = null;
    this.releaseTransport(info?.reason ?? '');
    this.clearTimer('reconnectTimer');
    this.reconnectAttempt = 0;
    this.resyncFull = false;
    this.resyncSpawned = false;
    this.regions.reset();
    this.eventBuffer.clear();
    this.inputSender.reset();
    this.prediction?.reset();
    this.acceptedCompatibility = null;
    this.sessionCapacityValue = 0;
    this.ownPlayerId = -1;
    this.ownEntity = ENTITY_NONE;
    this.playerList = [];
    this.wantedActive = [];
    this.reportedLoaded = new Set();
    this.readySent = false;
    this.setState('Disconnected');
    before?.();
    if (pending !== null) pending.reject(connectError ?? new ConnectError('closed', 'closed'));
    if (info !== null) this.emit('disconnected', info);
  }

  private clearTimer(
    which: 'connectTimer' | 'pingTimer' | 'tickTimer' | 'reconnectTimer' | 'deferredTimer',
  ): void {
    const handle = this[which];
    if (handle === null) return;
    this[which] = null;
    if (which !== 'pingTimer') this.timers.clearTimeout(handle);
    else this.timers.clearInterval(handle);
  }
}
