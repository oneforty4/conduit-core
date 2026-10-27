# @conduit/world

Session persistence uses detached `captureSave` images and staged evictions; standalone `flushAll` remains region-only. External load/save outcomes apply at `update` boundaries and exact region checkpoints preserve streaming state. See [generation saves](generation-saves.md).

Implementation specification for `@conduit/world`: world graphs, region streaming, migration,
spatial index and interest. Depends on `@conduit/math`, `@conduit/protocol`, `@conduit/sim`.
Isomorphic; obeys the sim purity rules (`docs/sim.md` section 2.12). `BlobStore` is specified in
`docs/persist.md` (this package only depends on the structural `RegionStore` subset below, so it
does not import `@conduit/persist`); the snapshot builder that consumes interest is in
`docs/net.md`; region asset groups are in `docs/assets.md`.

The `Session` (`docs/net.md`) drives this package each tick in the canonical order of
`docs/sim.md` 2.9, of which the relevant part is:

```
regions.update(players, ctx, pending, interest)   // every tick, before sim.step: activations land on a tick boundary
sim.step(tick)                                     // tail = [regions.membershipSystem.run, spatial.rebuild]  (docs/sim.md 2.9)
```

---

## 1. Types

```ts
export type RegionId = string;
export type AssetId = string;                          // docs/assets.md

export type RegionBounds =
  | { kind: 'aabb2'; origin: Vec3; min: Vec2; max: Vec2; plane: 'xz' | 'xy' }
  | { kind: 'aabb3'; origin: Vec3; min: Vec3; max: Vec3 }
  | { kind: 'node';  origin: Vec3 };

export interface RegionDef {
  id: RegionId;
  kind: string;
  bounds: RegionBounds;
  neighbors: RegionId[];       // graph order: GridWorld ascending by (iy, ix) (section 2), NodeWorld ascending by id (section 3)
  assets: AssetId[];
  seed: number;                // u32
  data?: unknown;              // game-defined, JSON-serializable if it must reach the client
}

export interface WorldGraph {
  readonly wantedDepth: number;                       // default depth of wanted: GridWorld opts.wantedDepth, NodeWorld 1 (section 9 prefetch uses it)
  get(id: RegionId): RegionDef | undefined;
  neighbors(id: RegionId): RegionId[];
  locate(worldPos: Vec3, hint?: RegionId): RegionId | null;
  wanted(id: RegionId, depth?: number): RegionId[];   // self first; deterministic order; depth defaults to wantedDepth
  toJson(): WorldGraphJson;
}
```

`min`/`max` are region-local: relative to `bounds.origin`. For `aabb2`, `Vec2.x` maps to world
`x`; `Vec2.y` maps to world `z` when `plane === 'xz'` and to world `y` when `plane === 'xy'`.
The third axis is unbounded. Containment is half-open: `min <= p < max` on each bounded axis.

Bounded region = `aabb2 | aabb3`. Node regions have no extent; entities in them never migrate by
movement.

**Static JSON form**, used by tooling (`conduit-assets build --graph`, `docs/assets.md`) and by
tests. The graph itself never crosses the wire: the client rebuilds it from the game definition and
`Welcome.worldSeed` (`game.world(seed)`, `docs/game.md`), which is what lets `RegionClient`
prefetch region asset groups.

```ts
export interface WorldGraphJson {
  version: 1;
  kind: 'grid' | 'node';
  grid?: { cellSize: number; cols: number; rows: number; plane: 'xz' | 'xy'; kind: string; wantedDepth: number; base: Vec3; worldSeed: number };
  regions: RegionDef[];        // every region; `data` included (as its JSON round-trip) only if JSON.stringify succeeds on it and returns a string, else omitted
}
export function fromJson(json: WorldGraphJson): WorldGraph;   // dispatches on kind to GridWorld.fromJson / NodeWorld.fromJson
```

`toJson` on a `GridWorld` enumerates all `cols * rows` regions in row-major order (sandbox: 16 x 16 = 256 defs of
256 m cells; a 64 x 64 grid is about 1 MB of JSON, so games with large grids keep `assets` per
cell short).

Validation in `fromJson`: `version === 1`, unique ids, every neighbour exists; throws
`WorldGraphError(message)`.

## 2. GridWorld

```ts
export interface GridWorldOpts {
  cellSize: number;                              // metres, > 0
  cols: number; rows: number;                    // >= 1
  plane?: 'xz' | 'xy';                           // default 'xz'
  kind?: string;                                 // default 'cell'
  originOf?: (ix: number, iy: number) => Vec3;   // default below
  assetsFor?: (ix: number, iy: number) => AssetId[];   // default () => []
  dataFor?: (ix: number, iy: number) => unknown;       // default undefined
  wantedDepth?: number;                          // default 1
  worldSeed: number;                             // u32
}
export class GridWorld implements WorldGraph {
  constructor(opts: GridWorldOpts);
  static fromJson(json: WorldGraphJson): GridWorld;
  readonly cellSize: number; readonly cols: number; readonly rows: number; readonly plane: 'xz' | 'xy'; readonly wantedDepth: number;
  indexOf(id: RegionId): { ix: number; iy: number } | undefined;   // parses `${kind}/${ix}_${iy}`: canonical decimal (no sign or leading zeros) inside the grid, else undefined
  idAt(ix: number, iy: number): RegionId;                           // formats only; no range check
}
```

Defaults and constants:

| Name | Value |
| --- | --- |
| `DEFAULT_WANTED_DEPTH` | `1` |
| default `originOf(ix, iy)` | plane `xz`: `(ix*cellSize, 0, iy*cellSize)`; plane `xy`: `(ix*cellSize, iy*cellSize, 0)` |
| region id | `` `${kind}/${ix}_${iy}` `` e.g. `cell/3_7` |
| region seed | `fnv1a32(id, worldSeed)` (FNV-1a over the id string with `worldSeed` as the basis) |
| bounds | `{ kind: 'aabb2', origin: originOf(ix, iy), min: {x:0, y:0}, max: {x:cellSize, y:cellSize}, plane }` |
| neighbors | 8-neighbourhood (Chebyshev distance 1), clipped to the grid, ascending by `(iy, ix)` |

