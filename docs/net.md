# @conduit/net-server and @conduit/net-client

Session `flushAll` now captures region/session state together, publishes an atomic generation, coalesces one pending follow-up and refuses new post-fault captures. Inspect saved bytes using `openApplicationSave`; see [generation saves](generation-saves.md).

Two packages that move the wire format defined in docs/protocol.md between an authoritative `Session` and browser/headless clients. `net-server` (Node) owns the session lifecycle, input intake, snapshot building and backpressure (the fixed-timestep driver itself is `@conduit/sim`'s `FixedLoop`, docs/sim.md 2.10). `net-client` (isomorphic) owns connect/reconnect, the network clock, the replica world with interpolation, input sending and region loading.

Cross-references: ECS/`World`/`Simulation`/`SimContext` in docs/sim.md; `RegionManager`/`WorldGraph`/`SpatialIndex` in docs/world.md; `PortLink` and the gateway in docs/host.md; `AssetLoader` in docs/assets.md; binders that consume `ReplicaWorld.sample` in docs/render.md.

## Part A. `@conduit/net-server`

Dependencies: `@conduit/protocol`, `@conduit/sim`, `@conduit/world`, `@conduit/persist`, `@conduit/auth`, `ws`. `node:crypto` for reconnect tokens, `node:perf_hooks` for `performance.now()`. Nothing under `sim`/`world`/`protocol` is touched with wall-clock time; only this package reads clocks.

### A.1 Constants

| Name | Value | Meaning |
| --- | --- | --- |
| `DEFAULT_TICK_RATE` | `60` | sim Hz if the game does not say |
| `DEFAULT_SNAPSHOT_EVERY` | `3` | snapshot every Nth tick |
| `MAX_PLAYERS` | `8` | player ids 0..7; re-exported from `@conduit/sim` (docs/sim.md 2.9) |
| `HANDSHAKE_TIMEOUT_MS` | `5000` | Hello must arrive within this after `attach` |
| `RECONNECT_GRACE_MS` | `120000` | away → slot freed |
| `INPUT_QUEUE_MAX` | `6` | frames per client |
| `SENT_LOG_SIZE` | `32` | snapshot ring per client |
| `BACKPRESSURE_SKIP_BYTES` | `65536` | skip snapshot when `bufferedAmount()` exceeds this |
| `BACKPRESSURE_HALVE_OUTSTANDING` | `20` | outstanding snapshots above which rate halves |
| `ACK_TIMEOUT_MS` | `10000` | no Ack while snapshots outstanding → kick |
| `PENDING_EVENTS_MAX` | `256` | queued replicated events per client (oldest dropped) |
| `SNAPSHOT_SOFT_LIMIT_BYTES` | `60000` | creates beyond this are deferred to the next snapshot |
| `RTT_ALPHA` | `0.1` | EWMA weight |
| `RECONNECT_TOKEN_BYTES` | `24` | random bytes, base64url → 32 chars |
| `MAX_GAME_MESSAGES_PER_TICK` | `64` | per client; excess dropped and counted |
| `LINK_QUEUE_MAX` | `64` | messages a link queues before `onMessage` is registered (A.2) |
| `WS_CLOSE_TIMEOUT_MS` | `2000` | `WsLink.close` terminates a socket still open after this (A.2) |

### A.2 `ClientLink`

```ts
export interface ClientLink {
  id: number;                                       // unique per process, assigned by the creator (gateway or createServer)
  send(buf: Uint8Array): void;                      // takes ownership of buf; callers pass FrameWriter.finish() copies and never reuse them
  bufferedAmount(): number;                         // bytes queued and not yet handed to the kernel
  close(code?: number, reason?: string): void;
  onMessage(cb: (buf: Uint8Array) => void): void;   // one callback; a second call replaces the first
  onClose(cb: (code: number, reason: string) => void): void;
}
```

Guarantees a link must provide: messages are delivered in order, on the event loop (never re-entrantly from `send`); `onClose` fires exactly once, including after a local `close()`; messages that arrive before `onMessage` is registered are queued (bounded to 64, then the link closes with 4003) and flushed synchronously when it is registered; after `close()` no further `onMessage` calls occur. A close that happened before `onClose` was registered is reported from a microtask after registration, never from inside it. `QueuedLinkBase` implements these guarantees for transports that push messages in: subclasses call its public `deliver(buf)` per inbound message and `handleClosed(code, reason)` once the transport closed (`PortLink`, docs/host.md §21, uses the same two entry points).

`WsLink` (`ws-link.ts`):

```ts
export class WsLink implements ClientLink {
  constructor(socket: WebSocket /* from 'ws' */, id: number, opts?: { log?: (level: 'warn' | 'error', msg: string, data?: unknown) => void });   // log receives socket 'error' events; default console.warn
}
export function createWsServer(opts: { port?: number; host?: string; server?: http.Server; path?: string }): WebSocketServer;  // perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES
```

- Sets `socket.binaryType = 'arraybuffer'`. `perMessageDeflate` is `false` on the server (`createWsServer`) so `bufferedAmount` reflects real bytes and CPU is not spent compressing already-quantized data.
- `message` events: `isBinary === false` (text frame) → `close(4003, 'binary only')`. Binary → `cb(new Uint8Array(data))` (view over the ArrayBuffer, no copy).
- `send`: if `socket.readyState !== OPEN` → silently drop (the close path is already in flight). Else `socket.send(buf, { binary: true })`.
- `bufferedAmount()` → `socket.bufferedAmount`.
- `close(code = 1000, reason = '')` → `socket.close(code, reason)`; if the socket is still not closed after 2 s, `socket.terminate()`.
- `onClose`: fires on the ws `close` event; the ws `error` event is logged and followed by `close` from ws itself.

`PortLink` (worker side of a `MessagePort`) is specified in docs/host.md; it satisfies the same guarantees.

### A.3 Close codes

| Code | Sent by | Meaning | Client reconnects? |
| --- | --- | --- | --- |
| 1000 | either | normal (Leave / `disconnect()`) | no |
| 1001 | server | shutdown (`Kicked{ServerShutdown}` precedes) | after backoff, yes |
| 4000 | server | handshake timeout | yes |
| 4001 | server | wire version mismatch | no |
| 4002 | server | malformed frame (`DecodeError`) | yes |
| 4003 | server | protocol violation (text frame, Hello twice, message in wrong state) | no |
| 4004 | server | `Rejected{ProtocolVersion}` | no |
| 4005 | server | `Rejected{SchemaMismatch}` | no |
| 4006 | server | `Kicked{Replaced}` (a reconnect took over this player) | no |
| 4007 | server | `Kicked{AckTimeout}` | yes |
| 4008 | server | `Rejected{BadToken}` | no |
| 4009 | server | `Rejected{SessionFull}` | no |
| 4010 | server | `Rejected{SessionNotRunning}` | no |
| 4011 | server | `Kicked{Idle|ByHost|Protocol}` | no |
| 4012 | server | authoritative `SessionFault` | no |
| 4013 | server | declared compatibility mismatch | no |
| 4014 | server | insufficient client capacity limit | no |
| 4100–4199 | gateway / host (docs/host.md §17 `GATEWAY_CLOSE`) | reserved for the main-thread gateway, SessionManager and lobby; never sent by `Session` | `4110` (worker crashed) and `4111` (host shutting down) after backoff, yes; all others no |

`isReconnectableClose(code)` (net-client, B.9) encodes the last column of both ranges.

### A.4 Fixed loop

There is exactly one `FixedLoop`, in `@conduit/sim` (docs/sim.md 2.10). `Session` constructs it as

```ts
new FixedLoop({ tickRate: game.tickRate, onTick: t => runTick(t), onOverrun: n => dropTicks(n),
                now: opts.now, setTimeout: opts.timers?.setTimeout, clearTimeout: opts.timers?.clearTimeout })

dropTicks(n):                              // the loop fell more than MAX_CATCH_UP_TICKS behind (docs/sim.md 2.10)
  log('warn', 'dropped ticks', { n })
  if running and not in a tick: simulation.skip(n); recordLog?.skips.push([first skipped tick, n])
```

A loop held up drops ticks, and the world skips them, numbers and all, so that a tick stays where the
server's clock puts it and clients' clocks hold across the stall (B.4); a replay skips them too.

Session delegates scheduling to this loop. Authoritative pipeline stages commit together: outbound frames are
buffered until the tick succeeds. A mutating lifecycle, message, world-edge, system or tail callback
that throws faults the Session; it stops ticking/admitting clients, closes them with terminal code
4012 and refuses persistence capture of partial state. A save captured before the fault may finish.
Relevance callbacks remain isolated to one client's snapshot. Recovery requires a complete prior
checkpoint and game state, not continuing the partially executed tick. See docs/sim.md 2.9 for
`SimulationFault`; the loop's own tests live in `packages/sim/test/fixedLoop.test.ts`.

### A.5 `Session`

```ts
export interface SessionGameDef {                 // structural; defineGame's output satisfies it (docs/sim.md for the sim parts)
  id: string; protocolVersion: number; tickRate: number; snapshotEvery: number; seed: number;
  registry: SchemaRegistry; input: Schema<InputFrameBase>;
  systems: readonly System[]; components: readonly ComponentType<unknown>[];
  world(seed: number): WorldGraph;
}
export interface PlayerInfo { playerId: number; accountId: string; displayName: string; state: PlayerState; entity: EntityId }
export interface PlayerSpawn { regionId: RegionId; spawn(ctx: HookContext): EntityId }
export interface HookContext extends SimContext { readonly session: Session }   // the Session's single SimContext plus a back-reference; built once in start()
export interface SessionHooks {
  onInit?(ctx: HookContext): void;
  onLoad?(ctx: HookContext, blob: Uint8Array | null): void;
  onSave?(ctx: HookContext): Uint8Array;
  onPlayerJoin(player: PlayerInfo, ctx: HookContext): PlayerSpawn;     // choose spawn region now; create the entity later when asked
  onPlayerLeave?(player: PlayerInfo, ctx: HookContext): void;          // entity still alive; Session destroys it afterwards if still alive
  onWorldEdge?(entity: EntityId, ctx: HookContext): void;              // see docs/world.md
  relevance?(player: PlayerInfo, entity: EntityId, ctx: HookContext): boolean;
  onMessage?(player: PlayerInfo, def: MessageDef, payload: unknown, ctx: HookContext): void;
}
export interface SessionOptions {
  store: BlobStore; regionLoader: RegionLoader; hooks: SessionHooks;
  verifier?: TokenVerifier;                        // docs/persist.md 2.4; required when attach() is called without an identity (createServer path)
  sessionId?: string;                              // must equal SessionToken.sessionId of joiners; default game.id (createServer passes 'dev', docs/game.md)
  maxPlayers?: number;                             // ≤ MAX_PLAYERS
  now?: () => number;                              // default performance.now
  timers?: { setTimeout; clearTimeout };           // injectable for tests
  manualLoop?: boolean;                            // true: no FixedLoop; tests call step() (and skip(n))
  reconnectGraceMs?: number; ackTimeoutMs?: number;   // ms ≥ 0 (RangeError otherwise); defaults RECONNECT_GRACE_MS, ACK_TIMEOUT_MS
  log?: (level: 'info'|'warn'|'error', msg: string, data?: unknown) => void;   // SessionLog: the same shape as docs/game.md ServerContext.log; default: warn/error to the console
  autosaver?: (save: () => Promise<void>) => SessionAutosaver;   // the Autosaver hookup: called once by the constructor with save = flushAll; e.g. save => new Autosaver(save, AUTOSAVE_INTERVAL_MS, { onError }) (docs/persist.md 1.8)
  recordLog?: InputLog;                            // (M6) replay recording (docs/sim.md 2.11), below; an empty version 1 log with the game's seed and tickRate, else RangeError
}
export interface SessionAutosaver { start(): void; stop(): Promise<void> }   // persist's Autosaver satisfies it; start() at the end of start(); stop() once, from stop(): cancels the periodic saves and performs the final save, which is the shutdown flush
// every optional SessionOptions field also accepts `undefined`, so callers can pass their own options straight through
export class Session {
  constructor(game: SessionGameDef, opts: SessionOptions);
  readonly id: string; readonly world: World; readonly regions: RegionManager; readonly tick: number;
  readonly simulation: Simulation; readonly spatial: SpatialIndex; readonly ctx: HookContext;   // ctx valid after start()
  // `spatial` is @conduit/world's SpatialIndex (docs/world.md §8.2) and ctx.spatial, rebuilt in the step tail right after membershipSystem (pipeline step 5); it satisfies the exported structural type `SessionSpatial` (SpatialApi + rebuild(ctx)). (M1 used a stub whose queries found nothing.)
  readonly graph: WorldGraph; readonly interest: InterestPolicy; readonly stats: SessionStats; readonly running: boolean;
  start(): Promise<void>;                          // store 'session'/'state': onLoad(ctx, blob) if it exists, else onInit(ctx); then sessionStartMs = now(), the loop starts, then autosaver.start()
  stop(): Promise<void>;                           // idempotent: stop loop, Kicked(ServerShutdown) + close(1001) on every bound link (no onPlayerLeave), then the final save (autosaver.stop() when there is an autosaver, else flushAll), resolving once it completed; a start() still loading finishes first; a session whose load failed or never ran saves nothing
  step(): void;                                    // run exactly one tick (manualLoop)
  skip(n: number): void;                           // skip n ticks as the loop does those it drops, recorded (manualLoop)
  attach(link: ClientLink, identity?: SessionToken, opts?: AttachOptions): void;   // AttachOptions { tokenExpired?: boolean }: the gateway's verdict on identity's token (gateway path)
  players(): readonly PlayerInfo[];
  send<T>(playerId: number, def: MessageDef<T>, payload: T): void;    // s2c/both game message, encoded now (RangeError / EncodeError thrown to the caller), queued into the client's next frame; dropped when the player has no bound link
  broadcast<T>(def: MessageDef<T>, payload: T): void;
  kick(playerId: number, reason: KickReason): void;                   // Kicked{reason} then close(4011); lifecycle *leave* follows
  tickStats(): TickStats;
  flushAll(): Promise<void>;                       // regions.flushAll + onSave → store 'session'/'state' (onSave only once start() loaded the session); calls never overlap: one made while another is in flight runs after it
}
export interface TickStats { tick: number; players: number; entities: number; regionsActive: number; tickMsAvg: number; tickMsMax: number; dropped: number; wakeLateness: WakeLatenessStats; bytesOutPerSec: number; perClient: { playerId; rttMs; buffered; outstanding; bytesOutPerSec }[]; counters: SessionStats }   // tickMs over the last 64 ticks
export interface WakeLatenessStats { wakes: number; p50Ms: number; p99Ms: number; maxMs: number; bucketMs: number; histogram: number[] }   // stats.ts; cumulative since start()
```

**Replay recording (M6).** With `recordLog` the constructor installs `recordInputs(simulation, recordLog)` (docs/sim.md 2.11), so every `simulation.step(t)` records the frames it consumes (`conn.held`, placed in step 3) whenever a player's frame changes, and `[t, playerId, null]` when a frame goes away (away, leaving). The lifecycle (step 2, A.6) appends `[t, playerId, event]` to `recordLog.lifecycle` (created when absent) as it runs each step: `{ type: 'join', accountId, displayName }` right before `onPlayerJoin` (`accountId` is `identity.accountId`, `displayName` the clipped one the hooks see), `{ type: 'spawn' }` right before `PlayerSpawn.spawn`, and `{ type: 'leave' }` at the start of every *leave*, also of a player whose join never ran or failed. A failed join or spawn is therefore recorded followed by its *leave* in the same tick. The ticks the loop drops are recorded as `[firstTick, n]` in `recordLog.skips` (created when absent). Game messages are not recorded. `replay` through `@conduit/game`'s `createReplayRun` (docs/game.md 2) rebuilds the session's world tick for tick, provided each region load the session starts settles before its next tick runs: true with a `MemoryStore` or `SqliteStore` when every wake of the loop runs one tick, and with `manualLoop` when the caller yields a macrotask between `step()` calls. A catch-up wake that runs several ticks, or a store answering from another thread (the host's `ProxyBlobStore`), can shift an activation by a tick, and the replay then fails at the next checkpoint.

