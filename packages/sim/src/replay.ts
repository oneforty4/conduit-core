import { cloneExactState } from './checkpoint.ts';
import { ByteReader, ByteWriter, decodeWith, encodeWith } from '@conduit/protocol';
import type { InputFrame } from './context.ts';
import type { Simulation } from './simulation.ts';

/**
 * One player's Session lifecycle step (docs/net.md A.6), replayed before the inputs of its tick:
 * `join` (`onPlayerJoin` ran), `spawn` (the player was ready; `PlayerSpawn.spawn` runs once the
 * planned region is active) and `leave` (`onPlayerLeave`, the entity destroyed, the slot freed).
 */
export type LifecycleEvent =
  | { readonly type: 'join'; readonly accountId: string; readonly displayName: string }
  | { readonly type: 'spawn' }
  | { readonly type: 'leave' };

/** A frame placed for `playerId` from `tick` on; `null`: from then on the player has none. */
export type InputLogEntry = [tick: number, playerId: number, frame: InputFrame | null];
export type LifecycleEntry = [tick: number, playerId: number, event: LifecycleEvent];
/**
 * Ticks `tick` to `tick + count - 1` never ran: the Session's loop dropped them, their numbers
 * skipped (docs/sim.md 2.10), and a replay skips them too (`ReplayRun.skip`).
 */
export type SkipEntry = [tick: number, count: number];

/** A recorded run (docs/sim.md 2.11). Plain data: it round-trips through JSON. */
export interface InputLog {
  version: 1;
  seed: number;
  tickRate: number;
  /** Sorted by tick, then playerId. */
  entries: InputLogEntry[];
  /** Ascending tick; within a tick in the order they ran. Absent: no lifecycle. */
  lifecycle?: LifecycleEntry[];
  /**
   * Ascending, none overlapping another, and no tick of them named by an entry or a lifecycle step.
   * Absent: none.
   */
  skips?: SkipEntry[];
}

export type Checkpoint = [tick: number, hash: number];

export type ReplayResult =
  { ok: true } | { ok: false; tick: number; expected: number; actual: number };

/** A fresh game instance a log is fed into, one tick at a time. */
export interface ReplayRun {
  /** The frame placed for the next step and held after it; `null`: none. */
  setInput(player: number, frame: InputFrame | null): void;
  /** A lifecycle step for the next step. Required when a log has lifecycle entries. */
  lifecycle?(player: number, event: LifecycleEvent): void;
  /**
   * Moves the run on by `count` ticks without a step (`Simulation.skip`): those the recorded
   * session's loop dropped. Required when a log has skips.
   */
  skip?(count: number): void;
  /** Async so MemoryStore-backed region loads settle on the same tick boundary. */
  step(tick: number): Promise<void>;
  hash(): number;
}

export interface ReplayableGame {
  createRun(seed: number, tickRate: number): Promise<ReplayRun>;
}

/**
 * Records into `log.entries` what each `sim.step` consumes (docs/sim.md 2.11), through
 * `sim.onInputsPlaced`: an entry whenever a player's frame differs from the one last recorded for
 * that player, compared and stored in its encoded form (the input schema's quantization, which is
 * how a Session receives frames), and `[tick, player, null]` when a player's frame goes away. A held
 * frame adds nothing. Install before the first step. A hook already installed keeps being called.
 * Returns the uninstall function.
 */
export function recordInputs(sim: Simulation, log: InputLog): () => void {
  const schema = sim.ctx.world.registry.input;
  const writer = new ByteWriter(64);
  /** By player: the encoding of the frame last recorded; `null` or absent for none. */
  const last: (Uint8Array | null)[] = [];
  const previous = sim.onInputsPlaced;
  let recording = true;
  const hook = (tick: number, player: number, frame: InputFrame | undefined): void => {
    if (recording) {
      const before = last[player] ?? null;
      if (frame === undefined) {
        if (before !== null) {
          last[player] = null;
          insertEntry(log.entries, [tick, player, null]);
        }
      } else {
        writer.reset();
        encodeWith(writer, schema, frame);
        const bytes = writer.view();
        if (before === null || !equalBytes(before, bytes)) {
          const copy = bytes.slice();
          last[player] = copy;
          insertEntry(log.entries, [tick, player, decodeWith(new ByteReader(copy), schema)]);
        }
      }
    }
    previous?.(tick, player, frame);
  };
  sim.onInputsPlaced = hook;
  return () => {
    if (!recording) return;
    recording = false;
    if (sim.onInputsPlaced === hook) sim.onInputsPlaced = previous;
  };
}

