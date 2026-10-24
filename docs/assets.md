# @conduit/assets

Manifest format, the Three-free `AssetLoader`, core backends, the `conduit-assets` CLI logic, and the
Blender/glTF authoring conventions that the checker and `ModelMeta` derivation enforce.

Scope boundaries (CONCEPT.md): `@conduit/assets` is isomorphic and never imports `three`. The Three-based
`GltfBackend` lives in `@conduit/render` (docs/render.md). The `conduit-assets` bin lives in `@conduit/tooling`
(docs/consuming.md) and only parses argv; all logic is exported from this package. Region asset lists come from
`RegionDef.assets` in the world graph (docs/world.md). `RegionClient` (docs/net.md) is the main consumer of
`acquireGroup`.

Package entry points:

| Export path             | File            | Runs in     | Contents                                                        |
| ----------------------- | --------------- | ----------- | --------------------------------------------------------------- |
| `@conduit/assets`       | `src/index.ts`  | browser+node | types, `validateManifest`, `AssetLoader`, backends, GLB parsing |
| `@conduit/assets/node`  | `src/node.ts`   | node        | `buildManifest`, `checkManifest`, `cli` (uses `node:fs`, `node:crypto`) |

## 1. Manifest

### 1.1 Types

```ts
export type AssetId = string;                 // grammar below
export type RegionId = string;                // docs/world.md
export type AssetType = 'model' | 'texture' | 'audio' | 'json' | 'binary';
export type Sha256Sri = `sha256-${string}`;   // 'sha256-' + standard base64 (padded) of the 32-byte digest

export interface AssetEntry {
  type: AssetType;
  url: string;          // relative to baseUrl; POSIX separators; no leading '/'; no '..' segments
  hash: Sha256Sri;
  size: number;         // byte length, integer >= 0
  deps?: AssetId[];     // acquired transitively before this asset resolves
}

export interface Manifest {
  version: 1;
  baseUrl: string;                          // ends with '/'; absolute URL or root-relative path
  assets: Record<AssetId, AssetEntry>;
  groups: Record<string, AssetId[]>;        // group name grammar: ^[a-z0-9_]+$
  regions: Record<RegionId, AssetId[]>;
}
```

Constants:

```ts
export const MANIFEST_VERSION = 1;
export const ASSET_ID_RE = /^[a-z0-9]+(\.[a-z0-9_]+)*$/;
export const ASSET_ID_MAX_LENGTH = 128;
export const GROUP_NAME_RE = /^[a-z0-9_]+$/;
export const SRI_RE = /^sha256-[A-Za-z0-9+/]{43}=$/;
export const ASSET_TYPES: readonly AssetType[] = ['model', 'texture', 'audio', 'json', 'binary'];
```

### 1.2 JSON Schema (draft 2020-12)

Exported as `MANIFEST_JSON_SCHEMA` for editors and external tooling. `validateManifest` implements the same rules
by hand (no schema-validation dependency at runtime).

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://conduit.dev/schemas/manifest-1.json",
  "type": "object",
  "required": ["version", "baseUrl", "assets", "groups", "regions"],
  "additionalProperties": false,
  "properties": {
    "version": { "const": 1 },
    "baseUrl": { "type": "string", "pattern": "/$" },
    "assets": {
      "type": "object",
      "propertyNames": { "pattern": "^[a-z0-9]+(\\.[a-z0-9_]+)*$", "maxLength": 128 },
      "additionalProperties": {
        "type": "object",
        "required": ["type", "url", "hash", "size"],
        "additionalProperties": false,
        "properties": {
          "type": { "enum": ["model", "texture", "audio", "json", "binary"] },
          "url": { "type": "string", "minLength": 1, "pattern": "^(?!/)(?!.*\\\\)(?!.*(^|/)\\.\\.(/|$)).+$" },
          "hash": { "type": "string", "pattern": "^sha256-[A-Za-z0-9+/]{43}=$" },
          "size": { "type": "integer", "minimum": 0 },
          "deps": { "type": "array", "items": { "type": "string", "pattern": "^[a-z0-9]+(\\.[a-z0-9_]+)*$" }, "uniqueItems": true }
        }
      }
    },
    "groups": {
      "type": "object",
      "propertyNames": { "pattern": "^[a-z0-9_]+$" },
      "additionalProperties": { "type": "array", "items": { "type": "string" }, "uniqueItems": true }
    },
    "regions": {
      "type": "object",
      "additionalProperties": { "type": "array", "items": { "type": "string" }, "uniqueItems": true }
    }
  }
}
```

### 1.3 Validation

```ts
export type ManifestErrorCode =
  | 'bad_version' | 'bad_base_url' | 'bad_shape' | 'bad_id' | 'bad_type' | 'bad_url' | 'bad_hash' | 'bad_size'
  | 'duplicate_url' | 'unknown_dep' | 'self_dep' | 'dep_cycle'
  | 'bad_group_name' | 'unknown_group_asset' | 'unknown_region_asset' | 'duplicate_list_entry';

export interface ManifestError {
  code: ManifestErrorCode;
  path: string;            // JSON pointer-ish, e.g. 'assets.ship.sloop.deps[1]' or 'regions.r_3_4[0]'
  message: string;         // human text; includes the cycle path for dep_cycle: 'a -> b -> c -> a'
}

export class ManifestValidationError extends Error {
  readonly errors: ManifestError[];
  constructor(errors: ManifestError[]);     // message = errors.map(e => `${e.code} ${e.path}: ${e.message}`).join('\n')
}

