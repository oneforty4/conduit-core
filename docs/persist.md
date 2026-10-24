# @conduit/persist and @conduit/auth

Sessions now publish atomic application save generations. See [generation saves](generation-saves.md) for the framework/game versions, bounded storage, migration contracts and manifest-aware reader. The raw BlobStore contract below remains unchanged.

Packages `packages/persist` and `packages/auth`. Both are `node` packages (CONCEPT.md layout): they may use `node:sqlite`, `node:crypto`, timers and the wall clock. Neither imports any other conduit package; `auth` has no dependencies at all. Consumers: `@conduit/net-server` (Session persistence, handshake verification), `@conduit/lobby` (accounts, tokens), `@conduit/host` (SqliteStore ownership, ProxyBlobStore over the worker port, docs/host.md), `@conduit/game` (`createServer` dev token, docs/game.md).

Cross-references: docs/net.md (Session, flushAll, handshake), docs/host.md (ProxyBlobStore, StoreBridge, HOST_SECRET), docs/protocol.md (Hello payload carrying `sessionToken`), docs/game.md (`createServer` `devAuth` option), docs/world.md (region blobs written through BlobStore).

---

## Part 1: @conduit/persist

### 1.1 Package

- `package.json`: `"exports": { ".": "./src/index.ts", "./testing": "./src/testing.ts" }`. No runtime dependencies. `vitest` is a devDependency; only `src/testing.ts` imports it and only tests import `./testing`.
- Requires Node >= 22. `node:sqlite` is stable from Node 24; on Node 22.5 to 22.12 the process must run with `--experimental-sqlite` (22.13+ loads it without the flag but prints an `ExperimentalWarning`). When it is unavailable, `openNodeSqlite` (1.6.1) throws an actionable error, which the CLI in docs/host.md prints. A `better-sqlite3` fallback is out of scope; section 1.6.1 defines the driver seam it would plug into.
- Spike 6 (M4), `pnpm vitest run --project @conduit/persist` (all 6 test files): Node 24.21.0 and 26.7.0 green with no flag and no warning; Node 22.23.2 green both with `NODE_OPTIONS=--experimental-sqlite` and without it (warning printed); Node 22.12.0 (vitest additionally needs `--experimental-strip-types` for the `.ts` presets) green with the flag, and without it prints the actionable error and skips the node:sqlite tests. `--no-experimental-sqlite` on 22.23.2/24.21.0/26.7.0 gives the same error and skip. Node 22's node:sqlite truncates TEXT results at U+0000, so `list` reads keys as bytes (1.6).
- Namespaces used by core (docs/net.md, docs/world.md): `region`, `session`, `player`. Games may add their own namespaces subject to the rules below.

### 1.2 BlobStore

```ts
export interface BlobStore {
  get(ns: string, key: string): Promise<Uint8Array | null>;
  put(ns: string, key: string, blob: Uint8Array): Promise<void>;
  delete(ns: string, key: string): Promise<void>;
  list(ns: string, prefix?: string): Promise<string[]>;
  transaction<T>(fn: (tx: BlobStore) => T | Promise<T>): Promise<T>;
}
```

Constants (`src/keys.ts`):

| Name | Value |
| --- | --- |
| `NAMESPACE_RE` | `/^[a-z_]+$/` |
| `MAX_NAMESPACE_CHARS` | `64` |
| `MAX_KEY_BYTES` | `256` (UTF-8 bytes) |
| `MAX_BLOB_BYTES` | `67108864` (64 MiB) |

