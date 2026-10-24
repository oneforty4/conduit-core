import { diagnosticNow, observeDiagnostic, type DiagnosticOptions } from '@conduit/math';
import type { InputFrameBase, Schema } from '@conduit/protocol';
import type { DeepReadonly, EntityId } from '@conduit/sim';
import type { RegionId } from '@conduit/world';
import { guardView } from '@conduit/sim';
import { freezeOwned } from './readonly-view.ts';
import type { PendingInput, Predictor, ReconcileView } from './prediction.ts';

export type PredictionResetReason =
  | 'explicit'
  | 'overflow'
  | 'discontinuity'
  | 'entity'
  | 'boundary'
  | 'missing-history'
  | 'adapter-error';

export interface AuthoritativePrediction<I> {
  /** True only when ALL declared state, external conditions and command outcomes are coherent at view.serverTick. */
  coherent: boolean;
  /** Tick at which the declared group is coherent; may trail the global snapshot tick. */
  authoritativeTick: number;
  /** Consumer epoch, teleport and region/coordinate-frame identity. */
  boundaryKey: string;
  regionId: RegionId | null;
  /** Actual authoritative held controls, not inferred from input acknowledgement. */
  heldInput: I | undefined;
  /** Explicit authoritative outcomes for speculative commands known at this tick. */
  commandOutcomes?: readonly { id: string; outcome: 'confirmed' | 'cancelled' }[];
}
export interface PredictionStep<I, C> {
  readonly tick: number;
  readonly dt: number;
  readonly input: DeepReadonly<I> | undefined;
  readonly commands: readonly DeepReadonly<C>[];
  /** Replay must not issue irreversible effects. Prefer the separate effect ledger. */
  readonly phase: 'predict' | 'replay';
}
export interface PredictionAdapter<S, I, P, C = never> {
  /** All evolving state and external conditions needed by step must be represented here or explicitly supplied by the adapter. */
  createState(): S;
  copyState(source: DeepReadonly<S>, out: S): void;
  readAuthoritative(view: ReconcileView, out: S): AuthoritativePrediction<I>;
  step(state: S, context: PredictionStep<I, C>): void;
  /** Consumer tolerance handles quantified/wire rounding; core supplies no movement approximation. */
  equals(expected: DeepReadonly<S>, actual: DeepReadonly<S>): boolean;
  /** Pure presentation sampling into caller-owned output; must never step persistent simulation. */
  sample(previous: DeepReadonly<S>, current: DeepReadonly<S>, alpha: number, out: P): void;
  reset?(reason: PredictionResetReason): void;
}
export interface PredictionDriverOptions<S, I extends InputFrameBase, P, C = never> {
  adapter: PredictionAdapter<S, I, P, C>;
  diagnostics?: DiagnosticOptions | undefined;
  inputSchema: Schema<I>;
  tickRate: number;
  /** Bounded retained ticks/inputs/commands; default 128, range 2..4096. */
  capacity?: number;
  /** Work per reconcile/pulse, default capacity. Long gaps reset rather than catch up unboundedly. */
  maxReplayTicks?: number;
  copyCommand?: (command: DeepReadonly<C>) => C;
  onCommandOutcome?: (id: string, outcome: 'confirmed' | 'cancelled') => void;
  onError?: (error: unknown) => void;
}
interface StateSlot<S> {
  tick: number;
  value: S;
}
interface CommandSlot<C> {
  id: string;
  tick: number;
  value: C;
}

function predictionNow(): number {
  return performance.now();
}