export function validateManifest(input: unknown): ManifestError[];          // pure; [] means valid
export function assertValidManifest(input: unknown): asserts input is Manifest;  // throws ManifestValidationError
```

Rules, checked in this order, all errors collected (validation never stops at the first):

1. `version !== 1` (or input not an object) -> `bad_version` (and stop; nothing else is meaningful).
2. `baseUrl` not a string or not ending in `/` -> `bad_base_url`. Structure the JSON Schema rejects is `bad_shape`,
   reported where rules 2-8 visit it: an unknown top-level or entry property (`additionalProperties: false`),
   `assets`/`groups`/`regions` or an entry not an object, `deps` or a group/region list not an array, a list member
   not a string. A non-object section counts as empty for the remaining rules.
3. For each `assets` key in insertion order: key fails `ASSET_ID_RE` or exceeds `ASSET_ID_MAX_LENGTH` -> `bad_id`;
   `type` not in `ASSET_TYPES` -> `bad_type`; `url` empty, starts with `/`, contains a `..` segment, or contains
   `\` -> `bad_url`; `hash` fails `SRI_RE` -> `bad_hash`; `size` not a non-negative integer -> `bad_size`.
4. `url` seen twice (exact string compare) -> `duplicate_url` on the second occurrence.
5. For each `deps[i]`: not an `assets` key -> `unknown_dep`; equal to the owner -> `self_dep`; repeated within the
   same array -> `duplicate_list_entry`.
6. Cycle detection over the dep graph: iterative DFS with `white/grey/black` marks starting from each asset in
   insertion order; a grey hit reports one `dep_cycle` per distinct cycle with `path` = the asset where the cycle
   was closed and `message` = the cycle listed from that asset back to itself. Each cycle is reported once.
7. `groups`: key fails `GROUP_NAME_RE` -> `bad_group_name`; member not an asset -> `unknown_group_asset`; repeat
   -> `duplicate_list_entry`.
8. `regions`: member not an asset -> `unknown_region_asset`; repeat -> `duplicate_list_entry`. Region ids are not
   validated here (their grammar belongs to docs/world.md).

Helpers:

```ts
export function resolveUrl(manifest: Manifest, id: AssetId): string;   // baseUrl + entry.url; throws RangeError for unknown id
export function depsOf(manifest: Manifest, id: AssetId): AssetId[];     // transitive closure, deps before dependants, no duplicates, never `id` itself; RangeError for unknown id
export function sriFromDigest(digest: Uint8Array): Sha256Sri;           // 32 bytes -> 'sha256-<base64>'
export async function sha256Sri(bytes: ArrayBuffer | Uint8Array): Promise<Sha256Sri>;   // crypto.subtle (browser and Node >= 20)
```

`depsOf` pseudocode (post-order DFS, memoised):

```
depsOf(m, id):
  out = []; seen = Set([id])
  visit(x):
    for d in (m.assets[x]?.deps ?? []):                -- an unknown dep is listed (acquiring it fails), not visited
      if d in seen: continue
      seen.add(d); visit(d); out.push(d)
  visit(id)
  return out
```

## 2. CLI logic (`@conduit/assets/node`)

The bin `conduit-assets` (docs/consuming.md, `packages/tooling/bin/conduit-assets.mjs`) does
`import('@conduit/assets/node').then(m => m.cli(process.argv.slice(2)))` and exits with the returned code.

```ts
export async function cli(argv: string[], io?: { stdout?: (s: string) => void; stderr?: (s: string) => void }): Promise<number>;
```

Usage (printed on `--help` or any parse error, exit code 1):

```
conduit-assets build <srcDir> <outDir> [--graph <world.json>] [--base-url </assets/>] [--clean]
conduit-assets check <manifest.json> [--dir <outDir>]
```

Exit codes: `0` success, `1` usage error, `2` build/validation/check failure. All failures are printed to stderr one
per line as `<code> <path>: <message>` (for `check`, `<path>` is the asset id, or the manifest path when the id is
`null`). Usage is printed to stdout for `--help` and no arguments, and to stderr after `error: <message>` for a parse
error. An input that cannot be read or has the wrong shape (missing `srcDir`, invalid JSON or unknown keys in
`conduit-assets.json`, a `--graph` file that is missing or has no `regions` array) makes `buildManifest` reject with
`BuildInputError { path }`; `cli` prints it as `input_error <path>: <message>` (any other thrown error as
`io_error <srcDir|manifest>: <message>`) and returns 2. Build log lines (`config ...`, `skip ...`, a summary) go to
stdout.

### 2.1 `build`

```ts
export interface BuildOptions {
  srcDir: string;
  outDir: string;
  graphPath?: string;        // WorldGraphJson (docs/world.md)
  baseUrl?: string;          // default: config.baseUrl ?? '/assets/'
  clean?: boolean;           // default false
  log?: (line: string) => void;
}

export interface BuildResult {
  manifest: Manifest;
  written: string[];         // absolute paths written to outDir (content files + manifest.json)
  removed: string[];         // absolute paths deleted by --clean
  errors: ManifestError[];   // non-empty => nothing written, cli returns 2
}

export function buildManifest(opts: BuildOptions): Promise<BuildResult>;
```

Optional config file `<srcDir>/conduit-assets.json`, or, when that does not exist, `conduit-assets.json` in the parent
directory of `srcDir` (the sandbox keeps it next to `world.json`, outside `assets/`). Keys other than `baseUrl`,
`groups` and `deps` are a `BuildInputError`:

```json
{
  "baseUrl": "/assets/",
  "groups": { "core": ["ui.*", "sfx.horn"], "ships": ["models.ship.*"] },
  "deps": { "models.ship.sloop": ["textures.ship.sloop_albedo"] }
}
```

Group patterns are exact ids or `prefix.*` (matches ids whose leading segments equal `prefix`, with at least one more
segment; `*` only as the final segment). A pattern matching nothing, or with `*` anywhere else, is an error
(`unknown_group_asset`, path `groups.<name>[i]`). Members keep pattern order (each pattern's matches sorted), without
duplicates.

Algorithm:

```
buildManifest(opts):
  reject BuildInputError if srcDir is not a directory, outDir == srcDir, or clean and srcDir is inside outDir
  config  = readJsonIfExists(srcDir/conduit-assets.json) ?? readJsonIfExists(dirname(srcDir)/conduit-assets.json) ?? {}
  baseUrl = opts.baseUrl ?? config.baseUrl ?? '/assets/'
  files   = walk(srcDir) sorted by relative POSIX path, skipping:
              any path segment starting with '.' or '_', the root 'conduit-assets.json', and outDir if inside srcDir
  assets = {}; urlToId = {}; errors = []
  for rel in files:
    if typeFromExt(ext(rel)) == null: log("skip <rel>: '<ext>' is not an asset type"); continue   -- e.g. .blend sources
    id = idFromPath(rel)                     -- below
    if id in assets: errors.push(bad_id 'duplicate id from <rel> and <assets[id].src>'); continue
    bytes = readFile(srcDir/rel); digest = sha256(bytes)
    hex8  = hex(digest).slice(0, 8)
    outRel = dirname(rel) + '/' + basenameWithoutExt(rel) + '.' + hex8 + ext(rel)   -- no leading './'
    assets[id] = { type: typeFromExt(ext(rel)), url: outRel, hash: sriFromDigest(digest), size: bytes.length, src: rel }
  for (id, deps) in config.deps: assets[id].deps = deps   (unknown id -> unknown_dep at 'deps.<id>')
  groups  = expandPatterns(config.groups, keys(assets))
  regions = {}
  if opts.graphPath:
    graph = readJson(graphPath)               -- WorldGraphJson { regions: RegionDef[] }
    for def in graph.regions: regions[def.id] = dedupe(def.assets)
  manifest = { version: 1, baseUrl, assets (without src), groups, regions }   -- all record keys sorted
  errors += validateManifest(manifest)       -- a bad_id message gets ' (from <src>)' appended
  if errors.length: return { manifest, written: [], removed: [], errors }
  mkdir -p outDir
  for each asset: copy srcDir/src -> outDir/url (mkdir -p parent)
  write outDir/manifest.json (JSON, 2-space indent, trailing newline)
  if opts.clean: remove every file under outDir not in written (and then empty directories)
  return { manifest, written, removed, errors: [] }
