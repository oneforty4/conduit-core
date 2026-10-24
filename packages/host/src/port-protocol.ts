import type { SessionToken } from '@conduit/auth';
import type { PortLinkClose, PortLinkSend, TickStats } from '@conduit/net-server';
import type { LogLevel } from './logger.ts';

/** `workerData` of a session worker (docs/host.md 18). */
export interface WorkerData {
  maxPlayers?: number;
  sessionId: string;
  gameId: string;
  /** A URL (normally `file:`) the worker can `import()`; it exports `game` and `sessionFactory`. */
  gameModule: string;
  logLevel: LogLevel;
  /** `HostOptions.workerExtra`, opaque to core (test fixtures read their flags from it). */
  extra?: Record<string, unknown>;
}

export type BatchOp =
  | { op: 'put'; ns: string; key: string; value: ArrayBuffer }
  | { op: 'delete'; ns: string; key: string };

export type StoreOp =
  | { op: 'get'; ns: string; key: string }
  | { op: 'put'; ns: string; key: string; value: ArrayBuffer }
  | { op: 'delete'; ns: string; key: string }
  | { op: 'list'; ns: string; prefix: string }
  | { op: 'batch'; ops: BatchOp[] };

/** `get` → `ArrayBuffer | null`, `list` → `string[]`, `put`/`delete`/`batch` → `undefined`. */
export type StoreValue = ArrayBuffer | string[] | null | undefined;

/** A worker's store request; every `ArrayBuffer` value is transferred. */
export type StoreRequest = { t: 'store'; reqId: number } & StoreOp;

/** The main thread's answer to one `StoreRequest`; a `get` value is transferred. */
export type StoreResult =
  | { t: 'storeResult'; reqId: number; ok: true; value?: StoreValue }
  | { t: 'storeResult'; reqId: number; ok: false; error: { code: string; message: string } };

export type MainToWorker =
  /** `helloFrame` transferred; `tokenExpired`: the gateway's verdict on the token (docs/host.md 17). */
  | {
      t: 'attach';
      clientId: number;
      identity: SessionToken;
      tokenExpired: boolean;
      helloFrame: ArrayBuffer;
    }
  /** `buf` transferred. */
  | { t: 'frame'; clientId: number; buf: ArrayBuffer }
  | { t: 'closed'; clientId: number; code: number; reason: string }
  /** Every `STATS_INTERVAL_MS`: `[clientId, bufferedAmount]` of the worker's attached clients. */
  | { t: 'stats'; entries: [clientId: number, bufferedAmount: number][] }
  | { t: 'flush'; reqId: number }
  | { t: 'shutdown'; graceMs: number; code: number; reason: string }
  | StoreResult;

export type WorkerToMain =
  | { t: 'ready' }
  /** `buf` transferred (net-server's `PortLink`). */
  | PortLinkSend
  | PortLinkClose
  | { t: 'flushed'; reqId: number; ok: boolean; error?: string }
  /** Every `TICK_STATS_INTERVAL_MS`: `session.tickStats()` verbatim. */
  | { t: 'tickStats'; stats: TickStats }
  | StoreRequest
  | { t: 'log'; level: LogLevel; msg: string; data?: unknown }
  | { t: 'fatal'; error: { message: string; stack?: string } };

/**
 * A standalone `ArrayBuffer` with exactly `u8`'s bytes, for a transfer: `u8.buffer` itself when the
 * view covers all of a plain `ArrayBuffer` (the caller gives `u8` up), otherwise a copy (a view into
 * a larger or pooled buffer, such as a `Buffer` slice).
 */
export function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const backing = u8.buffer;
  if (
    backing instanceof ArrayBuffer &&
    u8.byteOffset === 0 &&
    u8.byteLength === backing.byteLength
  ) {
    return backing;
  }
  return new Uint8Array(u8).buffer;
}
