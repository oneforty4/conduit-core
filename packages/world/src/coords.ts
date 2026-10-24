import { v3, type Vec3 } from '@conduit/math';
import type { RegionDef } from './types.ts';

/**
 * Region-local coordinates (docs/world.md §4). `Transform.pos` is relative to the
 * `bounds.origin` of the entity's region. Every function taking `out` writes into it and returns
 * it (allocating when omitted); `out` may alias any input.
 */

/** Gap kept below `max` by `clampToBounds`, in metres. */
export const CLAMP_EPS = 1e-3;

/** World position of the region-local position `local`: `origin + local`. */
export function toWorld(def: RegionDef, local: Vec3, out?: Vec3): Vec3 {
  return v3.add(def.bounds.origin, local, out);
}

/** Region-local position of the world position `world`: `world - origin`. */
export function toLocal(def: RegionDef, world: Vec3, out?: Vec3): Vec3 {
  return v3.sub(world, def.bounds.origin, out);
}

/**
 * Re-expresses `pos`, local to `from`, as local to `to`: `pos + (from.origin - to.origin)`. The
 * world position is unchanged, which is what keeps migration continuous across a border.
 */
export function rebase(from: RegionDef, to: RegionDef, pos: Vec3, out?: Vec3): Vec3 {
  const a = from.bounds.origin;
  const b = to.bounds.origin;
  const x = pos.x + (a.x - b.x);
  const y = pos.y + (a.y - b.y);
  const z = pos.z + (a.z - b.z);
  return out === undefined ? { x, y, z } : v3.set(out, x, y, z);
}

/**
 * Whether region-local `local` lies inside the region: always for `node`; otherwise the half-open
 * test `min <= p < max` on each bounded axis (`NaN` is outside).
 */
export function contains(def: RegionDef, local: Vec3): boolean {
  const b = def.bounds;
  switch (b.kind) {
    case 'node':
      return true;
    case 'aabb2': {
      const v = b.plane === 'xz' ? local.z : local.y;
      return b.min.x <= local.x && local.x < b.max.x && b.min.y <= v && v < b.max.y;
    }
    case 'aabb3':
      return (
        b.min.x <= local.x &&
        local.x < b.max.x &&
        b.min.y <= local.y &&
        local.y < b.max.y &&
        b.min.z <= local.z &&
        local.z < b.max.z
      );
  }
}

/** `v` clamped to `[lo, max(lo, hi - CLAMP_EPS)]`; `NaN` clamps to `lo`. */
function clampAxis(v: number, lo: number, hi: number): number {
  const top = Math.max(lo, hi - CLAMP_EPS);
  return v > top ? top : v >= lo ? v : lo;
}

/**
 * Clamps the bounded axes of region-local `local` to `[min, max - CLAMP_EPS]`, so the result is
 * contained (`contains` is true) for any non-empty bounds. Unbounded axes, and every axis of a
 * `node` region, are copied unchanged.
 */
export function clampToBounds(def: RegionDef, local: Vec3, out?: Vec3): Vec3 {
  const b = def.bounds;
  let x = local.x;
  let y = local.y;
  let z = local.z;
  switch (b.kind) {
    case 'aabb2':
      x = clampAxis(x, b.min.x, b.max.x);
      if (b.plane === 'xz') z = clampAxis(z, b.min.y, b.max.y);
      else y = clampAxis(y, b.min.y, b.max.y);
      break;
    case 'aabb3':
      x = clampAxis(x, b.min.x, b.max.x);
      y = clampAxis(y, b.min.y, b.max.y);
      z = clampAxis(z, b.min.z, b.max.z);
      break;
    case 'node':
      break;
  }
  return out === undefined ? { x, y, z } : v3.set(out, x, y, z);
}
