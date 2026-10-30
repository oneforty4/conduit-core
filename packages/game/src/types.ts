import type { ReplicationGroup } from '@conduit/net-server';
import type { ReplicatedEvent } from '@conduit/sim';
import type { CompatibilityDeclaration, CompatibilityDescriptor } from '@conduit/protocol';
// Type-only module: shared by the browser entries (index.ts, client.ts) and the Node entries, so it
// must never gain a runtime import (docs/game.md 5).
import type { Manifest } from '@conduit/assets';
import type { KickReason, MessageDef, Schema, SchemaRegistry } from '@conduit/protocol';
import type {
  ComponentType,
  DeepReadonly,
  CommandActor,
  EntityId,
  EventType,
  InputFrame,
  Simulation,
  System,
} from '@conduit/sim';
import type {
  RegionId,
  RegionLoader,
  RegionManager,
  WorldGraph,
  WorldGraphJson,
} from '@conduit/world';
import type {
  HookContext,
  PlayerInfo,
  PlayerSpawn,
  SessionLog,
  SessionOptions,
  SessionSpatial,
} from '@conduit/net-server';

export type { HookContext, PlayerInfo, PlayerSpawn } from '@conduit/net-server';

/** What a game passes to `defineGame` (docs/game.md 1). */
export interface GameDefInput<I extends InputFrame = InputFrame> {
  /** `/^[a-z][a-z0-9-]{1,31}$/`. */
  id: string;
  name: string;
  /** u16, 1..65535; sent in Hello and checked by the Session (not the frame's WIRE_VERSION). */
  protocolVersion: number;
  /** Omission explicitly selects schema-only admission during migration. */
  compatibility?: CompatibilityDeclaration | undefined;
  /** Default 60; integer in [10, 240]. */
  tickRate?: number | undefined;
  /** Default 3; integer in [1, 255] (a u8 in Welcome). */
  snapshotEvery?: number | undefined;
  /** u32 world seed. */
  seed: number;
  /** Game components; the core components are merged in. */
  components: readonly ComponentType<unknown>[];
  /** `defineMessage` definitions. */
  messages: readonly MessageDef<unknown>[];
  /** `defineEvent` types; the core `RegionChanged` is merged in. */
  events: readonly EventType<unknown>[];
  /** `defineInput`: `tick: f.u32` must be the first field. */
  input: Schema<I>;
  /** Registered in this order (registration order matters within a phase). */
  systems: readonly System[];
  world: (seed: number) => WorldGraph;
  /**
   * The asset manifest (docs/assets.md 1), usually built by `conduit-assets build`; the client's
   * `AssetLoader` reads it (docs/game.md 4). Absent: no loader, models stay placeholders. A client
   * whose manifest is only known at runtime passes `CreateClientOpts.manifest` instead.
   */
  assets?: Manifest | undefined;
}

/** The frozen result of `defineGame`; satisfies net-server's `SessionGameDef` and net-client's `ClientGameDef`. */
export interface Game<I extends InputFrame = InputFrame> {
  readonly id: string;
  readonly name: string;
  readonly protocolVersion: number;
  readonly compatibility: CompatibilityDescriptor;
  readonly tickRate: number;
  readonly snapshotEvery: number;
  readonly seed: number;
  /** Core + game, sorted by name, registry IDs equal to list indices. */
  readonly components: readonly ComponentType<unknown>[];
  /** Sorted by name; kinds from 128 via `registry.messageKind(def)`. */
  readonly messages: readonly MessageDef<unknown>[];
  /** Core + game, sorted by name, registry IDs equal to list indices. */
  readonly events: readonly EventType<unknown>[];
  readonly input: Schema<I>;
  /** As given. */
  readonly systems: readonly System[];
  readonly registry: SchemaRegistry;
  /** u32 sent in Hello and checked by the Session (independent of `protocolVersion`). */
  readonly registryHash: number;
  /** `GameDefInput.assets` as given (not validated or copied); absent when not given. */
  readonly assets?: Manifest;
  world(seed: number): WorldGraph;
  /** `world(seed).toJson()`, cached per seed; `seed` defaults to `game.seed`. Do not mutate. */
  graphJson(seed?: number): WorldGraphJson;
  component(name: string): ComponentType<unknown> | undefined;
  message(name: string): MessageDef<unknown> | undefined;
  event(name: string): EventType<unknown> | undefined;
}

/** `(level, msg, data?)`: net-server's `SessionLog`; `data` is extra context or an error. */
export type ServerLog = SessionLog;

/**
 * What server hooks see (docs/game.md 2): an object whose prototype is the Session's `HookContext`
 * (so `tick`, `dt`, `rng`, `inputs`, ... stay live) plus these members delegating to the Session.
 */
