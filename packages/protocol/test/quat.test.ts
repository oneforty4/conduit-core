import { q, Rng, type Quat } from '@conduit/math';
import { describe, expect, it } from 'vitest';
import {
  ByteReader,
  ByteWriter,
  f,
  packQuat,
  QUAT_COMPONENT_MAX,
  QUAT_SCALE,
  unpackQuat,
} from '../src/index.ts';

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

function randomUnitQuat(rng: Rng): Quat {
  for (;;) {
    const r = q.create(
      rng.float() * 2 - 1,
      rng.float() * 2 - 1,
      rng.float() * 2 - 1,
      rng.float() * 2 - 1,
    );
    if (q.length(r) > 0.1) return q.normalize(r);
  }
}

function neg(a: Quat): Quat {
  return { x: -a.x, y: -a.y, z: -a.z, w: -a.w };
}

describe('constants', () => {
  it('QUAT_SCALE is 511 * sqrt(2) and QUAT_COMPONENT_MAX is sqrt(1/2)', () => {
    expect(QUAT_SCALE).toBe(511 * Math.SQRT2);
    expect(QUAT_SCALE).toBeCloseTo(722.6631, 4);
    expect(QUAT_COMPONENT_MAX).toBe(Math.SQRT1_2);
  });
});

describe('smallest-three quaternion packing', () => {
  it('round-trips random unit quaternions with |dot| > 0.9999', () => {
    const rng = new Rng(20240917);
    const out = q.create();
    let worst = 1;
    for (let i = 0; i < 10_000; i++) {
      const a = randomUnitQuat(rng);
      unpackQuat(packQuat(a), out);
      worst = Math.min(worst, Math.abs(q.dot(a, out)));
    }
    expect(worst).toBeGreaterThan(0.9999);
  });

  it('per-component round-trip error is at most 1 / (2 * QUAT_SCALE) plus the dropped-term error', () => {
    const rng = new Rng(77);
    const out = q.create();
    for (let i = 0; i < 1000; i++) {
      const a = randomUnitQuat(rng);
      unpackQuat(packQuat(a), out);
      const b = q.dot(a, out) < 0 ? neg(out) : out;
      expect(Math.abs(a.x - b.x)).toBeLessThan(0.003);
      expect(Math.abs(a.y - b.y)).toBeLessThan(0.003);
      expect(Math.abs(a.z - b.z)).toBeLessThan(0.003);
      expect(Math.abs(a.w - b.w)).toBeLessThan(0.003);
    }
  });

  it('q and -q encode to the same u32', () => {
    const rng = new Rng(3);
    let differ = 0;
    for (let i = 0; i < 10_000; i++) {
      const a = randomUnitQuat(rng);
      if (packQuat(a) !== packQuat(neg(a))) differ++;
    }
    expect(differ).toBe(0);
  });

  it('covers each of the four dropped-index cases', () => {
    const cases: [Quat, number][] = [
      [q.normalize({ x: -0.9, y: 0.2, z: 0.3, w: 0.1 }), 0],
      [q.normalize({ x: 0.2, y: 0.9, z: -0.3, w: 0.1 }), 1],
      [q.normalize({ x: 0.1, y: -0.2, z: -0.95, w: 0.2 }), 2],
      [q.normalize({ x: 0.3, y: 0.2, z: 0.1, w: -0.9 }), 3],
    ];
    for (const [a, index] of cases) {
      const packed = packQuat(a);
      expect(packed >>> 30).toBe(index);
      const b = unpackQuat(packed, q.create());
      expect(Math.abs(q.dot(a, b))).toBeGreaterThan(0.9999);
      const dropped = [b.x, b.y, b.z, b.w][index] as number;
      expect(dropped).toBeGreaterThan(0); // the dropped component is reconstructed non-negative
    }
  });

  it('has the exact bit layout for a hand-computed quaternion (dropped index 3)', () => {
    // q = (0.1, -0.2, 0.3, sqrt(0.86)); |q| = 1; w is the largest and positive, so i = 3.
    // s = round(v * 722.6631...): 0.1 -> 72.27 -> 72; -0.2 -> -144.53 -> -145; 0.3 -> 216.80 -> 217
    // 10-bit fields: 72 = 0x048; -145 -> 1024 - 145 = 879 = 0x36F; 217 = 0x0D9
    // packed = (3 << 30) | (0x048 << 20) | (0x36F << 10) | 0x0D9
    //        = 0xC0000000 | 0x04800000 | 0x000DBC00 | 0x000000D9 = 0xC48DBCD9
    const a = { x: 0.1, y: -0.2, z: 0.3, w: Math.sqrt(0.86) };
    expect(packQuat(a)).toBe(0xc48dbcd9);
    expect(packQuat(neg(a))).toBe(0xc48dbcd9);
    // A non-unit input is normalized first.
    expect(packQuat({ x: 0.2, y: -0.4, z: 0.6, w: 2 * Math.sqrt(0.86) })).toBe(0xc48dbcd9);
    // On the wire: u32 little-endian.
    const w = new ByteWriter();
    f.quat().encode(w, a);
    expect(hex(w.view())).toBe('d9 bc 8d c4');
  });

  it('has the exact bit layout for a hand-computed quaternion (dropped index 0, sign flip)', () => {
    // q = (-0.8, 0.36, 0.48, 0): |x| is largest and negative, so c = -q = (0.8, -0.36, -0.48, -0)
    // s: -0.36 -> -260.16 -> -260 -> 764 = 0x2FC; -0.48 -> -346.88 -> -347 -> 677 = 0x2A5; -0 -> 0
    // packed = (0 << 30) | (0x2FC << 20) | (0x2A5 << 10) | 0 = 0x2FC00000 | 0x000A9400 = 0x2FCA9400
    const a = { x: -0.8, y: 0.36, z: 0.48, w: 0 };
    expect(packQuat(a)).toBe(0x2fca9400);
    const w = new ByteWriter();
    f.quat().encode(w, a);
    expect(hex(w.view())).toBe('00 94 ca 2f');
    const b = f.quat().decode(new ByteReader(w.view()));
    expect(b.x).toBeCloseTo(0.8, 3);
    expect(b.y).toBeCloseTo(-260 / QUAT_SCALE, 12);
    expect(b.z).toBeCloseTo(-347 / QUAT_SCALE, 12);
    expect(b.w).toBe(0);
    expect(q.equals(a, b, 1e-4)).toBe(true);
  });

  it('breaks ties toward the lowest index', () => {
    // all |c| = 0.5: i = 0; round(0.5 * 722.66) = 361 = 0x169
    // (0x169 << 20) | (0x169 << 10) | 0x169 = 0x16900000 | 0x0005A400 | 0x169 = 0x1695A569
    expect(packQuat({ x: 0.5, y: 0.5, z: 0.5, w: 0.5 })).toBe(0x1695a569);
    // x negative: flip to (0.5, -0.5, -0.5, -0.5); -361 -> 663 = 0x297
    // (0x297 << 20) | (0x297 << 10) | 0x297 = 0x29700000 | 0x000A5C00 | 0x297 = 0x297A5E97
    expect(packQuat({ x: -0.5, y: 0.5, z: 0.5, w: 0.5 })).toBe(0x297a5e97);
  });

  it('encodes a degenerate zero (or NaN, or infinite) quaternion as identity', () => {
    const identity = (3 << 30) >>> 0; // i = 3, s = [0, 0, 0]
    expect(identity).toBe(0xc0000000);
    expect(packQuat({ x: 0, y: 0, z: 0, w: 0 })).toBe(identity);
    expect(packQuat({ x: NaN, y: 0, z: 0, w: 1 })).toBe(identity);
    expect(packQuat({ x: Infinity, y: 0, z: 0, w: 1 })).toBe(identity);
    expect(packQuat(q.identity())).toBe(identity);
    expect(unpackQuat(identity, q.create(9, 9, 9, 9))).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });

  it('decodes -512 without throwing', () => {
    // every 10-bit field = 0x200 (512) sign-extends to -512
    const p = ((2 << 30) | (0x200 << 20) | (0x200 << 10) | 0x200) >>> 0;
    const out = unpackQuat(p, q.create());
    expect(out.x).toBeCloseTo(-512 / QUAT_SCALE, 12);
    expect(out.y).toBeCloseTo(-512 / QUAT_SCALE, 12);
    expect(out.w).toBeCloseTo(-512 / QUAT_SCALE, 12);
    expect(out.z).toBe(0); // 1 - 3 * 0.502 < 0 clamps to 0
    const w = new ByteWriter();
    w.u32(p);
    expect(() => f.quat().decode(new ByteReader(w.view()))).not.toThrow();
    // encoders never produce -512
    const rng = new Rng(8);
    let saw512 = 0;
    for (let i = 0; i < 10_000; i++) {
      const packed = packQuat(randomUnitQuat(rng));
      for (const shift of [0, 10, 20]) if (((packed >>> shift) & 0x3ff) === 0x200) saw512++;
    }
    expect(saw512).toBe(0);
  });

  it('writes into the given out object', () => {
    const out = q.create();
    expect(unpackQuat(packQuat(q.fromAxisAngle({ x: 0, y: 1, z: 0 }, 1)), out)).toBe(out);
  });
});