Constructor invariant (asserted, throws `WorldGraphError`): `originOf` is grid-consistent, i.e.
`originOf(1,1) - originOf(0,0)` equals `cellSize` on both plane axes and `0` on the third. `base =
originOf(0,0)` is cached; `locate` relies on it. Origins are copied, so `originOf` may reuse its
return object. The constructor also throws `WorldGraphError` unless `cellSize` is finite and `> 0`,
`cols`/`rows` are integers `>= 1`, `wantedDepth` is an integer `>= 0`, `worldSeed` is a u32 and
`kind` is non-empty.

Region defs are built lazily and cached in a `Map<RegionId, RegionDef>` (lookup only, never
iterated for sim effects). `get` returns `undefined` for ids outside the grid or with another
`kind`.

`GridWorld.fromJson(json)` takes the parameters from `grid` and each cell's origin, `assets` and
`data` from `regions` (so the constructor invariant runs on the stored origins). It throws
`WorldGraphError` unless `version === 1`, `kind === 'grid'`, `grid.base` is the origin of cell
`(0, 0)`, and `regions` are exactly the `cols * rows` cells with the derived `kind`, bounds extent,
`neighbors` and `seed`.

```
axes(): (a, b) = plane === 'xz' ? ('x', 'z') : ('x', 'y')

locate(p, hint):
  if hint !== undefined:
    def = get(hint)
    if def: o = def.bounds.origin                                                            // = originOf(ix, iy) of the hint
            if o[a] <= p[a] < o[a] + cellSize and o[b] <= p[b] < o[b] + cellSize: return hint    // fast path
  ix = floor((p[a] - base[a]) / cellSize)
  iy = floor((p[b] - base[b]) / cellSize)
  if not (0 <= ix < cols and 0 <= iy < rows): return null                                    // written this way to reject NaN
  return idAt(ix, iy)

wanted(id, depth = wantedDepth):
  if depth is not an integer >= 0: throw RangeError
  idx = indexOf(id); if !idx: return []
  out = [id]
  for dy in -depth..depth: for dx in -depth..depth:      // row-major, ascending
    if dx === 0 and dy === 0: continue
    x = idx.ix + dx; y = idx.iy + dy
    if 0 <= x < cols and 0 <= y < rows: out.push(idAt(x, y))
  return out
```

`neighbors(id)` = `wanted(id, 1)` without the first element.

## 3. NodeWorld

```ts
export interface NodeWorldOpts { wanted?: (id: RegionId, graph: NodeWorld, depth: number) => RegionId[] }
export class NodeWorld implements WorldGraph {
  constructor(defs: RegionDef[], opts?: NodeWorldOpts);
  static fromJson(json: WorldGraphJson): NodeWorld;
  readonly wantedDepth: number;                     // 1
}
```

- Constructor validates: unique ids, every `neighbors` entry exists, is not the region itself and is
  listed once, every `bounds.kind === 'node'` (throws `WorldGraphError` otherwise). Defs are copied,
  with neighbour lists sorted ascending, and stored in a `Map` for lookup and an id-sorted array for
  `toJson`.
- `locate(pos, hint)` returns `hint` if it names a known region, else `null`. Entities never leave a
  node by moving; games call `RegionManager.migrate` explicitly (jump gates).
- `wanted(id, depth = 1)`: `[]` for an unknown id; `RangeError` unless `depth` is an integer `>= 0`.
  If `opts.wanted` is set, return its result for `(id, graph, depth)`, deduplicated, with `id` forced
  to be first (it gets `depth`, so a game can keep only the current system wanted and still prefetch
  its gate targets at depth 2, section 9); otherwise breadth-first to `depth` hops:
  `[id, ...hop1 sorted, ...hop2 sorted, ...]`, each id once.
- `toJson` has no `grid` section and follows the `GridWorld` rule for `data`; `fromJson` checks
  `version === 1` and `kind === 'node'`. An override is code and is not part of the JSON.

