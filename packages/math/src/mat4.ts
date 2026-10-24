import type { Quat } from './quat.ts';
import { EPS } from './scalar.ts';
import type { Vec3 } from './vec3.ts';

/**
 * Decomposes a column-major 4x4 affine matrix (glTF `node.matrix` layout) into translation,
 * rotation and scale (docs/sim.md 1.8). `outS` holds the column lengths, with x negated when the
 * 3x3 determinant is negative; `outR` is the normalized rotation of the 3x3 with its columns divided
 * by `outS`. If any column is shorter than `EPS` the rotation is undefined and `outR` is identity.
 */
export function decomposeMat4(m: ArrayLike<number>, outT: Vec3, outR: Quat, outS: Vec3): void {
  if (m.length < 16) throw new RangeError(`decomposeMat4: expected 16 elements, got ${m.length}`);
  const m0 = m[0] ?? 0;
  const m1 = m[1] ?? 0;
  const m2 = m[2] ?? 0;
  const m4 = m[4] ?? 0;
  const m5 = m[5] ?? 0;
  const m6 = m[6] ?? 0;
  const m8 = m[8] ?? 0;
  const m9 = m[9] ?? 0;
  const m10 = m[10] ?? 0;

  outT.x = m[12] ?? 0;
  outT.y = m[13] ?? 0;
  outT.z = m[14] ?? 0;

  let sx = Math.sqrt(m0 * m0 + m1 * m1 + m2 * m2);
  const sy = Math.sqrt(m4 * m4 + m5 * m5 + m6 * m6);
  const sz = Math.sqrt(m8 * m8 + m9 * m9 + m10 * m10);
  // det = col0 . (col1 x col2)
  const det = m0 * (m5 * m10 - m6 * m9) + m1 * (m6 * m8 - m4 * m10) + m2 * (m4 * m9 - m5 * m8);
  if (det < 0) sx = -sx;
  outS.x = sx;
  outS.y = sy;
  outS.z = sz;

  if (!(Math.abs(sx) >= EPS && sy >= EPS && sz >= EPS)) {
    outR.x = 0;
    outR.y = 0;
    outR.z = 0;
    outR.w = 1;
    return;
  }

  // Rotation matrix entries r<row><col>; column c of the matrix is divided by its scale.
  const r00 = m0 / sx;
  const r10 = m1 / sx;
  const r20 = m2 / sx;
  const r01 = m4 / sy;
  const r11 = m5 / sy;
  const r21 = m6 / sy;
  const r02 = m8 / sz;
  const r12 = m9 / sz;
  const r22 = m10 / sz;

  let x: number;
  let y: number;
  let z: number;
  let w: number;
  const trace = r00 + r11 + r22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s;
    x = (r21 - r12) * s;
    y = (r02 - r20) * s;
    z = (r10 - r01) * s;
  } else if (r00 > r11 && r00 > r22) {
    const s = 2 * Math.sqrt(1 + r00 - r11 - r22);
    w = (r21 - r12) / s;
    x = 0.25 * s;
    y = (r10 + r01) / s;
    z = (r02 + r20) / s;
  } else if (r11 > r22) {
    const s = 2 * Math.sqrt(1 + r11 - r00 - r22);
    w = (r02 - r20) / s;
    x = (r10 + r01) / s;
    y = 0.25 * s;
    z = (r21 + r12) / s;
  } else {
    const s = 2 * Math.sqrt(1 + r22 - r00 - r11);
    w = (r10 - r01) / s;
    x = (r02 + r20) / s;
    y = (r21 + r12) / s;
    z = 0.25 * s;
  }

  const len = Math.sqrt(x * x + y * y + z * z + w * w);
  if (!(len >= EPS && len < Infinity)) {
    outR.x = 0;
    outR.y = 0;
    outR.z = 0;
    outR.w = 1;
    return;
  }
  outR.x = x / len;
  outR.y = y / len;
  outR.z = z / len;
  outR.w = w / len;
}