```

`idFromPath(rel)`:

```
segments = rel without extension, split on '/'
each segment: toLowerCase(), replace /[^a-z0-9_]/g with '_'
first segment additionally: if it now starts with '_', replace /_/g with ''
join with '.'
```

The result can still fail `ASSET_ID_RE`, whose first segment is `[a-z0-9]+` (e.g. a top-level `sfx_horn.ogg` gives
`sfx_horn`); validation reports that as `bad_id` naming the source file, rather than silently renaming the asset.

`typeFromExt`:

| Extension                             | Type      |
| ------------------------------------- | --------- |
| `.glb`                                | `model`   |
| `.png` `.jpg` `.jpeg` `.webp` `.ktx2` | `texture` |
| `.ogg` `.mp3` `.wav`                  | `audio`   |
| `.json`                               | `json`    |
| `.bin` `.gltf`                        | `binary`  |
| anything else (incl. `.blend`, `.blend1`, no extension) | `null`: not an asset; `buildManifest` skips the file with a `skip` log line |

Matching is case-insensitive (`.PNG` is a texture); the output name keeps the original extension. Skipping unknown
extensions lets Blender sources sit beside their exports (`crate.blend` next to `crate.glb` would otherwise collide on
id `crate`); other binary data must use `.bin`.

Region lists from `--graph` replace any list for the same region id (there is no other source, so no merge
semantics are needed beyond dedupe). Regions referencing unknown ids fail with `unknown_region_asset`.

### 2.2 `check`

```ts
export interface CheckOptions { manifestPath: string; dir?: string; log?: (line: string) => void }
export interface CheckFailure { id: AssetId | null; code: CheckCode; message: string }
export type CheckCode =
  | 'manifest_invalid' | 'missing_file' | 'size_mismatch' | 'hash_mismatch' | 'glb_parse' | NamingErrorCode;
export function checkManifest(opts: CheckOptions): Promise<CheckFailure[]>;    // [] => ok
```

```
checkManifest:
  m = readJson(manifestPath)                 -- unreadable or not JSON: return [{ id: null, code: manifest_invalid }]
  errs = validateManifest(m)
  if errs: return errs.map(-> manifest_invalid, id null, message '<code> <path>: <message>')
  dir = opts.dir ?? dirname(manifestPath)
  for (id, e) in m.assets (sorted):
    p = join(dir, e.url); if !exists(p): failures.push(missing_file); continue
    bytes = readFile(p)
    if bytes.length != e.size: failures.push(size_mismatch)
    if sriFromDigest(sha256(bytes)) != e.hash: failures.push(hash_mismatch)
    if e.type == 'model':
      try glb = parseGlb(bytes) catch -> failures.push(glb_parse); continue
      meta = deriveModelMeta(glb.json, id)
      failures.push(...checkModelNaming(glb.json, meta, id).map(n => ({ id, code: n.code, message: n.message })))
  return failures
```

## 3. `AssetLoader`

Three-free, refcounted, prioritised. One instance per client. Backends are registered by `type`; exactly one
backend per type (duplicate -> `Error('duplicate backend for type ...')`).

### 3.1 Interfaces

```ts
export type Priority = 'high' | 'low';
export type AssetState = 'idle' | 'queued' | 'loading' | 'loaded' | 'error' | 'grace' | 'disposing';

export interface AssetHandle<T = unknown> {
  readonly id: AssetId;
  readonly asset: T;
  release(): void;               // idempotent; second call logs a warning and does nothing
}

export interface GroupHandle {
  readonly ids: readonly AssetId[];
  readonly handles: readonly AssetHandle[];
  release(): void;               // releases every handle once
}

export interface LoaderEvents {
  loaded:   { id: AssetId };
  unloaded: { id: AssetId };
  error:    { id: AssetId; error: Error };
  retrying: { id: AssetId; error: Error; attempt: number; delayMs: number };   // failed for a reason that may pass: tried again in delayMs
  progress: { id: AssetId; loaded: number; total: number };   // bytes if the backend reports them, else 0/1 then 1/1
}

export interface AssetLoaderOptions {
  maxConcurrent?: number;        // DEFAULT_MAX_CONCURRENT = 6
  unloadGraceMs?: number;        // DEFAULT_UNLOAD_GRACE_MS = 5000
  verifyHashes?: boolean;        // default false
  retries?: number;              // DEFAULT_RETRIES = 5: tries again of a load that failed for a reason that may pass
  retryMs?: number;              // DEFAULT_RETRY_MS = 500: the first wait, doubling (0.5, 1, 2, 4, 8 s)
  fetch?: typeof fetch;          // default globalThis.fetch
  setTimer?: (fn: () => void, ms: number) => unknown;   // default setTimeout; injectable for tests
  clearTimer?: (h: unknown) => void;                   // default clearTimeout
  warn?: (msg: string) => void;  // default console.warn
}

export class AssetLoader {
  constructor(manifest: Manifest, backends: AssetBackend<unknown>[], opts?: AssetLoaderOptions);
  readonly manifest: Manifest;
  acquire<T = unknown>(id: AssetId, priority?: Priority, signal?: AbortSignal): Promise<AssetHandle<T>>;   // default 'high'
  acquireGroup(ids: readonly AssetId[], priority?: Priority, signal?: AbortSignal): Promise<GroupHandle>;
  peek<T = unknown>(id: AssetId): T | undefined;           // asset if state === 'loaded' or 'grace'
  state(id: AssetId): AssetState;                          // 'idle' for unknown or evicted ids
  refcount(id: AssetId): number;                           // handles outstanding plus pending acquisitions
  stats(): { queuedHigh: number; queuedLow: number; inFlight: number; loaded: number };   // loaded counts 'loaded' + 'grace'
  on<K extends keyof LoaderEvents>(evt: K, cb: (e: LoaderEvents[K]) => void): () => void;
  dispose(): void;   // aborts all in-flight, disposes all loaded, rejects waiters with AbortError
}
```

`acquire` of an id not in the manifest rejects with `RangeError('unknown asset <id>')`. `acquire` of an id whose
`type` has no backend rejects with `Error('no backend for type <type>')`. After `dispose()`, `acquire` and
`acquireGroup` reject with `AbortError`.

`acquire` takes its reference (`refs += 1`) when called, before it resolves. `signal` is how a caller gives that
reference back early: aborting it before the promise settles rejects the promise with `signal.reason` and runs
`release(r)` for that acquisition, so an asset nobody else wants is dequeued (`queued`) or has its backend load aborted
(`loading`); an already-aborted signal rejects at once without taking a reference; after resolution the signal is
ignored and the handle must be released. This is what makes the `queued` and `loading` branches of `release` below
reachable, e.g. for `RegionClient` (docs/net.md) dropping a region whose group is still loading.

### 3.2 Record and scheduler

Internal record per id:

```ts
interface Record_ {
  id: AssetId; entry: AssetEntry; state: AssetState;
  refs: number;                         // handles outstanding (group handles count once per member)
  asset?: unknown;
  error?: Error;
  waiters: { resolve; reject }[];       // promises awaiting 'loaded'
  depHandles: AssetHandle[];            // handles on deps, held while this record is not idle
  abort?: AbortController;
  graceTimer?: unknown;
  priority: Priority;                   // highest priority requested while queued
  attempts: number;                     // failed loads tried again
  waiting: boolean; retryTimer?: unknown;   // queued, waiting out the delay before it is tried again
}
```

Queues: `high: AssetId[]`, `low: AssetId[]` (FIFO arrays; dequeue = shift). `inFlight: Set<AssetId>`.

```
acquire(id, priority):
  r = records.get(id) ?? create(id, 'idle')
  r.refs += 1
  switch r.state:
    'loaded':   return handle(r)
    'grace':    clearTimer(r.graceTimer); r.state = 'loaded'; return handle(r)
    'loading', 'queued':
                if priority == 'high' and r.priority == 'low' and r.state == 'queued': promote(r)
                return waitFor(r)
    'error', 'idle':
                r.error = undefined; r.state = 'queued'; r.priority = priority
                enqueue(r) ; await acquireDeps(r, priority)   -- see below
                return waitFor(r)
    'disposing': await r.disposed; retry acquire (recursion once)

