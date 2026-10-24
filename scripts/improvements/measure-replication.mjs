// Run with native Node from the workspace root after the shared measurement window is released.
// Synthetic authoritative stores isolate replication discovery/encoding, not simulation or transport.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const originalRoot = process.env.CONDUIT_ORIGINAL_ROOT ?? '/tmp/conduit-original-baseline';
const currentRoot = process.cwd();
async function load(root) {
  const at = (file) => pathToFileURL(resolve(root, file)).href;
  return {
    p: await import(at('packages/protocol/src/index.ts')),
    client: await import(at('packages/net-client/src/replica-world.ts')),
    b: await import(at('packages/net-server/src/snapshot-builder.ts')),
  };
}
const current = await load(currentRoot);
const original = await load(originalRoot);
const { ReplicationPlanner } = await import('../../packages/net-server/src/replication-planner.ts');
const modes = [
  ['original-complete', original, null],
  ['current-complete-budget-off', current, null],
  ['current-masks-unbounded', current, 60000],
  ['current-masks-target4096', current, 4096],
];
const scenarios = ['static', 'movement', 'large-fields', 'churn-relevance'];
function trial(api, mode, scenario, target) {
  const { p, b } = api;
  const component = {
    name: 'Body',
    replicate: true,
    persist: true,
    interpolate: [],
    schema: p.defineSchema({
      pos: p.f.vec3(p.f.f32),
      x: p.f.f32,
      z: p.f.f32,
      flags: p.f.u8,
      note: p.f.str(4096),
    }),
  };
  const registry = new p.SchemaRegistry({
    components: [component],
    messages: [],
    events: [],
    input: p.defineInput({ tick: p.f.u32 }),
  });
  const count = scenario === 'large-fields' ? 12 : 128;
  const noteSize = scenario === 'large-fields' ? 2048 : 128;
  const values = new Map();
  const version = new Uint32Array(2048),
    removedAt = new Uint32Array(2048);
  let nextId = count + 1,
    tick = 0;
  for (let id = 1; id <= count; id++) {
    values.set(id, {
      pos: { x: id, y: 0, z: 0 },
      x: id,
      z: 0,
      flags: 0,
      note: 'a'.repeat(noteSize),
    });
    version[id] = 1;
  }
  const store = { has: (id) => values.has(id), read: (id) => values.get(id), version, removedAt };
  const source = {
    registry,
    entitiesIn: () => values.keys(),
    regionOf: () => 'region',
    entityAlive: (id) => values.has(id),
    store: () => store,
    slot: (id) => id,
    relevance: (id) => scenario !== 'churn-relevance' || (id + Math.floor(tick / 30)) % 8 !== 0,
  };
  const state = { known: new Set(), baselineTick: 0, fullNext: true };
  const planner = target === null ? null : new ReplicationPlanner();
  const replica = new api.client.ReplicaWorld(registry, [component], {
    tickRate: 60,
    snapshotEvery: 3,
  });
  let coherenceChecks = 0;
  const cpu = [];
  let discoveryMs = 0,
    encodingMs = 0,
    commitMs = 0;
  let bytes = 0,
    creates = 0,
    updates = 0,
    destroys = 0,
    deferred = 0;
  let peakKnown = 0,
    peakCacheBytes = 0,
    peakPendingGroups = 0,
    oldestDeferredTicks = 0;
  for (tick = 1; tick <= 300; tick++) {
    if (scenario !== 'static')
      for (const [id, value] of values) {
        value.x += 0.125;
        value.pos.x += 0.125;
        value.z = tick * 0.25;
        version[id] = tick;
        if (scenario === 'large-fields' && tick % 60 === 0)
          value.note = (tick % 120 === 0 ? 'a' : 'b').repeat(noteSize);
      }
    if (scenario === 'churn-relevance' && tick % 15 === 0) {
      const id = values.keys().next().value;
      values.delete(id);
      removedAt[id] = tick;
      values.set(nextId, {
        pos: { x: nextId, y: 0, z: 0 },
        x: nextId,
        z: 0,
        flags: 0,
        note: 'a'.repeat(noteSize),
      });
      version[nextId++] = tick;
    }
    if (tick % 3 !== 0) continue;
    const start = performance.now();
    let data, payload;
    if (planner) {
      const prepared = planner.prepare(
        source,
        state,
        ['region'],
        tick,
        { serverTimeMs: (tick * 1000) / 60, lastInputSeq: 0, lastInputTick: tick },
        target,
        65535,
      );
      const preparedAt = performance.now();
      discoveryMs += preparedAt - start;
      data = prepared.data;
      payload = prepared.bytes;
      deferred += prepared.deferred;
      oldestDeferredTicks = Math.max(oldestDeferredTicks, prepared.oldestDeferredTicks);
      const commitStart = performance.now();
      prepared.commit();
      commitMs += performance.now() - commitStart;
    } else {
      data = b.buildSnapshot(source, state, ['region'], tick, {
        serverTimeMs: (tick * 1000) / 60,
        lastInputSeq: 0,
        lastInputTick: tick,
      });
      const discoveredAt = performance.now();
      discoveryMs += discoveredAt - start;
      const writer = new p.ByteWriter();
      p.encodeSnapshot(writer, registry, data);
      payload = writer.view();
      const encodedAt = performance.now();
      encodingMs += encodedAt - discoveredAt;
      b.commitSnapshot(state, data, data.creates.length);
      commitMs += performance.now() - encodedAt;
    }
    cpu.push(performance.now() - start);
    // Decode and install through each tree's real client outside encoding CPU samples.
    replica.applySnapshot(p.decodeSnapshot(new p.ByteReader(payload), registry));
    for (const record of [...data.creates, ...data.updates]) {
      assert.deepEqual(
        replica.read(record.entity, component),
        values.get(record.entity),
        `${mode}/${scenario}/${tick}/${record.entity}`,
      );
      coherenceChecks++;
    }
    for (const entity of data.destroys) {
      assert.equal(
        [...replica.visibleAt(tick)].some((record) => record.id === entity),
        false,
      );
      coherenceChecks++;
    }
    bytes += payload.byteLength;
    creates += data.creates.length;
    updates += data.updates.length;
    destroys += data.destroys.length;
    peakKnown = Math.max(peakKnown, state.known.size);
    if (planner) {
      const stats = planner.stats();
      peakCacheBytes = Math.max(peakCacheBytes, stats.cacheBytes);
      peakPendingGroups = Math.max(peakPendingGroups, stats.pendingGroups);
    }
  }
  cpu.sort((a, b) => a - b);
  return {
    mode,
    scenario,
    snapshots: cpu.length,
    coherenceChecks,
    stageCpuMs: {
      discoveryOrPlannerPrepare: discoveryMs,
      encode: planner ? null : encodingMs,
      commit: commitMs,
    },
    bytes,
    creates,
    updates,
    destroys,
    deferredGroupObservations: deferred,
    cpuTotalMs: cpu.reduce((sum, value) => sum + value, 0),
    cpuP50Ms: cpu[Math.floor(cpu.length * 0.5)],
    cpuP95Ms: cpu[Math.floor(cpu.length * 0.95)],
    peakKnown,
    peakCacheBytes: planner ? peakCacheBytes : null,
    peakPendingGroups: planner ? peakPendingGroups : null,
    oldestDeferredTicks,
    finalPlanner: planner?.stats() ?? null,
  };
}
const results = [];
for (const scenario of scenarios)
  for (const [mode, api, target] of modes) {
    trial(api, mode, scenario, target); // One separate warmup; no sample discarded from measured trials.
    for (let repetition = 0; repetition < 3; repetition++)
      results.push({ repetition, ...trial(api, mode, scenario, target) });
  }
const report = {
  version: 1,
  node: process.version,
  originalRoot,
  ticks: 300,
  snapshotEveryTicks: 3,
  scope:
    'Synthetic single-client snapshot payload discovery/encoding and synchronous delivery commit. No full Session, network framing, fragmentation, simulation, transport backpressure or heap/RSS measurement.',
  interpretation:
    'Original and current complete modes include their respective wire metadata. Unbounded planner isolates masks/cache; 4096-byte target also changes scheduling and must not be attributed to masks alone. Cache bytes count encoded images, not JS object overhead. Pending groups are planner queue evidence, not transport queues. No blanket performance improvement claimed.',
  results,
};
const output =
  process.env.CONDUIT_REPLICATION_REPORT ??
  'artifacts/improvements/step6/replication-comparison.json';
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, trials: results.length }));
