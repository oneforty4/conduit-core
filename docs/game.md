# @conduit/game

`createServer` and `defineSessionFactory` support `saveSchema`, `saveLimits` and `saveCompatibilityAdapter`. `openApplicationSave` is re-exported by `game/server`; physical legacy keys remain preserved originals. See [generation saves](generation-saves.md).

Implementation specification for the game facade: `defineGame`, `createServer` (`./server`),
`createHost` (`./host`), `createClient` (`./client`). The root entry depends on `protocol`, `sim`,
`world`, `assets` only. `./server` adds `net-server`, `persist` and `auth`; `./host` adds `host`;
`./client` adds `net-client`, `lobby-client`, and `render` through a dynamic import.

Referenced specs: schema DSL, registry and message definitions in `docs/protocol.md`; `Session`,
`SessionHooks`, `HookContext`, `ClientLink`, `WsLink`, `NetClient`, `ReplicaWorld`, `NetClock`,
`RegionClient` and the handshake messages in `docs/net.md`; `BlobStore`/`MemoryStore` in
`docs/persist.md` Part 1 and `TokenVerifier`/`devVerifier`/`hmacVerifier` in `docs/persist.md` 2.4;
host process and `registerGame` in `docs/host.md`; `Manifest`/`AssetLoader` in `docs/assets.md`; `RenderHost`, `RenderWorld`,
binders and cameras in `docs/render.md`; ECS in `docs/sim.md`; regions in `docs/world.md`.

---

## 1. `defineGame`

```ts
export interface GameDefInput<I extends InputFrame = InputFrame> {
  id: string;                          // /^[a-z][a-z0-9-]{1,31}$/
  name: string;
  compatibility?: { simulationRevision: string; gameplayDigests: Readonly<Record<string, string>> };
  protocolVersion: number;             // u16, 1..65535; sent in Hello and checked by the Session (docs/protocol.md 9.1); the frame header carries WIRE_VERSION, not this
  tickRate?: number;                   // default 60; integer in [10, 240]
  snapshotEvery?: number;              // default 3; integer in [1, 255] (a u8 in Welcome)
  seed: number;                        // u32; world seed
  components: readonly ComponentType<unknown>[];   // the four lists accept readonly arrays (e.g. CORE_COMPONENTS)
  messages: readonly MessageDef<unknown>[];     // defineMessage (docs/protocol.md)
  events: readonly EventType<unknown>[];        // defineEvent (docs/sim.md 2.8)
  input: Schema<I>;                    // defineInput (docs/protocol.md §10): `tick: f.u32` must be the FIRST field
  systems: readonly System[];
  world: (seed: number) => WorldGraph;
  assets?: Manifest;                   // docs/assets.md 1; from M2. Kept as given (not validated, not in registryHash); read by createClient (section 4)
}

export interface Game<I extends InputFrame = InputFrame> {
  readonly id: string; readonly name: string; readonly protocolVersion: number;
  readonly tickRate: number; readonly snapshotEvery: number; readonly seed: number;
  readonly components: readonly ComponentType<unknown>[];   // core + game, sorted by name; IDs belong to registry
  readonly messages: readonly MessageDef<unknown>[];        // sorted by name; kinds from 128 via registry.messageKind(def)
  readonly events: readonly EventType<unknown>[];           // core + game, sorted by name; IDs belong to registry
  readonly input: Schema<I>;
  readonly systems: readonly System[];                      // as given (registration order matters)
  readonly registry: SchemaRegistry;                        // docs/protocol.md
  readonly registryHash: number;                            // u32 sent in Hello, checked by the Session (independent of protocolVersion)
  readonly assets?: Manifest;
  world(seed: number): WorldGraph;
  graphJson(seed?: number): WorldGraphJson;                 // cached per seed; default game.seed
  component(name: string): ComponentType<unknown> | undefined;
  message(name: string): MessageDef<unknown> | undefined;
  event(name: string): EventType<unknown> | undefined;
}

export function defineGame<I extends InputFrame>(def: GameDefInput<I>): Game<I>;
export class GameDefError extends Error { readonly code: GameDefErrorCode; constructor(code: GameDefErrorCode, detail: string) }   // message = `${code}: ${detail}`
```

Algorithm:

```
defineGame(def):
  validate scalar fields (id pattern, protocolVersion 1..65535, tickRate 10..240, snapshotEvery 1..255, seed is u32)
  components = dedupeByIdentity([...CORE_COMPONENTS, ...def.components])
  events     = dedupeByIdentity([RegionChanged, ...def.events])
  messages   = [...def.messages]
  check duplicates by name in each list          -> 'duplicateComponent' | 'duplicateEvent' | 'duplicateMessage' | 'duplicateSystem'
  if components.length > 255                     -> 'tooManyComponents'
  if def.input.fieldNames[0] !== 'tick' or def.input.fields.tick.kind !== 'u32'   -> 'inputLacksTick'   (same rule as defineInput, docs/protocol.md §10; re-checked here for schemas built without it)
  for c of components: every c.interpolate name must be a field of c of kind vec2 | vec3 | quat | angle16 | f32 | fixed16 | fixed32 (docs/sim.md 2.4), and c.extrapolateWith (if set) a vec2/vec3 field of the same kind as the first vec field in c.interpolate   -> 'badInterpolate' | 'badExtrapolate'
  registry = new SchemaRegistry({ components, messages, events, input })   // docs/protocol.md §7; sorts by name and assigns ids/kinds; its RangeErrors (> 128 messages, > 256 events) propagate
  sort components and events by name (stringCompare); IDs come from registry.componentId(c) and registry.eventId(ev); definitions are never mutated
  registryHash = registry.hash
  return frozen Game                             // assets set only when def.assets is defined
```

`GameDefErrorCode` = `'badId' | 'badProtocolVersion' | 'badTickRate' | 'badSnapshotEvery' | 'badSeed' | 'duplicateComponent' | 'duplicateEvent' | 'duplicateMessage' | 'duplicateSystem' | 'tooManyComponents' | 'inputLacksTick' | 'badInterpolate' | 'badExtrapolate'`.
Messages are `` `${code}: ${detail}` `` (for example `duplicateComponent: "Health" defined twice`).

Registry IDs follow sorted names, so server and client agree regardless of import order.
Component and event definitions are immutable and have no `.id` field. This is an intentional
TypeScript API break: replace `component.id` with `game.registry.componentId(component)` and
`event.id` with `game.registry.eventId(event)`. Worlds, event buses and replicas resolve through
their own registry, so games with different sorted indices may share core or game definitions.
IDs remain wire/storage indices, never persistent domain identity; saves retain component names.

Separate module copies are accepted when their schema descriptors and relevant metadata agree.
Component resolution checks replication, persistence, interpolation and extrapolation as well as
schema; event resolution checks schema and replication. Conflicts throw before access. Immutable
definitions are cached per registry. Factory metadata is copied, including field declarations and
interpolation arrays; caller objects are not frozen. Custom mutable schema metadata is rejected
(use `defineSchema`). Registry hash and sorted-name wire assignments remain unchanged for unchanged
schemas; persistence/presentation metadata is validated for object resolution but is not added to
the wire hash.

### Simulation compatibility declarations

Pass `compatibility: { simulationRevision: 'rules-2026-10', gameplayDigests: { collision:
collisionDigest, compactIds: idDigest } }` to defineGame. The resulting `game.compatibility` is a
bounded immutable descriptor; the session pins its own copy and checks it before allocating
players or rebinding reconnects. A changed table/revision is rejected with named differences
and an update/rejoin instruction. Optional assets/presentation versions do not enter this check.
Omitting the declaration explicitly chooses **schema-only migration mode**, which checks no
simulation revision or gameplay data and cannot join declared sessions. No revision is inferred
from browser bundles, file paths or systems' function text.

`canonicalGameplayData` and async `hashGameplayData` from `@conduit/protocol` support build-time
SHA-256 identifiers. Plain-object keys are sorted, array order matters, signed zero is preserved;
nonfinite numbers, undefined, sparse arrays, extra array properties, accessors, cycles, symbols,
functions and nonplain objects are rejected. Prepare digests before defineGame/admission;
network admission only compares bounded strings synchronously. Descriptor equality is a
compatibility declaration, not proof of trusted execution. `Session.compatibility`, Welcome's
compatibility field and readonly `NetClient.compatibility` expose the accepted declaration.

## 2. `createServer` (`@conduit/game/server`)

Single-session mode for dev and tests: one `ws` server, one `Session`, no lobby; token verification through a `TokenVerifier` (`docs/persist.md` 2.4).