handle(r): { id, asset: r.asset, release: once(() => release(r)) }

acquireDeps(r, priority):
  ids = depsOf(manifest, r.id)                       -- transitive, deps first
  r.depHandles = await Promise.all(ids.map(d => acquire(d, priority)))
  -- failure of any dep: release the ones that resolved, fail(r, err)
  r.depsReady = true; pump()

pump():
  while inFlight.size < maxConcurrent:
    id = nextReady(high) ?? nextReady(low)            -- first queued id in the queue with depsReady, not waiting
    if !id: break
    start(records.get(id))

start(r):
  remove r.id from its queue; inFlight.add(r.id); r.state = 'loading'
  r.abort = new AbortController()
  backend = backends.get(r.entry.type)
  url = resolveUrl(manifest, r.id)
  emit progress {id, 0, entry.size || 1}
  backend.load(url, r.entry, r.abort.signal, ctx(r))
    .then(asset => finishOk(r, asset), err => finishErr(r, err))

finishOk(r, asset):
  inFlight.delete(r.id)
  if r.abort.signal.aborted: backend.dispose(asset); evict(r); pump(); return
  r.asset = asset; r.state = 'loaded'
  emit progress {id, size, size}; emit loaded
  resolve all waiters with handle(r); r.waiters = []
  if r.refs == 0: startGrace(r)            -- released while loading but not aborted (cannot happen; defensive)
  pump()

finishErr(r, err):
  inFlight.delete(r.id)
  if aborted: evict(r); pump(); return
  if r.attempts < retries and transientError(err):    -- no response, or the server's 5xx, 408 or 429
    delayMs = retryMs × 2^r.attempts; r.attempts += 1
    r.state = 'queued'; r.waiting = true; enqueue(r)   -- waiters wait on; a release dequeues it (clearing the timer)
    r.retryTimer = setTimer(() => { r.waiting = false; pump() }, delayMs)
    emit retrying {id, error: err, attempt: r.attempts, delayMs}; pump(); return
  r.state = 'error'; r.error = err; emit error
  reject all waiters; r.waiters = []
  releaseDeps(r); r.refs = 0             -- callers hold no handle on error; they retry via acquire
  pump()

release(r):
  r.refs = max(0, r.refs - 1)
  if r.refs > 0: return
  switch r.state:
    'loaded':  startGrace(r)
    'queued':  dequeue(r); releaseDeps(r); evict(r)
    'loading': r.abort.abort(); r.state = 'disposing'   -- finishOk/finishErr will evict
    'grace':   nothing (timer already running)

startGrace(r):
  r.state = 'grace'
  r.graceTimer = setTimer(() => expire(r), unloadGraceMs)

expire(r):
  if r.refs > 0 or r.state != 'grace': return
  r.state = 'disposing'
  backend.dispose(r.asset)
  releaseDeps(r)                          -- deps then get their own grace period
  evict(r); emit unloaded

evict(r): records.delete(r.id); resolve r.disposed
```

Guarantees: (a) `high` is always dequeued before `low` regardless of enqueue time; (b) at most `maxConcurrent`
backend loads in flight; (c) one backend call per id while it is not idle; (d) `acquire` on a record that resolves
never resolves before all its deps are `loaded`; (e) after `release` to zero the asset stays `peek`-able for
`unloadGraceMs`; (f) an abort observed by the backend is never followed by `loaded`.

Implementation notes. Dep acquisitions inside the loader report through synchronous callbacks rather than awaited
promises, so when a dep's `finishOk` resolves its waiters the dependant is marked `depsReady` before that call's
`pump()` runs; otherwise a queued `low` record could take the slot a `high` dependant is about to need. `promote(r)`
also moves `r`'s queued `low` deps to the `high` queue (deps first). A dep cycle (possible only in an unvalidated
manifest) fails the record with `Error('dependency cycle: ...')` instead of leaving both ends queued forever.
`finishErr`/`fail` emit `error` after releasing deps and before rejecting waiters, so a dep's `error` event precedes
its dependant's.

`acquireGroup(ids, priority, signal)`: `Promise.all(ids.map(id => acquire(id, priority, groupSignal)))`; on the first
rejection abort `groupSignal` (pending members give their references back, so queued ones are dequeued and loading
ones aborted when nobody else holds them), release the resolved handles and reject with that first error. Aborting
`signal` aborts `groupSignal`. Progress for a group is derived by callers from per-id `progress` events;
`RegionClient` (docs/net.md) counts `loaded` events among the group's ids.

`verifyHashes`: when true, the `ctx` passed to `backend.load` has `verify: true`; core backends pass
`integrity: entry.hash` to `fetch` (a browser then also enforces it natively) and always hash the fetched bytes with
`sha256Sri`, rejecting with `AssetIntegrityError { id, expected, actual }` on mismatch. The manual check is not skipped
because `fetchBytes` cannot tell whether `ctx.fetch` enforces `integrity` (injected fetches and wrappers do not); it
costs one extra digest per asset and only when `verifyHashes` is on.

## 4. Backends

```ts
export interface BackendContext {
  loader: AssetLoader;            // for peek(dep)
  id: AssetId;
  verify: boolean;
  fetch: typeof fetch;            // AssetLoaderOptions.fetch ?? globalThis.fetch, wrapped so calling it as ctx.fetch(...) is safe
  progress(loaded: number, total: number): void;   // emits `progress` while the load is current and not aborted
}

export interface AssetBackend<T> {
  readonly type: AssetType;
  load(url: string, entry: AssetEntry, signal: AbortSignal, ctx: BackendContext): Promise<T>;
  dispose(asset: T): void;
}

