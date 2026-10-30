// CPU per frame of permessage-deflate on snapshot frames (docs/net.md A.2), run with native Node from
// the workspace root: node scripts/improvements/measure-compression.mjs [--frames=1200] [--entities=24]
//
// Frames are real Snapshot frames from the protocol codec: a FULL population, then whole-record
// deltas of moving bodies at 20 Hz, as the default (budget-off) Session sends them. Each setting
// compresses them in order through one raw-deflate stream with context takeover, a sync flush per
// message and the 4-byte trailer dropped: what ws's PerMessageDeflate does for every message on a
// socket. Reported per frame: process CPU (zlib runs on the libuv pool), event-loop time, wall time,
// and the wire share (of this synthetic population: a measured flight game's compress to a fifth);
// then the inflate a client does. Each setting's quickest of three runs.
import { performance } from 'node:perf_hooks';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const FRAMES = Number(args.get('frames') ?? 1200);
const ENTITIES = Number(args.get('entities') ?? 24);
const at = (file) => pathToFileURL(resolve(process.cwd(), file)).href;
const p = await import(at('packages/protocol/src/index.ts'));
const { DEFAULT_WS_COMPRESSION } = await import(at('packages/net-server/src/ws-link.ts'));

// A flight-like population: pose and motion (quantised and float), control surfaces, counters.
const Body = {
  name: 'Body',
  replicate: true,
  interpolate: [],
  schema: p.defineSchema({
    pos: p.f.vec3(p.f.f32),
    rot: p.f.quat(),
    vel: p.f.vec3(p.f.fixed16(0.01)),
  }),
};
const State = {
  name: 'State',
  replicate: true,
  interpolate: [],
  schema: p.defineSchema({
    throttle: p.f.u8,
    pitch: p.f.i8,
    roll: p.f.i8,
    fuel: p.f.fixed32(0.001),
    ammo: p.f.u16,
    inputTick: p.f.u32,
    damage: p.f.array(p.f.u8, 16),
  }),
};
const registry = new p.SchemaRegistry({
  components: [Body, State],
  messages: [],
  events: [],
  input: p.defineInput({ tick: p.f.u32 }),
});
const bodyId = registry.componentId(Body);
const stateId = registry.componentId(State);

function values(e, tick) {
  const t = tick / 60;
  const a = e * 0.7 + t * 0.4;
  const half = a / 2;
  return [
    {
      id: bodyId,
      value: {
        pos: {
          x: 1000 * Math.cos(a) + e * 50,
          y: 1500 + 30 * Math.sin(t + e),
          z: 1000 * Math.sin(a),
        },
        rot: { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) },
        vel: { x: -160 * Math.sin(a), y: 2 * Math.cos(t), z: 160 * Math.cos(a) },
      },
    },
    {
      id: stateId,
      value: {
        throttle: 200 + ((tick + e) % 20),
        pitch: Math.round(20 * Math.sin(t + e)),
        roll: Math.round(60 * Math.sin(t * 0.5 + e)),
        fuel: 900 - t * 0.5,
        ammo: 300 - (Math.floor(t * 2) % 300),
        inputTick: tick,
        damage: Array.from({ length: 16 }, (_, i) => (i === e % 16 ? 10 : 0)),
      },
    },
  ].sort((x, y) => x.id - y.id);
}

const frames = [];
const fw = new p.FrameWriter();
for (let i = 0; i < FRAMES; i++) {
  const tick = 3 * (i + 1);
  const full = i === 0;
  const records = Array.from({ length: ENTITIES }, (_, e) => ({
    entity: e + 1,
    components: values(e, tick),
  }));
  const data = {
    header: {
      serverTick: tick,
      serverTimeMs: Math.round((tick * 1000) / 60),
      baselineTick: full ? 0 : tick - 3,
      lastInputSeq: i,
      lastInputTick: tick,
      flags: full ? p.SNAPSHOT_FLAG_FULL : 0,
    },
    regions: [],
    creates: full ? records.map((r) => ({ ...r, regionIdx: p.REGION_IDX_NONE })) : [],
    updates: full ? [] : records.map((r) => ({ ...r, removed: [] })),
    destroys: [],
  };
  fw.begin();
  fw.message(p.CoreKind.Snapshot, tick, i, (w) => p.encodeSnapshot(w, registry, data));
  frames.push(Buffer.from(fw.finish()));
}

