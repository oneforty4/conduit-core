import type { Vec3 } from '@conduit/math';
import { REMOVED, type SampleRingReader } from '@conduit/net-client';
import { Region, Transform } from '@conduit/sim';
import type { RegionId } from '@conduit/world';
import type { Binder, EntityView } from '../view.ts';
import type { RenderWorld } from '../world.ts';

/** The `Region` component's value: `{ id: RegionId }`. */
type RegionValue = ReturnType<typeof Region.create>;
type TransformValue = ReturnType<typeof Transform.create>;

/** `Transform` samples from `tick` on (up to the next frame's tick) are local to `region`. */
interface RegionFrame {
  readonly tick: number;
  readonly region: RegionId;
}

interface RegionState {
  /** Ascending `tick`; the first entry also covers every earlier tick. */
  readonly frames: RegionFrame[];
  /** `replica.latestTick` at the last attach or update: newer samples arrived since. */
  seenTick: number;
  /** This frame's `regionFrameOffset`. */
  readonly offset: Vec3;
}

const STATE_KEY = '__region';
const ZERO: Readonly<Vec3> = Object.freeze({ x: 0, y: 0, z: 0 });
/** Every state object a `RegionBinder` created, so `view.data` entries can be trusted. */
const states = new WeakSet<object>();

function stateOf(view: EntityView): RegionState | undefined {
  const s = view.data[STATE_KEY];
  return typeof s === 'object' && s !== null && states.has(s) ? (s as RegionState) : undefined;
}

/**
 * The offset `TransformBinder` adds to this frame's sampled `Transform.pos` so that it is local to
 * `view.regionId` (docs/render.md §4.2). Zero except while the render tick is inside an
 * interpolation bracket that spans a migration, or before a migration whose older samples were
 * already evicted. A game binder that writes `view.object.position` from `Transform` itself adds it
 * too, and must run after `RegionBinder`.
 */
export function regionFrameOffset(view: EntityView): Readonly<Vec3> {
  return stateOf(view)?.offset ?? ZERO;
}

/** The last frame of `frames` whose tick is `<= tick`; the first frame for earlier ticks. */
function regionAt(frames: readonly RegionFrame[], tick: number): RegionId {
  for (let i = frames.length - 1; i > 0; i--) {
    const frame = frames[i] as RegionFrame;
    if (frame.tick <= tick) return frame.region;
  }
  return (frames[0] as RegionFrame).region;
}

/** Samples from `tick` on are local to `region`: drops later frames, then appends or rewrites. */
function setRegionFrom(frames: RegionFrame[], tick: number, region: RegionId): void {
  while (frames.length > 1 && (frames[frames.length - 1] as RegionFrame).tick >= tick) {
    frames.pop();
  }
  const last = frames[frames.length - 1] as RegionFrame;
  if (last.tick >= tick) frames[frames.length - 1] = { tick: last.tick, region };
  else if (last.region !== region) frames.push({ tick, region });
}

/** Drops leading frames that no tick `>= bound` falls in. */
function prune(frames: RegionFrame[], bound: number): void {
  let drop = 0;
  while (drop + 1 < frames.length && (frames[drop + 1] as RegionFrame).tick <= bound) drop++;
  if (drop > 0) frames.splice(0, drop);
}

function posOf(ring: SampleRingReader, i: number): Readonly<Vec3> {
  return (ring.at(i).value as Readonly<TransformValue>).pos;
}

/**
 * Keeps each view in the group of the region its entity was in at the render tick
 * (docs/render.md §4.2). `Region` is read at its latest value while `Transform` is sampled at the
 * render tick, which lags the newest snapshot by the interpolation delay, so the binder records
 * from which `Transform` sample tick each observed `Region.id` applies and re-parents the view
 * (Three's `add`) when the render tick reaches that sample. Positions are region-local, so no
 * other math is needed, except while the render tick is between the last sample in the old region
 * and the first in the new one: `regionFrameOffset(view)` then expresses the blended sample in
 * `view.regionId`'s frame, which keeps the world position continuous across the border whatever
 * the floating origin.
 *
 * When several snapshots arrived since the last frame, the first sample in the new region is the
 * one that joins its predecessor most continuously in world space. Register it before
 * `TransformBinder` (`createClient` order), which applies the offset.
 */