export class AssetLoadError extends Error { constructor(readonly id: AssetId, readonly url: string, readonly status: number) }
export class AssetNetworkError extends Error { constructor(readonly id: AssetId, readonly url: string, cause: unknown) }   // no response, or the body broke off
export function transientError(error: unknown): boolean;   // AssetNetworkError, or an AssetLoadError of 5xx, 408 or 429: the loader tries again
export class AssetIntegrityError extends Error { constructor(readonly id: AssetId, readonly expected: string, readonly actual: string) }
```

Shared helper `fetchBytes(url, entry, signal, ctx): Promise<ArrayBuffer>`: `ctx.fetch(url, { signal, integrity:
ctx.verify ? entry.hash : undefined })` (the key is omitted when not verifying); non-2xx -> `AssetLoadError`, no
response (or a body that broke off) -> `AssetNetworkError` unless the signal aborted it; reads the
body via `response.arrayBuffer()`, then `signal.throwIfAborted()`; when `ctx.verify`, hashes the bytes and rejects
with `AssetIntegrityError` on mismatch (section 3.2); streaming progress is not required in v1;
`ctx.progress(size, size)` on completion.

| Backend           | type       | load returns                          | dispose  |
| ----------------- | ---------- | ------------------------------------- | -------- |
| `JsonBackend`     | `json`     | `JSON.parse(text)` (`unknown`)         | no-op    |
| `BinaryBackend`   | `binary`   | `ArrayBuffer`                          | no-op    |
| `AudioBackend`    | `audio`    | `ArrayBuffer` (decoding is a game concern; games wrap with `AudioContext.decodeAudioData`) | no-op |
| `GltfMetaBackend` | `model`    | `ModelMeta` (section 5.4)              | no-op    |

`TextureBackend` is not core: textures are embedded in `.glb` files by convention; a game that needs standalone
textures registers its own backend in `@conduit/render`.

### 4.1 GLB parsing (`src/glb.ts`, isomorphic)

```ts
export const GLB_MAGIC = 0x46546c67;      // 'glTF'
export const GLB_VERSION = 2;
export const GLB_CHUNK_JSON = 0x4e4f534a; // 'JSON'
export const GLB_CHUNK_BIN = 0x004e4942;  // 'BIN\0'
export const GLB_HEADER_BYTES = 12;

export interface GlbParsed { json: GltfJson; bin: ArrayBuffer | null; byteLength: number }
export type GlbErrorCode = 'bad_magic' | 'bad_version' | 'truncated' | 'no_json_chunk' | 'bad_json';
export class GlbParseError extends Error { constructor(readonly code: GlbErrorCode, message: string) }
export function parseGlb(buf: ArrayBuffer | Uint8Array, opts?: { jsonOnly?: boolean }): GlbParsed;
```

```
parseGlb(buf, jsonOnly=false):
  dv = DataView(buf); if byteLength < 12: throw truncated
  if dv.getUint32(0, LE) != GLB_MAGIC: throw bad_magic
  if dv.getUint32(4, LE) != 2: throw bad_version
  total = dv.getUint32(8, LE); if total > byteLength: throw truncated
  off = 12; json = null; bin = null
  while off + 8 <= total:
    len = dv.getUint32(off, LE); type = dv.getUint32(off+4, LE); off += 8
    if off + len > total: throw truncated
    if type == JSON and json == null: json = JSON.parse(utf8(buf, off, len))   (throw bad_json on failure)
    else if type == BIN and !jsonOnly and bin == null: bin = buf.slice(off, off+len)
    off += len + pad4(len)
    if json and jsonOnly: break
  if !json: throw no_json_chunk
  return { json, bin, byteLength: total }
