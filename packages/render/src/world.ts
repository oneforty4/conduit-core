import type { AssetLoader } from '@conduit/assets';
import type { Vec3 } from '@conduit/math';
import type {
  NetClock,
  ReplicaWorld,
  PresentationPose,
  PresentationProvider,
} from '@conduit/net-client';
import type { EventDef } from '@conduit/protocol';
import {
  Region,
  Transform,
  guardView,
  type DeepReadonly,
  type ComponentType,
  type EntityId,
} from '@conduit/sim';
import type { RegionId, WorldGraph } from '@conduit/world';
import { Group } from 'three';
import type { ModelInstance } from './binders/model.ts';
import {
  NULL_INPUT,
  type CameraContext,
  type CameraController,
  type InputSource,
} from './cameras/context.ts';
import type { RenderHost } from './host.ts';
import type { Binder, EntityView } from './view.ts';

/** A replicated event at render time: exactly the object `NetClient` emits on `'event'` (docs/net.md B.7). */
export interface ReplicatedEvent {
  def: EventDef;
  /** Server tick the event was emitted on. */
  tick: number;
  regionId: RegionId | null;
  payload: unknown;
}

/**
 * Handles one replicated event. `view` is the view of the entity named by the payload's `entity`
 * field (a field of kind `entity`) when that entity has a view at dispatch, else `null`.
 */
export type EventHandler = (
  evt: ReplicatedEvent,
  view: EntityView | null,
  world: RenderWorld,
) => void;

export interface RenderWorldEvents {
  viewCreated: { view: EntityView };
  viewDestroyed: { view: EntityView };
  /** Emitted by `ModelBinder` once a model resolved and replaced the placeholder. */
  modelReady: { view: EntityView; model: ModelInstance };
  /** Emitted by `setFloatingOrigin` after the groups moved; `origin` is a fresh copy. */
  floatingOrigin: { regionId: RegionId; origin: Vec3 };
}

type Listener<K extends keyof RenderWorldEvents> = (e: RenderWorldEvents[K]) => void;
type ListenerLists = { [K in keyof RenderWorldEvents]: readonly Listener<K>[] };

interface BinderRecord {
  readonly binder: Binder<unknown>;
  active: boolean;
}

interface HandlerRecord {
  readonly handler: EventHandler;
  active: boolean;
}

