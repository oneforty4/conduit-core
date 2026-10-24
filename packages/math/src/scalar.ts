/** Tolerance used by `normalize`, `equals` and the slerp fallback (docs/sim.md 1.3). */
export const EPS = 1e-6;
export const PI = Math.PI;
export const TAU = 2 * Math.PI;
export const HALF_PI = Math.PI / 2;

/** `min(max(x, lo), hi)`. */
export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

/** `a + (b - a) * t`; `t` is not clamped. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Wraps an angle in radians into `(-PI, PI]`. */
export function wrapAngle(a: number): number {
  let r = a - TAU * Math.floor((a + PI) / TAU); // r in [-PI, PI)
  if (r === -PI) r = PI; // move the boundary so the range is (-PI, PI]
  return r;
}

/** Interpolates from `a` towards `b` along the shortest arc. The result is not wrapped. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}