/** Opt-in fixed-tick prediction. The authoritative replica is never mutated. */
export class PredictionDriver<S, I extends InputFrameBase, P, C = never> implements Predictor {
  private readonly adapter: PredictionAdapter<S, I, P, C>;
  private readonly schema: Schema<I>;
  private readonly capacity: number;
  private readonly maxReplay: number;
  private readonly dt: number;
  private readonly authoritative: S;
  private readonly working: S;
  private readonly samplePrevious: S;
  private readonly sampleCurrent: S;
  private readonly inputs = new Map<number, I>();
  private readonly states: StateSlot<S>[] = [];
  private readonly commands: CommandSlot<C>[] = [];
  private readonly outcomes = new Map<
    string,
    { outcome: 'confirmed' | 'cancelled'; tick: number }
  >();
  private initialized = false;
  private currentTick = 0;
  private targetTick = 0;
  private authoritativeTick = 0;
  private entity: EntityId = 0;
  private boundary = '';
  private region: RegionId | null = null;
  private held: I | undefined;
  private correctionCount = 0;
  private retiredCommandsThrough = 0;
  private rejectedCommands = 0;
  private resetCount = 0;
  private readonly options: PredictionDriverOptions<S, I, P, C>;
  private readonly inputPool: I[] = [];
  private readonly statePool: S[] = [];
  private readonly commandScratch: DeepReadonly<C>[] = [];
  private readonly sampleGuards = new WeakMap<object, object>();
  constructor(options: PredictionDriverOptions<S, I, P, C>) {
    this.options = options;
    this.adapter = options.adapter;
    this.schema = options.inputSchema;
    this.capacity = options.capacity ?? 128;
    this.maxReplay = options.maxReplayTicks ?? this.capacity;
    if (
      !Number.isInteger(this.capacity) ||
      this.capacity < 2 ||
      this.capacity > 4096 ||
      !Number.isInteger(this.maxReplay) ||
      this.maxReplay < 1 ||
      this.maxReplay > this.capacity
    )
      throw new RangeError('PredictionDriver: invalid history/work bounds');
    if (!Number.isFinite(options.tickRate) || options.tickRate <= 0)
      throw new RangeError('PredictionDriver: invalid tickRate');
    this.dt = 1 / options.tickRate;
    this.authoritative = this.adapter.createState();
    this.working = this.adapter.createState();
    this.samplePrevious = this.adapter.createState();
    this.sampleCurrent = this.adapter.createState();
  }
  get tick(): number {
    return this.currentTick;
  }
  get ready(): boolean {
    return this.initialized;
  }
  get metadata(): Readonly<{
    entity: EntityId;
    tick: number;
    regionId: RegionId | null;
    boundaryKey: string;
  }> {
    return {
      entity: this.entity,
      tick: this.currentTick,
      regionId: this.region,
      boundaryKey: this.boundary,
    };
  }
  stats() {
    return {
      tick: this.currentTick,
      authoritativeTick: this.authoritativeTick,
      retainedInputs: this.inputs.size,
      retainedStates: this.states.length,
      pendingCommands: this.commands.length,
      commandHistory: this.outcomes.size,
      commandPressure: this.commands.length + this.outcomes.size >= this.capacity,
      rejectedCommands: this.rejectedCommands,
      retiredCommandsThrough: this.retiredCommandsThrough,
      corrections: this.correctionCount,
      resets: this.resetCount,
    };
  }

