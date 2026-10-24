import { openNodeSqlite } from '../src/index.ts';

/**
 * Why tests that need node:sqlite are skipped in this Node process (openNodeSqlite's actionable
 * message, also printed as a warning), or null when node:sqlite is available. Any other failure to
 * open an in-memory database is a real error and throws.
 */
export function nodeSqliteSkipReason(): string | null {
  try {
    openNodeSqlite(':memory:').close();
    return null;
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ERR_UNKNOWN_BUILTIN_MODULE') {
      console.warn(`Skipping node:sqlite tests. ${err.message}`);
      return err.message;
    }
    throw err;
  }
}
