import { describe, expect, it } from 'vitest';
import { clamp, EPS, HALF_PI, lerp, lerpAngle, PI, TAU, wrapAngle } from '../src/index.ts';

describe('constants', () => {
  it('have the specified values', () => {
    expect(EPS).toBe(1e-6);
    expect(PI).toBe(Math.PI);
    expect(TAU).toBe(2 * Math.PI);
    expect(HALF_PI).toBe(Math.PI / 2);
  });
});

describe('wrapAngle', () => {
  it('maps the half-turn boundaries to PI', () => {
    expect(wrapAngle(PI)).toBe(PI);
    expect(wrapAngle(-PI)).toBe(PI);
    expect(wrapAngle(3 * PI)).toBe(PI);
    expect(wrapAngle(-3 * PI)).toBe(PI);
  });

  it('maps whole turns to 0', () => {
    expect(wrapAngle(2 * PI)).toBe(0);
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(-4 * PI)).toBe(0);
  });

  it('always lands in (-PI, PI] and preserves the angle', () => {
    for (let a = -20; a <= 20; a += 0.37) {
      const r = wrapAngle(a);
      expect(r).toBeGreaterThan(-PI);
      expect(r).toBeLessThanOrEqual(PI);
      const turns = (a - r) / TAU;
      expect(Math.abs(turns - Math.round(turns))).toBeLessThan(1e-9);
    }
    expect(wrapAngle(1)).toBe(1);
    expect(wrapAngle(-1)).toBe(-1);
  });
});

describe('lerpAngle', () => {
  it('lerpAngle(3.0, -3.0, 0.5) crosses through PI', () => {
    // The short way from 3.0 to -3.0 is +0.283 rad through PI, not -6 rad through 0.
    const mid = lerpAngle(3.0, -3.0, 0.5);
    expect(Math.abs(wrapAngle(mid))).toBeGreaterThan(3.1);
    expect(mid).toBeCloseTo(PI, 9);
  });

  it('interpolates normally when no wrap is needed', () => {
    expect(lerpAngle(0, 1, 0.25)).toBe(0.25);
    expect(lerpAngle(1, 0, 0.5)).toBe(0.5);
    expect(lerpAngle(-3.0, 3.0, 0.5)).toBeCloseTo(-PI, 9);
  });
});

describe('clamp and lerp', () => {
  it('clamp bounds', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    expect(clamp(0, 0, 1)).toBe(0);
    expect(clamp(1, 0, 1)).toBe(1);
    expect(clamp(Infinity, -2, 2)).toBe(2);
    expect(clamp(-Infinity, -2, 2)).toBe(-2);
  });

  it('lerp does not clamp t', () => {
    expect(lerp(2, 4, 0)).toBe(2);
    expect(lerp(2, 4, 1)).toBe(4);
    expect(lerp(2, 4, 0.5)).toBe(3);
    expect(lerp(2, 4, 2)).toBe(6);
    expect(lerp(2, 4, -1)).toBe(0);
  });
});
