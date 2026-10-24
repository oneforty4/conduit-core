import {
  ENTITY_NONE,
  type InputFrameBase,
  type InputPayload,
  type Schema,
  type SnapshotHeader,
} from '@conduit/protocol';
import type { EntityId } from '@conduit/sim';
import { consoleLog, PREDICTION_RING } from './constants.ts';
import type { ReplicaEntity, ReplicaWorld } from './replica-world.ts';

/**
 * `NetClientOptions.prediction` (M6, docs/net.md B.10). Absent, or `enabled: false` (the default),
 * builds nothing; `enabled: true` runs the reconciliation stub.
 */
export interface PredictionOptions {
  enabled: boolean;
  /** The plug-in point for client-side prediction; ignored unless `enabled`. */
  predictor?: Predictor | undefined;
}

/** An input frame the client sent that no snapshot has reached yet. */
export interface PendingInput {
  /** The server tick the frame targets. */
  readonly tick: number;
  /** Envelope seq of the Input message that first carried the frame (the one it was newest in). */
  readonly seq: number;
  /** The stub's copy, in a slot reused once the frame is pruned, evicted or reset. */
  readonly frame: Readonly<InputFrameBase>;
}

/** Pending frames, oldest first, ticks strictly ascending. */
export interface PendingInputs {
  readonly length: number;
  /** Frame `i`, 0 = oldest; `RangeError` outside `0..length - 1`. */
  at(i: number): PendingInput;
}

/** What `Predictor.reconcile` sees: one object per `Reconciler`, updated before each call. */
export interface ReconcileView {
  /** Of the snapshot just applied: `replica` holds the server's state at the end of this tick. */
  readonly serverTick: number;
  /** The highest `lastInputTick` on this connection (the last frame the server applied), or 0. */
  readonly ackedTick: number;
  /** The `lastInputSeq` that came with `ackedTick`. */
  readonly ackedSeq: number;
  /** `NetClient.entity`: `ENTITY_NONE` before the own Spawned. */
  readonly entity: EntityId;
  /** `replica.get(entity)` while alive there: `latest` has the server's values at `serverTick`. */
  readonly authoritative: ReplicaEntity | undefined;
  readonly replica: ReplicaWorld;
  /** The frames above `serverTick`, oldest first: what a predictor replays. */
  readonly pending: PendingInputs;
}

/**
 * Client-side prediction of the local entity, plugged into the stub (docs/net.md B.10). Every hook
 * is optional and runs inside the client tick or the snapshot handler; what it receives is
 * read-only and valid only during the call. A hook that throws is reported and otherwise ignored.
 */
export interface Predictor {
  /** A frame the stub recorded, right after its Input message went out. */
  inputSent?(input: PendingInput): void;
  /** After each applied snapshot, once the frames it reached were pruned. */
  reconcile?(view: ReconcileView): void;
  /** The stub reset: `connect()`, the Welcome of a reconnect, or Disconnected. */
  reset?(): void;
}

export type PredictorHook = 'inputSent' | 'reconcile' | 'reset';

/** `NetClient.stats().prediction` while the stub is enabled (docs/net.md B.10). */
export interface PredictionStats {
  /** Recorded frames above the newest snapshot's `serverTick`; at most the ring's capacity. */
  pendingFrames: number;
  /** The highest `lastInputTick` on this connection; 0 before the first acknowledgement. */
  lastAckedTick: number;
  /** The `lastInputSeq` that came with `lastAckedTick`. */
  lastAckedSeq: number;
  /** `serverTick` of the newest snapshot holding the local entity alive (this connection), or 0. */
  authoritativeTick: number;
  /** Since construction: frames pruned because a snapshot's `serverTick` reached them. */
  ackedFrames: number;
  /**
   * Since construction: pruned frames above that snapshot's `lastInputTick`, which the server
   * passed over. A lower bound: the header names only the last frame the server applied.
   */
  missedFrames: number;
  /** Since construction: frames evicted from a full ring before any snapshot reached them. */
  droppedFrames: number;
}