The hook names, argument order and the `PlayerSpawn` protocol are `docs/net.md` A.5's `SessionHooks`, so a game's hooks can be handed to a `Session` in both deployments; `ServerHooks` only narrows the context type and offers JSON convenience for save/load and a per-message map for `onMessage`. `PlayerInfo` and `PlayerSpawn` are re-exported from `@conduit/net-server`.

```ts
export interface ServerHooks<I extends InputFrame = InputFrame> {
  onInit?(ctx: ServerContext<I>): void;                                   // fresh session, no saved state
  onLoad?(ctx: ServerContext<I>, saved: unknown): void;                   // session blob existed; `saved` is what onSave returned (JSON-decoded)
  onSave?(ctx: ServerContext<I>): unknown;                                // JSON-serializable; stored in BlobStore ns 'session' key 'state' (`undefined` is stored as `null`)
  onPlayerJoin(player: PlayerInfo, ctx: ServerContext<I>): PlayerSpawn;   // choose the spawn region now; `spawn(ctx)` is called once that region is active (docs/net.md A.6) and receives the ServerContext
  onPlayerLeave?(player: PlayerInfo, ctx: ServerContext<I>): void;        // `player.entity` still alive; core destroys it after the hook returns
  onWorldEdge?(entity: EntityId, ctx: ServerContext<I>): void;
  relevance?(player: PlayerInfo, entity: EntityId, ctx: ServerContext<I>): boolean;
  withheldComponents?(player: PlayerInfo, entity: EntityId, ctx: ServerContext<I>): readonly ComponentType<unknown>[] | undefined;   // replicated components of entity not sent to player, e.g. owner-only prediction state (docs/net.md A.8.4); return frozen arrays
  onMessage?: Record<string, (player: PlayerInfo, msg: unknown, ctx: ServerContext<I>) => void>;   // keyed by message name; adapted to SessionHooks.onMessage by def.name
  simulationInterest?(ctx: ServerContext<I>): readonly RegionId[];        // regions to keep simulated independent of players and pending spawns, wanted exactly (no neighbourhood); once per tick right before regions.update; deterministic, not journaled; an invalid result faults the session (docs/net.md A.5); absent: none, behaviour unchanged
}

export type { PlayerInfo, PlayerSpawn } from '@conduit/net-server';       // { playerId, accountId, displayName, state, entity } / { regionId, spawn(ctx) }

export interface ServerContext<I extends InputFrame = InputFrame> extends HookContext {   // HookContext = SimContext + session (docs/net.md A.5)
  readonly game: Game<I>;
  readonly sim: Simulation;                         // session.simulation
  readonly regionManager: RegionManager;            // session.regions; typed superset of ctx.regions
  readonly spatialIndex: SpatialIndex;              // session.spatial; typed SessionSpatial (queries find nothing) until SpatialIndex lands in M3
  readonly players: readonly PlayerInfo[];          // session.players(); ascending by playerId; away players kept during the reconnect grace
  inputs(player: number): I | undefined;            // HookContext.inputs narrowed to the game's input type
  send(player: number, type: MessageDef<unknown>, msg: unknown): void;    // session.send
  broadcast(type: MessageDef<unknown>, msg: unknown): void;               // session.broadcast
  kick(player: number, reason: KickReason): void;                         // session.kick
  log(level: 'info' | 'warn' | 'error', msg: string, data?: unknown): void;   // = net-server's SessionLog (exported as ServerLog); data is extra context or an error
}

export interface CreateServerOpts<I extends InputFrame = InputFrame> {   // optional fields also accept `undefined` (as SessionOptions, docs/net.md A.5); so do CreateClientOpts' and GameDefInput's tickRate/snapshotEvery
  port?: number;                         // default 0 (ephemeral); integer 0..65535 (RangeError); the resolved port is returned
  host?: string;                         // default '127.0.0.1'
  compression?: boolean | WsCompressionOptions;   // permessage-deflate on the game sockets, createWsServer's option (docs/net.md A.2): true for DEFAULT_WS_COMPRESSION (level 3, memLevel 8, windowBits 15); default false
  store?: BlobStore;                     // default new MemoryStore(); e.g. new SqliteStore(path) (M4). The server owns it: close(), and a failed start, close it when it has a close() method
  autosaveIntervalMs?: number;           // (M4) period of the Autosaver (docs/persist.md 1.8); default AUTOSAVE_INTERVAL_MS (60 000); outside (0, 2^31 - 1] the Autosaver's RangeError
  regionLoader: RegionLoader;
  hooks: ServerHooks<I>;
  devAuth?: boolean;                     // true: devVerifier() (any token accepted, warning logged once); default false
  secret?: string;                       // required unless devAuth; hmacVerifier(secret) (docs/persist.md 2.4)
  maxPlayers?: number;                   // default 8
  maxSimulationInterestRegions?: number; // SessionOptions (docs/net.md A.5): most distinct regions simulationInterest may name per tick; default 64
  reconnectGraceMs?: number;             // default 120000 (docs/net.md)
  log?: ServerLog;                       // default console-backed; also given to the Session, its WsLinks and every ServerContext
}

export interface GameServer { readonly port: number; readonly session: Session; readonly url: string; close(): Promise<void> }   // url: `ws://host:port` ([host] for IPv6); close() rejects when the shutdown save or closing the store failed
export function createServer<I extends InputFrame>(game: Game<I>, opts: CreateServerOpts<I>): Promise<GameServer>;
```

```
createServer(game, opts):             // everything before the first await throws synchronously (option errors)
  if port is not an integer in 0..65535: throw RangeError
  if !opts.devAuth and !opts.secret: throw Error('createServer: pass secret or devAuth: true')
  verifier = opts.devAuth ? devVerifier({ warn: msg => log('warn', msg) }) : hmacVerifier(opts.secret)   // docs/persist.md 2.4; a weak secret throws AuthError
  store = opts.store ?? new MemoryStore()
  session = new Session(game, { store, regionLoader, hooks: adaptHooks(hooks, game, log), verifier, sessionId: 'dev',
                                maxPlayers, reconnectGraceMs, log,     // docs/net.md A.5; sessionId 'dev' matches devVerifier's identities
                                autosaver: save => new Autosaver(save, opts.autosaveIntervalMs ?? AUTOSAVE_INTERVAL_MS,
                                                                 { onError: err => log('error', 'saving the session failed', err) }) })
                                        // the Session constructor calls the factory, so a bad interval throws here; save = session.flushAll
  await session.start()                 // builds World, Simulation, RegionManager, SpatialIndex, InterestPolicy; loads 'session'/'state'; calls onLoad or onInit; starts sim's FixedLoop, then autosaver.start()
                                        // on a start error: close the store, reject
  wss = createWsServer({ host, port, compression })  // docs/net.md A.2
  wss.on('connection', socket => session.attach(new WsLink(socket, nextLinkId++, { log })))   // no identity: the Session verifies Hello.sessionToken through `verifier`
  await listening                       // on a listen error: wss.close(), await session.stop() (which saves), close the store, reject with the listen error
  return { port: wss.address().port, session, url: `ws://${host}:${port}`, close }

close():                                // idempotent (returns the same promise)
  wss.close()                           // stop accepting; its callback fires once every socket has closed
  await session.stop()                  // stops the loop, Kicked{ServerShutdown} + close(1001) on every link, then autosaver.stop(): its final save
                                        //   (coalesced with a periodic save in flight) is session.flushAll = regions.flushAll() then onSave -> store.put('session', 'state', ...)
  await the wss close callback
  store.close?.()                       // last, so no save can reach a closed store; every step runs even when an earlier one failed,
                                        //   and close() rejects with the first failure (later ones are logged)
