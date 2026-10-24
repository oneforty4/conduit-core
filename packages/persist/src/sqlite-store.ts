import type { DatabaseSync } from 'node:sqlite';
import type { BlobStore } from './blob-store.ts';
import { BoundStore } from './bound-store.ts';
import { BlobStoreError } from './errors.ts';
import { prefixUpperBound, validateKey, validateNamespace, validateValue } from './keys.ts';
import { Mutex } from './mutex.ts';
import { openNodeSqlite, type SqliteDriver, type SqliteStatement } from './sqlite-driver.ts';

export interface SqliteStoreOptions {
  /** `PRAGMA journal_mode=WAL`; default true. Never applied to `':memory:'`. */
  wal?: boolean;
}

const TABLES_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'blob_*'";

/**
 * Keys are read back as bytes: Node 22's node:sqlite truncates TEXT results at U+0000 (Spike 6).
 * `ignoreBOM` keeps a leading U+FEFF, which a default decoder would strip.
 */
const utf8 = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * BlobStore over one node:sqlite connection (docs/persist.md 1.6): a `blob_<ns>` table per
 * namespace, created on first use, WAL journal, cached prepared statements. `db` is shared with
 * `migrate` and the lobby's SQL.
 */
export class SqliteStore implements BlobStore {
  readonly path: string;
  readonly db: DatabaseSync;
  private readonly driver: SqliteDriver;
  private readonly mutex = new Mutex();
  /** Names of the `blob_*` tables known to exist. */
  private readonly tables = new Set<string>();
  /** Tables created while the open transaction runs; its rollback drops them again. */
  private txTables: string[] = [];
  private readonly stmts = new Map<string, SqliteStatement>();
  private bound: BoundStore | null = null;
  /** Transaction nesting: 1 inside the outermost `fn`, +1 per running `tx.transaction`, else 0. */
  private depth = 0;
  private isClosed = false;

  /**
   * Opens `path` (`':memory:'` allowed) and applies the pragmas. Driver failures throw
   * `BlobStoreError('io')`; a missing node:sqlite throws `openNodeSqlite`'s error unchanged.
   */
  constructor(path: string, opts: SqliteStoreOptions = {}) {
    this.path = path;
    this.db = open(path);
    this.driver = this.db;
    try {
      if (opts.wal !== false && path !== ':memory:') this.driver.exec('PRAGMA journal_mode=WAL');
      this.driver.exec('PRAGMA synchronous=NORMAL');
      this.driver.exec('PRAGMA busy_timeout=5000');
      this.driver.exec('PRAGMA foreign_keys=ON');
      for (const row of this.driver.prepare(TABLES_SQL).all()) {
        const name = field(row, 'name');
        if (typeof name === 'string') this.tables.add(name);
      }
    } catch (err) {
      try {
        this.db.close();
      } catch {
        // Already unusable; the setup error below is the one to report.
      }
      throw openError(path, err);
    }
  }

  /** True after `close()`; every method then rejects `closed`. */
  get closed(): boolean {
    return this.isClosed;
  }

  async get(ns: string, key: string): Promise<Uint8Array | null> {
    this.assertOpen();
    validateNamespace(ns);
    validateKey(key);
    const table = this.table(ns);
    const row = this.io(() => this.stmt(`SELECT value FROM ${table} WHERE key = ?`).get(key));
    if (row === undefined) return null;
    const value = field(row, 'value');
    if (!(value instanceof Uint8Array)) {
      throw new BlobStoreError(
        'io',
        `${table} holds a non-BLOB value for key ${JSON.stringify(key)}`,
      );
    }
    return value; // node:sqlite allocates a fresh array per call
  }

  async put(ns: string, key: string, blob: Uint8Array): Promise<void> {
    this.assertOpen();
    validateNamespace(ns);
    validateKey(key);
    validateValue(blob);
    const table = this.table(ns);
    const sql =
      `INSERT INTO ${table} (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) ` +
      'DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at';
    // Binding copies the view's bytes (SQLITE_TRANSIENT), so later mutation of `blob` is harmless.
    this.io(() => this.stmt(sql).run(key, blob, Date.now()));
  }

  async delete(ns: string, key: string): Promise<void> {
    this.assertOpen();
    validateNamespace(ns);
    validateKey(key);
    const table = this.table(ns);
    this.io(() => this.stmt(`DELETE FROM ${table} WHERE key = ?`).run(key));
  }

