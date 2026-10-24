# Application save generations

Sessions publish `kind: 'app-world', version: 1` manifests containing `completedTick`, generation,
compatibility descriptor, separately pinned `stateSchemaHash`, independent `gameSaveVersion`, and
immutable blob references. These application saves contain persisted components and game `onSave`
bytes; exact replay checkpoints are a separate contract. `save_data` holds blobs and
`save_manifest/current` selects a manifest. Blobs, manifest and pointer publish in one BlobStore
transaction. Failure preserves the previous complete generation. Live evictions stage in a
process-local overlay until a valid completed tick is captured; a failed tick cannot publish them.

`GenerationStore.capture(tick, compatibility, writes, gameSaveVersion, stateSchemaHash)` synchronously
detaches bytes and references. `publish(image)` uses only those detached inputs and acknowledges
staging revisions by identity, preserving newer writes. Staging transactions use detached maps;
outside readers see committed staging state. Capture rejects while a staging transaction is pending.
Session flushes await previous eviction staging, capture session/regions/inboxes together at one
completed boundary, then perform async merges using the detached references. Concurrent flush
requests share one pending follow-up save, which shutdown can share. A valid image already
publishing may finish after a later simulation fault; new post-fault captures reject. Snapshot hooks
must not mutate ECS.

Default limits: 64 MiB overlay bytes, 64 MiB captured/publication bytes, 10,000 keys, two retained
generations. `saveLimits` configures them. The byte budget includes manifest metadata and all
referenced blobs in a complete generation, not just newly written bytes. Retention preserves blobs
referenced by either retained manifest and deletes only unreferenced generation data. A failed
cleanup preserves extra history and exposes `lastRetentionError`; that publication remains
successful. Further publications reject until cleanup recovers, bounding extra retained generations.
External concurrent writers to the same session scope are unsupported. Old readers can outlive the
configured retention window and must reopen the current generation if their data is collected.

Use the manifest-aware public reader, also re-exported by `@conduit/game/server`:

```ts
const save = await openApplicationSave(store);
const bytes = await save.get('session', 'state');
const regionIds = await save.list('region');
const hostedSave = await openApplicationSave(host.store, { scope: sessionId });
```

Without a manifest, the explicit legacy v0 path reads original `region`/`session` keys. First
publication copies them into immutable generation blobs; the originals remain untouched if a
migration fails. Unknown manifest versions, missing referenced blobs, unknown region formats and
incompatible descriptors fail explicitly. Account/authentication stores are outside this mechanism.

`saveSchema` supplies the independent game byte version: `{ version, migrations: [{ version: 1,
migrate }, ...], validate(version, bytes) }`. Steps are contiguous from 1 and step N transforms N-1
into N. The framework copies bytes before callbacks, validates the original declared version and
every result, and calls `onLoad` only after success. Version 0 is the explicit opaque legacy/default
contract when no schema is supplied. Newer versions reject. Game callbacks validate domain contents;
unrelated database effects require game-owned transactions or idempotency. Descriptor mismatch
rejects unless the game explicitly provides `saveCompatibilityAdapter(stored, current)` for
application saves. This adapter never relaxes admission or exact replay compatibility.
Simulation/content schema transitions require the separate explicit `saveRegistryAdapter(storedHash,
currentHash)` and game-owned migration/validation; revision adapters cannot silently bypass schema
checks. `createServer` and `defineSessionFactory` pass these options and `saveLimits` to Session;
hosted callbacks are constructed inside the worker.

Standalone `RegionManager.flushAll` remains region-only. Sessions use `waitForSaves` and synchronous
`captureSave`. Inbox acknowledgements remove only the captured prefix and preserve later arrivals or
activation. Region load/save outcomes become authoritative at `update` boundaries, exposed by
`drainDecisions` and injectable during replay. Transient failures retry; malformed saves fail.
`captureCheckpoint`, `validateCheckpoint(dto, detachedWorld?)` and `restoreCheckpoint(dto, ctx, {
replayExternal: true })` preserve membership, RNG, pending outcomes, inbox order and streaming
bookkeeping. Capture requires settled eviction promises; loading results remain journal inputs.
Infinity linger sentinels encode as null. Promises are never checkpoint data.
