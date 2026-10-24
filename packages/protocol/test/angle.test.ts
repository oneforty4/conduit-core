import { Rng } from '@conduit/math';
import { describe, expect, it } from 'vitest';
import {
  ByteReader,
  ByteWriter,
  decodeAngle16,
  encodeAngle16,
  EncodeError,
  f,
  TAU,
} from '../src/index.ts';

const PI = Math.PI;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** Angular distance on the circle. */
function arc(a: number, b: number): number {
  const d = Math.abs(a - b) % TAU;
  return Math.min(d, TAU - d);
}

describe('encodeAngle16', () => {
  it('maps 0, PI and quarter turns', () => {
    expect(encodeAngle16(0)).toBe(0);
    expect(encodeAngle16(PI / 2)).toBe(16384); // frac(0.25) * 65536
    expect(encodeAngle16(PI)).toBe(32768);
    expect(encodeAngle16((3 * PI) / 2)).toBe(49152);
  });

  it('wraps 2*PI - eps to 0 and keeps one step below 2*PI', () => {
    expect(encodeAngle16(TAU - 1e-9)).toBe(0); // round(65535.99999) = 65536, & 0xFFFF = 0
    expect(encodeAngle16(TAU)).toBe(0);
    expect(encodeAngle16(TAU - TAU / 65536)).toBe(65535);
  });

  it('handles negative inputs', () => {
    expect(encodeAngle16(-PI / 2)).toBe(49152); // frac(-0.25) = 0.75
    expect(encodeAngle16(-PI)).toBe(32768);
    expect(encodeAngle16(-TAU)).toBe(0);
    expect(encodeAngle16(-TAU / 65536)).toBe(65535);
  });

  it('handles inputs greater than 2*PI', () => {
    expect(encodeAngle16(TAU + PI / 2)).toBe(16384);
    expect(encodeAngle16(5 * PI)).toBe(32768);
    expect(encodeAngle16(100 * TAU + PI)).toBe(32768);
  });

  it('rounds to the nearest step (half-steps round up)', () => {
    expect(encodeAngle16(TAU / 131072)).toBe(1); // exactly half a step
    expect(encodeAngle16(TAU / 262144)).toBe(0); // a quarter step
  });

  it('rejects NaN and infinities', () => {
    for (const v of [NaN, Infinity, -Infinity]) {
      expect(() => encodeAngle16(v)).toThrow(EncodeError);
      try {
        f.angle16().encode(new ByteWriter(), v);
      } catch (err) {
        expect(err).toBeInstanceOf(EncodeError);
        expect((err as EncodeError).code).toBe('nan');
      }
      expect(() => f.angle16().encode(new ByteWriter(), v)).toThrow(EncodeError);
    }
  });
});

describe('decodeAngle16', () => {
  it('is u * TAU / 65536, in [0, TAU)', () => {
    expect(decodeAngle16(0)).toBe(0);
    expect(decodeAngle16(32768)).toBe(PI);
    expect(decodeAngle16(16384)).toBe(PI / 2);
    expect(decodeAngle16(65535)).toBeLessThan(TAU);
    expect(decodeAngle16(65535)).toBe((65535 * TAU) / 65536);
  });

  it('round-trips within half a step', () => {
    const rng = new Rng(16);
    let worst = 0;
    for (let i = 0; i < 10_000; i++) {
      const v = (rng.float() * 2 - 1) * 50;
      worst = Math.max(worst, arc(v, decodeAngle16(encodeAngle16(v))));
    }
    expect(worst).toBeLessThanOrEqual(TAU / 131072 + 1e-12);
  });
});

describe('f.angle16()', () => {
  it('is a u16 on the wire', () => {
    const w = new ByteWriter();
    const t = f.angle16();
    t.encode(w, PI / 2); // 16384 = 0x4000 -> 00 40
    t.encode(w, -PI / 2); // 49152 = 0xC000 -> 00 c0
    expect(hex(w.view())).toBe('00 40 00 c0');
    const r = new ByteReader(w.view());
    expect(t.decode(r)).toBe(PI / 2);
    expect(t.decode(r)).toBe((3 * PI) / 2);
    expect(t.numeric).toBe(true);
    expect(t.create()).toBe(0);
  });

  it('lerp takes the shortest arc across the 0 / 2*PI seam', () => {
    const lerp = f.angle16().lerp;
    expect(lerp).toBeDefined();
    if (lerp === undefined) return;
    const a = 0.1;
    const b = TAU - 0.1;
    // the short way from 0.1 to 2*PI - 0.1 is -0.2 rad through 0, not +6.08 rad through PI
    expect(arc(lerp(a, b, 0.5, 0), 0)).toBeLessThan(1e-12);
    expect(lerp(a, b, 0.25, 0)).toBeCloseTo(0.05, 12);
    expect(lerp(a, b, 0.75, 0)).toBeCloseTo(TAU - 0.05, 12);
    expect(arc(lerp(b, a, 0.5, 0), 0)).toBeLessThan(1e-12);
    expect(lerp(b, a, 0.25, 0)).toBeCloseTo(TAU - 0.05, 12);
    // endpoints
    expect(arc(lerp(a, b, 0, 0), a)).toBeLessThan(1e-12);
    expect(arc(lerp(a, b, 1, 0), b)).toBeLessThan(1e-12);
    // no seam: plain interpolation
    expect(lerp(1, 2, 0.5, 0)).toBeCloseTo(1.5, 12);
    expect(lerp(2, 1, 0.5, 0)).toBeCloseTo(1.5, 12);
  });

  it('lerp results stay in [0, TAU)', () => {
    const lerp = f.angle16().lerp;
    if (lerp === undefined) throw new Error('angle16 must define lerp');
    const rng = new Rng(4);
    for (let i = 0; i < 1000; i++) {
      const v = lerp(rng.float() * TAU, rng.float() * TAU, rng.float(), 0);
      expect(v >= 0 && v < TAU).toBe(true);
    }
  });
});