export class RegionBinder implements Binder<RegionValue> {
  readonly component = Region;
  /** `Region` as it comes: the binder times the switch itself, against `Transform`'s samples. */
  readonly newest = true;
  private readonly world: RenderWorld;
  /** `Transform`'s id in the replica's registry: `undefined` until looked up, `null` if absent. */
  private transformId: number | null | undefined;

  constructor(world: RenderWorld) {
    this.world = world;
  }

  onAttach(view: EntityView, r: Readonly<RegionValue>): void {
    this.originOf(r.id); // RangeError before any state
    const state: RegionState = {
      frames: [{ tick: -Infinity, region: r.id }],
      seenTick: this.world.replica.latestTick,
      offset: { x: 0, y: 0, z: 0 },
    };
    states.add(state);
    view.data[STATE_KEY] = state;
    this.place(view, r.id);
  }

  onUpdate(view: EntityView, r: Readonly<RegionValue>): void {
    const state = stateOf(view);
    if (state === undefined) {
      this.onAttach(view, r); // view.data was cleared by someone else
      return;
    }
    const pose = this.world.presentationFor(view.id);
    if (pose !== undefined) {
      this.originOf(pose.regionId);
      state.frames.splice(0, state.frames.length, { tick: pose.tick, region: pose.regionId });
      state.offset.x = 0;
      state.offset.y = 0;
      state.offset.z = 0;
      state.seenTick = this.world.replica.latestTick;
      this.place(view, pose.regionId);
      return;
    }
    const frames = state.frames;
    let ring: SampleRingReader | undefined;
    const current = (frames[frames.length - 1] as RegionFrame).region;
    if (r.id !== current) {
      const toOrigin = this.originOf(r.id); // RangeError for an unknown id, state unchanged
      ring = this.transformRing(view);
      const tick =
        ring === undefined || ring.length === 0
          ? -Infinity // no interpolated positions: switch at once
          : this.migrationTick(ring, state.seenTick, this.originOf(current), toOrigin);
      setRegionFrom(frames, tick, r.id);
    }
    state.seenTick = this.world.replica.latestTick;

    if (frames.length > 1) {
      ring ??= this.transformRing(view);
      if (ring === undefined || ring.length === 0) {
        setRegionFrom(frames, -Infinity, r.id);
      } else {
        prune(frames, Math.min(this.world.renderTick, ring.at(0).tick));
        // One frame per sample plus the render tick's: more only piles up behind a stalled clock.
        const max = ring.capacity + 1;
        if (frames.length > max) frames.splice(0, frames.length - max);
      }
    }
    if (frames.length === 1 || ring === undefined || ring.length === 0) {
      const offset = state.offset;
      offset.x = 0;
      offset.y = 0;
      offset.z = 0;
      this.place(view, (frames[0] as RegionFrame).region);
      return;
    }
    this.placeBlended(view, state, ring);
  }

  onDetach(view: EntityView): void {
    if (stateOf(view) !== undefined) delete view.data[STATE_KEY]; // the view stays in its group
  }

