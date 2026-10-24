import {
  compatibilityDifferences,
  copyCompatibilityDescriptor,
  type CompatibilityDescriptor,
  PROTOCOL_SESSION_CAPACITY_MAX,
} from '@conduit/protocol';
import {
  cloneExactState,
  encodeExactState,
  decodeExactState,
  firstStateDifference,
  fullStateDigest,
  type StateDifference,
} from './checkpoint.ts';
import type { InputFrame } from './context.ts';
import type { LifecycleEvent } from './replay.ts';

export interface CommandActor {
  readonly playerId: number;
  readonly actorId: string;
  readonly displayName: string;
}
export interface RecordedConnectionState {
  readonly actor: CommandActor;
  readonly state: string;
  readonly entity: number;
  readonly joinQueued: boolean;
  readonly joinRan: boolean;
  readonly readyPending: boolean;
  readonly spawnQueued: boolean;
  readonly leaveQueued: boolean;
  readonly inputQueue: readonly { readonly frame: InputFrame; readonly seq: number }[];
}
export interface RecordedExternalCommand {
  readonly tick: number;
  readonly sequence: number;
  readonly name: string;
  readonly payload: unknown;
  readonly actor: CommandActor | null;
}
export type JournalAction =
  | { readonly kind: 'connections'; readonly players: readonly RecordedConnectionState[] }
  | {
      readonly kind: 'scheduled-external';
      readonly commands: readonly RecordedExternalCommand[];
      readonly nextSequence: number;
    }
  | { readonly kind: 'lifecycle'; readonly playerId: number; readonly event: LifecycleEvent }
  | { readonly kind: 'input'; readonly playerId: number; readonly frame: InputFrame | undefined }
  | {
      readonly kind: 'message';
      readonly actor: CommandActor;
      readonly name: string;
      readonly payload: unknown;
    }
  | {
      readonly kind: 'external';
      readonly actor: CommandActor | null;
      readonly name: string;
      readonly payload: unknown;
    }
  | { readonly kind: 'region'; readonly decision: unknown };
