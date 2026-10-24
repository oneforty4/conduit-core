# Deterministic implementation scenarios

Test-only entry points live in `packages/net-client/test/scenarios`. They are deliberately
absent from runtime package exports. Run `pnpm exec vitest run packages/net-client/test/scenarios`.
Set `CONDUIT_SCENARIO_ARTIFACT` to an absolute JSON destination to export the three reference runs.

Files under `artifacts/` are generated local evidence and are ignored by Git. The measurement
drivers below produce those files; the qualification outcomes and limits are summarized here.

`ScenarioClock` provides stable deadline/creation ordering, cancellable lane timers, timer
quantization, independent network/server/client stalls and bounded task execution/history.
The public `MemoryTransport` accepts `clock.timers('network')`; the integration test verifies
the existing Transport/ClientLink pair using these timers. Consumers can inject
`clock.timers('client')` into their client scheduler independently of server timers.

The version 1 scenario records seed, adapter name, tick/render frequency, independent directional
latency/jitter, serialization bandwidth, byte limits, stalls and input/command/connection events.
`OrderedChannel` preserves FIFO delivery and models head-of-line waiting. Network transit and
receiver processing occupy separate lanes. Capacity exhaustion is an explicit failure, never
silent application message loss. Disconnect changes connection generation so old in-flight
messages cannot apply after reconnect. This is a test connection model, not TCP congestion control.

The runner queues received commands until the next simulation tick. Game policy belongs to its
adapter. The vehicle, abrupt-stop/teleport character and inventory examples have distinct state
shapes and deep-enough snapshot copies. Artifacts contain the original scenario, effective
scheduled event deadlines, applied command/state/snapshot/render traces, directional latency
samples and queue byte peaks. Reference outputs are deterministic virtual measurements, not
hardware timing or production performance budgets. Outstanding deliveries at the duration
horizon remain pending and are not reported as delivered latency samples.

The public GameDef fixtures in `packages/game/test/fixtures/scenario-consumers.ts` additionally
exercise three distinct schemas through public World/Simulation APIs, virtual channel delivery,
tick-boundary input placement, guarded mutation and encoded snapshot/ReplicaWorld integration.
`registry-isolation.test.ts` verifies differently ordered shared definitions in both construction
orders and equivalent factory definitions from separate module instances.

## Integration and release layers

`packages/game/test/scenario-network.test.ts` runs all three public GameDefs through actual
NetClient/Session admission, wire encoding, commands, snapshots and reconnect/resync. Its 30
bounded cases cover zero delay, asymmetric delay, byte-serialized OrderedChannel backlog,
700 ms main-thread lane stalls, delayed/fresh Pong corrections and FixedLoop server overruns.
The jitter/reconnect profile varies 30/60/120/144 render cadences; the other named profiles run
at 60 Hz. Quiesced visible replica values equal authority at declared f32 precision. Private
inventory items remain private behind a replicated count/revision projection. Set
`CONDUIT_NETWORK_SCENARIO_ARTIFACT` to export seeds, effective schedules, counters, queue peaks
and lifecycle outcomes. Run `pnpm exec vitest run packages/game/test/scenario-network.test.ts`.

PredictionDriver has fixed-tick, held-input, coherence, overflow, command-outcome, immutable
scratch and reset tests. Public consumer adapters compare prediction against three independent
Simulation models at four cadences. Renderer tests exercise one prepared region-local pose
shared by model/region/camera, including teleport reset at 144 Hz. These tests complement exact
journal/checkpoint tests; the toy runner itself is not an exact replay or authoritative-state
proof.

Real loopback WebSocket and worker-bridge suites cover direct createServer/createClient and
host gateway admission/reconnect. Browser app smoke/render suites run under Chromium, Firefox
and WebKit through `CONDUIT_BROWSER=<engine> pnpm e2e`. The smoke test requires the actual
unauthenticated HTTP 401 response and filters only its expected console equivalent, because
browser console formatting differs. All fixture servers/stores use disposable test resources.