  /**
   * Places `view` in the region of the render tick and sets the offset for the samples that
   * `ReplicaWorld.sample` blends there (the same bracket as docs/net.md B.5): with `A`, `B` the
   * bracketing sample ticks, `t` the blend factor and `D` the shown region,
   * `offset = origin(A's region) - origin(D) + (origin(B's region) - origin(A's region)) * t`.
   */
  private placeBlended(view: EntityView, state: RegionState, ring: SampleRingReader): void {
    const frames = state.frames;
    const renderTick = this.world.renderTick;
    const oldest = ring.at(0).tick;
    const newest = ring.at(ring.length - 1).tick;
    let aTick = newest;
    let bTick = newest;
    let t = 0;
    if (renderTick <= oldest) {
      aTick = oldest;
      bTick = oldest;
    } else if (renderTick < newest) {
      const span = ring.bracket(renderTick);
      if (span !== null) {
        aTick = ring.at(span.a).tick;
        bTick = ring.at(span.b).tick;
        if (span.a !== span.b) {
          t = Math.min(Math.max((renderTick - aTick) / (bTick - aTick), 0), 1);
        }
      }
    }
    const shown = regionAt(frames, renderTick);
    const d = this.originOf(shown);
    const a = this.originOf(regionAt(frames, aTick));
    const b = this.originOf(regionAt(frames, bTick));
    const offset = state.offset;
    offset.x = a.x - d.x + (b.x - a.x) * t;
    offset.y = a.y - d.y + (b.y - a.y) * t;
    offset.z = a.z - d.z + (b.z - a.z) * t;
    this.place(view, shown);
  }

  /**
   * Tick of the first `Transform` sample local to the new region, for a `Region.id` change first
   * seen now. A migration writes `Transform` and `Region` in the same tick, so that sample arrived
   * after `seenTick`. With one new sample it is that one; with none (`Region` written alone) the
   * newest sample is reinterpreted from now on. With several, it is the split where the world-space
   * step from the previous sample (old origin) to it (new origin) most shortens the step between
   * their raw local positions: a border crossing turns a jump of about the origin distance into
   * the entity's own motion. Ties go to the newer sample; a split at the oldest sample (nothing
   * before it to compare) scores 0.
   */
  private migrationTick(
    ring: SampleRingReader,
    seenTick: number,
    fromOrigin: Readonly<Vec3>,
    toOrigin: Readonly<Vec3>,
  ): number {
    const n = ring.length;
    let first = n;
    while (first > 0 && ring.at(first - 1).tick > seenTick) first--;
    if (first >= n - 1) return ring.at(n - 1).tick;
    const dx = toOrigin.x - fromOrigin.x;
    const dy = toOrigin.y - fromOrigin.y;
    const dz = toOrigin.z - fromOrigin.z;
    let best = n - 1;
    let bestGain = -Infinity;
    for (let k = first; k < n; k++) {
      let gain = 0;
      if (k > 0) {
        const p = posOf(ring, k);
        const q = posOf(ring, k - 1);
        const ex = p.x - q.x;
        const ey = p.y - q.y;
        const ez = p.z - q.z;
        gain = Math.hypot(ex, ey, ez) - Math.hypot(ex + dx, ey + dy, ez + dz);
      }
      if (gain >= bestGain) {
        bestGain = gain;
        best = k;
      }
    }
    return ring.at(best).tick;
  }

  private transformRing(view: EntityView): SampleRingReader | undefined {
    const replica = this.world.replica;
    if (this.transformId === undefined) {
      try {
        this.transformId = replica.registry.componentId(Transform);
      } catch {
        this.transformId = null; // a registry without Transform: nothing is interpolated
      }
    }
    if (this.transformId === null) return undefined;
    const ring = replica.get(view.id)?.samples.get(this.transformId);
    if (ring === undefined) return undefined;
    // Positions all the way through, or none to go by: a Transform removed while its samples last.
    for (let i = 0; i < ring.length; i++) if (ring.at(i).value === REMOVED) return undefined;
    return ring;
  }

  private place(view: EntityView, id: RegionId): void {
    const group = this.world.regionGroup(id);
    if (view.object.parent !== group) group.add(view.object);
    view.regionId = id;
  }

  private originOf(id: RegionId): Readonly<Vec3> {
    const def = this.world.graph.get(id);
    if (def === undefined) throw new RangeError(`RegionBinder: unknown region ${id}`);
    return def.bounds.origin;
  }
}
