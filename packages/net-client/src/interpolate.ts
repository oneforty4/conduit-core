import type { ComponentLike, FieldType } from '@conduit/protocol';
import type { SampleRingReader } from './sample-ring.ts';

/** The session rates interpolation needs. */
export interface SampleTiming {
  readonly tickRate: number;
  readonly snapshotEvery: number;
  readonly extrapolation?:
    { readonly horizonMs: number; readonly onLimit?: 'hold' | 'reset' } | undefined;
}

/**
 * What a component's samples hold for the tick it was removed (`ReplicaWorld`, docs/net.md B.5): it
 * is not there from then on, until a later sample brings it back.
 */
export const REMOVED: unique symbol = Symbol('removed');

/**
 * The value of a component in effect at `tick`, from its samples (docs/net.md B.5): the sample at
 * or before it, or undefined if the component was not there then -- removed, or not come yet.
 * Before the oldest sample it had not come, unless older samples were let go
 * (`SampleRing.complete`): then the oldest is the nearest known.
 */
export function valueAt(ring: SampleRingReader, tick: number): unknown {
  const i = ring.indexAtOrBefore(tick);
  const s = i >= 0 ? ring.at(i) : ring.complete ? undefined : ring.oldest();
  return s === undefined || s.value === REMOVED ? undefined : s.value;
}

type Fields = Record<string, unknown>;
type Vec = { x: number; y: number; z?: number };

function fieldOf(def: ComponentLike<unknown>, name: string): FieldType<unknown> | undefined {
  return def.schema.fields[name];
}

/**
 * The value of one component at fractional `renderTick` (docs/net.md B.5 `sample`), written into
 * `out` and returned. Without samples, `latest` is copied. Before the oldest sample the oldest is
 * copied; from the newest on -- or from the last before the component was removed (`REMOVED`) --
 * `extrapolateComponent` runs; in between, the bracketing samples are blended: every field is
 * copied from the earlier sample, then each `interpolate` field whose kind has a `lerp` is
 * interpolated. A render tick at which the component was not there gets `latest`: the caller says
 * whether it is (`valueAt`). Pure apart from writing `out`.
 */
export function sampleComponent<T>(
  def: ComponentLike<T>,
  ring: SampleRingReader | undefined,
  latest: T,
  renderTick: number,
  out: T,
  timing: SampleTiming,
): T {
  const schema = def.schema;
  if (ring === undefined || ring.length === 0) return schema.copy(latest, out);
  // The sample at or before the render tick (the oldest, before them all), and the one after it.
  const i = Math.max(0, ring.indexAtOrBefore(renderTick));
  const A = ring.at(i);
  if (A.value === REMOVED) return schema.copy(latest, out);
  const aValue = A.value as T;
  if (renderTick <= A.tick) return schema.copy(aValue, out);
  const B = i + 1 < ring.length ? ring.at(i + 1) : undefined;
  if (B === undefined || B.value === REMOVED) {
    return extrapolateComponent(def, A.tick, aValue, renderTick, out, timing);
  }
  const bValue = B.value as T;
  const t = Math.min(Math.max((renderTick - A.tick) / (B.tick - A.tick), 0), 1);
  schema.copy(aValue, out);
  const o = out as Fields;
  const a = aValue as Fields;
  const b = bValue as Fields;
  for (const name of def.interpolate) {
    const ft = fieldOf(def as ComponentLike<unknown>, name);
    if (ft?.lerp !== undefined) o[name] = ft.lerp(a[name], b[name], t, o[name]);
  }
  return out;
}

/**
 * `newest` advanced to `renderTick` (docs/net.md B.5 `extrapolate`): copied into `out`, then, when
 * the component has `extrapolateWith`, every `interpolate` field of the velocity field's kind
 * (`vec2` or `vec3`) moves by `vel × dt` with `dt` capped at one snapshot interval, after which the
 * value holds.
 */
export function extrapolateComponent<T>(
  def: ComponentLike<T>,
  newestTick: number,
  newest: T,
  renderTick: number,
  out: T,
  timing: SampleTiming,
): T {
  def.schema.copy(newest, out);
  const velName = def.extrapolateWith;
  if (velName === undefined) return out;
  const vt = fieldOf(def as ComponentLike<unknown>, velName);
  if (vt === undefined || (vt.kind !== 'vec2' && vt.kind !== 'vec3')) return out;
  const horizon =
    timing.extrapolation?.horizonMs === undefined
      ? timing.snapshotEvery
      : (timing.extrapolation.horizonMs * timing.tickRate) / 1000;
  if (!Number.isFinite(horizon) || horizon < 0)
    throw new RangeError('Extrapolation horizon must be finite and nonnegative');
  const elapsed = Math.max(renderTick - newestTick, 0);
  if (elapsed > horizon && timing.extrapolation?.onLimit === 'reset') return out;
  const dtTicks = Math.min(elapsed, horizon);
  if (dtTicks === 0) return out;
  const dtSec = dtTicks / timing.tickRate;
  const src = newest as Fields;
  const vel = src[velName] as Vec;
  const o = out as Fields;
  for (const name of def.interpolate) {
    const ft = fieldOf(def as ComponentLike<unknown>, name);
    if (ft === undefined || ft.kind !== vt.kind) continue;
    const p = src[name] as Vec;
    const target = o[name] as Vec;
    target.x = p.x + vel.x * dtSec;
    target.y = p.y + vel.y * dtSec;
    if (vt.kind === 'vec3') target.z = (p.z as number) + (vel.z as number) * dtSec;
  }
  return out;
}
