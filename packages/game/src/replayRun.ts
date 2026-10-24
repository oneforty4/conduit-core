import {
  type PlayerInfo,
  type PlayerSpawn,
  Session,
  type SessionGameDef,
  type SessionHooks,
  type SessionOptions,
  type ExternalCommand,
  type SpawnPlanSerializer,
  type ExactSessionCheckpoint,
  executionStateOfCheckpoint,
} from '@conduit/net-server';
import { type BlobStore, MemoryStore } from '@conduit/persist';
import { ENTITY_NONE, PlayerState, type Schema, type MessageDef } from '@conduit/protocol';
import {
  type EntityId,
  cloneExactState,
  validateCommandJournal,
  type CommandJournal,
  type JournalReplayRun,
  type StateSerializer,
  type InputFrame,
  type LifecycleEvent,
  MAX_PLAYERS,
  type ReplayRun,
  TickOrder,
  SimulationFault,
} from '@conduit/sim';
import type { RegionId, RegionLoader } from '@conduit/world';
import { adaptHooks, consoleServerLog } from './serverContext.ts';
import type { Game, ServerHooks, ServerLog } from './types.ts';

/** Optional fields also accept `undefined`, as `CreateServerOpts`' do. */
export interface ReplayRunOpts<I extends InputFrame = InputFrame> {
  regionLoader: RegionLoader;
  /** Adapted as `createServer` adapts them; `ctx.players` lists the replayed players. */
  hooks: ServerHooks<I>;
  /**
   * Default `new MemoryStore()`. It must hold what the recorded session's store held when that
   * session started: the session blob decides `onLoad` or `onInit`, region blobs what regions load.
   */
  store?: BlobStore | undefined;
  /** u32; default `game.seed` (`ReplayableGame.createRun` passes the log's). */
  seed?: number | undefined;
  /** Integer in 1..255; default `game.tickRate`. */
  tickRate?: number | undefined;
  /** 1..8; default 8. */
  maxPlayers?: number | undefined;
  /** Default `consoleServerLog`: stage failures, hook throws and `ServerContext.log`. */
  log?: ServerLog | undefined;
}

/** A `ReplayRun` (docs/sim.md 2.11) over a game's session stack. */
export interface GameReplayRun extends ReplayRun {
  /**
   * The Session whose stack the run drives: world, graph, regions, spatial index, simulation and
   * `stats.tickErrors`. It has no loop and no links; its `players()` lists the replayed players.
   */
  readonly session: Session;
  lifecycle(player: number, event: LifecycleEvent): void;
  skip(count: number): void;
}

/** A player of the run: the Session's lifecycle flags (docs/net.md A.6) without a connection. */
interface ReplayPlayer {
  readonly playerId: number;
  readonly accountId: string;
  readonly displayName: string;
  plan: PlayerSpawn | null;
  entity: EntityId;
  /** *join* delivered for the next step; it runs even when a *leave* of that step follows it. */
  joinQueued: boolean;
  joinRan: boolean;
  /** Ready: *spawn* runs once `plan.regionId` is active. */
  spawnQueued: boolean;
  /** The *spawn* was delivered for the next step, so a *leave* of that step does not cancel it. */
  spawnFresh: boolean;
  playing: boolean;
  leaveQueued: boolean;
}

/** A Session whose `players()` are the replayed players, so `ServerContext.players` sees them. */
class ReplaySession extends Session {
  private readonly replayPlayers: () => readonly PlayerInfo[];

  constructor(game: SessionGameDef, opts: SessionOptions, players: () => readonly PlayerInfo[]) {
    super(game, opts);
    this.replayPlayers = players;
  }

  override players(): readonly PlayerInfo[] {
    return this.replayPlayers();
  }
}

