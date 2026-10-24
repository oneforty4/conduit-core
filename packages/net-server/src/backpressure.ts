import type { ClientConn } from './client-conn.ts';
import {
  ACK_TIMEOUT_MS,
  BACKPRESSURE_HALVE_OUTSTANDING,
  BACKPRESSURE_SKIP_BYTES,
  DEFAULT_SNAPSHOT_EVERY,
} from './constants.ts';

/** Skip rule (docs/net.md A.10): the link holds more than `BACKPRESSURE_SKIP_BYTES` unsent bytes. */
export function shouldSkip(conn: Pick<ClientConn, 'link'>): boolean {
  return conn.link !== null && conn.link.bufferedAmount() > BACKPRESSURE_SKIP_BYTES;
}

/**
 * Halve rule (A.10), evaluated on snapshot tick `tick`: more than `BACKPRESSURE_HALVE_OUTSTANDING`
 * unacked snapshots switches the client to every other snapshot tick (the phase is fixed on
 * entering); `outstanding <= BACKPRESSURE_HALVE_OUTSTANDING` restores the full rate.
 */
export function updateDivisor(
  conn: Pick<ClientConn, 'snapshotDivisor' | 'snapshotPhase' | 'outstandingSnapshots'>,
  tick: number,
  snapshotEvery: number = DEFAULT_SNAPSHOT_EVERY,
): void {
  const outstanding = conn.outstandingSnapshots();
  if (outstanding > BACKPRESSURE_HALVE_OUTSTANDING) {
    if (conn.snapshotDivisor === 1) {
      conn.snapshotDivisor = 2;
      conn.snapshotPhase = Math.floor(tick / snapshotEvery) % 2;
    }
  } else {
    conn.snapshotDivisor = 1;
  }
}

/** True when the halved rate skips snapshot tick `tick` for this client. */
export function halvedRateSkips(
  conn: Pick<ClientConn, 'snapshotDivisor' | 'snapshotPhase'>,
  tick: number,
  snapshotEvery: number = DEFAULT_SNAPSHOT_EVERY,
): boolean {
  return conn.snapshotDivisor === 2 && Math.floor(tick / snapshotEvery) % 2 !== conn.snapshotPhase;
}

/** Ack-timeout rule (A.10): snapshots are outstanding and no Ack arrived for `timeoutMs`. */
export function ackTimedOut(
  conn: Pick<ClientConn, 'lastAckAtMs' | 'outstandingSnapshots'>,
  nowMs: number,
  timeoutMs: number = ACK_TIMEOUT_MS,
): boolean {
  return conn.outstandingSnapshots() > 0 && nowMs - conn.lastAckAtMs > timeoutMs;
}