  inputSent(input: PendingInput): void {
    this.recordInput(input.frame as DeepReadonly<I>);
  }
  /** Copies a sent frame. No timer or render callback is interpreted as another simulation tick. */
  recordInput(input: DeepReadonly<I>): void {
    try {
      this.recordInputUnsafe(input);
    } catch (error) {
      this.resetWithReason('adapter-error');
      throw error;
    }
  }
  private recordInputUnsafe(input: DeepReadonly<I>): void {
    const tick = input.tick;
    if (!Number.isSafeInteger(tick) || tick <= this.targetTick) return;
    if (this.inputs.size >= this.capacity) this.resetWithReason('overflow');
    this.inputs.set(
      tick,
      this.schema.copy(input as I, this.inputPool.pop() ?? this.schema.create()),
    );
    this.targetTick = tick;
    if (this.initialized) this.advanceTo(tick, 'predict');
  }
  /** Commands are consumer-scheduled explicit events, separate from held input controls. */
  recordCommand(id: string, tick: number, command: DeepReadonly<C>): boolean {
    try {
      return this.recordCommandUnsafe(id, tick, command);
    } catch (error) {
      this.resetWithReason('adapter-error');
      throw error;
    }
  }
  private recordCommandUnsafe(id: string, tick: number, command: DeepReadonly<C>): boolean {
    if (
      id.length === 0 ||
      id.length > 128 ||
      !Number.isSafeInteger(tick) ||
      tick <= this.authoritativeTick ||
      this.outcomes.has(id) ||
      this.commands.some((entry) => entry.id === id)
    )
      return false;
    if (this.commands.length + this.outcomes.size >= this.capacity) {
      this.rejectedCommands++;
      return false;
    }
    if (this.options.copyCommand === undefined)
      throw new Error('PredictionDriver: copyCommand required for command prediction');
    if (this.commands.length >= this.capacity) {
      this.resetWithReason('overflow');
      return false;
    }
    this.commands.push({ id, tick, value: freezeOwned(this.options.copyCommand(command)) });
    if (this.initialized && tick <= this.currentTick) {
      // Late commands require an authoritative replay anchor; do not mutate a historical state.
      this.initialized = false;
      this.clearStates();
    }
    return true;
  }
  reconcile(view: ReconcileView): void {
    const diagnostics = this.options.diagnostics;
    const start =
      diagnostics === undefined ? undefined : diagnosticNow(diagnostics.now ?? predictionNow);
    try {
      this.reconcileUnsafe(view);
      if (diagnostics !== undefined) {
        const end = diagnosticNow(diagnostics.now ?? predictionNow);
        if (end !== undefined) {
          observeDiagnostic(diagnostics.observer, {
            version: 1,
            category: 'prediction',
            name: 'reconcile',
            timeMs: end,
            tick: this.currentTick,
            durationMs: start === undefined || end < start ? undefined : end - start,
            status: start === undefined ? 'unavailable' : 'ok',
          });
          observeDiagnostic(diagnostics.observer, {
            version: 1,
            category: 'prediction',
            name: 'corrections-total',
            timeMs: end,
            tick: this.currentTick,
            value: this.correctionCount,
            unit: 'count',
          });
        }
      }
    } catch (error) {
      this.resetWithReason('adapter-error');
      throw error;
    }
  }
  private reconcileUnsafe(view: ReconcileView): void {
    if (view.authoritative === undefined) {
      this.resetWithReason('entity');
      return;
    }
    const info = this.adapter.readAuthoritative(view, this.authoritative);
    // Critically, an incoherent/global snapshot must not prune older inputs or advance our anchor.
    if (!info.coherent || info.authoritativeTick < this.authoritativeTick) return;
    const authoritativeTick = info.authoritativeTick;
    if (
      !Number.isSafeInteger(authoritativeTick) ||
      authoritativeTick < 0 ||
      authoritativeTick > view.serverTick
    )
      throw new RangeError('PredictionDriver: invalid authoritative tick');
    if (authoritativeTick < this.authoritativeTick) return;
    const changed =
      this.entity !== 0 &&
      (this.entity !== view.entity ||
        this.boundary !== info.boundaryKey ||
        this.region !== info.regionId);
    if (changed) this.resetWithReason(this.entity !== view.entity ? 'entity' : 'boundary');
    const predicted = this.states.find((slot) => slot.tick === authoritativeTick);
    if (
      predicted !== undefined &&
      !this.adapter.equals(
        predicted.value as DeepReadonly<S>,
        this.authoritative as DeepReadonly<S>,
      )
    )
      this.correctionCount++;
    const target = Math.max(authoritativeTick, this.targetTick);
    this.entity = view.entity;
    this.boundary = info.boundaryKey;
    this.region = info.regionId;
    this.authoritativeTick = authoritativeTick;
    this.currentTick = authoritativeTick;
    this.targetTick = target;
    this.adapter.copyState(this.authoritative as DeepReadonly<S>, this.working);
    this.held =
      info.heldInput === undefined
        ? undefined
        : this.schema.copy(info.heldInput, this.held ?? this.schema.create());
    this.clearStates();
    this.retainState();
    this.initialized = true;
    for (const [tick, frame] of this.inputs)
      if (tick <= authoritativeTick) {
        this.inputs.delete(tick);
        this.inputPool.push(frame);
      }
    for (const outcome of info.commandOutcomes ?? [])
      this.resolveCommand(outcome.id, outcome.outcome);
    // Past commands require an explicit authoritative outcome. Missing outcomes make replay unsafe.
    if (this.commands.some((command) => command.tick <= authoritativeTick)) {
      this.initialized = false;
      return;
    }
    this.advanceTo(target, 'replay');
  }
  /** Samples owned scratch copies. Even a badly behaved sample callback cannot advance working state. */
  sample(tick: number, out: P): P | undefined {
    try {
      return this.sampleUnsafe(tick, out);
    } catch (error) {
      this.resetWithReason('adapter-error');
      throw error;
    }
  }
  private sampleUnsafe(tick: number, out: P): P | undefined {
    if (!this.initialized || !Number.isFinite(tick)) return undefined;
    const last = this.states[this.states.length - 1];
    if (last === undefined) return undefined;
    const clamped = Math.min(Math.max(tick, this.states[0]!.tick), last.tick);
    let previous = this.states[0]!;
    let current = previous;
    for (const state of this.states) {
      if (state.tick <= clamped) previous = state;
      if (state.tick >= clamped) {
        current = state;
        break;
      }
    }
    this.adapter.copyState(previous.value as DeepReadonly<S>, this.samplePrevious);
    this.adapter.copyState(current.value as DeepReadonly<S>, this.sampleCurrent);
    const alpha =
      current.tick === previous.tick
        ? 0
        : (clamped - previous.tick) / (current.tick - previous.tick);
    this.adapter.sample(
      guardView(this.samplePrevious, () => {}, false, this.sampleGuards) as DeepReadonly<S>,
      guardView(this.sampleCurrent, () => {}, false, this.sampleGuards) as DeepReadonly<S>,
      alpha,
      out,
    );
    return out;
  }
  /** Explicit deduplication retention boundary; caller must never reuse retired IDs or resend old outcomes. Movement history is retained. */
  retireCommandHistory(throughTick: number): void {
    if (
      !Number.isSafeInteger(throughTick) ||
      throughTick < this.retiredCommandsThrough ||
      throughTick > this.authoritativeTick
    )
      throw new RangeError('PredictionDriver: invalid command retirement boundary');
    this.retiredCommandsThrough = throughTick;
    for (const [id, outcome] of this.outcomes)
      if (outcome.tick <= throughTick) this.outcomes.delete(id);
  }

