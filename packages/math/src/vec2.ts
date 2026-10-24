import { EPS } from './scalar.ts';

export interface Vec2 {
  x: number;
  y: number;
}

function write(out: Vec2 | undefined, x: number, y: number): Vec2 {
  if (out === undefined) return { x, y };
  out.x = x;
  out.y = y;
  return out;
}

/**
 * 2D vector functions. Every vector-producing function takes a trailing `out`: when given, the
 * result is written into it and returned; when omitted a new object is allocated. `out` may alias
 * any input (docs/sim.md 1.2).
 */
export const v2 = {
  create(x = 0, y = 0): Vec2 {
    return { x, y };
  },
  copy(a: Vec2, out?: Vec2): Vec2 {
    return write(out, a.x, a.y);
  },
  set(out: Vec2, x: number, y: number): Vec2 {
    out.x = x;
    out.y = y;
    return out;
  },
  add(a: Vec2, b: Vec2, out?: Vec2): Vec2 {
    return write(out, a.x + b.x, a.y + b.y);
  },
  sub(a: Vec2, b: Vec2, out?: Vec2): Vec2 {
    return write(out, a.x - b.x, a.y - b.y);
  },
  scale(a: Vec2, s: number, out?: Vec2): Vec2 {
    return write(out, a.x * s, a.y * s);
  },
  dot(a: Vec2, b: Vec2): number {
    return a.x * b.x + a.y * b.y;
  },
  /** Scalar z of the 3D cross product: `a.x*b.y - a.y*b.x`. */
  cross(a: Vec2, b: Vec2): number {
    return a.x * b.y - a.y * b.x;
  },
  length(a: Vec2): number {
    return Math.sqrt(a.x * a.x + a.y * a.y);
  },
  lengthSq(a: Vec2): number {
    return a.x * a.x + a.y * a.y;
  },
  /** Unit vector along `a`; a vector shorter than `EPS` normalizes to `(0,0)`. */
  normalize(a: Vec2, out?: Vec2): Vec2 {
    const len = Math.sqrt(a.x * a.x + a.y * a.y);
    if (len < EPS) return write(out, 0, 0);
    return write(out, a.x / len, a.y / len);
  },
  /** `a + (b - a) * t`; `t` is not clamped. */
  lerp(a: Vec2, b: Vec2, t: number, out?: Vec2): Vec2 {
    return write(out, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
  },
  distance(a: Vec2, b: Vec2): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  },
  distanceSq(a: Vec2, b: Vec2): number {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
  },
  /** Component-wise `|a - b| <= eps`. */
  equals(a: Vec2, b: Vec2, eps = EPS): boolean {
    return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
  },
};