```

So the shutdown order is stop loop → kick clients → `regions.flushAll` → `onSave` → `store.close`, with exactly one shutdown
save: `createServer` never saves on its own; the Session's `stop()` performs the autosaver's final save, which is also the
save `flushAll` would have done without an autosaver (docs/net.md A.5). While the session runs, the `Autosaver` saves every
`autosaveIntervalMs`, so a crash loses at most that much play. A store passed in belongs to the server from then on: pass
a new `SqliteStore` to each `createServer`, even on the same file (the file keeps the state; `test/server.test.ts` restarts
on it). A `MemoryStore` has nothing to close and can be handed to the next server as it is.

**Dev auth.** With `devAuth: true` (never the default), `devVerifier` accepts any `Hello.sessionToken`,
including `DEV_TOKEN = 'dev'` and `''`, and derives the identity from `Hello.displayName`:
`{ accountId: 'dev:' + name.toLowerCase(), displayName: name, sessionId: 'dev', exp: now + 600 }`
(`docs/persist.md` 2.4; `Hello` carries `displayName: str(32)` for this purpose, `docs/protocol.md`).
`DEV_AUTH_WARNING` is logged once at construction. Two connections with the same display name are
therefore the same account: the second is treated by the reconnect rule in `docs/net.md` A.6 (with a
matching `reconnectToken` it takes over the slot; otherwise it is a fresh join with a second player
slot only if `accountId` differs). With a `secret`, tokens must be minted by `mintToken` with
`sessionId: 'dev'`.

**Hook adaptation (`adaptHooks`, `src/serverContext.ts`).** The `Session` calls hooks with a
`HookContext` (`docs/net.md` A.5). `adaptHooks(hooks, game, log = consoleServerLog)` returns
`AdaptedHooks` (`SessionHooks` plus a read-only `unhandledMessages` counter) whose entries
call the game's hooks with a `ServerContext` built lazily on the first call by `buildServerContext(ctx, game, log)`:
an object whose prototype is the `HookContext` (so `tick`, `dt`, `rng`, `inputs`, … stay live) plus the members
listed above delegating to `ctx.session`. Hooks the game leaves out stay unset (so the Session skips
`relevance` entirely, and without `simulationInterest` keeps no interest regions); a missing `onPlayerJoin` throws `TypeError`. `PlayerSpawn.spawn` is wrapped to
receive the `ServerContext` too. `onSave`/`onLoad` are wrapped with `JSON.stringify` +
`TextEncoder` / `TextDecoder` + `JSON.parse`. `onMessage` is dispatched by `def.name` (own properties
of the map only); unknown names are ignored and counted. The same adapter is used by `defineSessionFactory` (section 3), so hooks
behave identically under `createHost`. `onMessage` handlers run before the tick's systems (pipeline
step 3 in `docs/net.md` A.5), in arrival order.

**Replay (M6).** `createReplayRun` builds the stack a session runs the game on, without networking, as a
`ReplayRun` (`docs/sim.md` 2.11) that replays a log recorded by a live Session (`SessionOptions.recordLog`,
`docs/net.md` A.5) or written by hand:

```ts
export interface ReplayRunOpts<I extends InputFrame = InputFrame> {   // optional fields also accept `undefined`
  regionLoader: RegionLoader;
  hooks: ServerHooks<I>;                 // adapted by adaptHooks, as createServer does; ctx.players lists the replayed players
  store?: BlobStore;                     // default new MemoryStore(); must hold what the recorded session's store held when it started
  seed?: number;                         // u32; default game.seed
  tickRate?: number;                     // integer in 1..255; default game.tickRate
  maxPlayers?: number;                   // 1..8; default 8
  maxSimulationInterestRegions?: number; // the recorded session's SessionOptions value (docs/net.md A.5); default 64
  log?: ServerLog;                       // default consoleServerLog: stage failures, hook throws and ServerContext.log
}
export interface GameReplayRun extends ReplayRun {
  readonly session: Session;             // the stack: world, graph, regions, spatial, simulation, stats.tickErrors; no loop, no links
  lifecycle(player: number, event: LifecycleEvent): void;
  skip(count: number): void;             // the ticks the recorded session's loop dropped: simulation.skip(count)
}
export function createReplayRun<I extends InputFrame>(game: Game<I>, opts: ReplayRunOpts<I>): Promise<GameReplayRun>;
```

```
createReplayRun(game, opts):            // TypeError without regionLoader.populate or hooks.onPlayerJoin; RangeError for seed, tickRate, maxPlayers
  session = new Session({ ...game, seed, tickRate }, { store, regionLoader, hooks: adaptHooks(hooks, game, log), maxPlayers, maxSimulationInterestRegions, log, manualLoop: true })
            // a subclass whose players() lists the run's players, ascending playerId, leaving ones omitted:
            // state Joined, Ready while a spawn waits for its region, Playing once spawned
  await session.start()                 // onLoad or onInit, as a live session
  return run

run.lifecycle(p, event):                // for the next step; RangeError for a join of a player still in, a spawn of one not in or already spawned, an unknown event
  join:  a player { accountId, displayName } with its join queued
  spawn: its spawn queued (ready)
  leave: its leave queued; a spawn queued at an earlier step and still waiting is cancelled, a join or spawn of this step still runs
         (the Session records a leave after the join or spawn that caused it); a player not in the session: nothing
run.setInput(p, frame): held[p] = a copy of frame, undefined for null   // RangeError for p outside 0..maxPlayers-1
run.skip(count): session.simulation.skip(count)    // Error while the previous step is still pending

run.step(t):                            // TickOrder unless t === world.tick + 1; Error while the previous step is still pending
  1. lifecycle, as the Session's (docs/net.md A.6), each hook guarded (logged `hook <name> threw`, counted in stats.tickErrors):
       joins in playerId order: plan = onPlayerJoin(player, ctx); a throw, or a plan whose region the graph lacks: the player leaves
       spawns in playerId order, once the plan's region is active: entity = plan.spawn(ctx), alive and in an active region, else the player leaves
       leaves in playerId order: onPlayerLeave (if its join ran), destroy the entity if alive, free the slot and its frame
  2. simulation.inputFrames[p] = held[p] for every player
  3. interest = the Session's simulationInterest(): hooks.simulationInterest(ctx), validated, deduplicated and sorted as live (docs/net.md A.5); [] without the hook
     regions.update(entities of players that have one alive, ctx, planned regions of players not yet spawned, interest)
  4. simulation.step(t)
  5. simulation.events.drainOutbox()    // stages 1-5 guarded as the Session's runTick: `tick <t>: <stage> failed`, counted in stats.tickErrors
  6. await one macrotask turn (setImmediate)
run.hash(): session.world.hash()
```

The macrotask turn is what makes region loads land on the same tick as in the recorded session. A load
starts in step `t`'s `regions.update` and activates at the first `update` after its store answered;
a `MemoryStore` or `SqliteStore` answers within promise callbacks, which all run before the turn ends, so
the region activates in step `t + 1`, as under a live loop whose wakes each run one tick. A single
microtask hop is not enough for a store that answers after several promise hops.

A replayed session receives no game messages: `onMessage` handlers never run, so a game whose handlers
change the world does not replay from an input log. `simulationInterest` is not recorded: it is a
function of the replayed state, called at the same point as live, so interest-driven region loads
replay as player-driven ones do. `ctx.send`, `ctx.broadcast` and `ctx.kick` reach no
client, and what a kick caused is replayed from the recorded *leave*. `ctx.players` is exact except for
states the log does not carry: a replayed player is never `Away`, `Ready` only while its spawn waits,
and one leaving in a tick is omitted from the start of that tick's lifecycle.

## 3. `createHost` (`@conduit/game/host`)

Sessions run in worker threads that `import()` the game module themselves (`docs/host.md` §21),
so the main thread never receives a factory function; it receives the module's location. A game
module (the file `createHost` is pointed at) must export `game` (the `defineGame` result) and
`sessionFactory`, built with `defineSessionFactory` so its hooks get a `ServerContext`:

```ts
export interface SessionFactoryResult<I extends InputFrame = InputFrame> { regionLoader: RegionLoader; hooks: ServerHooks<I> }
export function defineSessionFactory<I extends InputFrame>(game: Game<I>, fn: (sessionId: string) => SessionFactoryResult<I>): SessionFactory;
  // SessionFactory from docs/host.md §19: (sessionId, opts?: { log?: ServerLog }) => { regionLoader, hooks: SessionHooks };
  // hooks are adaptHooks(fn(sessionId).hooks, game, opts?.log). The worker passes its log (the host's logger through the port,
  // lines prefixed `[session <id>]`), so ServerContext.log reaches the host's logger; without one it is consoleServerLog
  // (declared structurally in src/types.ts, since @conduit/host only exists from M5; exported from ./server in M1)

export interface HostGameEntry { game: Game; module: string | URL }   // module: importable file URL of the module exporting `game` and `sessionFactory`
export interface CreateHostOpts {
  port: number;
  dbPath: string;
  secret: string;                            // HMAC secret for SessionToken (docs/host.md §16 HOST_SECRET)
  static?: string;                           // directory served at '/' after the lobby routes
  workerEntry?: string | URL;                // the session worker entry (docs/host.md §19). Default @conduit/host's src/worker.ts, found next to the
                                             // module that spawns workers, which a bundle inlines: a bundle sets its @conduit/host/worker output
  workerExecArgv?: string[];                 // the workers' execArgv; default process.execArgv. [] when the host runs with a flag a worker
                                             // rejects (--max-old-space-size: ERR_WORKER_INVALID_EXEC_ARGV, every start fails)
  log?: ServerContext['log'];                // the host's lines, the session workers' included (prefixed `[session <id>]`), at LOG_LEVEL and above;
                                             // debug lines arrive as 'info'. Default: the host's consoleLogger(LOG_LEVEL)
}
export interface GameHost { readonly port: number; readonly url: string; close(): Promise<void> }
export function createHost(games: readonly HostGameEntry[], opts: CreateHostOpts): Promise<GameHost>;
```

```
createHost(games, opts):                  // not async: option errors throw synchronously, as createServer's do
  if a game.id appears twice in games: throw Error('createHost: game <id> is listed twice')   // before anything is opened
  logger = opts.log && { debug → log('info'), info → log('info'), warn → log('warn'), error → log('error') }, each filtered by host.config.logLevel
  host = new Host({ port, dbPath, secret, staticDir: static, workerEntry, workerExecArgv, logger })   // docs/host.md §22; throws ConfigError (a weak secret, a bad port or static) or the store's error
  for { game, module } of games: host.registerGame(game, { module })
  { port, url } = await host.listen()     // a failure closes the host again, then rejects
  return frozen { port, url, close: () => host.close() }                 // close = flushAll every worker, stop all, close HTTP and the store; idempotent