/** Index of the first view in `list` (ascending ids) whose id is `>= id`. */
function lowerBound(list: readonly EntityView[], id: EntityId): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((list[mid] as EntityView).id < id) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index in `queue` (ascending tick) after every event whose tick is `<= tick`: a stable insert. */
function upperBoundTick(queue: readonly ReplicatedEvent[], tick: number): number {
  let lo = 0;
  let hi = queue.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((queue[mid] as ReplicatedEvent).tick <= tick) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The subject of an event: by convention the payload's `entity` field, when the schema declares it
 * with kind `entity` (docs/render.md §3.3); otherwise null.
 */
function subjectOf(evt: ReplicatedEvent): EntityId | null {
  if (evt.def.schema.fields['entity']?.kind !== 'entity') return null;
  const payload = evt.payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const entity = (payload as Record<string, unknown>)['entity'];
  return typeof entity === 'number' ? entity : null;
}

/**
 * Turns the replica into a Three scene graph (docs/render.md §3): one `EntityView` per entity
 * visible at the render tick (`createdTick <= renderTick < destroyedTick`), parented to its
 * region's group, with binders driving each view from replicated components. Never calls
 * `ReplicaWorld.gc` (`NetClient.update` owns it, docs/net.md B.5).
 *
 * Replicated events pushed with `pushEvent` dispatch to `onEvent` handlers once the render tick
 * reaches their tick, after the binders ran.
 *
 * Scene space is floating-origin-relative (docs/render.md §3.1): each region group sits at its
 * region origin minus `floatingOrigin`, and entity positions stay region-local inside it.
 */
export class RenderWorld {
  /** Added to `host.scene`; name `conduit-root`. */
  readonly root: Group;
  readonly host: RenderHost;
  readonly replica: ReplicaWorld;
  readonly clock: NetClock;
  /** `undefined` when the game has no asset manifest (docs/game.md §4). */
  readonly assets: AssetLoader | undefined;
  /** `game.world(Welcome.worldSeed)`, built by `createClient` (docs/world.md). */
  readonly graph: WorldGraph;

  private readonly origin: Vec3 = { x: 0, y: 0, z: 0 };
  private originRegion: RegionId | null = null;
  private tick = 0;
  private dt = 0;
  private readonly groups = new Map<RegionId, Group>();
  private readonly viewMap = new Map<EntityId, EntityView>();
  /** Every view, ascending id: the binder pass order. */
  private readonly viewList: EntityView[] = [];
  /** Copy-on-write, so binders may be registered or unregistered from callbacks. */
  private binders: readonly BinderRecord[] = [];
  /** Sample output per interpolated component type, reused every frame. */
  private readonly scratch = new Map<ComponentType<unknown>, unknown>();
  private readonly visible = new Set<EntityId>();
  /** Pending replicated events, ascending tick, arrival order within a tick. */
  private readonly eventQueue: ReplicatedEvent[] = [];
  /** Copy-on-write per event name, so handlers may (un)subscribe during dispatch. */
  private readonly eventHandlers = new Map<string, readonly HandlerRecord[]>();
  private listeners: ListenerLists = {
    viewCreated: [],
    viewDestroyed: [],
    modelReady: [],
    floatingOrigin: [],
  };
  private camera: CameraController | null = null;
  private readonly cameraCtx: CameraContext;
  private targetId: EntityId | null = null;
  private disposed = false;
  private presentation: PresentationProvider | null = null;
  private poseSamples: Map<EntityId, PresentationPose> | null = null;
  private presented: Set<EntityId> | null = null;
  private presentationPrepared = false;
  private readonly poseGuards = new WeakMap<object, object>();
  private cameraBoundary: string | null = null;

  constructor(
    host: RenderHost,
    replica: ReplicaWorld,
    clock: NetClock,
    assets: AssetLoader | undefined,
    graph: WorldGraph,
  ) {
    this.host = host;
    this.replica = replica;
    this.clock = clock;
    this.assets = assets;
    this.graph = graph;
    this.root = new Group();
    this.root.name = 'conduit-root';
    host.scene.add(this.root);
    this.cameraCtx = { camera: host.camera, world: this, input: NULL_INPUT, target: null, dt: 0 };
  }

  /** World-space position currently at the root's (0,0,0). */
  get floatingOrigin(): Readonly<Vec3> {
    return this.origin;
  }

  get floatingRegion(): RegionId | null {
    return this.originRegion;
  }

  /**
   * `view`'s position in the world, into `out`: its region's origin plus its region-local position,
   * added in doubles (§3.1) -- however far the floating origin is from it.
   */
  worldOf<T extends Vec3>(view: EntityView, out: T): T {
    const o = this.originOf(view.regionId);
    const p = view.object.position;
    out.x = o.x + p.x;
    out.y = o.y + p.y;
    out.z = o.z + p.z;
    return out;
  }

  /** Scene point `p` in the world, into `out`: the floating origin added. */
  toWorld<T extends Vec3>(p: Readonly<Vec3>, out: T): T {
    const o = this.origin;
    out.x = p.x + o.x;
    out.y = p.y + o.y;
    out.z = p.z + o.z;
    return out;
  }

  /** World point `p` in the scene, into `out`: the floating origin taken away. */
  toScene<T extends Vec3>(p: Readonly<Vec3>, out: T): T {
    const o = this.origin;
    out.x = p.x - o.x;
    out.y = p.y - o.y;
    out.z = p.z - o.z;
    return out;
  }

  /** The render tick used by the last `update`. */
  get renderTick(): number {
    return this.tick;
  }

  /** `dt` (seconds) of the current or last `update`. */
  get frameDt(): number {
    return this.dt;
  }

  /**
   * The group for region `id`, created on demand: name `region:${id}`, `userData.regionId = id`,
   * positioned at `graph.get(id).bounds.origin - floatingOrigin`. `RangeError` for an id the graph
   * does not know.
   */
  regionGroup(id: RegionId): Group {
    const existing = this.groups.get(id);
    if (existing !== undefined) return existing;
    const origin = this.originOf(id);
    const g = new Group();
    g.name = `region:${id}`;
    g.userData['regionId'] = id;
    this.placeGroup(g, origin);
    this.root.add(g);
    this.groups.set(id, g);
    return g;
  }

  hasRegionGroup(id: RegionId): boolean {
    return this.groups.has(id);
  }

  /**
   * Removes the group of region `id` from `root` and forgets it, so the next `regionGroup(id)`
   * creates a new one. A no-op while any view is parented to the group, and for an id without a
   * group. Other children (game scenery, `RegionBoundsHelper` lines) leave with the group; their
   * owners dispose them.
   */
  releaseRegionGroup(id: RegionId): void {
    const g = this.groups.get(id);
    if (g === undefined) return;
    for (const v of this.viewList) {
      if (v.object.parent === g) return;
    }
    g.removeFromParent();
    this.groups.delete(id);
  }

  /**
   * Moves the floating origin to region `regionId`'s origin (docs/render.md §3.1): every group is
   * placed at `origin - floatingOrigin` (computed in doubles), so scene space moves by `-delta`
   * with `delta = new origin - old origin`. The host camera moves with it when it is in scene space
   * (no parent, or the scene or `root`), the camera controller's `rebase(delta)` runs, then
   * `floatingOrigin` is emitted. Views keep their local transforms. `RangeError` for an id the graph
   * does not know (nothing changes); a no-op after `dispose`.
   */
  setFloatingOrigin(regionId: RegionId): void {
    const next = this.originOf(regionId);
    if (this.disposed) return;
    const origin = this.origin;
    const delta: Vec3 = { x: next.x - origin.x, y: next.y - origin.y, z: next.z - origin.z };
    origin.x = next.x;
    origin.y = next.y;
    origin.z = next.z;
    this.originRegion = regionId;
    for (const [id, g] of this.groups) this.placeGroup(g, this.originOf(id));
    const cam = this.host.camera;
    if (cam.parent === null || cam.parent === this.host.scene || cam.parent === this.root) {
      cam.position.set(
        cam.position.x - delta.x,
        cam.position.y - delta.y,
        cam.position.z - delta.z,
      );
    }
    this.camera?.rebase?.(delta);
    this.emit('floatingOrigin', { regionId, origin: { x: origin.x, y: origin.y, z: origin.z } });
  }

  /**
   * Adds a binder; registration order is update order (and reverse detach order). The returned
   * function unregisters it, calling `onDetach` on every view it is attached to. Registering the
   * same binder object twice throws.
   */
  registerBinder<T>(b: Binder<T>): () => void {
    const binder = b as Binder<unknown>;
    if (this.binders.some((r) => r.binder === binder)) {
      throw new Error('RenderWorld.registerBinder: binder is already registered');
    }
    const rec: BinderRecord = { binder, active: true };
    this.binders = [...this.binders, rec];
    return () => {
      if (!rec.active) return;
      rec.active = false;
      this.binders = this.binders.filter((r) => r !== rec);
      for (const v of [...this.viewList]) {
        if (v.attached.delete(binder)) binder.onDetach?.(v);
      }
    };
  }

  view(e: EntityId): EntityView | undefined {
    return this.viewMap.get(e);
  }

  /** Every view, ascending id. */
  views(): Iterable<EntityView> {
    return this.viewList.values();
  }

  /** Detaches the previous controller, then attaches `c` (with the current target resolved). */
  setCamera(c: CameraController | null): void {
    const prev = this.camera;
    this.camera = null;
    prev?.detach();
    this.camera = c;
    if (c !== null) {
      this.cameraCtx.target = this.targetView();
      c.attach(this.cameraCtx);
    }
  }

  /** Default `NULL_INPUT`. */
  setInput(input: InputSource): void {
    this.cameraCtx.input = input;
  }

  /** The entity whose view becomes `CameraContext.target` (null while it has no view). */
  cameraTarget(e: EntityId | null): void {
    this.targetId = e;
    this.cameraCtx.target = this.targetView();
  }

  /**
   * Queues a replicated event until `renderTick >= evt.tick`. Inserted by tick (stable), so an event
   * with an earlier tick that arrives later still dispatches first. Ignored after `dispose`.
   */
  pushEvent(evt: ReplicatedEvent): void {
    if (this.disposed) return;
    const queue = this.eventQueue;
    const last = queue[queue.length - 1];
    if (last === undefined || last.tick <= evt.tick) queue.push(evt);
    else queue.splice(upperBoundTick(queue, evt.tick), 0, evt);
  }

  /**
   * Subscribes `handler` to replicated events whose `def.name` is `type`; handlers of one type run
   * in subscription order. Returns an idempotent unsubscribe, effective during a dispatch too.
   */
  onEvent(type: string, handler: EventHandler): () => void {
    const rec: HandlerRecord = { handler, active: true };
    this.eventHandlers.set(type, [...(this.eventHandlers.get(type) ?? []), rec]);
    return () => {
      if (!rec.active) return;
      rec.active = false;
      const list = (this.eventHandlers.get(type) ?? []).filter((r) => r !== rec);
      if (list.length > 0) this.eventHandlers.set(type, list);
      else this.eventHandlers.delete(type);
    };
  }

  on<K extends keyof RenderWorldEvents>(k: K, cb: Listener<K>): () => void {
    this.setListeners(k, [...this.listeners[k], cb]);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      const list = this.listeners[k];
      const i = list.indexOf(cb);
      if (i >= 0) this.setListeners(k, [...list.slice(0, i), ...list.slice(i + 1)]);
    };
  }

  /**
   * One render frame (docs/render.md §3.3): create views for newly visible entities, run the
   * binders over every visible view (ascending id, registration order), destroy views that are no
   * longer visible, dispatch the replicated events that are due, then update the camera. A no-op
   * after `dispose`.
   */
  /** Opt-in provider; model binders, region placement and camera share the same prepared pose. */
  setPresentationProvider(provider: PresentationProvider | null): void {
    this.presentation = provider;
    this.presentationPrepared = false;
    this.poseSamples = provider === null ? null : new Map();
    this.presented = provider === null ? null : new Set();
  }
  preparePresentation(nowMs?: number): void {
    const provider = this.presentation;
    if (provider === null || this.presentationPrepared) return;
    const tick = this.clock.renderTick();
    provider.beginFrame?.(tick, nowMs ?? performance.now());
    this.presented!.clear();
    for (const entity of this.replica.entities()) {
      if (entity.destroyedTick !== null) continue;
      let pose = this.poseSamples!.get(entity.id);
      if (pose === undefined) {
        pose = {
          entity: entity.id,
          tick,
          regionId: entity.regionId ?? '',
          boundaryKey: '',
          transform: Transform.create(),
        };
        this.poseSamples!.set(entity.id, pose);
      }
      if (!provider.sample(entity.id, tick, pose)) continue;
      if (
        pose.entity !== entity.id ||
        !Number.isFinite(pose.tick) ||
        this.graph.get(pose.regionId) === undefined ||
        pose.boundaryKey.length > 256
      )
        throw new RangeError('PresentationProvider: invalid entity, tick, region or boundary');
      this.presented!.add(entity.id);
    }
    for (const id of this.poseSamples!.keys())
      if (!this.replica.has(id)) this.poseSamples!.delete(id);
    this.presentationPrepared = true;
  }
  presentationFor(entity: EntityId): DeepReadonly<PresentationPose> | undefined {
    const pose = this.presented?.has(entity) ? this.poseSamples?.get(entity) : undefined;
    return pose === undefined ? undefined : guardView(pose, () => {}, false, this.poseGuards);
  }

  update(dt: number): void {
    if (this.disposed) return;
    this.preparePresentation();
    if (this.disposed) return;
    this.dt = dt;
    const renderTick = this.clock.renderTick();
    this.tick = renderTick;
    const visible = this.visible;
    visible.clear();

    // 1. create views
    for (const ent of this.replica.visibleAt(renderTick)) {
      visible.add(ent.id);
      if (!this.viewMap.has(ent.id)) {
        this.createView(ent.id, ent.regionId);
        if (this.disposed) return; // disposed by a viewCreated listener
      }
    }

    if (this.presented !== null)
      for (const id of this.presented) {
        if (visible.has(id)) continue;
        const pose = this.poseSamples!.get(id)!;
        visible.add(id);
        if (!this.viewMap.has(id)) this.createView(id, pose.regionId);
        if (this.disposed) return;
      }

    // 2. binders, registration order, per view in ascending id
    const binders = this.binders;
    const list = this.viewList;
    for (let i = 0; i < list.length; i++) {
      const v = list[i] as EntityView;
      if (!visible.has(v.id)) continue;
      for (const rec of binders) {
        if (rec.active) this.runBinder(v, rec.binder, renderTick);
        if (this.disposed) return;
      }
    }

    // 3. destroy views no longer visible (splice first: listeners see a consistent views())
    for (let i = 0; i < list.length;) {
      const v = list[i] as EntityView;
      if (visible.has(v.id)) {
        i++;
        continue;
      }
      list.splice(i, 1);
      this.destroyView(v);
    }

    // 4. replicated events due at the render tick, in (tick, arrival) order; a handler may push more
    const queue = this.eventQueue;
    while (queue.length > 0 && (queue[0] as ReplicatedEvent).tick <= renderTick) {
      const evt = queue.shift() as ReplicatedEvent;
      const handlers = this.eventHandlers.get(evt.def.name);
      if (handlers === undefined) continue;
      const subject = subjectOf(evt);
      const view = subject === null ? null : (this.viewMap.get(subject) ?? null);
      for (const rec of handlers) {
        if (!rec.active) continue;
        rec.handler(evt, view, this);
        if (this.disposed) return;
      }
    }

    // 5. camera
    const camera = this.camera;
    if (camera !== null) {
      const ctx = this.cameraCtx;
      ctx.dt = dt;
      ctx.target = this.targetView();
      const pose = ctx.target === null ? undefined : this.presentationFor(ctx.target.id);
      ctx.presentation = pose;
      const boundary =
        pose === undefined ? null : `${pose.entity}:${pose.boundaryKey}:${pose.regionId}`;
      if (boundary !== this.cameraBoundary) camera.reset?.();
      this.cameraBoundary = boundary;
      camera.update(dt, ctx);
    }
    this.presentationPrepared = false;
  }

  /** Detaches the camera, destroys every view (detaching its binders), removes `root`. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.setCamera(null);
    for (const v of this.viewList.splice(0)) this.destroyView(v);
    for (const rec of this.binders) rec.active = false;
    this.binders = [];
    this.root.removeFromParent();
    this.groups.clear();
    this.scratch.clear();
    this.cameraCtx.target = null;
    this.eventQueue.length = 0;
    for (const list of this.eventHandlers.values()) for (const rec of list) rec.active = false;
    this.eventHandlers.clear();
    this.listeners = { viewCreated: [], viewDestroyed: [], modelReady: [], floatingOrigin: [] };
  }

  /**
   * Calls the `on(k)` listeners in subscription order. Used by `ModelBinder` for `modelReady`; a
   * game binder that replaces it emits `modelReady` the same way.
   */
  emit<K extends keyof RenderWorldEvents>(k: K, e: RenderWorldEvents[K]): void {
    const list: readonly Listener<K>[] = this.listeners[k];
    for (const cb of list) cb(e);
  }

  private setListeners<K extends keyof RenderWorldEvents>(
    k: K,
    list: readonly Listener<K>[],
  ): void {
    this.listeners[k] = list as ListenerLists[K];
  }

  private targetView(): EntityView | null {
    return this.targetId === null ? null : (this.viewMap.get(this.targetId) ?? null);
  }

  /** `graph.get(id).bounds.origin`; `RangeError` for an id the graph does not know. */
  private originOf(id: RegionId): Readonly<Vec3> {
    const def = this.graph.get(id);
    if (def === undefined) throw new RangeError(`RenderWorld: unknown region ${id}`);
    return def.bounds.origin;
  }

  private placeGroup(g: Group, regionOrigin: Readonly<Vec3>): void {
    const o = this.origin;
    g.position.set(regionOrigin.x - o.x, regionOrigin.y - o.y, regionOrigin.z - o.z);
  }

  private createView(id: EntityId, replicaRegion: RegionId | null): void {
    // Region component first, then the region-table entry of the create (docs/net.md B.5).
    const regionId = this.replica.read(id, Region)?.id ?? replicaRegion ?? this.originRegion;
    if (regionId === null) {
      throw new RangeError(
        `RenderWorld: entity ${id} has no region and no floating origin has been set`,
      );
    }
    const group = this.regionGroup(regionId);
    const object = new Group();
    object.name = `entity:${id}`;
    const view: EntityView = { id, regionId, object, data: {}, attached: new Set() };
    group.add(object);
    this.viewMap.set(id, view);
    this.viewList.splice(lowerBound(this.viewList, id), 0, view);
    this.emit('viewCreated', { view });
  }

  private runBinder(v: EntityView, b: Binder<unknown>, renderTick: number): void {
    const c = b.component;
    // As of the render tick: there from the tick it came, gone from the tick it went (docs/net.md
    // B.5) -- or the newest, for a binder that times its component itself.
    const newest = b.newest === true;
    const pose = this.presentationFor(v.id);
    if (pose !== undefined && c.name === Transform.name) {
      if (!v.attached.has(b)) {
        v.attached.add(b);
        b.onAttach?.(v, pose.transform);
      }
      if (this.disposed || !v.attached.has(b)) return;
      b.onUpdate?.(v, pose.transform, true);
      return;
    }
    const value = newest ? this.replica.read(v.id, c) : this.replica.readAt(v.id, c, renderTick);
    if (value === undefined) {
      if (v.attached.delete(b)) b.onDetach?.(v);
      return;
    }
    if (!v.attached.has(b)) {
      v.attached.add(b);
      b.onAttach?.(v, value);
    }
    if (this.disposed || !v.attached.has(b) || b.onUpdate === undefined) return;
    if (c.interpolate.length > 0 && !newest) {
      let out = this.scratch.get(c);
      if (out === undefined) {
        out = c.create();
        this.scratch.set(c, out);
      }
      // `readAt` found it there, so `sample` returns `out` (docs/net.md B.5).
      const sampled = this.replica.sample(v.id, c, renderTick, out);
      b.onUpdate(v, sampled, true);
    } else {
      b.onUpdate(v, value, false);
    }
  }

  /** The caller has already removed `v` from `viewList`. */
  private destroyView(v: EntityView): void {
    try {
      const binders = this.binders;
      for (let i = binders.length - 1; i >= 0; i--) {
        const b = (binders[i] as BinderRecord).binder;
        if (v.attached.has(b)) b.onDetach?.(v);
      }
    } finally {
      v.attached.clear();
      v.object.removeFromParent();
      this.viewMap.delete(v.id);
    }
    this.emit('viewDestroyed', { view: v });
  }
}