export function validateJournalAction(
  action: JournalAction,
  tick: number,
  capacity = PROTOCOL_SESSION_CAPACITY_MAX,
): void {
  const player = (value: number): boolean =>
    Number.isInteger(value) && value >= 0 && value < capacity;
  const actor = (value: CommandActor): boolean =>
    value !== null &&
    typeof value === 'object' &&
    player(value.playerId) &&
    typeof value.actorId === 'string' &&
    value.actorId.length <= 256 &&
    typeof value.displayName === 'string' &&
    value.displayName.length <= 128;
  const frame = (value: InputFrame | undefined): boolean =>
    value === undefined ||
    (value !== null &&
      typeof value === 'object' &&
      Number.isInteger(value.tick) &&
      value.tick >= 0 &&
      value.tick <= 0xffffffff);
  const name = (value: string): boolean =>
    typeof value === 'string' && value.length > 0 && value.length <= 128;
  let valid = false;
  switch (action.kind) {
    case 'connections':
      valid =
        Array.isArray(action.players) &&
        action.players.length <= capacity &&
        new Set(action.players.map((entry) => entry.actor.playerId)).size ===
          action.players.length &&
        action.players.every(
          (entry) =>
            actor(entry.actor) &&
            ['joined', 'loading', 'ready', 'playing', 'away', 'closed'].includes(entry.state) &&
            Number.isInteger(entry.entity) &&
            entry.entity >= 0 &&
            entry.entity <= 0xffffffff &&
            [
              entry.joinQueued,
              entry.joinRan,
              entry.readyPending,
              entry.spawnQueued,
              entry.leaveQueued,
            ].every((value) => typeof value === 'boolean') &&
            Array.isArray(entry.inputQueue) &&
            entry.inputQueue.length <= 513 &&
            entry.inputQueue.every(
              (input: { frame: InputFrame; seq: number }) =>
                frame(input.frame) &&
                Number.isInteger(input.seq) &&
                input.seq >= 0 &&
                input.seq <= 0xffff,
            ),
        );
      break;
    case 'scheduled-external':
      valid =
        Array.isArray(action.commands) &&
        action.commands.length <= 256 &&
        Number.isSafeInteger(action.nextSequence) &&
        action.nextSequence >= 0 &&
        new Set(action.commands.map((entry) => entry.sequence)).size === action.commands.length &&
        action.commands.every(
          (entry) =>
            name(entry.name) &&
            Number.isSafeInteger(entry.tick) &&
            entry.tick >= tick &&
            entry.tick < tick + 1024 &&
            Number.isSafeInteger(entry.sequence) &&
            entry.sequence >= 0 &&
            entry.sequence < action.nextSequence &&
            (entry.actor === null || actor(entry.actor)),
        );
      break;
    case 'lifecycle':
      valid =
        player(action.playerId) &&
        action.event !== null &&
        typeof action.event === 'object' &&
        ['join', 'spawn', 'leave'].includes(action.event.type) &&
        (action.event.type !== 'join' ||
          (typeof action.event.accountId === 'string' &&
            action.event.accountId.length <= 256 &&
            typeof action.event.displayName === 'string' &&
            action.event.displayName.length <= 128));
      break;
    case 'input':
      valid = player(action.playerId) && frame(action.frame);
      break;
    case 'message':
      valid = actor(action.actor) && name(action.name);
      break;
    case 'external':
      valid = (action.actor === null || actor(action.actor)) && name(action.name);
      break;
    case 'region':
      valid =
        action.decision !== null &&
        typeof action.decision === 'object' &&
        Number.isSafeInteger(Reflect.get(action.decision, 'observedTick')) &&
        Reflect.get(action.decision, 'observedTick') === tick;
      break;
  }
  if (!valid) throw new TypeError(`Invalid ${String(action.kind)} journal action at tick ${tick}`);
}
export interface JournalRecord {
  readonly order: number;
  readonly action: JournalAction;
}
export interface JournalTick {
  readonly tick: number;
  readonly records: readonly JournalRecord[];
  readonly digest?: string;
  readonly state?: unknown;
}
export interface JournalFailure {
  readonly tick: number;
  readonly system: string;
  readonly phase: string;
  readonly message: string;
}
export interface CheckpointReference {
  readonly id: string;
  readonly tick: number;
  readonly digest: string;
}
/** V2 records committed simulation decisions. V1 InputLog remains explicitly input-only/limited. */
export interface CommandJournal {
  readonly version: 2;
  readonly compatibility: CompatibilityDescriptor;
  readonly stateSchemaHash: number;
  readonly capacity: number;
  readonly tickRate: number;
  readonly seed: number;
  readonly sessionEpoch: string;
  readonly initialCheckpoint: CheckpointReference | null;
  /** Explicitly preserves idle tails after the last changed input/command. */
  finalTick: number;
  readonly ticks: JournalTick[];
  readonly skips: Array<{ readonly first: number; readonly count: number }>;
  readonly failures: JournalFailure[];
  readonly maxRecords: number;
  readonly maxBytes: number;
  readonly maxTicks: number;
  /** Conservative serialized-byte accounting, maintained by recording/diagnostic helpers. */
  encodedBytes: number;
}
export function createCommandJournal(options: {
  compatibility: CompatibilityDescriptor;
  stateSchemaHash: number;
  capacity: number;
  tickRate: number;
  seed: number;
  sessionEpoch: string;
  initialCheckpoint?: CheckpointReference | null;
  maxRecords?: number;
  maxBytes?: number;
  maxTicks?: number;
}): CommandJournal {
  const maxRecords = options.maxRecords ?? 1_000_000;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const maxTicks = options.maxTicks ?? 1_000_000;
  if (
    !Number.isInteger(options.capacity) ||
    options.capacity < 1 ||
    options.capacity > PROTOCOL_SESSION_CAPACITY_MAX ||
    !Number.isInteger(options.stateSchemaHash) ||
    options.stateSchemaHash < 0 ||
    options.stateSchemaHash > 0xffffffff ||
    !Number.isInteger(options.tickRate) ||
    options.tickRate < 1 ||
    options.tickRate > 255 ||
    !Number.isInteger(options.seed) ||
    options.seed < 0 ||
    options.seed > 0xffffffff ||
    typeof options.sessionEpoch !== 'string' ||
    options.sessionEpoch.length === 0 ||
    options.sessionEpoch.length > 128 ||
    !Number.isSafeInteger(maxRecords) ||
    maxRecords < 1 ||
    maxRecords > 1_000_000 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 8192 ||
    maxBytes > 64 * 1024 * 1024 ||
    !Number.isSafeInteger(maxTicks) ||
    maxTicks < 1 ||
    maxTicks > 1_000_000
  )
    throw new TypeError('Invalid command journal header');
  const initialCheckpoint = cloneExactState(options.initialCheckpoint ?? null);
  if (
    initialCheckpoint !== null &&
    (typeof initialCheckpoint.id !== 'string' ||
      initialCheckpoint.id.length === 0 ||
      initialCheckpoint.id.length > 256 ||
      !Number.isSafeInteger(initialCheckpoint.tick) ||
      initialCheckpoint.tick < 0 ||
      !/^[0-9a-f]{64}$/.test(initialCheckpoint.digest))
  )
    throw new TypeError('Invalid journal initial checkpoint reference');
  const journal: CommandJournal = {
    version: 2,
    compatibility: copyCompatibilityDescriptor(options.compatibility),
    stateSchemaHash: options.stateSchemaHash,
    capacity: options.capacity,
    tickRate: options.tickRate,
    seed: options.seed,
    sessionEpoch: options.sessionEpoch,
    initialCheckpoint,
    finalTick: initialCheckpoint?.tick ?? 0,
    ticks: [],
    skips: [],
    failures: [],
    maxRecords,
    maxBytes,
    maxTicks,
    encodedBytes: 0,
  };
  journal.encodedBytes = encodeExactState(journal).byteLength;
  if (journal.encodedBytes + 4096 > maxBytes)
    throw new RangeError('Command journal byte budget cannot hold its header and failure reserve');
  return journal;
}
export function validateCommandJournal(
  log: CommandJournal,
  compatibility?: CompatibilityDescriptor,
): void {
  if (log === null || typeof log !== 'object' || log.version !== 2)
    throw new TypeError(
      `Unsupported command journal version ${String(log?.version)}; version 1 is input-only`,
    );
  if (
    !Array.isArray(log.ticks) ||
    !Array.isArray(log.skips) ||
    !Array.isArray(log.failures) ||
    log.skips.length > 1_000_000 ||
    log.failures.length > 64
  )
    throw new TypeError('Invalid command journal collections');
  if (
    !Number.isSafeInteger(log.maxBytes) ||
    !Number.isSafeInteger(log.maxTicks) ||
    !Number.isSafeInteger(log.maxRecords)
  )
    throw new TypeError('Journal resource budgets required');
  createCommandJournal({
    compatibility: log.compatibility,
    stateSchemaHash: log.stateSchemaHash,
    capacity: log.capacity,
    tickRate: log.tickRate,
    seed: log.seed,
    sessionEpoch: log.sessionEpoch,
    initialCheckpoint: log.initialCheckpoint,
    maxRecords: log.maxRecords,
    maxBytes: log.maxBytes,
    maxTicks: log.maxTicks,
  });
  if (compatibility !== undefined) {
    const differences = compatibilityDifferences(compatibility, log.compatibility);
    if (differences.length > 0)
      throw new TypeError(`Replay compatibility mismatch: ${differences.join(', ')}`);
  }
  const first = log.initialCheckpoint?.tick ?? 0;
  if (!Number.isSafeInteger(log.finalTick) || log.finalTick < first)
    throw new TypeError('Invalid command journal finalTick');
  let previous = first;
  let total = 0;
  let totalBytes = 0;
  if (log.ticks.length > log.maxTicks) throw new RangeError('Command journal tick budget exceeded');
  for (const tick of log.ticks) {
    if (!Number.isSafeInteger(tick.tick) || tick.tick <= previous || tick.tick > log.finalTick)
      throw new TypeError('Command journal ticks must be strictly ordered completed ticks');
    previous = tick.tick;
    for (let i = 0; i < tick.records.length; i++) {
      const record = tick.records[i]!;
      if (
        record.order !== i ||
        ![
          'connections',
          'scheduled-external',
          'lifecycle',
          'input',
          'message',
          'external',
          'region',
        ].includes(record.action.kind)
      )
        throw new TypeError('Invalid command journal pipeline ordering');
      validateJournalAction(record.action, tick.tick, log.capacity);
      cloneExactState(record.action);
    }
    total += Math.max(1, tick.records.length);
    totalBytes += encodeExactState(tick).byteLength;
    if (tick.digest !== undefined && !/^[0-9a-f]{64}$/.test(tick.digest))
      throw new TypeError('Invalid journal tick digest');
  }
  if (totalBytes > log.maxBytes) throw new RangeError('Command journal byte budget exceeded');
  if (total + log.skips.length > log.maxRecords)
    throw new RangeError('Command journal record budget exceeded');
  let end = first;
  let skipped = 0;
  let tickIndex = 0;
  for (const skip of log.skips) {
    if (
      !Number.isSafeInteger(skip.first) ||
      !Number.isSafeInteger(skip.count) ||
      skip.count < 1 ||
      skip.first <= end ||
      skip.count - 1 > Number.MAX_SAFE_INTEGER - skip.first ||
      skip.first > log.finalTick ||
      skip.count - 1 > log.finalTick - skip.first
    )
      throw new TypeError('Invalid command journal skip interval');
    end = skip.first + (skip.count - 1);
    while (tickIndex < log.ticks.length && log.ticks[tickIndex]!.tick < skip.first) tickIndex++;
    if (tickIndex < log.ticks.length && log.ticks[tickIndex]!.tick <= end)
      throw new TypeError('Journal tick overlaps skip');
    skipped += skip.count;
  }
  if (log.finalTick - first - skipped > log.maxTicks)
    throw new RangeError('Command journal replay work/span budget exceeded');
  for (const failure of log.failures) {
    if (
      !Number.isSafeInteger(failure.tick) ||
      failure.tick < first ||
      typeof failure.system !== 'string' ||
      failure.system.length > 256 ||
      typeof failure.phase !== 'string' ||
      failure.phase.length > 64 ||
      typeof failure.message !== 'string' ||
      failure.message.length > 2048
    )
      throw new TypeError('Invalid command journal failure diagnostic');
  }
  if (encodeExactState(log).byteLength > log.maxBytes)
    throw new RangeError('Command journal total byte budget exceeded');
}