```

`GltfJson` is a minimal structural type: `{ asset: { version: string }, scene?: number, scenes?: { name?, nodes?:
number[] }[], nodes?: GltfNode[], meshes?: { name? }[], animations?: { name? }[], buffers?: { uri? }[], images?:
{ uri? }[], extensionsRequired?: string[], extensionsUsed?: string[] }` with `GltfNode = { name?, mesh?,
children?: number[], translation?: [n,n,n], rotation?: [n,n,n,n], scale?: [n,n,n], matrix?: number[16], extras? }`.

`GltfMetaBackend.load` = `fetchBytes` -> `parseGlb(bytes, { jsonOnly: true })` -> `deriveModelMeta(json, ctx.id)`.
`new GltfMetaBackend()` takes no options and imports neither `three` nor Node built-ins, so servers and headless
clients (docs/game.md §4) register it where a rendering client registers render's `GltfBackend` (same `meta`). The
whole file is fetched (and hashed when `verify`), but its BIN chunk is never scanned or copied. A Node server that
reads its built assets from disk supplies them through `AssetLoaderOptions.fetch`.

## 5. Blender and glTF conventions

These rules are what `checkModelNaming` enforces and what `deriveModelMeta` reads. Anything not listed is a game
concern (materials, texture resolution, polygon budgets).

### 5.1 Blender scene setup

Verified with Blender 5.2.2 LTS and its bundled exporter, Khronos glTF Blender I/O 5.2.40 (the `asset.generator` it
writes): `examples/sandbox/scripts/make-models.py` builds the sandbox's `crate` and `vehicle` (`.blend` and `.glb` in
`examples/sandbox/assets/`) headless with the settings below (`EXPORT_OPTIONS`, each commented with its dialog path),
and `conduit-assets check` passes on the exports. Other Blender versions may move or rename these options.

| Rule | Blender setting / action |
| --- | --- |
| Units | Scene Properties > Units: Metric, Unit Scale 1.0, Length Meters. 1 Blender unit = 1 m. |
| Transforms | Select the visual meshes only, then `Ctrl+A` > All Transforms before export, so every visual mesh node exports with identity rotation and unit scale. Never apply transforms to `_COL_*` colliders or `SOCKET_*` empties, so never "select all": their object transform is the data (their TRS is the collider or the socket), and applying moves a socket to the origin and bakes a collider's scale into its vertices, leaving unit scale. |
| Orientation | Model the front facing Blender −Y. Export with `+Y Up` on (default). The exporter maps Blender −Y front to glTF +Z, giving the core convention **forward = +Z, up = +Y, right = −X** in glTF/Three space. |
| Root | One top-level object per file named `<root>` where `<root>` = asset id with every `.` replaced by `_` (`ship.sloop` -> `ship_sloop`). Every other object is parented under it. Root at world origin, identity TRS. |
| Custom properties | Object custom properties become glTF `extras` (Export > Include > Data > Custom Properties on). Values must be JSON scalars, arrays or objects. |
| Include | Export > Include > Limit to: leave every option off. Colliders are usually hidden from render in Blender (Object Properties > Visibility > Renders off, as `make-models.py` does); with Renderable Objects on the exporter drops them, and Visible Objects likewise drops anything hidden in the viewport. |
| Modifiers | Export > Data > Mesh > Apply Modifiers on. |
| Compression | Export > Data > Draco Compression **off** and Data > Meshopt Compression **off**: v1 loaders set no decoder, and `checkModelNaming` reports either extension as `draco_required`. |
| Textures | Export > Material > Images: Automatic; Format `.glb` so images are embedded. No external `uri` in `buffers[]` or `images[]`. |
| Animations | Each animation is a separate Action pushed down to its own NLA track, exported with Export > Animation > Animation Mode: NLA Tracks. Name each **track** in lowercase snake_case: the track name, not the Action name, becomes the clip name in `animations[].name`, and a track left at its default name exports as `NlaTrack` (fails `animation_name`). |

### 5.2 Node naming

All names are matched exactly (case-sensitive). `<root>` below is the root object name.

| Pattern | Meaning |
| --- | --- |
| `<root>` | Root node. Exactly one node in scene 0's `nodes` may have this name; it must be a top-level scene node. |
| `<root>_LOD0`, `<root>_LOD1`, `<root>_LOD2` | LOD meshes, direct children of root, contiguous from 0, at most 3. Extra `lodDistance` (number, metres, distance at which this level becomes active) defaults `LOD_DISTANCES = [0, 50, 150]`. If no `_LOD` children exist, the root's own mesh (and any non-special descendants) is LOD0. |
| `<root>_COL_box`, `<root>_COL_sphere`, `<root>_COL_capsule`, `<root>_COL_convex`, each optionally suffixed `.NNN` (Blender's duplicate suffix, three digits) | Collider primitives, direct children of root, hidden from render. Geometry is ignored except for `convex` (see 5.4). Shape derived from TRS: box = unit cube scaled, so `halfExtents = scale * 0.5`; sphere `radius = max(scale.x, scale.y, scale.z)`; capsule `radius = scale.x`, `height = scale.y` (total end-to-end length along local +Y, caps included). Author box colliders as a 1 m cube (Add > Mesh > Cube, Size 1 m, not the 2 m default) and sphere colliders as a UV sphere of radius 1, then scale the object (never apply its scale); a capsule's reference mesh is only a visual guide, its scale encodes `(radius, height, radius)`. |
| `SOCKET_<name>`, `<name>` matching `[a-z0-9_]+` | Attachment points, empties (no `mesh`), anywhere in the hierarchy. Transform is root-relative when composed. |
| anything else | Ordinary visual node, rendered as part of LOD0 (or of the `_LODn` subtree it lives in). |

These patterns apply to glTF node names. three's `GLTFLoader` sanitises `Object3D.name` (it removes `.`, `:`, `/`,
`[` and `]`, and replaces whitespace with `_`) and keeps the original in `userData.name`, so `ship_sloop_COL_convex.001`
becomes `ship_sloop_COL_convex001` in a loaded scene. Code matching these patterns on three objects (docs/render.md
`ModelBinder`) uses `userData.name ?? name`, or the node indices in `ModelMeta`.

### 5.3 Regular expressions and constants

```ts
export const ROOT_NAME = (id: AssetId) => id.replace(/\./g, '_');
export const LOD_RE = /^(.+)_LOD([0-2])$/;
export const COLLIDER_RE = /^(.+)_COL_(box|sphere|capsule|convex)(?:\.(\d{3}))?$/;
export const SOCKET_RE = /^SOCKET_([a-z0-9_]+)$/;
export const ANIMATION_NAME_RE = /^[a-z][a-z0-9_]*$/;
export const LOD_DISTANCES: readonly number[] = [0, 50, 150];
export const MAX_LOD_LEVELS = 3;
export const DRACO_EXTENSION = 'KHR_draco_mesh_compression';
export const MESHOPT_EXTENSIONS: readonly string[] = ['EXT_meshopt_compression', 'KHR_meshopt_compression'];
export const IDENTITY_EPSILON = 1e-5;
```

### 5.4 `ModelMeta`

```ts
export interface GltfNodeMeta {
  index: number; name: string; mesh: number | null; children: number[];
  translation: Vec3; rotation: Quat; scale: Vec3;          // @conduit/math plain objects; matrix decomposed if present
  extras: Record<string, unknown>;
}

export interface LodMeta { name: string; node: number; distance: number }

export type ColliderMeta =
  | { kind: 'box';     name: string; node: number; halfExtents: Vec3; position: Vec3; rotation: Quat }
  | { kind: 'sphere';  name: string; node: number; radius: number;    position: Vec3 }
  | { kind: 'capsule'; name: string; node: number; radius: number; height: number; position: Vec3; rotation: Quat }
  | { kind: 'convex';  name: string; node: number; position: Vec3; rotation: Quat; scale: Vec3 };
  // convex: vertex extraction needs the BIN chunk and is deferred (CONCEPT.md: no mesh colliders in v1);
  // the node reference lets a game read the accessor itself if it must.

export interface SocketMeta { name: string; node: number; position: Vec3; rotation: Quat }   // name without 'SOCKET_' (SOCKET_cannon_l -> 'cannon_l'), as render's ModelInstance.sockets keys

export interface ModelMeta {
  id: AssetId;
  root: string;                 // ROOT_NAME(id)
  rootNode: number | null;      // index into nodes, null when missing (checker reports)
  nodes: GltfNodeMeta[];
  scenes: { name: string; nodes: number[] }[];
  animations: string[];
  lods: LodMeta[];              // sorted by level; empty when the root has no _LOD children
  colliders: ColliderMeta[];
  sockets: SocketMeta[];
  extras: Record<string, unknown>;   // root node extras
}

export function deriveModelMeta(json: GltfJson, id: AssetId): ModelMeta;
```

Derivation:

```
deriveModelMeta(json, id):
  nodes = json.nodes.map(toNodeMeta)             -- matrix -> decompose (math.decomposeMat4); defaults T=0,R=identity,S=1
  root  = ROOT_NAME(id); scene = json.scenes[json.scene ?? 0]
  rootNode = index of first node in scene.nodes with name == root, else null
  animations = json.animations.map(a => a.name ?? '')
  if rootNode == null: return meta with empty lods/colliders/sockets (checker reports root_missing)
  lods = children of rootNode whose name matches LOD_RE with prefix == root
         -> { name, node, distance: typeof extras.lodDistance == 'number' ? extras.lodDistance : LOD_DISTANCES[level] }, sorted by level
  colliders = children of rootNode matching COLLIDER_RE with prefix == root -> shape from node TRS (5.2)
  sockets = every descendant of rootNode (DFS, pre-order) matching SOCKET_RE
         -> position/rotation = compose parent chain from rootNode (exclusive) to node (inclusive):
            p = parent.p + rotate(parent.r, parent.s * node.t); r = parent.r * node.r
  extras = nodes[rootNode].extras
```

### 5.5 Naming checker

```ts
export type NamingErrorCode =
  | 'root_missing' | 'multiple_roots' | 'root_not_top_level' | 'root_transform'
  | 'lod_order' | 'lod_distance' | 'lod_parent'
  | 'collider_shape' | 'collider_parent' | 'collider_has_children' | 'collider_scale'
  | 'socket_name' | 'socket_has_mesh'
  | 'animation_name' | 'animation_duplicate'
  | 'draco_required' | 'external_uri' | 'unapplied_transform';
