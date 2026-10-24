import type * as NodeSqlite from 'node:sqlite';
import type { DatabaseSync } from 'node:sqlite';

/** A value bound to a `?` parameter. */
export type SqliteParam = string | number | bigint | Uint8Array | null;

/** The prepared-statement members SqliteStore and migrate use; node:sqlite's `StatementSync` has them. */
export interface SqliteStatement {
  run(...params: SqliteParam[]): { changes: number | bigint };
  /** The first result row as an object keyed by column name, or `undefined`. */
  get(...params: SqliteParam[]): unknown;
  all(...params: SqliteParam[]): unknown[];
}

/**
 * The connection members SqliteStore and migrate use (docs/persist.md 1.6.1). node:sqlite's
 * `DatabaseSync` satisfies it structurally; a `better-sqlite3` adapter would be a second `open*`
 * function in this file.
 */
export interface SqliteDriver {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/** Node's code for a missing built-in module, kept so callers can tell this failure apart. */
const UNAVAILABLE_CODE = 'ERR_UNKNOWN_BUILTIN_MODULE';

/**
 * Opens `path` (`':memory:'` allowed) with node:sqlite. This is the only file that loads
 * node:sqlite at runtime, and it does so on the first call rather than at import, so importing
 * `@conduit/persist` works where the module is missing. There, it throws an `Error` with
 * `code: 'ERR_UNKNOWN_BUILTIN_MODULE'` and a message saying which Node version and flag to use.
 */
export function openNodeSqlite(path: string): DatabaseSync {
  // process.getBuiltinModule (Node >= 22.3; node:sqlite itself arrived in 22.5) loads a built-in
  // synchronously and returns undefined when the module is unavailable.
  const sqlite: typeof NodeSqlite | undefined = process.getBuiltinModule?.('node:sqlite');
  if (sqlite === undefined) {
    throw Object.assign(
      new Error(
        `node:sqlite is not available in Node.js ${process.version}: run Node 24+, or Node 22 with ` +
          '--experimental-sqlite (e.g. NODE_OPTIONS=--experimental-sqlite; only needed before 22.13), ' +
          'and do not pass --no-experimental-sqlite.',
      ),
      { code: UNAVAILABLE_CODE },
    );
  }
  return new sqlite.DatabaseSync(path);
}
