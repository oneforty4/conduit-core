import { describe, expect, it } from 'vitest';
import {
  DiagnosticCapture,
  diagnosticNow,
  observeDiagnostic,
  type DiagnosticRecord,
} from '../src/index.ts';
const record = (timeMs: number, extra: Partial<DiagnosticRecord> = {}): DiagnosticRecord => ({
  version: 1,
  category: 'frame',
  name: 'elapsed',
  timeMs,
  durationMs: timeMs,
  ...extra,
});
describe('bounded diagnostics', () => {
  it('keeps bounded ordered history and computes recent percentiles only on demand', () => {
    const capture = new DiagnosticCapture({ capacity: 3, durationWindow: 3 });
    for (let value = 1; value <= 5; value++) capture.observe(record(value));
    expect(capture.export().records.map((entry) => entry.timeMs)).toEqual([3, 4, 5]);
    expect(capture.stats()).toMatchObject({
      retained: 3,
      dropped: 2,
      metrics: [{ count: 5, mean: 3, p50Ms: 4, p95Ms: 4, peak: 5 }],
    });
    capture.clear();
    expect(capture.stats().retained).toBe(0);
  });
  it('bounds labels and repeated errors and never invents unavailable GPU timing zero', () => {
    const capture = new DiagnosticCapture({ maxMetrics: 2, errorIntervalMs: 100 });
    capture.observe(
      record(1, { category: 'gpu', name: 'timing', durationMs: undefined, status: 'unavailable' }),
    );
    capture.observe(
      record(2, { category: 'error', name: 'render', durationMs: undefined, status: 'error' }),
    );
    capture.observe(
      record(3, { category: 'error', name: 'render', durationMs: undefined, status: 'error' }),
    );
    capture.observe(record(4, { name: 'extra' }));
    expect(capture.stats()).toMatchObject({ suppressed: 1, dropped: 1 });
    expect(capture.stats().metrics[0]).toMatchObject({
      mean: undefined,
      latest: undefined,
      peak: undefined,
      p50Ms: undefined,
    });
  });
  it('filters metadata and omits correlations by default without raw payload/error fields', () => {
    const capture = new DiagnosticCapture();
    capture.observe({ ...record(1), correlation: 'opaque-connection' });
    const untrusted = {
      configuration: { tickRate: 60, token: 'secret', chat: 'private' },
      compatibility: {
        descriptorVersion: 1,
        mode: 'declared',
        gameId: 'game',
        simulationRevision: 'r1',
      },
      token: 'secret',
    };
    const exported = JSON.stringify(capture.export(untrusted));
    expect(exported).not.toContain('secret');
    expect(exported).not.toContain('private');
    expect(exported).not.toContain('opaque-connection');
    expect(JSON.stringify(capture.export(untrusted, true))).toContain('opaque-connection');
  });
  it('rejects malformed records/overflow and isolates throwing clocks and observers', () => {
    const capture = new DiagnosticCapture();
    capture.observe(record(NaN));
    capture.observe(record(1, { value: 1e300 }));
    capture.observe(record(2, { name: 'raw user text' }));
    expect(capture.stats()).toMatchObject({ retained: 0, dropped: 3 });
    expect(
      diagnosticNow(() => {
        throw Error('clock');
      }),
    ).toBeUndefined();
    expect(diagnosticNow(() => Infinity)).toBeUndefined();
    expect(() =>
      observeDiagnostic(
        {
          observe() {
            throw Error('observer');
          },
        },
        record(1),
      ),
    ).not.toThrow();
  });
});