export interface NamingError { code: NamingErrorCode; node?: string; message: string }
export function checkModelNaming(json: GltfJson, meta: ModelMeta, id: AssetId): NamingError[];
```

"Scene 0" below is the default scene, `json.scenes[json.scene ?? 0]`, the same one `deriveModelMeta` and GLTFLoader use.
When the root is missing or not top-level, the root-relative checks (`lod_order`, `lod_distance`, `lod_parent`,
`collider_parent`) are skipped; everything else still runs. A node whose name has an `_LOD<n>` or `_COL_<shape>` suffix
but a prefix other than `<root>` counts as not a direct child of root (`lod_parent`, `collider_parent`), since
`deriveModelMeta` would silently treat it as visual geometry. Errors carry `node` (the node name) when they concern one
node.

| Code | Condition |
| --- | --- |
| `root_missing` | no node named `ROOT_NAME(id)` in scene 0 |
| `multiple_roots` | scene 0 has more than one top-level node |
| `root_not_top_level` | a node named `<root>` exists but is not in `scene.nodes` |
| `root_transform` | root TRS not identity within `IDENTITY_EPSILON` |
| `lod_order` | `_LODn` levels are not contiguous from 0 (e.g. LOD0 and LOD2 only), n > 2 (any `_LOD<digits>` suffix outside `LOD_RE`), or a level repeats |
| `lod_distance` | `lodDistance` present but not a finite number >= 0, or not strictly increasing by level (a repeated level is skipped) |
| `lod_parent` | a node matching `LOD_RE` is not a direct child of root |
| `collider_shape` | name matches `_COL_` but the shape suffix is not one of the four |
| `collider_parent` | collider not a direct child of root |
| `collider_has_children` | collider node has children |
| `collider_scale` | any scale component <= 0 |
| `socket_name` | name starts with `SOCKET_` but fails `SOCKET_RE` |
| `socket_has_mesh` | socket node has a `mesh` |
| `animation_name` | clip name fails `ANIMATION_NAME_RE` |
| `animation_duplicate` | two clips share a name |
| `draco_required` | `extensionsRequired` or `extensionsUsed` includes `KHR_draco_mesh_compression` or one of `MESHOPT_EXTENSIONS` (compressed geometry needs a decoder the v1 loaders do not set up); one error per extension, whose message names it and the exporter option to turn off |
| `external_uri` | any `buffers[].uri` or `images[].uri` present that does not start with `data:` |
| `unapplied_transform` | a node with a `mesh` that is neither a collider nor a socket (names containing `_COL_` or starting with `SOCKET_`) nor the root (covered by `root_transform`) has non-identity rotation or non-unit scale (warning-level; still fails `check`) |

## 6. Files

### packages/assets/src

| File | Exports |
| --- | --- |
| `index.ts` | re-exports everything below except `node.ts` |
| `manifest.ts` | `Manifest`, `AssetEntry`, `AssetId`, `RegionId`, `AssetType`, `Sha256Sri`, `MANIFEST_VERSION`, `ASSET_ID_RE`, `ASSET_ID_MAX_LENGTH`, `GROUP_NAME_RE`, `SRI_RE`, `ASSET_TYPES`, `MANIFEST_JSON_SCHEMA`, `resolveUrl`, `depsOf` |
| `validate.ts` | `validateManifest`, `assertValidManifest`, `ManifestError`, `ManifestErrorCode`, `ManifestValidationError` |
| `hash.ts` | `sriFromDigest`, `sha256Sri`, `base64Encode` |
| `emitter.ts` | `Emitter<Events>` (`on`, `off`, `emit`; returns unsubscribe) |
| `loader.ts` | `AssetLoader`, `AssetLoaderOptions`, `AssetHandle`, `GroupHandle`, `AssetState`, `Priority`, `LoaderEvents`, `DEFAULT_MAX_CONCURRENT`, `DEFAULT_UNLOAD_GRACE_MS`, `DEFAULT_RETRIES`, `DEFAULT_RETRY_MS` |
| `backend.ts` | `AssetBackend`, `BackendContext`, `AssetLoadError`, `AssetNetworkError`, `AssetIntegrityError`, `transientError`, `fetchBytes` |
| `backends/json.ts` | `JsonBackend` |
| `backends/binary.ts` | `BinaryBackend` |
| `backends/audio.ts` | `AudioBackend` |
| `backends/gltf-meta.ts` | `GltfMetaBackend` |
| `glb.ts` | `parseGlb`, `GlbParsed`, `GlbParseError`, `GlbErrorCode`, `GltfJson`, `GltfNode`, `GLB_MAGIC`, `GLB_VERSION`, `GLB_CHUNK_JSON`, `GLB_CHUNK_BIN`, `GLB_HEADER_BYTES` |
| `model-meta.ts` | `deriveModelMeta`, `ModelMeta`, `GltfNodeMeta`, `LodMeta`, `ColliderMeta`, `SocketMeta`, `ROOT_NAME`, `LOD_RE`, `COLLIDER_RE`, `SOCKET_RE`, `ANIMATION_NAME_RE`, `LOD_DISTANCES`, `MAX_LOD_LEVELS`, `DRACO_EXTENSION`, `MESHOPT_EXTENSIONS`, `IDENTITY_EPSILON` |
| `naming.ts` | `checkModelNaming`, `NamingError`, `NamingErrorCode` |
| `node.ts` | (subpath `@conduit/assets/node`) `buildManifest`, `BuildOptions`, `BuildResult`, `BuildInputError`, `expandPatterns`, `checkManifest`, `CheckOptions`, `CheckFailure`, `CheckCode`, `cli`, `CliIo`, `USAGE`, `idFromPath`, `typeFromExt` |
| `build.ts` | implementation of `buildManifest`, `BuildInputError`, `idFromPath`, `typeFromExt` (returns `AssetType \| null`), `expandPatterns(patterns, ids): { groups, errors }` (Node only; imported by `node.ts`) |
| `check.ts` | implementation of `checkManifest` (Node only) |
| `cli.ts` | argv parsing, `cli` (Node only) |

`package.json` exports: `"." -> ./src/index.ts`, `"./node" -> ./src/node.ts` (docs/consuming.md template).
Dependencies: `@conduit/math` (workspace). Dev: `@types/node`.

### packages/assets/test

| File | Proves |
| --- | --- |
| `manifest.test.ts` | valid fixture passes; each `ManifestErrorCode` is produced by a minimal broken manifest (bad id, bad hash, duplicate url, unknown dep, self dep, a 3-cycle reported once with the full path, unknown group/region asset, duplicate list entry); errors are collected, not short-circuited; `depsOf` returns deps before dependants with no duplicates on a diamond graph |
| `loader-scheduler.test.ts` | with `maxConcurrent = 2` and a backend that resolves on demand: 5 low then 1 high acquired -> the high one starts as soon as a slot frees, before remaining lows; FIFO within a priority; a second `acquire` of an in-flight id does not call the backend again and both promises resolve to the same asset; `stats()` counts |
| `loader-refcount.test.ts` | with injected timers: release to 0 enters `grace`, `peek` still returns the asset, re-acquire within grace cancels the timer and no `dispose`; timer expiry calls `backend.dispose` exactly once, emits `unloaded`, `state` becomes `idle`; release while `loading` (aborting the acquisition's `signal`) aborts the backend signal and the asset is disposed (not emitted `loaded`) when the backend later resolves; the same while `queued` dequeues without a backend call; double `release` is a no-op; error state then re-acquire calls the backend again and resolves |
| `loader-deps.test.ts` | `a` deps `[b]`, `b` deps `[c]`: backend call order is c, b, a (parent never starts before deps loaded); parent resolves after all; releasing `a` to zero and expiring grace cascades a grace period on `b` then `c`; a failing dep rejects the parent and leaves no handles |
| `loader-harness.ts` | (helper) `manifestOf(ids, deps?, types?)`, `ManualBackend` (loads settle on demand; records calls and disposals), `ManualTimers`, `flush()`, `recordEvents(loader)` |
| `fixtures/make-glb.ts` | (helper) `encodeGlb(json, bin?)`, `shipSloopGltf()`, `makeShipSloopGlb()`, `SHIP_SLOOP_ID`, `SHIP_SLOOP_GLB_PATH`; `node packages/assets/test/fixtures/make-glb.ts` rewrites `ship_sloop.glb` byte-for-byte. The fixture: root `ship_sloop` (extras `{ displayName, crew }`), `_LOD0..2` meshes sharing material `hull`, `_COL_box`/`_COL_sphere`/`_COL_capsule`/`_COL_convex.001` meshes sharing material `collider`, empty `deck` holding `SOCKET_cannon_l`/`SOCKET_cannon_r`, `SOCKET_helm`, clips `idle` and `sail`; every mesh has its own accessors and there are no textures (parses in jsdom) |
| `glb-meta.test.ts` | `test/fixtures/ship_sloop.glb` (generated by `test/fixtures/make-glb.ts`, committed, checked to be reproducible): `parseGlb` reads header and JSON chunk, `jsonOnly` skips BIN; `bad_magic`, `bad_version`, `truncated`, `no_json_chunk` each thrown for a corrupted copy; `deriveModelMeta` yields root `ship_sloop`, 3 LODs with distances `[0, 50, 150]` overridden by an extra on LOD2 (=200), a box collider with halfExtents from scale, a sphere radius = max scale, a capsule radius/height, a `SOCKET_cannon_l` with composed transform under a nested empty, animations `['idle', 'sail']`; `GltfMetaBackend` in Node through a real `AssetLoader` (`verifyHashes` on) whose `fetch` stub serves files from disk: `ship_sloop.glb` gives `deriveModelMeta`'s result, the sandbox's `examples/sandbox/assets/vehicle.glb` a box collider with halfExtents (1, 0.75, 2), `SOCKET_horn` z > 0 and `SOCKET_camera` z < 0; a BIN chunk whose length runs past the end still loads (only the JSON chunk is parsed); `dispose` is a no-op (grace expiry and `loader.dispose()` leave the meta intact); aborting a loading acquisition aborts the fetch signal and nothing is loaded or disposed, whether the fetch honours or ignores the signal; a non-GLB file rejects with `GlbParseError` |
| `naming.test.ts` | each `NamingErrorCode` is produced by a mutated copy of the fixture JSON; the unmodified fixture yields `[]`; meshopt extensions report `draco_required`, one error per extension |
| `build.test.ts` | temp dir with nested files: ids derived per `idFromPath`, types per extension, output names `<name>.<8-hex>.<ext>`, `manifest.json` sorted and valid; `--graph` with a `WorldGraphJson` fixture fills `regions`; unknown region asset -> error and no files written; `--clean` removes stale outputs; `conduit-assets.json` groups expand `prefix.*`; duplicate id collision reported |
| `check.test.ts` | check of a fresh build passes; modifying one byte -> `hash_mismatch` and `size_mismatch` as applicable; deleting a file -> `missing_file`; a `.glb` whose root is misnamed -> `root_missing` and exit code 2 through `cli` |

## Resource estimates and optional pressure policies

Backends may implement `estimate(asset, entry): ResourceEstimate`. Each resource has a process-local
object identity and `cpuBytes`, `gpuBytes`, `retainedSourceBytes` costs, using `null` when unknown.
`ResourceLedger` counts a shared identity once across owners, retains it until the last owner leaves,
and conservatively uses the largest conflicting known estimate while keeping unknown ownership
explicit. Estimates are detached metadata; they never freeze or change the asset itself.

`AssetLoader.memoryStats()` reports known estimated bytes and unknown resource counts per domain,
plus pressure, evictions, rejected optional prefetch, estimate errors and instance owners. CPU and
source domains can overlap (binary/audio buffers are both decoded CPU storage and retained source);
do not add these domains to infer total resident memory. `loadedDownloadBytes` is the manifest's
transfer-size sum for loaded/grace records, not retained source RAM or a measurement of all network
retries. GPU values model supported upload bytes, not exact driver residency or compiled programs.

Use optional `AssetLoaderOptions.memoryBudget.soft`/`.hard` domain limits and `maxPendingLoads`
only after measuring your content and choosing budgets. There are no default byte limits. Hard
limits are a pressure/admission policy, never permission to invalidate live handles or a promise of
a physical memory ceiling. Required high-priority assets may exceed them; unknown costs also report
pressure for configured domains. New optional low-priority loads can reject with `AssetBudgetError`
under hard/unknown pressure. Pending-load bounds apply explicitly to new queued/loading records,
including dependencies; existing acquisitions and handles remain valid. Budget errors are not
transient download failures and do not start an automatic retry/reload loop.

Under pressure, only zero-reference grace entries are evicted: low priority first, then least recent
acquisition, then largest known exclusive reclaimable estimate as a tie-break, then asset ID. Grace
may shorten; releasing a parent can make its dependencies eligible in the same pass. Referenced
assets and instance owners are never selected. If live/unknown costs alone exceed limits, pressure
remains visible so the consumer can select lower-detail content or reduce its own demands. With
budgets omitted, the existing grace, reacquisition, cancellation, retry and dependency behavior stays.

`loader.trackResources(estimate)` returns an idempotent `ResourceOwner` with `update` and `release`.
It accounts consumer/instance-owned resources; the caller still performs their physical disposal.
It does not convert a template-owned resource into an instance-owned resource. The optional Step 9
observer receives static asset load/queue/reference, estimate/unknown, pressure and eviction metrics;
raw asset IDs, payloads and errors are absent from those diagnostic records. A broken observer or
estimate cannot fail a successful asset load; broken/missing estimates become explicit unknown costs.