  reset(): void {
    this.resetWithReason('explicit');
  }
  private advanceTo(target: number, phase: 'predict' | 'replay'): void {
    if (target - this.currentTick > this.maxReplay) {
      this.resetWithReason('discontinuity');
      return;
    }
    while (this.currentTick < target) {
      const tick = this.currentTick + 1;
      const input = this.inputs.get(tick);
      if (input !== undefined)
        this.held = this.schema.copy(input, this.held ?? this.schema.create());
      this.commandScratch.length = 0;
      for (const command of this.commands)
        if (command.tick === tick) this.commandScratch.push(command.value as DeepReadonly<C>);
      this.adapter.step(this.working, {
        tick,
        dt: this.dt,
        input: this.held as DeepReadonly<I> | undefined,
        commands: this.commandScratch,
        phase,
      });
      this.currentTick = tick;
      this.retainState();
    }
  }
  private retainState(): void {
    const value =
      this.states.length >= this.capacity
        ? this.states.shift()!.value
        : (this.statePool.pop() ?? this.adapter.createState());
    this.adapter.copyState(this.working as DeepReadonly<S>, value);
    this.states.push({ tick: this.currentTick, value });
  }
  private resolveCommand(id: string, outcome: 'confirmed' | 'cancelled'): void {
    if (this.outcomes.has(id)) return;
    const index = this.commands.findIndex((command) => command.id === id);
    if (index < 0) return;
    const command = this.commands[index]!;
    this.commands.splice(index, 1);
    this.outcomes.set(id, { outcome, tick: command.tick });

    this.notify(() => this.options.onCommandOutcome?.(id, outcome));
  }
  private clearStates(): void {
    for (const slot of this.states) this.statePool.push(slot.value);
    this.states.length = 0;
  }
  private notify(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      try {
        this.options.onError?.(error);
      } catch {
        /* Reporting cannot interrupt cleanup. */
      }
    }
  }
  private resetWithReason(reason: PredictionResetReason): void {
    const cancelled = this.commands.map((command) => command.id);
    for (const frame of this.inputs.values()) this.inputPool.push(frame);
    this.inputs.clear();
    this.retiredCommandsThrough = 0;
    this.clearStates();
    this.commands.length = 0;
    this.outcomes.clear();
    this.initialized = false;
    this.currentTick = 0;
    this.targetTick = 0;
    this.authoritativeTick = 0;
    this.entity = 0;
    this.boundary = '';
    this.region = null;
    this.held = undefined;
    this.resetCount++;
    for (const id of cancelled) this.notify(() => this.options.onCommandOutcome?.(id, 'cancelled'));
    this.notify(() => this.adapter.reset?.(reason));
  }
}
