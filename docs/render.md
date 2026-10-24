# @conduit/render

`RenderHost`, `RenderWorld`, entity views and binders, the Three-based `GltfBackend`, cameras, debug helpers and
the headless enforcement tests. Browser-only. Consumes `ReplicaWorld`/`NetClock` from docs/net.md, components
from docs/sim.md, `WorldGraph` from docs/world.md, and `AssetLoader`/`ModelMeta` from docs/assets.md. Wired
into a game by `createClient` (docs/game.md), which dynamically imports this package only when a `canvas` is given.

## 1. The `three` rule

`@conduit/render` is the only package that imports `three` (including `three/examples/jsm/*` and
`three/addons/*`). `three` and `@types/three` are `peerDependencies` (range `>=0.160 <1`); the app pins one exact
version (docs/consuming.md). Enforcement:

1. eslint `no-restricted-imports` from `conduitEslint({ renderGlobs })` bans `three` and `three/*` outside
   `packages/render/**` (and, in this repo, the sandbox's scene dressing `examples/sandbox/src/client/scene.ts`, which
   stands in for a game client app's own `three` code; docs/consuming.md §1).
2. `packages/game/test/module-graph.test.ts` (section 10) proves the server and headless client module graphs
   contain no `three` module.
3. `pnpm why three` in CI resolves exactly one version (docs/consuming.md).

Math conversion lives here, never in `@conduit/math`:

```ts
import * as THREE from 'three';
import type { Vec3, Quat } from '@conduit/math';

export function toThreeVec3(v: Vec3, out?: THREE.Vector3): THREE.Vector3;   // out ??= new Vector3(); out.set(v.x, v.y, v.z)
export function toThreeQuat(q: Quat, out?: THREE.Quaternion): THREE.Quaternion;
export function fromThreeVec3(v: THREE.Vector3, out?: Vec3): Vec3;
export function fromThreeQuat(q: THREE.Quaternion, out?: Quat): Quat;
```

All hot paths pass `out` to avoid allocation.

## 2. `RenderHost`

```ts
export interface RendererLike {                    // the subset RenderHost uses; WebGLRenderer satisfies it
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
  setSize(w: number, h: number, updateStyle?: boolean): void;
  setPixelRatio(r: number): void;
  dispose(): void;
  info: { memory: { geometries: number; textures: number }; render: { calls: number; triangles: number } };
  domElement: HTMLCanvasElement;
}

export interface RenderHostOptions {
  canvas: HTMLCanvasElement;
  renderer?: RendererLike;        // game-supplied WebGLRenderer or composer-backed adapter; not disposed by host
  antialias?: boolean;            // default true; ignored when renderer supplied
  pixelRatioCap?: number;         // PIXEL_RATIO_CAP_DEFAULT = 2
  raf?: (cb: FrameRequestCallback) => number;   // default requestAnimationFrame; injectable for tests
  caf?: (id: number) => void;
  now?: () => number;             // default performance.now; only a fallback for a driver that passes no timestamp
  onFrameError?: (error: unknown, host: RenderHost) => void;   // what a frame threw, once the loop has stopped (it propagates still)
}

export const PIXEL_RATIO_CAP_DEFAULT = 2;
export const MAX_DT = 0.1;                     // seconds; dt is clamped to this after tab throttling
export const CAMERA_FOV = 60, CAMERA_NEAR = 0.1, CAMERA_FAR = 20000;

export type RenderFn = (host: RenderHost) => void;
export type FrameCb = (dt: number, host: RenderHost) => void;

export class RenderHost {
  constructor(opts: RenderHostOptions);
  readonly renderer: RendererLike;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;    // fov 60, aspect from canvas, near 0.1, far 20000; game may mutate
  readonly canvas: HTMLCanvasElement;
  readonly running: boolean;
  readonly width: number;                      // the view's CSS size as last laid out (the observer's, or the last resize()), at least 1:
  readonly height: number;                     // read per frame instead of canvas.clientWidth/clientHeight, which force a synchronous layout after any DOM change
  readonly timeMs: number;                     // the current frame's time base: the rAF timestamp, on the performance.now() clock, shared by everything in the frame. Seeded by start(); 0 before that
  frame: number;                               // count of frames rendered (not reset by stop/start)
  setRenderFn(fn: RenderFn | null): void;      // null restores the default renderer.render(scene, camera)
  setWorld(world: RenderWorld | null): void;   // optional convenience: world.update runs first each frame. createClient does NOT use it; it drives NetClient.update then world.update itself from an onFrame callback (docs/game.md §4) so the clock is slewed before views sample it
  onFrame(cb: FrameCb): () => void;            // game callbacks; returns an idempotent unsubscribe (effective within the current frame too)
  start(): void;                               // no-op while running or after dispose
  stop(): void;
  resize(width: number, height: number): void; // manual; also driven by ResizeObserver
  dispose(): void;                             // stop, disconnect observer, dispose renderer only if host created it; idempotent
}
```

Construction:

```
renderer = opts.renderer ?? new THREE.WebGLRenderer({ canvas, antialias: opts.antialias ?? true, powerPreference: 'high-performance' })
renderer.setPixelRatio(min(devicePixelRatio, pixelRatioCap))      -- also for a supplied renderer
scene = new Scene(); camera = new PerspectiveCamera(60, w/h, 0.1, 20000)
observer = new ResizeObserver(entries => resize(entry.contentRect.width, entry.contentRect.height))   -- last entry; skipped where ResizeObserver is undefined (jsdom): only manual resize() applies
observer.observe(canvas.parentElement ?? canvas)
resize(canvas.clientWidth || 1, canvas.clientHeight || 1)
```

`resize(w, h)`: a non-positive size counts as 1 (a hidden parent reports 0); `width = w`, `height = h`;
`renderer.setSize(w, h, false)`; `camera.aspect = w / h`; `camera.updateProjectionMatrix()`.

Frame loop:

```
start(): if running or disposed return; running = true; last = now(); id = raf(tick)
tick(frameMs):                                   -- the timestamp raf passes its callback
  id = null
  if !running return
  t = isFinite(frameMs) ? frameMs : now(); dt = clamp((t - last) / 1000, 0, MAX_DT); last = t
  try:
    world?.update(dt)                         -- 1. RenderWorld (views, binders, events, camera)
    for cb of frameCbs: cb(dt, host)           -- 2. game onFrame, registration order
    if disposed: return                        -- dispose() from a callback: no render, no next frame
    (renderFn ?? defaultRender)(host)          -- 3. render
  catch err: stop(); throw err
  frame += 1
  if running and id == null: id = raf(tick)    -- stop() in a callback still renders this frame; start() in one does not double-request
stop(): running = false; if id != null: caf(id); id = null
```

The frame is timed from **the timestamp `requestAnimationFrame` passes**, exposed to everything in the frame as
`host.timeMs`, and `now()` is only the fallback for a driver that passes none. A clock read inside the frame instead
measures when that line ran, after however much work came first, and its jitter lands in `dt` and in anything driven off
it — above all the net clock, whose rendered motion then stutters (docs/net.md §B.4). Anything a game does per frame that
needs a wall clock reads `host.timeMs` rather than calling `performance.now()` itself.

An exception thrown by `world.update`, a frame callback or the render fn propagates out of the frame after
`stop()` (`running` is false, no frame pending) and `onFrameError`; the game decides whether to `start()` again.

## 3. `RenderWorld`

```ts
export interface ReplicatedEvent {              // exactly the object NetClient emits on 'event' (docs/net.md B.3/B.7)
  def: EventDef; tick: number; regionId: RegionId | null; payload: unknown;
}
export type EventHandler = (evt: ReplicatedEvent, view: EntityView | null, world: RenderWorld) => void;

export interface RenderWorldEvents {
  viewCreated:   { view: EntityView };
  viewDestroyed: { view: EntityView };
  modelReady:    { view: EntityView; model: ModelInstance };
  floatingOrigin:{ regionId: RegionId; origin: Vec3 };   // after the groups moved; origin is a copy
}

export class RenderWorld {
  constructor(host: RenderHost, replica: ReplicaWorld, clock: NetClock, assets: AssetLoader | undefined, graph: WorldGraph);   // assets undefined when the game has no manifest (createClient, docs/game.md §4): models stay placeholders
  readonly root: THREE.Group;                                  // added to host.scene; name 'conduit-root'
  readonly host: RenderHost; readonly replica: ReplicaWorld; readonly clock: NetClock; readonly assets: AssetLoader | undefined;
  readonly graph: WorldGraph;                                  // docs/world.md; built by createClient from game.world(Welcome.worldSeed)
  readonly floatingOrigin: Vec3;                               // world-space origin currently at root (0,0,0)
  readonly floatingRegion: RegionId | null;
  readonly renderTick: number;                                 // last tick used by update()
  readonly frameDt: number;                                    // dt of the current/last update; read by ModelBinder

  regionGroup(id: RegionId): THREE.Group;                      // create on demand; name `region:${id}`
  hasRegionGroup(id: RegionId): boolean;
  releaseRegionGroup(id: RegionId): void;                      // removes a group no view is parented to (other children leave with it); no-op otherwise
  setFloatingOrigin(regionId: RegionId): void;                 // §3.1; RangeError for an unknown id; no-op after dispose
  worldOf<T extends Vec3>(view: EntityView, out: T): T;        // the view's world position: its region's origin + its region-local position, in doubles (§3.1)
  toWorld<T extends Vec3>(p: Vec3, out: T): T;                 // scene point p in the world: + floatingOrigin
  toScene<T extends Vec3>(p: Vec3, out: T): T;                 // world point p in the scene: − floatingOrigin
  registerBinder<T>(b: Binder<T>): () => void;                 // order of registration = update order; the returned fn unregisters and calls onDetach on every view the binder is attached to; the same binder object twice -> Error
  view(e: EntityId): EntityView | undefined;
  views(): Iterable<EntityView>;                               // ascending id
  setCamera(c: CameraController | null): void;
  setInput(input: InputSource): void;                         // default NULL_INPUT; supplied by createClient from the game
  cameraTarget(e: EntityId | null): void;                      // sets CameraContext.target
  pushEvent(evt: ReplicatedEvent): void;                       // buffered until evt.tick <= renderTick; ignored after dispose
  onEvent(type: string, handler: EventHandler): () => void;    // type = evt.def.name; idempotent unsubscribe
  on<K extends keyof RenderWorldEvents>(k: K, cb: (e: RenderWorldEvents[K]) => void): () => void;
  emit<K extends keyof RenderWorldEvents>(k: K, e: RenderWorldEvents[K]): void;   // listeners in subscription order; how ModelBinder (or a game's replacement) emits modelReady
  update(dt: number): void;
  dispose(): void;                                             // detach the camera, destroy views (detaching their binders), remove root; later update() calls are no-ops
}
```

**Before M3** (PLAN.md) `floatingOrigin` stayed `(0,0,0)` and `floatingRegion` `null`, so region groups sat at
their world origins; `setFloatingOrigin` and `releaseRegionGroup` arrived in M3 without changing the constructor or
the methods above. (M1 had no `pushEvent`/`onEvent` or `modelReady` emit, and typed `AssetLoader`, `AssetHandle`,
`Priority` and `ModelMeta` with structural stand-ins in `src/asset-types.ts`; M2 imports them from `@conduit/assets`
and deleted that file, so call sites passing `undefined` or a real loader did not change.)

`createClient` (docs/game.md §4) constructs one `RenderWorld`, registers core binders
(`new RegionBinder(world)`, `TransformBinder`, `ModelBinder`, in that order; `RegionBinder` must precede
`TransformBinder`, §4.2) before game binders, calls `setInput(opts.input)` and
`setCamera`, forwards `NetClient.on('event')` to `pushEvent`, calls `cameraTarget(localEntity)` on `Spawned`, drives
`update(dt)` each frame after `NetClient.update`, and calls `setFloatingOrigin` whenever the local player's replicated
`Region.id` changes (checked each frame).

### 3.1 Region groups and floating origin

Region origin is `originOf(id) = graph.get(id).bounds.origin` (docs/world.md; all `RegionBounds` variants carry
`origin`). Unknown region id (`graph.get` returns `undefined`) -> `RangeError`.

```
regionGroup(id):
  g = groups.get(id); if g return g
  g = new Group(); g.name = 'region:' + id; g.userData.regionId = id
  g.position = toThreeVec3(sub(originOf(id), floatingOrigin))
  root.add(g); groups.set(id, g); return g

setFloatingOrigin(regionId):
  next = originOf(regionId)                                   -- RangeError before anything changes
  if disposed: return
  delta = sub(next, floatingOrigin); floatingOrigin = next; floatingRegion = regionId
  for (id, g) of groups: g.position = toThreeVec3(sub(originOf(id), floatingOrigin))   -- computed in doubles, assigned to float32
  if host.camera.parent is null, host.scene or root: host.camera.position -= delta   -- scene space moved by -delta; a camera no controller moves stays put in world space
  camera?.rebase?.(delta)                                     -- §6
  emit floatingOrigin { regionId, origin: copy of floatingOrigin }

releaseRegionGroup(id):
  g = groups.get(id); if !g or any view has view.object.parent === g: return
  g.removeFromParent(); groups.delete(id)                     -- other children (game scenery, RegionBoundsHelper lines) leave with it; their owners dispose them
```

Entity positions are region-local (CONCEPT.md principle 4), so only group positions change; views never move.
Camera controllers read positions through `view.object.getWorldPosition`, which is floating-origin-relative.

### 3.2 Views and binders

```ts
export interface EntityView {
  readonly id: EntityId;
  regionId: RegionId;                       // maintained by RegionBinder
  readonly object: THREE.Object3D;          // Group; name `entity:${id}`; parented to regionGroup(regionId)
  model?: ModelInstance | undefined;        // set by ModelBinder once resolved
  readonly data: Record<string, unknown>;   // per-view scratch for game binders
  readonly attached: Set<Binder<unknown>>;  // binders currently attached (internal, exposed for tests)
}

export interface Binder<T> {                // exactly as CONCEPT.md
  component: ComponentType<T>;
  newest?: boolean;                         // given its component's newest value as it comes, unsampled: a binder that times it itself (RegionBinder)
  onAttach?(view: EntityView, value: Readonly<T>): void;
  onUpdate?(view: EntityView, value: Readonly<T>, interpolated: boolean): void;
  onDetach?(view: EntityView): void;
}
```

`interpolated` is `true` when `value` came from `replica.sample` (the `ComponentType`'s `interpolate` list is
non-empty, docs/sim.md 2.4), `false` when it is the value as of the render tick from `replica.readAt` (the newest
from `replica.read`, for a `newest` binder). A binder sees its component as the view shows it: attached from the
tick it came, detached from the tick it went, valued as of the render tick -- not as the newest snapshot has it, a
little ahead (docs/net.md B.5).

### 3.3 `update(dt)`

```
update(dt):
  frameDt = dt
  renderTick = clock.renderTick()
  visible = Set(ent.id for ent of replica.visibleAt(renderTick))   -- createdTick <= renderTick < destroyedTick (docs/net.md B.5)

  -- 1. create views
  for ent of replica.visibleAt(renderTick), e = ent.id:
    if !views.has(e):
      regionId = replica.read(e, Region)?.id ?? ent.regionId ?? floatingRegion ?? (throw RangeError: an entity without a region before any floating origin)   -- ent.regionId: the create's region-table entry (docs/net.md B.5)
      v = { id: e, regionId, object: new Group(), data: {}, attached: new Set() }   -- regionGroup(regionId) first: an unknown id throws before any view exists
      v.object.name = 'entity:' + e; regionGroup(regionId).add(v.object)
      views.set(e, v); emit viewCreated; if a listener disposed the world: return

  -- 2. binders, registration order, per view (ascending EntityId for determinism)
  for v of views (sorted by id):
    if !visible.has(v.id): continue
    for b of binders:
      c = b.component
      value = b.newest ? replica.read(v.id, c)          -- undefined when absent: as of the render tick, there from the tick it
                       : replica.readAt(v.id, c, renderTick)   --   came, gone from the tick it went (docs/net.md B.5)
      if value !== undefined:
        if !v.attached.has(b):
          v.attached.add(b); b.onAttach?.(v, value)
        if b.onUpdate:
          if c.interpolate.length and !b.newest:
            s = scratch(c)                                  -- one reused c.create() per component type (keyed by the type, not c.id)
            replica.sample(v.id, c, renderTick, s); b.onUpdate(v, s, true)
          else:
            b.onUpdate(v, value, false)
      else if v.attached.has(b):
        v.attached.delete(b); b.onDetach?.(v)

  -- 3. destroy views no longer visible
  for v of views (ascending id):
    if !visible.has(v.id): destroyView(v)                  -- removed from views() before its onDetach calls

  -- 4. buffered replicated events, in (tick, arrival) order
  while eventQueue.length and eventQueue[0].tick <= renderTick:
    evt = eventQueue.shift()
    ent = evt.def.schema.fields.entity?.kind === 'entity' ? evt.payload.entity : null   -- convention: an `entity` field of kind entity names the subject
    view = ent != null ? views.get(ent) ?? null : null
    for h of handlers.get(evt.def.name) ?? []: h(evt, view, this)

  -- 5. camera
  if camera: cameraCtx.dt = dt; cameraCtx.target = targetId != null ? views.get(targetId) ?? null : null; camera.update(dt, cameraCtx)

destroyView(v):
  for b of binders (reverse registration order): if v.attached.has(b): b.onDetach?.(v)
  v.attached.clear(); v.object.removeFromParent(); views.delete(v.id); emit viewDestroyed
```

`pushEvent` inserts by `tick` (stable, binary search) so late-arriving events with an earlier tick still dispatch
before later ones. `NetClient` already holds events until `tick <= renderTick` (docs/net.md B.7), so in practice
every pushed event is due and dispatches on the next `update`; the queue exists so that events pushed by other
sources (tests, game code) get the same ordering. During a dispatch, an unsubscribe takes effect at once, a handler
added for the same type first sees the next event, an event a handler pushes dispatches in the same `update` if it is
due, and `dispose` from a handler ends the dispatch (it also clears the queue and the handlers).

Detach order on destroy is the reverse of attach order so `ModelBinder` releases after game binders that referenced
`view.model`.

## 4. Core binders

### 4.1 `TransformBinder`

Component `Transform { pos: Vec3, rot: Quat, vel: Vec3 }` (docs/sim.md), interpolated `pos`/`rot`.

```
onUpdate(view, t, interpolated):
  o = regionFrameOffset(view)                                 -- §4.2; zero unless the sample blends two regions' frames
  view.object.position.set(t.pos.x + o.x, t.pos.y + o.y, t.pos.z + o.z)
  toThreeQuat(t.rot, view.object.quaternion)
```

`vel` is ignored (extrapolation is `ReplicaWorld.sample`'s job, docs/net.md). Positions are region-local, so no
origin math beyond that offset.

### 4.2 `RegionBinder`

```ts
export class RegionBinder implements Binder<{ id: RegionId }> { constructor(world: RenderWorld); readonly newest: true }   // Region as it comes: it times the switch itself
export function regionFrameOffset(view: EntityView): Readonly<Vec3>;   // this frame's offset; zero without RegionBinder state
```

Component `Region { id }`. The server rebases `Transform.pos` into the new region in the tick it writes `Region`
(docs/world.md §6.1), so re-parenting needs no position math, but not at the moment the new id arrives: `Region` has
no samples, so the binder sees the newest id, while `Transform` is sampled at the render tick, which lags the newest
snapshot by the interpolation delay (docs/net.md B.4). Re-parenting then would show old-region positions in the new
group for that delay (a jump of one cell) and blend samples local to different regions. So a view is shown in its
entity's region at the render tick:

```
state (view.data.__region): frames [{ tick, region }] ascending (the first also covers earlier ticks), seenTick, offset
onAttach(view, r): originOf(r.id); frames = [{ -inf, r.id }]; seenTick = replica.latestTick; place(r.id)   -- re-parents a view created under a guess
onUpdate(view, r):
  if r.id != last(frames).region:                            -- originOf(r.id) first: RangeError for an unknown id
    ring = replica.get(view.id)?.samples.get(registry id of Transform)
    tick = ring non-empty ? migrationTick(ring, seenTick, last(frames).region, r.id) : -inf
    drop trailing frames (not the first) with tick >= tick; then if the last frame's tick >= tick: its region = r.id
    else if its region != r.id: append { tick, r.id }
  seenTick = replica.latestTick
  if frames.length > 1: no ring -> keep only r.id; else drop leading frames while frames[1].tick <= min(renderTick, oldest sample tick),
                        then the oldest beyond ring.capacity + 1 (only a render tick that stopped advancing piles them up)
  if frames.length == 1: offset = 0; place(frames[0].region); return
  A, B, t = the bracket ReplicaWorld.sample uses at renderTick (docs/net.md B.5; A = B at or beyond either end, t = 0 unless strictly between)
  D = regionAt(renderTick)                                   -- regionAt(x): region of the last frame with tick <= x, else of the first
  offset = origin(regionAt(A)) - origin(D) + (origin(regionAt(B)) - origin(regionAt(A))) * t
  place(D)
place(id): g = world.regionGroup(id); if view.object.parent !== g: g.add(view.object); view.regionId = id   -- Three's add re-parents; the local transform is untouched
onDetach(view): delete the state; the view stays in its group

migrationTick(ring, seenTick, from, to):                     -- the first sample local to `to` arrived after seenTick
  S = samples with tick > seenTick
  if S.length <= 1: return the newest sample's tick          -- none: Region was written alone, the newest sample moves to `to`
  return the tick of the sample in S whose ring index k has the largest gain, ties to the newer:
    gain(k) = k == 0 ? 0 : |P[k] - P[k-1]| - |origin(to) - origin(from) + P[k] - P[k-1]|   -- P[k]: pos of ring sample k, 0 = oldest
```

`TransformBinder` adds the offset, so the position is exactly the blend of the two samples' world positions: across a
border it is continuous whatever the floating origin. A game binder that sets `view.object.position` from
`Transform` itself adds `regionFrameOffset(view)` too; both run after `RegionBinder`, which `createClient` registers
first. The gain picks the split when several snapshots arrived between frames (a stall): at a border crossing the
local jump of about the origin distance becomes the entity's own motion. Two limits, both lasting until the render
tick passes the samples concerned: a view created after its entity migrated but before the render tick reached the
migration shows the older samples in the new region (the previous region is not known; it needs a migration within
the interpolation delay of the create), and two region changes between one frame and the next (a stall over a
double crossing) are seen as one change or none.

### 4.3 `ModelBinder`

Component `Model { asset: AssetId, variant: number }` (`variant` is `u8`, docs/sim.md 2.5).

```ts
export type ModelComponent = { asset: AssetId; variant: number };   // ReturnType<typeof Model.create>
export interface GltfAsset { scene: THREE.Group; animations: THREE.AnimationClip[]; meta: ModelMeta }   // declared in gltf-backend.ts

export interface ModelInstance {
  root: THREE.Object3D;                        // the clone, child of view.object
  lod: THREE.LOD | null;                       // present when meta.lods.length > 0
  sockets: Map<string, THREE.Object3D>;        // name without 'SOCKET_' -> node in the clone
  mixer: THREE.AnimationMixer;                 // bound to root
  clips: Map<string, THREE.AnimationClip>;     // by clip name
  meta: ModelMeta;
  handle: AssetHandle<GltfAsset>;
  variant: number;
  skinned: boolean;
}

export interface ModelBinderOptions {
  placeholder?: (view: EntityView, value: ModelComponent) => THREE.Object3D;   // default 1 m wireframe box, colour 0xff00ff
  onVariant?: (instance: ModelInstance, variant: number, view: EntityView) => void;
  priority?: Priority;                          // default 'high'
}
export class ModelBinder implements Binder<ModelComponent> { constructor(world: RenderWorld, opts?: ModelBinderOptions) }
```

```
onAttach(view, m):
  ph = placeholder(view, m); ph.name = 'placeholder'; view.object.add(ph)
  s = view.data.__model = { ph, inst: null, asset: m.asset, variant: m.variant }   -- a new object per attach
  request(view, s)

request(view, s):
  if !world.assets: return                                          -- no manifest (createClient): the placeholder stays
  world.assets.acquire<GltfAsset>(s.asset, priority).then(handle => {
    if view.data.__model !== s: handle.release(); return            -- detached or asset changed meanwhile
    try: if handle.asset is not a GltfAsset: throw TypeError; inst = instantiate(handle, s.variant)
    catch err: handle.release(); warnOnce(s.asset, err); return    -- keep the placeholder
    view.object.add(inst.root); view.object.remove(s.ph); disposePlaceholder(s.ph); s.ph = null
    s.inst = inst; view.model = inst
    onVariant?.(inst, s.variant, view)
    if view.data.__model === s: world.emit('modelReady', { view, model: inst })   -- unless onVariant released it
  }, err => { if view.data.__model === s: warnOnce(s.asset, err) })               -- keep placeholder; console.warn once per asset id

gltfName(n) = typeof n.userData.name == 'string' ? n.userData.name : n.name
  -- GLTFLoader stores the glTF node name in userData.name; n.name is sanitised ('.' dropped, so
  -- `ship_COL_box.001` becomes `ship_COL_box001`) and de-duplicated with `_1` suffixes

instantiate(handle, variant):
  tpl = handle.asset; meta = tpl.meta
  skinned = tpl.scene has any SkinnedMesh
  clone = skinned ? SkeletonUtils.clone(tpl.scene) : tpl.scene.clone(true)    -- geometries/materials shared with template
  clone.traverse(n => if COLLIDER_RE.test(gltfName(n)): n.visible = false)
  sockets = Map(); clone.traverse(n => m = SOCKET_RE.exec(gltfName(n)); if m: sockets.set(m[1], n))
  lod = null
  if meta.lods.length:
    lod = new THREE.LOD(); lod.name = meta.root + '_LOD'; parent = null
    for l of meta.lods:
      node = first node under clone (pre-order) with gltfName(node) == l.name; if !node: continue
      parent ??= node.parent; lod.addLevel(node, l.distance)            -- addLevel re-parents the node
    (parent ?? clone).add(lod)                                          -- where the levels were (the root node), so its transform still applies
  mixer = new AnimationMixer(clone); clips = Map(tpl.animations.map(c => [c.name, c]))
  return { root: clone, lod, sockets, mixer, clips, meta, handle, variant, skinned }

onUpdate(view, m):
  s = view.data.__model
  if !s or m.asset != s.asset: release(view); onAttach(view, m); return
  if m.variant != s.variant:
    s.variant = m.variant                           -- also before the model resolves: it resolves with the latest
    if s.inst: s.inst.variant = m.variant; onVariant?.(s.inst, m.variant, view)
  s.inst?.mixer.update(world.frameDt)

onDetach(view): release(view)

release(view):
  s = view.data.__model; if !s return
  delete view.data.__model                         -- invalidates an in-flight acquire
  if s.inst:
    if view.model === s.inst: view.model = undefined
    s.inst.mixer.stopAllAction(); s.inst.mixer.uncacheRoot(s.inst.root)
    s.inst.root.removeFromParent()
    if s.inst.skinned: disposeCloneOwned(s.inst.root)   -- SkeletonUtils gives each cloned SkinnedMesh its own Skeleton; Skeleton.dispose frees only its boneTexture
    s.inst.handle.release()
  if s.ph: view.object.remove(s.ph); disposePlaceholder(s.ph)
```

The swap happens when the acquire settles (a microtask after the frame that requested it), so `modelReady` and
`onVariant` for a new model run between frames.

Geometry, materials and textures belong to the template and are disposed by `GltfBackend.dispose` when the
`AssetLoader` evicts the asset after grace. `LOD` levels use the clone's nodes, so they need no separate disposal.
`defaultPlaceholder(view?, value?)` returns a new `Mesh`, centred on the entity, that shares one module-level
`BoxGeometry(1,1,1)` and `MeshBasicMaterial({ color: 0xff00ff, wireframe: true })`, created on first use and never
disposed; `disposePlaceholder` therefore disposes nothing. A binder that restyles a placeholder (the sandbox
`VehicleBinder` tint) assigns its own material rather than mutating the shared one, and disposes it in its
`onDetach`, which runs before `ModelBinder`'s. The same holds for a resolved model on `modelReady`: its materials
are the template's, shared by every instance, so a per-entity restyle assigns cloned materials and disposes them.

## 5. `GltfBackend`

```ts
export interface GltfBackendOptions { loader?: GLTFLoader; manager?: THREE.LoadingManager }   // default loader: new GLTFLoader(manager)
export class GltfBackend implements AssetBackend<GltfAsset> {
  readonly type = 'model';
  constructor(opts?: GltfBackendOptions);
  load(url, entry, signal, ctx): Promise<GltfAsset>;
  dispose(asset: GltfAsset): void;
}
```

```
load(url, entry, signal, ctx):
  bytes = await fetchBytes(url, entry, signal, ctx)             -- from @conduit/assets; honours signal and verify
  if signal.aborted: throw new DOMException('aborted', 'AbortError')   -- nothing parsed yet
  glb = parseGlb(bytes, { jsonOnly: true })                     -- @conduit/assets; throws GlbParseError
  meta = deriveModelMeta(glb.json, ctx.id)
  gltf = await new Promise((res, rej) => gltfLoader.parse(bytes, '', res, rej))   -- GLTFLoader, no DRACOLoader set
  if signal.aborted: dispose({ scene: gltf.scene, ... }); throw new DOMException('aborted', 'AbortError')
  return { scene: gltf.scene, animations: gltf.animations, meta }

dispose(asset):                                   -- each object once, however many meshes share it
  geometries, materials, skeletons = Sets from asset.scene.traverse(n =>
    n.geometry; each of (Array.isArray(n.material) ? n.material : [n.material]); n.isSkinnedMesh ? n.skeleton)
  textures = Set of every own property value v of every material with v.isTexture   -- all slots, MeshPhysicalMaterial's too
  dispose geometries, then textures, materials, skeletons
```

`meta` uses the same `deriveModelMeta` as docs/assets.md, so server (`GltfMetaBackend`) and client agree on
colliders and sockets. A game registers it with the loader like any backend:
`new AssetLoader(manifest, [new GltfBackend(), new JsonBackend(), ...])` (docs/game.md §4 does this when a canvas is
given).

## 6. Cameras

```ts
export interface InputSource {                    // supplied by the game; polled once per frame, never DOM-bound here
  pointerDelta(): { x: number; y: number };       // pixels since last call; resets on read
  wheelDelta(): number;                           // deltaY sum since last call; resets on read
  isPointerDown(button: 0 | 1 | 2): boolean;
  isKeyDown(code: string): boolean;               // KeyboardEvent.code
}

export interface CameraContext {
  camera: THREE.PerspectiveCamera;
  world: RenderWorld;
  input: InputSource;
  target: EntityView | null;                      // set via RenderWorld.cameraTarget
  dt: number;
}

export interface CameraController {               // as CONCEPT.md, plus the optional rebase below
  attach(ctx: CameraContext): void;
  update(dt: number, ctx: CameraContext): void;
  detach(): void;
  rebase?(delta: Vec3): void;                     // scene space moved by -delta (floating origin, end of §6.3)
}

export const NULL_INPUT: InputSource;              // all zeros/false; used when the game supplies none
```

`RenderWorld.setCamera(c)`: `prev?.detach(); ctx.target = view(targetId) ?? null; c?.attach(ctx)`. There is one
`CameraContext` per world, refreshed (`dt`, `target`) before each `update`. `createClient` passes `input` from
its options (`InputSource` built by the game from DOM listeners) into `RenderWorld` via `setInput(input)`.

### 6.1 `FollowCamera`

```ts
export interface FollowCameraOptions {
  offset?: Vec3;          // FOLLOW_OFFSET_DEFAULT = { x: 0, y: 6, z: -14 }, target local space (behind, since forward = +Z)
  stiffness?: number;     // FOLLOW_STIFFNESS_DEFAULT = 8   (1/s)
  lookAhead?: number;     // FOLLOW_LOOK_AHEAD_DEFAULT = 0.3 (s of target velocity added to the look point)
  lookOffset?: Vec3;      // FOLLOW_LOOK_OFFSET_DEFAULT = { x: 0, y: 1.5, z: 0 }
  up?: Vec3;              // { x: 0, y: 1, z: 0 }
}
```

```
update(dt, ctx):
  if !ctx.target: followed = null; return                        -- the camera holds still
  t = ctx.target.object
  tPos, tQuat = decompose(t.matrixWorld after t.updateWorldMatrix(true, false))
  desired = tPos + rotate(tQuat, offset)
  if t !== followed: snap                                        -- first target, or a new/re-created view
  else:
    if dt > 0: vel = (tPos - prevPos) / max(dt, 1e-4)            -- finite-difference velocity in scene space
    prevPos = tPos
    -- critically damped spring: x += (desired - x) * (1 - exp(-stiffness * dt))
    k = 1 - exp(-stiffness * dt)
    pos += (desired - pos) * k
  look = tPos + rotate(tQuat, lookOffset) + vel * lookAhead
  ctx.camera.position.copy(pos); ctx.camera.up.copy(up); ctx.camera.lookAt(look)
snap: followed = t; pos = desired; prevPos = tPos; vel = 0
attach(ctx): followed = null; if ctx.target: snap and place the camera as above
detach(): followed = null
```

### 6.2 `OrbitCamera`

```ts
export interface OrbitCameraOptions {
  distance?: number;      // ORBIT_DISTANCE_DEFAULT = 12
  minDistance?: number;   // 2
  maxDistance?: number;   // 200
  yaw?: number;           // radians, default 0
  pitch?: number;         // ORBIT_PITCH_DEFAULT = 0.5
  minPitch?: number;      // 0.05
  maxPitch?: number;      // 1.5
  sensitivity?: number;   // ORBIT_SENSITIVITY = 0.005 rad/pixel
  zoomSpeed?: number;     // ORBIT_ZOOM_SPEED = 0.001 per wheel unit, applied multiplicatively: distance *= 1 + delta*zoomSpeed
  dragButton?: 0 | 1 | 2; // default 0
  point?: Vec3;           // fixed orbit centre (scene space) used when no target; default (0, 0, 0)
  smoothing?: number;     // ORBIT_SMOOTHING = 12 (1/s); 0 = instant
}
```

```
update(dt, ctx):
  if ctx.input.isPointerDown(dragButton): d = ctx.input.pointerDelta(); yaw -= d.x * sensitivity; pitch = clamp(pitch + d.y * sensitivity, minPitch, maxPitch)
  else ctx.input.pointerDelta()                                   -- consume
  distance = clamp(distance * (1 + ctx.input.wheelDelta() * zoomSpeed), minDistance, maxDistance)
  centre = ctx.target ? ctx.target.object.getWorldPosition() : point
  desired = centre + (distance * cos(pitch) * sin(yaw), distance * sin(pitch), distance * cos(pitch) * cos(yaw))
  source = ctx.target ? ctx.target.object : 'point'
  if source !== followed: followed = source; pos = desired        -- snap on a new centre source, like FollowCamera
  else: k = smoothing ? 1 - exp(-smoothing * dt) : 1; pos += (desired - pos) * k
  ctx.camera.position.copy(pos); ctx.camera.up.set(0, 1, 0); ctx.camera.lookAt(centre)
attach(ctx): followed = null; place as in update without reading input (so it snaps)
detach(): followed = null
constructor: distance and pitch start clamped to their bounds
```

The snap matters for `createClient`, which attaches the camera before the local entity has a view: easing would
sweep the camera from `point` to the first target, possibly kilometres away.

### 6.3 `TopDownCamera`

```ts
export interface TopDownCameraOptions {
  height?: number;        // TOPDOWN_HEIGHT_DEFAULT = 60
  tilt?: number;          // TOPDOWN_TILT_DEFAULT = 0.9 rad from vertical (0 = straight down)
  yaw?: number;           // default 0
  minHeight?: number; maxHeight?: number;   // 10, 500
  zoomSpeed?: number;     // 0.001, wheel, multiplicative on height
  smoothing?: number;     // 12
}
```

```
update: centre = target world position or (0,0,0)
        height = clamp(height * (1 + wheel * zoomSpeed), minHeight, maxHeight)      -- pointer input is not read
        desired = centre + (height * sin(tilt) * sin(yaw), height * cos(tilt), height * sin(tilt) * cos(yaw))
        snap or smooth as above (source = target object or 'origin'); camera.up.set(-sin(yaw), 0, -cos(yaw)); camera.lookAt(centre)
attach/detach as OrbitCamera; height starts clamped to its bounds
```

`TopDownCamera`'s `up` is the horizontal direction away from the camera: at rest it frames exactly as `+Y` would for
`0 < tilt < π/2`, but it stays defined at `tilt = 0` (where `+Y` is parallel to the view direction) and does not
spin when a moving target passes under a steep camera.

All three controllers work in scene space (floating-origin-relative). On a floating-origin change, `RenderWorld`
moves a scene-space `host.camera` by `-delta` and calls `controller.rebase?.(deltaVec3)` if present (§3.1), before
emitting `floatingOrigin`; core controllers implement `rebase` by subtracting `delta` from their internal
`pos`/`prevPos` (and `OrbitCamera`'s `point`) so the spring does not jerk.

## 7. Visibility and gc

An entity has a view iff `createdTick <= renderTick < destroyedTick` per `ReplicaWorld.visibleAt` (docs/net.md).
`ReplicaWorld.gc` is called only by `NetClient.update` with `GC_LAG_TICKS = 2 × snapshotEvery` (docs/net.md B.1,
B.5); `RenderWorld` never calls it. Because gc only removes entities whose `destroyedTick` is already behind the
render tick by that lag, a view is always destroyed (step 3 above) before its replica entry disappears.

## 8. Debug helpers (`src/debug/*`)

```ts
export class RegionBoundsHelper {        // one LineSegments wireframe per region group, from graph bounds
  constructor(world: RenderWorld, opts?: { color?: number; activeColor?: number });   // 0x444444 / 0x00ff88 (activeColor: world.floatingRegion)
  update(): void;                        // sync with world's region groups; call from onFrame
  dispose(): void;                       // removes the lines; disposes their geometries and both materials; update() is then a no-op
}
export class EntityLabels {              // optional; imports CSS2DRenderer from three/addons
  constructor(world: RenderWorld, container: HTMLElement, opts?: { text?: (v: EntityView) => string });   // default `${id}`
  render(camera: THREE.Camera): void;    // call after the render fn
  dispose(): void;                       // idempotent: unsubscribes, removes every label and the overlay
}
export interface RenderStats { fps: number; dt: number; calls: number; triangles: number; geometries: number; textures: number; views: number; regionGroups: number; loaderInFlight: number }
export function statsHook(host: RenderHost, world: RenderWorld, cb: (s: RenderStats) => void, everyMs = 250): () => void;
```

`RegionBoundsHelper.update` walks the children of `world.root` with a string `userData.regionId` (as `statsHook`
does): a group without an outline gets a `LineSegments` named `region-bounds` as its child, built in region-local
space from `graph.get(id).bounds` (`aabb2`: the `min`/`max` rectangle at 0 on the unbounded axis; `aabb3`: the 12
box edges; `node`: no line), so it follows the floating origin; each line takes the active material when its region
is `world.floatingRegion`. An outline whose group left `root` (`releaseRegionGroup`) or was replaced by a new group
for the same id is removed and its geometry disposed.

`EntityLabels` appends a `CSS2DRenderer`'s overlay element (class `conduit-labels`, absolutely positioned at the
container's top-left, `pointer-events: none`) to `container`, usually the canvas's parent covering it. Every view,
existing or later (`viewCreated`), gets a `CSS2DObject` child named `label` (a `div.conduit-label`) at its origin;
`viewDestroyed` removes it and its element. `render` sets each label's text to `text(view)` when it changed, sizes
the overlay to the container's client size (else the canvas's, else 1) and renders `host.scene` with `camera`.

`statsHook` registers `host.onFrame((dt) => ...)` (the returned function unsubscribes, idempotent): it counts frames
and sums their `dt`, and once the sum reaches `everyMs` it calls `cb` with a new object and starts a new window:
`fps = frames / Σdt`, `dt` = the last frame's (clamped) `dt`, `calls`/`triangles` from `renderer.info.render` and
`geometries`/`textures` from `renderer.info.memory` (read before this frame renders, so the previous frame's), `views`
= number of views, `regionGroups` = children of `world.root` with a `userData.regionId`, `loaderInFlight =
world.assets?.stats().inFlight ?? 0`. Frame time rather than wall time keeps it on the host's (injectable) clock.

## 9. Package rules for tests

- Vitest environment `jsdom` (`conduitVitest({ environment: 'jsdom' })`, docs/consuming.md). No WebGL: tests pass
  `renderer: new FakeRenderer()` from `test/fake-renderer.ts`, which implements `RendererLike` with counters and an
  `info.memory` that counts a geometry/texture from the first frame that draws it until its `dispose` event (as
  `WebGLRenderer` does). The one test of a host-created renderer replaces `WebGLRenderer` with `vi.mock('three')`.
  jsdom has no `ResizeObserver`; the observer test stubs one.
- `requestAnimationFrame` is injected (`raf`/`caf`/`now` options from the fixture's `FrameDriver`) and driven
  manually with `stepFrame(ms)`.
- `ReplicaWorld` and `NetClock` are used for real (from `@conduit/net-client`) fed with synthetic snapshots via
  `test/replica-fixture.ts`, so binder tests exercise real `sample`/`visibleAt` semantics. The fixture runs at
  50 Hz (`tickMs` = 20 ms, exact in floating point) and `setRenderTick(t)` drives the real clock (`reset`, one
  sample, one `update`) so that `renderTick() === t` exactly.
- Model tests read `packages/assets/test/fixtures/ship_sloop.glb` with `node:fs` from a path resolved against
  `import.meta.dirname`; `new URL('…', import.meta.url)` does not work there because Vite rewrites that pattern into
  a dev-server asset URL.

## 10. Headless rule and the tests

### 10.1 Module-graph test (`packages/game/test/module-graph.test.ts`)

ESM has no `require.cache`, so each scenario runs in a fresh child `node` whose resolve hook records every
module URL it resolves:

```
trace(script):                                   -- script: an ES module body
  node [typescript flags] --import ./test/trace-loader.mjs --input-type=module -e <script>
       cwd packages/game (so '@conduit/game/*' resolve through the package's own `exports`), env CONDUIT_TRACE_OUT=<tmp file>
  typescript flags: none when Node strips types itself (`process.features.typescript`, Node >= 22.18);
                    otherwise `--import <tsx/esm resolved from @conduit/tooling>`
  the body is wrapped with a 5 s `setTimeout(() => process.exit(done ? 0 : 3)).unref()` guard: a finished
  scenario exits even if a handle stays open, a hung one fails with exit code 3 (execFile timeout 30 s)
  return JSON.parse(<tmp file>)

scenarios (all four traced in parallel):
  server    await import('@conduit/game/server')
  entries   await import('@conduit/game/server'); '@conduit/net-client'; '@conduit/game'; '@conduit/game/client'
  inUse     defineGame (inline minimal game) + createServer(devAuth) + a headless createClient that connects,
            waits 250 ms, requires its own Transform in the replica, dispose(), server.close()
  render    await import('@conduit/render')                                     -- positive control

THREE_URL  = /\/node_modules\/(\.pnpm\/[^/]*\/node_modules\/)?three\//
RENDER_URL = /\/packages\/render\//
assert THREE_URL matches hoisted and pnpm virtual-store paths of three and not `node_modules/threejs-extras/`
assert render has URLs matching THREE_URL and RENDER_URL                        -- the trace works
assert server has packages/game/src/server.ts and a node_modules/ws/ URL; entries has packages/game/src/client.ts
       and packages/net-client/src/net-client.ts; inUse has packages/game/src/client.ts   -- non-empty traces
assert server, entries and inUse have no URL matching THREE_URL or RENDER_URL
```

`packages/game/test/trace-loader.mjs` (`node --import ./test/trace-loader.mjs <entry>`) registers a resolve hook
that calls `nextResolve` and records `result.url`, so it sees static and dynamic imports and `require()` calls. It
uses the synchronous in-thread `module.registerHooks` (Node >= 22.15) and falls back to `module.register` with an
async hook on the loader thread that posts each URL back over a `MessagePort`. On `exit` it writes the URLs as a
JSON array to the file named by `CONDUIT_TRACE_OUT`, or prints them to stdout when that is unset.

### 10.2 Render tests (jsdom)

| Test | Proves |
| --- | --- |
| `host.test.ts` | frame order is world.update, onFrame callbacks in registration order, render fn; `dt` clamps to `MAX_DT`; `stop` cancels the pending frame; `setRenderFn(null)` restores default; resize updates aspect and `setSize`; host-created renderer disposed on `dispose`, supplied renderer not; `statsHook` reports fps from frame `dt` and the renderer/world counts once per `everyMs` window and stops after unsubscribe |
| `world-lifecycle.test.ts` | a snapshot creating entity E at tick 10: no view at renderTick 9, view at 10; destroy at 20: view at 19, none at 20; views are under `regionGroup(Region.id)`; `viewCreated`/`viewDestroyed` emitted; `RenderWorld.update` never calls `replica.gc` (spy); `releaseRegionGroup` removes a group only while no view is in it, and `regionGroup` then creates a new one |
| `binders.test.ts` | registration order = update order; `onAttach` once then `onUpdate` each frame with `interpolated=true` for `Transform` and `false` for a non-interpolated component; removing the component calls `onDetach` once and keeps the view; destroy calls `onDetach` in reverse registration order; `TransformBinder` writes sampled pos/quat (midpoint of two samples at the midpoint tick) |
| `region-binder.test.ts` | `Region.id` change re-parents the view to the new group without changing local position, once the render tick reaches the migration sample (blending in world space before it); an entity driving across a border with the render tick 7 ticks behind the snapshots and the floating origin elsewhere has, every frame, the world position of the server trajectory (steps equal to its per-frame motion), also when the snapshots around the crossing arrive in one burst after a stall and when it zig-zags across the border every one or two snapshots; a `FollowCamera` has the same world-space position and orientation whether or not the floating origin follows the entity's region; `setFloatingOrigin` moves every group by the origin delta, rebases the camera controller and a scene-space `host.camera`, and emits `floatingOrigin`; group positions equal `origin - floatingOrigin`; unknown ids throw `RangeError` |
| `debug-helpers.test.ts` | `RegionBoundsHelper` outlines each region group from its bounds (`aabb2` on both planes, `aabb3`, none for `node`) with the floating region in `activeColor`, disposes the outline of a released group, and disposes everything on `dispose`; `EntityLabels` labels views by id (or `text`), follows view creation and destruction, positions the elements on `render`, and removes its overlay on `dispose` |
| `model-binder.test.ts` | with a fake `AssetLoader` (a subclass whose `acquire` returns resolvable promises) and a hand-built `GltfAsset` template: placeholder shown until resolve; on resolve the clone is a child of `view.object`, `_COL_*` hidden (matched on `userData.name`, `.NNN` suffix included), sockets collected, `THREE.LOD` has levels at meta distances, `clips` keyed by name and the mixer advances by `frameDt`, `modelReady` emitted once, `onVariant` called when the model resolves (with the latest variant) and on a `variant` (u8) change; detach before resolve releases the handle without adding the clone; detach after resolve releases exactly once and the template geometry is not disposed; an asset change or a failed/non-model acquire keeps a placeholder (one warning per id); a skinned clone's own skeleton is disposed on detach; plus the real `AssetLoader` + `GltfBackend` on `ship_sloop.glb`: GLTFLoader names resolve to LODs/colliders/sockets, and `FakeRenderer` memory returns to 0 after release and the grace expiry |
| `events.test.ts` | `pushEvent` with tick 15 dispatches when renderTick reaches 15, not before; two events with ticks 12 and 11 pushed in that order dispatch 11 first; handlers are keyed by `def.name`; handler receives the view when the payload's `entity` field names a visible entity and `null` otherwise |
| `cameras.test.ts` | `FollowCamera` converges to `target + rotated offset` within 2 s at 60 fps and never overshoots (monotone distance); `OrbitCamera` yaw changes by `-dx * sensitivity` on drag, pitch clamped, zoom clamped to bounds; `TopDownCamera` height clamped; `NULL_INPUT` leaves cameras still |
| `gltf-backend.test.ts` | `GltfBackend.load` on the `ship_sloop.glb` fixture (shared from `packages/assets/test/fixtures`) returns a scene with the root name, the fixture's two animations (`idle`, `sail`) parsed by `GLTFLoader`, and `meta` deep-equal to `deriveModelMeta`; `dispose` calls `dispose` on every geometry/material/texture exactly once (spies), including shared materials and textures, and on each skeleton once; an abort during parsing rejects with `AbortError` and disposes the parsed scene; an abort before the bytes arrive, or bytes that are not GLB (`GlbParseError`), reject without calling `GLTFLoader` |
| `math.test.ts` | `toThreeVec3`/`toThreeQuat` round-trip with `fromThree*` and reuse `out` |

### 10.3 Memory-baseline e2e (`examples/sandbox/e2e/render-memory.spec.ts`, Playwright chromium)

Runs against the sandbox dev server (real WebGL, headless chromium with `--use-gl=angle --use-angle=swiftshader`).
`examples/sandbox/playwright.config.ts`: `testDir: 'e2e'`, one worker (the specs share one dev session),
`webServer: { command: 'pnpm dev', url: 'http://localhost:5173', reuseExistingServer: !CI, gracefulShutdown: SIGTERM }`,
reporters `list` and `html` (`playwright-report/`, uploaded by the CI `e2e` job on failure, docs/consuming.md §7).
Playwright waits for vite only, so `e2e/sandbox.ts`'s `openSandbox(page, name)` first waits for the game server's
port 8081, then opens `/?name=<name>` and awaits `__conduit.ready`, retrying while the page is replaced under it
(Vite reloads once after optimizing a dependency it discovered on the first load).

```
errors = console errors + page errors from the start
openSandbox(page, 'e2e-render-memory')
poll until client.regions.loading() is empty and every view has its model (no placeholder)
REGION = 'cell/0_0'                                  -- GridWorld ids are `${kind}/${ix}_${iy}` (docs/world.md §2); far
                                                     -- from the spawn cell cell/8_8, so it is not held and no view is in its group
host.stop()                                          -- (1)
expect(manifest.regions[REGION]).not.toHaveLength(0); expect(regionsLoaded()).not.toContain(REGION); no view in REGION
await __conduit.debug.expireGrace()                  -- graces armed before the test expire now, not inside the loop
probe = { geometries, textures from host.renderer.info.memory,
          [{ id, state: assets.state(id), refcount: assets.refcount(id) } for id of manifest.regions[REGION]],
          hasGroup: world.hasRegionGroup(REGION) }
baseline = probe; expect(baseline.hasGroup).toBe(false)
for i in 0..49:
  await page.evaluate(async () => {
    const h = await __conduit.assets.acquireGroup(__conduit.manifest.regions[REGION])
    __conduit.world.regionGroup(REGION)              -- created: hasRegionGroup is true
    h.release(); __conduit.world.releaseRegionGroup(REGION)   -- removed: no view is in it (a no-op while one is)
    await __conduit.debug.expireGrace()              -- test hook: fast-forwards loader grace timers
  })
expect(probe).toEqual(baseline)                      -- renderer memory, and the loader's state and references
host.start(); expect(host.frame).toBe(the frame count at stop); poll until host.frame advanced by more than 10
expect(errors).toEqual([])
```

(1) The frame loop is paused while the test measures. Otherwise the counts move for reasons the test does not
control (a wanderer walking into view or to another level of detail uploads geometry nobody rendered before), and
a rendered frame would re-upload anything the loader disposed while a view still used it, which is exactly the
release bug the probe looks for. The region's assets (the `crate` model) are also in use by the crates around the
spawn cell, so a correct acquire and release neither loads nor frees GPU memory: over-releasing shows up as a lower
geometry count and a lost reference, a leaked reference as a higher `refcount`.

`window.__conduit` is exposed by the sandbox (CONCEPT.md) and includes `debug.expireGrace()` which calls the
injected loader timer's fast-forward.

## 11. Files

### packages/render/src

| File | Exports |
| --- | --- |
| `index.ts` | re-exports everything below |
| `math.ts` | `toThreeVec3`, `toThreeQuat`, `fromThreeVec3`, `fromThreeQuat` |
| `host.ts` | `RenderHost`, `RenderHostOptions`, `RendererLike`, `RenderFn`, `FrameCb`, `PIXEL_RATIO_CAP_DEFAULT`, `MAX_DT`, `CAMERA_FOV`, `CAMERA_NEAR`, `CAMERA_FAR` |
| `world.ts` | `RenderWorld`, `RenderWorldEvents`, `ReplicatedEvent`, `EventHandler` |
| `view.ts` | `EntityView`, `Binder` |
| `binders/transform.ts` | `TransformBinder` |
| `binders/region.ts` | `RegionBinder`, `regionFrameOffset` |
| `binders/model.ts` | `ModelBinder`, `ModelBinderOptions`, `ModelInstance`, `ModelComponent`, `defaultPlaceholder` |
| `gltf-backend.ts` | `GltfBackend`, `GltfBackendOptions`, `GltfAsset` |
| `cameras/context.ts` | `CameraController`, `CameraContext`, `InputSource`, `NULL_INPUT` |
| `cameras/follow.ts` | `FollowCamera`, `FollowCameraOptions`, `FOLLOW_OFFSET_DEFAULT`, `FOLLOW_STIFFNESS_DEFAULT`, `FOLLOW_LOOK_AHEAD_DEFAULT`, `FOLLOW_LOOK_OFFSET_DEFAULT` |
| `cameras/orbit.ts` | `OrbitCamera`, `OrbitCameraOptions`, `ORBIT_DISTANCE_DEFAULT`, `ORBIT_PITCH_DEFAULT`, `ORBIT_SENSITIVITY`, `ORBIT_ZOOM_SPEED`, `ORBIT_SMOOTHING` |
| `cameras/topdown.ts` | `TopDownCamera`, `TopDownCameraOptions`, `TOPDOWN_HEIGHT_DEFAULT`, `TOPDOWN_TILT_DEFAULT` |
| `debug/region-bounds.ts` | `RegionBoundsHelper` |
| `debug/labels.ts` | `EntityLabels` |
| `debug/stats.ts` | `statsHook`, `RenderStats` |

`package.json`: deps `@conduit/math`, `@conduit/protocol` (`EventDef` type), `@conduit/sim`, `@conduit/net-client`, `@conduit/assets` (added in M2), `@conduit/world`
(`WorldGraph`), all `workspace:*`; peers `three`, `@types/three`; devDeps `jsdom`, `three`,
`@types/three`. `tsconfig.json` adds `"lib": ["ES2022", "DOM", "DOM.Iterable"]`.

### packages/render/test

| File | Proves |
| --- | --- |
| `fake-renderer.ts` | (helper) `FakeRenderer implements RendererLike`, `FrameDriver` (`raf`/`caf`/`now`, `stepFrame(ms)`) |
| `replica-fixture.ts` | (helper) `ReplicaFixture`: `ReplicaWorld` + `NetClock` over the core components plus extras, a 4 x 4 `GridWorld` (cells 256 m), `snapshot(tick, spec)`, `setRenderTick(t)`; `createWorld(fixture?, hostOpts?, assets?)` adds a `RenderHost` on a `FakeRenderer` and a `RenderWorld` (with `assets` as its loader) |
| `host.test.ts` | section 10.2 |
| `world-lifecycle.test.ts` | section 10.2 |
| `binders.test.ts` | section 10.2 |
| `region-binder.test.ts` | section 10.2 |
| `debug-helpers.test.ts` | section 10.2 |
| `model-binder.test.ts` | section 10.2 |
| `events.test.ts` | section 10.2 |
| `cameras.test.ts` | section 10.2 |
| `gltf-backend.test.ts` | section 10.2 |
| `math.test.ts` | section 10.2 |

Outside this package but specified here: `packages/game/test/module-graph.test.ts` + `trace-loader.mjs`
(section 10.1) and `examples/sandbox/e2e/render-memory.spec.ts` (section 10.3).


### Predicted presentation provider

`RenderWorld.setPresentationProvider(provider)` opts into a complete pose override. The provider
has optional beginFrame(renderTick, nowMs) and sample(entity, renderTick, out): boolean methods.
It writes `{ entity, tick, regionId, boundaryKey, transform }` into caller-owned output; Transform
positions are local to regionId. False keeps the authoritative replica path. Sampling must not
step simulation. preparePresentation(nowMs) runs once before views/floating-origin/binders and
cameras; createClient calls it before choosing its floating origin. Local predicted entities can
prepare before their first delayed authoritative view exists.

RegionBinder uses the prepared region and clears cross-region interpolation offsets;
TransformBinder/model presentation and the camera consume the same prepared pose. CameraContext
exposes deeply readonly presentation metadata. A boundary/entity/region change invokes optional
CameraController.reset; FollowCamera drops its visual spring history and snaps on that frame.
Floating-origin changes still rebase scene-space camera state. Never override only a Transform
while its coordinates refer to a different region than the RegionBinder's placement. A144 Hz
regression exercises migration, teleport reset, model position and camera agreement.


Diagnostics are opt-in through RenderHostOptions.diagnostics (also createClient diagnostics).
Raw frame elapsed milliseconds are recorded before MAX_DT animation clamping; statsHook FPS now
uses raw elapsed time and exposes rawDt alongside the clamped animation dt. A200 ms frame reports
200 ms even though RenderHost animation dt is100 ms. Optional gpuTiming reads an asynchronous
renderer-provided result; absent/disjoint/invalid results are unavailable, never invented zero.
Context loss/restoration and render-frame failures emit bounded diagnostic records. Throwing
clocks, observer sinks or GPU timing callbacks do not interrupt rendering; visual callbacks
retain their existing error/stop behavior. Diagnostic listeners detach on disposal.

## Estimated template and instance resources

`GltfBackend.estimate` counts typed geometry/morph/index and animation backing buffers once, estimates
supported texture/mipmap upload sizes, and uses identities to share geometry/material/texture costs
across templates and model instances. JavaScript graph/material overhead, unsupported image formats,
compiled programs, retained parser/source bytes and driver residency stay explicitly unknown. It
estimates all template resources that may upload, including hidden/unused LOD geometry; this is not
the current renderer's exact residency. The measured ownership baseline is in
`artifacts/improvements/step11/ownership-baseline.json`.

Model clones share template geometry, materials, textures and clips. Each skinned clone owns its
skeleton buffers/bone textures. `ModelBinder` registers those instance resources and releases their
accounting with clone disposal. Bone-buffer/texture identity changes refresh the report; stable
frames do not allocate a new resource report. `GltfBackend` retains shared physical resource owners
across its loaded templates and disposes each after the last template releases it. Templates should
be treated as shared immutable resources by consumers.

A variant callback that creates materials, textures, buffers or other resources owns their lifecycle.
Report them using `AssetLoader.trackResources`, update the report when ownership changes, and release
the report alongside the consumer's disposer. Core cannot infer arbitrary consumer allocations or
external native/GPU costs. An unknown estimate is not zero. Renderer geometry/texture counters verify
ownership and cleanup, while exact byte residency remains unavailable; no GPU-byte ceiling is claimed.

Texture upload estimates deliberately leave 3D, array/layered, cube, compressed, depth and video
texture layouts unknown. A width and height alone cannot describe those costs. Consumers supporting
those variants can provide a backend-specific estimate; ordinary 2D formats remain modeled uploads.