```

`Host` itself is the authority for everything else (`docs/host.md` §22); `createHost` adds nothing
but the typed pairing of `Game` and module and the log adapter. A production bundle of the host
(`docs/consuming.md` §4) builds the main thread, `@conduit/host/worker` and the game module as
entries of one split build and passes its outputs: `workerEntry` the worker's, `module` the game
module's. Settings it has no option for (`IDLE_TIMEOUT_MS`, `LOG_LEVEL`, `PUBLIC_WS_BASE`,
`TRUST_PROXY`, and `STATIC_DIR` when `static` is not given) come from the environment
(`docs/host.md` §16). The worker constructs `Session` with the
factory's `regionLoader`/`hooks` and a `BlobStore` proxied to the main thread; identities come
verified from the gateway, so no `verifier` is involved. Everything in section 2 about `ServerContext`
and hooks applies unchanged, `ctx.log` included (it reaches `opts.log` through the worker); only
transport and auth differ.

## 4. `createClient` (`@conduit/game/client`)

```ts
export interface CreateClientOpts<I extends InputFrame = InputFrame> {
  url?: string;                              // direct ws URL (createServer mode); token defaults to opts.token ?? DEV_TOKEN ('dev', docs/persist.md 2.4)
  token?: string;                            // dev token or a real SessionToken string
  displayName?: string;                      // sent in Hello (devAuth identity)
  lobby?: Pick<LobbyClient, 'join'>;         // (M5) host mode: each connect() that opens a connection first calls lobby.join(sessionId) -> { token, wsUrl }
  sessionId?: string;                        //   and connects with those. lobby needs a non-empty sessionId and excludes url and token, and a sessionId
                                             //   needs a lobby (TypeError at construction). Without a lobby url is required (connect() rejects without it)
  canvas?: HTMLCanvasElement;                // present => rendering; absent => headless
  render?: Pick<RenderHostOptions, 'renderer' | 'antialias' | 'pixelRatioCap' | 'onFrameError' | 'gpuTiming'>;  // with a canvas: a game-supplied renderer (not disposed by the host), or how the host makes its own; onFrameError hears of a frame that threw
  binders?: Binder<unknown>[];               // docs/render.md; appended after the core binders (RegionBinder, TransformBinder, ModelBinder)
  manifest?: Manifest;                       // (M2) default game.assets; for a manifest known only at runtime (fetched), so the shared game definition needs no generated file
  assetBaseUrl?: string;                     // (M2) URL prefix for asset files, ending with '/'; default manifest.baseUrl (e.g. a CDN); anything else throws TypeError
  assetLoader?: AssetLoaderOptions;          // (M2) docs/assets.md 3.1: concurrency, unloadGraceMs, verifyHashes, fetch, injectable grace timers
  models?: GltfBackendOptions;               // with a canvas: render's GltfBackend options, e.g. a GLTFLoader with a KTX2Loader set (docs/render.md §5)
  camera?: CameraController;                 // default FollowCamera on localEntity
  input?: InputSource;                       // docs/render.md §6; passed to RenderWorld.setInput; default NULL_INPUT
  sampleInput: (ctx: InputContext<I>) => I;  // called once per fresh eligible input tick (docs/net.md B.6)
  onFrame?: (frame: FrameContext<I>) => void;
  onMessage?: Record<string, (msg: unknown, frame: FrameContext<I>) => void>;   // keyed by message name
  onRegion?: (ev: { type: 'loaded' | 'unloaded'; id: RegionId }) => void;   // RegionClient's regionLoaded/regionUnloaded (docs/net.md B.8)
  autoFrame?: boolean;                       // default true; false: nothing drives frames (with a canvas the RenderHost is not started either), call tickFrame
  prediction?: PredictionOptions;            // default off; enabled acknowledgement tracking plus an optional Predictor/PredictionDriver
  presentation?: PresentationProvider;       // shared region-local pose for model, camera and floating origin
  inputScheduling?: 'hybrid' | 'timer' | 'manual'; // default hybrid: frame pulse plus absolute timer fallback
  maxInputLeadTicks?: number;                 // default 32; integer 1..256
  maxSessionCapacity?: number;                // client admission/decode limit 1..16; default 16, not the server support limit
  snapshotLimits?: Partial<SnapshotLimits>;  // bounded transaction/assembly limits offered in Hello
  extrapolation?: { horizonMs: number; onLimit?: 'hold' | 'reset' }; // horizon 0..10000 ms
  batchSends?: boolean;                      // NetClient's (docs/net.md B.6): true, an Ack rides with the next Input; default false
  diagnostics?: DiagnosticOptions;           // optional isolated observer with an injected timing function
}

export interface InputContext<I> { tick: number /* selected target */; dt: number /* elapsed sample seconds, 0 first */; sampleTimeMs: number; localEntity: EntityId | undefined; replica: ReplicaWorld; previous: I | undefined /* copy of the last frame sent; undefined for a connection's first sample */ }   // one object reused per tick
export interface FrameContext<I> {
  renderTick: number;                        // fractional; from clock.renderTick()
  dt: number;                                // seconds since last frame, clamped to [0, 0.25]
  replica: ReplicaAt;                        // the replica as of renderTick (docs/net.md B.5): each component as the view shows it; replica.world (= GameClient.replica) has the newest
  clock: NetClock;
  localEntity: EntityId | undefined;         // from Spawned
  input: Readonly<I> | undefined;            // copy of the last input frame sent (one object reused per frame); undefined before the first client tick
  regions: { loaded: readonly RegionId[]; loading: readonly RegionId[]; wanted: readonly RegionId[]; prefetch: readonly RegionId[] };
      // sorted; loaded/loading = RegionClient.loaded()/loading(), every region held, so one dropped from the set stays
      // until REGION_RELEASE_GRACE_MS ends; wanted = last RegionSet.active; prefetch = its prefetch without the active ids.
      // One frozen object, rebuilt only after a RegionSet, a regionLoaded or a regionUnloaded
  render?: { host: RenderHost; world: RenderWorld };   // only when a canvas was given
}

export type ClientState = 'idle' | 'connecting' | 'connected' | 'spawned' | 'reconnecting' | 'closed';   // NetClient: Connecting/Handshaking, Joined/Loading/Ready, Playing, Reconnecting/Resyncing, Disconnected
export interface ConnectResult { playerId: number; localEntity: EntityId; tick: number /* clock.serverTickNow() when playing starts */ }
export interface GameClientEvents { state: ClientState; spawned: SpawnedPayload /* every player's */; rejected: RejectedPayload; disconnected: DisconnectInfo /* { code, reason, willReconnect } (docs/net.md B.3) */; event: ReplicatedEventInfo /* from M2 */ }
export interface GameClient<I extends InputFrame = InputFrame> {
  readonly game: Game<I>;
  connect(): Promise<ConnectResult>;         // resolves once the own entity is spawned (NetClient Playing); rejects with net-client's ConnectError: 'rejected' (with the Rejected payload), 'closed' (with the close code, e.g. a kick before spawning), 'aborted' (disconnect() meanwhile), ...
  disconnect(): void;                        // sends Leave, closes, state 'closed'
  send(type: MessageDef<unknown>, msg: unknown): void;   // throws before connect()
  readonly replica: ReplicaWorld;            // = net.mirror; these four throw until connect() built the NetClient (it needs url/token and the loader at construction, docs/net.md B.3): at once for a headless client, once the render module loaded with a canvas
  readonly clock: NetClock;                  // = net.clock
  readonly net: NetClient;
  readonly regions: RegionClient;            // = net.regions
  readonly assets: AssetLoader | undefined;  // (M2) built by the first connect() when there is a manifest; undefined before and without one; disposed by dispose()
  readonly state: ClientState;
  readonly localEntity: EntityId | undefined;    // own entity from Spawned; kept while reconnecting to the same player, undefined after a fresh join until the new entity spawns, and once closed
  on<K extends keyof GameClientEvents>(evt: K, cb: (payload: GameClientEvents[K]) => void): () => void;
  tickFrame(nowMs: number): void;            // manual frame when autoFrame is false (headless tests); nowMs on the performance.now() time base, and with a canvas the frame's rAF timestamp
  dispose(): void;                           // disconnect, stop frame loop, dispose render world, asset loader (M2) and host, in that order
}
export function createClient<I extends InputFrame>(game: Game<I>, opts: CreateClientOpts<I>): GameClient<I>;
```

Construction is cheap and synchronous; everything that needs the socket or `three` happens in `connect()`:

```
createClient(game, opts):
  1. registry = game.registry (registry-local IDs established by defineGame; hash sent in Hello)
  2. if opts.assetBaseUrl !== undefined and !opts.assetBaseUrl.endsWith('/'): throw TypeError
     manifest = opts.manifest ?? game.assets; if manifest and opts.assetBaseUrl (differing): manifest = { ...manifest, baseUrl: opts.assetBaseUrl }   // a copy; the caller's object is not mutated
  3. renderModule = opts.canvas ? import('@conduit/render') : null                 // the only three import path; started now, awaited in connect()
  4. return client (state 'idle')

