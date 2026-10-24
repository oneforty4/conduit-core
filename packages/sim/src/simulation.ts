import { DEFAULT_SESSION_CAPACITY, QUALIFIED_SESSION_CAPACITY } from '@conduit/protocol';
import { cloneExactState } from './checkpoint.ts';
import { guardView, type DeepReadonly } from './readonly.ts';
import { Rng, diagnosticNow, observeDiagnostic, type DiagnosticOptions } from '@conduit/math';
import type { InputFrame, RegionId, RegionsApi, SimContext, SpatialApi } from './context.ts';
import { DuplicateSystem, TickOrder } from './errors.ts';
import { EventBus, type EventCheckpoint } from './events.ts';
import { type Phase, PHASES, type System } from './system.ts';
import type { World } from './world.ts';

/** Player ids are 0..MAX_PLAYERS-1. */
/** @deprecated Use the explicit default/qualified/protocol limits from @conduit/protocol. */
export const MAX_PLAYERS = DEFAULT_SESSION_CAPACITY;

export interface SimulationOpts {
  /** Invocation-boundary diagnostics require an injected clock; systems remain clock-free. */
  diagnostics?: (DiagnosticOptions & { now: () => number }) | undefined;
  world: World;
  /** Default 60. */
  tickRate?: number;
  /** `ctx.rng = new Rng(seed)`. */
  seed: number;
  regionRng: (id: RegionId) => Rng;
  regions: RegionsApi;
  spatial: SpatialApi;
  /** Default `MAX_PLAYERS`. */
  maxPlayers?: number;
}

/** The single mutable context a Simulation hands to every system; `tick`/`dt` are set by `step`. */
class Context implements SimContext {
  readonly world: World;
  tick: number;
  dt: number;
  readonly rng: Rng;
  readonly regions: RegionsApi;
  readonly spatial: SpatialApi;
  readonly events: EventBus;
  private readonly regionRngFn: (id: RegionId) => Rng;
  private readonly frames: readonly (InputFrame | undefined)[];

  constructor(
    opts: SimulationOpts,
    dt: number,
    events: EventBus,
    frames: readonly (InputFrame | undefined)[],
  ) {
    this.world = opts.world;
    this.tick = opts.world.tick;
    this.dt = dt;
    this.rng = new Rng(opts.seed);
    this.regions = opts.regions;
    this.spatial = opts.spatial;
    this.events = events;
    this.regionRngFn = opts.regionRng;
    this.frames = frames;
  }

  regionRng(id: RegionId): Rng {
    return this.regionRngFn(id);
  }

  private readonly inputViews = new WeakMap<object, object>();
  inputs(player: number): DeepReadonly<InputFrame> | undefined {
    const frame = this.frames[player];
    return this.world.mutationGuards ? guardView(frame, () => {}, false, this.inputViews) : frame;
  }
}

