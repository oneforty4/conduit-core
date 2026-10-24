import type { Quat } from '@conduit/math';
import { QUAT_COMPONENT_MAX, QUAT_SCALE, TAU } from './constants.ts';
import { EncodeError } from './errors.ts';

function quantize10(v: number): number {
  const clamped =
    v < -QUAT_COMPONENT_MAX ? -QUAT_COMPONENT_MAX : v > QUAT_COMPONENT_MAX ? QUAT_COMPONENT_MAX : v;
  const s = Math.round(clamped * QUAT_SCALE);
  return (s < -511 ? -511 : s > 511 ? 511 : s) & 0x3ff;
}

function sext10(u: number): number {
  return u >= 512 ? u - 1024 : u;
}

/**
 * Smallest-three packing of a rotation into a u32 (docs/protocol.md 4.3): bits 31-30 hold the index
 * of the dropped (largest-magnitude, made non-negative) component, then three signed 10-bit values.
 * A zero, NaN or infinite quaternion packs as identity; `q` and `-q` pack identically.
 */
export function packQuat(q: Quat): number {
  let x = q.x;
  let y = q.y;
  let z = q.z;
  let w = q.w;
  const len = Math.sqrt(x * x + y * y + z * z + w * w);
  if (!(len > 0 && len < Infinity)) {
    x = 0;
    y = 0;
    z = 0;
    w = 1;
  } else if (Math.abs(len - 1) > 1e-6) {
    x /= len;
    y /= len;
    z /= len;
    w /= len;
  }
  // index of the largest magnitude; ties go to the lowest index
  let i = 0;
  let best = Math.abs(x);
  if (Math.abs(y) > best) {
    i = 1;
    best = Math.abs(y);
  }
  if (Math.abs(z) > best) {
    i = 2;
    best = Math.abs(z);
  }
  if (Math.abs(w) > best) i = 3;
  const dropped = i === 0 ? x : i === 1 ? y : i === 2 ? z : w;
  if (dropped < 0) {
    x = -x;
    y = -y;
    z = -z;
    w = -w;
  }
  // the three kept components, in ascending index order
  const s0 = i === 0 ? y : x;
  const s1 = i <= 1 ? z : y;
  const s2 = i <= 2 ? w : z;
  return ((i << 30) | (quantize10(s0) << 20) | (quantize10(s1) << 10) | quantize10(s2)) >>> 0;
}

/** Inverse of `packQuat`, written into `out`. Accepts `-512` in any 10-bit field. */
export function unpackQuat(u32: number, out: Quat): Quat {
  const p = u32 >>> 0;
  const i = p >>> 30;
  const v0 = sext10((p >>> 20) & 0x3ff) / QUAT_SCALE;
  const v1 = sext10((p >>> 10) & 0x3ff) / QUAT_SCALE;
  const v2 = sext10(p & 0x3ff) / QUAT_SCALE;
  const dropped = Math.sqrt(Math.max(0, 1 - v0 * v0 - v1 * v1 - v2 * v2));
  switch (i) {
    case 0:
      out.x = dropped;
      out.y = v0;
      out.z = v1;
      out.w = v2;
      break;
    case 1:
      out.x = v0;
      out.y = dropped;
      out.z = v1;
      out.w = v2;
      break;
    case 2:
      out.x = v0;
      out.y = v1;
      out.z = dropped;
      out.w = v2;
      break;
    default:
      out.x = v0;
      out.y = v1;
      out.z = v2;
      out.w = dropped;
  }
  return out;
}

/**
 * Radians to u16 turns: `Math.round(frac(rad / TAU) * 65536) & 0xFFFF`. NaN and +-Infinity throw
 * `EncodeError('nan')`.
 */
export function encodeAngle16(rad: number): number {
  if (!Number.isFinite(rad)) throw new EncodeError('nan', `angle16: ${String(rad)} is not finite`);
  const x = rad / TAU;
  const frac = ((x % 1) + 1) % 1;
  return Math.round(frac * 65536) & 0xffff;
}

/** u16 turns to radians in `[0, TAU)`. */
export function decodeAngle16(u16: number): number {
  return (u16 * TAU) / 65536;
}

/**
 * `clamp(Math.round(v / scale), min, max)`, the integer step of `fixed16`/`fixed32`. NaN throws
 * `EncodeError('nan')`; +-Infinity clamps.
 */
export function quantize(v: number, scale: number, min: number, max: number): number {
  if (Number.isNaN(v)) throw new EncodeError('nan', 'cannot quantize NaN');
  const q = Math.round(v / scale);
  return q < min ? min : q > max ? max : q;
}
