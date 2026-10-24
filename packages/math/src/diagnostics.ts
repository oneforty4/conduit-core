/** Driver/invocation-boundary measurements. Simulation systems never read clocks for diagnostics. */
export type DiagnosticCategory =
  | 'frame'
  | 'system'
  | 'pipeline'
  | 'input'
  | 'clock'
  | 'prediction'
  | 'replication'
  | 'save'
  | 'asset'
  | 'gpu'
  | 'error';
export type DiagnosticStatus = 'ok' | 'unavailable' | 'error' | 'reset' | 'dropped';
export interface DiagnosticRecord {
  readonly version: 1;
  readonly category: DiagnosticCategory;
  /** Bounded static metric/system name; never actor names, chat, tokens or raw errors. */
  readonly name: string;
  readonly timeMs: number;
  readonly tick?: number | undefined;
  readonly durationMs?: number | undefined;
  readonly value?: number | undefined;
  readonly unit?: 'ms' | 'count' | 'bytes' | 'ticks' | 'ratio' | undefined;
  readonly status?: DiagnosticStatus | undefined;
  /** Optional caller-supplied opaque correlation. Omitted by default from exports. */
  readonly correlation?: string | undefined;
}
export interface DiagnosticObserver {
  observe(record: DiagnosticRecord): void;
}
export interface DiagnosticOptions {
  observer: DiagnosticObserver;
  now?: () => number;
}

