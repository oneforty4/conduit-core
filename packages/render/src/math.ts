import type { Quat, Vec3 } from '@conduit/math';
import { Quaternion, Vector3 } from 'three';

/**
 * Conversions between `@conduit/math` plain objects and Three types (docs/render.md §1). They live
 * here, never in `@conduit/math`, so nothing else imports `three`. Every function writes into `out`
 * when given (hot paths always pass it) and allocates otherwise.
 */

export function toThreeVec3(v: Readonly<Vec3>, out: Vector3 = new Vector3()): Vector3 {
  return out.set(v.x, v.y, v.z);
}

export function toThreeQuat(q: Readonly<Quat>, out: Quaternion = new Quaternion()): Quaternion {
  return out.set(q.x, q.y, q.z, q.w);
}

export function fromThreeVec3(v: Vector3, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  out.x = v.x;
  out.y = v.y;
  out.z = v.z;
  return out;
}

export function fromThreeQuat(q: Quaternion, out: Quat = { x: 0, y: 0, z: 0, w: 1 }): Quat {
  out.x = q.x;
  out.y = q.y;
  out.z = q.z;
  out.w = q.w;
  return out;
}