`node scripts/improvements/measure-browser.mjs` separately measures actual browser timers and
independent browser-worker simulation at four requested presentation cadences. Its 72-run
original/current artifact records discrete input revision to presentation latency, not GPU
pixels or perceptual latency. Exact browser versions and complete/partial/failed status are
recorded. The initial matrix did not capture actual frame counts and has no selected latency
budget, so latency is descriptive and no improvement is claimed. Optional
`CONDUIT_BROWSER_TREE=current`, `CONDUIT_BROWSER_FPS=144` and `CONDUIT_BROWSER_PREDICTION=1` enable the
nine-run public-adapter correction capture. ClockSnaps counts render-clock snaps; prediction
counts and correction magnitudes are recorded separately. Results live under
artifacts/improvements/browser-*.json.

`node --expose-gc scripts/improvements/measure-timing.mjs` compares the exact preserved source
baseline with current diagnostics disabled/enabled. Inspector allocation samples estimate
allocation volume; post-GC retained heap is labeled separately. The first comparison failed its
preselected relative p95/allocation tolerance; follow-up attempts remain separate artifacts.
None establishes arbitrary game capacity or production headroom. Asset ownership/resource
bounds have their own focused tests and estimates; unknown GPU residency/timing is not zero.

`node --expose-gc scripts/improvements/qualify-capacity.mjs` creates an isolated runtime copy
with an experimental capacity of sixteen. Public limits and lobby SQL stay at eight. The
preselected gates in `artifacts/improvements/capacity-qualification-plan.json` cover 3,600
steady ticks with sixteen clients, CPU, egress, observed RSS, reconnect and exact checkpoints.
Every client must see every player and stationary world entity correctly; ambient movers are
checked against their recorded authoritative tick. Heap endpoints describe retention and
observed peaks, not allocation volume. A separate real-timer phase loads two workers with
sixteen clients each, faults one, and checks subsequent command outcomes in the survivor.
Qualification applies only to this synthetic workload. Initial failed attempts are retained.
The current sixteen-client attempt fails simultaneous admission because the mandatory control
egress reserve is exhausted before all clients reach Playing; no sustained measurement or
worker result is claimed. Public supported capacity and SQLite remain eight. An incomplete run
does not qualify a larger public capacity.

Set `CONDUIT_CAPACITY_TARGET=8` for the separate shipped-default run. Its artifact is
`artifacts/improvements/capacity-qualification-8.json`, with a separate plan and preserved
attempt. It completed 3,600 ticks, full replica coherence, reconnect, exact checkpoint restore
and two-worker isolation. CPU and egress passed the original thresholds. Overall qualification
failed: peak RSS growth was 224,293,184 bytes against 134,217,728, and checkpoint capture took
69.06 ms against 50 ms. Heap retention and observed peaks are recorded separately. These
results do not establish the preselected resource headroom for the shipped default. No gate
was relaxed, and the failed sixteen-player admission result remains separate.

CI runs fast deterministic/unit/integration checks and exports the full network scenario
artifact on every change. Browser jobs form a Chromium/Firefox/WebKit matrix. A manual
`workflow_dispatch` `extended_checks` job runs the existing 600-second real-timer qualification.
Isolated consumer checks verify public imports, dependency boundaries and one copy of three.

Limits: actual physical display refresh, driver/GPU behavior and real hidden-tab throttling are
not proved by modeled stalls, busy main-thread tests or a background Playwright context. The
original headless stall case pauses `update()` while timers continue. The Chromium
`suspend-resume.spec.ts` test pauses JavaScript dispatch for 2.5 seconds using the debugger,
then checks input, queued snapshots and bounded lead recovery. It passed as a distinct
recovery probe. Two earlier lifecycle-freeze attempts failed to prove suspension and are
preserved in the artifacts; no hidden-tab lifecycle qualification is claimed. Other browsers and hardware require their own visibility/throttling measurements.
Reliable test channels model FIFO/backlog and explicit disconnect loss, not TCP congestion
control. Saved schedules reproduce virtual ordering; real timers intentionally include host noise.