connect():
  live = net exists and is not Disconnected                                        // reconnecting: no join, just wait for Playing below
  if !live: { token, wsUrl } = opts.lobby ? await lobby.join(sessionId)             // a rejected join rejects connect() with the lobby's error; state 'closed'
                                          : { token: opts.token ?? DEV_TOKEN, wsUrl: opts.url }
  r = await renderModule                                                            // null when headless
  backends = r ? [new r.GltfBackend(opts.models), new JsonBackend(), new BinaryBackend(), new AudioBackend()]
               : [new GltfMetaBackend(), new JsonBackend(), new BinaryBackend(), new AudioBackend()]   // docs/assets.md §4; GltfMetaBackend from M6 (until then a headless client has no model backend)
  assets ??= manifest ? new AssetLoader(manifest, backends, opts.assetLoader) : undefined   // once per client; manifest.baseUrl is the URL prefix (docs/assets.md 1.1)
  net ??= new NetClient({ url: wsUrl, game, token, displayName, assets, manifest: assets?.manifest,   // RegionClient loads manifest.regions[id] per region (docs/net.md B.8); both or neither
                          prediction: opts.prediction,                                              // (M6) docs/net.md B.10; undefined = off
                          sampleInput: frame => schema.copy(opts.sampleInput(inputCtx(frame)), frame) })   // docs/net.md B.3/B.6
  else if !live: net.setTarget(wsUrl, token)       // a later connect() (after 'closed') reuses the NetClient: a lobby join minted a new token, and a
                                                    // SessionToken expires TOKEN_TTL_S after minting, so the first one would be refused
  replica = net.mirror; clock = net.clock; regions = net.regions
  net.on('welcome', w => graph = game.world(w.worldSeed))                          // the graph never crosses the wire (docs/world.md §1)
  net.on('spawned', s => { if s.playerId === net.playerId: localEntity = s.entity; render?.world.cameraTarget(s.entity) })
  net.on('message', m => opts.onMessage?.[m.def.name]?.(m.payload, lastFrame))
  net.on('event', e => { render?.world.pushEvent(e); emit 'event' })                 // docs/render.md §3; the same object; due at once (NetClient emits at render time)
  net.on('regionSet', r => { wanted = sortedUnique(r.active); prefetch = sortedUnique(r.prefetch) - wanted })   // FrameContext.regions
  regions.on('regionLoaded'/'regionUnloaded', id => opts.onRegion?.({ type, id }))
  await net.connect()                                                               // Hello -> Welcome (graph now known) -> Ready -> RegionSet ... (docs/net.md B.3)
  if r:                                                                             // build the render side once the graph exists
     host = new r.RenderHost({ canvas }); world = new r.RenderWorld(host, replica, clock, assets, graph)
     for b of [new r.RegionBinder(world), new r.TransformBinder(), new r.ModelBinder(world), ...opts.binders]: world.registerBinder(b)   // order per docs/render.md §3; RegionBinder before TransformBinder (§4.2)
     world.setInput(opts.input ?? r.NULL_INPUT); world.setCamera(opts.camera ?? new r.FollowCamera())
     host.onFrame((dt, h) => frame(h.timeMs, dt)); host.start()                            // RenderHost drives the frame; host.setWorld is not used (ordering below). h.timeMs is the frame's rAF timestamp: reading performance.now() here would time the frame from after the work above, and that jitter shows up as stutter (docs/net.md B.4)
  else if autoFrame: setInterval(() => frame(now(), HEADLESS_FRAME_MS / 1000), HEADLESS_FRAME_MS = 1000 / 60)
  await spawned (own Spawned received); return { playerId, localEntity, tick }

frame(nowMs, dt):
  net.update(nowMs)                                        // clock slew, event dispatch, ReplicaWorld.gc (docs/net.md B.3); must precede world.update
  if render and localEntity: rid = replica.read(localEntity, Region)?.id                 // the latest Region, not the render tick's (docs/render.md 3.1)
     if rid && rid !== render.world.floatingRegion: render.world.setFloatingOrigin(rid)   // before update, so views and the camera see the new origin in this frame
  render?.world.update(dt)                                 // docs/render.md 3.3
  renderTick = clock.renderTick()
  ctx = FrameContext{ renderTick, dt, replica: new ReplicaAt(replica, renderTick), clock, localEntity, input, regions, render }
  opts.onFrame?.(ctx); lastFrame = ctx