/**
 * Runs `log` on a fresh run of `game` and takes a checkpoint every `every` ticks, through the first
 * multiple of `every` at or after the log's last tick that runs (so every entry is followed by a
 * checkpoint). A skipped tick runs no step and takes no checkpoint.
 */
export async function record(
  game: ReplayableGame,
  log: InputLog,
  every: number,
): Promise<Checkpoint[]> {
  if (!Number.isInteger(every) || every < 1) {
    throw new RangeError(`record: every must be an integer >= 1, got ${every}`);
  }
  checkLog(log, 'record');
  const run = await game.createRun(log.seed, log.tickRate);
  const feed = feeder(log, run, 'record');
  const skip = skipper(log, run, 'record');
  const last = lastTickOf(log);
  const checkpoints: Checkpoint[] = [];
  for (let tick = skip(1); last > 0; tick = skip(tick + 1)) {
    feed(tick);
    await run.step(tick);
    if (tick % every === 0) {
      checkpoints.push([tick, run.hash()]);
      if (tick >= last) break;
    }
  }
  return checkpoints;
}

/**
 * Runs `log` on a fresh run of `game` through its last tick or last checkpoint, whichever is later,
 * and compares `run.hash()` at every checkpoint; the first mismatch ends the replay.
 */
export async function replay(
  game: ReplayableGame,
  log: InputLog,
  checkpoints: readonly Checkpoint[],
): Promise<ReplayResult> {
  checkLog(log, 'replay');
  const expected = checkCheckpoints(checkpoints);
  const skipped = inSkips(log.skips ?? []);
  for (const [tick] of expected) {
    if (skipped(tick))
      throw new RangeError(`replay: a checkpoint names tick ${tick}, which the log skips`);
  }
  const run = await game.createRun(log.seed, log.tickRate);
  const feed = feeder(log, run, 'replay');
  const skip = skipper(log, run, 'replay');
  const lastCheckpoint =
    expected.length === 0 ? 0 : (expected[expected.length - 1] as Checkpoint)[0];
  const lastTick = Math.max(lastTickOf(log), lastCheckpoint);
  let next = 0;
  for (let tick = skip(1); tick <= lastTick; tick = skip(tick + 1)) {
    feed(tick);
    await run.step(tick);
    while (next < expected.length && (expected[next] as Checkpoint)[0] === tick) {
      const want = (expected[next] as Checkpoint)[1];
      next++;
      const actual = run.hash();
      if (actual !== want) return { ok: false, tick, expected: want, actual };
    }
  }
  return { ok: true };
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Negative when `a` sorts before `b`: by tick, then playerId. */
function compareEntries(a: InputLogEntry, b: InputLogEntry): number {
  return a[0] - b[0] || a[1] - b[1];
}

/** Inserts after every entry that does not sort after `entry`; normally an append. */
function insertEntry(entries: InputLogEntry[], entry: InputLogEntry): void {
  let i = entries.length;
  while (i > 0 && compareEntries(entries[i - 1] as InputLogEntry, entry) > 0) i--;
  if (i === entries.length) entries.push(entry);
  else entries.splice(i, 0, entry);
}

/** The latest tick an entry, a lifecycle step or a skip names; 0 for an empty log. */
function lastTickOf(log: InputLog): number {
  const entries = log.entries;
  const lifecycle = log.lifecycle ?? [];
  const skips = log.skips ?? [];
  const lastEntry = entries.length === 0 ? 0 : (entries[entries.length - 1] as InputLogEntry)[0];
  const lastStep =
    lifecycle.length === 0 ? 0 : (lifecycle[lifecycle.length - 1] as LifecycleEntry)[0];
  const lastSkip = skips.length === 0 ? null : (skips[skips.length - 1] as SkipEntry);
  return Math.max(lastEntry, lastStep, lastSkip === null ? 0 : lastSkip[0] + lastSkip[1] - 1);
}

/**
 * Has `run` skip the ticks `log.skips` names from `tick` on, as the walk through the log comes to
 * them (ticks asked in ascending order): the next tick that runs.
 */
function skipper(log: InputLog, run: ReplayRun, where: string): (tick: number) => number {
  const skips = log.skips ?? [];
  if (skips.length > 0 && typeof run.skip !== 'function') {
    throw new TypeError(`${where}: the log has skips but the run has no skip()`);
  }
  let k = 0;
  return (tick) => {
    let at = tick;
    for (; k < skips.length; k++) {
      const [from, count] = skips[k] as SkipEntry;
      if (from !== at) break;
      run.skip?.(count);
      at += count;
    }
    return at;
  };
}

/** Whether `skips` skip `tick`, for ticks asked in ascending order. */
function inSkips(skips: readonly SkipEntry[]): (tick: number) => boolean {
  let k = 0;
  return (tick) => {
    while (k < skips.length && (skips[k] as SkipEntry)[0] + (skips[k] as SkipEntry)[1] <= tick) k++;
    return k < skips.length && (skips[k] as SkipEntry)[0] <= tick;
  };
}

/** Feeds the lifecycle steps, then the frames, of each tick to `run`; ticks must ascend by one. */
function feeder(log: InputLog, run: ReplayRun, where: string): (tick: number) => void {
  const entries = log.entries;
  const lifecycle = log.lifecycle ?? [];
  if (lifecycle.length > 0 && typeof run.lifecycle !== 'function') {
    throw new TypeError(`${where}: the log has lifecycle entries but the run has no lifecycle()`);
  }
  let i = 0;
  let j = 0;
  return (tick) => {
    for (; j < lifecycle.length; j++) {
      const [at, player, event] = lifecycle[j] as LifecycleEntry;
      if (at !== tick) break;
      run.lifecycle?.(player, event);
    }
    for (; i < entries.length; i++) {
      const [at, player, frame] = entries[i] as InputLogEntry;
      if (at !== tick) break;
      run.setInput(player, frame);
    }
  };
}

/** `value` as a tuple of `length` elements, or `null`. */
function tupleOf(value: unknown, length: number): readonly unknown[] | null {
  return Array.isArray(value) && value.length === length ? (value as unknown[]) : null;
}

function isTick(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isPlayer(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isLifecycleEvent(value: unknown): value is LifecycleEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as { type?: unknown; accountId?: unknown; displayName?: unknown };
  if (event.type === 'spawn' || event.type === 'leave') return true;
  return (
    event.type === 'join' &&
    typeof event.accountId === 'string' &&
    typeof event.displayName === 'string'
  );
}

/** Throws `RangeError` for anything but a well-formed version 1 log. */
function checkLog(log: InputLog, where: string): void {
  const raw = log as unknown as Partial<Record<keyof InputLog, unknown>> | null;
  if (typeof raw !== 'object' || raw === null || raw.version !== 1) {
    throw new RangeError(`${where}: expected an InputLog of version 1`);
  }
  const { seed, tickRate, entries, lifecycle, skips } = raw;
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError(`${where}: log.seed must be a u32, got ${String(seed)}`);
  }
  if (typeof tickRate !== 'number' || !(Number.isFinite(tickRate) && tickRate > 0)) {
    throw new RangeError(
      `${where}: log.tickRate must be a positive number, got ${String(tickRate)}`,
    );
  }
  if (!Array.isArray(entries)) throw new RangeError(`${where}: log.entries must be an array`);
  let previousTick = 1;
  let previousPlayer = 0;
  for (let i = 0; i < (entries as readonly unknown[]).length; i++) {
    const entry = tupleOf((entries as readonly unknown[])[i], 3);
    const tick = entry?.[0];
    const player = entry?.[1];
    const frame = entry?.[2];
    if (!isTick(tick) || !isPlayer(player) || typeof frame !== 'object') {
      throw new RangeError(
        `${where}: log.entries[${i}] is not [tick >= 1, playerId, frame | null]`,
      );
    }
    if (tick < previousTick || (tick === previousTick && player < previousPlayer)) {
      throw new RangeError(`${where}: log.entries[${i}] is out of order (by tick, then playerId)`);
    }
    previousTick = tick;
    previousPlayer = player;
  }
  if (lifecycle !== undefined) {
    if (!Array.isArray(lifecycle)) throw new RangeError(`${where}: log.lifecycle must be an array`);
    previousTick = 1;
    for (let i = 0; i < (lifecycle as readonly unknown[]).length; i++) {
      const entry = tupleOf((lifecycle as readonly unknown[])[i], 3);
      const tick = entry?.[0];
      if (!isTick(tick) || !isPlayer(entry?.[1]) || !isLifecycleEvent(entry?.[2])) {
        throw new RangeError(`${where}: log.lifecycle[${i}] is not [tick >= 1, playerId, event]`);
      }
      if (tick < previousTick) {
        throw new RangeError(`${where}: log.lifecycle[${i}] is out of order (ascending tick)`);
      }
      previousTick = tick;
    }
  }
  if (skips === undefined) return;
  if (!Array.isArray(skips)) throw new RangeError(`${where}: log.skips must be an array`);
  let free = 1; // the first tick a skip may name
  for (let i = 0; i < (skips as readonly unknown[]).length; i++) {
    const entry = tupleOf((skips as readonly unknown[])[i], 2);
    const tick = entry?.[0];
    const count = entry?.[1];
    if (!isTick(tick) || !isTick(count)) {
      throw new RangeError(`${where}: log.skips[${i}] is not [tick >= 1, count >= 1]`);
    }
    if (tick < free) {
      throw new RangeError(`${where}: log.skips[${i}] is out of order or overlaps the one before`);
    }
    free = tick + count;
  }
  const checked = log as InputLog;
  const skipped = (list: readonly (readonly [number, ...unknown[]])[], name: string): void => {
    const isSkipped = inSkips(checked.skips ?? []);
    for (let i = 0; i < list.length; i++) {
      const tick = (list[i] as readonly [number, ...unknown[]])[0];
      if (isSkipped(tick)) {
        throw new RangeError(`${where}: log.${name}[${i}] names tick ${tick}, which the log skips`);
      }
    }
  };
  skipped(checked.entries, 'entries');
  skipped(checked.lifecycle ?? [], 'lifecycle');
}

/** The checkpoints sorted by tick (stable); `RangeError` for a tick below 1 or a non-number hash. */
function checkCheckpoints(checkpoints: readonly Checkpoint[]): Checkpoint[] {
  const raw: unknown = checkpoints;
  if (!Array.isArray(raw)) throw new RangeError('replay: checkpoints must be an array');
  for (let i = 0; i < (raw as readonly unknown[]).length; i++) {
    const checkpoint = tupleOf((raw as readonly unknown[])[i], 2);
    if (!isTick(checkpoint?.[0]) || typeof checkpoint?.[1] !== 'number') {
      throw new RangeError(`replay: checkpoints[${i}] is not [tick >= 1, hash]`);
    }
  }
  return checkpoints.slice().sort((a, b) => a[0] - b[0]);
}

/** Explicit compatibility reader: v1 never recorded commands, initial state, content revision or idle tail. */
export function readInputOnlyLog(value: unknown): {
  readonly kind: 'limited-input-only';
  readonly limitation: string;
  readonly log: InputLog;
} {
  checkLog(value as InputLog, 'readInputOnlyLog');
  return {
    kind: 'limited-input-only',
    limitation:
      'Version 1 contains inputs/lifecycle/skips only; no commands, initial checkpoint, compatibility revision or final idle tick.',
    log: cloneExactState(value as InputLog),
  };
}
