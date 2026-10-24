import { EPS } from './scalar.ts';
import type { Vec3 } from './vec3.ts';

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

function write(out: Quat | undefined, x: number, y: number, z: number, w: number): Quat {
  if (out === undefined) return { x, y, z, w };
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}

function normalized(out: Quat | undefined, x: number, y: number, z: number, w: number): Quat {
  const len = Math.sqrt(x * x + y * y + z * z + w * w);
  if (len < EPS) return write(out, 0, 0, 0, 1);
  return write(out, x / len, y / len, z / len, w / len);
}

/**
 * Quaternion functions (`{x, y, z, w}`, w last). Every quaternion-producing function takes a
 * trailing `out`: when given, the result is written into it and returned; when omitted a new object
 * is allocated. `out` may alias any input (docs/sim.md 1.2, 1.6).
 */
export const q = {
  /** `(0, 0, 0, 1)`. */
  identity(out?: Quat): Quat {
    return write(out, 0, 0, 0, 1);
  },
  create(x = 0, y = 0, z = 0, w = 1): Quat {
    return { x, y, z, w };
  },
  copy(a: Quat, out?: Quat): Quat {
    return write(out, a.x, a.y, a.z, a.w);
  },
  set(out: Quat, x: number, y: number, z: number, w: number): Quat {
    out.x = x;
    out.y = y;
    out.z = z;
    out.w = w;
    return out;
  },
  dot(a: Quat, b: Quat): number {
    return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  },
  length(a: Quat): number {
    return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z + a.w * a.w);
  },
  /** Unit quaternion along `a`; a quaternion shorter than `EPS` normalizes to identity. */
  normalize(a: Quat, out?: Quat): Quat {
    return normalized(out, a.x, a.y, a.z, a.w);
  },
  /** `(-x, -y, -z, w)`; the inverse of a unit quaternion. */
  conjugate(a: Quat, out?: Quat): Quat {
    return write(out, -a.x, -a.y, -a.z, a.w);
  },
  /** Hamilton product `a*b`: rotating by the result applies `b` first, then `a`. */
  multiply(a: Quat, b: Quat, out?: Quat): Quat {
    const ax = a.x;
    const ay = a.y;
    const az = a.z;
    const aw = a.w;
    const bx = b.x;
    const by = b.y;
    const bz = b.z;
    const bw = b.w;
    return write(
      out,
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz,
    );
  },
  /**
   * Spherical interpolation along the shortest arc (`b` is negated when `dot(a, b) < 0`). Falls back
   * to normalized lerp when the arc is shorter than `acos(1 - EPS)`.
   */
  slerp(a: Quat, b: Quat, t: number, out?: Quat): Quat {
    const ax = a.x;
    const ay = a.y;
    const az = a.z;
    const aw = a.w;
    let bx = b.x;
    let by = b.y;
    let bz = b.z;
    let bw = b.w;
    let d = ax * bx + ay * by + az * bz + aw * bw;
    if (d < 0) {
      d = -d;
      bx = -bx;
      by = -by;
      bz = -bz;
      bw = -bw;
    }
    if (d > 1 - EPS) {
      return normalized(
        out,
        ax + (bx - ax) * t,
        ay + (by - ay) * t,
        az + (bz - az) * t,
        aw + (bw - aw) * t,
      );
    }
    const th = Math.acos(d);
    const s = Math.sin(th);
    const ka = Math.sin((1 - t) * th) / s;
    const kb = Math.sin(t * th) / s;
    return write(out, ax * ka + bx * kb, ay * ka + by * kb, az * ka + bz * kb, aw * ka + bw * kb);
  },
  /** Rotation of `rad` radians about `axis`, which must be unit length. */
  fromAxisAngle(axis: Vec3, rad: number, out?: Quat): Quat {
    const s = Math.sin(rad / 2);
    return write(out, axis.x * s, axis.y * s, axis.z * s, Math.cos(rad / 2));
  },
  /**
   * Intrinsic YXZ Euler angles: yaw about +Y, then pitch about +X, then roll about +Z. Closed form of
   * `multiply(multiply(qY(yaw), qX(pitch)), qZ(roll))`; matches Three.js `Euler` order `'YXZ'`.
   */
  fromEuler(yaw: number, pitch: number, roll: number, out?: Quat): Quat {
    const cy = Math.cos(yaw / 2);
    const sy = Math.sin(yaw / 2);
    const cp = Math.cos(pitch / 2);
    const sp = Math.sin(pitch / 2);
    const cr = Math.cos(roll / 2);
    const sr = Math.sin(roll / 2);
    return write(
      out,
      cy * sp * cr + sy * cp * sr,
      sy * cp * cr - cy * sp * sr,
      cy * cp * sr - sy * sp * cr,
      cy * cp * cr + sy * sp * sr,
    );
  },
  /** Rotates `v` by the unit quaternion `r`. */
  rotateVec3(r: Quat, v: Vec3, out?: Vec3): Vec3 {
    const qx = r.x;
    const qy = r.y;
    const qz = r.z;
    const qw = r.w;
    const vx = v.x;
    const vy = v.y;
    const vz = v.z;
    // t = 2 * cross(r.xyz, v)
    const tx = 2 * (qy * vz - qz * vy);
    const ty = 2 * (qz * vx - qx * vz);
    const tz = 2 * (qx * vy - qy * vx);
    // out = v + w * t + cross(r.xyz, t)
    const x = vx + qw * tx + (qy * tz - qz * ty);
    const y = vy + qw * ty + (qz * tx - qx * tz);
    const z = vz + qw * tz + (qx * ty - qy * tx);
    if (out === undefined) return { x, y, z };
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
  },
  /** True when `a` and `b` represent the same rotation: `|dot(a, b)| >= 1 - eps`. */
  equals(a: Quat, b: Quat, eps = EPS): boolean {
    return Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w) >= 1 - eps;
  },
};