`tickStats()` loop health: `dropped` is the FixedLoop's `droppedTicks` (docs/sim.md 2.10). `wakeLateness` records the loop's `stats().lastLateMs` once per wake, at the first tick the wake runs (a wake runs up to `MAX_CATCH_UP_TICKS`; one that runs none is not recorded), into a `LatenessHistogram` (`stats.ts`): 64 buckets of `bucketMs` 0.25 ms as in Spike 2a, where `histogram[i]` counts lateness in `[i, i + 1) × bucketMs`, bucket 0 also early (negative) wakes and bucket 63 everything from 15.75 ms. The counts are cumulative since `start()`, so a monitor diffs two samples for the distribution of an interval. `p50Ms`/`p99Ms` are the upper edge of the bucket holding the nearest-rank quantile, capped at `maxMs` (the true quantile is at most this; the open last bucket answers `maxMs`); `maxMs` is exact. With `manualLoop` nothing is recorded (all zero). The host serves each worker's latest `TickStats` on `/healthz` (docs/host.md §22).

`attach(link, identity?, opts?)`: one flow for both deployments. The `Hello` frame always arrives through the link as its first message. In the gateway path (docs/host.md §18, §21) the main thread has already verified the token and passes `identity`, which is authoritative, with `opts.tokenExpired`, its verdict on the token's expiry (an expired token passes the gateway only with a reconnect token and then rebinds only the player that token names, A.6; without the option the Session decides from `identity.exp` when the Hello arrives); the Session does not re-verify (it has no secret) and only checks `protocolVersion`/`registryHash`. In the `createServer` path (docs/game.md §2) `attach(link)` is called without an identity; on `Hello` the Session runs `opts.verifier.verify(hello.sessionToken, { displayName: hello.displayName })` and uses the result as the identity (`null` → `Rejected{BadToken}`, close 4008). `attach` without an identity and without a `verifier` throws.

#### Tick pipeline (`runTick(t)`), in order

The order is the canonical one in docs/sim.md 2.9 and is not restated in full here:

```
1. tickStartMs = now(); serverTimeMs = (tickStartMs − sessionStartMs) >>> 0
2. lifecycle: process pending joins (onPlayerJoin), spawns (plan.spawn), leaves/grace expiries (onPlayerLeave + destroy)   // A.6
3. drain inputs for every playing client (A.7); dispatch queued c2s game messages to hooks.onMessage (≤ MAX_GAME_MESSAGES_PER_TICK each)
4. regions.update(playerEntities(), ctx, pendingSpawnRegions())     // every tick, before step (docs/world.md 5.2); pending = plan.regionId of conns in joined/loading/ready
5. simulation.step(t)                                               // phases, tail [membershipSystem, spatial.rebuild], applyDestroys, events.endTick (docs/sim.md 2.9)
6. for ev of events.drainOutbox(): queue to interested playing clients (A.8.3)
7. if t % snapshotEvery === 0:
     for each playing client: refreshRegionSet(conn); buildAndSend(conn, t)   // A.8, A.9; queued events ride in the snapshot frame; a rebound client gets neither snapshot nor Events until it re-reported its regions (A.6)
     then send Events in their own frame for playing clients that got no snapshot frame this tick (halved rate, snapshot too large or failed) and are not backpressured
8. flush queued game messages (outbox) in their own frame for clients that got no snapshot frame this tick and are not backpressured
9. record tick duration
```

Step 7 from M3 (PLAN.md): `refreshRegionSet` sends `RegionSet{ active, prefetch }` built from `interest.wantedForRegion`/`prefetchForRegion` (A.8.2), and the snapshot interest is `wantedRegions ∩ reportedRegions` (A.8.1): a wanted region reaches a client's snapshots and events only once the client reported it loaded, and a reported region that is not wanted contributes nothing. (M1 sent `prefetch: []` and used `wantedRegions` alone.)

`world.tick` is advanced by `simulation.step`; the Session never sets it. The `SimContext` (as `HookContext`) is built once in `start()` with `inputs: p => conn(p).held`. Lifecycle and message dispatch run inside the tick so hooks always see a consistent context; message parsing itself happens on arrival. Because `applyDestroys` runs inside `step`, the snapshot built in step 7 for tick `t` already reports entities destroyed during tick `t`.

### A.6 `ClientConn` and the server-side state machine

```ts
export type ConnState = 'handshaking' | 'joined' | 'loading' | 'ready' | 'playing' | 'away' | 'closed';
export interface SentSnapshot { tick: number; sentAtMs: number; bytes: number }
export interface QueuedInput { frame: InputFrameBase; seq: number }
export interface ClientConn {
  id: number;                          // link.id at last bind
  playerId: number;                    // 0..7
  state: ConnState;
  link: ClientLink | null;             // null while away
  identity: SessionToken | null;       // null until the Hello verified (createServer path)
  displayName: string;
  reconnectToken: string;
  plan: PlayerSpawn | null;
  entity: EntityId;                    // ENTITY_NONE until spawned
  awaySince: number;                   // ms, valid in 'away'
  handshakeTimer: unknown;
  // input
  inputQueue: QueuedInput[];           // ascending tick, ≤ INPUT_QUEUE_MAX
  lastInputSeq: number;                // seq of the newest Input message accepted
  lastInputTick: number;               // highest frame tick accepted into the queue
  held: InputFrameBase | undefined;    // frame exposed via ctx.inputs
  appliedTick: number; appliedSeq: number;   // tick/seq of the held frame when it was popped (Snapshot header)
  // replication
  baselineTick: number;                // tick of the last snapshot sent; 0 = none
  lastAckedTick: number;
  lastAckAtMs: number;
  sentLog: SentSnapshot[];             // ring, SENT_LOG_SIZE
  known: Set<EntityId>;
  fullNext: boolean;                   // next snapshot gets FULL
  reportedRegions: Set<RegionId>;      // from RegionLoadState.loaded
  regionsReported: boolean;            // a RegionLoadState arrived since the last bind; a rebound conn gets no snapshot or Events before it
  wantedRegions: Set<RegionId>;        // RegionSet.active last sent
  prefetchRegions: Set<RegionId>;
  pendingEvents: ReplicatedEvent[];    // docs/sim.md 2.8 shape; ≤ PENDING_EVENTS_MAX
  outbox: { def: MessageDef; payload: unknown; kind: number; bytes: Uint8Array }[];   // game messages to include in the next frame, encoded when queued
  // lifecycle bookkeeping: joinQueued, joinRan, readyPending, spawnQueued, leaveQueued; gameMessagesQueued (per-tick cap); playerId is -1 until the Hello is accepted
  snapshotDivisor: 1 | 2; snapshotPhase: number;
  // stats
  rttMs: number;                       // EWMA from Ack timing
  outstandingSnapshots(): number;      // count of sentLog entries with tick > lastAckedTick
  seqOut: number; seqIn: number; bytesOut: number;
}
```

`outstandingSnapshots()` is computed, not stored, so it stays correct after ring eviction (max 32).

#### Transitions

