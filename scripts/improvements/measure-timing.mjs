import { performance } from 'node:perf_hooks';
import { Session as Inspector } from 'node:inspector';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const original = process.env.CONDUIT_ORIGINAL_TREE ?? '/tmp/conduit-original-baseline';
const workload = {
  entities: 128,
  warmupTicks: 1000,
  measuredTicks: 5000,
  tickRate: 60,
  trials: 3,
  seed: 42,
  samplingIntervalBytes: 32768,
};
const inspector = new Inspector();
inspector.connect();
const post = (method, parameters = {}) =>
  new Promise((resolve, reject) =>
    inspector.post(method, parameters, (error, result) =>
      error ? reject(error) : resolve(result),
    ),
  );
const quantile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)];
async function measure(base, enabled) {
  const math = await import(`${base}/packages/math/src/index.ts`);
  const protocol = await import(`${base}/packages/protocol/src/index.ts`);
  const sim = await import(`${base}/packages/sim/src/index.ts`);
  const State = sim.defineComponent('MeasurementState', {
    position: protocol.f.f32,
    speed: protocol.f.f32,
  });
  const registry = new protocol.SchemaRegistry({
    components: [State],
    messages: [],
    events: [],
    input: protocol.defineInput({ tick: protocol.f.u32 }),
  });
  const trials = [];
  for (let trial = 0; trial < workload.trials; trial++) {
    const world = new sim.World(registry);
    for (let entity = 0; entity < workload.entities; entity++) {
      const id = world.create();
      world.add(id, State, { position: entity, speed: 1 });
    }
    const capture = enabled
      ? new math.DiagnosticCapture({ capacity: 128, durationWindow: 128 })
      : undefined;
    const simulation = new sim.Simulation({
      world,
      seed: workload.seed,
      tickRate: workload.tickRate,
      regionRng: () => new math.Rng(1),
      regions: {
        regionOf() {},
        entitiesIn: () => [],
        active: () => [],
        def() {},
        migrate: () => 'notMember',
      },
      spatial: {
        queryRadius: (_id, _p, _r, out) => out,
        queryAABB: (_id, _a, _b, out) => out,
        queryRadiusAcross: (_id, _p, _r, out) => out,
        nearest() {},
      },
      ...(capture === undefined
        ? {}
        : { diagnostics: { observer: capture, now: () => performance.now() } }),
    });
    simulation.register(
      sim.defineSystem('measurementIntegrate', 'sim', (ctx) => {
        for (const id of ctx.world.query(State)) {
          const state = ctx.world.write(id, State);
          state.position += state.speed * ctx.dt;
        }
      }),
    );
    for (let tick = 1; tick <= workload.warmupTicks; tick++) simulation.step(tick);
    globalThis.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    await post('HeapProfiler.startSampling', {
      samplingInterval: workload.samplingIntervalBytes,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const durations = [];
    for (let tick = 1; tick <= workload.measuredTicks; tick++) {
      const start = performance.now();
      simulation.step(workload.warmupTicks + tick);
      durations.push(performance.now() - start);
    }
    const { profile } = await post('HeapProfiler.stopSampling');
    const sampledAllocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    const nodes = new Map();
    const walk = (node) => {
      nodes.set(node.id, node.callFrame);
      for (const child of node.children ?? []) walk(child);
    };
    walk(profile.head);
    const allocated = new Map();
    for (const sample of profile.samples)
      allocated.set(sample.nodeId, (allocated.get(sample.nodeId) ?? 0) + sample.size);
    const allocationHotspots = [...allocated]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([nodeId, bytes]) => ({
        function: nodes.get(nodeId)?.functionName ?? '',
        source: (nodes.get(nodeId)?.url ?? '').replace(base, '<tree>'),
        bytes,
      }));
    globalThis.gc?.();
    const heapAfter = process.memoryUsage().heapUsed;
    trials.push({
      p50TickMs: quantile(durations, 0.5),
      p95TickMs: quantile(durations, 0.95),
      p99TickMs: quantile(durations, 0.99),
      maxTickMs: Math.max(...durations),
      sampledAllocatedBytes,
      allocationHotspots,
      heapRetainedDeltaBytes: heapAfter - heapBefore,
      lastPosition: world.get(1, State).position,
      diagnosticRetained: capture?.stats().retained ?? 0,
    });
  }
  return {
    trials,
    medianP95TickMs: quantile(
      trials.map((trial) => trial.p95TickMs),
      0.5,
    ),
    medianSampledAllocatedBytes: quantile(
      trials.map((trial) => trial.sampledAllocatedBytes),
      0.5,
    ),
  };
}
const baseline = await measure(original, false);
const savedPath = `${root}/artifacts/improvements/timing-allocation-comparison.json`;
const preserved = existsSync(savedPath)
  ? JSON.parse(readFileSync(savedPath, 'utf8')).tolerances
  : undefined;
const tolerances = preserved ?? {
  description:
    'Selected after baseline and before current-tree measurement. Descriptive qualification for this workload only; no production headroom claim.',
  p95TickMs: baseline.medianP95TickMs * 1.25,
  disabledSampledAllocationBytes: baseline.medianSampledAllocatedBytes * 1.25,
};
const currentDisabled = await measure(root, false);
const currentEnabled = await measure(root, true);
const result = {
  version: 1,
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    inspectorSampling: true,
    exposedGC: typeof globalThis.gc === 'function',
  },
  workload,
  tolerances,
  baseline,
  currentDisabled,
  currentEnabled,
  comparison: {
    disabledP95Ratio: currentDisabled.medianP95TickMs / baseline.medianP95TickMs,
    enabledP95Ratio: currentEnabled.medianP95TickMs / currentDisabled.medianP95TickMs,
    disabledWithinP95Tolerance: currentDisabled.medianP95TickMs <= tolerances.p95TickMs,
    disabledWithinAllocationTolerance:
      currentDisabled.medianSampledAllocatedBytes <= tolerances.disabledSampledAllocationBytes,
  },
  limitations: [
    'Inspector allocation sampling estimates allocation volume and includes instrumentation; it is not exact allocation counting.',
    'Heap delta is retained heap after explicit GC, not total allocation volume.',
    'Synthetic128-entity single-system workload does not establish production capacity or browser latency.',
  ],
};
writeFileSync(
  process.env.CONDUIT_MEASUREMENT_OUTPUT ??
    `${root}/artifacts/improvements/timing-allocation-attribution.json`,
  JSON.stringify(result, null, 2) + '\n',
);
inspector.disconnect();
