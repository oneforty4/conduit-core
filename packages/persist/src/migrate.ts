import type { DatabaseSync } from 'node:sqlite';
import type { SqliteDriver } from './sqlite-driver.ts';

/** One schema step (docs/persist.md 1.7). `migrations[i].version` must be `i + 1`. */
export interface Migration {
  version: number;
  /** SQL run in order inside one transaction; an entry may hold several statements. */
  up: string[];
}

export type MigrationErrorCode =
  | 'db_ahead' // the database is at a newer version than the list knows; nothing was modified
  | 'bad_list' // versions not contiguous from 1, or an `up` that is not a non-empty string array
  | 'failed'; // a database error; `version` names the migration that was rolled back, if any

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
  readonly code: MigrationErrorCode;
  /** `db_ahead`: the database's version. `failed`: the migration that failed. */
  readonly version?: number;

  constructor(
    code: MigrationErrorCode,
    message: string,
    options: { version?: number; cause?: unknown } = {},
  ) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined);
    this.code = code;
    if (options.version !== undefined) this.version = options.version;
  }
}

const CREATE_SCHEMA_VERSION = `CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
)`;

/**
 * Applies every migration newer than the database's version, each in its own `BEGIN IMMEDIATE`
 * transaction, and records it in `schema_version` (docs/persist.md 1.7). Re-running with the same
 * list is a no-op. Must not be called inside an open `SqliteStore.transaction`.
 */
export function migrate(db: DatabaseSync, migrations: Migration[]): void {
  validateMigrations(migrations);
  const driver: SqliteDriver = db;
  let current: number;
  try {
    driver.exec(CREATE_SCHEMA_VERSION);
    current = readVersion(driver);
  } catch (cause) {
    throw new MigrationError('failed', `cannot read the schema version: ${messageOf(cause)}`, {
      cause,
    });
  }
  if (current > migrations.length) {
    throw new MigrationError(
      'db_ahead',
      `the database is at schema version ${current} but only ${migrations.length} migrations ` +
        'are known; refusing to touch a newer schema',
      { version: current },
    );
  }
  for (const migration of migrations.slice(current)) apply(driver, migration);
}

/** The highest applied migration version, or 0 when `schema_version` does not exist. */
export function schemaVersion(db: DatabaseSync): number {
  const driver: SqliteDriver = db;
  const table = driver
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
    .get();
  return table === undefined ? 0 : readVersion(driver);
}

function validateMigrations(migrations: Migration[]): void {
  if (!Array.isArray(migrations)) throw badList('migrations must be an array');
  migrations.forEach((migration: Migration | null | undefined, i) => {
    const version = migration?.version;
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      throw badList(`migrations[${i}].version must be a positive integer, got ${String(version)}`);
    }
    if (version !== i + 1) {
      throw badList(
        `migrations[${i}].version is ${version}; versions must be contiguous from 1 (expected ${i + 1})`,
      );
    }
    const up: unknown = migration?.up;
    if (
      !Array.isArray(up) ||
      up.length === 0 ||
      !up.every((sql: unknown) => typeof sql === 'string')
    ) {
      throw badList(`migration ${version}: up must be a non-empty array of SQL strings`);
    }
  });
}

function apply(driver: SqliteDriver, migration: Migration): void {
  const { version } = migration;
  try {
    driver.exec('BEGIN IMMEDIATE');
  } catch (cause) {
    // Nothing to roll back; above all not a transaction the caller left open.
    throw new MigrationError('failed', `migration ${version}: cannot begin: ${messageOf(cause)}`, {
      version,
      cause,
    });
  }
  try {
    for (const sql of migration.up) driver.exec(sql);
    driver
      .prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)')
      .run(version, Date.now());
    driver.exec('COMMIT');
  } catch (cause) {
    try {
      driver.exec('ROLLBACK');
    } catch {
      // SQLite already rolled the transaction back.
    }
    throw new MigrationError('failed', `migration ${version} failed: ${messageOf(cause)}`, {
      version,
      cause,
    });
  }
}

function readVersion(driver: SqliteDriver): number {
  const row = driver
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_version')
    .get();
  const version = typeof row === 'object' && row !== null && 'version' in row ? row.version : null;
  if (typeof version === 'number') return version;
  if (typeof version === 'bigint') return Number(version);
  throw new Error(`schema_version holds a non-integer version: ${String(version)}`);
}

function badList(message: string): MigrationError {
  return new MigrationError('bad_list', message);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
