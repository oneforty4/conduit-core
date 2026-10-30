import type { SessionToken } from '@conduit/auth';
import {
  ENTITY_NONE,
  type EntityId,
  type InputFrameBase,
  type MessageDef,
} from '@conduit/protocol';
import type { ReplicatedEvent } from '@conduit/sim';
import type { RegionId } from '@conduit/world';
import { RECONNECT_GRACE_MS, RTT_ALPHA, SENT_LOG_SIZE } from './constants.ts';
import type { ClientLink } from './link.ts';
import type { PlayerSpawn } from './session.ts';

/** Server-side connection states (docs/net.md A.6). */
export type ConnState =
  'handshaking' | 'joined' | 'loading' | 'ready' | 'playing' | 'away' | 'closed';

export interface SentSnapshot {
  tick: number;
  sentAtMs: number;
  bytes: number;
}

export interface QueuedInput {
  frame: InputFrameBase;
  /** Envelope seq of the Input message that carried the frame. */
  seq: number;
}

/** A game message queued for a client's next frame, encoded when it was queued. */
export interface OutboxMessage {
  def: MessageDef;
  payload: unknown;
  /** `registry.messageKind(def)`. */
  kind: number;
  /** The encoded payload. */
  bytes: Uint8Array;
}

/** One client slot of a Session (docs/net.md A.6). */
export interface ClientConn {
  /** `link.id` at the last bind. */
  id: number;
  /** 0..maxPlayers-1; -1 until the Hello is accepted. */
  playerId: number;
  state: ConnState;
  /** `null` while away and once closed. */
  link: ClientLink | null;
  /** From `attach`, or the verifier's result once the Hello arrives; `null` until then. */
  identity: SessionToken | null;
  /** Opaque logical identity for offline diagnostic replay; never an authorization credential. */
  actorId?: string;
  displayName: string;
  reconnectToken: string;
  plan: PlayerSpawn | null;
  /** `ENTITY_NONE` until spawned. */
  entity: EntityId;
  /** Session `now()` ms when the conn went away; valid in 'away'. */
  awaySince: number;
  handshakeTimer: unknown;

  // lifecycle bookkeeping (pipeline step 2)
  /** Lifecycle *join* is queued. */
  joinQueued: boolean;
  /** `onPlayerJoin` ran and returned `plan`. */
  joinRan: boolean;
  /** `Ready` arrived before *join* ran; handled right after it. */
  readyPending: boolean;
  /** Lifecycle *spawn* is queued. */
  spawnQueued: boolean;
  /** Lifecycle *leave* is queued. */
  leaveQueued: boolean;

  // input (docs/net.md A.7)
  /** Ascending tick, at most `INPUT_QUEUE_MAX`. */
  inputQueue: QueuedInput[];
  /** Seq of the newest Input message accepted. */
  lastInputSeq: number;
  /** Highest frame tick accepted into the queue. */
  lastInputTick: number;
  /** The frame `ctx.inputs(playerId)` returns. */
  held: InputFrameBase | undefined;
  /** Tick of the held frame when it was applied (Snapshot header `lastInputTick`). */
  appliedTick: number;
  /** Seq of the Input message that carried the held frame (Snapshot header `lastInputSeq`). */
  appliedSeq: number;
  /** c2s game messages accepted since the last dispatch (cap `MAX_GAME_MESSAGES_PER_TICK`). */
  gameMessagesQueued: number;

  // replication (docs/net.md A.8)
  /** Tick of the last snapshot sent; 0 = none. */
  baselineTick: number;
  lastAckedTick: number;
  lastAckAtMs: number;
  /** Ring of the last `SENT_LOG_SIZE` snapshots sent, oldest first. */
  sentLog: SentSnapshot[];
  known: Set<EntityId>;
  /** Component ids withheld from the client per known entity, as of the last snapshot (A.8.4). */
  withheld: Map<EntityId, ReadonlySet<number>>;
  /** The next snapshot is FULL. */
  fullNext: boolean;
  /** `RegionLoadState.loaded`. */
  reportedRegions: Set<RegionId>;
  /**
   * A `RegionLoadState` arrived since the conn was last bound to a link. A rebound conn gets no
   * snapshot or events until it has (docs/net.md A.6), so its first snapshot is FULL over the
   * regions it re-reported.
   */
  regionsReported: boolean;
  /** `RegionSet.active` last sent. */
  wantedRegions: Set<RegionId>;
  /** `RegionSet.prefetch` last sent. */
  prefetchRegions: Set<RegionId>;
  /** At most `PENDING_EVENTS_MAX` (docs/net.md A.8.3, M2). */
  pendingEvents: ReplicatedEvent[];
  /** Game messages to include in the next frame. */
  outbox: OutboxMessage[];
  snapshotDivisor: 1 | 2;
  snapshotPhase: number;

