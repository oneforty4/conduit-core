# Bounded replication

Wire version 3 introduced snapshot transactions and entity state ticks; wire version 4 also negotiates session capacity. Old wire versions are rejected. Application saves and exact checkpoints pin `stateSchemaHash`, independently of the wire envelope version.

`SessionOptions.replication` is optional. Without it, snapshots retain complete state and ordinary snapshot cadence. Large full populations and updates are split into reliable ordered `SnapshotPart` frames; the client applies and acknowledges only the complete transaction. No partial population is reported as a completed snapshot. Large event batches may occupy several bounded frames while retaining event order.

With replication enabled, the server compares each client's last successfully handed-off quantized wire values. Schemas with up to 16 fields use top-level field masks; wider schemas use full components. Dirty values that cannot be selected remain pending even after newer global snapshots. No baseline advances on queueing or a failed send. Reconnect discards pending transactions and starts a full population.

`replicationGroups` declares coherent entity dependencies. All group members and lifecycle tombstones are delivered together. `required` groups receive first priority, but can remain at an older coherent `stateTick` when another group is selected. Prediction adapters must use the group's `replica.authoritativeTick(entity)` and verify every dependency has that stamp; the global snapshot tick and input acknowledgement are separate clocks. A required group that cannot fit the negotiated transaction limit fails explicitly. Priority scores must be finite within ±1,000,000. Every fourth transaction by default reserves first service for the oldest optional unit; `fairnessEvery` accepts 2–64. Fairness assumes successful transport delivery and that each indivisible dependency unit fits configured limits.

Defaults and hard bounds:

| Resource | Default | Supported bound |
| --- | --- | --- |
| Complete transaction bytes | 4 MiB | 64 B–16 MiB |
| Transaction parts | 256 | 1–1024 |
| Assembly inactivity | 5 s | 100 ms–60 s |
| Absolute assembly lifetime | 120 s | inactivity–600 s |
| All-frame wire bytes | 65,546 | 64–65,546 |
| Wire cache per client | 16 MiB | up to 256 MiB |
| Cached/eligible entities | 65,535 | up to 65,535 |
| Dependency groups | 8192 | up to 65,535 |
| Indivisible group bytes | 128 KiB | up to 16 MiB |
| Queued game messages per client | 1024 and 1 MiB | fixed ceilings |
| Control reserve | 4096 B/s, burst 8192 B | configurable within validated bounds |
| Control frame bytes | 4096 | additionally capped by all-frame maximum |

`bytesPerSecond` defaults to unlimited. Finite rates start at 32 B/s. The burst defaults to the larger of the rate and frame bound; it must hold an indivisible frame. Data credits are reserved before queueing, refunded on drop/fault, and settled on actual handoff. Control uses a separate bounded reserve; mandatory control exhaustion disconnects only that peer with an explicit reason. Snapshot fragments are sized for progress within the inactivity limit, and total transaction bytes including fragment headers must fit the configured lifetime at the selected rate. Unsupported frame, burst, group, queue, or transaction capacities fail actionably rather than retrying indefinitely.

Clients may offer smaller `snapshotLimits`; Welcome returns the effective intersection. The client validates order, count, total bytes, tick/baseline consistency, inactivity and absolute lifetime before applying. A direct delta cannot supersede an incomplete transaction. Only an explicit full reset can do so. Missing baselines, regressing entity stamps, corrupt transactions and partial apply failures invalidate/reconnect for a complete full resync; partial apply failures clear the mirror and prediction before emitting an error.

`eventDependencies` can name entity state required by an event. The ordered event prefix waits until those stamps have reached the event tick, including a destroy in the same committed transaction. Dependency history retires with bounded tombstones. Existing interest filtering and bounded pending-event overflow policy still apply. Slow consumers can see increasing state age; budgeting does not promise every snapshot contains fresh values for every entity.

Diagnostics report queued bytes, snapshot frame bytes/fragments, deferred groups and oldest deferred ticks, event/game-message records, resets and capacity failures. Measurements must report both bytes and CPU/cache cost: masking can save bandwidth while increasing per-client comparison work, especially for static or churn-heavy workloads.