**Spike 4 decision (M3): a Spacehunter star system is one `node` region using the core
`Transform`.** Node regions do not subdivide, and space games do not define their own `Transform`.
`Transform.pos` is `fixed32(0.001)` on the wire: ±2 147 483.647 m per axis at 1 mm (`docs/sim.md`
2.5). The reference Escape-Velocity-style system has the star at the region origin, a few planets
within 50 km and a 100 km jump radius. Flown in real time at game speeds (a 250 m/s cruise reaches
the jump radius in 400 s), it uses under 5% of the range: a ship a third over that cruise, at
327.67 m/s per axis, needs 6 554 s (1 h 49 min) of straight flight along one axis to leave it.
(327.67 m/s was the cap of the replicated `Transform.vel` while that was `fixed16(0.01)`. It is
`f32` now and has none, so how fast a ship may go, and with it how soon it can reach the end of
the range, is the game's to hold.) Every position inside replicates within 0.5 mm, and the
server keeps doubles (sub-nanometre at 2 000 km). The alternatives lose. Subdividing a system into
bounded sub-regions adds border crossings, inboxes and interest churn inside one system for range no
game needs. `f.f32` positions are coarser than 1 mm beyond 16 km (0.125 m at 2 000 km), and
membership, `SpatialIndex` and the render binders read the core `Transform`. Node regions have no
extent, so nothing clamps a ship that keeps flying: a space game enforces its own system edge well
inside the range (the reference uses 1 000 km, beyond which the drive forces a jump or turns the ship
back). Past ±2 147 km the wire saturates at the limit while the server keeps the true position. A
system at real planetary scale would not fit; Spacehunter's is not one. `test/nodeWorld.test.ts`
exercises these bounds.

## 4. Region-local coordinates

`Transform.pos` (`docs/sim.md` 2.5) is relative to `RegionDef.bounds.origin` of the entity's
`Region.id`. Helpers in `coords.ts`:

```ts
export function toWorld(def: RegionDef, local: Vec3, out?: Vec3): Vec3;     // origin + local
export function toLocal(def: RegionDef, world: Vec3, out?: Vec3): Vec3;     // world - origin
export function rebase(from: RegionDef, to: RegionDef, pos: Vec3, out?: Vec3): Vec3;   // pos + (from.origin - to.origin)
export function contains(def: RegionDef, local: Vec3): boolean;             // node: true; bounded: half-open test on bounded axes
export function clampToBounds(def: RegionDef, local: Vec3, out?: Vec3): Vec3;   // clamp bounded axes to [min, max(min, max - CLAMP_EPS)]; NaN clamps to min
export const CLAMP_EPS = 1e-3;
```

Migration rebases with `rebase`, so a moving entity's world position is continuous across a border.
The client applies a floating origin per region group (`docs/render.md`).

## 5. RegionManager

```ts
export interface RegionLoader {
  populate(region: RegionDef, blob: RegionBlob | null, ctx: SimContext): void;   // after the manager restored blob.entities (5.3)
  onDeactivate?(region: RegionDef, ctx: SimContext): unknown;     // returned value is stored as blob.gameData
}

export interface RegionStore {                      // structural subset of docs/persist.md BlobStore; satisfied by every BlobStore
  get(ns: string, key: string): Promise<Uint8Array | null>;
  put(ns: string, key: string, blob: Uint8Array): Promise<void>;
  transaction<T>(fn: (tx: RegionStore) => T | Promise<T>): Promise<T>;
}

export interface RegionManagerOpts {                // optional fields also take `undefined`, so a Session can pass its own options through
  graph: WorldGraph;
  world: World;                                     // registry must hold Region, Transform (UnknownComponent) and the RegionChanged event (RangeError); defineGame's does
  loader: RegionLoader;
  store: RegionStore;                               // a BlobStore (docs/persist.md 1.2)
  tickRate: number;                                 // > 0, else RangeError
  lingerMs?: number | undefined;                    // default LINGER_MS; finite and >= 0, else RangeError
  log?: ((level: 'warn' | 'error', msg: string, err?: unknown) => void) | undefined;   // default no-op
  onWorldEdge?: ((e: EntityId, ctx: SimContext) => void) | undefined;
}

export type RegionState = 'inactive' | 'loading' | 'active' | 'saving';

export class RegionManager implements RegionsApi {
  constructor(opts: RegionManagerOpts);
  readonly membershipSystem: System;               // phase 'postSim'; run via Simulation.tail
  update(players: readonly EntityId[], ctx: SimContext, pending?: readonly RegionId[], interest?: readonly RegionId[]): void;   // pending: regions kept wanted, with their neighbourhood, for players not yet spawned (docs/net.md A.6 PlayerSpawn.regionId); interest: regions kept wanted exactly, the game's simulation interest (docs/net.md A.5 SessionHooks.simulationInterest); UnknownRegion for an interest id the graph lacks
  migrate(e: EntityId, to: RegionId, newLocalPos?: Vec3): MigrateResult;
  entitiesIn(id: RegionId): readonly EntityId[];   // ascending; [] if not active; the live list: copy it before migrating the entities it lists
  regionOf(e: EntityId): RegionId | undefined;     // Region.id if the entity has one
  active(): readonly RegionId[];                   // sorted ascending
  state(id: RegionId): RegionState;
  def(id: RegionId): RegionDef | undefined;
  lingering(id: RegionId): boolean;
  regionRng(id: RegionId): Rng;                    // section 7
  flushAll(): Promise<void>;
  inboxSize(id: RegionId): number;
}
```

Constants:

| Name | Value |
| --- | --- |
| `LINGER_MS` | `10000` |
| `lingerTicks` | `Math.round(lingerMs * tickRate / 1000)` (600 at 60 Hz) |
| `RETRY_MS` | `5000`; `retryTicks = Math.round(RETRY_MS * tickRate / 1000)` |
| `BLOB_NAMESPACE` | `'region'` |
| `BLOB_VERSION` | `1` |

Per-region record:

```
RegionRec {
  id, def, state: RegionState
  entities: EntityId[]          ascending; maintained by binary insert / remove
  rng: Rng | null               section 7
  lingerUntil: number           tick; Infinity when not lingering
  retryAt: number               tick; 0 when no failure
  blob: RegionBlob | null       content while not active, when known in memory: last blob loaded, saved, or merged with arrivals by flushAll; every activation restores from it
  saving: Promise<void> | null  the eviction's save, until it settles
  unsaved: boolean              blob holds content the store may not have (a save pending or failed)
}
pendingActivations: RegionId[]                           filled by async completions, drained at the start of update
inbox: Map<RegionId, SerializedEntity[]>                 section 6
playerSet: Set<EntityId>                                 the players passed to the last update (lookup only)
wantedSet: Set<RegionId>                                 the regions the last update wanted (lookup only)
recordedIn: Map<EntityId, RegionRec>                     the record listing each recorded entity (lookup only)
scanFrom: number                                         Region version stamps below this are already recorded (track)
```

**Records.** For an active region, `rec.entities` lists the entities whose `Region.id` is that
region; for any other region it is `[]`. It changes only through `record(rec, e)` (drop `e` from the
list of `recordedIn.get(e)`, `insertSorted(rec.entities, e)`, `recordedIn.set(e, rec)`) and
`unrecord(e)` (drop `e` from the list of `recordedIn.get(e)`, delete the entry); in the pseudo-code
below `insertSorted(rec.entities, e)` stands for `record(rec, e)` and `removeSorted(rec.entities, e)`
for `unrecord(e)`. Entities no step below records (created with `Region` by hooks or systems, or
whose `Region.id` is written directly) are picked up by `track()`, which runs in `update` before the
transitions (so an eviction saves them) and at the start of every membership pass: each entity of
the `Region` store whose `version` stamp (`docs/sim.md` 2.3) is `>= scanFrom` is `record`ed into the
record of its `Region.id` if that region is active, else `unrecord`ed; then `scanFrom` = the current
stamp tick (`world.tick` while stepping, else `world.tick + 1`). An entity created between steps is listed from the next `update`; one created
during a step, from that step's membership pass.

### 5.1 State machine

| From | To | Trigger | Actions |
| --- | --- | --- | --- |
| `inactive` | `loading` | wanted during `update` and `tick >= retryAt` | if `rec.blob` is non-null (content kept in memory) push `id` to `pendingActivations` and skip the store; else `store.get('region', id).then(bytes => { blob = decode(bytes); if rec.blob === null: rec.blob = blob; pendingActivations.push(id) }, err => fail(rec, err))` (a `flushAll` that ran meanwhile may have merged arrivals into `rec.blob`: keep that) |
| `loading` | `inactive` | `store.get` rejected, the blob fails to decode, or at activation a stored blob names a component the registry lacks (`BlobError`) | `log('error')`, `retryAt = world.tick + 1 + retryTicks` (`retryTicks` after the next `update`); a stored blob that could not be restored is dropped from memory, so the retry reads the store |
| `loading` | `active` | `id` drained from `pendingActivations` at the start of `update` | `activate(rec, ctx)` (5.3) |
| `active` | `active` (lingering) | not wanted during `update` and `lingerUntil === Infinity` | `lingerUntil = tick + lingerTicks` |
| `active` (lingering) | `active` | wanted during `update` | `lingerUntil = Infinity` |
| `active` (lingering) | `saving` | `tick >= lingerUntil` during `update` | `deactivate(rec, ctx, tick)` (5.4) |
| `saving` | `inactive` | the save resolved | `rec.saving = null`, `rec.unsaved = false`; keep `rec.blob` |
| `saving` | `active` | the save rejected | `log('error')`; push `id` to `pendingActivations` (the state stays `saving` until drained); on drain `activate` re-creates the entities from the in-memory blob and the region gets a fresh linger timer. Nothing is lost; the region is active again and the save is retried on the next linger expiry |
| `saving` | `loading` | wanted during `update` while the save is pending | `rec.state = 'loading'`; when the save settles, resolved or rejected, push `id` to `pendingActivations` (no `store.get`) |

`loading` is never wanted-checked for eviction: a region that stops being wanted while loading
still activates, then lingers normally.

### 5.2 `update(players, ctx, pending?, interest?)`

```
update(players, ctx, pending = [], interest = []):
  if world.stepping: throw Error                       // between steps only (docs/sim.md 2.12 rule 6)
  for id of interest: if graph.get(id) === undefined: throw UnknownRegion(id)   // before anything changes
  tick = ctx.tick + 1                                  // update runs before step(tick); use the tick about to be simulated
  playerSet = new Set(players)

  // 1. drain activations, sorted by id so same-boundary completions are order-stable
  batch = pendingActivations.splice(0).sort(stringCompare)
  for id of batch:
    rec = recs.get(id)
    if rec.state === 'loading' or rec.state === 'saving': activate(rec, ctx)   // throws: push the rest of batch back to pendingActivations, rethrow

  // 2. entities hooks created since the last pass (section 5, Records), so an eviction below saves them
  track()

  // 3. wanted set
  wanted = []
  for p of players (array order):
    r = regionOf(p); if r === undefined: continue          // player not yet placed
    for id of graph.wanted(r): if !wanted.includes(id): wanted.push(id)
  for r of pending: for id of graph.wanted(r): if !wanted.includes(id): wanted.push(id)   // spawn regions of joined-but-unspawned players
  for id of interest: if !wanted.includes(id): wanted.push(id)   // simulation interest: exactly these regions, no graph.wanted neighbourhood
  wanted.sort(stringCompare); wantedSet = new Set(wanted)

  // 4. transitions
  for id of wanted:
    rec = getOrCreate(id)                                   // throws UnknownRegion if graph.get(id) is undefined
    switch rec.state:
      'inactive': if tick >= rec.retryAt: startLoad(rec)
      'active':   rec.lingerUntil = Infinity
      'saving':   if rec.saving: rec.state = 'loading'      // the save's settle queues the activation (5.4)
      'loading':  nothing
  for rec of recs where rec.state === 'active' and !wanted.includes(rec.id):   // recs iterated in id order (sorted keys array)
    if rec.lingerUntil === Infinity: rec.lingerUntil = tick + lingerTicks
    else if tick >= rec.lingerUntil: deactivate(rec, ctx, tick)
```

**Simulation interest.** `interest` lets a game keep regions simulated that no player is in or near,
such as the path of a long-range projectile (`docs/net.md` A.5, `SessionHooks.simulationInterest`,
which the Session validates, deduplicates and sorts before passing it here). Unlike players and
`pending`, each interest region is wanted alone: its neighbours are not, so a game names every
region it needs. Wanted is wanted: an interest region loads, activates at the next `update`, stays
active while named, and once no longer wanted by anyone lingers `lingerTicks` and is saved and
evicted (5.1). Because membership (6.1) holds an entity at the border of a wanted region that is
loading, saving, or inactive awaiting a load retry, a non-player entity crossing into an interest
region waits in place until it activates; crossing into an inactive region nobody wants still
inboxes it. Simulation interest is not client interest: `InterestPolicy` (section 9) and the
RegionSet are built from player regions only. With no `interest` (the default) `update` is unchanged.

A `populate` that throws propagates out of `update`: its region stays `active` with the entities it
created (and its arrivals), and the rest of the batch activates at the next `update` instead of
staying `loading`. An eviction that throws (`InvariantViolation`, `onDeactivate`, `gameData` that is
not JSON) propagates too, before anything changed; the region stays active with a fresh linger
timer.

Because `update` runs before `step`, `activate` and `deactivate` see `world.tick === tick - 1`, and
any store writes they cause are stamped `tick` (`world.stepping` is false, `docs/sim.md` 2.3), so they
replicate with step `tick`. `update` only creates entities (restores, `populate`,
`mergeArrivals`) and queues destroys; it never writes to a component of an entity that already
existed, so the snapshot builder's `version > baselineTick` rule (`docs/net.md` A.8) is
unaffected (new entities are reported as creates because they are not yet `known`). This is also
why `update` must precede `step` and never interleave with it.

### 5.3 `activate(rec, ctx)`

```
activate(rec, ctx):
  blob = rec.blob; queued = inbox.get(rec.id)
  resolve the component types of blob.entities and queued     // BlobError: fail(rec, err) as a load (5.1), nothing created
  fresh = blob === null or blob.inboxOnly                     // an inboxOnly blob (5.5) activates as fresh
  rec.state = 'active'; rec.lingerUntil = Infinity; rec.retryAt = 0; rec.unsaved = false
  rec.rng = new Rng(rec.def.seed); if blob: rec.rng.restore(blob.rngState)
  inbox.delete(rec.id)
  try:
    if !fresh: for e of deserializeEntities(world, registry, blob.entities, rec.id): insertSorted(rec.entities, e)
    loader.populate(rec.def, fresh ? null : blob, ctx)  // game adds procedural content; each entity gets Region { id } and, if bounded, Transform
  finally:                                               // arrivals merge even when populate throws
    for e of world.query(Region) where Region.id === rec.id: insertSorted(rec.entities, e)
    mergeArrivals(rec, fresh && blob ? blob.entities : [], queued ?? [])   // section 6.3
```

Entity ids are never persisted: the manager restores a saved region's entities with fresh ids before
`populate`, so `populate` finds them in `entitiesIn` and adds procedural content only when
`blob === null` (it may read `blob.gameData`):

```ts
export function deserializeEntities(world: World, registry: SchemaRegistry, entities: SerializedEntity[], regionId: RegionId): EntityId[];
// for each SerializedEntity: e = world.create(); for [name, value]: world.add(e, component named name, value); world.add(e, Region, { id: regionId }); returns ids in creation order
// throws BlobError, creating nothing, for a component the registry lacks, one listed twice, Region, or a value that is not an object
export function serializeEntity(world: World, e: EntityId): SerializedEntity | null;
// components in component-id order where type.persist, as deep copies; null if the entity has no persisted component
```

### 5.4 `deactivate(rec, ctx, tick)`

```
deactivate(rec, ctx, tick):
  rec.lingerUntil = tick + lingerTicks                         // a throw below leaves the region active; retried when this expires
  assertNoPlayer(rec)                                          // section 6 invariant
  entities = rec.entities.slice()
  serialized = []
  for e of entities: if e not in world.destroyedThisTick(): s = serializeEntity(world, e); if s: serialized.push(s)
  gameData = loader.onDeactivate ? loader.onDeactivate(rec.def, ctx) : undefined
  bytes = encode({ version: 1, savedTick: tick - 1, entities: serialized, rngState: rec.rng.state(), gameData })   // BlobError if gameData is not JSON
  for e of entities: world.destroy(e)                          // applied at the end of the coming step
  for e of entities: unrecord(e)                               // rec.entities is now []
  rec.blob = decode(bytes)                                     // what a load returns: reactivating from memory equals loading
  rec.rng = null; rec.unsaved = true
  rec.state = 'saving'; rec.lingerUntil = Infinity
  rec.saving = store.transaction(tx => tx.put('region', rec.id, bytes))
    .then(() => { rec.saving = null; rec.unsaved = false; if rec.state === 'loading': pendingActivations.push(rec.id) else rec.state = 'inactive' },
          err => { log('error', ..., err); rec.saving = null; pendingActivations.push(rec.id) })
```

The save is a transaction so that one started while `flushAll` writes queues behind it on the store
mutex (`docs/persist.md` 1.4): the older flush snapshot never lands after the newer eviction blob
(`ProxyBlobStore` sends a transaction's writes as one batch when it commits, `docs/host.md` §20).

Entities destroyed here are still in stores during the coming `step` (destroy is deferred), but
they are no longer in `rec.entities`; systems that query them for one more tick is acceptable and
deterministic. `membershipSystem` skips entities whose region is not `active`.

### 5.5 `flushAll()`

```
flushAll():
  await every rec.saving
  await store.transaction(async tx =>
    // snapshot synchronously, so regions and inboxes agree on one instant even if ticks run during the awaits
    writes = []
    for rec of recs in id order:
      if rec.state === 'active':
        rec.blob = { version: 1, savedTick: world.tick, entities: serialized rec.entities except players and entities destroyed this tick, rngState: rec.rng.state(), gameData: loader.onDeactivate?.(rec.def, lastCtx) }
        writes.push(rec.id, encode(rec.blob))                 // entities stay in the ECS; flush is a save, not an eviction
      else if rec.unsaved and !rec.saving:
        writes.push(rec.id, encode(rec.blob))                 // a failed save waiting to reactivate
    arrivals = for [id, items] of inbox entries in id order where items.length > 0 and recs.get(id).state !== 'active':
      { rec, items, copy: items.slice(), base: rec.blob }
    for w of writes: await tx.put('region', w.id, w.bytes)
    for a of arrivals:
      base = a.base ?? decode(await tx.get('region', a.rec.id))   // BlobError: log('error'), keep that inbox in memory, next
      merged = base and !base.inboxOnly
        ? { ...base, savedTick: world.tick, entities: [...base.entities, ...a.copy] }
        : { ...emptyBlob(a.rec.def), savedTick: world.tick, entities: [...(base?.entities ?? []), ...a.copy], inboxOnly: true }
      await tx.put('region', a.rec.id, encode(merged))
      if inbox.get(a.rec.id) === a.items:                     // no activation merged them meanwhile
        drop the copied items from a.items (delete the entry once empty); a.rec.blob = merged; a.rec.unsaved = true
  )
  rec.unsaved = false for each blob this flush wrote that is still rec.blob
```

`inboxOnly` marks a blob written for a region that was never saved: passed to `populate`, it would
suppress the region's procedural content forever, so activation treats it as fresh and merges its
entities as arrivals (5.3). Because every later activation restores from `rec.blob`, a load that
read the store before the flush wrote still activates with the flushed arrivals, exactly once.

`onDeactivate` is called during flush for `gameData` only; games must treat it as idempotent and
side-effect free on the ECS. Used by the Session on graceful shutdown and by `Autosaver`
(`docs/persist.md` 1.8, wired by the worker in `docs/host.md` §21).

### 5.6 Blob format

```ts
export interface SerializedEntity { components: [name: string, value: unknown][] }   // component-id order; only persist: true types
export interface RegionBlob {
  version: 1;
  savedTick: number;             // integer >= 0
  entities: SerializedEntity[];
  rngState: number;              // u32
  gameData?: unknown;            // JSON-serializable
  inboxOnly?: true;              // written by flushAll for a region never saved: entities are inbox arrivals only (5.5)
}
export function encodeBlob(b: RegionBlob): Uint8Array;               // new TextEncoder().encode(JSON.stringify(b)); BlobError if not JSON-serializable
export function decodeBlob(bytes: Uint8Array | null): RegionBlob | null;   // JSON.parse; throws BlobError on bad UTF-8 or JSON, version !== 1 or shape mismatch
export function emptyBlob(def: RegionDef): RegionBlob;              // { version: 1, savedTick: 0, entities: [], rngState: def.seed >>> 0 }
```

Stored through `BlobStore` namespace `region`, key `= regionId`. Entity ids are never persisted;
games that need stable identity add their own `PersistentId` component with `persist: true`.
Component values are the plain schema objects (numbers are not quantized in JSON; quantization
happens only on the wire).

## 6. Migration

### 6.1 `membershipSystem` (postSim tail, first entry)

```
run(ctx):
  track()                                                      // section 5, Records: entities created since the last pass
  for e of world.destroyedThisTick():                          // entities destroyed this tick, by systems or between steps (docs/sim.md 2.2)
    unrecord(e)                                                // after track, so entitiesIn never lists an entity after applyDestroys
  moved = []                                                   // scratch, reset each tick
  for e of world.query(Transform, Region):
    current = Region.read(e).id
    rec = recs.get(current)
    if !rec or rec.state !== 'active': continue
    def = rec.def
    if def.bounds.kind === 'node': continue                    // unbounded; explicit migrate only
    pos = Transform.read(e).pos
    if contains(def, pos): continue
    if world.destroyedThisTick() includes e: continue          // going away: moving would re-record it, inboxing would resurrect it
    target = graph.locate(toWorld(def, pos, tmp), current)
    if target === null:
      clampToBounds(def, pos, Transform.write(e).pos)
      onWorldEdge?.(e, ctx)
      continue
    if target === current: continue                            // float boundary: locate's hint test can accept a position contains() rejects
    trec = getOrCreate(target)
    switch trec.state:
      'active':
        t = Transform.write(e); rebase(def, trec.def, t.pos, t.pos)
        Region.write(e).id = target                            // write, so it replicates
        removeSorted(rec.entities, e); insertSorted(trec.entities, e)
        events.emit(RegionChanged, { entity: e, from: current, to: target })
      'loading', 'saving':
        continue                                               // try again next tick
      'inactive':
        if wantedSet.has(target): continue                     // loads at an update soon (once any retry is due)
        assert !playerSet.has(e)                               // invariant, section 6.3
        s = serializeEntity(world, e)
        if s: rebase(def, trec.def, positionField(s)), inbox.get(target).push(s)   // Transform.pos in s rebased to target origin
        removeSorted(rec.entities, e)
        world.destroy(e)
```

Entities with `persist: false` only (no persisted components) are simply destroyed when they leave
into an inactive region; the world is empty out there by definition.

Order guarantees: `query` order is ascending slot order, so the outcome of two entities crossing in
the same tick is deterministic.

### 6.2 `migrate(e, to, newLocalPos?)`

```ts
export type MigrateResult = 'moved' | 'inboxed' | 'deferred' | 'same' | 'unknownRegion' | 'notMember' | 'outOfBounds';
```

```
migrate(e, to, newLocalPos):
  if !world.has(e, Region): return 'notMember'
  current = Region.read(e).id; if current === to: return 'same'
  tdef = graph.get(to); if !tdef: return 'unknownRegion'
  cdef = graph.get(current); trec = getOrCreate(to)          // current may have no record (never wanted) or no def
  hasT = world.has(e, Transform)
  newPos = newLocalPos ?? (hasT and cdef and cdef.bounds.kind !== 'node' and tdef.bounds.kind !== 'node' ? rebase(cdef, tdef, Transform.read(e).pos) : (0,0,0))
  if tdef.bounds.kind !== 'node' and !contains(tdef, newPos): return 'outOfBounds'
  switch trec.state:
    'active':
      if hasT: copy newPos into Transform.write(e).pos
      Region.write(e).id = to; record(trec, e)
      events.emit(RegionChanged, { entity: e, from: current, to })
      return 'moved'
    'loading', 'saving': return 'deferred'
    'inactive':
      if playerSet.has(e): throw InvariantViolation(to, e, 'player entity cannot enter an inactive region')
      s = e in world.destroyedThisTick() ? null : serializeEntity(world, e)   // never resurrect a destroyed entity
      if s: set Transform.pos in s to newPos (if present); inbox.get(to).push(s)
      unrecord(e); world.destroy(e)
      return 'inboxed'
```

Games wanting an entity to enter an inactive, unwanted region and be active (a player's ship
jumping to a new star system) first make the region wanted (the player is there, so it will be
after `update` places them) or call `migrate` again next tick on `'deferred'`.

### 6.3 Inbox

`inbox: Map<RegionId, SerializedEntity[]>` (lookup only; `flushAll` iterates a sorted copy of
keys). `mergeArrivals` runs at the end of `activate`, after `populate` (in its `finally`), with the
inbox entry already deleted and every item resolved:

```
mergeArrivals(rec, flushed, queued):
  ids = deserializeEntities(world, registry, [...flushed, ...queued], rec.id)   // an inboxOnly blob's arrivals first, then the inbox
  for e of ids: insertSorted(rec.entities, e)
```

Inbox contents survive across a session save through `flushAll` (5.5). Inbox order is arrival order,
which is deterministic.

**Player invariant.** A player entity (any entity in the `players` array passed to `update`)
always has its own region in `wanted`, so its region can never linger, save, or be the source of
an inbox move, and `membershipSystem` never sees a player heading into an inactive region unless the
target became inactive in the same tick as the player crossed, which cannot happen because
transitions only occur in `update`. Assertions:

- `assertNoPlayer(rec)` at `deactivate` entry: throws `InvariantViolation(regionId, entity, detail)`
  if any `rec.entities` element is in `playerSet`.
- The `'inactive'` branch of `membershipSystem` and `migrate` asserts `!playerSet.has(e)`.

Both assertions are cheap (`Set.has`) and stay on in production.

## 7. Per-region RNG

`regionRng(id)` returns the active region's `Rng` (created in `activate` from `blob.rngState`, or
`new Rng(def.seed)` for a fresh region). Throws `RegionNotActive(id)` otherwise. State is written to
`blob.rngState` in `deactivate` and `flushAll`. `ctx.regionRng` (`docs/sim.md` 2.8) is bound to
this method. Games derive sub-streams with `fork(label)`.

## 8. Spatial index

### 8.1 `SpatialGrid`

```ts
export class SpatialGrid {
  constructor(cellSize: number, plane: 'xz' | 'xy');
  clear(): void;
  insert(e: EntityId, pos: Vec3): void;
  queryRadius(pos: Vec3, r: number, out: EntityId[]): EntityId[];
  queryAABB(min: Vec3, max: Vec3, out: EntityId[]): EntityId[];
  nearest(pos: Vec3, maxR: number, exclude?: EntityId): EntityId | undefined;
  readonly size: number;
}
```

Layout: `ids: Uint32Array`, `px: Float64Array`, `py: Float64Array` (dense, insertion order,
capacity doubling), `cells: Map<number, number[]>` keyed by `((ix + 0x8000) & 0xFFFF) | (((iy +
0x8000) & 0xFFFF) << 16)` holding dense indices. `project(pos)` = `(pos.x, pos.z)` for `xz`, `(pos.x,
pos.y)` for `xy`. `cellOf(v) = Math.floor(v / cellSize)`.

```
queryRadius(pos, r, out):
  (x, y) = project(pos); r2 = r*r; n0 = out.length
  for iy in cellOf(y - r)..cellOf(y + r):                // ascending
    for ix in cellOf(x - r)..cellOf(x + r):              // ascending
      list = cells.get(key(ix, iy)); if !list: continue
      for i of list (insertion order): if (px[i]-x)^2 + (py[i]-y)^2 <= r2: out.push(ids[i])
  sort out[n0..] ascending
  return out

queryAABB(min, max, out): same cell walk over the projected box; inclusive test min <= p <= max; sorts what it appended
nearest(pos, maxR, exclude): ring expansion from ring 0 to ceil(maxR/cellSize); track best distance, ties to the lowest id; stop before a ring whose inner distance ((k - 1) * cellSize) exceeds best; returns undefined if none within maxR
```

Every query appends its matches ascending by entity id (it sorts only what it appended), so results
do not depend on cell size or insertion order. A walk that would visit more cells than there are
points, or more than `0xFFFF` cells on an axis (keys alias beyond that), scans every point instead;
the distance test keeps aliased cells harmless. A negative or NaN radius, an empty or NaN box, or a
non-finite `pos` matches nothing.

### 8.2 `SpatialIndex`

```ts
export interface SpatialIndexOpts {
  regions: RegionManager;
  world: World;
  graph: WorldGraph;
  cellSizeFor?: (def: RegionDef) => number;   // default below
}
export const DEFAULT_NODE_CELL = 64;
export class SpatialIndex implements SpatialApi {
  constructor(opts: SpatialIndexOpts);
  rebuild(ctx: SimContext): void;                       // postSim tail, second entry
  region(id: RegionId): SpatialGrid;                    // throws RegionNotActive
  queryRadius(regionId, pos, r, out): EntityId[];
  queryAABB(regionId, min, max, out): EntityId[];
  queryRadiusAcross(regionId, pos, r, out, outRegions?): EntityId[];
  nearest(regionId, pos, maxR, exclude?): EntityId | undefined;
}
```

Default cell size: bounded region `(max.x - min.x) / 8` (32 m for the sandbox's 256 m cells);
node region `DEFAULT_NODE_CELL`. A grid projects onto the `aabb2` plane, and onto `xz` for `aabb3`
and `node` regions. Grids are created on first use per region (empty until the next rebuild) and
dropped when the region leaves `active`.

```
rebuild(ctx):
  for id of regions.active(): grid(id).clear()
  for e of world.query(Transform, Region):               // ascending slot order
    if e in world.destroyedThisTick(): continue          // gone once the step applies destroys
    id = Region.read(e).id
    if regions.state(id) !== 'active': continue
    grid(id).insert(e, Transform.read(e).pos)

queryRadiusAcross(regionId, pos, r, out, outRegions):
  def = graph.get(regionId)
  n0 = out.length
  queryRadius(regionId, pos, r, out); if outRegions: push regionId (out.length - n0) times
  if def.bounds.kind === 'node': return out              // a node region has no borders
  for nid of graph.neighbors(regionId) (graph order):
    if regions.state(nid) !== 'active' or graph.get(nid).bounds.kind === 'node': continue
    ndef = graph.get(nid); local = rebase(def, ndef, pos, tmp)
    n = out.length; region(nid).queryRadius(local, r, out); if outRegions: push nid (out.length - n) times
  return out
```

Results in `out` are region-local ids only; callers convert positions with `rebase` when they need
distances across regions.

## 9. Interest

```ts
export interface RegionMembership {                    // structural subset of RegionManager (section 5); SimContext.regions satisfies it too
  regionOf(e: EntityId): RegionId | undefined;
  entitiesIn(id: RegionId): readonly EntityId[];
}
export interface InterestClient { player: EntityId; wanted: readonly RegionId[]; reported: readonly RegionId[] }   // wanted, reported: sorted by stringCompare; player names the client, visible does not filter by it

export class InterestPolicy {
  constructor(opts: { graph: WorldGraph; regions: RegionMembership });
  wantedForRegion(r: RegionId): RegionId[];            // graph.wanted(r)
  prefetchForRegion(r: RegionId): RegionId[];          // graph.wanted(r, graph.wantedDepth + 1) minus wantedForRegion(r), in graph order
  wantedFor(playerEntity: EntityId): RegionId[];       // wantedForRegion(regionOf(player)); [] if unplaced
  prefetchFor(playerEntity: EntityId): RegionId[];     // prefetchForRegion(regionOf(player)); [] if unplaced
  visible(client: InterestClient, out: EntityId[]): EntityId[];
}
```

```
visible(client, out):
  out.length = 0
  ids = client.wanted ∩ client.reported (as a sorted array; both inputs are sorted)
  for id of ids: for e of regions.entitiesIn(id) (ascending): out.push(e)
  out.sort((a, b) => a - b)                  // regions are disjoint; the result is ascending by entity id
  return out
```

`docs/net.md` uses `wantedForRegion`/`prefetchForRegion` to build `RegionSet` (the region is the
player's current region, or the planned spawn region before spawn), stores the client's
`RegionLoadState` report as `reported`, and on each snapshot tick passes `wanted ∩ reported` to its
snapshot builder, which covers the same entities as `visible` and filters them per entity with the
Session's `relevance(player, entity, ctx)` hook (`docs/net.md` A.8). `InterestPolicy` has no
relevance option: the Session builds the only instance, and its hook needs the player's `PlayerInfo`
and the tick's context. Entities in `reported` but not `wanted` are excluded, which is what makes a
distant client receive nothing.
For `GridWorld`, `depth + 1` uses `wantedDepth + 1`; for `NodeWorld`, `2` hops.

---

## 10. Files

### packages/world

| File | Exports |
| --- | --- |
| `src/index.ts` | re-exports everything below |
| `src/types.ts` | `RegionId`, `AssetId`, `RegionBounds`, `RegionDef`, `WorldGraph`, `WorldGraphJson`, `WorldGraphError`, `RegionStore` |
| `src/graph.ts` | `fromJson`, `validateGraphJson` |
| `src/gridWorld.ts` | `GridWorld`, `GridWorldOpts`, `DEFAULT_WANTED_DEPTH` |
| `src/nodeWorld.ts` | `NodeWorld`, `NodeWorldOpts` |
| `src/coords.ts` | `toWorld`, `toLocal`, `rebase`, `contains`, `clampToBounds`, `CLAMP_EPS` |
| `src/blob.ts` | `RegionBlob`, `SerializedEntity`, `encodeBlob`, `decodeBlob`, `emptyBlob`, `serializeEntity`, `deserializeEntities`, `BlobError`, `BLOB_NAMESPACE`, `BLOB_VERSION` |
| `src/regionManager.ts` | `RegionManager`, `RegionManagerOpts`, `RegionLoader`, `RegionState`, `MigrateResult`, `LINGER_MS`, `RETRY_MS`, `RegionNotActive`, `UnknownRegion`, `InvariantViolation` |
| `src/membership.ts` | `createMembershipSystem(manager): System` (used by `RegionManager` constructor) |
| `src/spatialGrid.ts` | `SpatialGrid` |
| `src/spatialIndex.ts` | `SpatialIndex`, `SpatialIndexOpts`, `DEFAULT_NODE_CELL` |
| `src/interest.ts` | `InterestPolicy`, `InterestClient`, `RegionMembership` |
| `src/sorted.ts` | `insertSorted(arr, v)`, `removeSorted(arr, v)` (binary search on an ascending, duplicate-free `number[]` or `string[]` ordered by `<`; return whether `arr` changed), `stringCompare`, `intersectSorted(a, b, out = [])` (appends, returns `out`) |

| Test | Proves |
| --- | --- |
| `test/gridWorld.test.ts` | `locate` floor division at cell edges (exactly `cellSize` belongs to the next cell), negative coordinates return `null`, hint fast path returns hint when inside and re-locates when outside; `wanted` corner cell has 4 entries, interior 9, depth 2 interior 25, order is self then row-major; ids parse round-trip; seeds differ per cell and are stable; `toJson`/`fromJson` round-trip yields identical `locate`/`wanted` for 1000 random points; custom `originOf` that is not grid-consistent throws |
| `test/nodeWorld.test.ts` | `locate` returns hint or null; `wanted` BFS order and depth; override wanted forces self first; missing neighbour and duplicate id throw; Spike 4 (section 3): positions out to a 1 000 km system edge replicate through the core `Transform` codec within 0.5 mm, the range outlasts 1.8 h at the replicated speed cap, the codec saturates past ±2 147 km, and a ship crossing its system stays in its node region until an explicit `migrate` |
| `test/coords.test.ts` | `toWorld`/`toLocal` inverse; `rebase` preserves world position across two regions; `contains` half-open; `clampToBounds` result is contained |
| `test/regionManager.test.ts` | every transition in 5.1 driven by a scripted `players` array and a controllable `RegionStore` (resolve/reject on demand); a region listed in `pending` is loaded and kept active without any player entity; load on wanted, activation at the next `update`, linger exactly `lingerTicks`, re-wanted cancels linger, save on expiry removes entities and writes the blob, put failure re-activates from memory, wanted-while-saving reactivates without `get`, get failure retries after `retryTicks`; `deactivate` with a player present throws `InvariantViolation`; an eviction during `flushAll` saves after the flush commits; simulation interest: an interest region activates alone (no neighbour is loaded), with no player, in any order and with repeats, unioned with player neighbourhoods; an unknown interest id throws `UnknownRegion` before anything changes; a dropped interest region lingers exactly `lingerTicks`, then is saved and evicted; an entity crossing into a loading interest region waits at the border and moves in once it activates, while one crossing into an unwanted neighbour of it is inboxed; an interest region whose load failed keeps the entity waiting, and once dropped the crossing inboxes |
| `test/borderOscillation.test.ts` | 3 x 3 grid; one player entity moves back and forth across the `cell/1_1`/`cell/2_1` border every 30 ticks for 7200 ticks (2 min at 60 Hz) with 20 persisted crates per cell populated procedurally; asserts: no region ever reaches `saving`, region count stays 9 wanted minus clipped, total crate count is constant every tick, no crate appears in two regions' `entitiesIn`, the player's `Region.id` matches `graph.locate` after every tick, `world.hash()` sequence is identical on a second run |
| `test/inbox.test.ts` | an entity walking into an inactive unwanted region is inboxed and removed; activating that region later re-creates it with the rebased position; `flushAll` writes inbox items into the stored blob and a fresh manager loads them; a `persist: false`-only entity is destroyed, not inboxed; `flushAll` racing a load or an activation stores arrivals once; `migrate` returns each `MigrateResult` value under the matching setup |
| `test/blob.test.ts` | `serializeEntity` includes only `persist: true` components in id order; entities with none serialize to `null`; encode/decode round-trip; `rngState` restore continues the stream exactly; bad version throws `BlobError` |
| `test/spatial.test.ts` | `queryRadius` and `queryAABB` match brute force for 2000 random points and 200 random queries; results are in ascending entity order; `nearest` matches brute force and honours `exclude`; `queryRadiusAcross` finds an entity 1 m across a border with the neighbour rebased correctly and `outRegions` parallel to `out`; grids rebuild each tick from moved positions |
| `test/interest.test.ts` | `visible` = wanted ∩ reported, ascending, unfiltered; `prefetchFor`/`prefetchForRegion` is the depth+1 ring only; a client whose reported set does not include its wanted region sees nothing |