  // stats
  /** EWMA from Ack timing. */
  rttMs: number;
  /** Count of `sentLog` entries with `tick > lastAckedTick` (computed, so it survives ring eviction). */
  outstandingSnapshots(): number;
  /** Next outgoing envelope seq. */
  seqOut: number;
  /** Next expected incoming envelope seq. */
  seqIn: number;
  bytesOut: number;
}

/** Thrown by `transition` (and `rebindConn`) for an edge that is not in the A.6 table. */
export class ConnStateError extends Error {
  override readonly name = 'ConnStateError';
  readonly from: ConnState;
  readonly to: ConnState;

  constructor(from: ConnState, to: ConnState, context: string) {
    super(`illegal connection transition ${from} -> ${to}${context}`);
    this.from = from;
    this.to = to;
  }
}

/** The state edges of the A.6 table (the reconnect rebind of a still-bound playing conn is not a state change). */
export const CONN_TRANSITIONS: Readonly<Record<ConnState, readonly ConnState[]>> = Object.freeze({
  handshaking: ['joined', 'closed'],
  joined: ['loading', 'closed'],
  loading: ['ready', 'closed'],
  ready: ['playing', 'closed'],
  playing: ['away', 'closed'],
  away: ['playing', 'closed'],
  closed: [],
});

export function createConn(
  link: ClientLink | null,
  identity: SessionToken | null,
  nowMs: number,
): ClientConn {
  const conn: ClientConn = {
    id: link?.id ?? -1,
    playerId: -1,
    state: 'handshaking',
    link,
    identity,
    displayName: identity?.displayName ?? '',
    reconnectToken: '',
    plan: null,
    entity: ENTITY_NONE,
    awaySince: 0,
    handshakeTimer: undefined,
    joinQueued: false,
    joinRan: false,
    readyPending: false,
    spawnQueued: false,
    leaveQueued: false,
    inputQueue: [],
    lastInputSeq: 0,
    lastInputTick: 0,
    held: undefined,
    appliedTick: 0,
    appliedSeq: 0,
    gameMessagesQueued: 0,
    baselineTick: 0,
    lastAckedTick: 0,
    lastAckAtMs: nowMs,
    sentLog: [],
    known: new Set(),
    withheld: new Map(),
    fullNext: true,
    reportedRegions: new Set(),
    regionsReported: false,
    wantedRegions: new Set(),
    prefetchRegions: new Set(),
    pendingEvents: [],
    outbox: [],
    snapshotDivisor: 1,
    snapshotPhase: 0,
    rttMs: 0,
    outstandingSnapshots: () => countOutstanding(conn),
    seqOut: 0,
    seqIn: 0,
    bytesOut: 0,
  };
  return conn;
}

function countOutstanding(conn: ClientConn): number {
  let n = 0;
  for (const entry of conn.sentLog) if (entry.tick > conn.lastAckedTick) n++;
  return n;
}

/**
 * Asserts `conn.state -> to` is an edge of the A.6 table and applies it. Throws `ConnStateError`
 * otherwise.
 */
export function transition(
  conn: ClientConn,
  to: ConnState,
  session?: { readonly id: string },
): void {
  const from = conn.state;
  if (!CONN_TRANSITIONS[from].includes(to)) {
    const where = session === undefined ? '' : ` (session ${session.id}, player ${conn.playerId})`;
    throw new ConnStateError(from, to, where);
  }
  conn.state = to;
}

/**
 * Forgets everything the client had (reconnect rebind, docs/net.md A.6): the next snapshot is FULL
 * with `baselineTick` 0, and none is sent before the client re-reports its regions. The input
 * stream starts over too: the queue, the held frame and the duplicate watermark.
 */
export function resetReplication(conn: ClientConn, nowMs: number): void {
  conn.known = new Set();
  conn.withheld = new Map();
  conn.baselineTick = 0;
  conn.lastAckedTick = 0;
  conn.sentLog = [];
  conn.fullNext = true;
  conn.reportedRegions = new Set();
  conn.regionsReported = false;
  conn.wantedRegions = new Set();
  conn.prefetchRegions = new Set();
  conn.pendingEvents = [];
  conn.outbox = [];
  conn.inputQueue = [];
  conn.lastInputSeq = 0;
  conn.lastInputTick = 0;
  conn.held = undefined;
  conn.appliedTick = 0;
  conn.appliedSeq = 0;
  conn.snapshotDivisor = 1;
  conn.snapshotPhase = 0;
  conn.lastAckAtMs = nowMs;
}