export interface JournalReplayRun {
  readonly compatibility: CompatibilityDescriptor;
  readonly tick: number;
  readonly capacity: number;
  readonly stateSchemaHash: number;
  /** Queues decisions into their recorded pipeline positions; never performs original services. */
  apply(action: JournalAction): void;
  step(tick: number): Promise<void>;
  skip(count: number): void;
  capture(): unknown;
  restore(checkpoint: unknown): void | Promise<void>;
  dispose(): void | Promise<void>;
}
export interface JournalReplayFactory {
  createRun(header: CommandJournal): Promise<JournalReplayRun>;
  loadCheckpoint?(reference: CheckpointReference): Promise<unknown>;
}
export type JournalReplayResult =
  | { readonly ok: true; readonly finalTick: number }
  | {
      readonly ok: false;
      readonly tick: number;
      readonly reason: 'divergence' | 'fault';
      readonly message: string;
      readonly difference?: StateDifference;
    };
/** Seek uses a verified exact checkpoint, then replays through the explicit final tick. */
export async function replayCommandJournal(
  factory: JournalReplayFactory,
  log: CommandJournal,
  options: {
    untilTick?: number;
    checkpoint?: { readonly tick: number; readonly state: unknown; readonly digest: string };
  } = {},
): Promise<JournalReplayResult> {
  validateCommandJournal(log);
  const until = options.untilTick ?? log.finalTick;
  if (
    !Number.isSafeInteger(until) ||
    until < (log.initialCheckpoint?.tick ?? 0) ||
    until > log.finalTick
  )
    throw new RangeError('Replay target tick outside journal');
  const run = await factory.createRun(log);
  let tick = log.initialCheckpoint?.tick ?? 0;
  try {
    validateCommandJournal(log, run.compatibility);
    if (log.capacity !== run.capacity) throw new TypeError('Replay session capacity mismatch');
    if (log.stateSchemaHash !== run.stateSchemaHash)
      throw new TypeError('Replay state schema hash mismatch');
    const checkpoint = options.checkpoint;
    if (checkpoint !== undefined) {
      if (
        !Number.isSafeInteger(checkpoint.tick) ||
        checkpoint.tick < tick ||
        checkpoint.tick > until ||
        (await fullStateDigest(checkpoint.state)) !== checkpoint.digest
      )
        throw new TypeError('Invalid replay seek checkpoint');
      await run.restore(cloneExactState(checkpoint.state));
      if (run.tick !== checkpoint.tick)
        throw new TypeError('Restored checkpoint tick differs from seek reference');
      tick = checkpoint.tick;
    } else if (log.initialCheckpoint !== null) {
      if (factory.loadCheckpoint === undefined)
        throw new TypeError('Replay requires initial checkpoint resolver');
      const state = await factory.loadCheckpoint(log.initialCheckpoint);
      if ((await fullStateDigest(state)) !== log.initialCheckpoint.digest)
        throw new TypeError('Replay initial checkpoint digest mismatch');
      await run.restore(cloneExactState(state));
      if (run.tick !== log.initialCheckpoint.tick)
        throw new TypeError('Restored checkpoint tick differs from initial reference');
    } else if (run.tick !== 0)
      throw new TypeError('Replay without initial checkpoint must begin at tick zero');
    const ticks = new Map(log.ticks.map((entry) => [entry.tick, entry]));
    let skipIndex = 0;
    while (tick < until) {
      const next = tick + 1;
      while (
        skipIndex < log.skips.length &&
        log.skips[skipIndex]!.first + (log.skips[skipIndex]!.count - 1) < next
      )
        skipIndex++;
      const candidate = log.skips[skipIndex];
      const skip = candidate !== undefined && candidate.first <= next ? candidate : undefined;
      if (skip !== undefined) {
        const count = Math.min(skip.count - (next - skip.first), until - tick);
        run.skip(count);
        tick += count;
        continue;
      }
      const entry = ticks.get(next);
      for (const record of entry?.records ?? []) run.apply(cloneExactState(record.action));
      await run.step(next);
      tick = next;
      if (entry?.digest !== undefined) {
        const state = run.capture();
        if ((await fullStateDigest(state)) !== entry.digest) {
          const difference =
            entry.state === undefined
              ? undefined
              : (firstStateDifference(entry.state, state) ?? undefined);
          return {
            ok: false,
            tick,
            reason: 'divergence',
            message: `Full-state divergence at completed tick ${tick}`,
            ...(difference === undefined ? {} : { difference }),
          };
        }
      }
    }
    return { ok: true, finalTick: tick };
  } catch (error) {
    return {
      ok: false,
      tick: tick + 1,
      reason: 'fault',
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await run.dispose();
  }
}

/** Journal serialization uses exact tags; raw JSON cannot retain undefined/signed zero game state. */
export function encodeCommandJournal(journal: CommandJournal): Uint8Array {
  validateCommandJournal(journal);
  return encodeExactState(journal);
}
export function decodeCommandJournal(bytes: Uint8Array): CommandJournal {
  const value = decodeExactState(bytes) as CommandJournal;
  validateCommandJournal(value);
  return value;
}

/** Optional detailed diagnostics are explicit and remain inside recording byte limits. */
export async function attachJournalDiagnostic(
  journal: CommandJournal,
  tick: number,
  state: unknown,
): Promise<void> {
  const index = journal.ticks.findIndex((entry) => entry.tick === tick);
  if (index < 0) throw new TypeError('Diagnostic requires a committed journal tick');
  const previous = journal.ticks[index]!;
  const detached = cloneExactState(state);
  journal.ticks[index] = { ...previous, state: detached, digest: await fullStateDigest(detached) };
  const priorBytes = journal.encodedBytes;
  journal.encodedBytes = encodeExactState(journal).byteLength;
  try {
    if (journal.failures.length === 0 && journal.encodedBytes + 4096 > journal.maxBytes)
      throw new RangeError('Diagnostic exceeds journal failure reserve');
    validateCommandJournal(journal);
  } catch (error) {
    journal.ticks[index] = previous;
    journal.encodedBytes = priorBytes;
    throw error;
  }
}