/** Resolves on a later macrotask, once every promise callback queued so far has run. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

class Replay<I extends InputFrame> implements GameReplayRun {
  readonly session: Session;
  private readonly hooks: SessionHooks;
  private readonly input: Schema<I>;
  private readonly log: ServerLog;
  /** Index = playerId. */
  private readonly slots: (ReplayPlayer | null)[];
  /** The frame placed for each player every step; `setInput` changes it. */
  private readonly held: (InputFrame | undefined)[];
  private stepping = false;
  private failure: SimulationFault | null = null;

  constructor(game: Game<I>, def: SessionGameDef, opts: ReplayRunOpts<I>, log: ServerLog) {
    this.hooks = adaptHooks(opts.hooks, game, log);
    this.input = game.input;
    this.log = log;
    this.session = new ReplaySession(
      def,
      {
        store: opts.store ?? new MemoryStore(),
        regionLoader: opts.regionLoader,
        hooks: this.hooks,
        maxPlayers: opts.maxPlayers,
        log,
        manualLoop: true,
      },
      () => this.players(),
    );
    const maxPlayers = this.session.simulation.inputFrames.length;
    this.slots = new Array<ReplayPlayer | null>(maxPlayers).fill(null);
    this.held = new Array<InputFrame | undefined>(maxPlayers).fill(undefined);
  }

  setInput(player: number, frame: InputFrame | null): void {
    this.checkPlayer('setInput', player);
    this.held[player] =
      frame === null ? undefined : this.input.copy(frame as I, this.input.create());
  }

  lifecycle(player: number, event: LifecycleEvent): void {
    this.checkPlayer('lifecycle', player);
    const slot = this.slots[player] ?? null;
    switch (event.type) {
      case 'join':
        if (slot !== null) {
          throw new RangeError(
            `GameReplayRun.lifecycle: player ${player} joins while still in the session`,
          );
        }
        this.slots[player] = {
          playerId: player,
          accountId: event.accountId,
          displayName: event.displayName,
          plan: null,
          entity: ENTITY_NONE,
          joinQueued: true,
          joinRan: false,
          spawnQueued: false,
          spawnFresh: false,
          playing: false,
          leaveQueued: false,
        };
        return;
      case 'spawn':
        if (slot === null || slot.leaveQueued || slot.playing) {
          throw new RangeError(
            `GameReplayRun.lifecycle: player ${player} cannot spawn (${slot === null || slot.leaveQueued ? 'not in the session' : 'already spawned'})`,
          );
        }
        slot.spawnQueued = true;
        slot.spawnFresh = true;
        return;
      case 'leave':
        // The Session records every leave it runs, also of a player whose join never ran.
        if (slot === null) return;
        if (!slot.spawnFresh) slot.spawnQueued = false; // still waiting for its region: cancelled
        slot.leaveQueued = true;
        return;
      default:
        throw new RangeError(
          `GameReplayRun.lifecycle: unknown event ${JSON.stringify((event as { type?: unknown }).type)}`,
        );
    }
  }

  /**
   * The ticks the recorded session's loop dropped (docs/sim.md 2.10): the world's tick moves on by
   * `count` without a step, as the Session's did.
   */
  skip(count: number): void {
    if (this.stepping) throw new Error('GameReplayRun.skip: the previous step has not finished');
    this.session.simulation.skip(count);
  }

  /**
   * One Session tick without networking (docs/net.md A.5): lifecycle, the held frames, then
   * `regions.update` and `simulation.step` (docs/sim.md 2.9), each stage guarded as the Session
   * guards it; then a macrotask turn, so the region loads this step started settle before the next
   * one, as between the ticks of a live loop.
   */
  async step(tick: number): Promise<void> {
    if (this.failure !== null) throw this.failure;
    if (this.stepping) throw new Error('GameReplayRun.step: the previous step has not finished');
    const session = this.session;
    const expected = session.world.tick + 1;
    if (tick !== expected) throw new TickOrder(expected, tick);
    this.stepping = true;
    try {
      const ctx = session.ctx;
      const simulation = session.simulation;
      this.guard(tick, 'lifecycle', () => this.runLifecycle());
      this.guard(tick, 'input', () => {
        for (let p = 0; p < this.held.length; p++) simulation.inputFrames[p] = this.held[p];
      });
      this.guard(tick, 'regions.update', () =>
        session.regions.update(this.playerEntities(), ctx, this.spawnRegions()),
      );
      this.guard(tick, 'simulation.step', () => simulation.step(tick));
      this.guard(tick, 'events', () => {
        simulation.events.drainOutbox();
      });
      await nextTurn();
    } catch (cause) {
      this.failure =
        cause instanceof SimulationFault
          ? cause
          : new SimulationFault(tick, 'replay', 'pipeline', cause);
      throw this.failure;
    } finally {
      this.stepping = false;
    }
  }

  hash(): number {
    return this.session.world.hash();
  }

  /** `ctx.players`: every player in the session that is not leaving, ascending playerId. */
  private players(): PlayerInfo[] {
    const out: PlayerInfo[] = [];
    for (const slot of this.slots)
      if (slot !== null && !slot.leaveQueued) out.push(this.info(slot));
    return out;
  }

  private info(slot: ReplayPlayer, leaving = slot.leaveQueued): PlayerInfo {
    let state: PlayerState;
    if (leaving) state = slot.entity !== ENTITY_NONE ? PlayerState.Playing : PlayerState.Joined;
    else if (slot.playing) state = PlayerState.Playing;
    else if (slot.joinRan && slot.spawnQueued) state = PlayerState.Ready;
    else state = PlayerState.Joined;
    return {
      playerId: slot.playerId,
      accountId: slot.accountId,
      displayName: slot.displayName,
      state,
      entity: slot.entity,
    };
  }

  private checkPlayer(method: string, player: number): void {
    if (!Number.isInteger(player) || player < 0 || player >= this.slots.length) {
      throw new RangeError(
        `GameReplayRun.${method}: player must be an integer in 0..${this.slots.length - 1}, got ${player}`,
      );
    }
  }

  private guard(tick: number, stage: string, fn: () => void): void {
    try {
      fn();
    } catch (cause) {
      throw cause instanceof SimulationFault
        ? cause
        : new SimulationFault(tick, stage, 'replay', cause);
    }
  }

  private callHook(name: string, fn: () => void): boolean {
    try {
      fn();
      return true;
    } catch (cause) {
      throw new SimulationFault(this.session.world.tick + 1, name, 'hook', cause);
    }
  }

  /** The Session's lifecycle pass (docs/net.md A.6): joins, spawns, leaves, each in playerId order. */
  private runLifecycle(): void {
    const { session, hooks, slots } = this;
    const ctx = session.ctx;
    for (const slot of slots) {
      if (slot === null || !slot.joinQueued) continue;
      slot.joinQueued = false;
      let plan: PlayerSpawn | undefined;
      const ok = this.callHook('onPlayerJoin', () => {
        plan = hooks.onPlayerJoin(this.info(slot), ctx);
        if (
          plan === null ||
          typeof plan !== 'object' ||
          typeof plan.spawn !== 'function' ||
          session.graph.get(plan.regionId) === undefined
        ) {
          throw new Error(
            `onPlayerJoin must return a PlayerSpawn with a region of the world graph, got region ${String(plan?.regionId)}`,
          );
        }
      });
      if (!ok || plan === undefined) {
        this.kick(slot);
        continue;
      }
      slot.plan = plan;
      slot.joinRan = true;
    }

    const regions = session.regions;
    for (const slot of slots) {
      if (slot === null || !slot.spawnQueued || slot.plan === null) continue;
      if (!regions.active().includes(slot.plan.regionId)) continue; // waits, as a ready player does
      slot.spawnQueued = false;
      const plan = slot.plan;
      const ok = this.callHook('PlayerSpawn.spawn', () => {
        const entity = plan.spawn(ctx);
        if (session.world.alive(entity)) slot.entity = entity;
        else throw new Error(`PlayerSpawn.spawn returned entity ${entity}, which is not alive`);
        const region = regions.regionOf(entity);
        if (region === undefined || !regions.active().includes(region)) {
          throw new Error(
            `PlayerSpawn.spawn: entity ${entity} is not in an active region (${String(region)})`,
          );
        }
      });
      if (!ok) {
        this.kick(slot);
        continue;
      }
      slot.playing = true;
    }

    for (const slot of slots) if (slot !== null) slot.spawnFresh = false;
    for (const slot of slots) if (slot !== null && slot.leaveQueued) this.runLeave(slot);
  }

  /** A failed join or spawn: the Session kicks the player, whose *leave* runs in the same pass. */
  private kick(slot: ReplayPlayer): void {
    slot.spawnQueued = false;
    slot.leaveQueued = true;
  }

  /** *leave*: `onPlayerLeave` (if the join ran), the entity destroyed if alive, the slot freed. */
  private runLeave(slot: ReplayPlayer): void {
    const { session, hooks } = this;
    if (slot.joinRan) {
      this.callHook('onPlayerLeave', () =>
        hooks.onPlayerLeave?.(this.info(slot, true), session.ctx),
      );
    }
    slot.leaveQueued = false;
    if (slot.entity !== ENTITY_NONE && session.world.alive(slot.entity)) {
      session.world.destroy(slot.entity);
    }
    if (this.slots[slot.playerId] === slot) {
      this.slots[slot.playerId] = null;
      session.simulation.inputFrames[slot.playerId] = undefined;
      this.held[slot.playerId] = undefined;
    }
  }

  /** Entities of players that have one alive: `regions.update` keeps their regions wanted. */
  private playerEntities(): EntityId[] {
    const out: EntityId[] = [];
    for (const slot of this.slots) {
      if (slot !== null && slot.entity !== ENTITY_NONE && this.session.world.alive(slot.entity)) {
        out.push(slot.entity);
      }
    }
    return out;
  }

  /** The planned regions of players whose join ran and who have not spawned. */
  private spawnRegions(): RegionId[] {
    const out: RegionId[] = [];
    for (const slot of this.slots) {
      if (slot !== null && slot.plan !== null && !slot.playing) out.push(slot.plan.regionId);
    }
    return out;
  }
}