Rules, enforced identically by every implementation (MemoryStore, SqliteStore, docs/host.md's ProxyBlobStore):

- **Namespace**: matches `NAMESPACE_RE`, length 1..`MAX_NAMESPACE_CHARS`. Otherwise the returned promise rejects with `BlobStoreError('bad_namespace')`. Because the pattern excludes everything but `[a-z_]`, a namespace may be interpolated into a SQL identifier without quoting.
- **Key**: a non-empty, well-formed string (`key.isWellFormed()`, i.e. no lone surrogates) whose UTF-8 encoding is <= `MAX_KEY_BYTES`. Otherwise `BlobStoreError('bad_key')`. `prefix` (for `list`) follows the same rules except that it may be empty; empty or omitted means "all keys".
- **Value**: a `Uint8Array` of length 0..`MAX_BLOB_BYTES`. Otherwise `BlobStoreError('bad_value')`. A zero-length blob is a stored value, distinct from `null` (absent).
- **Copy semantics**: `put` copies the bytes before returning; later mutation of the caller's array does not change the stored value. `get` returns a fresh array each call; mutating it does not change the stored value.
- **`delete`** of an absent key is a no-op and resolves.
- **`list`** returns keys sorted by Unicode code point order, which equals UTF-8 byte order (`compareKeys`, 1.3). Only keys with `key.startsWith(prefix)` are returned. A namespace never written returns `[]`.
- **Validation is asynchronous**: every method returns a promise; validation failures reject rather than throw synchronously.
- **All methods return promises even when the implementation is synchronous** (SqliteStore, `node:sqlite` is synchronous). Reasons: interface parity between MemoryStore, SqliteStore, ProxyBlobStore (worker side, genuinely asynchronous) and the deferred Postgres adapter; and callers (Session flush, RegionManager save/evict) already await at those points, so no hot path pays for it.

Errors (`src/errors.ts`):

```ts
export type BlobStoreErrorCode = 'bad_namespace' | 'bad_key' | 'bad_value' | 'tx_closed' | 'closed' | 'io';
export class BlobStoreError extends Error {
  readonly code: BlobStoreErrorCode;
  constructor(code: BlobStoreErrorCode, message: string, options?: { cause?: unknown });
}
```

`io` wraps driver failures (`cause` set). `closed` is returned by any call after `SqliteStore.close()`. `tx_closed` is returned by calls on a transaction-bound store after its transaction ended (1.4).

### 1.3 Key helpers (`src/keys.ts`)

```ts
export function validateNamespace(ns: string): void;       // throws BlobStoreError('bad_namespace')
export function validateKey(key: string, allowEmpty?: boolean): void;   // throws BlobStoreError('bad_key')
export function validateValue(blob: Uint8Array): void;      // throws BlobStoreError('bad_value')
export function compareKeys(a: string, b: string): number;  // code point order == UTF-8 byte order
export function prefixUpperBound(prefix: string): string | null;
```

- `compareKeys`: iterate both strings by code point (`codePointAt`), compare numerically; shorter prefix sorts first. Do not use `<` on strings (UTF-16 code unit order differs for supplementary characters: `'\u{1F600}' < ''` in JS, but the reverse in UTF-8).
- `prefixUpperBound(prefix)` returns the smallest string strictly greater than every string that starts with `prefix`, or `null` when no bound exists:
  1. If `prefix === ''` return `null`.
  2. Let `last` be the last code point of `prefix`, `head` the rest.
  3. If `last === 0x10FFFF`: return `prefixUpperBound(head)`.
  4. Let `next = last + 1`; if `next === 0xD800` set `next = 0xE000` (skip surrogates).
  5. Return `head + String.fromCodePoint(next)`.
  Correctness: UTF-8 is prefix-free and preserves code point order, so for any string `s` starting with `prefix`, `s < head + next` bytewise, and any string `>= head + next` does not start with `prefix`.

### 1.4 Transaction semantics

Common to all implementations:

- `transaction(fn)` calls `fn(tx)` where `tx` is a `BlobStore` bound to the transaction. Writes through `tx` are visible to later reads through `tx` within `fn` (read-your-writes).
- If `fn` returns (or its promise resolves), the transaction commits and `transaction` resolves with `fn`'s value. If `fn` throws (or rejects), the transaction rolls back every write made through `tx` since the outermost `transaction` began, and `transaction` rejects with the **same error object**.
- **Nesting**: `tx.transaction(fn2)` reuses the outer transaction. `transaction` on the root store never nests, even when called from inside `fn`: it queues on the mutex behind the open transaction (so awaiting it from inside `fn` never completes; nest through `tx`). There are no savepoints: an inner `fn2` that throws does not roll anything back by itself; the rollback happens only if the error propagates out of the outermost `fn`. If the outer `fn` catches the inner error and returns normally, the inner writes are committed with the rest.
- **Bound store lifetime**: after the outermost transaction commits or rolls back, every method on the `tx` object rejects with `BlobStoreError('tx_closed')`. Implementations use `BoundStore` (`src/bound-store.ts`): a thin `BlobStore` that forwards `get/put/delete/list` to the owner while `open === true`, forwards `transaction` as a nested (reusing) call through `owner.nested(fn)`, and rejects after `close()`.
- **Serialization**: every `transaction` call on the root store is serialized through a `Mutex` (1.9): a second concurrent `transaction` waits for the first to finish, including one started while the first's `fn` is suspended at an `await`. A `depth > 0` check in `transaction` must therefore not decide nesting (it would let an unrelated caller join the open transaction); only `nested` reuses it. Nested calls (made through `tx`) bypass the mutex.
- **Root-store operations during an open transaction** (`get/put/delete/list` on the root store object, not `tx`, while another caller's transaction is open): permitted but not isolated. In SqliteStore they execute on the same connection and therefore inside the open transaction; in MemoryStore they are included in the snapshot/restore. Core code never does this (Session runs one flush at a time); the contract suite does not test it.
- `fn` may be synchronous or asynchronous. Awaiting inside `fn` is allowed; the transaction stays open across the await.

### 1.5 MemoryStore (`src/memory-store.ts`)

```ts
export class MemoryStore implements BlobStore {
  constructor();
  get; put; delete; list; transaction;                       // BlobStore
  nested<T>(fn: (tx: BlobStore) => T | Promise<T>): Promise<T>;   // BoundStore owner hook (1.4); rejects 'tx_closed' when no transaction is open
  size(ns?: string): number;                                 // key count (all namespaces when omitted)
  clear(): void;
}
```

- Storage: `Map<string /*ns*/, Map<string /*key*/, Uint8Array>>`. `put` stores `new Uint8Array(blob)` (a fresh plain copy; not `blob.slice()`, which returns a view when `blob` is a `Buffer`). `get` returns `stored.slice()`. Stored arrays are never mutated in place, so they may be shared by snapshots.
- `list`: filter by `startsWith(prefix)`, sort with `compareKeys`.
- `transaction`: after acquiring the mutex, take `snapshot = new Map(ns => new Map(inner))` (shallow copy of every inner map; blob arrays are shared, which is safe because they are immutable). Create a `BoundStore` and keep it as the open one. Run `fn(tx)`. On success: discard the snapshot. On throw: replace the live map with the snapshot, rethrow. In `finally`: clear the open bound store, close it, release the mutex. `nested(fn)` (reached through `tx.transaction`): run `fn(tx)` with the open bound store, no snapshot handling.
- Cost is O(total keys) per outermost transaction; MemoryStore is for tests and `createServer` dev mode, not production.

### 1.6 SqliteStore (`src/sqlite-store.ts`)

```ts
export interface SqliteStoreOptions { wal?: boolean }                  // default true
export class SqliteStore implements BlobStore {
  readonly path: string;
  readonly db: DatabaseSync;                                           // shared with migrate() and lobby SQL
  constructor(path: string, opts?: SqliteStoreOptions);
  get; put; delete; list; transaction;                                 // BlobStore
  nested<T>(fn: (tx: BlobStore) => T | Promise<T>): Promise<T>;        // BoundStore owner hook (1.4)
  close(): void;                                                       // idempotent; later calls reject 'closed'
  readonly closed: boolean;
}
```

Constructor:

1. `this.db = openNodeSqlite(path)` (1.6.1; `':memory:'` allowed).
2. Pragmas, in this order, via `db.exec`: `PRAGMA journal_mode=WAL` (skipped when `wal === false` or `path === ':memory:'`), `PRAGMA synchronous=NORMAL`, `PRAGMA busy_timeout=5000`, `PRAGMA foreign_keys=ON`.
3. Read existing `blob_*` table names from `sqlite_master` into `tables: Set<string>`.

A driver failure in these steps closes the connection and throws `BlobStoreError('io')` whose message names the path (`cause` set); `openNodeSqlite`'s unavailable error is rethrown unchanged.

Tables, one per namespace, created lazily on the first operation naming that namespace (including `get`/`list`):

```sql
CREATE TABLE IF NOT EXISTS blob_<ns> (
  key        TEXT    PRIMARY KEY,
  value      BLOB    NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
```

`updated_at` is `Date.now()` (unix ms). `ensureTable(ns)`: validate, check `tables`, else exec the DDL and add to the set. DDL is transactional: a table created while a transaction is open disappears if it rolls back, so the rollback also removes those names from `tables` (otherwise the next operation on that namespace fails with `no such table`).

Prepared-statement cache: `stmts: Map<string, StatementSync>` keyed by SQL text; `stmt(sql)` returns the cached statement or prepares and caches it. Statements per namespace:

| Op | SQL |
| --- | --- |
| get | `SELECT value FROM blob_<ns> WHERE key = ?` |
| put | `INSERT INTO blob_<ns> (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at` |
| delete | `DELETE FROM blob_<ns> WHERE key = ?` |
| list, no bound | `SELECT CAST(key AS BLOB) AS key_bytes FROM blob_<ns> WHERE key >= ? ORDER BY key` |
| list, bounded | `SELECT CAST(key AS BLOB) AS key_bytes FROM blob_<ns> WHERE key >= ? AND key < ? ORDER BY key` |

- `list(ns, prefix = '')`: `upper = prefixUpperBound(prefix)`; bind `prefix` (and `upper` when non-null). SQLite's default `BINARY` collation compares UTF-8 bytes, so `ORDER BY key` equals `compareKeys` order and the range uses the primary key index. Keys are selected as bytes and decoded with `new TextDecoder('utf-8', { ignoreBOM: true })` (which keeps a leading U+FEFF): Node 22's node:sqlite truncates TEXT results at U+0000 (Spike 6, 1.1).
- `get`: `stmt.get(key)`; the driver returns `value` as a `Uint8Array`; return it as is (the driver allocates a fresh one per call; verify with the copy-semantics contract case). Missing row → `null`.
- `put`: validate value, bind the `Uint8Array` directly (bind as BLOB), `updated_at = Date.now()`.
- Driver exceptions are wrapped: `new BlobStoreError('io', e.message, { cause: e })`.

Transactions (`depth` re-entrancy counter, `mutex`):

```
transaction(fn):                      // root store: always through the mutex (1.4)
  if closed: reject 'closed'
  return mutex.run(async () => {
    db.exec('BEGIN IMMEDIATE'); depth = 1; bound = new BoundStore(this)
    try { const r = await fn(bound); db.exec('COMMIT'); return r }
    catch (e) { try { db.exec('ROLLBACK') } catch {} ; throw e }
    finally { depth = 0; bound.close() }
  })

nested(fn):                           // tx.transaction: reuse the open transaction
  depth++; try { return await fn(bound) } finally { depth-- }
```

`BEGIN IMMEDIATE` takes the write lock up front so a transaction never fails midway with `SQLITE_BUSY`; `busy_timeout=5000` covers the (single-process) case of a WAL checkpoint holding the lock.

`close()`: `db.close()`, `closed = true`, clear the statement cache. Every later method rejects `BlobStoreError('closed')`.

#### 1.6.1 Driver seam (`src/sqlite-driver.ts`)

```ts
export interface SqliteStatement {
  run(...params: SqliteParam[]): { changes: number | bigint };
  get(...params: SqliteParam[]): unknown;
  all(...params: SqliteParam[]): unknown[];
}
export type SqliteParam = string | number | bigint | Uint8Array | null;
export interface SqliteDriver { exec(sql: string): void; prepare(sql: string): SqliteStatement; close(): void }
export function openNodeSqlite(path: string): DatabaseSync;   // the only file that loads 'node:sqlite' at runtime; others use `import type`
```

`openNodeSqlite` loads the module on its first call with `process.getBuiltinModule('node:sqlite')`, never at import, so `@conduit/persist` (MemoryStore, Autosaver) imports fine where node:sqlite is missing. There `getBuiltinModule` returns `undefined`, and `openNodeSqlite` throws an `Error` with `code: 'ERR_UNKNOWN_BUILTIN_MODULE'` (Node's code for a missing built-in; the host CLI can check it to choose exit code 3) and the message `node:sqlite is not available in Node.js <version>: run Node 24+, or Node 22 with --experimental-sqlite (e.g. NODE_OPTIONS=--experimental-sqlite; only needed before 22.13), and do not pass --no-experimental-sqlite.` Tests that need node:sqlite skip with that message as the reason.

`DatabaseSync` satisfies `SqliteDriver` structurally. `SqliteStore` and `migrate` use only `SqliteDriver` members. A `better-sqlite3` adapter would be a second `open*` function in this file returning an object with the same three members; `SqliteStore.db` stays typed as `DatabaseSync` for `migrate` and the lobby, which is why that fallback is out of scope rather than free.

### 1.7 migrate (`src/migrate.ts`)

```ts
export interface Migration { version: number; up: string[] }             // version >= 1, contiguous
export type MigrationErrorCode = 'db_ahead' | 'bad_list' | 'failed';
export class MigrationError extends Error {
  readonly code: MigrationErrorCode; readonly version?: number;
  constructor(code: MigrationErrorCode, message: string, options?: { version?: number; cause?: unknown });
}
export function migrate(db: DatabaseSync, migrations: Migration[]): void;
export function schemaVersion(db: DatabaseSync): number;                 // 0 when the table is absent
```

```sql
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
```

Algorithm (synchronous):

1. Validate the list: versions are positive integers, strictly increasing, `migrations[i].version === i + 1` (contiguous from 1); each `up` is a non-empty array of strings. Otherwise `MigrationError('bad_list')`.
2. Create `schema_version` if absent.
3. `current = SELECT COALESCE(MAX(version), 0) FROM schema_version`.
4. If `current > migrations.length` → `MigrationError('db_ahead')` with `version = current`. Nothing is modified. (The code is older than the database; refusing prevents a downgrade from touching a newer schema.)
5. For each migration with `version > current`, in order: `BEGIN IMMEDIATE`; `db.exec(stmt)` for each entry of `up` in order; `INSERT INTO schema_version (version, applied_at) VALUES (?, Date.now())`; `COMMIT`. On any throw after `BEGIN IMMEDIATE`: `ROLLBACK`, then throw `MigrationError('failed')` with `version` and `cause`. SQLite DDL is transactional, so a failed migration leaves no partial tables. If `BEGIN IMMEDIATE` itself fails (e.g. the precondition below is violated), throw `failed` without `ROLLBACK`, so a transaction the caller left open is not rolled back.

A database error in steps 2-3 throws `MigrationError('failed')` without `version`.
6. Re-running with the same list is a no-op (idempotent): `current === migrations.length`.

Precondition: not called inside an open `SqliteStore.transaction`. The host calls `migrate(store.db, lobbyMigrations)` once at startup (docs/host.md).

### 1.8 Autosaver (`src/autosaver.ts`)

```ts
export const AUTOSAVE_INTERVAL_MS = 60_000;
export interface AutosaverOptions {                                   // timers injectable for tests; default the globals
  onError?: (err: unknown) => void;
  setTimeout?(callback: () => void, ms: number): unknown;              // a returned handle with unref() is unref'd
  clearTimeout?(handle: unknown): void;
}
export class Autosaver {
  constructor(fn: () => Promise<void>, intervalMs?: number, opts?: AutosaverOptions);   // intervalMs default AUTOSAVE_INTERVAL_MS; RangeError outside (0, 2^31 - 1]
  start(): void;
  stop(): Promise<void>;
  flush(): Promise<void>;
  readonly running: boolean;      // start() called and stop() not yet called
  readonly inFlight: boolean;     // a call to fn is pending
  readonly lastSavedAt: number | null;
  readonly lastError: unknown;
}
```

State: `timer`, `current: Promise<void> | null` (the in-flight save), `queued: Promise<void> | null` (one follow-up save shared by everyone who called `flush()` during `current`; cleared when it starts, not when it settles).

- `start()`: idempotent. `running = true`; arm a `setTimeout(tick, intervalMs)` (`.unref()` when available; the host's shutdown path calls `stop()` explicitly). A `setTimeout` chain is used, not `setInterval`, so a slow save never overlaps the next timer: the next timer is armed after the tick's save settles.
- `tick()`: if `current` or `queued` is set, skip (do not queue) and re-arm; else `run()` then re-arm (if still running).
- `run()`: `current = fn().then(ok => lastSavedAt = now, err => { lastError = err; onError?.(err); throw err }).finally(() => current = null)`; returns `current`. A synchronous throw from `fn` is treated as a rejection.
- `flush()`, checked in this order:
  - `queued` exists (not started yet) → return `queued`.
  - no save in flight → `run()`; return it.
  - save in flight → `queued = current.catch(() => {}).then(() => { queued = null; return run() })`; return `queued`.
  `queued` is checked first because `current` is already null during the microtasks between the end of a save and the start of its follow-up: a `flush()` (or tick) that tested `current` first there would start a second save concurrently with the follow-up.
  Guarantee: after `await flush()` resolves, every write made before `flush()` was called has been passed through one complete `fn` call that started after those writes.
- `stop()`: idempotent (a repeated call returns the first call's promise until `start()` is called again). `running = false`, `clearTimeout(timer)`, then `await flush()` (one final save, coalesced with any in flight). Resolves after that save. If `start()` was never called, `stop()` still performs the final flush (so `stop()` is always a safe "save now and halt").
- Errors from `fn` are reported through `onError` (default `console.error`) and rethrown to `flush()`/`stop()` callers; the timer keeps running after a failed save.

### 1.9 Mutex (`src/mutex.ts`)

```ts
export class Mutex {
  run<T>(fn: () => Promise<T> | T): Promise<T>;   // FIFO; fn runs when every earlier run() has settled
  readonly locked: boolean;                       // true from a run() call until its fn settles (running or waiting)
}
```

Implemented as a promise chain: `const prev = this.tail; let release; this.tail = new Promise(r => release = r); await prev; try { return await fn() } finally { release() }`.

### 1.10 Contract suite (`src/testing.ts`, subpath `@conduit/persist/testing`)

```ts
export interface StoreFixture { store: BlobStore; close(): Promise<void> }
export function storeContract(name: string, factory: () => Promise<StoreFixture>): void;
```

Registers a vitest `describe(name)` block; `factory` runs in `beforeEach`, `close` in `afterEach`. Every `BlobStore` implementation in the repo (MemoryStore, SqliteStore, docs/host.md ProxyBlobStore) must pass all cases:

| Case | Proves |
| --- | --- |
| `round-trip` | `put` then `get` returns equal bytes; `get` of an absent key is `null`; a namespace never written lists `[]` |
| `overwrite` | second `put` replaces; `get` returns the second value |
| `delete` | `delete` removes; `get` → `null`; `delete` of an absent key resolves |
| `empty blob` | zero-length value round-trips as `Uint8Array(0)`, not `null` |
| `binary safe` | a 256-byte value containing every byte 0..255 and a 1 MiB seeded pseudo-random value round-trip exactly |
| `copy on put / get` | mutating the source after `put` does not change `get`; mutating the array returned by `get` does not change the next `get`; the same for a `Buffer` source, and a `subarray` view stores exactly the view's bytes |
| `list ordering and prefix` | keys `['b', 'a/2', 'a', 'a/1', '\u{1F600}', '', 'é']` list as `['a', 'a/1', 'a/2', 'b', 'é', '', '\u{1F600}']`; prefix `'a/'` → `['a/1','a/2']`; prefix `'a'` → `['a','a/1','a/2']`; prefix `'zz'` → `[]`; prefix `''` lists every key; prefixes `'\u{E000}'` and `'\u{1F600}'` list only that key |
| `namespaces are isolated` | same key in `ns` `a` and `b` holds different values; `list` per namespace |
| `validation` | namespace `'Bad'`, `'a-b'`, `''`, 65 chars reject `bad_namespace`; key `''`, a 257-byte key, a lone surrogate reject `bad_key` (also as a `list` prefix); a non-Uint8Array value rejects `bad_value`; every method returns a rejected promise, never a synchronous throw; a 64-char namespace and 256-byte keys are accepted |
| `transaction commit` | writes through `tx` visible through `tx` before commit (read-your-writes, including `list`) and through the root store after |
| `transaction rollback` | `put`, overwrite and `delete` through `tx` then `throw err`; `transaction` rejects with the identical `err`; every affected key reads as before the transaction; a synchronous throw also rejects with the identical error |
| `nested reuses outer` | inner `tx.transaction` writes; outer throws afterwards; inner writes are rolled back. Inner throws, outer catches and returns; inner writes are committed |
| `bound store closes` | using `tx` (every method) after `transaction` resolved, or after it rolled back, rejects `tx_closed` |
| `transaction returns value` | `transaction(() => 42)` resolves `42`; async `fn` supported |
| `concurrent transactions serialize` | two outermost transactions started without awaiting; the second's `fn` starts after the first's commit; a third started while the first's `fn` is suspended at an `await` also waits (a root-store `transaction` never joins an open one) |
| `concurrent puts to different namespaces` | `Promise.all` of 50 puts spread over 5 namespaces; all values read back; each `list` has 10 keys |

### 1.11 Files: packages/persist

`src/`

| File | Exports |
| --- | --- |
| `index.ts` | re-exports everything below except `testing.ts` |
| `errors.ts` | `BlobStoreError`, `BlobStoreErrorCode` |
| `keys.ts` | `NAMESPACE_RE`, `MAX_NAMESPACE_CHARS`, `MAX_KEY_BYTES`, `MAX_BLOB_BYTES`, `validateNamespace`, `validateKey`, `validateValue`, `compareKeys`, `prefixUpperBound` |
| `blob-store.ts` | `BlobStore` |
| `bound-store.ts` | `BoundStore` (`constructor(owner: BlobStore & { nested<T>(fn): Promise<T> })`, `open`, `close()`) |
| `mutex.ts` | `Mutex` |
| `memory-store.ts` | `MemoryStore` |
| `sqlite-driver.ts` | `SqliteDriver`, `SqliteStatement`, `SqliteParam`, `openNodeSqlite` |
| `sqlite-store.ts` | `SqliteStore`, `SqliteStoreOptions` |
| `migrate.ts` | `Migration`, `MigrationError`, `MigrationErrorCode`, `migrate`, `schemaVersion` |
| `autosaver.ts` | `Autosaver`, `AutosaverOptions`, `AUTOSAVE_INTERVAL_MS` |
| `testing.ts` | `storeContract`, `StoreFixture` (imports `vitest`; subpath export only) |

`test/`

| File | Proves |
| --- | --- |
| `keys.test.ts` | `validateNamespace`/`validateKey`/`validateValue` accept and reject the boundary cases (64-char ns, 256-byte key, 64 MiB value, 65-char ns, 257-byte key); `compareKeys` orders `'' < '\u{1F600}'`; `prefixUpperBound('')` is `null`, `('a')` is `'b'`, `('a퟿')` is `'a'`, `('a\u{10FFFF}')` is `'b'`, `('\u{10FFFF}')` is `null` |
| `memory-store.test.ts` | runs `storeContract('MemoryStore', ...)`; `size()` and `clear()`; snapshot restore leaves untouched namespaces identical |
| `sqlite-store.test.ts` | runs `storeContract('SqliteStore', ...)` against a file in a fresh `fs.mkdtempSync` dir; `PRAGMA journal_mode` reads `wal` (and `memory`/`delete` for `':memory:'`, `wal: false`); table `blob_region` exists only after the first `region` operation; the statement cache holds one entry per SQL text after 100 gets; values survive `close()` and reopening the same path; `list` with prefix `'a'` in a table containing `'a\u{10FFFF}z'` and `'b'` returns only the former; re-entrancy counter returns to 0 after a nested throw (and after an inner `tx.transaction` outlives its outer one); every method after `close()` rejects `closed`, as do an interrupted transaction (rolled back) and ones queued behind it; a namespace first created in a rolled-back transaction works afterwards; keys containing U+0000 or starting with U+FEFF list intact; driver failures reject `io` with `cause`, and opening a non-database file throws `io` naming the path; with `process.getBuiltinModule` stubbed, and in a child `node --no-experimental-sqlite`, `openNodeSqlite` throws the `ERR_UNKNOWN_BUILTIN_MODULE` error (not wrapped by `SqliteStore`). The node:sqlite cases skip, with the error message as the reason, where it is unavailable |
| `migrate.test.ts` | applies 1..3 and records `applied_at`; second run is a no-op (`schemaVersion` unchanged, no new rows); a db at version 3 with a 2-migration list throws `db_ahead` and modifies nothing; a migration whose second statement fails leaves the first statement's table absent and `schemaVersion` unchanged, error `failed` with `version`; a list starting at 2 or with a gap throws `bad_list` (also repeated, zero, fractional or non-number versions, an empty `up`, a non-string statement), before creating `schema_version`; only migrations newer than the database run; a failing `BEGIN IMMEDIATE` does not roll back the caller's open transaction; `migrate(store.db)` next to blob tables persists across reopening. Skips like `sqlite-store.test.ts` |
| `autosaver.test.ts` | with injected timers: `start()` calls `fn` once per interval; a `fn` slower than the interval is never overlapped and the skipped tick is not queued; `flush()` during an in-flight save waits for it and runs `fn` exactly once more, and three concurrent `flush()` calls share that one run; `stop()` cancels the timer and performs one final save; `fn` rejection reaches `onError`, `lastError` and the `flush()` caller, and the next tick still runs; `stop()` without `start()` performs one save; a `flush()` or tick in the microtasks between the end of a save and the start of its queued follow-up starts no extra save; `stop()` during a timed save coalesces behind it and returns the same promise when repeated; a synchronous throw from `fn` is a failed save; `unref()`, the default interval and `console.error`, invalid intervals, and the global timers |
| `mutex.test.ts` | FIFO order over 10 queued runs; a throwing `fn` releases the lock; `locked` reflects state |

---

## Part 2: @conduit/auth

### 2.1 Package

`package.json` `"exports": { ".": "./src/index.ts" }`. No dependencies. Uses `node:crypto` only. All functions are pure given their inputs except `hashPassword` (random salt) and the default `now` of `verifyToken`.

### 2.2 Passwords (`src/password.ts`)

Constants:

| Name | Value |
| --- | --- |
| `SCRYPT_N` | `32768` (2^15) |
| `SCRYPT_R` | `8` |
| `SCRYPT_P` | `1` |
| `SCRYPT_KEYLEN` | `32` |
| `SCRYPT_SALT_BYTES` | `16` |
| `SCRYPT_MAXMEM` | `67108864` (64 MiB; scrypt needs `128 * N * r` = 32 MiB, and Node's default `maxmem` is exactly 32 MiB, which fails) |
| `MIN_PASSWORD_BYTES` | `8` |
| `MAX_PASSWORD_BYTES` | `256` |
| `PASSWORD_HASH_PREFIX` | `'scrypt'` |

```ts
export interface ParsedPasswordHash { N: number; r: number; p: number; salt: Buffer; hash: Buffer }
export function validatePasswordLength(pw: string): boolean;           // MIN <= utf8 bytes <= MAX
export function hashPassword(pw: string): Promise<string>;
export function verifyPassword(pw: string, stored: string): Promise<boolean>;
export function parsePasswordHash(stored: string): ParsedPasswordHash | null;
export function needsRehash(stored: string): boolean;
```

Stored format: `scrypt$<N>$<r>$<p>$<salt b64url>$<hash b64url>` (base64url without padding, 2.5). Example shape: `scrypt$32768$8$1$Q2xpY2tPblRoaXM$...`.

- Password rules: `Buffer.byteLength(pw, 'utf8')` in `[MIN_PASSWORD_BYTES, MAX_PASSWORD_BYTES]`. No other rules (no character classes, no normalization; the string is hashed as given).
- `hashPassword`: throws `AuthError('password_length')` when the length rule fails; `salt = randomBytes(SCRYPT_SALT_BYTES)`; `hash = await scrypt(pw, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM })` (promisified `crypto.scrypt`); return the formatted string.
- `parsePasswordHash`: split on `$`; exactly 6 parts; `parts[0] === 'scrypt'`; `N`, `r`, `p` are decimal integers (digits only: no sign, no leading zeros) with `N` a power of two in `[2^10, 2^22]`, `r` in `[1, 32]`, `p` in `[1, 16]`; salt decodes to 8..64 bytes; hash decodes to 16..64 bytes (base64url per 2.5; a character outside the alphabet fails). Any failure, or a non-string, → `null`.
- `verifyPassword`: never throws. Returns `false` when the password fails the length rule (a non-string fails it) or `stored` does not parse, or when scrypt itself errors. Otherwise derive with the **parsed** `N, r, p`, `keylen = hash.length`, `maxmem = Math.max(SCRYPT_MAXMEM, 256 * N * r)`, and compare with `timingSafeEqual` (lengths equal by construction).
- `needsRehash`: `true` when `stored` does not parse or its `N, r, p, salt.length, hash.length` differ from the current constants. The lobby calls it after a successful login and re-hashes with the new parameters (docs/host.md), which is how the cost is raised later.

### 2.3 Session tokens (`src/token.ts`)

```ts
export const TOKEN_TTL_S = 600;
export const MIN_SECRET_BYTES = 32;
export const MAX_TOKEN_FIELD_CHARS = 256;
export interface SessionToken { accountId: string; displayName: string; sessionId: string; exp: number }   // exp: unix seconds
export interface VerifyTokenOptions { allowExpired?: boolean }     // skip rule 6 (a reconnect Hello, below)
export function nowSeconds(): number;                              // Math.floor(Date.now() / 1000)
export function tokenExpiry(now?: number): number;                 // now + TOKEN_TTL_S
export function isTokenExpired(token: Pick<SessionToken, 'exp'>, now?: number): boolean;   // rule 6 alone: exp <= now (a NaN now is expired)
export function assertSecret(secret: string): void;                // throws AuthError('weak_secret') if utf8 bytes < MIN_SECRET_BYTES
export function mintToken(payload: SessionToken, secret: string): string;
export function verifyToken(token: string, secret: string, now?: number, opts?: VerifyTokenOptions): SessionToken | null;
```

- `secret` is the host's `HOST_SECRET` (docs/host.md config); `assertSecret` runs in both `mintToken` and `verifyToken` and throws (not returns null): a weak secret is a deployment error, not a bad token.
- `mintToken`: `body = base64url(JSON.stringify({ accountId, displayName, sessionId, exp }))` built from a fresh object literal in that key order (extra properties on `payload` are dropped; `exp` must be a finite non-negative integer and the string fields must satisfy rule 5 of `verifyToken`, else `AuthError('bad_payload')`, since such a token could never verify); `sig = base64url(HMAC-SHA256(key = secret, msg = body))`; return `body + '.' + sig`. `body` is the ASCII text of the base64url string, not the JSON bytes.
- `verifyToken(token, secret, now = nowSeconds())` returns `null` (never throws for bad input) when any of these fails, checked in order:
  1. `token` is a string of length <= 4096 matching `/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/`.
  2. `sigBytes = base64urlDecode(sig)` has length 32 and `base64url(sigBytes) === sig` (canonical encoding: the 2 spare bits of the last character are zero, so exactly one signature string verifies).
  3. `timingSafeEqual(sigBytes, HMAC-SHA256(secret, body))`. Always computed before parsing the body so malformed bodies cost the same as valid ones.
  4. `JSON.parse(base64urlDecode(body))` succeeds and is a plain object.
  5. `accountId`, `displayName`, `sessionId` are strings; `accountId` and `sessionId` non-empty; all three <= `MAX_TOKEN_FIELD_CHARS`; `exp` is a finite integer.
  6. `exp > now` (a token with `exp <= now` is expired), skipped with `opts.allowExpired`: an expired token that passes rules 1-5 is then returned, and the caller tells it apart with `isTokenExpired(token, now)`.
  Returns a new object with exactly the four fields.
- Tokens authorize joining one session (`sessionId`); the gateway checks it against the URL path (docs/host.md). A reconnect proves the player with `reconnectToken` from `Welcome` (docs/protocol.md, docs/net.md), but its Hello still carries the client's SessionToken, which lives `TOKEN_TTL_S` and may have expired since the join. So a Hello with a non-empty `reconnectToken` is verified with `allowExpired` (by the gateway, docs/host.md §17, and by the Session's verifier, docs/net.md A.6): a correctly signed expired token still identifies the account and the session, and resumes only the player that reconnect token names. A fresh join always needs an unexpired token.

### 2.4 Verifiers and dev mode (`src/verifier.ts`)

```ts
export const DEV_TOKEN = 'dev';
export interface TokenVerifier {
  readonly dev: boolean;
  verify(token: string, hello: { displayName: string }, now?: number, opts?: VerifyTokenOptions): SessionToken | null;
}
export function hmacVerifier(secret: string): TokenVerifier;                 // calls assertSecret once
export function devVerifier(opts?: { warn?: (msg: string) => void }): TokenVerifier;
export const DEV_AUTH_WARNING = '[conduit/auth] devAuth enabled: session tokens are NOT verified. Never use in production.';
```

- `hmacVerifier(secret).verify(token, hello, now, opts)` = `verifyToken(token, secret, now, opts)`; `hello.displayName` is ignored (identity comes from the token). `dev === false`.
- `devVerifier().verify(token, hello, now = nowSeconds(), opts?)` ignores `opts` (its identities expire `TOKEN_TTL_S` after `now`, so they are never expired) and accepts **any** `token` string, including `DEV_TOKEN` and `''`, and builds the identity from the Hello payload: `name = hello.displayName.trim()`; if `name` is empty or longer than 32 chars, `name = 'anon'`; returns `{ accountId: 'dev:' + name.toLowerCase(), displayName: name, sessionId: 'dev', exp: now + TOKEN_TTL_S }`. Two dev clients with the same display name therefore share an `accountId`, which keeps per-player persistence (`player` namespace) working across dev reconnects; docs/net.md's duplicate-account rule applies to them. `dev === true`.
- `devVerifier` calls `opts.warn ?? console.warn` with `DEV_AUTH_WARNING` exactly once, at construction.
- Wiring: the Session handshake (docs/net.md) takes a `TokenVerifier`. `createServer` (docs/game.md) constructs `devVerifier()` **only** when called with the explicit option `devAuth: true`; otherwise it requires a `secret` and uses `hmacVerifier(secret)`. `createHost` and the gateway (docs/host.md) never construct `devVerifier`. `DEV_TOKEN` is what `createClient` sends in `Hello.sessionToken` when no lobby token is available (docs/game.md); it is just a recognizable placeholder, not a credential.

### 2.5 base64url (`src/base64url.ts`)

```ts
export function base64url(bytes: Uint8Array | string): string;   // strings encoded as UTF-8; no padding; '+'→'-', '/'→'_'
export function base64urlDecode(s: string): Buffer;               // throws AuthError('bad_encoding') on characters outside [A-Za-z0-9_-]
```

Implemented with `Buffer.from(bytes).toString('base64url')` and `Buffer.from(s, 'base64url')` after the character check (Node's decoder silently drops invalid characters, hence the explicit check).

### 2.6 Errors (`src/errors.ts`)

```ts
export type AuthErrorCode = 'password_length' | 'weak_secret' | 'bad_payload' | 'bad_encoding';
export class AuthError extends Error { readonly code: AuthErrorCode; constructor(code: AuthErrorCode, message: string) }
```

### 2.7 Files: packages/auth

`src/`

| File | Exports |
| --- | --- |
| `index.ts` | re-exports everything below |
| `errors.ts` | `AuthError`, `AuthErrorCode` |
| `base64url.ts` | `base64url`, `base64urlDecode` |
| `password.ts` | `SCRYPT_N`, `SCRYPT_R`, `SCRYPT_P`, `SCRYPT_KEYLEN`, `SCRYPT_SALT_BYTES`, `SCRYPT_MAXMEM`, `MIN_PASSWORD_BYTES`, `MAX_PASSWORD_BYTES`, `PASSWORD_HASH_PREFIX`, `ParsedPasswordHash`, `validatePasswordLength`, `hashPassword`, `verifyPassword`, `parsePasswordHash`, `needsRehash` |
| `token.ts` | `TOKEN_TTL_S`, `MIN_SECRET_BYTES`, `MAX_TOKEN_FIELD_CHARS`, `SessionToken`, `VerifyTokenOptions`, `nowSeconds`, `tokenExpiry`, `isTokenExpired`, `assertSecret`, `mintToken`, `verifyToken` |
| `verifier.ts` | `DEV_TOKEN`, `DEV_AUTH_WARNING`, `TokenVerifier`, `hmacVerifier`, `devVerifier` |

`test/`

| File | Proves |
| --- | --- |
| `base64url.test.ts` | round-trip of 0..64-byte inputs; no padding characters; `'+'`/`'/'` never appear; the RFC 4648 test vectors in the URL-safe alphabet; strings are encoded as UTF-8 and a typed-array view by its own bytes only; decode returns a `Buffer`; decode rejects `'='`, `'+'`, `'/'`, whitespace and other characters with `bad_encoding` |
| `password.test.ts` | the constants match 2.2; `validatePasswordLength` counts UTF-8 bytes with both bounds inclusive (7 and 257 bytes fail, 8 and 256 pass, four 2-byte characters pass, `''` and a non-string fail); `hashPassword` output matches `/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/`; two hashes of the same password differ (salt) and both verify; wrong password `false`; 7-byte, 257-byte and empty passwords throw `password_length`, 8- and 256-byte pass, a 5-character string of 2-byte characters (10 bytes) passes; the string is hashed as given (a decomposed `é` does not verify against the composed one); `verifyPassword` returns `false` (no throw) for `''`, `'scrypt$x'`, a 5-part string, `N = 3`, a non-string hash, and empty or over-long passwords; a fresh hash with a flipped last character of the hash part still parses but fails; hashes built in the test with `N = 1024`, or `N = 2048, r = 4, p = 2` with an 8-byte salt and a 64-byte key, verify with their stored parameters and `needsRehash` is `true`; `parsePasswordHash` returns a fresh hash's `N`, `r`, `p`, salt and hash (as `Buffer`s), accepts the bounds (`N` 2^10 and 2^22, `r` 1 and 32, `p` 1 and 16, salt 8 and 64 bytes, hash 16 and 64 bytes) and returns `null` for everything else (wrong part count or prefix, `N` not a power of two or out of range, leading zeros, signs, decimals, empty parts, out-of-range `r`/`p`/lengths, characters outside base64url, a non-string); `needsRehash` is `false` for a fresh hash and `true` for any other `N`, `r`, `p`, salt or key length and for unparseable input |
| `token.test.ts` | the constants match 2.3; `nowSeconds` is the wall clock in whole seconds and `tokenExpiry(100)` is `700`; `isTokenExpired` is rule 6 (`exp <= now` expired, `exp === now + 1` not, a `NaN` now expired, the wall clock by default); `assertSecret` counts UTF-8 bytes (31 fail, 32 pass); mint/verify round-trip returns exactly the four fields; the token has two `.`-separated base64url parts; `verifyToken` is `null` for: wrong secret, one flipped signature character, one flipped body character, missing `.`, three parts, empty string, a body that is not JSON, a body missing `sessionId`, `exp` as a string, `exp === now`, `exp < now`, a signature whose last character has a spare bit set; `exp === now + 1` verifies; `now` default uses the wall clock (a token with `exp = nowSeconds() + 600` verifies); a 31-byte secret throws `weak_secret` in both mint and verify; a 32-byte secret is accepted; `exp = 1.5` throws `bad_payload`, as do `exp` negative, `NaN`, infinite or a string, an empty `accountId`/`sessionId`, a non-string `displayName` and a 257-char field; extra payload fields are not encoded; with `allowExpired` a correctly signed token with `exp` at or before `now` is returned (and a valid one too), while a wrong secret, a flipped signature or body character, a non-JSON body, a string or fractional `exp` and an empty `sessionId` still return `null`, and a weak secret still throws |
| `verifier.test.ts` | `hmacVerifier` delegates to `verifyToken` and ignores `displayName`, passes `allowExpired` through (an expired token verifies only with it; a forged one never), defaults `now` to the wall clock and asserts the secret at construction; `devVerifier` accepts `DEV_TOKEN`, `''` and garbage, yields `accountId 'dev:alice'` for `displayName ' Alice '`, `'dev:anon'` for `''` and for a 33-character name, `sessionId 'dev'`, `exp = now + 600`; `devVerifier` ignores `allowExpired` (its identities never expire), and two clients with the same display name get the same `accountId`; the warning is emitted once via the injected `warn` at construction and not on `verify`, and through `console.warn` by default |