  async list(ns: string, prefix = ''): Promise<string[]> {
    this.assertOpen();
    validateNamespace(ns);
    validateKey(prefix, true);
    const table = this.table(ns);
    const upper = prefixUpperBound(prefix);
    // BINARY collation compares UTF-8 bytes, so ORDER BY key is compareKeys order and the range
    // [prefix, upper) walks the primary key.
    const select = `SELECT CAST(key AS BLOB) AS key_bytes FROM ${table} WHERE key >= ?`;
    const rows = this.io(() =>
      upper === null
        ? this.stmt(`${select} ORDER BY key`).all(prefix)
        : this.stmt(`${select} AND key < ? ORDER BY key`).all(prefix, upper),
    );
    return rows.map((row) => {
      const bytes = field(row, 'key_bytes');
      if (!(bytes instanceof Uint8Array)) {
        throw new BlobStoreError('io', `${table} holds a NULL key`);
      }
      return utf8.decode(bytes);
    });
  }

  /**
   * Runs `fn` in `BEGIN IMMEDIATE ... COMMIT` (docs/persist.md 1.4, 1.6). Always waits for the
   * mutex, even when called from inside another transaction's `fn`; nest through `tx.transaction`.
   */
  async transaction<T>(fn: (tx: BlobStore) => T | Promise<T>): Promise<T> {
    this.assertOpen();
    return this.mutex.run(async () => {
      this.assertOpen(); // closed while this call waited
      this.io(() => this.driver.exec('BEGIN IMMEDIATE'));
      const bound = new BoundStore(this);
      this.bound = bound;
      this.depth = 1;
      try {
        const result = await fn(bound);
        this.assertOpen(); // closing the connection inside fn already rolled the transaction back
        this.io(() => this.driver.exec('COMMIT'));
        return result;
      } catch (err) {
        this.rollback();
        throw err;
      } finally {
        this.depth = 0;
        this.bound = null;
        this.txTables = [];
        bound.close();
      }
    });
  }

  /**
   * `BoundStore` owner hook behind `tx.transaction(fn)`: runs `fn` inside the open transaction,
   * without the mutex or a savepoint. Rejects `tx_closed` when no transaction is open.
   */
  async nested<T>(fn: (tx: BlobStore) => T | Promise<T>): Promise<T> {
    this.assertOpen();
    const bound = this.bound;
    if (bound === null) throw new BlobStoreError('tx_closed', 'no transaction is open');
    this.depth++;
    try {
      return await fn(bound);
    } finally {
      // An inner fn left running past its outer transaction must not disturb the next one.
      if (this.bound === bound) this.depth--;
    }
  }

  /**
   * Closes the connection; idempotent. SQLite rolls back a transaction still open. Every later
   * call rejects `closed`, including transactions that were waiting for the mutex.
   */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.stmts.clear();
    this.tables.clear();
    try {
      this.db.close();
    } catch (err) {
      throw ioError(err);
    }
  }

  private assertOpen(): void {
    if (this.isClosed) {
      throw new BlobStoreError('closed', `SqliteStore ${JSON.stringify(this.path)} is closed`);
    }
  }

  /** The table of an already validated namespace, created on first use. */
  private table(ns: string): string {
    const table = `blob_${ns}`;
    if (!this.tables.has(table)) {
      this.io(() =>
        this.driver.exec(
          `CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value BLOB NOT NULL, ` +
            'updated_at INTEGER NOT NULL) WITHOUT ROWID',
        ),
      );
      this.tables.add(table);
      if (this.bound !== null) this.txTables.push(table); // DDL is transactional
    }
    return table;
  }

  /** The cached prepared statement for `sql`, prepared on first use. */
  private stmt(sql: string): SqliteStatement {
    let statement = this.stmts.get(sql);
    if (statement === undefined) {
      statement = this.driver.prepare(sql);
      this.stmts.set(sql, statement);
    }
    return statement;
  }

  /** Runs a driver call, wrapping its exceptions as `BlobStoreError('io')`. */
  private io<T>(op: () => T): T {
    try {
      return op();
    } catch (err) {
      throw ioError(err);
    }
  }

  private rollback(): void {
    for (const table of this.txTables) this.tables.delete(table);
    if (this.isClosed) return;
    try {
      this.driver.exec('ROLLBACK');
    } catch {
      // SQLite already ended the transaction (e.g. after SQLITE_FULL); there is nothing to undo.
    }
  }
}

function open(path: string): DatabaseSync {
  try {
    return openNodeSqlite(path);
  } catch (err) {
    if (isNodeSqliteMissing(err)) throw err; // keep openNodeSqlite's actionable message and code
    throw openError(path, err);
  }
}

function isNodeSqliteMissing(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ERR_UNKNOWN_BUILTIN_MODULE';
}

/** Column `name` of a node:sqlite result row (a plain object keyed by column name). */
function field(row: unknown, name: string): unknown {
  return typeof row === 'object' && row !== null
    ? (row as Record<string, unknown>)[name]
    : undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function ioError(err: unknown): BlobStoreError {
  return new BlobStoreError('io', messageOf(err), { cause: err });
}

function openError(path: string, err: unknown): BlobStoreError {
  const message = `cannot open SQLite database ${JSON.stringify(path)}: ${messageOf(err)}`;
  return new BlobStoreError('io', message, { cause: err });
}