| From | Trigger | Actions | To |
| --- | --- | --- | --- |
| — | `attach(link, identity?, opts?: AttachOptions)` (`AttachOptions { tokenExpired? }`, gateway path only) | create conn `{state: handshaking, identity}` and keep `opts.tokenExpired` for it (the gateway's verdict on the token, docs/host.md §17); start `HANDSHAKE_TIMEOUT_MS` timer; `link.onMessage/onClose` bound | handshaking |
| handshaking | Hello, no identity was given to `attach` | `identity = verifier.verify(hello.sessionToken, { displayName: hello.displayName }, now, { allowExpired: hello.reconnectToken !== '' })` (docs/persist.md 2.4); `null` → `Rejected{BadToken, detail: "bad token"}`, `close(4008)` (checked before the rows below) | handshaking / closed |
| handshaking | timer fires | `close(4000)` | closed |
| handshaking | any message other than Hello | `close(4003)` | closed |
| handshaking | Hello with `protocolVersion ≠ game.protocolVersion` | send `Rejected{ProtocolVersion, detail: "server=<v> client=<v>"}`; `close(4004)` | closed |
| handshaking | Hello with `registryHash ≠ registry.hash` | `Rejected{SchemaMismatch, detail: "please refresh"}`; `close(4005)` | closed |
| handshaking | `identity.sessionId ≠ session.id`, or the token is expired (the kept `tokenExpired` verdict, else `isTokenExpired(identity, now)`, docs/persist.md 2.3) and the Hello matches no conn to reconnect (the reconnect row below) | `Rejected{BadToken}`; `close(4008)`. Session tokens live 10 minutes but a player may reconnect much later, so an expired token (accepted only with a non-empty `reconnectToken`, by the gateway, docs/host.md §17, or by the verifier row above) resumes the player it names and never joins fresh | closed |
| handshaking | session stopping | `Rejected{SessionNotRunning}`; `close(4010)` | closed |
| handshaking | `reconnectToken ≠ ''` and a conn `c` exists with `c.reconnectToken === token && c.identity.accountId === identity.accountId` | **reconnect path**: if `c.link` non-null: send `Kicked{Replaced}` on it, `close(4006)`, unbind. Only a `c` in `playing` or `away` matches. Rebind `c.link = link`, `c.id = link.id`, `c.seqOut = 0`, `c.seqIn` continues from the Hello on the new link; clear handshake timer; discard the new conn object. Reset replication (`resetReplication`): `known = ∅`, `baselineTick = 0`, `lastAckedTick = 0`, `sentLog = []`, `fullNext = true`, `reportedRegions = ∅`, `regionsReported = false`, `wantedRegions = prefetchRegions = ∅`, `pendingEvents = []`, `outbox = []`, `inputQueue = []`, `lastInputTick = lastInputSeq = 0` (the new link's input stream starts over), `held = undefined`, `appliedTick = appliedSeq = 0`, `snapshotDivisor = 1`, `lastAckAtMs = now`. Send on the new link in this order: `Welcome` (with `c.playerId` and `c.reconnectToken`, unchanged), `SessionState`, `RegionSet` (recomputed), and `Spawned{c.playerId, c.entity, regionOf(entity)}` if `c.entity ≠ NONE`. Broadcast `SessionState` (state Playing) to others. No `Snapshot` or `Events` goes to the conn until its first `RegionLoadState` on the new link (which, in any accepted state, sets `reportedRegions = loaded` and `regionsReported = true`); the snapshot after it is FULL with `baselineTick 0` over `wanted ∩ reported`, and events queued meanwhile (global ones) ride its frame. | `playing` (entity exists) — reconnect is only possible from `away`, and `away` is only entered from `playing` |
| handshaking | Hello valid, fresh (or unknown reconnectToken) and active player count `≥ maxPlayers` | `Rejected{SessionFull}`; `close(4009)` | closed |
| handshaking | Hello valid, fresh | `playerId` = lowest free 0..maxPlayers−1; `reconnectToken = base64url(randomBytes(24))`; `displayName = hello.displayName || identity.displayName`; clear timer; send `Welcome{playerId, reconnectToken, tickRate, snapshotEvery, tick, serverTimeMs, seed}`; queue lifecycle *join*; send `SessionState` to all (new player `Joined`) | joined |
| joined | tick lifecycle *join* | `plan = hooks.onPlayerJoin(player, ctx)`; from now `pendingSpawnRegions()` includes `plan.regionId` so `RegionManager.update` activates it. A throw, or a `plan.regionId` the world graph does not know, faults the authoritative session, aborts publication and closes clients with terminal `SessionFault` + 4012 | joined |
| joined | `Ready` received (after *join* ran; if before, buffered until it has) | `wanted = interest.wantedForRegion(plan.regionId)`, `prefetch = interest.prefetchForRegion(plan.regionId)` (`InterestPolicy`, docs/world.md §9); send `RegionSet{active: sorted(wanted), prefetch: sorted(prefetch)}`; `wantedRegions = wanted`; `prefetchRegions = prefetch` | loading |
| loading | `RegionLoadState` | `reportedRegions = loaded`; if `wantedRegions ⊆ reportedRegions` → queue lifecycle *spawn*; broadcast `SessionState` (Ready) | ready (else stays loading) |
| ready | tick lifecycle *spawn*, and `regions.active()` contains `plan.regionId` | `entity = plan.spawn(ctx)` (must be alive and located in an active region, else the authoritative session faults, aborts publication and closes clients with terminal `SessionFault` + 4012); broadcast `Spawned{playerId, entity, regionOf(entity)}` to every conn in loading/ready/playing; broadcast `SessionState` (Playing); `fullNext = true`; `lastAckAtMs = now` | playing |
| ready | *spawn* queued but region not yet active | wait; retried each tick | ready |
| playing | link `onClose` | `link = null`; `awaySince = now`; `inputQueue = []`; `held = undefined`; broadcast `SessionState` (Away) | away |
| playing | Ack timeout (A.10) | send `Kicked{AckTimeout}`; `close(4007)`; then as link close | away |
| playing | `Leave` | `close(1000)`; queue lifecycle *leave* | closed (after *leave* runs) |
| joined / loading / ready | link `onClose` or `Leave` | no grace (no entity to keep); queue lifecycle *leave* (which calls `onPlayerLeave` only if *join* ran) | closed |
| away | reconnect Hello (row above) | rebind | playing |
| away | `now − awaySince ≥ reconnectGraceMs` (checked in lifecycle, after spawns) | queue lifecycle *leave*; it runs in the same lifecycle pass, so the entity is destroyed in this tick's step and reported in its snapshots | closed |
| any | `stop()` | send `Kicked{ServerShutdown}` to bound links; `close(1001)` | closed |

A conn that leaves (Leave, link close before spawn, kick, grace expiry) is `closed` at once with *leave* queued; its slot stays taken until the *leave* runs in the next tick's lifecycle, and a *join* still queued for it is skipped. Lifecycle *leave*: `hooks.onPlayerLeave?.(player, ctx)` (only if *join* ran); if `world.alive(entity)` → `world.destroy(entity)`; free `playerId`; remove conn; broadcast `SessionState`. `Session.kick(playerId, reason)` sends `Kicked{reason}`, calls `close(4011)` and queues *leave* (no reconnect grace).

While away the player's input is released: `inputQueue` and `held` are cleared, so `ctx.inputs(playerId)` is `undefined` from the next tick until the rebound client sends input. A Hello whose `reconnectToken` matches no playing or away conn of its account (empty, unknown, stale after the grace expired or after a drop before spawn, or another account's) is a fresh join, even when that account already holds a slot. A fresh join always gets a new `reconnectToken` while a rebind's `Welcome` repeats the old one; its `playerId` is the lowest free slot and may equal the one the client had (after the grace expired), so the token, not the `playerId`, tells a client which of the two happened.

Message acceptance by state (anything else is ignored and counted in `stats.ignoredMessages`; `Hello` outside handshaking → `close(4003)`):

| Message | Accepted in |
| --- | --- |
| Hello | handshaking |
| Ready | joined |
| Input | playing |
| Ack | playing |
| Ping | joined, loading, ready, playing (answered immediately, outside the tick) |
| RegionLoadState | loading, ready, playing |
| Leave | joined, loading, ready, playing |
| game c2s/both | joined, loading, ready, playing (queued, dispatched in step 3) |

Frame handling on arrival: `readFrame`; every message of the frame is decoded before any is handled, so a `DecodeError` discards the whole frame → `log('warn')`, `stats.badFrames++`, `close(4002)`, or `close(4001)` for `DecodeError('version')` (→ away if playing, else closed). `seqIn` gap → `stats.seqGaps++`. Unknown kinds skipped.

Every outgoing frame for a client is assembled by `FrameWriter` with `tick = world.tick`, `seq = conn.seqOut++ mod 65536`. Small messages sent outside the snapshot path (Welcome, Pong, SessionState, …) each go in their own frame immediately.

Declared simulation compatibility is checked after protocolVersion/registryHash and before
slot allocation or reconnect rebinding. Session copies and freezes its descriptor at construction;
caller mutations cannot switch active rules. `Rejected{Compatibility}` (reason 5, close 4013)
names differing revision/digest fields without showing digest values or gameplay data. Details
are clipped to the UTF-8 wire limit. Welcome carries the accepted descriptor; clients validate it
against their own pinned offer and expose it as readonly `net.compatibility`. See docs/game.md
for deliberate schema-only migration mode and docs/protocol.md for the coordinated wire 2 rollout.

### A.7 Input intake

On `Input` arrival (state `playing`):

```
if frames.length == 0 or frames[0].tick != firstTick or not strictly ascending: stats.badInput++; return
for frame in frames:
  if frame.tick <= conn.lastInputTick: continue                 // duplicate from the 4-frame redundancy or late
  if frame.tick < serverTick - maxStaleTicks or frame.tick > serverTick + maxFutureTicks: stats.badInput++; continue
  conn.inputQueue.push({ frame, seq: header.seq })              // the queue owns the frame: the Session decodes every Input payload afresh
  conn.lastInputTick = frame.tick
  if conn.inputQueue.length > capacity: conn.inputQueue.shift(); stats.inputOverflow++
conn.lastInputSeq = header.seq
```

Sessions default to a 32-tick future window, 2-tick stale tolerance and capacity 35. Configure
`SessionOptions.inputQueue` to change these bounds (future/stale 0..256, capacity 1..513).
Rejected targets never advance the accepted watermark. The default replaces the six-frame
queue for sessions; the standalone acceptInput helper retains its six-frame behavior when no
server tick bounds are supplied. Client `maxInputLeadTicks` defaults to 32 (1..256); deployments
raising it must configure a matching server window/capacity. Lead adapts to half RTT plus one
tick within that ceiling; latency beyond this supported range may miss inputs, so choose the
limit deliberately. Bounds are configuration, not wire negotiation.

Drain at sim tick `T` (pipeline step 3):

```
q = conn.inputQueue
while q.length > 0 and q[0].frame.tick < T: q.shift(); stats.staleInputs++    // arrived too late; held frame covers it
if q.length > 0 and q[0].frame.tick == T:
  entry = q.shift(); conn.held = entry.frame; conn.appliedTick = T; conn.appliedSeq = entry.seq
else:
  stats.missingInputs++                                          // hold previous conn.held unchanged
```

`ctx.inputs(playerId)` returns `conn.held` (the frame for `T` if it arrived, otherwise the most recently applied frame; `undefined` if none ever). The Snapshot header carries `appliedTick`/`appliedSeq`. Input is never throttled or dropped for backpressure.

### A.8 Snapshot builder

`snapshot-builder.ts` is FixedLoop-free and depends only on an abstract source so it is unit-testable:

```ts
export interface SnapshotSource {
  registry: SchemaRegistry;
  entitiesIn(region: RegionId): Iterable<EntityId>;         // regions.entitiesIn
  regionOf(e: EntityId): RegionId | null | undefined;
  store(compId: number): { has(e): boolean; read(e): unknown; version: Uint32Array; removedAt: Uint32Array };
  slot(e: EntityId): number;                                 // index into version/removedAt (docs/sim.md)
  relevance?: ((e: EntityId) => boolean) | undefined;        // bound to (player, ctx)
}
export interface ReplicationState { known: Set<EntityId>; baselineTick: number; fullNext: boolean }
export function buildSnapshot(src: SnapshotSource, rs: ReplicationState, interestRegions: Iterable<RegionId>, tick: number, header: Omit<SnapshotHeader,'baselineTick'|'flags'|'serverTick'>): SnapshotData;
```

```
buildSnapshot(src, rs, interestRegions, tick, hdr):
  interest = Set()
  for r in interestRegions:                                   // wanted ∩ reported, computed by the caller
    for e in src.entitiesIn(r):
      if src.relevance and not src.relevance(e): continue
      interest.add(e)

  creates = []; updates = []; destroys = []
  regions = []; regionIdx = Map()                             // local table, first-use order
  idxOf(r) = r == null ? REGION_IDX_NONE : (regionIdx.get(r) ?? (regions.push(r), regionIdx.set(r, regions.length−1), regions.length−1))

  for e in sorted(interest):                                  // ascending id
    if not rs.known.has(e):
      comps = []
      for c in src.registry.replicated:                       // ascending id
        st = src.store(id(c)); if st.has(e): comps.push({ id: id(c), value: st.read(e) })
      creates.push({ entity: e, regionIdx: idxOf(src.regionOf(e)), components: comps })
    else:
      changed = []; removed = []
      for c in src.registry.replicated:
        st = src.store(id(c)); s = src.slot(e)
        if st.has(e):
          if st.version[s] > rs.baselineTick: changed.push({ id: id(c), value: st.read(e) })
        else if st.removedAt[s] > rs.baselineTick: removed.push(id(c))
      if changed.length or removed.length: updates.push({ entity: e, components: changed, removed })

  for e in sorted(rs.known): if not interest.has(e): destroys.push(e)

  flags = rs.fullNext ? SNAPSHOT_FLAG_FULL : 0                // known is empty whenever fullNext, so creates == interest
  data = { header: { serverTick: tick, baselineTick: rs.fullNext ? 0 : rs.baselineTick, flags, ...hdr }, regions, creates, updates, destroys }
  return data                                                 // caller commits rs only after a successful send: commitSnapshot(rs, data, createsWritten) (A.8.1)
```

Notes: `store.version`/`removedAt` are stamped with the tick of the write (docs/sim.md); because the baseline is the last snapshot *sent* and WebSocket is ordered and reliable, `version > baselineTick` is exactly "changed since the client's last view". A component added, removed and re-added between snapshots shows as changed (has + version). A component removed and not re-added shows in `removed` once (its `removedAt` stays > baseline only until the next snapshot moves the baseline). Entities destroyed on the server disappear from `entitiesIn` and thus from interest → `destroys`; slot reuse yields a new generation so the id differs.

#### A.8.1 Committing and encoding per client

`buildAndSend` prepares a detached logical snapshot and queues bounded ordered frames. With budgeting disabled it uses the complete builder above. With `SessionOptions.replication` enabled, `ReplicationPlanner` compares each client's admitted quantized component and field encodings, selects whole dependency groups, and retains unselected dirty values independently of the global baseline.

A logical payload that exceeds one wire message is carried by `SnapshotPart`. The client validates and assembles all parts before applying or acknowledging it. The server reserves egress credits when queueing a frame and commits the replication image only after the final frame is actually handed to the same live link. Dropped or failed frames refund reservations; reconnect starts a new FULL population. Unsupported indivisible groups, negotiated limits, or required control frames fail explicitly for that peer.

Selected groups carry their own `stateTick`. Required prediction groups can defer at an older coherent tick while the global snapshot advances. Prediction adapters reconcile from the group's admitted tick after checking all dependency members agree. Lifecycle tombstones and surviving dependency members are selected together. Aging reserves occasional first service for the oldest optional group even under required-group pressure.

See [bounded replication](bounded-replication.md) for defaults, supported bounds, field masks, event dependencies, queue ceilings, control reserves and failure/recovery behavior. `encodeSnapshotBounded` remains a legacy helper and is no longer the Session delivery path; oversized update populations make progress through complete bounded transactions.

#### A.8.2 RegionSet refresh (`refreshRegionSet`, playing clients, snapshot ticks)

```
r = regions.regionOf(conn.entity) ?? conn.plan.regionId
wanted = Set(interest.wantedForRegion(r)); prefetch = Set(interest.prefetchForRegion(r))     // docs/world.md §9
if wanted ≠ conn.wantedRegions or prefetch ≠ conn.prefetchRegions:
  conn.wantedRegions = wanted; conn.prefetchRegions = prefetch
  send RegionSet{ active: sorted(wanted), prefetch: sorted(prefetch) }   // own frame, before the snapshot
```

#### A.8.3 Replicated events

After `simulation.step` (pipeline step 6), `events.drainOutbox()` (docs/sim.md 2.8) returns this tick's replicated events as `ReplicatedEvent { typeId, tick, regionId | undefined, payload }` (the bus keeps at most `MAX_OUTBOX = 4096` between drains). Each is queued to every conn in `playing` for which `regionId === undefined || (conn.wantedRegions ∩ conn.reportedRegions).has(regionId)`. Queue is `pendingEvents` (per-client cap `PENDING_EVENTS_MAX = 256`, drop oldest with `stats.eventsDropped++`). On the wire `eventId = typeId` and `regionIdx = REGION_IDX_NONE` when `regionId` is undefined. Events are sent in the same frame as the next snapshot that goes through (A.8.1) so a client never sees an event for a tick ahead of its latest snapshot; events drained on other ticks wait for the next snapshot tick. If a client gets no snapshot frame on a snapshot tick but is not backpressured (halved rate, or its snapshot failed to build or encode), its events are sent in their own frame at step 7. Payloads are already copies (the bus copies on `emit`).

Before queueing, each drained event is encoded once as a payload of its own (`encodeEvents` of `eventsData([ev])`): an event that is not a replicated registry event, whose payload does not fit its schema (e.g. a `u8` of 300), whose region id exceeds 64 bytes, or whose own payload exceeds `MAX_PAYLOAD_BYTES` reaches no client and is logged once (`log('error', 'tick <t>: replicated event <name> dropped')`, `stats.tickErrors++`). When sending, `takeEvents(conn)` empties the queue into one `EventsData` (region table in first-use order); if `fw.message` throws `EncodeError('payload' | 'count')` for it (over `MAX_PAYLOAD_BYTES`, or more than `MAX_REGION_TABLE` regions), `splitEvents` halves it in order and each half is written the same way, so a large backlog becomes several consecutive `Events` messages. Before each `Events` message a new frame is started when the open one holds 255 messages or might not hold another `MAX_PAYLOAD_BYTES`. A conn that leaves `playing` (away, leave) forgets its queued events; a rebind resets them too, and what queues before the rebound client's first report waits for its FULL snapshot frame (A.6).

### A.9 Ack

On `Ack{lastSnapshotTick}` (playing): if `lastSnapshotTick > conn.lastAckedTick` and `lastSnapshotTick ≤ conn.baselineTick` (an ack of a snapshot never sent is ignored): `conn.lastAckedTick = lastSnapshotTick`; `conn.lastAckAtMs = now`; if `sentLog` contains an entry with `tick === lastSnapshotTick`: `sample = now − entry.sentAtMs; conn.rttMs = conn.rttMs === 0 ? sample : conn.rttMs + RTT_ALPHA × (sample − conn.rttMs)`.

### A.10 Backpressure

Evaluated per playing client on every snapshot tick before building, in this order: ack timeout, `updateDivisor`, `refreshRegionSet` (A.8.2), then in `buildAndSend` the halved-rate check and the skip rule. Queued game messages of a skipped client wait for its next frame:

| Rule | Condition | Effect |
| --- | --- | --- |
| skip | `link.bufferedAmount() > BACKPRESSURE_SKIP_BYTES` | no snapshot this tick; `known`/`baseline` untouched; events stay queued |
| halve | `outstandingSnapshots() > BACKPRESSURE_HALVE_OUTSTANDING` | `snapshotDivisor = 2`, `snapshotPhase = (t / snapshotEvery) % 2` when entering; back to `1` when `outstanding ≤ 20` |
| ack timeout | `outstandingSnapshots() > 0 && now − lastAckAtMs > ACK_TIMEOUT_MS` | `Kicked{AckTimeout}`, `close(4007)`, → away |
| input | — | never throttled |

`lastAckAtMs` is set at spawn and on rebind so a fresh client has the full 10 s before its first Ack is due.

### A.11 Ping/Pong and clock

`Ping{clientTimeMs}` is answered on arrival (not deferred to the tick) with `Pong{clientTimeMs, serverTimeMs: (now() − sessionStartMs) >>> 0, serverTick: world.tick}` in its own frame. `serverTimeMs` in Snapshot and Welcome headers is the value sampled at tick start (`tickStartMs`, pipeline step 1), so it is a tick-start timestamp; the Pong's is the current time. `sessionStartMs = now()` at `start()` (`ServerClock`: `tickStart()` samples and returns the raw `now()`, `serverTimeMs()` is the tick-start server time, `nowMs()` the current one); u32 wrap occurs after 49.7 days, longer than any session lives (idle stop, docs/host.md §19).

### A.12 Files — packages/net-server

| File | Exports |
| --- | --- |
| `src/index.ts` | re-exports |
| `src/constants.ts` | A.1 constants, `CloseCode` (A.3; an `as const` object plus a same-named union type, no `enum`) |
| `src/link.ts` | `ClientLink`, `LinkMessageHandler`, `LinkCloseHandler`, `QueuedLinkBase` (abstract: pre-`onMessage` queueing, once-only close; public `deliver`, `handleClosed`, `closed`; subclasses implement `send`, `bufferedAmount`, `closeTransport`) |
| `src/ws-link.ts` | `WsLink`, `WsLinkOptions`, `createWsServer`, `WsServerOptions` |
| `src/port-link.ts` | `PortLink`, `PortLinkPort`, `PortLinkSend`, `PortLinkClose` (worker side of the gateway `MessagePort`; behaviour and the port protocol are normative in docs/host.md §21 and §18) |
| `src/server-clock.ts` | `ServerClock { constructor(now); start(); tickStart(): number; nowMs(): number; serverTimeMs(): number }` |
| `src/hello.ts` | `peekHello(frame: Uint8Array): { header: MessageHeader; hello: HelloPayload } | null`, `validateHello(hello, game, registry, check?: HelloCheck): RejectReason | null` (without `check`: protocol version and registry hash; with it, the whole A.6 order: failed verification, version, hash, `sessionId`/`exp`, not running, capacity unless reconnecting), `HelloCheck` (`expired?`: the gateway's verdict, else `isTokenExpired` at `nowMs`; an expired identity passes only with `reconnect`), `resolveIdentity(hello, identity, verifier, now?)` (the verifier is asked with `allowExpired` when the Hello carries a reconnect token), `rejectCloseCode(reason)`, `rejectDetail(reason, hello, game)` |
| `src/client-conn.ts` | `ClientConn`, `ConnState`, `SentSnapshot`, `QueuedInput`, `OutboxMessage`, `createConn(link, identity, nowMs)`, `resetReplication(conn, nowMs)`, `transition(conn, to, session?)` (asserts the edge is in A.6's table: `CONN_TRANSITIONS`, throws `ConnStateError`), `markAway(conn, nowMs, session?)` (playing → away), `graceExpired(conn, nowMs, graceMs?)`, `matchesReconnect(conn, reconnectToken, accountId)`, `rebindConn(conn, link, seqIn, identity, nowMs, session?)` (the reconnect rebind; `ConnStateError` unless playing or away), `recordSent(conn, entry)` (ring), `recordAck(conn, tick, nowMs)` (A.9) |
| `src/input-queue.ts` | `acceptInput(conn, msg, seq, stats)`, `drainInput(conn, tick, stats)` |
| `src/snapshot-builder.ts` | `SnapshotSource`, `SnapshotStore`, `ReplicationState`, `buildSnapshot`, `commitSnapshot(rs, data, createsWritten)`, `encodeSnapshotBounded(w, registry, data, softLimitBytes, onCreatesWritten?)` (returns the count too) |
| `src/events-outbox.ts` | `wantsEvent(conn, ev)` (global, or region in `wanted ∩ reported`), `queueEvent(conn, ev, stats?)` (cap, drops oldest), `eventsData(events): EventsData` (builds the local region table), `takeEvents(conn): EventsData` (empties the queue), `splitEvents(data)` (halves with rebuilt tables) |
| `src/backpressure.ts` | `shouldSkip(conn)`, `updateDivisor(conn, t, snapshotEvery?)`, `halvedRateSkips(conn, t, snapshotEvery?)`, `ackTimedOut(conn, now, timeoutMs?)` |
| `src/tokens.ts` | `newReconnectToken(): string` |
| `src/session.ts` | `Session`, `SessionOptions`, `AttachOptions`, `SessionGameDef`, `SessionHooks`, `HookContext`, `PlayerInfo`, `PlayerSpawn`, `TickStats`, `ClientTickStats`, `SessionSpatial`, `SessionTimers`, `SessionLog`, `LogLevel`, `SessionAutosaver`, `SESSION_STATE_NAMESPACE`, `SESSION_STATE_KEY` |
| `src/stats.ts` | `SessionStats` counters named in this doc (plus `unknownKinds`, `snapshotsSent`, `ackTimeouts`, `gameMessagesDropped`, `tickErrors`), `createStats`, `RateMeter`, `TickTimes`, `LatenessHistogram`, `WakeLatenessStats` (A.5) |

| Test | Must prove |
| --- | --- |
| `test/ws-link.test.ts` | real `ws` on an ephemeral port: binary round trip, text frame closes 4003, `bufferedAmount` grows when the socket is paused, pre-`onMessage` queue flushes in order, `onClose` fires once |
| `test/hello.test.ts` | `peekHello` on a valid frame, on a frame whose first message is not Hello (`null`), on garbage (`null`); `validateHello` returns each `RejectReason`; `attach(link)` without identity + `devVerifier` accepts any token and derives the identity from `displayName`; with `hmacVerifier` a bad token yields `Rejected{BadToken}` + 4008; `attach(link)` with neither identity nor verifier throws; `validateHello` lets an expired identity through only as a reconnect, an explicit `expired` verdict winning over `exp`; `resolveIdentity` verifies with `allowExpired` only when the Hello carries a reconnect token |
| `test/state-machine.test.ts` | every row of the A.6 table with a `FakeLink` and `manualLoop`: messages sent per transition (kind sequence asserted), handshake timeout, Hello twice → 4003, session full, Leave frees the slot and `SessionState` shrinks, disconnect before spawn calls `onPlayerLeave` only if `onPlayerJoin` ran |
| `test/input-queue.test.ts` | duplicates from 4-frame redundancy ignored; queue capped at 6 dropping oldest; stale frames dropped; held frame persists across missing ticks; `appliedTick/appliedSeq` update only on a hit |
| `test/snapshot-builder.test.ts` | pure `SnapshotSource` fixture without FixedLoop: creates on first sight; updates only for `version > baseline`; removed component reported once; destroy when leaving interest or dying; `relevance` filter; FULL flag when `fullNext`; the region table is local to each snapshot (the regions of its creates only, first-use order from index 0, whatever the order or repetition of the interest regions; a region change inside interest is an update of `Region`, entering interest from outside a create in the new region; a create deferred past the soft limit gets its region in the table of the snapshot that carries it; `MAX_REGION_TABLE` regions fit and one more fails with `EncodeError('count')`, a region id over `REGION_ID_MAX` bytes with `EncodeError('length')`); ordering by entity id and compId; creates deferred beyond `SNAPSHOT_SOFT_LIMIT_BYTES` are not added to `known` and appear in the next build; `encodeSnapshotBounded` rejects `SNAPSHOT_FLAG_MASKED` and a component `mask`, both of which `encodeSnapshot` writes, with `EncodeError('range')` and the writer left as it was; "delta-equals-full": applying a sequence of deltas to a `ReplicaWorld` equals a FULL build at each tick. Fixtures in `test/fixtures/`: `<name>.json` timelines (scripted per-tick ops over the core components) run by `scripted-world.ts`, and `<name>.expected.snap` (JSON) recording each snapshot tick's delta and FULL build, shared with net-client's `replica-world.test.ts` |
| `test/backpressure.test.ts` | slow client via a `FakeLink` whose `bufferedAmount` is scripted: snapshots skipped above 64 KB and `known` unchanged; events queued during skip arrive in the next frame in tick order; rate halves at 21 outstanding and restores at 20; no Ack for 10 s → `Kicked{AckTimeout}` + 4007 → away; Input still consumed while throttled |
| `test/reconnect.test.ts` | client drops during playing → away, `SessionState` Away, input released; reconnect with token rebinds (same `playerId`, entity and token), receives Welcome/SessionState/RegionSet/Spawned in order, nothing more until it re-reports its regions, then a first snapshot with FULL and `baselineTick 0` whose contents equal the server's replicated stores (events queued meanwhile in its frame); reconnect while the old link is still bound kicks the old one with Replaced/4006 and starts a new input stream; unknown token, no token, a token of an unspawned player → fresh join with a new token; token of another account rejected as fresh join; a full session still takes a reconnect; grace expiry (fake time +120 s) calls `onPlayerLeave`, destroys the entity on other clients and frees the slot, and the stale token then joins fresh; reconnecting while the client or the server still loads regions (FULL over the reported, active ones, the rest as creates); expired session tokens (a gateway identity marked `tokenExpired`, or an `hmacVerifier` token past its `exp` with a reconnect token) rebind only the away player their reconnect token names, while a fresh join, an unknown or another account's reconnect token, a forged or other-session token, or a Hello after the grace ran out is `Rejected{BadToken}` + 4008, and a `tokenExpired: false` verdict wins over `exp`; `stop()` kicks with ServerShutdown/1001 before saving and resolves after the flush; the autosaver hookup; saves never overlap; a failed or unfinished load is never overwritten; the `client-conn.ts` helpers |
| `test/events.test.ts` | events region-filtered by `wanted ∩ reported`; global events reach everyone playing; cap at 256 drops oldest; events ride in the same frame after the Snapshot message; a halved-rate client gets them in their own frame on skipped snapshot ticks unless backpressured; an event that does not encode is dropped once with one error; a backlog too large for one payload arrives as several `Events` messages in order; nothing queued before or during an outage is delivered after a reconnect |
| `test/record.test.ts` | (M6) with `recordLog` (harness, `manualLoop`): frames are recorded as the steps consume them (a new frame, a changed tick field, nothing while held, a late frame never, `null` once when the player goes away), and the lifecycle with its ticks: joins with `accountId` and `displayName`, spawns, a Leave and a grace expiry; a join whose hook throws and a spawn that returns a dead entity are each recorded with their *leave* in the same tick; without `recordLog` no hook is installed, and a log of another version, seed or tick rate, or one that is not empty, is a `RangeError` |
| `test/session-pipeline.test.ts` | `manualLoop` `step()` runs the docs/sim.md 2.9 order (spy systems record order): `regions.update` before phases, `membershipSystem` and `spatial.rebuild` after `postSim`, destroys applied before the snapshot is built (an entity destroyed in `sim` at tick `T` appears as a destroy in the snapshot for `T`), `drainOutbox` called once per tick, `serverTimeMs` monotonic; the byte stats count frames a link takes ownership of (a `PortLink` over a `MessageChannel` transfers them, leaving the sent buffers empty); `wakeLateness` records each FixedLoop wake once, not each tick (injected timers firing 0.1 ms late, and every tenth time 20.1 ms late for a two-tick catch-up wake, fill buckets 0 and 63), a wake held up 290 ms runs the latest five of the 18 ticks due and the world skips the 13 before them (`tick` 48, `dropped ticks` logged, `[31, 13]` in `recordLog.skips`, `tickStats().dropped` 13) and on time again after, and `skip(n)` with `manualLoop` (recorded; an `Error` with a loop or before `start()`), and `LatenessHistogram` gives bucket-edge quantiles capped at the exact maximum, puts early wakes in the first bucket and anything past the last edge in the last. World streaming (M3): `RegionSet` carries `wantedForRegion` as `active` and the ring one step beyond as `prefetch`, only `active` regions load, an unchanged set is never re-sent and a region change re-sends it before that tick's snapshot; snapshots cover `wanted ∩ reported` filtered by `relevance` (an entity leaving a client's interest is destroyed on that client while it lives on; a throwing `relevance` fails only that player's snapshot); spatial queries, between steps and from the next tick's systems, see positions moved in `sim` this tick, and an entity that crossed a border in its new region (membership ran before the rebuild; `queryRadiusAcross` from the old region finds it with `outRegions` naming the new one); a player still loading keeps its spawn region's wanted set active, not lingering, past the linger time, and once it leaves those regions linger and are evicted; `onWorldEdge`: an entity moved off the world is clamped back into its region before the hook runs with the hook context, and a throwing hook is logged (`hook onWorldEdge threw`) and counted in `tickErrors` while the tick still rebuilds the index and sends its snapshot |
| `test/integration.test.ts` | two `@conduit/net-client` `NetClient`s (Node global WebSocket) over `WsLink` + a real `FixedLoop` on a minimal game: both reach Playing, A's input moves A's entity as seen by B within 10 snapshots, B's `mirror` hash of latest values equals server stores after quiescing, disconnect of A despawns on B, bandwidth per client measured and printed (Spike 1: 300 crates in view at `snapshotEvery` 3, a few moving and all moving; `< 60 KB/s` and `< 240 KB/s`) |

## Part B. `@conduit/net-client`

Dependencies: `@conduit/protocol`, `@conduit/sim` (component types, `EntityId`), `@conduit/world` (`WorldGraph` JSON, `RegionId`), `@conduit/assets` (`AssetLoader`), `@conduit/math`. Runs in browsers and Node ≥ 22 (global `WebSocket`). No `three`.

### B.1 Constants

| Name | Value |
| --- | --- |
| `PING_INTERVAL_MS` | `1000` (the first Ping is sent on Welcome) |
| `QUICK_PINGS` / `QUICK_PING_MS` | `5` / `100` (Pings that follow the Welcome's before the cadence settles: a first Pong handled late measures an RTT far too long, and the next lower one replaces it, B.4) |
| `CLOCK_WINDOW` | `16` samples |
| `RTT_ALPHA` | `0.1` (weight of an RTT sample above the estimate; a lower sample replaces it, B.4) |
| `JITTER_ALPHA` | `0.1` |
| `JITTER_MIN_MS` / `JITTER_MAX_MS` | `0` / `50` |
| `SLEW_RATE` | `0.02` (render clock runs at 0.98..1.02) |
| `FRAME_ALPHA` | `0.08` (EWMA weight of the frame interval the render clock advances by) |
| `FRAME_RESET_MS` | `8` (a frame interval this far from the smoothed one replaces it) |
| `SLEW_DEADBAND_MS` | `1` |
| `SNAP_THRESHOLD_MS` | `250` |
| `INPUT_RING` | `8` frames |
| `INPUT_FRAMES_PER_MESSAGE` | `4` (from protocol) |
| `SAMPLE_RING` | `8` |
| `EVENT_BUFFER_MAX` | `1024` |
| `RECONNECT_DELAYS_MS` | `[500, 1000, 2000, 4000, 8000]` (then give up): the wait before each attempt, from the loss or from the previous attempt's failure |
| `CONNECT_TIMEOUT_MS` | `10000` (socket open + Welcome; per connect and per reconnect attempt) |
| `REGION_RELEASE_GRACE_MS` | `5000` |
| `GC_LAG_TICKS` | `2 × snapshotEvery`, exported as `GC_LAG_SNAPSHOTS = 2` and `gcLagTicks(snapshotEvery)` (`NetClient.update` is the only caller of `ReplicaWorld.gc`; `RenderWorld` and `createClient` do not call it; kept in M2, below) |
| `MAX_BAD_FRAMES` | `3` (bad frames in a row before `disconnect()`, B.3) |
| `PREDICTION_RING` | `128` input frames the reconciliation stub keeps unacknowledged (M6, B.10; about 2 s at 60 Hz) |

**GC lag, decided in M2** (PLAN.md Open item 1): `GC_LAG_TICKS` stays `2 × snapshotEvery` (6 ticks, 100 ms at 60 Hz). `NetClient.update` emits a replicated event in the update where the render tick first reaches the event's tick, before it calls `gc` (B.7), and an event never reaches the client after the destroy of an entity destroyed at or after the event's tick: the event rides the first snapshot frame at or after its tick, the destroy the first at or after its own (A.8.3). So `'event'` listeners always find such an entity in `mirror`, and code later in the same frame (`RenderWorld.update`'s event handlers) still does unless that frame moved the render tick more than `GC_LAG_TICKS`. A larger lag (render.md once argued for 24 ticks) would only extend that to stalled frames, after which `RenderWorld` has already destroyed the entity's view anyway (its step 3 runs before event dispatch; an event emitted in the tick its entity is destroyed gets `view = null` whenever the destroy lands on that snapshot tick, whatever the lag), while holding every destroyed entity four times longer. `test/event-buffer.test.ts` and `test/headless-two-client.test.ts` check both properties.

**Spike 3 (M2)**, `test/headless-two-client.test.ts`: A drives at 12 m/s (0.192 m per 16 ms frame) over `MemoryTransport` with a seeded `10 + U(0, 30)` ms delay per message in both directions; B makes no `update()` call for 1 s. Over the 120 frames after the stall, B's sampled position of A moved 0.180–0.196 m per frame: **max jump 0.196 m** (limit 0.5 m), no render-clock snap (B: jitter 10.3 ms, interpolation delay 7 ticks). A one-off sweep (12 seeds × frames of 7, 16, 16.7 and 33 ms × stalls of 1 and 3 s, 96 runs) gave a worst jump of 0.416 m (33 ms frames, nominal 0.396 m), steps within −0.012/+0.020 m of the nominal motion and no snaps. The spike passed without tuning; the final values are the ones above: interpolation delay `2 × snapshotIntervalMs + jitterMs` (B.4) with `JITTER_ALPHA` 0.1 and `JITTER_MIN_MS`/`JITTER_MAX_MS` 0/50, `SLEW_RATE` 0.02, `SLEW_DEADBAND_MS` 1, `SNAP_THRESHOLD_MS` 250. At constant velocity extrapolation hides a late render clock, so the test also keeps every step within ±25 % of the nominal motion (a 0.25-interval delay gives about ±50 %).

### B.2 Transport

```ts
export interface Transport {
  send(buf: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (buf: Uint8Array) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
  onError(cb: (err: unknown) => void): void;
}
export type TransportFactory = (url: string) => Transport;
export const webSocketTransport: TransportFactory;   // new globalThis.WebSocket(url); binaryType = 'arraybuffer'; message.data → new Uint8Array(data); text messages ignored
```

`webSocketTransport` throws at construction if `globalThis.WebSocket` is undefined; `send` before open or after close is dropped. Tests inject a `MemoryTransport` pair (client side + a `ClientLink`-compatible server side) so `NetClient` runs against a `Session` without sockets:

```ts
export class MemoryTransport implements Transport {
  constructor(opts?: { id?: number; latencyMs?: number | (() => number); timers?: { setTimeout }; autoOpen?: boolean });  // id → link.id (default a process counter); latencyMs default 0, a function is sampled per message and close; autoOpen default true
  readonly link: MemoryLink;                         // implements ClientLink (A.2), pre-onMessage queue MEMORY_PRE_QUEUE_MAX = 64 then close 4003
  static factory(accept: (link: MemoryLink, url: string) => void, opts?): TransportFactory;   // e.g. link => session.attach(link)
  readonly opened: boolean; readonly closed: boolean;
  open(): void;                                      // when autoOpen is false
  bufferedAmount(): number;                          // client bytes in flight (MemoryLink.bufferedAmount: server bytes)
  drop(code = 1006, reason = ''): void;              // abrupt loss: in-flight data discarded both ways; also on MemoryLink
  fail(err?: unknown): void;                         // onError(err), then drop(1006)
}
```

Both ends deliver in order on later turns (never re-entrantly from `send`), fire `onClose` exactly once, and a normal `close()` reaches the peer after the messages sent before it (a `Rejected` arrives before its 4005). With a `latencyMs` function each message and close gets its own delay but order still holds: an item is delivered once its delay has passed and every earlier item was delivered (head-of-line blocking, as on TCP); a sampled delay that is not finite and `>= 0` throws `RangeError` from that `send`/`close`, which then queues nothing.

### B.3 `NetClient`

```ts
export interface ClientGameDef { id: string; protocolVersion: number; tickRate: number; snapshotEvery: number; registry: SchemaRegistry; input: Schema<InputFrameBase>; components: readonly ComponentType<unknown>[]; world?(seed: number): WorldGraph }   // input must be registry.input; the graph never crosses the wire
export interface NetClientOptions {
  url: string; game: ClientGameDef; token: string; displayName: string;
  transport?: TransportFactory;                    // default webSocketTransport
  now?: () => number;                              // default performance.now
  timers?: { setTimeout; clearTimeout; setInterval; clearInterval };
  sampleInput?: (frame: InputFrameBase, context: InputSampleContext) => void; // fills one eligible fresh frame; NetClient sets tick
  autoReady?: boolean;                             // default true: send Ready right after Welcome
  autoReconnect?: boolean;                         // default true
  assets?: AssetLoader; manifest?: Manifest;       // M3, docs/assets.md §3; passed to RegionClient (B.8), which needs both to load region groups; without them all regions count as loaded at once (each also accepts undefined)
  prediction?: PredictionOptions;                  // default off; acknowledgement tracking plus optional Predictor/PredictionDriver (B.10)
  inputScheduling?: 'hybrid' | 'timer' | 'manual';   // default hybrid
  maxInputLeadTicks?: number;                      // default 32; integer 1..256
  maxSessionCapacity?: number;                     // admission/decode limit 1..16; default 16
  snapshotLimits?: Partial<SnapshotLimits>;        // client transaction/assembly bounds
  extrapolation?: { horizonMs: number; onLimit?: 'hold' | 'reset' }; // horizon 0..10000 ms
  diagnostics?: DiagnosticOptions;
  log?: LogFn;                                     // (level, msg, data?) => void; default: warn/error to the console
}
export type ClientState = 'Disconnected' | 'Connecting' | 'Handshaking' | 'Joined' | 'Loading' | 'Ready' | 'Playing' | 'Reconnecting' | 'Resyncing';
export interface NetClientEvents {
  state: (s: ClientState, prev: ClientState) => void;
  welcome: (w: WelcomePayload) => void;
  sessionState: (s: SessionStatePayload) => void;
  spawned: (s: SpawnedPayload) => void;
  snapshot: (h: SnapshotHeader) => void;           // after apply
  event: (e: { def: EventDef; tick: number; regionId: RegionId | null; payload: unknown }) => void;   // at render time (B.7)
  message: (m: { def: MessageDef; tick: number; payload: unknown }) => void;                           // game s2c messages, on arrival
  regionSet: (r: RegionSetPayload) => void;
  rejected: (r: RejectedPayload) => void;
  kicked: (k: KickedPayload) => void;
  disconnected: (info: { code: number; reason: string; willReconnect: boolean }) => void;
  error: (err: unknown) => void;
}
export class NetClient {
  constructor(opts: NetClientOptions);
  readonly state: ClientState;
  readonly clock: NetClock; readonly mirror: ReplicaWorld; readonly regions: RegionClient;
  readonly prediction: Reconciler | null;          // (M6) B.10: null unless opts.prediction.enabled
  readonly playerId: number;                       // −1 until Welcome
  readonly entity: EntityId;                       // own entity after Spawned, else ENTITY_NONE
  readonly players: readonly PlayerEntry[];
  readonly graph: WorldGraph | undefined;          // game.world(Welcome.worldSeed), set before 'welcome' is emitted
  readonly reconnectToken: string;                 // from Welcome
  connect(): Promise<void>;                        // resolves on Joined; rejects with ConnectError { kind: 'rejected' | 'timeout' | 'closed' | 'error' | 'aborted', rejected?, code? }
  setTarget(url: string, token: string): void;     // (M5) the url and Hello token of the next connect(): a lobby client mints a token per join (docs/game.md 4); only while Disconnected (Error otherwise, so a reconnect keeps the token it joined with); RangeError for a token over 2048 UTF-8 bytes
  disconnect(): void;                              // Leave, close(1000), no reconnect
  ready(): void;                                   // send Ready (when autoReady is false)
  sendInput(frame: InputFrameBase): void;          // stores a copy as the frame to send on the next client tick
  reportRegions(loaded: RegionId[], loading: RegionId[]): void;   // RegionClient calls this; games may call it directly when not using RegionClient
  send<T>(def: MessageDef<T>, payload: T): void;   // c2s/both game message, own frame, immediately; RangeError for s2c/unknown; dropped with a warning before Joined
  update(nowMs?: number): void;                    // call once per animation frame, before RenderWorld.update (docs/game.md): clock slew, event dispatch, gc
  on<K extends keyof NetClientEvents>(evt: K, cb: NetClientEvents[K]): () => void;
  stats(): { rttMs; jitterMs; bytesIn; bytesOut; bytesInPerSec; bytesOutPerSec; snapshots; seqGaps; lastSnapshotTick; badFrames; ignoredMessages; prediction? };
  // bytesIn/bytesOut: frame bytes since construction; bytesInPerSec/bytesOutPerSec (M4): frame bytes received/sent in the rolling window (now − 1000 ms, now]
  // prediction (M6): Reconciler.stats() (B.10) while the stub is enabled; the key is absent otherwise
}
export function describeRejected(r: RejectedPayload): string;   // 'Rejected: SchemaMismatch — please refresh' (the ConnectError message); also rejectReasonName, kickReasonName
```

#### State machine

| From | Trigger | Actions | To |
| --- | --- | --- | --- |
| Disconnected | `connect()` | `transport = factory(url)`; start `CONNECT_TIMEOUT_MS` timer | Connecting |
| Connecting | `onOpen` | `seqOut = 0`; send `Hello{protocolVersion, registryHash, token, reconnectToken: '', displayName}` | Handshaking |
| Connecting / Handshaking | timeout, `onClose`, `onError` | close; reject `connect()`; emit `disconnected{willReconnect:false}` | Disconnected |
| Handshaking | `Rejected` | emit `rejected` (no `disconnected`); reject `connect()`; `autoReconnect` ignored, whatever close code follows | Disconnected |
| Handshaking | `Welcome` | `playerId`, `reconnectToken` stored; `clock.configure` and `mirror.configure` with the Welcome rates; `clock.addSample(serverTimeMs, serverTick, recvMs)`; `graph = game.world?.(worldSeed)`; resolve `connect()`; emit `welcome`; if `autoReady` send `Ready`; send a Ping, `QUICK_PINGS` more `QUICK_PING_MS` apart, then one every `PING_INTERVAL_MS` | Joined |
| Joined | `RegionSet` | `regions.apply(set)` (B.8); emit `regionSet` | Loading |
| Loading / Ready / Playing | `RegionSet` | as above; Ready whose new `active` is not all loaded goes back to Loading | unchanged / Loading |
| Loading | `regions.loaded() ⊇ set.active` (RegionClient callback; immediate when no assets) | `RegionLoadState` already sent by RegionClient | Ready |
| Ready | `Spawned{playerId === own}` (or one received earlier, on entering Ready) | `entity = s.entity`; start client tick interval (B.6) | Playing |
| Joined / Loading / Ready | `onClose` | emit `disconnected{willReconnect:false}` (server freed the slot) | Disconnected |
| Playing | `onClose` with a reconnectable code (A.3) and `autoReconnect` | stop client tick and pings; keep `reconnectToken`, `playerId`, `entity`, `clock` offset window (and `mirror` and regions until the Welcome); `attempt = 0`; schedule `RECONNECT_DELAYS_MS[attempt]`; emit `disconnected{willReconnect:true}` | Reconnecting |
| Playing | `onClose` non-reconnectable, `Kicked` non-reconnectable, `disconnect()` | stop timers; emit `disconnected{willReconnect:false}` | Disconnected |
| Reconnecting | timer → new transport (start `CONNECT_TIMEOUT_MS` timer) → `onOpen` | `seqOut = 0`; send `Hello{…, reconnectToken}` | Reconnecting (awaiting Welcome) |
| Reconnecting | `onClose`/`onError`/timeout | `attempt++`; if the close code reconnects (A.3; an error or timeout does) and `attempt < RECONNECT_DELAYS_MS.length`, schedule `RECONNECT_DELAYS_MS[attempt]` from now, else emit `disconnected{willReconnect:false}` | Reconnecting / Disconnected |
| Reconnecting | `Rejected` | emit `rejected` (no `disconnected`), whatever close code follows | Disconnected |
| Reconnecting | `Welcome` | **Resync reset**: `mirror.reset()` (all replica entities and sample rings), `eventBuffer.clear()`, `inputSender.reset()` (with `prediction?.reset()`, B.10), `clock.resetJitter()` (offset window kept; the Welcome adds no clock sample). If `Welcome.playerId ≠ playerId` or `Welcome.reconnectToken ≠ reconnectToken`, treat as fresh join (the server did not recognise the token; a freed slot can come back with the same `playerId`, so the token decides, A.6): also `clock.reset()` and the Handshaking row's `addSample` (a restarted session starts its time and ticks over), `entity = NONE`, send `Ready` if `autoReady`, go to Joined. Otherwise expect `SessionState`, `RegionSet` (→ `regions.apply`, RegionLoadState re-sent from the already-loaded set), `Spawned`. Both: store `playerId`/`reconnectToken`; `graph` rebuilt only for a different `worldSeed`; emit `welcome`; send a Ping and restart the ping interval | Resyncing / Joined |
| Resyncing | a `Snapshot` with `FULL` applied and the own `Spawned` received, in either order (other snapshots are applied and acked) | restart client tick; emit `state` | Playing |
| Resyncing | `onClose` | with a reconnectable code and no final kick: as Playing → Reconnecting, except that the attempt counter continues (`attempt++`; none left → `disconnected{willReconnect:false}`, Disconnected); otherwise as Playing → Disconnected | Reconnecting / Disconnected |
| any but Disconnected | `disconnect()` | `Leave` when the server knows the client (Joined … Playing, Resyncing); close(1000); stop timers; reject a pending `connect()` (`aborted`); emit `disconnected{1000}` | Disconnected |

M1 implemented the rows up to Playing; the Reconnecting and Resyncing rows landed in M4 (PLAN.md). `Kicked` is recorded and emitted; the close that follows decides, and a kick reason other than ServerShutdown or AckTimeout forbids reconnecting. A lost connection emits `disconnected{willReconnect:true}` once, on entering Reconnecting; failed attempts emit nothing more until the client gives up (`disconnected{willReconnect:false}` with the last failure's code, 1006 for an error or timeout) or a Rejected ends it (`rejected`). Nothing is queued for later while Reconnecting: the client tick and pings are stopped, `sendInput` only replaces the pending frame, and `send()` drops game messages (the server does not know the client until the Welcome). A connect timeout or transport error reports `disconnected{code: 1006}`. On entering Disconnected the client releases regions (`regions.reset()`), clears the event buffer (B.7), resets `playerId`/`entity`/`players`, and keeps `mirror` until the next `connect()`, which also resets `clock` (and clears the event buffer again).

Any `DecodeError` while reading a frame → `log('warn')`, frame discarded, `stats.badFrames++`; three in a row → `disconnect()` with `error` emitted. `dispatchFrame` decodes every message of a frame before dispatching any, so nothing of a discarded frame is applied.

### B.4 `NetClock`

```ts
export class NetClock {
  constructor(opts: { now: () => number });
  configure(tickRate: number, snapshotEvery: number): void;   // tickMs = 1000 / tickRate; snapshotIntervalMs = tickMs × snapshotEvery
  addSample(serverTimeMs: number, serverTick: number, clientRecvMs: number): void;
  onPong(clientTimeMs: number, serverTimeMs: number, serverTick: number, recvMs: number): void;
  onSnapshotArrival(serverTimeMs: number, serverTick: number, recvMs: number): void;
  update(nowMs: number): void;                                 // slews render clock
  serverTimeNow(): number;                                     // estimated server ms
  serverTickNow(): number;                                     // floor
  renderTick(): number;                                        // fractional tick
  inputTick(): number;                                         // integer
  readonly rttMs: number; readonly jitterMs: number; readonly offsetMs: number; readonly synced: boolean;
  readonly tickRate; snapshotEvery; tickMs; snapshotIntervalMs; tickEpochMs; interpDelayMs; interpDelayTicks; inputLead; snaps: number;
  readonly renderTimeMs: number | null; samples(): number[];   // the window's offset samples s, oldest first
  resetJitter(): void;
  reset(): void;                                               // forgets everything but the rates (a new session)
}
export function toU32Ms(ms: number): number;                    // floor(ms) mod 2^32, sent as Ping.clientTimeMs
```

```
offset sample s = serverTimeMs − clientRecvMs                     // what it saw of the offset: less the way back, and any hold-up
epoch  sample e = serverTimeMs − serverTick × tickMs               // server tick-0 time in server ms
window: ring of CLOCK_WINDOW s; addSample(serverTimeMs, serverTick, clientRecvMs) pushes its s (oldest evicted)
offsetMs   = max over window of s + rttMs/2                        // a delay only lowers s: the least delayed sample, plus the way back
                                                                   // (half the RTT as it is now, not as it was when each sample came)
tickEpoch  = min of e since reset()                                // tick starts are late, never early, and keep to one grid (a server that drops ticks skips their numbers, docs/sim.md 2.10)
synced     = window has ≥ 1 sample

onPong(clientTimeMs, serverTimeMs, serverTick, recvMs):
  sample = (u32(recvMs) − clientTimeMs) | 0, plus recvMs's fraction   // u32 wrap; a negative sample is ignored
  if first Pong: rttMs = sample                                           // before it, rttMs is 0: the Welcome's offset is what it saw
  else if sample < rttMs: rttMs = sample                                 // delays only add to a sample: fall at once, rise smoothed
  else: rttMs = rttMs + RTT_ALPHA × (sample − rttMs)
  addSample(serverTimeMs, serverTick, recvMs)

onSnapshotArrival(serverTimeMs, serverTick, recvMs):
  addSample(serverTimeMs, serverTick, recvMs)
  if lastSnapshotRecvMs != null:
     interval  = recvMs − lastSnapshotRecvMs
     deviation = |interval − snapshotIntervalMs|
     jitterRaw = jitterRaw + JITTER_ALPHA × (deviation − jitterRaw)
     jitterMs  = clamp(jitterRaw, JITTER_MIN_MS, JITTER_MAX_MS)
  lastSnapshotRecvMs = recvMs

serverTimeNow()     = now() + offsetMs
serverTickNow()     = floor((serverTimeNow() − tickEpoch) / tickMs)     // 0 until synced; never decreases until reset() (a window shift can lower offsetMs)
interpDelayMs       = 2 × snapshotIntervalMs + jitterMs
interpDelayTicks    = ceil(interpDelayMs / tickMs)
targetRenderTimeMs(now) = (now + offsetMs) − interpDelayTicks × tickMs   // server-ms domain

update(now):
  if !synced: return
  target = targetRenderTimeMs(now)
  if renderTimeMs == null: renderTimeMs = target; lastUpdateMs = now; return
  dt = now − lastUpdateMs; lastUpdateMs = now
  frameMs = (frameMs == null or |dt − frameMs| >= FRAME_RESET_MS) ? dt : frameMs + FRAME_ALPHA × (dt − frameMs)
  renderTimeMs += frameMs                          // advance first: an error measured before advancing settles one frame
  err = target − renderTimeMs                      // ahead of the target and snaps on every update at 1 Hz
  if |err| > SNAP_THRESHOLD_MS: renderTimeMs = target; snaps++
  else if |err| > SLEW_DEADBAND_MS: renderTimeMs += sign(err) × min(SLEW_RATE × dt, |err|)   // rate 1 ± SLEW_RATE, never past the target

renderTick()  = (renderTimeMs − tickEpoch) / tickMs                // fractional; NaN-safe: 0 before first update
inputLead     = min(maxInputLeadTicks, ceil((rttMs / 2) / tickMs) + 1)
inputTick()   = serverTickNow() + inputLead
```

**Each estimate is the extreme its bias points away from.** Everything that delays a message -- the network, the server sending after it stamped `serverTimeMs`, and above all a client whose main thread handles the message late because it was busy -- lowers `s`, so the least delayed sample (the highest) is the best estimate of the offset, short only of the way back, which half the RTT stands for; a tick start can only be late, which raises `e`, so the lowest is the best estimate of the epoch, and since the server keeps its ticks on one grid for the whole session (docs/sim.md 2.10) the lowest since `reset()` stays right. A sample keeps no RTT of its own: the offset adds the estimate as it is now, so a mismeasured RTT is undone by the next Pong that measures less, not by the window turning over. The offset was once the window's minimum of `s + rtt/2`, its most delayed sample: the snapshots a 120 ms hitch held back set it ~75 ms low for the window's 0.8 s, `serverTickNow` trailed the server by 7 ticks, every input frame arrived after its tick and was dropped (A.7), and the vehicle held its last orders for most of a second after every hitch (measured in a browser: 47 ticks without an applied input after a 120 ms hitch, 56 after 300 ms). And the epoch was the window's minimum: a server starting every tick a few ms late for longer than the window raised it, and the render tick stepped back by that much in one frame.

The RTT falls to a lower sample at once because stalls only ever add to a sample: a browser client handles its first Pong while it builds the WebGL renderer right after Welcome, and a ~300 ms sample that decayed at `RTT_ALPHA` per 1 Hz Pong kept `inputLead` near 10 ticks for half a minute, so every input frame arrived more than `INPUT_QUEUE_MAX` ticks early and was dropped by the server's queue (A.7) before its tick. Tick counts are floored and ceiled with a 1e-6-tick tolerance so exact multiples of `tickMs` do not fall a tick short. `resetJitter()` sets `jitterRaw = 0`, `jitterMs = 0`, `lastSnapshotRecvMs = null`. The window (and the RTT estimate) survives a resync because the server clock is the same session; a reconnect that ends in a fresh join calls `reset()` instead, since the server may be a restarted session whose time and ticks started over (B.3). Background-tab throttling (long gaps between updates) needs no correction because such a gap is far past `FRAME_RESET_MS` and advances the clock by the whole elapsed time; a large `err` from an offset or delay change is handled by the snap.

The clock advances by `frameMs`, the smoothed frame interval, rather than by the raw `dt`, because **the interval a frame reports is noisy even when frames are not**. A display held at a dead-steady 60 Hz reports intervals a millisecond or two either side of 16.667 ms, and successive intervals come out strongly anti-correlated (measured lag-1 autocorrelation −0.60 on an idle page), which is the signature of noise on the timestamps rather than of frames really arriving early and late. Advancing by that raw interval puts ±12 % into how far the world moves each frame — shimmer on everything in motion, worst where a chase camera holds the player still and the scenery slides past. Smoothing costs nothing, since it is the slew, not `dt`, that holds the clock on the target in the long run; the correction budget stays on the raw `dt` because it is an allowance of real time. A genuine change of cadence — a dropped frame, a 120 Hz display, a stall — differs by at least `FRAME_RESET_MS` and replaces the estimate outright, so the clock follows it on the same frame instead of easing into it.

`update(now)` must be called with **the frame's own timestamp**, which is what `requestAnimationFrame` passes its callback, and never with a clock read somewhere inside the frame: the latter measures when that line ran, after however much work came first, and feeds exactly the jitter this smoothing exists to remove. `RenderHost` exposes the frame's timestamp as `host.timeMs` for that reason (docs/render.md §2, docs/game.md §4).

### B.5 `ReplicaWorld`

```ts
export interface ReplicaEntity {
  readonly id: EntityId; readonly regionId: RegionId | null;
  readonly createdTick: number; readonly destroyedTick: number | null;
  readonly latest: ReadonlyMap<number, unknown>;  // deeply immutable owned values
  readonly samples: ReadonlyMap<number, SampleRingReader>;              // compId → its values by tick, and REMOVED at the tick it went: every component it has had while held
}
export class SampleRing {
  constructor(capacity = SAMPLE_RING);
  push(tick: number, value: unknown): void;      // value ownership transfers; ticks must be non-decreasing (older ignored; an equal tick replaces the newest value)
  readonly length: number; at(i: number): { tick: number; value: unknown };   // 0 = oldest
  newest(): { tick; value } | undefined;
  bracket(tick: number): { a: number; b: number } | null;   // indices with at(a).tick ≤ tick ≤ at(b).tick, b = a+1 (or a = b when exact/only)
  readonly capacity: number; oldest(); tickAt(i); indexAtOrBefore(tick): number; clear(): void;
  readonly complete: boolean;                    // every sample pushed since clear() still held (a full ring lets its oldest go)
}
export class ReplicaWorld {
  constructor(registry: SchemaRegistry, components: readonly ComponentType<unknown>[], opts: { tickRate: number; snapshotEvery: number; log?: LogFn; extrapolation?: { horizonMs: number; onLimit?: 'hold' | 'reset' } });   // components: the game's types; RangeError if one is not in the registry
  configure(tickRate: number, snapshotEvery: number): void;   // Welcome rates
  applySnapshot(s: SnapshotData): void;
  authoritativeTick(e: EntityId): number | undefined; // completed coherent entity tick; may lag latestTick
  read<T>(e: EntityId, c: ComponentType<T>): DeepReadonly<T> | undefined;    // latest
  readAt<T>(e: EntityId, c: ComponentType<T>, tick: number): DeepReadonly<T> | undefined;   // as it was at tick (valueAt): not there yet if it came later, still there if it went later
  sample<T>(e: EntityId, c: ComponentType<T>, renderTick: number, out: T): T | undefined;   // undefined when not there at renderTick
  has(e: EntityId): boolean; get(e: EntityId): ReplicaEntity | undefined;   // including destroyed entities not yet collected
  readonly size: number;
  entities(): Iterable<ReplicaEntity>;           // insertion order
  visibleAt(renderTick: number): Iterable<ReplicaEntity>;
  gc(beforeTick: number): number;                // returns count removed
  reset(): void;
  readonly latestTick: number;
}
export interface ReplicaReader { authoritativeTick?(e: EntityId): number | undefined; read<T>(e, c): DeepReadonly<T> | undefined; sample<T>(e, c, renderTick, out): T | undefined }   // ReplicaWorld (newest) and ReplicaAt (as of a tick)
export class ReplicaAt implements ReplicaReader {   // what a frame reads (docs/game.md FrameContext.replica): the replica as the view shows it
  constructor(world: ReplicaWorld, tick = 0); readonly world: ReplicaWorld; tick: number;
  read(e, c): world.readAt(e, c, tick); sample(e, c, renderTick, out): world.sample(...);
  get(e) / has(e): the entity if alive at tick; entities(): world.visibleAt(tick); visibleAt(t): world.visibleAt(t);
}
export const REMOVED: unique symbol;             // what a component's samples hold at the tick it was removed
export function valueAt(ring: SampleRing, tick: number): unknown;   // the value in effect at tick, or undefined
```

`ReplicaEntity` and its maps/history are readonly live views; they expose no mutating map or
ring methods. `SampleRingReader` supplies the read methods above, not `push` or `clear`.
Component values are owned immutable copies, including nested fields. Use `sample(..., out)`
for caller-owned mutable presentation output. `authoritativeTick(entity)` is the admitted complete
state tick for coherent reconciliation; `latestTick` is the global snapshot tick, not proof that
every budgeted entity advanced. A custom `ReplicaReader` may omit authoritative ticks.

#### `applySnapshot(s)`

```
T = s.header.serverTick
if s.header.flags & FULL: reset()                        // everything is re-created below
for c in s.creates:
  region = c.regionIdx == REGION_IDX_NONE ? null : s.regions[c.regionIdx]
  ent = entities.get(c.entity)
  if ent and ent.destroyedTick == null: log('warn', 'duplicate create'); if region: ent.regionId = region; treat as update of every component
  else if ent: ent.destroyedTick = null; if region: ent.regionId = region; removeComponent(ent, id, T) for every component the create lacks
                                                              // back in interest while still held (not yet collected): the same entity (an id carries its
                                                              // slot's generation), kept: a destroy not yet rendered never shows
  else: ent = { id, regionId: region, createdTick: T, destroyedTick: null, latest: Map, samples: Map }; entities.set(id, ent)
  for comp in c.components: setComponent(ent, comp.id, comp.value, T)
for u in s.updates:
  ent = entities.get(u.entity); if !ent: log('warn', 'update for unknown'); continue
  for comp in u.components: setComponent(ent, comp.id, comp.value, T)
  for id in u.removed: removeComponent(ent, id, T)
for e in s.destroys:
  ent = entities.get(e); if ent and ent.destroyedTick == null: ent.destroyedTick = T
latestTick = T

setComponent(ent, id, value, T):
  previous = ent.latest.get(id); ent.latest.set(id, value)  // decodeSnapshot allocated it; no copy
  ring = ent.samples.get(id) ?? new SampleRing(); ent.samples.set(id, ring)   // every component: what it was at a render tick
  if previous exists and ring.newest().tick < s.header.baselineTick < T:
     ring.push(baselineTick, previous)                      // the client's view at the baseline: a resting entity does not start moving early
  ring.push(T, value)                                       // ring and latest share the object; both treat it as immutable
  if def === Region: ent.regionId = value.id                // Region component tracks migrations (docs/sim.md)

removeComponent(ent, id, T):
  ent.latest.delete(id)                                     // the newest: gone at once
  ent.samples.get(id)?.push(T, REMOVED)                     // as of a tick: there until T (readAt, sample)
```

Render shows the entities alive at its render tick, which trails the newest snapshot by the interpolation delay, and
each component as it was then: one added at T is not there before T, one removed at T is still there before T, a
non-interpolated value changes at its tick. A component's ring holds `SAMPLE_RING` samples, which covers the delay;
before the oldest of a ring that let older ones go (`complete` false), the oldest stands in.

Values from `decodeSnapshot` are fresh objects per snapshot, so rings never alias across ticks. `NetClient` calls `applySnapshot`, then `clock.onSnapshotArrival(header.serverTimeMs, header.serverTick, recvMs)`, then sends `Ack{lastSnapshotTick: T}`, then emits `snapshot`.

#### `readAt(e, c, tick)` and `sample(e, c, renderTick, out)`

```
valueAt(ring, tick):                                         // the value in effect at tick, or undefined
  i = ring.indexAtOrBefore(tick)
  s = i >= 0 ? ring.at(i) : (ring.complete ? undefined : ring.oldest())   // before the oldest: not come yet, unless older ones were let go
  return s == undefined or s.value == REMOVED ? undefined : s.value

readAt(e, c, tick):
  ent = entities.get(e); if !ent: return undefined
  ring = ent.samples.get(registry.componentId(c)); return ring ? valueAt(ring, tick) : undefined

sample(e, c, renderTick, out):
  ent = entities.get(e); if !ent: return undefined
  ring = ent.samples.get(registry.componentId(c)); value = ring ? valueAt(ring, renderTick) : undefined
  if value == undefined: return undefined
  return sampleComponent(c, ring, value, renderTick, out)

sampleComponent(c, ring, latest, renderTick, out):
if !ring or ring.length == 0: return c.schema.copy(latest, out)
a = max(0, ring.indexAtOrBefore(renderTick)); A = ring.at(a)  // before them all: the oldest
if A.value == REMOVED: return c.schema.copy(latest, out)
if renderTick <= A.tick: return c.schema.copy(A.value, out)
B = a + 1 < ring.length ? ring.at(a + 1) : undefined
if !B or B.value == REMOVED: return extrapolate(c, A, renderTick, out)   // the newest, or the last before it went
t = clamp((renderTick − A.tick) / (B.tick − A.tick), 0, 1)
c.schema.copy(A.value, out)                                  // non-interpolated fields take the earlier sample
for name in c.interpolate:
   ft = c.schema.fields[name]
   if ft.lerp: out[name] = ft.lerp(A.value[name], B.value[name], t, out[name])
   // ft.lerp undefined (bool, str, entity, array, struct, optional): keep A's value
return out

extrapolate(c, newest, renderTick, out):
  c.schema.copy(newest.value, out)
  if !c.extrapolateWith: return out
  velName = c.extrapolateWith; vel = newest.value[velName]; vt = c.schema.fields[velName]
  maxTicks = snapshotEvery                                   // at most one snapshot interval
  dtTicks = min(renderTick − newest.tick, maxTicks); dtSec = dtTicks / tickRate
  for name in c.interpolate:
     ft = c.schema.fields[name]
     if ft.kind == vt.kind and (ft.kind == 'vec2' or ft.kind == 'vec3'):   // e.g. pos += vel × dt
        out[name].x = newest.value[name].x + vel.x × dtSec; … y, z
  return out                                                 // beyond maxTicks the value holds
```

Per-kind lerp rules are those of `FieldType.lerp` in docs/protocol.md §4.4: numbers/fixed/f32 linear, vec component-wise, quat slerp shortest path, angle16 shortest arc, everything else takes the earlier sample.

`visibleAt(renderTick)` yields entities with `createdTick ≤ renderTick && (destroyedTick === null || renderTick < destroyedTick)`, in insertion order. `gc(beforeTick)` deletes entities with `destroyedTick !== null && destroyedTick < beforeTick`; `NetClient.update` calls `gc(floor(renderTick) − GC_LAG_TICKS)`.

### B.6 Input sending

`NetClient.pulseInput(nowMs?)` samples and sends at most one current input when Playing. It returns
whether it sent. `nowMs` uses the same monotonic time base as `NetClientOptions.now` (default
`performance.now`); omit it to measure the actual callback time. The target comes from
`clock.inputTick()`, never from counting callbacks. A duplicate or smaller estimate is suppressed
without consuming a sample. Timestamps never regress within a connection; a backward correction
waits until the estimate passes the last emitted tick.

`inputScheduling: 'hybrid' | 'timer' | 'manual'` defaults to hybrid. NetClient uses an absolute
`setTimeout` deadline derived from the clock grid, recomputed after every wake. `createClient`
also pulses before clock update and presentation in hybrid/manual mode; timer mode omits its
frame pulse. Manual disables the fallback timer. Direct NetClient users call `pulseInput` before
presentation themselves. No early-send allowance is used. Timer rounding or 120/144 Hz frames
cannot accelerate a 60 Hz input stream; concurrent drivers cannot duplicate a target.

`sampleInput(frame, { targetTick, sampleTimeMs, dt })` receives actual local sample time and
elapsed seconds since the preceding successful sample (0 first). `createClient` exposes these as
`InputContext.tick/sampleTimeMs/dt`. Use `clock.tickMs / 1000` for fixed simulation duration.
Delayed wakes sample current controls once, never synthesize historical presses. Games should
latch short input edges in event handlers and consume the latch in sampleInput; a press and
release between pulses otherwise cannot be observed by polling. The core assigns no button
semantics. If sampling throws, the prior frame is sent and the error is reported.

InputSender retains up to INPUT_RING frames and sends the newest four, oldest first. The send
callback borrows these ring objects only during the callback; prediction copies its own frames
at send time. A forward jump over 32 ticks clears retained frames and resets prediction through
the discontinuity callback, doing bounded work. Smaller gaps simply skip unsampled targets.
Fresh join, resync and disconnect clear scheduling history and pending controls, preventing an
outage input from becoming current. Holding stale controls after a missed tick remains game
policy using the applied input's tick.

Migration: remove private inputSender interception and custom input intervals. Use
`createClient({ inputScheduling: 'hybrid', sampleInput })`, as in the sandbox, or call the public
`net.pulseInput()` before presentation with manual scheduling. The previous scheduler's forced
increments and backward timestamp jumps are intentionally removed; no legacy mode is provided.
This is a public sampling-dt behavior change; message encoding is unchanged. External consumer
workarounds should be removed only after their own browser checks pass.

### B.7 Replicated event delivery

`EventBuffer`: on `Events` arrival, for each wire event push `{ def: registry.event(id), tick, regionId: regionIdx == NONE ? null : regions[idx], payload }` into an array kept sorted by `(tick, arrivalIndex)` (`EVENT_BUFFER_MAX`, oldest dropped). `NetClient.update()` after `clock.update` does: `while buffer[0] && buffer[0].tick <= clock.renderTick(): emit('event', buffer.shift())`. Events whose tick is already behind the render tick on arrival dispatch on the next `update`. The buffer is cleared on Resync.

```ts
export interface ReplicatedEventInfo { def: EventDef; tick: number; regionId: RegionId | null; payload: unknown }   // the 'event' payload; docs/render.md §3 ReplicatedEvent
export class EventBuffer {
  constructor(registry: SchemaRegistry, capacity = EVENT_BUFFER_MAX);
  push(data: EventsData): void;            // one Events payload; RangeError (nothing buffered) for an id or region index decodeEvents would reject
  add(ev: ReplicatedEventInfo): void;      // after every buffered event whose tick is not later; beyond capacity the first in (tick, arrival) order is dropped
  shiftDue(renderTick: number): ReplicatedEventInfo | undefined;   // removes and returns the first event if its tick <= renderTick
  peek(): ReplicatedEventInfo | undefined; clear(): void;
  readonly length: number; readonly dropped: number; readonly capacity: number;
}
```

`NetClient` accepts `Events` in the states it accepts `Snapshot` (Joined … Playing, Resyncing); otherwise they are ignored and counted in `ignoredMessages`. `update()` emits due events before it calls `mirror.gc` (B.1). The emitted object is the buffered one, so listeners share it (`createClient` forwards it to `RenderWorld.pushEvent` and re-emits it). Besides Resync, `connect()` and entering Disconnected clear the buffer, so no event of a closed connection is emitted later.

### B.8 `RegionClient`

```ts
export class RegionClient {
  constructor(opts: RegionClientOptions);
  apply(set: RegionSetPayload): void;             // NetClient calls on RegionSet
  loaded(): RegionId[]; loading(): RegionId[];   // sorted
  on(evt: RegionClientEvent, cb: (id: RegionId) => void): () => void;   // RegionClientEvent = 'regionLoaded' | 'regionUnloaded'
  reset(): void;                                 // releases everything immediately, without a report (disconnect, not resync)
}
export interface RegionClientOptions {
  report: (loaded: RegionId[], loading: RegionId[]) => void;   // NetClient.reportRegions
  loader?: AssetLoader; manifest?: Manifest;     // docs/assets.md §3; loading needs both (one alone logs a warning and counts as neither); each also accepts undefined
  timers?: RegionClientTimers;                   // { setTimeout, clearTimeout } for the release grace; default the global timers (NetClient passes its own)
  log?: LogFn;
}
```

State per held region: `{ id, assets: AssetId[], status: 'loading' | 'loaded', pending: { priority: Priority; abort: AbortController } | null, handle: GroupHandle | null, releaseTimer }` (`Priority = 'high' | 'low'`, docs/assets.md §3.1). `pending` is the acquisition whose outcome counts; the outcome of any other is ignored.

```
apply(set):                                               // lists de-duplicated and sorted; prefetch −= active
  for id in set.active:   ensure(id, 'high')              // active first: their members queue ahead of prefetch ones
  for id in set.prefetch: ensure(id, 'low')
  for r in held:
    if r.id is listed:       clear r.releaseTimer
    elif no loader:          release(r) now               // the M1 behaviour
    elif no r.releaseTimer:  r.releaseTimer = setTimeout(() => { release(r); emit('regionUnloaded', r.id); report() }, REGION_RELEASE_GRACE_MS)
  emit('regionLoaded') for the regions loaded at once, then 'regionUnloaded' for those released now (each sorted)
  report()

ensure(id, priority):
  r = held.get(id)
  if r: if priority == 'high' and r.pending?.priority == 'low': promote(r)   // never demoted
        return
  r = { id, assets: loader && manifest ? manifest.regions[id] ?? [] : [], status: 'loaded', pending: null, handle: null, releaseTimer: null }; held.set(id, r)
  if r.assets is empty: return                            // loaded at once
  r.status = 'loading'; acquire(r, priority)

acquire(r, priority):
  p = r.pending = { priority, abort: new AbortController() }
  loader.acquireGroup(r.assets, priority, p.abort.signal).then(
    handle => { if held.get(r.id) !== r or r.pending !== p: handle.release(); return   // released, reset or promoted meanwhile
                r.pending = null; r.handle = handle; r.status = 'loaded'; emit('regionLoaded', r.id); report() },
    err    => { if held.get(r.id) !== r or r.pending !== p: return                     // our own abort
                r.pending = null; log('warn', …, { region, err }); r.status = 'loaded'; emit('regionLoaded', r.id); report() })
                // reported loaded so a missing asset never blocks play; missing models render as placeholders (docs/render.md)

promote(r):                             // a prefetch region still loading became active
  low = r.pending; acquire(r, 'high')   // takes a reference on every member at once (docs/assets.md §3.1); the loader moves each queued 'low' member, with its queued 'low' deps, to the end of the high queue (§3.2)
  low.abort.abort()                     // hands the 'low' references back; the 'high' acquisition holds every member, so nothing is dequeued or aborted

release(r):
  held.delete(r.id); clear r.releaseTimer
  r.pending?.abort.abort()              // still loading: members nobody else holds are dequeued or have their backend load aborted (docs/assets.md §3.1)
  r.handle?.release()                   // loaded: members enter the loader's own unload grace

report(): report(loaded = ids with status 'loaded', loading = ids with status 'loading')   // sorted; NetClient sends RegionLoadState immediately
```

**Promotion** (PLAN.md Open item 5, settled in M3). The loader needs no `setPriority`: acquiring a group again at `'high'` promotes its queued members, and members already `loading` keep their slot. So a prefetch region that becomes active while loading is re-acquired at `'high'` and its `'low'` acquisition is aborted right after, in that order (aborting first could drop the last reference and dequeue or abort members). A region is never demoted (an active region that becomes prefetch finishes at `'high'`), and a failed group is not retried until the region is released and listed again.

`regionLoaded` fires once per region, when it becomes loaded (at once without assets, or when its group completes or fails). `regionUnloaded` fires for every held region that is released, loaded or still loading, so a consumer caching `loaded()`/`loading()` (docs/game.md §4 `FrameContext.regions`) can refresh on either event.

**Without a loader and a manifest** (the M1 behaviour; headless clients and games without assets): every listed region (active or prefetch) counts as loaded at once and fires `regionLoaded`; a region dropped from the set is released at once (`regionUnloaded`); `loading()` is empty and no timer is used.

`RegionLoadState` is therefore sent once per `RegionSet`, once per group completion or failure, and once per release after the grace. `NetClient` moves Loading → Ready once the last report's `loaded` covers the latest `active`: every active group has completed or failed; prefetch groups never hold it back. The asset loader's own 5 s unload grace (docs/assets.md) stacks with this one; that is intended (a region bouncing in and out of `wanted` never refetches). Resync does not call `reset()`: the loaded set is kept and re-reported when the server re-sends `RegionSet`. Neither do Reconnecting (loads and release timers carry on; their reports are not sent while the server does not know the client) nor a fresh join after a reconnect, whose `RegionSet` follows its `Ready`.

### B.9 Files — packages/net-client

| File | Exports |
| --- | --- |
| `src/index.ts` | re-exports |
| `src/constants.ts` | B.1 constants, `gcLagTicks(snapshotEvery)`, `isReconnectableClose(code)` (A.3's last column; outside the table 1005, 1006 and 1011–1014 reconnect and every other code does not), `LogLevel`, `LogFn`, `consoleLog` |
| `src/transport.ts` | `Transport`, `TransportFactory`, `webSocketTransport`, `MemoryTransport` (+ `MemoryLink` implementing `ClientLink` for tests, paired), `MemoryTransportOptions`, `MemoryTimers`, `MEMORY_PRE_QUEUE_MAX` |
| `src/state.ts` | `ClientState`, `CLIENT_STATES`, `CLIENT_TRANSITIONS` (edge table), `canTransition`, `assertTransition` |
| `src/net-clock.ts` | `NetClock`, `NetClockOptions`, `toU32Ms` |
| `src/sample-ring.ts` | `SampleRing`, `Sample` |
| `src/interpolate.ts` | `sampleComponent(def, ring, latest, renderTick, out, timing)`, `extrapolateComponent(def, newestTick, newest, renderTick, out, timing)`, `valueAt(ring, tick)`, `REMOVED`, `SampleTiming` (pure; used by ReplicaWorld) |
| `src/replica-world.ts` | `ReplicaWorld`, `ReplicaEntity`, `ReplicaWorldOptions`, `ReplicaAt`, `ReplicaReader` |
| `src/input-sender.ts` | `InputSender`, `InputRing`, `InputSenderOptions` |
| `src/prediction.ts` | (M6, B.10) `Reconciler`, `ReconcilerOptions`, `PredictionOptions`, `PredictionStats`, `Predictor`, `PredictorHook`, `ReconcileView`, `PendingInput`, `PendingInputs` |
| `src/event-buffer.ts` | `EventBuffer`, `ReplicatedEventInfo` |
| `src/region-client.ts` | `RegionClient`, `RegionClientOptions`, `RegionClientEvent`, `RegionClientTimers` |
| `src/net-client.ts` | `NetClient`, `NetClientOptions`, `NetClientEvents`, `ClientGameDef`, `ClientTimers`, `NetClientStats`, `DisconnectInfo`, `GameMessageInfo`, `PlayerEntry`, `ConnectError`, `ConnectErrorKind`, `describeRejected`, `rejectReasonName`, `kickReasonName` |
| `src/frame-io.ts` | `FrameEncoderSession` (seq counter + `FrameWriter` wrapper: `begin/add/addWith/finish/abort/single/reset`), `dispatchFrame(buf, registry, handlers): number` (decodes every message, then dispatches), `ServerMessageHandlers` |

| Test | Must prove |
| --- | --- |
| `test/transport.test.ts` | `MemoryTransport` pair delivers in order, `close` fires once on both ends, a `latencyMs` function delays each message and close on its own while keeping order, `webSocketTransport` throws without a global `WebSocket` |
| `test/state-machine.test.ts` | every row of the B.3 table with a scripted `MemoryTransport`: `setTarget` changes the url and Hello token of the next `connect()` and throws while connected or for an over-long token (M5); Hello bytes on open, Ready auto-sent after Welcome, Rejected never reconnects, drop before Playing → Disconnected, drop in Playing → Reconnecting with backoff sequence `[500,1000,2000,4000,8000]` (attempts failing by drop, reconnectable close, error and timeout, each Hello with the reconnect token) then Disconnected, `Welcome` with a different playerId or token falls back to fresh join with the clock reset (M4). Also (M4): a Welcome for the same player → Resyncing (replica, jitter and input ring reset, clock window and regions kept, RegionLoadState re-sent, no Input) → Playing on a FULL snapshot and the own Spawned in either order; which kicks and close codes reconnect from Playing; Rejected, a non-reconnectable close and `disconnect()` (during a backoff or an attempt) end Reconnecting; a lost resync continues the attempt counter; `stats()` per-second byte rates over `(now − 1000, now]` |
| `test/net-clock.test.ts` | with fake `now`: samples with synthetic one-way delay `10 ms + uniform(0, 30)` and RTT jitter converge so `|offsetMs − trueOffset| ≤ 40 ms` after 16 samples and never exceed it afterwards; `jitterMs` for a 50 ms snapshot cadence with ±20 ms jitter settles in 5..30 and is clamped at 50 for wild input; slew stays within ±2% per update and a 300 ms error snaps; `inputLead` for RTT 0/16/100 ms at 60 Hz is 1/2/4 (`ceil(50 / 16.67) + 1 = 4`); after a stalled 294 ms first Pong a 1 ms Pong brings `rttMs` to 1 and `inputLead` to 2 at once, while a higher sample moves it by `RTT_ALPHA`; `serverTickNow` never runs backwards across a window shift |
| `test/interpolate.test.ts` | exact midpoints for fixed/f32/vec2/vec3; quat slerp shortest path (`q` vs `−q` inputs give the same path); angle16 across the `0/2π` seam interpolates the short way; non-interpolated and non-numeric fields take the earlier sample; extrapolation `pos + vel × dt` up to `snapshotEvery` ticks then holds; renderTick before oldest returns oldest; single-sample ring returns it |
| `test/sample-ring.test.ts` | capacity 8 evicts oldest; `bracket` at exact ticks, between, before, after; older ticks ignored on push |
| `test/replica-world.test.ts` | creates/updates/removed/destroys; FULL resets; duplicate create tolerated; `visibleAt` boundary conditions (`createdTick == renderTick` visible, `renderTick == destroyedTick` not); `gc` removes only destroyed-before; Region component updates `regionId`; delta-equals-full: applying deltas built by the server builder fixture (shared JSON fixtures with `net-server/test/snapshot-builder.test.ts`) yields the same `latest` maps as a single FULL (fixtures: net-server's `test/fixtures/<name>.json` timelines and their `<name>.expected.snap` JSON recordings of each tick's delta and FULL builds) |
| `test/input-sender.test.ts` | one message per tick with ≤ 4 ascending frames; ticks never regress when `inputTick()` dips by less than 4 or stalls, and follow it back after a drop of 4 or more, sending only the ascending tail; `sampleInput` used when provided; ring reuses objects |
| `test/event-buffer.test.ts` | dispatch order by tick then arrival; nothing before `renderTick` reaches the tick; cap drops oldest; clear on resync; through `NetClient` with a scripted server: `'event'` is emitted from `update()` (not on arrival) on the first update whose render tick reaches the tick, once, as exactly `{ def, tick, regionId, payload }`; a late event goes out on the next update; `Events` before Welcome are ignored; nothing is emitted after `disconnect()`; an entity destroyed at the event's tick is still in `mirror` for listeners when a stalled update also collects it; (M4) the resync Welcome forgets events buffered from the lost connection while the new connection's events go out |
| `test/region-client.test.ts` | with a real `AssetLoader`, a manual backend and manual timers (a fake loader for late outcomes): without a loader and a manifest every region is loaded and released at once (M1); a report on every `apply` and on each group completion; active groups acquired `'high'`, prefetch `'low'`, and the backend starts active members first; regions without assets count as loaded at once; a prefetch region still loading that becomes active is re-acquired at `'high'`, its queued members load before older `'low'` ones, a member already loading is not interrupted, and each member ends with one reference; the 5 s release grace runs from the first RegionSet that drops a region and is cancelled by re-listing; releasing a region still loading dequeues or aborts its members and never reports it loaded; a failed group is reported loaded with one warning and holds no references; `reset()` cancels loads, releases groups and clears timers without reporting; an outcome arriving after its promotion or release is released and ignored; through `NetClient`: Loading waits for the active groups but not prefetch ones, Ready goes back to Loading for a new active region still loading, a failed group still reaches Playing, and `RegionLoadState` is re-sent on each completion, RegionSet and release |
| `test/reconnect.test.ts` | client + `Session` (its `FixedLoop` on fake timers) over `MemoryTransport`/`MemoryLink`, with attempts made unreachable on demand: a drop in Playing retries after 500 and 1000 ms while unreachable and then 2000 ms, returns through Resyncing to Playing with the same `playerId`, entity and `reconnectToken`; the Welcome empties `mirror`, the first snapshot is FULL with `baselineTick 0`, and right after it (and later) `mirror.latest` for every entity equals the server's replicated stores; no Input is sent or queued during the outage (the new connection's first Input carries one frame) and the outage's steering is not replayed; events emitted during the outage are not delivered; after the server-side grace expired the reconnect is a fresh join (same `playerId`, new token and entity, through Joined); `Kicked{ServerShutdown}` + 1001 reconnects and the stopped session's Rejected ends it; a Rejected connect never reconnects; `disconnect()` stops the attempts; `bytesInPerSec`/`bytesOutPerSec` equal the frame bytes of the last second, are plausible for 60 Hz input and 20 Hz snapshots, fall to 0 in an outage and recover |
| `test/headless-two-client.test.ts` | two `NetClient`s against one `Session` over `MemoryTransport` with fake timers: both reach Playing; A's input changes A's Transform as sampled by B at `renderTick`; B's `visibleAt` never shows an entity before its `createdTick`; A `disconnect()` → B sees the destroy after the interpolation delay; a client whose first Pong reaches its clock 294 ms late (the browser renderer stall) has its input applied within a second once playing; a server held up 300 ms drops the ticks it missed and B's tick epoch moves less than a tick, its render tick never turns back, A on B never moves faster than A drives nor back by more than one snapshot interval of extrapolation, and A's steering reaches the server as promptly as before; replicated events with three clients: a system emits `Horn` in A's region and B (and A) get it once, with its payload, on the first frame whose render tick reaches its tick, while C, whose interest excludes the region, gets nothing (and hears its own horn); an event naming an entity destroyed in the same tick finds it in B's `mirror` through the end of that frame; Spike 3 (B.1) |
| `test/prediction.test.ts` | (M6, B.10) `Reconciler` alone: one frame recorded per Input message with the message's seq, a tick not above the newest recorded ignored, a full ring evicting its oldest frame into `droppedFrames`; a snapshot prunes every frame at or below `serverTick`, counts those above `lastInputTick` in `missedFrames`, never lowers the acknowledgement, and sets `authoritativeTick` only while the local entity is alive in the replica, which it leaves untouched; `reset` clears the connection state and keeps the counters; no more than `capacity` frame objects are ever created; the predictor's hooks get the recorded frame and a view whose pending ticks are all above `serverTick`, and a throwing hook is reported while the stub carries on. Through `NetClient` with a scripted server: off by default and with `{ enabled: false }` (`prediction` is `null`, `stats()` has no `prediction`, no `Reconciler` method runs, and no input frame is created or copied beyond `InputSender`'s own); on, the counters follow the scripted acknowledgements while the client sends the same messages and bytes and builds the same replica as with it off; the Welcome of a resync and of a fresh join, and `disconnect()`, reset it; a throwing predictor is logged at most once per second while inputs, snapshots and Acks carry on. Against a `Session` over `MemoryTransport` with fake timers: every snapshot's `lastInputSeq` is the seq the stub recorded for the frame at `lastInputTick`, the acknowledged tick advances while the frames pending at each snapshot stay within a tick of the input lead and none is missed or dropped, and after a reconnect the acknowledgement starts over |

### B.10 Reconciliation stub

**Purpose.** `Reconciler` in `src/prediction.ts` provides bounded input acknowledgement
bookkeeping and dispatches optional `Predictor` hooks. With `{ enabled: true }` alone it predicts
nothing; entities use authoritative replica presentation. Pass `PredictionDriver` as the predictor
for bounded adapter-driven simulation/replay, and give `createClient` a `PresentationProvider`
to present its sampled pose. See “Opt-in prediction driver and coherent presentation” below.
The game adapter owns rules and declares all state/conditions needed for coherent reconciliation.
Prediction remains off by default: an absent option or `{ enabled: false }` creates no reconciler,
prediction rings or driver work.

**What it consumes.**

- The snapshot header's input acknowledgement (docs/protocol.md 9.11): `lastInputTick`/`lastInputSeq` are the server's `appliedTick`/`appliedSeq` (A.7, A.8.1), the tick of the last input frame it applied and the envelope seq of the Input message that first carried that frame. `serverTick` is the global completed tick for the snapshot; the server has drained inputs through it, but budgeted entities/groups may retain an older coherent state tick (A.7, bounded replication).
- The client's unacknowledged input frames: each Input message `InputSender` sends (B.6) adds one frame, its newest. `NetClient` hands the stub each message it sent together with the message's envelope seq, and the stub copies that frame: `InputRing` keeps only `INPUT_RING` frames, fewer than a 60 Hz client with a 100 ms RTT has unacknowledged (its 4-tick input lead, the 3 ticks a snapshot travels and up to a snapshot interval), and acknowledgements do not prune it.
- The local entity's authoritative sample: after `mirror.applySnapshot(s)`, `mirror.get(NetClient.entity)` holds immutable admitted values in `latest`. Under budgeting, the entity's `mirror.authoritativeTick(entity)` may lag `serverTick`; an adapter must check this tick and all declared dependencies before replay.

```ts
export interface PredictionOptions {
  enabled: boolean;                                  // NetClientOptions.prediction absent: disabled
  predictor?: Predictor | undefined;                 // the plug-in point (below); ignored unless enabled
}
export interface PendingInput { readonly tick: number; readonly seq: number; readonly frame: Readonly<InputFrameBase> }   // frame: the stub's copy, in a reused slot
export interface PendingInputs { readonly length: number; at(i: number): PendingInput }   // 0 = oldest; ticks strictly ascending; RangeError outside 0..length−1
export interface ReconcileView {                     // one object per Reconciler, updated before each reconcile call
  readonly serverTick: number;                       // of the snapshot just applied
  readonly ackedTick: number; readonly ackedSeq: number;   // the highest lastInputTick on this connection and its lastInputSeq; 0 before any
  readonly entity: EntityId;                         // NetClient.entity: ENTITY_NONE before the own Spawned
  readonly authoritative: ReplicaEntity | undefined; // mirror.get(entity) while alive there (destroyedTick null)
  readonly replica: ReplicaWorld;
  readonly pending: PendingInputs;                   // the frames above serverTick: what a predictor replays
}
export interface Predictor {                         // every hook is optional
  inputSent?(input: PendingInput): void;             // each frame the stub records, right after its Input message went out
  reconcile?(view: ReconcileView): void;             // each snapshot, after pruning
  reset?(): void;                                    // each stub reset
}
export type PredictorHook = 'inputSent' | 'reconcile' | 'reset';
export interface PredictionStats {
  pendingFrames: number;                             // recorded frames above the newest snapshot's serverTick (≤ PREDICTION_RING)
  lastAckedTick: number; lastAckedSeq: number;       // ackedTick / ackedSeq
  authoritativeTick: number;                         // serverTick of the newest snapshot that held the local entity alive; 0 when none on this connection
  ackedFrames: number;                               // since construction: frames pruned because a snapshot's serverTick reached them
  missedFrames: number;                              // since construction: pruned frames above that snapshot's lastInputTick (passed over, never applied)
  droppedFrames: number;                             // since construction: frames evicted from a full ring before a snapshot reached them
}
export interface ReconcilerOptions {
  capacity?: number;                                 // default PREDICTION_RING; RangeError unless an integer ≥ 1
  predictor?: Predictor | undefined;
  onPredictorError?: ((err: unknown, hook: PredictorHook) => void) | undefined;   // default: consoleLog('error', 'predictor.<hook> threw', { err })
}
export class Reconciler {
  constructor(schema: Schema<InputFrameBase>, replica: ReplicaWorld, opts?: ReconcilerOptions);
  readonly pending: PendingInputs;
  onInputSent(msg: InputPayload, seq: number): void;
  onSnapshot(header: SnapshotHeader, entity: EntityId): void;
  reset(): void;
  stats(): PredictionStats;                          // a new object per call
}
```

```
connection state: ring of `capacity` PendingInput slots (a slot's frame object is created on first use, then reused)
                  newestTick = 0; ackedTick = 0; ackedSeq = 0; authoritativeTick = 0
counters since construction: ackedFrames = missedFrames = droppedFrames = 0

onInputSent(msg, seq):                               // NetClient, once the Input message went out with envelope seq `seq`
  f = msg.frames[msg.frames.length − 1]              // the frame this client tick stamped
  if f.tick <= newestTick: return                    // the server ignores it too (A.7); defensive guard; B.6 suppresses duplicate/backward eligible ticks
  newestTick = f.tick
  if ring.length == capacity: ring.shift(); droppedFrames++
  slot = ring.push(); slot.tick = f.tick; slot.seq = seq; schema.copy(f, slot.frame)
  predictor?.inputSent(slot)

onSnapshot(h, entity):                               // NetClient, after mirror.applySnapshot(s) and the Ack, before 'snapshot' listeners
  if h.lastInputTick > ackedTick: ackedTick = h.lastInputTick; ackedSeq = h.lastInputSeq
  while ring.length > 0 and ring.at(0).tick <= h.serverTick:   // applied or passed over for good
    if ring.at(0).tick > h.lastInputTick: missedFrames++      // after the last frame the server applied
    ring.shift(); ackedFrames++
  ent = entity == ENTITY_NONE ? undefined : replica.get(entity)
  authoritative = ent !== undefined and ent.destroyedTick === null ? ent : undefined
  if authoritative: authoritativeTick = h.serverTick
  predictor?.reconcile(view)                         // { serverTick: h.serverTick, ackedTick, ackedSeq, entity, authoritative, replica, pending: ring }

reset():                                             // wherever NetClient resets InputSender: connect(), the Welcome in Reconnecting (resync or fresh join), entering Disconnected
  ring.clear(); newestTick = ackedTick = ackedSeq = authoritativeTick = 0
  predictor?.reset()
```

A recorded frame's `seq` is the seq the server stores with it. The server accepts a frame only when its tick is above every tick it accepted before (A.7), and messages arrive in order, so it takes each frame from the first message that carried it, the one whose newest frame it was; the stub records under the same rule. So when a snapshot names a new `lastInputTick`, the stub's pending frame with that tick has `seq === lastInputSeq`. The server resets `appliedTick`/`appliedSeq` to 0 when it rebinds a reconnecting player (A.6), and the stub resets at that connection's Welcome, so the acknowledgement starts over with the connection.

A hook that throws is caught and handed to `onPredictorError(err, hook)`, and the stub carries on as if the hook had returned (`NetClient` logs `'predictor.<hook> threw'` at most once per second, as for `sampleInput`), so a predictor can break neither the client tick nor the snapshot handler.

**Acknowledgement tracking without a predictor.** `Reconciler` tracks the acknowledgement, prunes the frames a snapshot reached and keeps the counters: `NetClient.stats().prediction` is `Reconciler.stats()` while enabled. It replays nothing, holds no predicted state and never writes to `mirror`, the clock, the event buffer, the input stream or anything render reads, so a client with the stub on sends the same frames and builds the same replica as one without it. `missedFrames` is a lower bound: the header names only the last applied frame, so a frame at or below `lastInputTick` that the server passed over counts as acknowledged, not missed. `droppedFrames` grows only when acknowledgements stop while input keeps flowing, for more than `PREDICTION_RING` client ticks.

**Disabled (the default).** `NetClient.prediction` is `null`: no `Reconciler`, ring or frame copy exists, the `InputSender` callback is the plain send, the snapshot handler and the reset points do nothing beyond a null check, a `predictor` in the option is never called, and `stats()` has no `prediction` key.

**Plugging in a predictor.** Pass `prediction: { enabled: true, predictor: driver }`, where
`driver` is a `PredictionDriver` configured with the game's adapter. The driver retains its own
bounded input/state history; it does not treat the bookkeeping ring's global snapshot pruning as
proof of a coherent local state. The adapter returns an explicit authoritative tick and checks
all dependencies before reconciliation; the driver replays fixed ticks with held controls and
separate command outcomes. Pair it with `createClient`'s `presentation` provider for shared
region-local model/camera poses. Sampling reads readonly state and writes caller-owned output
without stepping simulation. Reset boundaries and command retirement are detailed below.
Custom `Predictor` hooks remain supported, with borrowed readonly inputs valid only during the call.

Authoritative faults close clients with terminal code **4012** (`SessionFault`), stop admission and
prevent partial state/event publication and persistence capture. Unlike a relevance callback failure,
a mutating game hook failure faults the whole session. Resume only after explicit checkpoint recovery.


### Opt-in prediction driver and coherent presentation

`PredictionDriver<S, I, P, C>` implements the existing Predictor hooks. Construct it only when
prediction is enabled, then pass `{ enabled: true, predictor: driver }` to NetClient/createClient.
The adapter owns all game rules: create/copy state, read the complete authoritative state,
fixed-tick step, tolerance-aware equality, reset and pure presentation sampling. It must declare
all evolving state, external conditions, authoritative held controls and command outcomes. Core
never derives a vehicle/character/inventory model from Transform or infers action semantics.
Three distinct public adapters live in game/test/fixtures/scenario-consumers.ts.

`readAuthoritative(view, out)` returns `{ coherent, authoritativeTick, boundaryKey, regionId,
heldInput, commandOutcomes? }`. authoritativeTick is the completed tick of the declared state,
which may trail the global snapshot tick and differs from input acknowledgement. A false
coherence flag leaves the driver's earlier input/history anchor intact. Reconcile copies state
at T, replays T+1 onward one fixed tick at a time, and holds the declared controls until a recorded
input changes them. Authoritative replica maps, values and sample history are immutable read
facades; application takes owned copies rather than freezing caller/simulation values.

The driver retains bounded reusable state/input slots (default 128 ticks, configurable2..4096)
and limits per-call replay work to capacity or maxReplayTicks. Overflow/large jumps reset instead
of executing unbounded catch-up. Entity generation, region/boundary changes and connection reset
clear obsolete history. Change boundaryKey for teleportation or game-owned discontinuities.
`sample(tick, out)` clamps to retained states and invokes adapter.sample with guarded scratch
copies and deeply readonly types; it never steps persistent timers, inventories or random
streams. Equality tolerances belong to the consumer and should include quantified wire rounding.

Commands use `recordCommand(id, tick, command)` and a required copyCommand callback. They are
separate from held input, applied once per simulated tick (including deterministic replay), and
require explicit authoritative confirmed/cancelled outcomes before their tick can be pruned.
A late command pauses prediction until a coherent replay anchor arrives. Bounded command/outcome
history rejects further speculation when full until reset. Reset cancels remaining commands;
notification errors cannot leave partial lifecycle state. Do not perform irreversible effects
inside adapter.step, especially with phase replay.

`SpeculativeEffects<T>` supplies bounded opaque-ID begin/confirm/cancel hooks. Tombstones prevent
duplicate lifecycle calls within an epoch; a full ledger rejects new effects. Explicit reset
cancels pending effects once and starts a new epoch; advanceEpoch(next) declares a strictly
increasing caller-owned retention boundary and performs that reset. stats reports retained/pending
entries, rejected attempts and pressure. This is the supported recovery from a full ledger;
old IDs are no longer deduplicated after the boundary, so applications must scope their IDs
and confirmation messages by epoch. There is no arbitrary-lifetime exactly-once guarantee. IDs should include the consumer's connection
or gameplay epoch. Callback failures are contained and reported through optional onError.

NetClient/createClient `extrapolation: { horizonMs, onLimit: 'hold' | 'reset' }` opts into an
explicit 0..10000 ms horizon. Hold keeps the extrapolated horizon endpoint; reset uses the newest
authoritative value once the horizon is exceeded. Without this option the existing one-snapshot
interval limit remains. Scalar/vector/quaternion interpolation remains schema-driven; custom
state/presentation sampling belongs in the adapter.

`authoritativeEvent` fires on arrival; `event` remains delayed until the render clock reaches its
tick. Both hooks receive the same immutable owned object and stable id. Identity includes client
source, connection epoch, server message tick/sequence and receipt order; sequence wrap does not
reuse IDs. A bounded 128-message tick/sequence dedupe window suppresses recent duplicates. Arrival
order is explicit, while delayed delivery sorts by tick then arrival. Treat these as two views
of one event: apply authoritative outcomes once by ID and reserve delayed hooks for presentation.
Events buffered during an outage are discarded on resync; no historical effects are synthesized.
Payloads remain valid after callbacks, but retaining them is consumer-owned memory.


### Bounded diagnostic capture

`DiagnosticCapture` and `DiagnosticOptions` from @conduit/math provide an optional version 1
observer contract shared by simulation drivers, clients, rendering, saves and assets. Pass
`diagnostics: { observer: capture, now: monotonicNow }`; Simulation requires the injected clock,
while drivers default to their existing monotonic source. Systems receive no clock or observer
in SimContext. Disabled paths construct no measurement records or duration arrays and do not
read diagnostic clocks at each invocation boundary. Throwing/nonfinite clocks and throwing
observers are isolated; backwards timing is unavailable rather than a zero-duration success.

Capture defaults to 256 records, 64 distinct metrics and 128 recent duration samples per metric;
configurable hard limits are 4096/128/2048. History overflow drops oldest records, excess metric
names are rejected, and repeated error records are rate-limited (default 1000 ms). stats/export
compute percentiles from bounded recent samples; no sorting occurs per observation. Cumulative
counts and recent percentiles describe different windows. Unknown GPU durations remain absent.
Records use static metric/system labels, explicit ticks, counts/bytes/durations/status, without
raw payloads, chat, account IDs, tokens or error causes.

`capture.export({ compatibility, configuration })` accepts an explicit bounded whitelist of
revision names and numeric timing/capacity options, not arbitrary metadata. Correlations are
omitted by default; the optional second argument must explicitly opt into caller-supplied opaque
correlation IDs. No capture is uploaded automatically. Session/client observers cover stage and
system durations, input sends/suppression/lead/queue pressure, snapshot/frame bytes, clock
corrections, prediction reconciliation/corrections and save timing. Renderer/asset observers add
their own domain-specific records. This is a diagnostic summary, not a replay or exact state save.

Performance comparisons, inspector allocation attribution and raw browser timing results are in
artifacts/improvements; scripts/improvements contains repeatable measurement drivers. The first
128-entity single-system comparison exceeded its preselected25 percent p95/allocation tolerance;
subsequent validation optimizations are recorded separately and do not erase that result.
Enabled/disabled observer overhead is measured separately from total framework change cost.
These small synthetic timings do not establish production capacity or headroom.


For long command sessions, `driver.retireCommandHistory(throughTick)` declares a monotonic
retention boundary no later than authoritativeTick and removes resolved command tombstones
without resetting movement history. The caller must never reuse retired IDs or resend outcomes
from before that boundary; scope IDs by a consumer-owned command epoch. Driver stats expose
commandHistory/commandPressure/rejectedCommands/retiredCommandsThrough. Without retirement, a
full bounded history rejects new speculation explicitly. There is no arbitrary-lifetime opaque-ID
exactly-once guarantee. Adapter read/copy/equality/sample/step failures reset prediction readiness
before propagating to the existing predictor-error boundary; notification callback errors are
contained separately.


Release timing coverage is split deliberately. game/test/scenario-network.test.ts runs full
public NetClient/Session admission, reliable transport, command dispatch and reconnect/resync
for three consumers. Named profiles cover zero delay, asymmetric delay, byte-serialized backlog,
700 ms client-lane stall, a delayed/fresh Pong correction and a real FixedLoop server overrun;
the jitter/resync profile varies 30/60/120/144 presentation cadences. Quiesced visible replica
values match authority at f32 precision, and hidden inventory items stay hidden behind an
explicit replicated count/revision projection. full-network-scenarios.json records all30 seeds,
effective schedules, queue peaks, counters and lifecycle outcomes.

scripts/improvements/measure-browser.mjs uses actual Chromium/Firefox/WebKit timers with an
independent browser worker authoritative model. The72-run baseline/current matrix records input
callbacks to the first presented discrete state revision at four requested cadences plus a120 ms
main-thread stall. This is not GPU/pixel/perceptual latency or proof of physical display rates;
the initial matrix did not record actual frame counts. Latency remains descriptive because no
latency tolerance was selected before comparison, and no latency improvement is claimed. Exact
browser versions and complete/failed/partial status are captured. ClockSnaps is render-clock
behavior, not a prediction-correction metric. The separate nine-run browser-prediction capture
uses public game adapters and records prediction counts/magnitudes; vehicle/character required
no correction, inventory command timing required at most one item of correction in this run.
Native/headless deterministic tests remain the fixed-tick and replay correctness gate. Physical
hidden-tab throttling, hardware-specific display cadence and GPU timing need separate measurements.

The bounded snapshot transaction, masking, dependency-group, egress and client validation contract is specified in [bounded replication](bounded-replication.md).