```

M3 form (PLAN.md): no `lobby` (M5); the `AssetLoader` is built as above (a headless client has only the
`json`, `binary` and `audio` backends until `GltfMetaBackend` in M6, so a region group with a model fails and
`RegionClient` reports that region loaded with a warning) and handed to both `RenderWorld` and `NetClient`, whose
`RegionClient` acquires each region's asset group, so `connect()` resolves only once the active regions' groups
completed or failed. (M2 did not pass the loader to `NetClient`, registered only `TransformBinder` and
`ModelBinder`, and had no `setFloatingOrigin` step.) The graph is `net.graph`, which `NetClient` builds as
`game.world(Welcome.worldSeed)` before it emits `welcome`. The NetClient is created by the first `connect()`
right after the loader, because `RegionClient` takes the loader at construction and a rendering client's loader
needs the render module's `GltfBackend`: a headless client without a lobby has it as soon as `connect()` returns
(nothing is awaited first), a lobby client once the join answered, a rendering client once `@conduit/render` has
loaded. Later `connect()` calls reuse it; the render
side is built once. Own spawn = NetClient reaching `Playing`. When the connection closes, the headless frame loop
stops (a `RenderHost` keeps running until `dispose()`).
`dispose()` disposes the render world first (its `ModelBinder` releases the model handles), then the loader
(which disposes every asset still held or in its unload grace while the renderer can still free their GPU
resources), then the host.

**Reconnect (M4).** The `NetClient` owns reconnecting (`docs/net.md` B.3); the client maps its states and
forwards its `disconnected` payload unchanged:

- A reconnectable loss while playing (an abnormal close such as 1006, `Kicked{ServerShutdown}` + 1001, …) moves
  to `reconnecting`, and `disconnected` fires once with `willReconnect: true`. Frames keep running (the headless
  interval or the `RenderHost`), so the replica stays on screen until the resync reset; `localEntity` is kept, and
  `connect()` called meanwhile waits for the connection to play again instead of opening a new one.
- A resync (the server still knew the reconnect token) goes back to `spawned` with the same player and entity.
- A fresh join (the token was unknown: the grace expired or the server restarted) goes `reconnecting` → `connected`
  → `spawned`: `localEntity` becomes `undefined` (and the camera target is cleared) on the `connected` step, and
  the new entity is set when playing starts.
- Either way the next connection's first `sampleInput` gets `previous: undefined`, and `connect()` resolves with
  the `ConnectResult` taken when playing started again.
- Giving up (every backoff attempt failed) or a final close (a kick, `Kicked{Replaced}`, …) is `closed` with
  `disconnected{willReconnect: false}`, and the headless frame loop stops, as on `disconnect()`.

**Host mode (M5).** With `lobby` and `sessionId` (the player is logged in, and already a member when the
session needs an invite code: the menu joins with the code first), every `connect()` that opens a connection
joins through the lobby, which starts an idle session and mints a `SessionToken` for this connection, and connects
to the `wsUrl` it answered. The NetClient's own reconnects (above) do not join again: they keep the token the
connection joined with, which the host accepts expired together with the reconnect token (`docs/host.md` §17). A
`connect()` after `closed` joins again and hands the new token and URL to the existing NetClient
(`NetClient.setTarget`, `docs/net.md` B.3), so its replica, clock and render world stay the same objects.

**Prediction and presentation.** Prediction is off by default. With `{ enabled: true }` alone,
`Reconciler` tracks input acknowledgements and pending frames; it does not predict or change
presentation. Pass a `PredictionDriver` as `prediction.predictor` to run the game's adapter,
and a `PresentationProvider` as `presentation` to present its sampled pose consistently through
models, cameras and floating origin. The adapter declares all evolving state, external conditions,
held input and command outcomes. It reconciles at a coherent authoritative entity/group tick,
which may lag the global snapshot tick; input acknowledgement is a separate watermark.

Predicted state stays separate from the immutable replica. Sampling writes caller-owned output
and cannot advance simulation. History/replay and commands are bounded; overflow, reconnect,
generation and boundary changes reset prediction. Retire resolved command history explicitly
without reusing retired IDs. See docs/net.md, “Opt-in prediction driver and coherent presentation,”
for the adapter, reset and command/effect contracts. Enabling acknowledgement tracking alone
remains useful for diagnostics and preserves the authoritative presentation path.

**Where the manifest comes from.** `conduit-assets build` writes `manifest.json` next to the content files,
and a build output is usually not committed. A game whose bundler can import the generated file passes it
as `defineGame({ assets })`. The sandbox cannot: `examples/sandbox/public/assets/` is gitignored and a fresh
checkout must typecheck and test without it. So `src/shared/game.ts` has no `assets`, and the browser
client fetches `/assets/manifest.json` at startup, validates it (`assertValidManifest`) and passes it as
`manifest` (a missing file leaves placeholders and a console warning); its `pnpm dev` builds the assets
before vite starts (PLAN.md "Sandbox content spec").

`sampleInput` receives actual elapsed sampling seconds in `dt` and a monotonic `sampleTimeMs`;
use `clock.tickMs / 1000` for fixed simulation duration. `inputScheduling` defaults to `hybrid`: each
frame pulses input before presentation, alongside an absolute timer fallback. `timer` disables
frame pulses; `manual` disables the timer. Short press/release edges must be latched by the game
until sampling consumes them. See the migration contract in docs/net.md B.6.

`sampleInput` runs inside `InputSender.tick()` (`docs/net.md` B.6): its return value is copied into
the ring slot, and the sender stamps `tick` and sends the last 4 frames. If `sampleInput` throws,
the previous frame is re-sent and the error is logged via `console.error` at most once per second.
Headless clients call `frame` from the interval (or from `tickFrame` when `autoFrame` is false);
there is no separate gc call anywhere in `@conduit/game`.

Headless mode is exactly: no `canvas`. Nothing in `client.ts` imports `@conduit/render` statically;
the only reference is the `import('@conduit/render')` expression behind the `opts.canvas` check
(type-only imports of `Binder`, `CameraController`, `InputSource`, `RenderHost`, `RenderWorld` are
erased), so bundlers code-split it and Node never evaluates it. Bot clients and the integration
test use this path.

## 5. Package `exports` and the browser boundary

```json
{
  "name": "@conduit/game",
  "type": "module",
  "exports": {
    ".":        "./src/index.ts",
    "./server": "./src/server.ts",
    "./client": "./src/client.ts",
    "./host":   "./src/host.ts"
  },
  "sideEffects": false
}
```

Rules:

- `src/index.ts` and `src/client.ts` import only isomorphic packages (`@conduit/math`, `protocol`,
  `sim`, `world`, `assets`, `net-client`, `lobby-client`) and never `ws`, `node:*`,
  `@conduit/net-server`, `@conduit/persist`, `@conduit/host`, `@conduit/auth`, `@conduit/lobby`, or
  `three` (statically).
- `src/server.ts` and `src/host.ts` are Node-only and are never re-exported from `src/index.ts`.
- Type-only imports across the boundary use `import type` so they are erased.

Why: Vite resolves every static import reachable from `@conduit/game/client` into the browser
bundle. `ws` has no browser build and `node:*` specifiers fail at resolve time, so a single stray
import breaks the client build; `three` must be a dynamic import so headless Node clients
(integration tests, bots) never load WebGL code. The eslint `no-restricted-imports` rule from
`docs/consuming.md` catches direct violations; `test/clientIsolation.test.ts` catches transitive
ones by bundling.

`test/clientIsolation.test.ts`:

```
(globalThis as unknown as { window?: unknown }).window = {}     // simulate a browser before importing; deleted afterwards
mod = await import('../src/client.ts'); expect(typeof mod.createClient).toBe('function')
result = await esbuild.build({ absWorkingDir: <repo root>, entryPoints: ['packages/game/src/client.ts', 'packages/lobby-client/src/index.ts'], bundle: true,
                               platform: 'browser', format: 'esm', splitting: true, outdir: 'out', write: false, metafile: true, external: ['three'], logLevel: 'silent' })
                               // splitting (with outdir) is what turns the dynamic import into its own chunk; paths are repo-relative so the regex below matches.
                               // The lobby client is the second entry because a host-mode app bundles it with the client (the `lobby` option, section 4)