/**
 * The stack a session runs a game on, without networking, as a `ReplayRun` (docs/game.md 2,
 * docs/sim.md 2.11): a Session with no loop and no links whose ticks the run drives from a log.
 * Resolves once the session loaded (`onLoad` or `onInit`, as a live session). Throws `TypeError`
 * without `regionLoader.populate` or `hooks.onPlayerJoin`, `RangeError` for a bad `seed`,
 * `tickRate` or `maxPlayers`.
 *
 * Replay a recorded log with
 * `replay({ createRun: (seed, tickRate) => createReplayRun(game, { regionLoader, hooks, seed, tickRate }) }, log, checkpoints)`,
 * building the loader and hooks afresh for each run.
 */
export async function createReplayRun<I extends InputFrame>(
  game: Game<I>,
  opts: ReplayRunOpts<I>,
): Promise<GameReplayRun> {
  if (typeof opts?.regionLoader?.populate !== 'function') {
    throw new TypeError('createReplayRun: regionLoader.populate is required');
  }
  const seed = opts.seed ?? game.seed;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError(`createReplayRun: seed must be a u32, got ${seed}`);
  }
  const tickRate = opts.tickRate ?? game.tickRate;
  if (!Number.isInteger(tickRate) || tickRate < 1 || tickRate > 255) {
    throw new RangeError(`createReplayRun: tickRate must be an integer in 1..255, got ${tickRate}`);
  }
  const maxPlayers = opts.maxPlayers ?? MAX_PLAYERS;
  if (!Number.isInteger(maxPlayers) || maxPlayers < 1 || maxPlayers > MAX_PLAYERS) {
    throw new RangeError(
      `createReplayRun: maxPlayers must be an integer in 1..${MAX_PLAYERS}, got ${maxPlayers}`,
    );
  }
  const def: SessionGameDef = {
    id: game.id,
    compatibility: game.compatibility,
    protocolVersion: game.protocolVersion,
    tickRate,
    snapshotEvery: game.snapshotEvery,
    seed,
    registry: game.registry,
    input: game.input,
    systems: game.systems,
    components: game.components,
    world: (worldSeed) => game.world(worldSeed),
  };
  const run = new Replay(game, def, opts, opts.log ?? consoleServerLog);
  await run.session.start();
  return run;
}

