export { INPUT_FRAMES_PER_MESSAGE } from '@conduit/protocol';

/** Ping cadence while connected (docs/net.md B.1); the first Ping is sent on Welcome. */
export const PING_INTERVAL_MS = 1000;
/**
 * Pings sent `QUICK_PING_MS` apart after the Welcome's, before the cadence settles to
 * `PING_INTERVAL_MS`: a first Pong the page handles late (it is building its renderer) measures an
 * RTT hundreds of ms too long, and the next lower one replaces it at once (B.4).
 */
export const QUICK_PINGS = 5;
export const QUICK_PING_MS = 100;
/** Clock samples the offset is the best of (docs/net.md B.4). */
export const CLOCK_WINDOW = 16;
/** EWMA weight of an RTT sample above the estimate (a lower sample replaces it). */
export const RTT_ALPHA = 0.1;
/** EWMA weight of snapshot inter-arrival deviations. */
export const JITTER_ALPHA = 0.1;
export const JITTER_MIN_MS = 0;
export const JITTER_MAX_MS = 50;
/** The render clock runs at `1 - SLEW_RATE .. 1 + SLEW_RATE` while it converges. */
export const SLEW_RATE = 0.02;
/**
 * EWMA weight of the frame interval the render clock advances by. Frame timestamps carry a
 * millisecond or two of noise even on a display running at a dead-steady rate (successive intervals
 * come out strongly anti-correlated), and advancing by the raw interval turns that into several
 * percent of velocity noise every frame, which reads as shimmer on everything that moves.
 */
export const FRAME_ALPHA = 0.08;
/**
 * A frame interval this many ms from the smoothed one is real, not noise -- a dropped frame, a
 * display at another rate, a stall -- and replaces it outright, so the clock follows a genuine
 * change of cadence immediately instead of easing into it.
 */
export const FRAME_RESET_MS = 8;
/** Render-clock errors this small are not corrected. */
export const SLEW_DEADBAND_MS = 1;
/** Render-clock errors larger than this snap instead of slewing. */
export const SNAP_THRESHOLD_MS = 250;
/** Input frames kept by `InputRing`. */
export const INPUT_RING = 8;
/** Samples per interpolated component in a `SampleRing`. */
export const SAMPLE_RING = 8;
/** Replicated events buffered for render-time dispatch (M2, docs/net.md B.7). */
export const EVENT_BUFFER_MAX = 1024;
/** Reconnect backoff, then give up (M4, docs/net.md B.3). */
export const RECONNECT_DELAYS_MS: readonly number[] = Object.freeze([500, 1000, 2000, 4000, 8000]);
/** Socket open plus Welcome must complete within this. */
export const CONNECT_TIMEOUT_MS = 10000;
/** Regions dropped from a RegionSet are released after this grace (M3, docs/net.md B.8). */
export const REGION_RELEASE_GRACE_MS = 5000;
/** `GC_LAG_TICKS = GC_LAG_SNAPSHOTS × snapshotEvery` (docs/net.md B.1). */
export const GC_LAG_SNAPSHOTS = 2;
/** Bad frames in a row after which the client disconnects (docs/net.md B.3). */
export const MAX_BAD_FRAMES = 3;
/** Input frames the reconciliation stub keeps unacknowledged (M6, docs/net.md B.10). */
export const PREDICTION_RING = 128;

/**
 * `GC_LAG_TICKS` for a session: how far behind the render tick a destroyed entity must be before
 * `ReplicaWorld.gc` may drop it. `NetClient.update` is its only user.
 */
export function gcLagTicks(snapshotEvery: number): number {
  return GC_LAG_SNAPSHOTS * snapshotEvery;
}

/**
 * Whether a client should reconnect after the socket closed with `code` (docs/net.md A.3 last
 * column, both ranges). Codes outside the table: transport-level failures that a new socket can
 * cure (1005 no status, 1006 abnormal closure, 1011-1014 server error / restart / try later / bad
 * gateway) reconnect; every other code does not, so an unknown code can never cause a loop.
 */
export function isReconnectableClose(code: number): boolean {
  switch (code) {
    case 1001: // server shutdown (Kicked{ServerShutdown} precedes)
    case 1005:
    case 1006:
    case 1011:
    case 1012:
    case 1013:
    case 1014:
    case 4000: // handshake timeout
    case 4002: // malformed frame
    case 4007: // Kicked{AckTimeout}
    case 4110: // gateway: worker crashed (docs/host.md §17)
    case 4111: // gateway: host shutting down
      return true;
    default:
      return false;
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/** Logging callback shared by `NetClient`, `ReplicaWorld` and `RegionClient`. */
export type LogFn = (level: LogLevel, msg: string, data?: object) => void;

/** Default `LogFn`: warnings and errors to the console, debug and info dropped. */
export const consoleLog: LogFn = (level, msg, data) => {
  if (level === 'error') console.error(`[conduit/net-client] ${msg}`, data ?? '');
  else if (level === 'warn') console.warn(`[conduit/net-client] ${msg}`, data ?? '');
};