inputs = Object.keys(result.metafile.inputs)
expect(inputs.some(p => /(^|\/)node_modules\/ws\//.test(p) || p.startsWith('node:') || /packages\/(net-server|persist|host|auth|lobby)\//.test(p))).toBe(false)
for name of ['host', 'lobby', 'auth', 'net-server', 'persist']: expect(inputs under packages/<name>/).toEqual([])   // M5: one readable failure per package
expect(inputs).toContain('packages/lobby-client/src/index.ts')       // bundled, its @conduit/lobby imports being type-only
entry = the output whose entryPoint is the client; every output in its static-import closure has no packages/render/ or packages/lobby-client/ input
        (client.ts only names the LobbyClient type) and no 'three' import
expect(entry.imports.filter(i => i.kind === 'dynamic-import')) to be one chunk whose entryPoint is packages/render/src/index.ts and which imports 'three' (external)   // render is split, not inlined
```

`esbuild` (`^0.24`) is a direct dev dependency of `@conduit/game`.

---

## 6. Files

### packages/game

| File | Exports |
| --- | --- |
| `src/index.ts` | `defineGame`, `Game`, `GameDefInput`, `GameDefError`, `GameDefErrorCode`; re-exports `defineComponent`, `defineSystem`, `defineEvent`, core components (`@conduit/sim`), `defineMessage`, `defineInput`, `f` (`@conduit/protocol`), `GridWorld`, `NodeWorld` (`@conduit/world`; `NodeWorld` from M3) |
| `src/defineGame.ts` | `defineGame` |
| `src/registry.ts` | `assignIds(components, messages, events): AssignedIds` (sorted immutable lists; never mutates definitions), `buildGameRegistry(parts: GameRegistryParts): SchemaRegistry` |
| `src/validate.ts` | `validateGameDef(def): ValidatedGameDef` (merged lists and defaulted rates), `GameDefError`, `GameDefErrorCode`, `GAME_ID_PATTERN`, `DEFAULT_TICK_RATE`, `MIN_TICK_RATE`, `MAX_TICK_RATE`, `DEFAULT_SNAPSHOT_EVERY`, `MAX_SNAPSHOT_EVERY`, `MAX_GAME_COMPONENTS` |
| `src/types.ts` | `Game`, `GameDefInput`, `ServerHooks`, `ServerContext`, `ServerLog`, `SessionFactoryResult`, `SessionFactory`, `HostGameEntry`; re-exports `PlayerInfo`, `PlayerSpawn`, `HookContext` types from `@conduit/net-server` (shared type-only definitions) |
| `src/server.ts` | `createServer`, `CreateServerOpts`, `GameServer`, `createReplayRun`, `ReplayRunOpts`, `GameReplayRun` (M6, from `src/replayRun.ts`), `defineSessionFactory`, `DEFAULT_SERVER_HOST`, `DEV_SESSION_ID`; re-exports `MemoryStore`, `SqliteStore`, `AUTOSAVE_INTERVAL_MS` (M4) (`@conduit/persist`), `devVerifier`, `hmacVerifier`, `DEV_TOKEN` (`@conduit/auth`), `ServerHooks`, `ServerContext`, `ServerLog`, `SessionFactory`, `SessionFactoryResult`, `PlayerInfo`, `PlayerSpawn`, `HookContext` |
| `src/serverContext.ts` | `buildServerContext(ctx: HookContext, game, log?): ServerContext`, `adaptHooks(hooks: ServerHooks, game, log?): AdaptedHooks`, `AdaptedHooks`, `consoleServerLog` |
| `src/replayRun.ts` | `createReplayRun`, `ReplayRunOpts`, `GameReplayRun` (section 2, Replay) |
| `src/host.ts` | `createHost`, `CreateHostOpts`, `GameHost`, `HostGameEntry` |
| `src/client.ts` | `createClient`, `CreateClientOpts`, `GameClient`, `GameClientEvents`, `ConnectResult`, `ClientState`, `FrameContext`, `InputContext`, `HEADLESS_FRAME_MS` |
| `src/frame.ts` | `FrameLoop`, `FrameLoopOptions`, `FrameLoopTimers` (rAF or interval driver with `start/stop/tick(now, dt?)`; the interval driver passes its nominal period as `dt`, rAF and manual ticks the elapsed time; the rAF driver times a frame from the timestamp it is passed, not from `now()` read inside the callback; `dt` clamped to `MAX_FRAME_DT = 0.25`), `DEFAULT_FRAME_INTERVAL_MS` |

| Test | Proves |
| --- | --- |
| `test/defineGame.test.ts` | a game whose `world` is a `NodeWorld` from the root entry round-trips its `graphJson` (M3); core components/events are merged and deduped; ids are identical when the same lists are passed in three different orders; `registryHash` changes when a component field changes and does not change when only `protocolVersion` changes; each `GameDefErrorCode` is thrown by its trigger (duplicate names, 256 components, input whose first field is not `tick: u32`, bad interpolate field, tickRate 0); `assets` is kept as given (same object, no effect on `registryHash`) and absent when not given; `graphJson` is cached per seed and round-trips through `fromJson` |
| `test/host.test.ts` | (M5, skipped without `node:sqlite`) `createHost` throws synchronously for a game listed twice (no database file is created) and for the host's `ConfigError` (a weak secret, a `static` directory that does not exist); on port 0 it returns a frozen `{ port, url }`, serves `GET /games` and the `static` directory, a join of a session whose worker cannot import the module answers 500 while the host's `[session <id>] start failed` line reaches `log`, and `close()` is idempotent and releases the port |
| `test/bundle.test.ts` + `test/fixtures/bundled-host.ts` | (skipped without `node:sqlite`) a production host bundle as `docs/consuming.md` §4 builds it: one esbuild build (`splitting`, `packages: 'external'` with the workspace plugin) of `bundled-host.ts` (the main thread: `createHost` with `module` and `workerEntry` set to the build's `session.mjs` and `worker.mjs` next to its own output, and `workerExecArgv: []`), `@conduit/host/worker` and the sandbox's game module (`examples/sandbox/src/server/game.ts`) into a temp directory; every module is in exactly one output (a `packages/sim/src/` file included), and the outputs import nothing external but `ws`, `hono` and `node:` built-ins. With only `ws` and `hono` linked into its `node_modules`, `node --max-old-space-size=512 main.mjs` (a flag a worker's `execArgv` may not carry) listens; a lobby `join` answers 200 and `/healthz` lists the session `running`; a `NetClient` with the join's token receives `Welcome` and reaches `Playing`; `SIGTERM` exits 0 |
| `test/server.test.ts` | `createServer` without `secret` or `devAuth` throws; with `devAuth: true` on port 0 it returns a listening port and logs `DEV_AUTH_WARNING` once; a raw `ws` client with any token (including `''`) completes Hello/Welcome and `displayName` from Hello reaches `onPlayerJoin` as `player.displayName` with `accountId 'dev:<name>'`; with a `secret`, a bad token is `Rejected{BadToken}` and a `mintToken`ed one with `sessionId 'dev'` joins; `onPlayerJoin` returns a `PlayerSpawn` whose `spawn` is called once the region is active; `onInit` runs on a fresh `MemoryStore`, `onLoad` runs with the value `onSave` returned after `close()` and a second `createServer` on the same store; `onMessage` handler receives a game message before that tick's systems (asserted via `ctx.tick`) and can reply through `ctx.send`. M4: a bad `port` or `autosaveIntervalMs` throws `RangeError`; with `autosaveIntervalMs: 20` region blobs and `onSave` reach the store while running; `close()` saves exactly once (one `regions.flushAll`, after the loop stopped), then closes a store that has `close()`, is idempotent, and the kicked `NetClient` goes `Reconnecting` with `disconnected{1001, willReconnect: true}` (a shutdown close is reconnectable) until `disconnect()`; a listen failure (`EADDRINUSE`) stops the started session and closes the store; with a `SqliteStore` scratch file (skipped when `node:sqlite` is unavailable) autosaves reach the file while running (read through a second connection), `close()` closes the store, and a second `createServer` with a new `SqliteStore` on the same file calls `onLoad` with the saved state and restores every region from its blob (the loader receives the blob and seeds nothing; a marker moved during the first run is where it was). `defineSessionFactory` builds hooks that see a `ServerContext` with JSON save/load, and gives every `ServerContext` the log a host worker passes (`consoleServerLog` without one) |
| `test/clientIsolation.test.ts` | section 5 |
| `test/client.test.ts` | headless `createClient` against `createServer` on a minimal inline game: connection members throw before `connect()`; states `connecting → connected → spawned`; frames arrive on their own with `FrameContext` fields filled; `sampleInput` gets `previous`/`dt`/`localEntity`; A's input moves A's entity by `> 1 m` in B's replica; an s2c reply reaches `onMessage` with a `FrameContext`; A's `disconnect()` destroys A's entity in B's replica and stops A's frames; `autoFrame: false` frames only through `tickFrame`; a protocol-version mismatch rejects `connect()` with `ConnectError('rejected')`; a kick before spawning rejects with `ConnectError('closed')` and code 4011. Reconnect (M4), through a TCP relay (`test/tcp-proxy.ts`) whose cut destroys the sockets so both ends see 1006: the client goes `reconnecting` with `disconnected{1006, willReconnect: true}`, keeps `localEntity` and its frames, the server holds the player away, a `connect()` made meanwhile resolves with the same player and entity once the relay is restored, input then moves the same entity, and a later kick is `closed` with `willReconnect: false`; against a server with `reconnectGraceMs: 0` the reconnect is a fresh join: states `reconnecting → connected → spawned`, `localEntity` `undefined` while `connected`, then a new alive entity and a new reconnect token, and the first sample after it has `previous: undefined`. Lobby (M5), against a `createServer` with a `secret` and a lobby double minting a token per join: `lobby` without a `sessionId`, with `url` or `token`, and a `sessionId` without `lobby` throw `TypeError`, and neither `url` nor `lobby` rejects `connect()`; `connect()` joins (`join('dev')`), builds the NetClient only once the join answered and plays as the token's account; after `disconnect()` a second `connect()` joins again and the same NetClient plays as the second token's account (states `connecting → connected → spawned → closed → connecting → connected → spawned`); a rejected join rejects `connect()` with the lobby's error and leaves the client `closed` without a NetClient; `disconnect()` while the join is pending rejects `connect()` with `ConnectError('aborted')`. Assets (M2): an `assetBaseUrl` without a trailing `/` throws; no manifest, no `assets`; a headless client builds its loader in `connect()` from `game.assets` or `opts.manifest`, fetches through `assetBaseUrl` (the manifest is copied, not mutated) with no `model` backend, and `dispose()` disposes it. Streaming (M3): with a manifest whose `regions` gives the spawn cell a JSON asset whose fetch is held back, `regions.loading()` and `FrameContext.regions.loading` list the spawn cell, `connect()` stays pending in `Loading` and `onRegion` has only the asset-less cells until the fetch completes; then `connect()` resolves, `onRegion` reports the spawn cell loaded and the loader holds one reference for `RegionClient`; `FrameContext.regions.prefetch` is empty in a 3 x 3 world. With a canvas and `@conduit/render` replaced by a `vi.mock` fake (no WebGL in Node): the NetClient exists only once the render module loaded; the loader's `model` backend is the render module's `GltfBackend`, `RenderWorld` receives `client.assets` and the core binders `RegionBinder` (constructed with the world), `TransformBinder`, `ModelBinder`; `setFloatingOrigin` runs once the replica has the local entity's `Region`, before that frame's `world.update`, and again, once, when the car drives across into the next cell; a replicated event the server emits reaches `world.pushEvent` and `'event'` as the same object, and `dispose()` runs world, loader, host in that order |
| `test/frame.test.ts` | `FrameLoop` interval and rAF drivers, `dt` clamping, a throwing frame stops the loop |
| `test/module-graph.test.ts` + `test/trace-loader.mjs` | specified in `docs/render.md` 10.1: no `three` module is loaded by the server entry or a headless `createClient`. The trace loader uses `module.registerHooks` (falling back to `module.register`) and writes the resolved URLs to `CONDUIT_TRACE_OUT` at exit; children run with Node's own type stripping (tsx via `@conduit/tooling` on a Node without it). Scenarios: the server entry; the headless client entries; a headless client that connects to a `createServer`, plays and disposes; and a positive control importing `@conduit/render`, whose trace must contain `three` |
| `test/headless.test.ts` | the CONCEPT.md integration row on the sandbox game: in-process `createServer` plus headless `createClient`s (A near B; C, joining later, far away): A and B each load the nine wanted cells and the 16-cell prefetch ring around them, as `regions.loaded()` and `FrameContext.regions` (`wanted`, `prefetch`) show; after 300 ticks server `world.hash()` equals a hash built from each client's replica over its visible set (delta-equals-full, before C joins); A's throttle input moves A's entity as observed in B's replica by `> 1 m` within 60 ticks; (M2) B receives A's `Horn` event with A's entity and region once per `BUTTON_HORN` press (held 20 ticks: one event; a second press: a second one), emitted once B's render tick reached the event tick, and A hears it at the same tick; A's `Chat` reaches both players as `'A: <text>'`; C, spawned by a hooks wrapper in `cell/2_2` (its nine cells and prefetch ring share no cell with A's and B's), receives zero `Snapshot` creates or updates for A/B and no create outside its own nine cells (recorded at `ReplicaWorld.applySnapshot`), and zero `Events` from their region while A drives and A and B honk, whereas C's own Horn reaches C (and not A or B); C then leaves; A `disconnect()` causes B to observe A's entity destroyed within `reconnectGraceMs` set to 0; bytes received per client over 10 s with 300 crates in view is `< 60 KB/s`; the hooks' `ctx.log` join lines reach the server's log. (M5) The same suite runs again through `createHost` (skipped when `node:sqlite` is unavailable): the host's SQLite file in a temp directory, the game module `test/fixtures/headless-game.ts` (the sandbox game with the crowded spawn cell and the distant C, which the session worker imports), and players that `register`, `login` and join through `@conduit/lobby-client` (A creates a private session with `createSession`; B and C `join` it with the invite code, then their clients connect with `lobby` and `sessionId`). The server-side checks read what the worker reports over a `BroadcastChannel` (each tick: tick, players, active regions and live vehicles; on snapshot ticks the world hash and entity count; a `sync` request answered between ticks) instead of the in-process Session; the join lines arrive through `createHost`'s `log` prefixed `[session <id>]`; and a lobby client's replica exists only once its join answered. (M6) The `createServer` run happens twice, the second time with every client's `prediction: { enabled: true }` (docs/net.md B.10), which must change nothing the scenarios observe: the runs without it check that the stub is off by default (`net.prediction` `null`, no `prediction` key in `stats()`), and the prediction run that each client's stub followed the acknowledgements (while A drives, A's and B's `lastAckedTick`, at most the server tick, `ackedFrames` and `authoritativeTick` rise; sampled on every frame over the run, C's until it left, the acked tick never goes back, pending frames stay within half a second of ticks and none is dropped) |
| `test/simulation-interest.test.ts` | `ServerHooks.simulationInterest` keeps a drone no player is near simulated along row 0 of an 8 x 3 grid in a live `Session` (`manualLoop`, `recordLog` and a command journal, one far player): it crosses every column, the pad and first column it left are evicted after `LINGER_MS`, and only the named regions load; `replay` through `createReplayRun` matches every checkpoint, the final hash and active regions, and without the hook fails at the first checkpoint; `createJournalReplayRun` reaches a state without differences from the live checkpoint, and without the hook rejects the journal; an invalid interest faults the replay step (`simulationInterest`/`hook`) before `regions.update`, and an out-of-range `maxSimulationInterestRegions` is a `RangeError` |
| `test/replay.test.ts` | `createReplayRun` on the sandbox game: record 600 ticks of scripted inputs from two players (joined and spawned by lifecycle entries; one drives into the next cells, so regions load during the run) with checkpoints every 60, `replay` passes; flipping one input byte (the `throttle` byte of one frame) fails at the first checkpoint after it; with a `MemoryStore` and with a store that answers after 20 promise hops, a region a step started loading activates at the next step and the spawn waits for it (`ctx.players` goes `Joined`, `Ready`, `Playing`); another `seed` builds another world; option, player, lifecycle and tick-order errors. A live `Session` (sandbox hooks, `manualLoop`, a macrotask turn between ticks, `recordLog`) with scripted in-memory clients: A joins, B joins, Y's join creates an entity and throws, Z drops before its join runs, A drops and reconnects, B leaves, C joins into B's slot; the recorded lifecycle and `null` frames are as expected, `replay` through `createReplayRun` matches all ten checkpoints and the final hash, players and active regions, and the same log without its lifecycle fails at the first checkpoint; ticks 200 to 212 are skipped (`Session.skip`), recorded as `[200, 13]` with no frames, replayed, and without its skips the log fails at the next checkpoint (240) |


Opt-in prediction uses `new PredictionDriver({ adapter, inputSchema: game.input, tickRate:
game.tickRate })` from @conduit/net-client and createClient prediction `{ enabled:true,
predictor:driver }`. Pass `presentation: provider` to createClient for one complete region-local
pose shared by model and camera; the provider maps driver.sample into its caller-owned Transform
output. Driver state is separate from the immutable replica. The existing prediction-disabled
path constructs no driver, prediction rings or presentation buffers. Subscribe to
`authoritativeEvent` for arrival-time outcomes and `event` for delayed visual delivery, deduping
shared IDs when a consumer observes both. See docs/net.md for coherence, command/effect lifecycle,
bounded work and migration details.

## Recording complete decisions and diagnostic replay

`CreateServerOpts` forwards `journal`, `simulationMessages`, `externalCommands`, `stateSerializers`,
`spawnPlanSerializer` and `sessionEpoch` to the Session. Classify simulation-changing messages
explicitly in `simulationMessages`; each must have an `onMessage` handler. Other messages, such as
chat, are outside the simulation journal and must not change authoritative state. Asynchronous
results enter `ctx.enqueueExternalCommand(name, payload, {tick, actor})` through a registered
`defineExternalCommand(name, schema, handler)` definition. The bounded queue validates the payload
before it reaches simulation; replay applies the recorded result without repeating its service call.

`Session.captureCheckpoint()` assembles an `ExactSessionCheckpoint` at a healthy completed boundary.
Its logical players retain opaque actor identity, lifecycle and input queues, without credentials,
reconnect tokens or transport baselines. Pending spawn closures require a versioned
`spawnPlanSerializer`; completed spawn closures are no longer continuation state. Registered game
serializers must validate their detached values/schema versions. Hidden mutable module/closure state
is not captured automatically. A serializer restore failure permanently invalidates that offline run;
construct a fresh adapter rather than continuing partially restored state.

`createJournalReplayRun(game, journal, {regionLoader, hooks: effects => replaySafeHooks, ...})` uses
the Session pipeline with no network admission or autosaving. Its pipeline calls `simulationInterest`
as live (not journaled; the recorded region decisions then apply to the regions it wants); pass the
recording's `maxSimulationInterestRegions` when it was not the default. Supply fresh replay-safe hooks and
recorded-result handlers; replace account/achievement/service writes with the provided bounded
observation sink. Core cannot intercept arbitrary external calls hidden inside consumer closures.
Recorded connection transitions reproduce Away/ready/rebind behavior, while live grace clocks and
region storage decisions are disabled. `apply`, `step`, `skip`, `checkpoint`, `restore`, `capture`
and idempotent `dispose` support full replay and checkpoint seek.

`executionStateOfCheckpoint` is the declared comparison projection. It includes allocator/store
state, hidden values, RNG/events, logical players/held inputs/accepted future frames, scheduled
commands, membership/inboxes and registered game state. It excludes capture generation, envelope
metadata, transport acknowledgement sequences and wall-clock `awaySince`; connection/lifecycle
choices are journaled instead. Unobserved asynchronous region-result inboxes are excluded from the
comparison until their recorded boundary application, while the exact checkpoint retains them for
continuation. Compare at a synchronized completed boundary before unrelated new network arrivals.
Taking extra diagnostic captures does not advance generation or change the execution digest.

A live recording source must start fresh. Starting it from an existing application save is rejected
before `onLoad`: persist-only world state cannot serve as an exact journal anchor. For recorded
continuation, supply a verified exact initial checkpoint reference to the offline replay factory;
the resolver and compatible consumer adapter must restore that image. The same contract supports
intermediate checkpoints captured after completed ticks and verified seek through later transitions.