export interface ReconcilerOptions {
  /** Frames kept unacknowledged; default `PREDICTION_RING`. */
  capacity?: number | undefined;
  predictor?: Predictor | undefined;
  /** A predictor hook threw; default: logged through `consoleLog`. */
  onPredictorError?: ((err: unknown, hook: PredictorHook) => void) | undefined;
}

interface Slot {
  tick: number;
  seq: number;
  frame: InputFrameBase;
}

interface MutableView {
  serverTick: number;
  ackedTick: number;
  ackedSeq: number;
  entity: EntityId;
  authoritative: ReplicaEntity | undefined;
  readonly replica: ReplicaWorld;
  readonly pending: PendingInputs;
}

/** The pending frames: a ring whose slots, frame objects included, are created once and reused. */
class PendingRing implements PendingInputs {
  readonly capacity: number;
  private readonly schema: Schema<InputFrameBase>;
  private readonly slots: Slot[] = [];
  /** Physical index of the oldest slot. */
  private head = 0;
  private count = 0;

  constructor(schema: Schema<InputFrameBase>, capacity: number) {
    this.schema = schema;
    this.capacity = capacity;
  }

  get length(): number {
    return this.count;
  }

  at(i: number): Slot {
    if (!Number.isInteger(i) || i < 0 || i >= this.count) {
      throw new RangeError(`PendingInputs.at(${i}): index outside 0..${this.count - 1}`);
    }
    return this.slots[(this.head + i) % this.capacity] as Slot;
  }

  /** Appends a slot for the caller to fill; the ring must not be full. */
  push(): Slot {
    const index = (this.head + this.count) % this.capacity;
    let slot = this.slots[index];
    if (slot === undefined) {
      slot = { tick: 0, seq: 0, frame: this.schema.create() };
      this.slots[index] = slot;
    }
    this.count++;
    return slot;
  }

  shift(): void {
    if (this.count === 0) return;
    this.head = (this.head + 1) % this.capacity;
    this.count--;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }
}

function logPredictorError(err: unknown, hook: PredictorHook): void {
  consoleLog('error', `predictor.${hook} threw`, { err });
}

/**
 * The reconciliation stub (M6, docs/net.md B.10): the seam where client-side prediction and
 * reconciliation of the local entity will live. It records each input frame the client sends,
 * tracks the input acknowledgement of each snapshot header (`lastInputTick`/`lastInputSeq`), prunes
 * the frames the server has applied or passed over (every tick up to the snapshot's `serverTick`)
 * and counts. It replays nothing and never writes to the replica, the clock or the input stream;
 * a `Predictor` plugged in gets the frames, the acknowledgement and the local entity's
 * authoritative record.
 */
export class Reconciler {
  private readonly schema: Schema<InputFrameBase>;
  private readonly replica: ReplicaWorld;
  private readonly predictor: Predictor | undefined;
  private readonly onPredictorError: (err: unknown, hook: PredictorHook) => void;
  private readonly ring: PendingRing;
  private readonly view: MutableView;
  /** The newest tick recorded on this connection; a frame must be above it. */
  private newestTick = 0;
  private ackedTick = 0;
  private ackedSeq = 0;
  private authoritativeTick = 0;
  private ackedFrames = 0;
  private missedFrames = 0;
  private droppedFrames = 0;

