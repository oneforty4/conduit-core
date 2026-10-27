export { MAX_PLAYERS } from '@conduit/sim';

/** Sim Hz if the game does not say. */
export const DEFAULT_TICK_RATE = 60;
/** Snapshot every Nth tick. */
export const DEFAULT_SNAPSHOT_EVERY = 3;
/** `Hello` must arrive within this after `attach`. */
export const HANDSHAKE_TIMEOUT_MS = 5000;
/** away -> slot freed. */
export const RECONNECT_GRACE_MS = 120000;
/** Queued input frames per client. */
export const INPUT_QUEUE_MAX = 6;
/** Sent-snapshot ring per client. */
export const SENT_LOG_SIZE = 32;
/** Skip a client's snapshot while `bufferedAmount()` exceeds this. */
export const BACKPRESSURE_SKIP_BYTES = 65536;
/** Outstanding (unacked) snapshots above which the snapshot rate halves. */
export const BACKPRESSURE_HALVE_OUTSTANDING = 20;
/** No Ack for this long while snapshots are outstanding -> kick. */
export const ACK_TIMEOUT_MS = 10000;
/** Queued replicated events per client (oldest dropped). */
export const PENDING_EVENTS_MAX = 256;
/** Creates beyond this many payload bytes are deferred to the next snapshot. */
export const SNAPSHOT_SOFT_LIMIT_BYTES = 60000;
/** EWMA weight of the RTT estimate. */
export const RTT_ALPHA = 0.1;
/** Random bytes in a reconnect token (base64url -> 32 chars). */
export const RECONNECT_TOKEN_BYTES = 24;
/** Game messages dispatched per client per tick; excess dropped and counted. */
export const MAX_GAME_MESSAGES_PER_TICK = 64;
/** Default `SessionOptions.maxSimulationInterestRegions`: distinct regions one tick's interest may name. */
export const DEFAULT_MAX_SIMULATION_INTEREST_REGIONS = 64;
/** Largest accepted `SessionOptions.maxSimulationInterestRegions`. */
export const SIMULATION_INTEREST_REGIONS_LIMIT = 1024;
/** Messages a link queues before `onMessage` is registered; one more closes it with 4003. */
export const LINK_QUEUE_MAX = 64;
/** `WsLink.close` terminates a socket that has not closed after this long. */
export const WS_CLOSE_TIMEOUT_MS = 2000;

/** Close codes sent by the Session (docs/net.md A.3). 4100-4199 belong to the gateway and host. */
export const CloseCode = Object.freeze({
  /** Leave / `disconnect()`. */
  Normal: 1000,
  /** Server shutdown; `Kicked{ServerShutdown}` precedes it. */
  Shutdown: 1001,
  HandshakeTimeout: 4000,
  WireVersion: 4001,
  /** A frame failed to decode (`DecodeError`). */
  MalformedFrame: 4002,
  /** Text frame, Hello twice, message in the wrong state, pre-bind queue overflow. */
  ProtocolViolation: 4003,
  /** `Rejected{ProtocolVersion}`. */
  ProtocolVersion: 4004,
  /** `Rejected{SchemaMismatch}`. */
  SchemaMismatch: 4005,
  /** `Kicked{Replaced}`: a reconnect took over this player. */
  Replaced: 4006,
  /** `Kicked{AckTimeout}`. */
  AckTimeout: 4007,
  /** `Rejected{BadToken}`. */
  BadToken: 4008,
  /** `Rejected{SessionFull}`. */
  SessionFull: 4009,
  /** `Rejected{SessionNotRunning}`. */
  SessionNotRunning: 4010,
  /** `Kicked{Idle|ByHost|Protocol}`. */
  Kicked: 4011,
  /** Authoritative state fault. Terminal; reconnect requires explicit recovery. */
  SessionFault: 4012,
  Compatibility: 4013,
  Capacity: 4014,
} as const);
export type CloseCode = (typeof CloseCode)[keyof typeof CloseCode];