/** Game adapters receive a replay-only sink; these observations never grant achievements or write accounts. */
export interface ReplayEffectSink {
  emit(kind: string, payload: unknown): void;
}
export interface JournalReplayRunOpts<I extends InputFrame = InputFrame> {
  regionLoader: RegionLoader;
  /** Build fresh replay-safe hooks. External services must be replaced by recorded-result adapters. */
  hooks(effects: ReplayEffectSink): ServerHooks<I>;
  simulationMessages?: readonly MessageDef[] | undefined;
  externalCommands?: readonly ExternalCommand[] | undefined;
  stateSerializers?: readonly StateSerializer[] | undefined;
  spawnPlanSerializer?: SpawnPlanSerializer | undefined;
  maxPlayers?: number | undefined;
  log?: ServerLog | undefined;
}
export interface GameJournalReplayRun extends JournalReplayRun {
  readonly session: Session;
  readonly effects: readonly { readonly kind: string; readonly payload: unknown }[];
  checkpoint(): ExactSessionCheckpoint;
}

/** V2 uses the authoritative Session pipeline with detached logical players and recorded load decisions. */
export async function createJournalReplayRun<I extends InputFrame>(
  game: Game<I>,
  journal: CommandJournal,
  options: JournalReplayRunOpts<I>,
): Promise<GameJournalReplayRun> {
  const observedEffects: Array<{ kind: string; payload: unknown }> = [];
  validateCommandJournal(journal, game.compatibility);
  if (options.maxPlayers !== undefined && options.maxPlayers !== journal.capacity)
    throw new TypeError('Replay configured capacity differs from recording');
  if (journal.stateSchemaHash !== game.registry.stateSchemaHash)
    throw new TypeError('Replay state schema hash mismatch');
  let disposed = false;
  const effects: ReplayEffectSink = {
    emit(kind, payload) {
      if (observedEffects.length >= 4096)
        throw new RangeError('Replay effect sink budget exceeded');
      observedEffects.push({ kind, payload: cloneExactState(payload) });
    },
  };
  const log = options.log ?? consoleServerLog;
  const replayHooks = options.hooks(effects);
  for (const definition of options.simulationMessages ?? [])
    if (typeof replayHooks.onMessage?.[definition.name] !== 'function')
      throw new TypeError(`Simulation command ${definition.name} has no replay handler`);
  const session = new Session(
    {
      id: game.id,
      compatibility: game.compatibility,
      protocolVersion: game.protocolVersion,
      tickRate: journal.tickRate,
      snapshotEvery: game.snapshotEvery,
      seed: journal.seed,
      registry: game.registry,
      input: game.input,
      systems: game.systems,
      components: game.components,
      world: (seed) => game.world(seed),
    },
    {
      store: new MemoryStore(),
      regionLoader: options.regionLoader,
      hooks: adaptHooks(replayHooks, game, log),
      manualLoop: true,
      replayExternal: true,
      sessionEpoch: journal.sessionEpoch,
      maxPlayers: journal.capacity,
      simulationMessages: options.simulationMessages,
      externalCommands: options.externalCommands,
      stateSerializers: options.stateSerializers,
      spawnPlanSerializer: options.spawnPlanSerializer,
      log,
    },
  );
  await session.start();
  const active = (): void => {
    if (disposed) throw new Error('Replay run disposed');
  };
  return {
    session,
    stateSchemaHash: game.registry.stateSchemaHash,
    capacity: session.capacity,
    get tick() {
      return session.tick;
    },
    compatibility: session.compatibility,
    effects: observedEffects,
    apply(action) {
      active();
      session.applyRecordedAction(action);
    },
    async step(tick) {
      active();
      if (tick !== session.tick + 1) throw new TickOrder(session.tick + 1, tick);
      session.step();
      if (session.fault !== null) throw session.fault;
    },
    skip(count) {
      active();
      session.skip(count);
    },
    capture() {
      active();
      return executionStateOfCheckpoint(session.captureCheckpoint());
    },
    checkpoint() {
      active();
      return session.captureCheckpoint();
    },
    restore(state) {
      active();
      session.restoreCheckpoint(state as ExactSessionCheckpoint);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      session.disposeReplay();
    },
  };
}