/** A failed invocation leaves partial private state and requires checkpoint recovery. */
export class SimulationFault extends Error {
  readonly tick: number;
  readonly system: string;
  readonly phase: string;
  constructor(tick: number, system: string, phase: string, cause: unknown) {
    super(
      `Simulation tick ${tick}: ${phase}/${system} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = 'SimulationFault';
    this.tick = tick;
    this.system = system;
    this.phase = phase;
  }
}

/** Runs registered systems in the canonical tick pipeline (docs/sim.md 2.9). */
export class Simulation {
  readonly ctx: SimContext;
  readonly events: EventBus;
  /** Indexed by player id; written by the caller before `step`, never cleared by the sim. */
  readonly inputFrames: (InputFrame | undefined)[];
  /** Core postSim tail, pushed by the caller (the Session: membership, then spatial rebuild). */
  readonly tail: Array<(ctx: SimContext) => void> = [];
  /**
   * Replay recording hook (docs/sim.md 2.11), installed by `recordInputs`: `step(tick)` calls it for
   * every player in id order with the frame placed for that tick (`undefined` when there is none),
   * after the tick succeeds, so failed ticks are never recorded as committed.
   */
  onInputsPlaced?:
    ((tick: number, player: number, frame: InputFrame | undefined) => void) | undefined;

  private readonly diagnostics: (DiagnosticOptions & { now: () => number }) | undefined;
  private readonly world: World;
  private readonly context: Context;
  private readonly tickRate: number;
  /** Index = position in `PHASES`. */
  private readonly byPhase: System[][] = PHASES.map(() => []);
  private readonly names = new Set<string>(); // lookup only
  private started = false;
  private failure: SimulationFault | null = null;
  get fault(): SimulationFault | null {
    return this.failure;
  }

  constructor(opts: SimulationOpts) {
    this.diagnostics = opts.diagnostics;
    const tickRate = opts.tickRate ?? 60;
    if (!(Number.isFinite(tickRate) && tickRate > 0)) {
      throw new RangeError(`Simulation: tickRate must be a positive number, got ${tickRate}`);
    }
    const maxPlayers = opts.maxPlayers ?? MAX_PLAYERS;
    if (
      !Number.isInteger(maxPlayers) ||
      maxPlayers < 1 ||
      maxPlayers > QUALIFIED_SESSION_CAPACITY
    ) {
      throw new RangeError(
        `Simulation: maxPlayers must be an integer in 1..${QUALIFIED_SESSION_CAPACITY}`,
      );
    }
    this.world = opts.world;
    this.tickRate = tickRate;
    this.events = new EventBus(opts.world);
    this.inputFrames = new Array<InputFrame | undefined>(maxPlayers).fill(undefined);
    this.context = new Context(opts, 1 / tickRate, this.events, this.inputFrames);
    this.ctx = this.context;
  }

  /** Throws `DuplicateSystem` on a repeated name and `Error` after the first `step`. */
  register(system: System): void {
    if (this.started) {
      throw new Error(
        `Simulation.register(${system.name}): systems must be registered before the first step`,
      );
    }
    const index = PHASES.indexOf(system.phase);
    if (index < 0) {
      throw new RangeError(
        `Simulation.register(${system.name}): unknown phase ${JSON.stringify(system.phase)}`,
      );
    }
    if (this.names.has(system.name)) throw new DuplicateSystem(system.name);
    this.names.add(system.name);
    (this.byPhase[index] as System[]).push(system);
  }

  /** Systems of `phase` in registration order. */
  systems(phase: Phase): readonly System[] {
    const list = this.byPhase[PHASES.indexOf(phase)];
    if (list === undefined)
      throw new RangeError(`Simulation.systems: unknown phase ${JSON.stringify(phase)}`);
    return list;
  }

  /**
   * Skips `count` ticks (an integer >= 1): `world.tick` moves on by `count` without a step, so none
   * of them runs -- no phase, no tail, no frames reported. A Session skips the ticks its loop drops,
   * keeping tick numbers to the clock (docs/sim.md 2.10), and a replay of it the same ones (2.11).
   * Writes and events made between steps keep their stamps (`tick + 1` and `tick` as they were
   * made), which the next step sees as it would have. Not while stepping.
   */
  skip(count: number): void {
    if (this.fault !== null) throw this.fault;
    const world = this.world;
    if (world.stepping) throw new Error(`Simulation.skip(${count}): not while stepping`);
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new RangeError(`Simulation.skip: count must be an integer >= 1, got ${count}`);
    }
    this.started = true;
    world.tick += count;
    this.context.tick = world.tick;
  }

  captureCheckpoint(): SimulationCheckpoint {
    if (this.world.stepping || this.fault !== null)
      throw new Error('Simulation checkpoint requires a healthy completed tick');
    return cloneExactState({
      version: 1,
      tick: this.world.tick,
      tickRate: this.tickRate,
      seedState: this.context.rng.state(),
      inputs: this.inputFrames,
      events: this.events.captureCheckpoint(),
      started: this.started,
      systems: PHASES.flatMap((phase) =>
        this.systems(phase).map((system) => ({ name: system.name, phase: system.phase })),
      ),
    });
  }

  validateCheckpoint(state: SimulationCheckpoint): void {
    if (
      state.version !== 1 ||
      !Number.isSafeInteger(state.tick) ||
      state.tick < 0 ||
      state.tickRate !== this.tickRate ||
      !Number.isInteger(state.seedState) ||
      state.seedState < 0 ||
      state.seedState > 0xffffffff ||
      state.inputs.length !== this.inputFrames.length
    )
      throw new TypeError('Invalid simulation checkpoint');
    const systems = PHASES.flatMap((phase) =>
      this.systems(phase).map((system) => ({ name: system.name, phase: system.phase })),
    );
    if (JSON.stringify(systems) !== JSON.stringify(state.systems))
      throw new TypeError('Simulation checkpoint system ordering mismatch');
    this.events.validateCheckpoint(state.events);
    cloneExactState(state);
  }

  restoreCheckpoint(input: SimulationCheckpoint): void {
    if (this.world.stepping) throw new Error('Simulation.restoreCheckpoint: not while stepping');
    const state = cloneExactState(input);
    this.validateCheckpoint(state);
    if (state.tick !== this.world.tick)
      throw new TypeError('Simulation checkpoint tick differs from restored world');
    this.context.tick = state.tick;
    this.context.rng.restore(state.seedState);
    for (let p = 0; p < state.inputs.length; p++) this.inputFrames[p] = state.inputs[p];
    this.events.restoreCheckpoint(state.events);
    this.started = state.started;
    this.failure = null;
  }

  /**
   * One tick: advance `world.tick`, run the phases and tail, validate tracked writes,
   * apply destroys, end the event tick, then report committed inputs. `tick` must be `world.tick + 1` (`TickOrder`
   * otherwise). `world.stepping` is true for the duration. If the hook or a system throws, the
   * structured fault propagates. Further steps are rejected; partial state needs checkpoint recovery.
   */
  step(tick: number): void {
    if (this.fault !== null) throw this.fault;
    const world = this.world;
    if (world.stepping) throw new Error(`Simulation.step(${tick}): step is not re-entrant`);
    const expected = world.tick + 1;
    if (tick !== expected) throw new TickOrder(expected, tick);
    this.started = true;
    world.tick = tick;
    const ctx = this.context;
    ctx.tick = tick;
    ctx.dt = 1 / this.tickRate;
    world.stepping = true;
    try {
      const byPhase = this.byPhase;
      for (let p = 0; p < byPhase.length; p++) {
        const list = byPhase[p] as System[];
        for (let i = 0; i < list.length; i++) {
          const system = list[i]!;
          const diagnostics = this.diagnostics;
          const start = diagnostics === undefined ? undefined : diagnosticNow(diagnostics.now);
          let failed = false;
          try {
            system.run(ctx);
          } catch (cause) {
            failed = true;
            throw new SimulationFault(tick, system.name, system.phase, cause);
          } finally {
            if (diagnostics !== undefined) {
              const end = diagnosticNow(diagnostics.now);
              if (end !== undefined)
                observeDiagnostic(diagnostics.observer, {
                  version: 1,
                  category: 'system',
                  name: system.name,
                  timeMs: end,
                  tick,
                  durationMs: start === undefined || end < start ? undefined : end - start,
                  status: failed
                    ? 'error'
                    : start === undefined || end < start
                      ? 'unavailable'
                      : 'ok',
                });
            }
          }
        }
      }
      const tail = this.tail;
      for (let i = 0; i < tail.length; i++) {
        try {
          tail[i]!(ctx);
        } catch (cause) {
          throw new SimulationFault(tick, `tail[${i}]`, 'tail', cause);
        }
      }
      const stores = world.stores();
      for (let i = 0; i < stores.length; i++) stores[i]!.validateWrites();
      world.applyDestroys();
      const placed = this.onInputsPlaced;
      if (placed !== undefined)
        for (let p = 0; p < this.inputFrames.length; p++) placed(tick, p, this.inputFrames[p]);
      this.events.endTick();
    } catch (cause) {
      this.failure =
        cause instanceof SimulationFault
          ? cause
          : new SimulationFault(tick, 'pipeline', 'commit', cause);
      throw this.fault;
    } finally {
      world.stepping = false;
    }
  }
}

export interface SimulationCheckpoint {
  readonly version: 1;
  readonly tick: number;
  readonly tickRate: number;
  readonly seedState: number;
  readonly inputs: readonly (InputFrame | undefined)[];
  readonly events: EventCheckpoint;
  readonly started: boolean;
  readonly systems: readonly { readonly name: string; readonly phase: Phase }[];
}
