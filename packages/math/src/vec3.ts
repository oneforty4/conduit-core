import { EPS } from './scalar.ts';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

function write(out: Vec3 | undefined, x: number, y: number, z: number): Vec3 {
  if (out === undefined) return { x, y, z };
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

/**
 * 3D vector functions. Every vector-producing function takes a trailing `out`: when given, the
 * result is written into it and returned; when omitted a new object is allocated. `out` may alias
 * any input (docs/sim.md 1.2).
 */
export const v3 = {
  create(x = 0, y = 0, z = 0): Vec3 {
    return { x, y, z };
  },
  copy(a: Vec3, out?: Vec3): Vec3 {
    return write(out, a.x, a.y, a.z);
  },
  set(out: Vec3, x: number, y: number, z: number): Vec3 {
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
  },
  add(a: Vec3, b: Vec3, out?: Vec3): Vec3 {
    return write(out, a.x + b.x, a.y + b.y, a.z + b.z);
  },
  sub(a: Vec3, b: Vec3, out?: Vec3): Vec3 {
    return write(out, a.x - b.x, a.y - b.y, a.z - b.z);
  },
  scale(a: Vec3, s: number, out?: Vec3): Vec3 {
    return write(out, a.x * s, a.y * s, a.z * s);
  },
  dot(a: Vec3, b: Vec3): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  },
  /** `(a.y*b.z - a.z*b.y, a.z*b.x - a.x*b.z, a.x*b.y - a.y*b.x)`. */
  cross(a: Vec3, b: Vec3, out?: Vec3): Vec3 {
    return write(out, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  },
  length(a: Vec3): number {
    return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  },
  lengthSq(a: Vec3): number {
    return a.x * a.x + a.y * a.y + a.z * a.z;
  },
  /** Unit vector along `a`; a vector shorter than `EPS` normalizes to `(0,0,0)`. */
  normalize(a: Vec3, out?: Vec3): Vec3 {
    const len = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    if (len < EPS) return write(out, 0, 0, 0);
    return write(out, a.x / len, a.y / len, a.z / len);
  },
  /** `a + (b - a) * t`; `t` is not clamped. */
  lerp(a: Vec3, b: Vec3, t: number, out?: Vec3): Vec3 {
    return write(out, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
  },
  distance(a: Vec3, b: Vec3): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  },
  distanceSq(a: Vec3, b: Vec3): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return dx * dx + dy * dy + dz * dz;
  },
  /** Component-wise `|a - b| <= eps`. */
  equals(a: Vec3, b: Vec3, eps = EPS): boolean {
    return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps && Math.abs(a.z - b.z) <= eps;
  },
};