export interface ServerContext<I extends InputFrame = InputFrame> extends HookContext {
  readonly game: Game<I>;
  /** `session.simulation`. */
  readonly sim: Simulation;
  /** `session.regions`; a typed superset of `ctx.regions`. */
  readonly regionManager: RegionManager;
  /** `session.spatial`: M1's `SessionSpatial` (queries find nothing); `SpatialIndex` from M3. */
  readonly spatialIndex: SessionSpatial;
  /** `session.players()`: ascending `playerId`, away players kept during the reconnect grace. */
  readonly players: readonly PlayerInfo[];
  /** The frame placed for `player` this tick (the game's input type). */
  inputs(player: number): DeepReadonly<I> | undefined;
  /** `session.send`: an s2c/both game message for `player`'s next frame. */
  send(player: number, type: MessageDef<unknown>, msg: unknown): void;
  /** `session.broadcast`. */
  broadcast(type: MessageDef<unknown>, msg: unknown): void;
  /** Schema-validated recorded external decision, applied at a future tick boundary. */
  enqueueExternalCommand(
    name: string,
    payload: unknown,
    options?: { tick?: number; actor?: CommandActor | null },
  ): void;
  /** `session.kick`. */
  kick(player: number, reason: KickReason): void;
  log(level: 'info' | 'warn' | 'error', msg: string, data?: unknown): void;
}

/**
 * A game's server hooks (docs/game.md 2): net-server's `SessionHooks` with a `ServerContext`, JSON
 * save/load and a per-message `onMessage` map.
 */
export interface ServerHooks<I extends InputFrame = InputFrame> {
  /** Fresh session: no saved state. */
  onInit?(ctx: ServerContext<I>): void;
  /** The session blob existed; `saved` is what `onSave` returned (JSON round-tripped). */
  onLoad?(ctx: ServerContext<I>, saved: unknown): void;
  /** JSON-serializable; stored in BlobStore namespace 'session', key 'state'. */
  onSave?(ctx: ServerContext<I>): unknown;
  /**
   * Choose the spawn region now; `spawn(ctx)` is called once that region is active (docs/net.md
   * A.6) and receives this `ServerContext`.
   */
  onPlayerJoin(player: PlayerInfo, ctx: ServerContext<I>): PlayerSpawn;
  /** `player.entity` is still alive; core destroys it after the hook returns. */
  onPlayerLeave?(player: PlayerInfo, ctx: ServerContext<I>): void;
  onWorldEdge?(entity: EntityId, ctx: ServerContext<I>): void;
  /** Entities it rejects are not replicated to `player`. */
  relevance?(player: PlayerInfo, entity: EntityId, ctx: ServerContext<I>): boolean;
  /**
   * Replicated components of `entity` not sent to `player`: net-server's
   * `SessionHooks.withheldComponents` (docs/net.md A.8.4). Return frozen arrays.
   */
  withheldComponents?(
    player: PlayerInfo,
    entity: EntityId,
    ctx: ServerContext<I>,
  ): readonly ComponentType<unknown>[] | undefined;
  replicationGroups?(player: PlayerInfo, ctx: ServerContext<I>): readonly ReplicationGroup[];
  replicationPriority?(player: PlayerInfo, group: ReplicationGroup, ctx: ServerContext<I>): number;
  eventDependencies?(
    player: PlayerInfo,
    event: Readonly<ReplicatedEvent>,
    ctx: ServerContext<I>,
  ): readonly EntityId[];
  /** Keyed by message name; c2s/both messages without a handler are ignored and counted. */
  onMessage?: Record<string, (player: PlayerInfo, msg: unknown, ctx: ServerContext<I>) => void>;
  /**
   * Regions the game needs simulated independent of players and pending spawns: net-server's
   * `SessionHooks.simulationInterest` (docs/net.md A.5). Once per tick, right before
   * `regions.update`, which keeps exactly these regions wanted. A deterministic function of
   * simulation state that does not change it; at most `maxSimulationInterestRegions` distinct ids
   * of the world graph, else the session faults. Never grants visibility or permissions.
   */
  simulationInterest?(ctx: ServerContext<I>): readonly RegionId[];
}

/** What a game module's session factory builds per session (docs/game.md 3). */
export interface SessionFactoryResult<I extends InputFrame = InputFrame> extends Pick<
  SessionOptions,
  | 'saveSchema'
  | 'saveLimits'
  | 'saveCompatibilityAdapter'
  | 'saveRegistryAdapter'
  | 'diagnostics'
  | 'replication'
  | 'snapshotLimits'
  | 'maxPlayers'
  | 'maxSimulationInterestRegions'
> {
  regionLoader: RegionLoader;
  hooks: ServerHooks<I>;
}

/**
 * docs/host.md 19's `SessionFactory`: the export a host worker calls with the session id and its
 * log (the host's logger, through the worker's port). Hooks are already adapted to net-server's
 * `SessionHooks`.
 */
export type SessionFactory = (
  sessionId: string,
  opts?: { log?: ServerLog | undefined; maxPlayers?: number },
) => Pick<
  SessionOptions,
  | 'regionLoader'
  | 'hooks'
  | 'saveSchema'
  | 'saveLimits'
  | 'saveCompatibilityAdapter'
  | 'saveRegistryAdapter'
  | 'diagnostics'
  | 'replication'
  | 'snapshotLimits'
  | 'maxPlayers'
  | 'maxSimulationInterestRegions'
>;

/** One game served by `createHost` (M5): `module` exports `game` and `sessionFactory`. */
export interface HostGameEntry {
  game: Game;
  module: string | URL;
}