/** Diagnostic clocks are untrusted callbacks; missing/invalid time is unavailable, never zero. */
export function diagnosticNow(now: () => number): number | undefined {
  try {
    const value = now();
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}
export function observeDiagnostic(observer: DiagnosticObserver, record: DiagnosticRecord): void {
  try {
    observer.observe(record);
  } catch {
    /* Observers cannot change runtime outcomes. */
  }
}
export interface DiagnosticMetadata {
  compatibility?: {
    descriptorVersion: number;
    mode: string;
    gameId: string;
    simulationRevision: string;
    gameplayDigestNames?: readonly string[];
  };
  configuration?: {
    tickRate?: number;
    snapshotEvery?: number;
    maxInputLeadTicks?: number;
    maxFutureTicks?: number;
    capacity?: number;
  };
}
export interface DiagnosticCaptureOptions {
  capacity?: number;
  maxMetrics?: number;
  durationWindow?: number;
  errorIntervalMs?: number;
}
interface Metric {
  count: number;
  measurements: number;
  mean: number | undefined;
  peak: number | undefined;
  latest: number | undefined;
  durations: number[];
  next: number;
  lastErrorMs: number | undefined;
}
const label = /^[A-Za-z0-9_.:/-]{1,64}$/;
const categories = new Set<DiagnosticCategory>([
  'frame',
  'system',
  'pipeline',
  'input',
  'clock',
  'prediction',
  'replication',
  'save',
  'asset',
  'gpu',
  'error',
]);
const units = new Set(['ms', 'count', 'bytes', 'ticks', 'ratio']);
const statuses = new Set<DiagnosticStatus>(['ok', 'unavailable', 'error', 'reset', 'dropped']);
function bound(value: number, min: number, max: number, name: string): void {
  if (!Number.isInteger(value) || value < min || value > max)
    throw new RangeError(`DiagnosticCapture: invalid ${name}`);
}
function text(value: string, max = 128): string {
  return [...value.slice(0, max * 2)].slice(0, max).join('');
}

/** Bounded opt-in collector; observation is O(1), percentile work occurs only in stats/export. */
export class DiagnosticCapture implements DiagnosticObserver {
  readonly capacity: number;
  private readonly maxMetrics: number;
  private readonly durationWindow: number;
  private readonly errorInterval: number;
  private readonly records: DiagnosticRecord[] = [];
  private readonly metrics = new Map<string, Metric>();
  private next = 0;
  private dropped = 0;
  private suppressed = 0;
  constructor(options: DiagnosticCaptureOptions = {}) {
    this.capacity = options.capacity ?? 256;
    this.maxMetrics = options.maxMetrics ?? 64;
    this.durationWindow = options.durationWindow ?? 128;
    this.errorInterval = options.errorIntervalMs ?? 1000;
    bound(this.capacity, 1, 4096, 'capacity');
    bound(this.maxMetrics, 1, 128, 'maxMetrics');
    bound(this.durationWindow, 1, 2048, 'durationWindow');
    if (!Number.isFinite(this.errorInterval) || this.errorInterval < 0)
      throw new RangeError('DiagnosticCapture: invalid errorIntervalMs');
  }
  observe(record: DiagnosticRecord): void {
    if (
      record.version !== 1 ||
      !categories.has(record.category) ||
      !label.test(record.name) ||
      !Number.isFinite(record.timeMs) ||
      (record.status !== undefined && !statuses.has(record.status)) ||
      (record.unit !== undefined && !units.has(record.unit)) ||
      (record.durationMs !== undefined &&
        (!Number.isFinite(record.durationMs) ||
          record.durationMs < 0 ||
          record.durationMs > Number.MAX_SAFE_INTEGER)) ||
      (record.value !== undefined &&
        (!Number.isFinite(record.value) || Math.abs(record.value) > Number.MAX_SAFE_INTEGER)) ||
      (record.tick !== undefined && (!Number.isSafeInteger(record.tick) || record.tick < 0))
    ) {
      this.dropped++;
      return;
    }
    const key = `${record.category}/${record.name}`;
    let metric = this.metrics.get(key);
    if (metric === undefined) {
      if (this.metrics.size >= this.maxMetrics) {
        this.dropped++;
        return;
      }
      metric = {
        count: 0,
        measurements: 0,
        mean: undefined,
        peak: undefined,
        latest: undefined,
        durations: [],
        next: 0,
        lastErrorMs: undefined,
      };
      this.metrics.set(key, metric);
    }
    if (record.status === 'error') {
      if (
        metric.lastErrorMs !== undefined &&
        record.timeMs - metric.lastErrorMs < this.errorInterval
      ) {
        this.suppressed++;
        return;
      }
      metric.lastErrorMs = record.timeMs;
    }
    metric.count++;
    const measurement = record.durationMs ?? record.value;
    if (measurement !== undefined) {
      metric.measurements++;
      metric.mean =
        metric.mean === undefined
          ? measurement
          : metric.mean + (measurement - metric.mean) / metric.measurements;
      metric.latest = measurement;
      metric.peak = metric.peak === undefined ? measurement : Math.max(metric.peak, measurement);
    }
    if (record.durationMs !== undefined) {
      if (metric.durations.length < this.durationWindow) metric.durations.push(record.durationMs);
      else metric.durations[metric.next] = record.durationMs;
      metric.next = (metric.next + 1) % this.durationWindow;
    }
    const owned = Object.freeze({
      version: 1 as const,
      category: record.category,
      name: record.name,
      timeMs: record.timeMs,
      ...(record.tick === undefined ? {} : { tick: record.tick }),
      ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
      ...(record.value === undefined ? {} : { value: record.value }),
      ...(record.unit === undefined ? {} : { unit: record.unit }),
      ...(record.status === undefined ? {} : { status: record.status }),
      ...(record.correlation === undefined || !label.test(record.correlation)
        ? {}
        : { correlation: record.correlation }),
    });
    if (this.records.length < this.capacity) this.records.push(owned);
    else {
      this.records[this.next] = owned;
      this.dropped++;
    }
    this.next = (this.next + 1) % this.capacity;
  }
  stats() {
    return {
      retained: this.records.length,
      dropped: this.dropped,
      suppressed: this.suppressed,
      metrics: [...this.metrics].map(([name, metric]) => {
        const sorted = [...metric.durations].sort((a, b) => a - b);
        const percentile = (fraction: number) =>
          sorted.length === 0
            ? undefined
            : sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))];
        return {
          name,
          count: metric.count,
          mean: metric.measurements === 0 ? undefined : metric.mean,
          latest: metric.latest,
          peak: metric.peak,
          p50Ms: percentile(0.5),
          p95Ms: percentile(0.95),
          p99Ms: percentile(0.99),
        };
      }),
    };
  }
  /** Explicit bounded metadata whitelist; no raw errors/payloads, account IDs, tokens or automatic uploads. */
  export(metadata: DiagnosticMetadata = {}, includeCorrelations = false) {
    const configuration: Record<string, number> = {};
    for (const key of [
      'tickRate',
      'snapshotEvery',
      'maxInputLeadTicks',
      'maxFutureTicks',
      'capacity',
    ] as const) {
      const value = metadata.configuration?.[key];
      if (value !== undefined && Number.isFinite(value)) configuration[key] = value;
    }
    const source = metadata.compatibility;
    if (
      source !== undefined &&
      (!Number.isInteger(source.descriptorVersion) ||
        source.descriptorVersion < 1 ||
        source.descriptorVersion > 255 ||
        typeof source.mode !== 'string' ||
        typeof source.gameId !== 'string' ||
        typeof source.simulationRevision !== 'string')
    )
      throw new TypeError('Invalid diagnostic compatibility metadata');
    const compatibility =
      metadata.compatibility === undefined
        ? undefined
        : {
            descriptorVersion: metadata.compatibility.descriptorVersion,
            mode: text(metadata.compatibility.mode, 16),
            gameId: text(metadata.compatibility.gameId, 64),
            simulationRevision: text(metadata.compatibility.simulationRevision),
            gameplayDigestNames: metadata.compatibility.gameplayDigestNames
              ?.slice(0, 16)
              .map((name) => text(name, 64)),
          };
    const records: DiagnosticRecord[] = [];
    const start = this.records.length < this.capacity ? 0 : this.next;
    for (let index = 0; index < this.records.length; index++) {
      const record = this.records[(start + index) % this.records.length]!;
      const { correlation: _correlation, ...safe } = record;
      records.push(includeCorrelations ? { ...record } : safe);
    }
    return {
      version: 1 as const,
      ...(compatibility === undefined ? {} : { compatibility }),
      configuration,
      records,
      summary: this.stats(),
    };
  }
  clear(): void {
    this.records.length = 0;
    this.metrics.clear();
    this.next = 0;
    this.dropped = 0;
    this.suppressed = 0;
  }
}
