import type { InputPayload } from '@conduit/protocol';
import type { ClientConn } from './client-conn.ts';
import { INPUT_QUEUE_MAX } from './constants.ts';
import type { SessionStats } from './stats.ts';

type InputConn = Pick<
  ClientConn,
  'inputQueue' | 'lastInputSeq' | 'lastInputTick' | 'held' | 'appliedTick' | 'appliedSeq'
>;

export interface InputQueueBounds {
  serverTick: number;
  maxFutureTicks?: number;
  maxStaleTicks?: number;
  capacity?: number;
}

/**
 * `Input` arrival while playing (docs/net.md A.7). Frames already accepted (the 4-frame redundancy)
 * or older are skipped; new ones are queued in ascending tick order, dropping the oldest beyond
 * `INPUT_QUEUE_MAX`. The queue takes ownership of the frame objects: pass a freshly decoded payload.
 * Returns `false` (and counts `badInput`) for an empty message, a `firstTick` that is not the first
 * frame's tick, or ticks that are not strictly ascending.
 */
export function acceptInput(
  conn: InputConn,
  msg: InputPayload,
  seq: number,
  stats: Pick<SessionStats, 'badInput' | 'inputOverflow'>,
  bounds?: InputQueueBounds,
): boolean {
  const future = bounds?.maxFutureTicks ?? 32;
  const stale = bounds?.maxStaleTicks ?? 2;
  const capacity =
    bounds?.capacity ?? (bounds === undefined ? INPUT_QUEUE_MAX : future + stale + 1);
  if (
    !Number.isInteger(future) ||
    future < 0 ||
    future > 256 ||
    !Number.isInteger(stale) ||
    stale < 0 ||
    stale > 256 ||
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity > 513
  ) {
    throw new RangeError('Invalid input queue bounds');
  }
  const frames = msg.frames;
  const first = frames[0];
  if (first === undefined || first.tick !== msg.firstTick) {
    stats.badInput++;
    return false;
  }
  if (frames.some((frame) => !Number.isSafeInteger(frame.tick) || frame.tick < 0)) {
    stats.badInput++;
    return false;
  }
  for (let i = 1; i < frames.length; i++) {
    if ((frames[i] as (typeof frames)[number]).tick <= (frames[i - 1] as typeof first).tick) {
      stats.badInput++;
      return false;
    }
  }
  const queue = conn.inputQueue;
  for (const frame of frames) {
    if (frame.tick <= conn.lastInputTick) continue;
    if (
      bounds !== undefined &&
      (frame.tick > bounds.serverTick + future || frame.tick < bounds.serverTick - stale)
    ) {
      stats.badInput++;
      continue;
    }
    queue.push({ frame, seq });
    conn.lastInputTick = frame.tick;
    if (queue.length > capacity) {
      queue.shift();
      stats.inputOverflow++;
    }
  }
  conn.lastInputSeq = seq;
  return true;
}

/**
 * Pipeline step 3 for sim tick `tick`: drops frames whose tick has passed, then applies the frame for
 * `tick` if it is at the front (setting `held`, `appliedTick`, `appliedSeq`). Otherwise the previous
 * `held` frame stays and `missingInputs` is counted. Returns whether a frame for `tick` was applied.
 */
export function drainInput(
  conn: InputConn,
  tick: number,
  stats: Pick<SessionStats, 'staleInputs' | 'missingInputs'>,
): boolean {
  const queue = conn.inputQueue;
  while (queue.length > 0 && (queue[0] as (typeof queue)[number]).frame.tick < tick) {
    queue.shift();
    stats.staleInputs++;
  }
  const head = queue[0];
  if (head !== undefined && head.frame.tick === tick) {
    queue.shift();
    conn.held = head.frame;
    conn.appliedTick = tick;
    conn.appliedSeq = head.seq;
    return true;
  }
  stats.missingInputs++;
  return false;
}