/**
 * playing -> away (docs/net.md A.6): the link is gone (the caller unbinds it), the grace starts at
 * `nowMs`, and the player's input is released: `ctx.inputs(playerId)` is `undefined` from the next
 * tick until a reconnected client sends input again. Queued events and game messages are dropped.
 */
export function markAway(conn: ClientConn, nowMs: number, session?: { readonly id: string }): void {
  transition(conn, 'away', session);
  conn.link = null;
  conn.awaySince = nowMs;
  conn.inputQueue = [];
  conn.held = undefined;
  conn.pendingEvents = [];
  conn.outbox = [];
}

/** An away conn whose reconnect grace has run out at `nowMs`: its *leave* is due. */
export function graceExpired(
  conn: Pick<ClientConn, 'state' | 'awaySince'>,
  nowMs: number,
  graceMs: number = RECONNECT_GRACE_MS,
): boolean {
  return conn.state === 'away' && nowMs - conn.awaySince >= graceMs;
}

/**
 * Whether a Hello carrying `reconnectToken` from `accountId` resumes `conn` (docs/net.md A.6): the
 * token is not empty and is the conn's, the account is the conn's, and the conn is playing or away.
 * Anything else (no token, an unknown or stale token, another account's) is a fresh join.
 */
export function matchesReconnect(
  conn: Pick<ClientConn, 'state' | 'reconnectToken' | 'identity'>,
  reconnectToken: string,
  accountId: string,
): boolean {
  return (
    reconnectToken !== '' &&
    conn.reconnectToken === reconnectToken &&
    conn.identity?.accountId === accountId &&
    (conn.state === 'playing' || conn.state === 'away')
  );
}

/**
 * The reconnect rebind (docs/net.md A.6): `conn` takes over `link`, whose Hello carried `identity`
 * and advanced its incoming seq to `seqIn`. Outgoing seq restarts at 0, replication is reset
 * (`resetReplication`) and an away conn is playing again. The caller has already kicked and unbound
 * a still-bound previous link (`Kicked{Replaced}`, 4006); `playerId`, `entity`, `plan` and
 * `reconnectToken` are kept.
 */
export function rebindConn(
  conn: ClientConn,
  link: ClientLink,
  seqIn: number,
  identity: SessionToken,
  nowMs: number,
  session?: { readonly id: string },
): void {
  if (conn.state !== 'playing' && conn.state !== 'away') {
    throw new ConnStateError(conn.state, 'playing', ' (only a playing or away conn is rebound)');
  }
  conn.link = link;
  conn.id = link.id;
  conn.seqOut = 0;
  conn.seqIn = seqIn;
  conn.identity = identity;
  conn.awaySince = 0;
  resetReplication(conn, nowMs);
  if (conn.state === 'away') transition(conn, 'playing', session);
}

/** Appends to the sent-snapshot ring, evicting the oldest beyond `SENT_LOG_SIZE`. */
export function recordSent(conn: ClientConn, entry: SentSnapshot): void {
  conn.sentLog.push(entry);
  if (conn.sentLog.length > SENT_LOG_SIZE) conn.sentLog.shift();
}

/**
 * `Ack{lastSnapshotTick}` (docs/net.md A.9): advances `lastAckedTick` and `lastAckAtMs`, and feeds
 * the RTT EWMA when the acked snapshot is still in the ring. An ack beyond the last snapshot sent
 * (`baselineTick`) is ignored. Returns whether the ack advanced.
 */
export function recordAck(conn: ClientConn, lastSnapshotTick: number, nowMs: number): boolean {
  // Only a snapshot that was sent can be acked: ignore stale and future ticks.
  if (lastSnapshotTick <= conn.lastAckedTick || lastSnapshotTick > conn.baselineTick) return false;
  conn.lastAckedTick = lastSnapshotTick;
  conn.lastAckAtMs = nowMs;
  for (const entry of conn.sentLog) {
    if (entry.tick !== lastSnapshotTick) continue;
    const sample = nowMs - entry.sentAtMs;
    conn.rttMs = conn.rttMs === 0 ? sample : conn.rttMs + RTT_ALPHA * (sample - conn.rttMs);
    break;
  }
  return true;
}
