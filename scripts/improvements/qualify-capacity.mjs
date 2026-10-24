import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '');
const targetCapacity = Number(process.env.CONDUIT_CAPACITY_TARGET ?? 16);
if (![8, 16].includes(targetCapacity))
  throw Error('CONDUIT_CAPACITY_TARGET must be eight or sixteen');
const expectedEntities = 309 + targetCapacity;
const plan = {
  version: 1,
  targetCapacity,
  defaultCapacity: 8,
  workload: {
    seed: 42,
    tickRate: 60,
    snapshotEvery: 3,
    staticEntities: 300,
    ambientMovers: 9,
    steadyTicks: 3600,
    commandsPerVirtualSecond: targetCapacity,
    oneWayLatencyMs: 10,
    peerBytesPerSecond: 65536,
    maxFrameBytes: 16384,
    workerBoundary: {
      workers: 2,
      clientsPerWorker: targetCapacity,
      loadedRealMs: 2000,
      faultedWorkers: 1,
      survivingCommandOutcome: 2,
    },
  },
  gates: {
    p99ServerTickMs: 1000 / 60 / 2,
    peakPeerBytesPerSecond: 49152,
    peakTotalBytesPerSecond: 49152 * targetCapacity,
    peakRssDeltaBytes: 128 * 1024 * 1024,
    reconnectVirtualMs: 2000,
    reconnectCpuMs: 1000,
    checkpointCaptureMs: 50,
    checkpointBytes: 8 * 1024 * 1024,
    workerIsolation: `Both workers must load ${targetCapacity} clients/${expectedEntities} visible entities; exactly one deliberate fault, other worker remains running and acknowledges another command for every client`,
  },
  scope: `Synthetic full Session/NetClient workload only, not arbitrary production games. RSS includes all ${targetCapacity} in-process fixture clients. Public capacity and lobby SQL remain unchanged during qualification.`,
};
await writeFile(
  `${root}/artifacts/improvements/${targetCapacity === 16 ? 'capacity-qualification-plan' : 'capacity-qualification-8-plan'}.json`,
  JSON.stringify(plan, null, 2) + '\n',
);
const temporaryRoot = await mkdtemp(join(tmpdir(), 'conduit-capacity-qual-'));
const runtimePackages = [
  'math',
  'protocol',
  'sim',
  'world',
  'persist',
  'auth',
  'assets',
  'net-client',
  'net-server',
  'host',
  'lobby',
];
async function sourceDigest(base) {
  const hash = createHash('sha256');
  async function visit(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const target = join(path, entry.name);
      if (entry.isDirectory()) await visit(target);
      else {
        hash.update(target.slice(base.length));
        hash.update(await readFile(target));
      }
    }
  }
  for (const name of runtimePackages) await visit(join(base, 'packages', name, 'src'));
  return hash.digest('hex');
}
const result = {
  version: 1,
  status: 'running',
  plan,
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  harnessSha256: createHash('sha256')
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest('hex'),
  experimentalPatch:
    targetCapacity === 16
      ? 'Only QUALIFIED_SESSION_CAPACITY is changed from eight to sixteen in an isolated runtime source copy.'
      : 'None: isolated runtime source copy uses shipped qualified capacity eight.',
  measurements: {},
  gates: {},
  cleanupErrors: [],
};
const preflight = Symbol('preflight');
let session, restored, manager;
const workerClients = [];
const clients = [];
try {
  await writeFile(join(temporaryRoot, 'package.json'), '{"type":"module"}');
  for (const name of runtimePackages) {
    const source = join(root, 'packages', name),
      target = join(temporaryRoot, 'packages', name);
    await mkdir(target, { recursive: true });
    await cp(join(source, 'src'), join(target, 'src'), { recursive: true });
    await cp(join(source, 'package.json'), join(target, 'package.json'));
  }
  for (const name of runtimePackages) {
    const source = join(root, 'packages', name),
      target = join(temporaryRoot, 'packages', name);
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      const destination = join(target, 'node_modules', dependency);
      await mkdir(dirname(destination), { recursive: true });
      const resolved = dependency.startsWith('@conduit/')
        ? join(temporaryRoot, 'packages', dependency.slice('@conduit/'.length))
        : await realpath(join(source, 'node_modules', dependency));
      await symlink(resolved, destination, 'dir');
    }
  }
  result.publicSourceSnapshotSha256 = await sourceDigest(temporaryRoot);
  const constantsPath = join(temporaryRoot, 'packages/protocol/src/constants.ts');
  const constants = await readFile(constantsPath, 'utf8');
  if (!/QUALIFIED_SESSION_CAPACITY\s*=\s*8/.test(constants))
    throw Error('Qualification requires the public qualified limit to remain eight');
  await writeFile(
    constantsPath,
    targetCapacity === 16
      ? constants.replace(/QUALIFIED_SESSION_CAPACITY\s*=\s*8/, 'QUALIFIED_SESSION_CAPACITY = 16')
      : constants,
  );
  const sourceHash = createHash('sha256');
  async function hashDirectory(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const target = join(path, entry.name);
      if (entry.isDirectory()) await hashDirectory(target);
      else {
        sourceHash.update(target.slice(temporaryRoot.length));
        sourceHash.update(await readFile(target));
      }
    }
  }
  for (const name of runtimePackages)
    await hashDirectory(join(temporaryRoot, 'packages', name, 'src'));
  result.runtimeSourceSha256 = sourceHash.digest('hex');
  const protocol = await import(join(temporaryRoot, 'packages/protocol/src/index.ts'));
  const sim = await import(join(temporaryRoot, 'packages/sim/src/index.ts'));
  const math = await import(join(temporaryRoot, 'packages/math/src/index.ts'));
  const worldModule = await import(join(temporaryRoot, 'packages/world/src/index.ts'));
  const server = await import(join(temporaryRoot, 'packages/net-server/src/index.ts'));
  const clientModule = await import(join(temporaryRoot, 'packages/net-client/src/index.ts'));
  const persist = await import(join(temporaryRoot, 'packages/persist/src/index.ts'));
  if (process.env.CONDUIT_CAPACITY_VALIDATE_ONLY === '1') throw preflight;
  class Timers {
    now = 0;
    next = 0;
    tasks = new Map();
    intervals = new Set();
    setTimeout = (fn, ms) => {
      const id = ++this.next;
      this.tasks.set(id, { at: this.now + Math.max(0, ms), fn, interval: null });
      return id;
    };
    clearTimeout = (id) => this.tasks.delete(id);
    setInterval = (fn, ms) => {
      const id = ++this.next;
      this.tasks.set(id, { at: this.now + ms, fn, interval: ms });
      this.intervals.add(id);
      return id;
    };
    clearInterval = (id) => {
      this.intervals.delete(id);
      this.tasks.delete(id);
    };
    advance(ms) {
      const until = this.now + ms;
      let work = 0;
      for (;;) {
        let chosen;
        for (const [id, task] of this.tasks)
          if (
            task.at <= until &&
            (!chosen || task.at < chosen[1].at || (task.at === chosen[1].at && id < chosen[0]))
          )
            chosen = [id, task];
        if (!chosen) break;
        if (++work > 100000) throw Error('Qualification timer work bound exceeded');
        const [id, task] = chosen;
        this.tasks.delete(id);
        this.now = task.at;
        task.fn();
        if (task.interval !== null && this.intervals.has(id))
          this.tasks.set(id, { ...task, at: this.now + task.interval });
      }
      this.now = until;
    }
  }
  const timers = new Timers(),
    capture = new math.DiagnosticCapture({ capacity: 256 });
  const Marker = sim.defineComponent('CapacityMarker', { commands: protocol.f.u32 });
  const Motion = sim.defineComponent(
    'CapacityMotion',
    { speed: protocol.f.f32, player: protocol.f.u8 },
    { replicate: false },
  );
  const Input = protocol.defineInput({ tick: protocol.f.u32, throttle: protocol.f.f32 });
  const Action = protocol.defineMessage('CapacityCommand', 'c2s', { sequence: protocol.f.u32 });
  const Fault = protocol.defineMessage('CapacityFault', 'c2s', {});
  const registry = new protocol.SchemaRegistry({
    components: [...sim.CORE_COMPONENTS, Marker, Motion],
    messages: [Action, Fault],
    events: [sim.RegionChanged],
    input: Input,
  });
  const game = {
    id: 'capacity-workload',
    protocolVersion: 1,
    tickRate: 60,
    snapshotEvery: 3,
    seed: 42,
    registry,
    input: Input,
    components: [...sim.CORE_COMPONENTS, Marker, Motion],
    compatibility: protocol.createCompatibilityDescriptor('capacity-workload', {
      simulationRevision: 'qualification-1',
      gameplayDigests: { workload: `300-static-9-moving-${targetCapacity}-players` },
    }),
    world: (seed) =>
      new worldModule.GridWorld({
        cellSize: 10000,
        cols: 1,
        rows: 1,
        wantedDepth: 0,
        worldSeed: seed,
      }),
    systems: [
      sim.defineSystem('capacity-motion', 'sim', (ctx) => {
        for (const entity of ctx.world.query(Motion, sim.Transform)) {
          const movement = ctx.world.get(entity, Motion);
          const throttle =
            movement.player < targetCapacity ? (ctx.inputs(movement.player)?.throttle ?? 0) : 1;
          ctx.world.mutate(entity, sim.Transform, (value) => {
            value.pos.x += movement.speed * throttle * ctx.dt;
          });
        }
      }),
    ],
  };
  let spawns = 0,
    controls = 1;
  const ambientEntities = [];
  const positionHistory = new Map();
  const options = () => ({
    maxPlayers: targetCapacity,
    sessionId: 'qualification',
    sessionEpoch: 'qualification',
    manualLoop: true,
    store: new persist.MemoryStore(),
    now: () => timers.now,
    timers,
    verifier: {
      dev: true,
      verify(_token, hello) {
        return {
          accountId: `fixture:${hello.displayName}`,
          displayName: hello.displayName,
          sessionId: 'qualification',
          exp: 9999999999,
        };
      },
    },
    log() {},
    diagnostics: { observer: capture, now: () => performance.now() },
    replication: { bytesPerSecond: 65536, burstBytes: 65536, maxFrameBytes: 16384 },
    simulationMessages: [Action],
    regionLoader: {
      populate(region, blob, ctx) {
        if (blob !== null) return;
        for (let index = 0; index < 309; index++) {
          const entity = ctx.world.create();
          ctx.world.add(entity, sim.Region, { id: region.id });
          ctx.world.add(entity, sim.Transform, { pos: { x: index, y: 0, z: 10 } });
          ctx.world.add(entity, Marker);
          if (index >= 300) {
            ctx.world.add(entity, Motion, { speed: 1, player: 255 });
            ambientEntities.push(entity);
          }
        }
      },
    },
    hooks: {
      onPlayerJoin(player) {
        return {
          regionId: 'cell/0_0',
          spawn(ctx) {
            spawns++;
            const entity = ctx.world.create();
            ctx.world.add(entity, sim.Region, { id: 'cell/0_0' });
            ctx.world.add(entity, sim.Owner, { player: player.playerId });
            ctx.world.add(entity, sim.Transform, { pos: { x: player.playerId, y: 0, z: 0 } });
            ctx.world.add(entity, Marker);
            ctx.world.add(entity, Motion, { speed: 1, player: player.playerId });
            return entity;
          },
        };
      },
      onMessage(player, definition, _payload, ctx) {
        if (definition.name === Fault.name)
          throw Error('deliberate capacity worker isolation fault');
        if (definition.name === Action.name)
          ctx.world.mutate(player.entity, Marker, (value) => {
            value.commands++;
          });
      },
    },
  });
  globalThis.gc?.();
  const memoryBefore = process.memoryUsage();
  const rssBefore = memoryBefore.rss;
  const heapUsedStartBytes = memoryBefore.heapUsed;
  let observedHeapUsedPeakBytes = heapUsedStartBytes;
  let peakRss = rssBefore;
  session = new server.Session(game, options());
  await session.start();
  const transports = [],
    failures = [],
    durations = [];
  for (let index = 0; index < targetCapacity; index++) {
    const net = new clientModule.NetClient({
      url: 'memory://qualification',
      game,
      token: 'fixture',
      displayName: `fixture-${index}`,
      timers,
      now: () => timers.now,
      transport() {
        const transport = new clientModule.MemoryTransport({ timers, latencyMs: 10 });
        transports[index] = transport;
        session.attach(transport.link);
        return transport;
      },
      sampleInput(frame) {
        frame.throttle = controls;
      },
      log() {},
    });
    net.on('error', (error) => failures.push(error.stack ?? error.message));
    net.on('disconnected', (info) => {
      if (!durations.length) failures.push(JSON.stringify({ index, ...info }));
    });
    clients.push(net);
    void net.connect().catch((error) => failures.push(error.message));
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  let ticks = 0,
    peakPeer = 0,
    peakTotal = 0,
    lastWindow = clients.map(() => 0),
    lastWindowAt = 0;
  async function tick(measured = false) {
    timers.advance(1000 / 60);
    await settle();
    timers.advance(0);
    const started = performance.now();
    session.step();
    const duration = performance.now() - started;
    if (measured) durations.push(duration);
    positionHistory.set(
      session.tick,
      new Map(
        ambientEntities.map((entity) => [entity, session.world.get(entity, sim.Transform).pos.x]),
      ),
    );
    if (positionHistory.size > 256) positionHistory.delete(positionHistory.keys().next().value);
    ticks++;
    for (const net of clients) {
      net.pulseInput();
      net.update(timers.now);
    }
    if (ticks % 60 === 0) {
      const elapsed = timers.now - lastWindowAt;
      let total = 0;
      for (let index = 0; index < clients.length; index++) {
        const current = clients[index].stats().bytesIn;
        const rate = ((current - lastWindow[index]) * 1000) / elapsed;
        peakPeer = Math.max(peakPeer, rate);
        total += rate;
        lastWindow[index] = current;
      }
      peakTotal = Math.max(peakTotal, total);
      lastWindowAt = timers.now;
      const memory = process.memoryUsage();
      peakRss = Math.max(peakRss, memory.rss);
      observedHeapUsedPeakBytes = Math.max(observedHeapUsedPeakBytes, memory.heapUsed);
    }
  }
  for (let index = 0; index < 120; index++) await tick();
  const allPlaying = () =>
    clients.every(
      (net) =>
        net.state === 'Playing' &&
        net.players.length === targetCapacity &&
        net.sessionCapacity === targetCapacity,
    );
  if (!allPlaying())
    throw Error(
      `Initial membership/admission failed: ${clients.map((net) => net.state).join(',')}; ${failures.join(';')}`,
    );
  for (let index = 0; index < 3600; index++) {
    if (index % 60 === 0) clients.forEach((net) => net.send(Action, { sequence: index / 60 }));
    await tick(true);
  }
  controls = 0;
  for (let index = 0; index < 120; index++) await tick();
  const reconnectAt = timers.now,
    reconnectCpuAt = performance.now();
  transports.forEach((transport) => transport.link.drop(1006));
  await tick();
  while (!allPlaying() && timers.now - reconnectAt <= 2000) await tick();
  const reconnectVirtualMs = timers.now - reconnectAt,
    reconnectCpuMs = performance.now() - reconnectCpuAt;
  for (let index = 0; index < 120; index++) await tick();
  const coherenceFailures = [];
  const ambientSet = new Set(ambientEntities);
  for (let index = 0; index < clients.length; index++) {
    const net = clients[index];
    if (net.mirror.size !== expectedEntities) coherenceFailures.push(`client${index}:entity-count`);
    for (const entity of net.mirror.entities()) {
      const actual = net.mirror.read(entity.id, sim.Transform);
      const current = session.world.tryGet(entity.id, sim.Transform);
      const stateTick = net.mirror.authoritativeTick(entity.id);
      const expectedX = ambientSet.has(entity.id)
        ? positionHistory.get(stateTick)?.get(entity.id)
        : current?.pos.x;
      if (
        actual === undefined ||
        current === undefined ||
        expectedX === undefined ||
        Math.abs(actual.pos.x - expectedX) > 0.00051 ||
        Math.abs(actual.pos.y - current.pos.y) > 0.00051 ||
        Math.abs(actual.pos.z - current.pos.z) > 0.00051
      )
        coherenceFailures.push(`client${index}:transform${entity.id}@${stateTick}`);
      const marker = net.mirror.read(entity.id, Marker),
        expectedMarker = session.world.tryGet(entity.id, Marker);
      if (marker?.commands !== expectedMarker?.commands)
        coherenceFailures.push(`client${index}:marker${entity.id}`);
      const region = net.mirror.read(entity.id, sim.Region),
        expectedRegion = session.world.tryGet(entity.id, sim.Region);
      if (region?.id !== expectedRegion?.id)
        coherenceFailures.push(`client${index}:region${entity.id}`);
      const owner = net.mirror.read(entity.id, sim.Owner),
        expectedOwner = session.world.tryGet(entity.id, sim.Owner);
      if (owner?.player !== expectedOwner?.player)
        coherenceFailures.push(`client${index}:owner${entity.id}`);
    }
  }
  const coherent =
    coherenceFailures.length === 0 &&
    clients.every((net) =>
      clients.every((peer) => net.mirror.read(peer.entity, Marker)?.commands === 60),
    );
  const checkpointAt = performance.now(),
    checkpoint = session.captureCheckpoint();
  const checkpointCaptureMs = performance.now() - checkpointAt;
  const checkpointBytes = sim.encodeExactState(checkpoint).byteLength;
  restored = new server.Session(game, { ...options(), replayExternal: true });
  await restored.start();
  restored.restoreCheckpoint(checkpoint);
  const restoreMatches =
    (await sim.fullStateDigest(restored.captureCheckpoint())) ===
    (await sim.fullStateDigest(checkpoint));
  globalThis.gc?.();
  const memoryEnd = process.memoryUsage();
  const endRss = memoryEnd.rss;
  const heapUsedRetainedEndBytes = memoryEnd.heapUsed;
  observedHeapUsedPeakBytes = Math.max(observedHeapUsedPeakBytes, heapUsedRetainedEndBytes);
  peakRss = Math.max(peakRss, endRss);
  const ordered = [...durations].sort((a, b) => a - b),
    p99 = ordered[Math.floor((ordered.length - 1) * 0.99)];
  result.measurements = {
    steadyTicks: durations.length,
    p50ServerTickMs: ordered[Math.floor(ordered.length * 0.5)],
    p95ServerTickMs: ordered[Math.floor(ordered.length * 0.95)],
    p99ServerTickMs: p99,
    maxServerTickMs: Math.max(...durations),
    peakPeerBytesPerSecond: peakPeer,
    peakTotalBytesPerSecond: peakTotal,
    heapUsedRetainedStartBytes: heapUsedStartBytes,
    observedHeapUsedPeakBytes,
    heapUsedRetainedEndBytes,
    heapMeasurementScope:
      'Observed heap sampling and explicit-GC endpoint retention; not allocation volume',
    coherenceFailures: coherenceFailures.slice(0, 64),
    rssBefore,
    peakRss,
    endRss,
    peakRssDeltaBytes: peakRss - rssBefore,
    endRssDeltaBytes: endRss - rssBefore,
    reconnectVirtualMs,
    reconnectCpuMs,
    checkpointCaptureMs,
    checkpointBytes,
    restoreMatches,
    allPlaying: allPlaying(),
    coherent,
    spawns,
    inputOverflow: session.stats.inputOverflow,
    faulted: session.fault !== null,
    clientErrors: failures,
    diagnostics: capture.stats(),
  };
  const measured = result.measurements,
    limit = plan.gates;
  result.gates = {
    sustainedRun: durations.length >= 3600,
    cpu: p99 <= limit.p99ServerTickMs,
    peerEgress: peakPeer <= limit.peakPeerBytesPerSecond,
    totalEgress: peakTotal <= limit.peakTotalBytesPerSecond,
    rss: measured.peakRssDeltaBytes <= limit.peakRssDeltaBytes,
    reconnect:
      reconnectVirtualMs <= limit.reconnectVirtualMs &&
      reconnectCpuMs <= limit.reconnectCpuMs &&
      allPlaying() &&
      spawns === targetCapacity,
    checkpoint:
      checkpointCaptureMs <= limit.checkpointCaptureMs &&
      checkpointBytes <= limit.checkpointBytes &&
      restoreMatches,
    correctness:
      coherent &&
      session.fault === null &&
      session.stats.inputOverflow === 0 &&
      failures.length === 0,
  };
  // A separate real-timer host phase checks admission and fault isolation at capacity.
  // It is not included in the in-process tick/RSS sample above.
  const modulePath = join(temporaryRoot, 'capacity-worker-game.mjs');
  const ownSource = await readFile(fileURLToPath(import.meta.url), 'utf8');
  const declarations = ownSource.slice(
    ownSource.indexOf('  const Marker ='),
    ownSource.indexOf('  let spawns ='),
  );
  const imports = ['protocol', 'sim'].map(
    (name) =>
      `import * as ${name} from ${JSON.stringify(pathToFileURL(join(temporaryRoot, `packages/${name}/src/index.ts`)).href)};`,
  );
  imports.push(
    `import * as worldModule from ${JSON.stringify(pathToFileURL(join(temporaryRoot, 'packages/world/src/index.ts')).href)};`,
  );
  const fixtureOptions = options();
  await writeFile(
    modulePath,
    `${imports.join('\n')}\nconst targetCapacity=${targetCapacity};\n${declarations}\nlet spawns=0;const ambientEntities=[];\nexport {game};\nexport function sessionFactory(){return {replication:{bytesPerSecond:65536,burstBytes:65536,maxFrameBytes:16384},regionLoader:{${fixtureOptions.regionLoader.populate.toString()}},hooks:{${fixtureOptions.hooks.onPlayerJoin.toString()},${fixtureOptions.hooks.onMessage.toString()}}};}\n`,
  );
  const { SessionManager } = await import(
    join(temporaryRoot, 'packages/host/src/session-manager.ts')
  );
  const crashes = [],
    workerErrors = [];
  const sessionIds = ['capacity-worker-a', 'capacity-worker-b'];
  manager = new SessionManager({
    store: new persist.MemoryStore(),
    games: new Map([[game.id, { def: game, module: pathToFileURL(modulePath).href }]]),
    execArgv: [],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    onCrash(id, error) {
      crashes.push({ id, message: error.message });
    },
    onIdle() {},
  });
  await Promise.all(sessionIds.map((id) => manager.start(id, game.id, targetCapacity)));
  let workerClientId = 0;
  for (const id of sessionIds)
    for (let index = 0; index < targetCapacity; index++) {
      const accountId = `${id}-${index}`;
      const net = new clientModule.NetClient({
        url: 'memory://worker-capacity',
        game,
        token: 'fixture',
        displayName: accountId,
        sampleInput(frame) {
          frame.throttle = 1;
        },
        log() {},
        transport() {
          const transport = new clientModule.MemoryTransport();
          const socket = new EventEmitter();
          socket.bufferedAmount = 0;
          socket.send = (data) => transport.link.send(new Uint8Array(data));
          socket.close = (code, reason) => transport.link.close(code, reason);
          socket.terminate = () => transport.link.drop(1006);
          let attached = false;
          transport.link.onMessage((bytes) => {
            if (attached) socket.emit('message', Buffer.from(bytes), true);
            else {
              attached = true;
              manager.attach(id, {
                ws: socket,
                clientId: ++workerClientId,
                identity: {
                  accountId,
                  displayName: accountId,
                  sessionId: id,
                  exp: Math.floor(Date.now() / 1000) + 600,
                },
                helloFrame: Uint8Array.from(bytes).buffer,
              });
            }
          });
          transport.link.onClose((code, reason) => socket.emit('close', code, Buffer.from(reason)));
          return transport;
        },
      });
      net.on('error', (error) => workerErrors.push(error.message));
      workerClients.push(net);
      void net.connect().catch((error) => workerErrors.push(error.message));
    }
  async function waitUntil(predicate, label, timeout = 10000) {
    const deadline = performance.now() + timeout;
    while (!predicate()) {
      if (performance.now() > deadline) throw Error(`worker capacity timeout: ${label}`);
      for (const net of workerClients) net.update(performance.now());
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  await waitUntil(
    () =>
      workerClients.every(
        (net) =>
          net.state === 'Playing' &&
          net.players.length === targetCapacity &&
          net.sessionCapacity === targetCapacity,
      ),
    `all ${2 * targetCapacity} playing`,
  );
  for (const net of workerClients) net.send(Action, { sequence: 1 });
  await waitUntil(
    () =>
      workerClients.every(
        (net) =>
          net.mirror.size === expectedEntities &&
          net.mirror.read(net.entity, Marker)?.commands === 1,
      ),
    'full loaded state and commands',
  );
  const workerTicksBefore = manager
    .health()
    .map((item) => ({ id: item.sessionId, tick: item.tick }));
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const loadedCoherence = workerClients.every((net, index) => {
    const peers = workerClients.slice(
      index < targetCapacity ? 0 : targetCapacity,
      index < targetCapacity ? targetCapacity : 2 * targetCapacity,
    );
    return (
      net.mirror.size === expectedEntities &&
      peers.every((peer) => net.mirror.read(peer.entity, Marker)?.commands === 1) &&
      [...net.mirror.entities()].filter(
        (entity) => net.mirror.read(entity.id, sim.Owner) !== undefined,
      ).length === targetCapacity
    );
  });
  workerClients[0].send(Fault, {});
  await waitUntil(() => crashes.some((item) => item.id === sessionIds[0]), 'first worker faults');
  for (const net of workerClients.slice(targetCapacity)) net.send(Action, { sequence: 2 });
  await waitUntil(
    () =>
      workerClients
        .slice(targetCapacity)
        .every(
          (net) => net.state === 'Playing' && net.mirror.read(net.entity, Marker)?.commands === 2,
        ),
    'surviving worker commands',
  );
  const workerHealth = manager.health();
  const survivor = workerHealth.find((item) => item.sessionId === sessionIds[1]);
  const workerIsolation =
    loadedCoherence &&
    crashes.length === 1 &&
    survivor?.state === 'running' &&
    workerClients.slice(targetCapacity).every((net) => net.players.length === targetCapacity);
  result.workerQualification = {
    scope: `Two real-timer workers with ${targetCapacity} clients and ${expectedEntities} entities each, two-second loaded interval, deliberate authoritative fault in A, subsequent command acknowledgement in B. Separate from sustained virtual CPU/RSS sample.`,
    loadedClients: 2 * targetCapacity,
    loadedCoherence,
    workerTicksBefore,
    health: workerHealth.map(({ sessionId, state, tick, clients }) => ({
      sessionId,
      state,
      tick,
      clients,
    })),
    expectedFaultCount: crashes.length,
    clientErrors: workerErrors,
    passed: workerIsolation,
  };
  result.gates.workerIsolation = workerIsolation;
  result.status = Object.values(result.gates).every(Boolean) ? 'passed' : 'failed';
} catch (error) {
  if (error === preflight) result.status = 'preflight-passed';
  else {
    result.status = 'error';
    result.error = String(error.stack ?? error);
  }
} finally {
  for (const client of [...clients, ...workerClients]) {
    try {
      client.disconnect();
    } catch (error) {
      result.cleanupErrors.push(String(error));
    }
  }
  if (manager) {
    try {
      await manager.shutdown();
    } catch (error) {
      result.cleanupErrors.push(String(error));
    }
  }
  for (const current of [session, restored])
    if (current)
      try {
        await current.stop();
      } catch (error) {
        result.cleanupErrors.push(String(error));
      }
  result.publicSourceEndSha256 = await sourceDigest(root);
  result.runtimeSourceChangedDuringRun =
    result.publicSourceEndSha256 !== result.publicSourceSnapshotSha256;
  await writeFile(
    process.env.CONDUIT_CAPACITY_OUTPUT ??
      `${root}/artifacts/improvements/${process.env.CONDUIT_CAPACITY_VALIDATE_ONLY === '1' ? 'capacity-preflight' : 'capacity-qualification'}${targetCapacity === 8 ? '-8' : ''}.json`,
    JSON.stringify(result, null, 2) + '\n',
  );
  if (process.env.CONDUIT_KEEP_QUALIFICATION_COPY !== '1')
    await rm(temporaryRoot, { recursive: true, force: true });
}
console.log(
  JSON.stringify(
    { status: result.status, gates: result.gates, measurements: result.measurements },
    null,
    2,
  ),
);
if (result.status !== 'passed' && result.status !== 'preflight-passed') process.exitCode = 1;
