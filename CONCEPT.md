# conduit-core

Shared engine for a family of browser co-op games: **Privateer** (pirate sailing, after Sid
Meier's Pirates), **Spacehunter** (grand space exploration, after Escape Velocity), and
**Steel Phalanx** (open-world mechs). The games differ in theme; the machinery underneath is
the same and lives here.

## Documents

This file is the "why and what". The "how" lives in spec-level documents, one per subsystem:

| Document | Covers |
| --- | --- |
| [docs/protocol.md](docs/protocol.md) | Schema DSL, binary codec, registry hash, envelope, every core message byte by byte |
| [docs/sim.md](docs/sim.md) | Math and RNG, entity ids, component stores, World, systems, EventBus, FixedLoop, replay |
| [docs/world.md](docs/world.md) | Region graph, GridWorld and NodeWorld, RegionManager, migration, spatial index, interest |
| [docs/net.md](docs/net.md) | Session and client state machines, input intake, snapshot builder, backpressure, clock, interpolation |
| [docs/game.md](docs/game.md) | defineGame, createServer, createClient, createHost, hooks, headless mode |
| [docs/persist.md](docs/persist.md) | BlobStore, MemoryStore, SqliteStore, migrations, Autosaver, password hashing, session tokens |
| [docs/host.md](docs/host.md) | Lobby DDL and HTTP API, presence socket, gateway, worker protocol, SessionManager, configuration |
| [docs/assets.md](docs/assets.md) | Manifest schema, conduit-assets CLI, AssetLoader, backends, Blender and glTF conventions |
| [docs/render.md](docs/render.md) | RenderHost, RenderWorld, binders, ModelInstance, cameras, headless rule |
| [docs/consuming.md](docs/consuming.md) | Tooling package, root config files, submodule consumption, pitfalls, CI |

## What every game has in common

- Runs in the browser. The client renders and samples input; it never simulates.
- An authoritative TypeScript/Node server runs a fixed-tick simulation.
- Multiplayer sessions of 1-8 players, 2-4 typical. Co-op, not MMO.
- An open world made of regions that load lazily as players approach.
- 3D models as glTF, authored in Blender.
- A shared lobby: accounts, sessions, invite codes, friends.

## Decisions

| Area | Decision |
| --- | --- |
| Server | TypeScript on Node. The load is game logic, AI, economy and streaming, not heavy numerics. The sim is kept pure and schema-driven so hot systems could move to Rust/WASM later without rearchitecting |
| Renderer | Three.js, quarantined in one package |
| Consumption | Each game repo includes conduit-core as a git submodule and links its packages through the game's pnpm workspace. Nothing is published to a registry |
| Netcode | Server-authoritative fixed-tick sim. Clients send inputs, receive delta snapshots, interpolate. No client prediction in v1; the seams for it are reserved |
| Persistence | SQLite through Node's built-in `node:sqlite`. Postgres adapter deferred behind the same interface |
| Lobby and auth | Username + password (scrypt) with HMAC-signed session tokens that the game handshake verifies. OAuth can sit behind the same token later |
| Hosting | One host process runs the lobby, a WebSocket gateway, and several game sessions in worker threads |

Out of scope: sharding one world across servers, automated matchmaking, Postgres until a second machine exists.

Working assumptions:

- Transport is WebSocket with a hand-rolled, schema-driven binary codec. No third-party codec or ECS.
- Physics is a game concern. Core ships kinematic helpers and a spatial hash only.
- Toolchain: pnpm, TypeScript (strict), vitest, eslint + prettier, vite for the example client, tsx for dev. Node >= 22 (>= 22.18 to load the `.ts` tooling presets without tsx), 24+ preferred for stable `node:sqlite`.
- Runtime dependencies are limited to `ws`, `hono` (zero-dependency HTTP router), and `three` as a peer of the render package.

## Principles

1. **Isomorphic by default, `three` quarantined.** Only `@conduit/render` imports `three`. Everything else runs in Node so the server and tests never touch WebGL. Enforced by an eslint `no-restricted-imports` rule and a CI module-graph test.
2. **One schema DSL drives everything.** Components, inputs, messages and events are declared with the same field-type DSL. It produces the binary codec, quantization, interpolation metadata, dirty tracking, and a registry hash checked at handshake.
3. **Sim code is pure.** No wall clock, `Math.random`, or timers inside `sim`, `world`, `protocol`. Seeded RNG per world and per region. Same seed + same input log = same state hash. Enforced by a lint rule. This is also what keeps a later Rust/WASM port of the sim feasible.
4. **Region-local coordinates.** Replicated positions are relative to their region origin. This keeps fixed-point quantization in range for space distances and avoids float32 drift in Three.js far from origin. The client applies a floating origin per region group.
5. **No library build step.** Each package's `exports` points at `./src/index.ts`. Vite, tsx, vitest and esbuild compile TypeScript through workspace symlinks. This is what makes submodule consumption painless.
6. **Core is opinionated but thin.** Games own visuals, materials, UI, physics and content. Core owns transport, replication, the ECS, region streaming, asset loading, entity-to-Object3D binding, accounts, sessions and hosting.
7. **Session I/O is abstracted from the socket.** The simulation talks to clients through a `ClientLink` interface, so the same session code runs directly on `ws` in tests and dev, or behind the gateway in a worker thread in production.

## Repository layout

```
conduit-core/
  package.json                 private; root scripts only (typecheck, lint, test, dev, e2e)
  pnpm-workspace.yaml          packages/*, examples/*
  .npmrc                       auto-install-peers=true, strict-peer-dependencies=false
  tsconfig.json                extends packages/tooling/tsconfig.base.json
  vitest.workspace.ts          ['packages/*', 'examples/*']
  eslint.config.js             re-exports conduitEslint() from tooling
  .github/workflows/ci.yml
  CONCEPT.md                   this file
  PLAN.md                      milestone checklists
  docs/                        spec-level documents, one per subsystem (see Documents above)
  packages/
    math/          @conduit/math          iso      Vec2/Vec3/Quat plain objects, pure fns, seeded Rng
    protocol/      @conduit/protocol      iso      schema DSL, ByteWriter/Reader, codecs, registry + hash, envelope, message defs
    sim/           @conduit/sim           iso      ECS (World, stores, queries), systems + phases, Simulation.step, EventBus, FixedLoop, replay, state hash
    world/         @conduit/world         iso      WorldGraph (GridWorld, NodeWorld), RegionManager, SpatialIndex, interest
    assets/        @conduit/assets        iso      manifest types, AssetLoader (refcounted, prioritized), Node GLB metadata reader
    persist/       @conduit/persist       node     BlobStore interface, MemoryStore, SqliteStore (node:sqlite), migrations, Autosaver
    auth/          @conduit/auth          node     scrypt password hashing, HMAC session tokens (mint/verify), token payload types
    net-server/    @conduit/net-server    node     Session (drives sim's FixedLoop; input intake, snapshot builder, backpressure), ClientLink, WsLink, PortLink
    net-client/    @conduit/net-client    iso      connect/reconnect, NetClock, ReplicaWorld + interpolation, RegionClient
    lobby/         @conduit/lobby         node     accounts, sessions, invite codes, friends; Hono routes; lobby WebSocket for presence
    lobby-client/  @conduit/lobby-client  iso      typed fetch client for the lobby API and presence socket; no UI
    host/          @conduit/host          node     the runnable: HTTP server, lobby routes, WS gateway, session worker manager, CLI
    render/        @conduit/render        browser  RenderHost, RenderWorld, binders, LOD, cameras. Sole importer of three
    game/          @conduit/game          iso      defineGame facade; ./server, ./client, ./host subpath entries
    tooling/       @conduit/tooling       dev      tsconfig base, eslint factory, vite/vitest presets, conduit-assets CLI
  examples/
    sandbox/       @conduit-examples/sandbox   reference game exercising every package, including a minimal lobby menu
```

Dependency graph (arrows point at dependencies; acyclic):

```
math <- protocol <- sim <- world <- net-client (+ assets)
                                 <- net-server (+ persist, auth)
assets <- render (+ math, protocol, sim, world, net-client; peer: three)
auth   -> nothing
lobby  -> persist, auth
host   -> lobby, net-server, persist, auth
lobby-client -> nothing (type-only import of lobby's API types)
game           -> protocol, sim, world, assets
game/server    -> net-server, persist, auth        (single-session mode for dev and tests)
game/host      -> host                             (production: lobby + gateway + workers)
game/client    -> net-client, lobby-client, render (render via dynamic import when a canvas is given)
tooling        -> nothing at runtime
```

Every package has a `package.json` whose `exports` map points at `./src/index.ts`, a `tsconfig.json` extending the tooling base, `src/index.ts`, and `test/*.test.ts`. `render` declares `three` as a peer dependency only.

## Subsystems

### Schema DSL and codec (`packages/protocol`)

```ts
export const f = {
  u8, i8, u16, i16, u32, i32, f32, bool, varuint,
  fixed16: (scale: number) => ..., fixed32: (scale: number) => ...,   // quantized ints
  vec2: (elem) => ..., vec3: (elem) => ..., quat: () => ...,           // quat = smallest-three, 32 bits
  angle16: () => ..., str: (max: number) => ..., entity: () => ...,
  array: (elem, max) => ..., struct: (fields) => ..., optional: (of) => ...,
};
export function defineSchema<F>(fields: F): Schema<Infer<F>>;   // includes an FNV hash of the field spec
export class ByteWriter { u8; u16; u32; i32; f32; varuint; bytes; patchU16; finish(): Uint8Array }
export class ByteReader { ...; remaining(): number }
export function encodeWith<T>(w, schema, value): void;
export function decodeInto<T>(r, schema, target: T): void;        // allocation-free hot path
```

Standard quantization: position `fixed32(0.001)` (1 mm, region-local), velocity `f32` (no cap: `fixed16(0.01)` stopped at ±327.67 m/s per axis, short of a supersonic aircraft), rotation `quat` or `angle16` for heading-only entities, percentages `u8`/`u16`. Games override per field.

### ECS and simulation (`packages/sim`)

```ts
interface ComponentOpts { replicate?: boolean; persist?: boolean; interpolate?: string[]; extrapolateWith?: string }
function defineComponent<F>(name: string, fields: F, opts?: ComponentOpts): ComponentType<Infer<F>>;

class ComponentStore<T> {
  version: Uint32Array;   // tick of last write per slot while present (0 when absent; add re-stamps it)
  removedAt: Uint32Array; // tick the component was last removed; monotonic, never cleared; drives "removed component" deltas
  read(e): Readonly<T>; write(e): T /* stamps version */; set(e, v); add(e, v?); remove(e); has(e);
  entities(): Iterable<EntityId>;   // ascending slot order
}

class World {
  tick: number; registry: SchemaRegistry;
  create(): EntityId; destroy(e): void /* deferred to end of tick */; alive(e): boolean;
  store<T>(c): ComponentStore<T>; add; get; write; has; remove;
  query(...cs): Iterable<EntityId>;   // deterministic ascending order
  hash(): number;                     // FNV over replicated stores, for determinism tests
}

type Phase = 'input' | 'preSim' | 'sim' | 'postSim';
function defineSystem(name: string, phase: Phase, run: (ctx: SimContext) => void): System;
interface SimContext {
  world; tick; dt; rng: Rng; regionRng(id): Rng; regions: RegionManager; spatial: SpatialIndex;
  events: EventBus; inputs(player): InputFrame | undefined;
}
class Simulation { register(system); step(tick): void }   // phase order, then registration order
```

Per-tick order (canonical in `docs/sim.md` 2.9): Session lifecycle and input intake, `regions.update` (every tick), `Simulation.step` (phases, then the postSim tail `membershipSystem` + `spatial.rebuild`, then deferred destroys, then `EventBus.endTick`), `drainOutbox`, and on snapshot ticks the RegionSet refresh and snapshot build.

`EntityId` is a u32 (type and `ENTITY_NONE = 0` defined in `@conduit/protocol`, re-exported by sim): 20-bit slot index plus 12-bit generation. Client-local entities set bit 31 from a separate allocator. Component ids are assigned by `defineGame` from sorted names so server and client agree regardless of import order.

Core-provided components: `Transform { pos, rot, vel }` (replicated, interpolate pos/rot, extrapolate with vel), `Region { id }`, `Model { asset, variant }`, `Owner { player }`, `Name { value }`. Everything else is game-defined.

Fixed-timestep loop (`FixedLoop`, in `@conduit/sim`, driven by `net-server`'s Session): sim at 60 Hz by default, `setTimeout` against an absolute deadline with an accumulator, at most 5 catch-up ticks per wake (excess time is dropped and logged rather than spiralling).

### World graph and regions (`packages/world`)

```ts
type RegionBounds =
  | { kind: 'aabb2'; origin; min; max; plane: 'xz' | 'xy' }
  | { kind: 'aabb3'; origin; min; max }
  | { kind: 'node'; origin };
interface RegionDef { id: RegionId; kind: string; bounds: RegionBounds; neighbors: RegionId[]; assets: AssetId[]; seed: number; data?: unknown }
interface WorldGraph { get(id); neighbors(id); locate(worldPos, hint?): RegionId | null; wanted(id, depth?): RegionId[]; toJson() }
class GridWorld implements WorldGraph {}   // Privateer sea cells, Steel Phalanx terrain chunks
class NodeWorld implements WorldGraph {}   // Spacehunter star systems linked by jump gates

interface RegionLoader { populate(region, blob | null, ctx): void; onDeactivate?(region, ctx): unknown }
class RegionManager {
  update(players, ctx, pending?): void;       // every tick before step; wanted = union of graph.wanted(regionOf(player)) plus pending spawn regions; load, linger 10 s, then save + evict
  migrate(e, to, newLocalPos?): MigrateResult;
  membershipSystem: System;                   // postSim: relocate bounded entities, rebase pos, move to inbox if target inactive
  entitiesIn(id); regionOf(e); active(); flushAll(): Promise<void>;
}
class SpatialIndex { region(id): SpatialGrid; queryRadius(regionId, pos, r, out); queryRadiusAcross(...) }  // rebuilt each tick
```

Only active regions have entities in the ECS, so systems never check region state. Region RNG state and entities with `persist: true` components are serialized on deactivate. The client rebuilds the static world graph from the game definition and `Welcome.worldSeed` (the graph never crosses the wire; its JSON form feeds `conduit-assets build --graph`) so it can prefetch region assets.

### Persistence (`packages/persist`)

```ts
interface BlobStore {
  get(ns: string, key: string): Promise<Uint8Array | null>; put(ns, key, blob): Promise<void>;
  delete(ns, key); list(ns, prefix?): Promise<string[]>; transaction<T>(fn: (tx: BlobStore) => T): Promise<T>;
}
class MemoryStore implements BlobStore {}
class SqliteStore implements BlobStore { constructor(path: string, opts?: { wal?: boolean }) }   // node:sqlite
function migrate(db: DatabaseSync, migrations: Migration[]): void;   // versioned DDL for lobby tables
class Autosaver { constructor(fn: () => Promise<void>, intervalMs: number); start(); stop(); flush() }
```

World and session state use `BlobStore` namespaces (`region`, `session`, `player`). Lobby tables (accounts, login sessions, game sessions with their invite codes, members, friends; the invites `/me` lists are friends-only sessions of friends, derived rather than stored, docs/host.md §1) are relational and use `node:sqlite` directly through `migrate`. One SQLite file per host process in WAL mode. Because sessions run as worker threads inside the host, only one process ever opens the file.

### Auth (`packages/auth`)

```ts
function hashPassword(pw: string): Promise<string>;  function verifyPassword(pw, hash): Promise<boolean>;   // node:crypto scrypt
interface SessionToken { accountId: string; displayName: string; sessionId: string; exp: number }
function mintToken(payload: SessionToken, secret: string): string;   // base64url(payload).base64url(HMAC-SHA256)
function verifyToken(token: string, secret: string): SessionToken | null;
```

The lobby mints a token when a player joins a session. The client sends it in `Hello`. The gateway verifies it before routing the socket to the session worker. Tokens are short-lived (10 min) and authorize joining that one session only; reconnects use the per-connection `reconnectToken` from `Welcome`.

### Lobby (`packages/lobby`, `packages/lobby-client`)

```
POST /auth/register {username, password}        -> {account}
POST /auth/login    {username, password}        -> sets httpOnly cookie, {account}
POST /auth/logout
GET  /me                                        -> {account, friends, invites}
GET  /games                                     -> [{gameId, name, version}]   (games registered by the host)
GET  /sessions?gameId=                          -> sessions the caller can see (own, friends', invited, public)
POST /sessions {gameId, name, visibility: 'private'|'friends'|'public', maxPlayers}  -> {session, inviteCode}
POST /sessions/:id/join {inviteCode?}           -> {token, wsUrl}           mints SessionToken; wsUrl = ws://host/session/:id
POST /sessions/:id/leave
DELETE /sessions/:id                            owner only; stops the worker after flushAll()
POST /friends/:username   POST /friends/:id/accept   DELETE /friends/:id
WS   /lobby                                     presence: friends online, session member changes, invites
```

`LobbyService` holds the logic; `lobbyRoutes(service)` returns a Hono app the host mounts. Session lifecycle: `created` (no worker), `running` (worker started on first join), `idle` (no game sockets for 5 min, worker flushed and stopped), `archived`. Each session records its game id so one host can serve several games; a game registers itself with `host.registerGame(gameDef, { module })`, where `module` is the file URL of a module exporting `game` and `sessionFactory` that each session worker imports itself.

`@conduit/lobby-client` is a typed fetch wrapper plus a presence socket: `login`, `register`, `me`, `listSessions`, `createSession`, `join(id, code)` returning `{token, wsUrl}`, `onPresence(cb)`. No UI; games build their own menus.

### Host and session workers (`packages/host`, `packages/net-server`)

```
host process (main thread)
  HTTP: lobby routes + optional static files on one port
  WS gateway: upgrade on /session/:id, verify SessionToken, attach socket to that session's worker via PortLink
  SessionManager: start/stop worker_threads per session, health, idle timeout, graceful shutdown (flushAll every worker)
session worker
  Session: FixedLoop, Simulation, RegionManager, snapshot builder; persistence via BlobStore proxied to the main thread
```

```ts
interface ClientLink { id: number; send(buf: Uint8Array): void; bufferedAmount(): number; close(code?, reason?): void; onMessage(cb); onClose(cb) }
class WsLink implements ClientLink {}     // wraps a ws socket; used by createServer single-session mode and tests
class PortLink implements ClientLink {}   // worker side; frames cross the MessagePort as transferred ArrayBuffers; main thread reports bufferedAmount every 100 ms
class Session { constructor(game, opts: { store: BlobStore; regionLoader; hooks; verifier?: TokenVerifier }); attach(link: ClientLink, identity?: SessionToken); tickStats(); flushAll() }
```

`Hello` always arrives through the link. The gateway verifies the token on the main thread and passes the identity to `attach`; `createServer` passes no identity and the Session verifies `Hello.sessionToken` through its `TokenVerifier` (`hmacVerifier(secret)` or, only with `devAuth: true`, `devVerifier()`). Close codes: the Session uses 4000–4099, the gateway and host 4100–4199.

The main thread owns all sockets, so backpressure and slow-client handling stay in one place and a crashed worker never takes the HTTP server down.

### Wire protocol (`packages/protocol`, `packages/net-server`)

```
Frame:   u8 wireVersion | u8 messageCount | Message*
Message: u8 kind | u32 tick | u16 seq | u16 payloadLength | payload
```

`wireVersion` is the envelope version (`WIRE_VERSION`); the game's `protocolVersion` (u16) and the registry hash travel in `Hello`. Core message kinds: Hello (carries the SessionToken), Welcome, Rejected, SessionState, Ready, Spawned, Input, Ack, Ping/Pong, RegionSet, RegionLoadState, Snapshot, Events, Leave, Kicked. Game kinds start at 128 via `defineMessage`. The input schema's first field must be `tick: u32`.

Snapshot build per client on snapshot ticks (sim 60 Hz, snapshot every 3rd tick, both configurable):

```
I        = entities in (client.wantedRegions ∩ client.reportedRegions), filtered by optional game relevance(client, e)
creates  = I \ known                      full component records
updates  = { e ∈ I ∩ known : some replicated store.version[e] > baselineTick }   whole components, no field masks
destroys = known \ I                      death or left interest look the same to the client
known = I; baselineTick = thisTick
```

Baseline is the last snapshot sent, which is correct because WebSocket is reliable and ordered. Ack and a sent-log ring exist so switching to last-acked (for datagrams later) is a one-line change. The 19-byte snapshot header is `serverTick, serverTimeMs, baselineTick, lastInputSeq, lastInputTick, flags` (`docs/protocol.md` 9.11); `lastInputSeq`/`lastInputTick` are the prediction seam. A removed component is reported through the store's `removedAt` stamp; a changed one through `version`. Snapshot and Events payloads carry a local region table (`str` ids indexed by `u8`). Events (explosions, sounds) are one-shot, carry their tick, are region-filtered, and are queued rather than skipped under backpressure. Backpressure: skip a client's snapshot when `bufferedAmount > 64 KB`, halve rate if 20 snapshots are unacked, close after 10 s without acks.

Client inputs are sent once per sim tick carrying the last 4 frames for redundancy, targeting `estimatedServerTick + inputLead`. The server holds the last frame when one is missing and caps the queue at 6.

### Client (`packages/net-client`)

```ts
class NetClient { connect(); sendInput(frame); reportRegions(loaded, loading); on(evt, cb); state; clock: NetClock; mirror: ReplicaWorld }
class NetClock { serverTickNow(); renderTick(); rttMs; jitterMs }   // min-filtered offset over 16 samples, slewed at ±2%, snap if >250 ms off
class ReplicaWorld { applySnapshot(s); read(e, c); sample(e, c, renderTick, out); visibleAt(renderTick); gc(beforeTick) }
class RegionClient { loaded(); loading(); on('regionLoaded' | 'regionUnloaded', cb) }   // RegionSet -> AssetLoader.acquireGroup -> RegionLoadState
```

Interpolation delay is 2 snapshot intervals (100 ms) plus a jitter margin. Sample rings hold 8 samples per interpolated component. Extrapolate at most one interval using `vel`, then hold. Reconnect with token resets replication state and takes the same full-snapshot path as initial spawn.

### Assets (`packages/assets`, `docs/assets.md`)

A manifest built by `conduit-assets build` maps logical asset ids to content-hashed URLs, with `groups` and `regions` (region id to asset ids). `AssetLoader` is Three-free: `acquire(id, priority)`, `acquireGroup(ids)`, refcount with a 5 s unload grace, dedupes in-flight loads, one backend per asset `type`. `GltfMetaBackend` reads the GLB JSON chunk in Node so the server can derive collider primitives and sockets without Three.

Blender conventions: metres, apply scale, +Y up export so forward is +Z; root named for the asset; LOD children `_LOD0/1/2`; colliders `_COL_box|sphere|capsule|convex`; sockets `SOCKET_<name>`; animations as separate named actions; `.glb`, no Draco in v1.

### Render (`packages/render`)

```ts
class RenderHost { renderer; scene; camera; setRenderFn(fn); start(); stop() }   // game may pass its own WebGLRenderer or composer
class RenderWorld { root; regionGroup(id); setFloatingOrigin(regionId); registerBinder(b); view(e); setCamera(c); setInput(src); cameraTarget(e); pushEvent(evt); onEvent(name, handler); update(dt) }
interface Binder<T> { component: ComponentType<T>; newest?: boolean; onAttach?(view, value); onUpdate?(view, value, interpolated); onDetach?(view) }
interface CameraController { attach(ctx); update(dt, ctx); detach() }
```

Core binders, registered in this order: `RegionBinder` (move between region groups), `TransformBinder` (interpolated sample to position/quaternion, region-local), `ModelBinder` (acquire asset, clone, THREE.LOD, sockets, animation mixer, hide colliders, emits `modelReady` so games restyle materials). `NetClient.update` owns `ReplicaWorld.gc`; the render world never calls it. Core cameras: `FollowCamera`, `OrbitCamera`, `TopDownCamera`. Views exist only while `createdTick <= renderTick < destroyedTick`, and a binder sees its component as of the render tick (a `newest` binder, as it comes).

### Game facade (`packages/game`)

```ts
export const game = defineGame({
  id: 'privateer', name: 'Privateer', protocolVersion: 1, tickRate: 60, snapshotEvery: 3, seed,
  components: [...], messages: [...], events: [...], input: InputFrame, systems: [...],
  world: (seed) => new GridWorld({...}),
});
createServer(game, { port, store?, regionLoader, hooks, secret } | { ..., devAuth: true });   // dev/test: one session, WsLink, token verified in-process
createHost([{ game, module }], { port, dbPath, secret, static?: dir });                        // production; `module` exports `game` and `sessionFactory = defineSessionFactory(game, id => ({ regionLoader, hooks }))`
createClient(game, { url?, lobby?: LobbyClient, canvas?, binders?, camera?, input?, sampleInput(ctx), onFrame?, onMessage?, onRegion? });
```

Hooks (`docs/net.md` A.5 shapes, `(player, ctx)` order): `onInit`, `onLoad`, `onSave`, `onPlayerJoin(player, ctx) → PlayerSpawn { regionId, spawn(ctx) }` (the spawn region is loaded first, then `spawn` creates the entity), `onPlayerLeave`, `onWorldEdge`, `relevance`, `onMessage`. `createClient` without a canvas is headless and never imports `three`, which is what integration tests and bot clients use.

## Consuming from a game repo

```
privateer/
  vendor/conduit-core/       git submodule, pinned commit
  apps/client/  apps/host/  shared/
  pnpm-workspace.yaml        packages: [vendor/conduit-core/packages/*, apps/*, shared]
  tsconfig.json              extends ./vendor/conduit-core/packages/tooling/tsconfig.base.json
```

Pitfalls and their mitigations, detailed in `docs/consuming.md`: pnpm ignores the nested workspace file and lockfile; `three` is pinned exactly once at the app and `render` only peers it, with `resolve.dedupe: ['three']` in the vite preset and a CI check that `pnpm why three` resolves one version; `server.fs.allow: ['..']` so vite serves submodule sources; no TypeScript project references; CI runs `git submodule update --init`. The host bundle is built with esbuild with `ws` and `hono` external.

## Reference game: `examples/sandbox`

Flat ground on a 2D `GridWorld` with 256 m cells. Each player is a coloured kinematic vehicle with throttle/steer input. A procedural `RegionLoader` seeds crates and one wandering AI per region. Chat message both ways and a "horn" event. A minimal DOM lobby menu (register, login, create or join by invite code) built on `lobby-client`. HUD shows tick, RTT, entity and region counts. Runs either through `createServer` (no lobby) or `createHost`.

## Milestones

**M0 Scaffold.** Root files, tooling package (tsconfig base, eslint factory with sim-purity and no-three rules, vite/vitest presets), CI. `@conduit/math` complete. `@conduit/protocol`: DSL, ByteWriter/Reader, codecs, registry + hash, envelope, defineMessage/defineInput. Empty sandbox that boots vite and a tsx server. Exit: install, typecheck, lint, test all green.

**M1 Something moving, multiplayer.** `@conduit/sim` (World, stores with version stamps, systems, Simulation.step, EventBus, FixedLoop, hash). `@conduit/net-server` (Session, ClientLink + WsLink, handshake with `devVerifier`, input queue, snapshot builder with "everything relevant" interest, backpressure). `@conduit/net-client` (connect, NetClock, ReplicaWorld, interpolation, input send). `@conduit/render` minimal (RenderHost, RenderWorld, TransformBinder, box placeholder for Model, FollowCamera). `@conduit/game` facade with `createServer`/`createClient`. Sandbox: two tabs see each other drive. Tests: determinism, delta-equals-full, headless two-client integration, codec bandwidth measurement, FixedLoop jitter histogram.

**M2 Assets, messages, events.** `@conduit/assets` loader and manifest, `conduit-assets` CLI, `ModelBinder` with GLTFLoader and LOD, OrbitCamera, custom messages and replicated events (sandbox chat and horn), `docs/assets.md`, one real Blender export round-trip.

**M3 World streaming.** `@conduit/world`: GridWorld, NodeWorld, RegionManager with linger and inbox migration, SpatialIndex. Interest becomes `wanted ∩ reported`. RegionSet/RegionLoadState, RegionClient driving asset groups, region groups with floating origin, RegionBinder. Sandbox drives far enough that regions unload behind you. Tests: border-thrash, migration atomicity, distant client receives nothing.

**M4 Persistence and reconnect.** `@conduit/persist` with MemoryStore, SqliteStore, migrate, Autosaver. Region save/load through RegionLoader, session onSave/onLoad, graceful shutdown flush. Reconnect with token and 120 s grace. `/healthz` and HUD bandwidth stats.

**M5 Lobby, auth, host.** `@conduit/auth`. `@conduit/lobby` service, routes, presence socket, SQLite tables. `@conduit/lobby-client`. `@conduit/host` with gateway, PortLink, SessionManager (start on first join, idle stop, crash isolation, graceful shutdown). Hello verifies real tokens. Sandbox lobby menu; two accounts create and join a session through the lobby. Playwright smoke through the host path. `docs/host.md` and `docs/consuming.md` verified by the CI consume job. Add core as a submodule to the first real game repo.

**M6 Headroom.** Replay recording and re-simulation as a regression test. Prediction seams exercised by a disabled-by-default reconciliation stub. Optional field-level masks for wide components. Node GLB metadata backend for server colliders and sockets. Standalone lobby mode serving several host processes. Postgres adapters only when a second machine exists.

## Verification

| Layer | Where | Proves |
| --- | --- | --- |
| math | `packages/math/test` | quat/vec invariants, Rng reproducible from seed |
| protocol | `packages/protocol/test` | property-based round-trip of every field type including quat and angle16 edge cases; registry ids stable under import-order permutation; hash changes when a schema changes |
| sim | `packages/sim/test` | same seed + input log twice gives identical per-tick hashes; replica built from deltas equals a full capture; stale EntityId rejected; query order deterministic |
| world | `packages/world/test` | grid and node locate/wanted; a player oscillating across a border for 2 min never unloads a region and never duplicates or loses an entity; inbox merges on activation |
| persist | `packages/persist/test` | SqliteStore round-trip in a scratch file, transaction rollback on throw, migrations idempotent, MemoryStore parity via a shared contract suite |
| auth | `packages/auth/test` | hash/verify, token round-trip, tampered or expired token rejected |
| lobby | `packages/lobby/test` | register/login/cookie flow, invite code join, visibility rules, session state transitions, presence events |
| host | `packages/host/test` | gateway rejects bad tokens, routes two clients to the same worker, worker crash does not kill HTTP, idle stop flushes state, PortLink backpressure reporting |
| net | `packages/net-server/test`, `packages/net-client/test` | FixedLoop holds 3600 ticks/min under a 2 ms body; a slow client keeps bufferedAmount bounded and still receives events in order; reconnect resync matches server stores; schema mismatch rejected cleanly |
| integration | `packages/game/test/headless.test.ts` | in-process server plus two headless clients on the sandbox game: hashes match, A's input moves A's entity as seen by B, distant client receives nothing, disconnect despawns, bandwidth per client measured against a 60 KB/s typical target; same suite run again through `createHost` and the lobby join flow |
| render | `packages/render/test` (jsdom) and `examples/sandbox/e2e/render-memory.spec.ts` (Playwright, real WebGL) | jsdom: binder attach/update/detach lifecycle, view lifecycle, cameras, GltfBackend dispose; e2e: acquire/release a region group 50 times returns renderer memory counts to baseline |
| e2e | `examples/sandbox/e2e/smoke.spec.ts` | Playwright registers two accounts, creates and joins a session via the menu, presses W in one page, asserts movement observed in the other, zero console errors |
| gates | CI | sim-purity lint, no `three` outside render (lint plus module-graph test), consume job that links `packages/*` from a throwaway workspace and asserts a single `three` |

## Risks to spike early

1. Codec size at 300 entities and 20 Hz. Measure in M1; target under 60 KB/s typical, 200 KB/s worst. (240 KB/s worst since the core `Transform.vel` became `f32`: PLAN.md Spike 1.)
2. Node timer jitter and GC pauses in a 60 Hz loop, and whether several workers on one machine interfere. Histogram FixedLoop intervals for 10 min with 4 workers.
3. Interpolation under jitter and background-tab throttling. Jitter proxy test in M2, tune delay and slew.
4. Fixed-point range for Spacehunter. Decided in M3 (Spike 4, docs/world.md §3): a star system is one `node` region using the core `Transform`. `fixed32(0.001)` replicates ±2,147 km per axis at 1 mm, over 20 times an Escape-Velocity-style system (planets within 50 km, a 100 km jump radius) flown at game speeds, and a ship at 327 m/s per axis, a third over cruise, needs 1 h 49 min of straight flight to leave it (velocity is replicated as `f32` and has no cap of its own). Regions do not subdivide and space games keep the core `Transform`; node regions never clamp, so a space game enforces its own system edge well inside that range.
5. Schema hash brittleness. Any component change forces a client reload. Confirm the Rejected path shows "please refresh" rather than a reconnect loop.
6. `node:sqlite` stability on the deployed Node version. Spike 6 (M4, docs/persist.md §1.1): the persist suite passes with no flag on Node 22.23.2, 24.21.0 and 26.7.0 (22.x prints an `ExperimentalWarning`, 24+ nothing). Only Node 22.5 to 22.12 needs `--experimental-sqlite`; without it `openNodeSqlite` throws an actionable error and the node:sqlite tests skip. A `better-sqlite3` fallback stays possible behind the same `SqliteStore` driver seam.
7. MessagePort relay cost between gateway and worker. Measure per-frame overhead in M5; batch frames per tick if it matters.

## Deliberately out of scope for v1

Client prediction, field-level dirty masks, WebTransport, physics engines and mesh colliders, cold simulation of inactive regions, cross-session persistent entity ids, Draco/KTX2, audio beyond raw fetch, animation state machines, automated matchmaking, OAuth, sharding, Postgres, registry publishing.