  constructor(schema: Schema<InputFrameBase>, replica: ReplicaWorld, opts: ReconcilerOptions = {}) {
    const capacity = opts.capacity ?? PREDICTION_RING;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`Reconciler: capacity must be an integer >= 1, got ${capacity}`);
    }
    this.schema = schema;
    this.replica = replica;
    this.predictor = opts.predictor;
    this.onPredictorError = opts.onPredictorError ?? logPredictorError;
    this.ring = new PendingRing(schema, capacity);
    this.view = {
      serverTick: 0,
      ackedTick: 0,
      ackedSeq: 0,
      entity: ENTITY_NONE,
      authoritative: undefined,
      replica,
      pending: this.ring,
    };
  }

  /** The frames no snapshot has reached yet, oldest first. */
  get pending(): PendingInputs {
    return this.ring;
  }

  /**
   * An Input message went out with envelope seq `seq`: records a copy of its newest frame, the one
   * this client tick stamped, unless its tick is not above the newest recorded (the server ignores
   * such a frame too, docs/net.md A.7). A full ring evicts its oldest frame first.
   */
  onInputSent(msg: InputPayload, seq: number): void {
    const frame = msg.frames[msg.frames.length - 1];
    if (frame === undefined || !(frame.tick > this.newestTick)) return;
    this.newestTick = frame.tick;
    const ring = this.ring;
    if (ring.length === ring.capacity) {
      ring.shift();
      this.droppedFrames++;
    }
    const slot = ring.push();
    slot.tick = frame.tick;
    slot.seq = seq;
    this.schema.copy(frame, slot.frame);
    const predictor = this.predictor;
    if (predictor?.inputSent !== undefined) {
      try {
        predictor.inputSent(slot);
      } catch (err) {
        this.onPredictorError(err, 'inputSent');
      }
    }
  }

  /**
   * A snapshot with `header` was applied to the replica: raises the acknowledgement, prunes every
   * frame at or below `serverTick` (counting those above `lastInputTick` as missed), notes whether
   * the local `entity` is alive in the replica, then lets the predictor reconcile.
   */
  onSnapshot(header: SnapshotHeader, entity: EntityId): void {
    if (header.lastInputTick > this.ackedTick) {
      this.ackedTick = header.lastInputTick;
      this.ackedSeq = header.lastInputSeq;
    }
    const ring = this.ring;
    while (ring.length > 0) {
      const tick = ring.at(0).tick;
      if (tick > header.serverTick) break;
      if (tick > header.lastInputTick) this.missedFrames++;
      ring.shift();
      this.ackedFrames++;
    }
    const ent = entity === ENTITY_NONE ? undefined : this.replica.get(entity);
    const authoritative = ent !== undefined && ent.destroyedTick === null ? ent : undefined;
    if (authoritative !== undefined) this.authoritativeTick = header.serverTick;
    const predictor = this.predictor;
    if (predictor?.reconcile !== undefined) {
      const view = this.view;
      view.serverTick = header.serverTick;
      view.ackedTick = this.ackedTick;
      view.ackedSeq = this.ackedSeq;
      view.entity = entity;
      view.authoritative = authoritative;
      try {
        predictor.reconcile(view);
      } catch (err) {
        this.onPredictorError(err, 'reconcile');
      }
    }
  }

  /**
   * Forgets this connection: pending frames, the newest tick, the acknowledgement and the
   * authoritative tick. The counters since construction stay.
   */
  reset(): void {
    this.ring.clear();
    this.newestTick = 0;
    this.ackedTick = 0;
    this.ackedSeq = 0;
    this.authoritativeTick = 0;
    const view = this.view;
    view.serverTick = 0;
    view.ackedTick = 0;
    view.ackedSeq = 0;
    view.entity = ENTITY_NONE;
    view.authoritative = undefined;
    const predictor = this.predictor;
    if (predictor?.reset !== undefined) {
      try {
        predictor.reset();
      } catch (err) {
        this.onPredictorError(err, 'reset');
      }
    }
  }

  stats(): PredictionStats {
    return {
      pendingFrames: this.ring.length,
      lastAckedTick: this.ackedTick,
      lastAckedSeq: this.ackedSeq,
      authoritativeTick: this.authoritativeTick,
      ackedFrames: this.ackedFrames,
      missedFrames: this.missedFrames,
      droppedFrames: this.droppedFrames,
    };
  }
}