const TRAILER = Buffer.from([0x00, 0x00, 0xff, 0xff]);

/** ws's compress: write, flush(Z_SYNC_FLUSH), concatenate, drop the trailer. */
function compressor(options) {
  const deflate = zlib.createDeflateRaw({ ...options, windowBits: options.windowBits });
  const chunks = [];
  deflate.on('data', (chunk) => chunks.push(chunk));
  return (buf) =>
    new Promise((done) => {
      deflate.write(buf);
      deflate.flush(zlib.constants.Z_SYNC_FLUSH, () => {
        const out = Buffer.concat(chunks.splice(0));
        done(out.subarray(0, out.length - 4));
      });
    });
}

function inflater(windowBits) {
  const inflate = zlib.createInflateRaw({ windowBits });
  const chunks = [];
  inflate.on('data', (chunk) => chunks.push(chunk));
  return (buf) =>
    new Promise((done) => {
      inflate.write(buf);
      inflate.write(TRAILER);
      inflate.flush(() => done(Buffer.concat(chunks.splice(0))));
    });
}

async function measure(name, options) {
  const warm = compressor(options);
  for (const f of frames.slice(0, 50)) await warm(f); // JIT and pool warm-up, its own stream
  const compress = compressor(options);
  const deltas = frames.slice(1);
  const compressed = [await compress(frames[0])]; // the FULL population: history, not timed
  const cpu0 = process.cpuUsage();
  const elu0 = performance.eventLoopUtilization();
  const t0 = performance.now();
  for (const f of deltas) compressed.push(await compress(f));
  const wall = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  const elu = performance.eventLoopUtilization(elu0);
  const n = deltas.length;
  const bytes = deltas.reduce((s, f) => s + f.length, 0);
  const wire = compressed.slice(1).reduce((s, f) => s + f.length, 0);
  const inflate = inflater(options.windowBits);
  await inflate(compressed[0]);
  const icpu0 = process.cpuUsage();
  for (const c of compressed.slice(1)) await inflate(c);
  const icpu = process.cpuUsage(icpu0);
  return {
    name,
    frameBytes: Math.round(bytes / n),
    wireShare: wire / bytes,
    cpuUs: (cpu.user + cpu.system) / n,
    loopUs: (elu.active * 1000) / n,
    wallUs: (wall * 1000) / n,
    inflateCpuUs: (icpu.user + icpu.system) / n,
  };
}

const settings = [
  ['default', DEFAULT_WS_COMPRESSION],
  ['level 1', { ...DEFAULT_WS_COMPRESSION, level: 1 }],
  ['level 6 (zlib)', { ...DEFAULT_WS_COMPRESSION, level: 6 }],
  ['level 9', { ...DEFAULT_WS_COMPRESSION, level: 9 }],
  ['window 13', { ...DEFAULT_WS_COMPRESSION, windowBits: 13 }],
  ['memLevel 9', { ...DEFAULT_WS_COMPRESSION, memLevel: 9 }],
];
console.log(
  `${FRAMES} snapshot frames of ${ENTITIES} bodies; deflate settings per frame (default ${JSON.stringify(DEFAULT_WS_COMPRESSION)}):`,
);
for (const [name, options] of settings) {
  // The quickest of three runs: the first pays for warming up what the others reuse.
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(await measure(name, options));
  const r = runs.sort((a, b) => a.cpuUs - b.cpuUs)[0];
  console.log(
    `  ${r.name.padEnd(15)} ${String(r.frameBytes).padStart(5)} B -> ${(r.wireShare * 100).toFixed(1).padStart(5)}%  ` +
      `CPU ${r.cpuUs.toFixed(1).padStart(6)} us (event loop ${r.loopUs.toFixed(1)}, wall ${r.wallUs.toFixed(1)})  ` +
      `inflate ${r.inflateCpuUs.toFixed(1)} us`,
  );
}
