import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MigrationError,
  SqliteStore,
  migrate,
  openNodeSqlite,
  schemaVersion,
  type Migration,
  type MigrationErrorCode,
} from '../src/index.ts';
import { nodeSqliteSkipReason } from './node-sqlite.ts';

const skipReason = nodeSqliteSkipReason();

const MIGRATIONS: Migration[] = [
  { version: 1, up: ['CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL)'] },
  {
    version: 2,
    up: [
      'ALTER TABLE accounts ADD COLUMN created_at INTEGER',
      'CREATE INDEX accounts_name ON accounts (name)',
    ],
  },
  {
    version: 3,
    up: [
      'CREATE TABLE friends (a INTEGER NOT NULL, b INTEGER NOT NULL, PRIMARY KEY (a, b)) WITHOUT ROWID; ' +
        "INSERT INTO accounts (name) VALUES ('system')",
    ],
  },
];

function hasTable(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/** Every schema object, for "modifies nothing" comparisons. */
function schema(db: DatabaseSync): unknown[] {
  return db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all();
}

function versionRows(db: DatabaseSync): unknown[] {
  return db.prepare('SELECT version, applied_at FROM schema_version ORDER BY version').all();
}

/** Rows changed through this connection so far. */
function totalChanges(db: DatabaseSync): unknown {
  return db.prepare('SELECT total_changes() AS n').get()?.n;
}

function migrationError(fn: () => void, code: MigrationErrorCode): MigrationError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(MigrationError);
  expect(caught).toMatchObject({ name: 'MigrationError', code });
  return caught as MigrationError;
}

describe.skipIf(skipReason !== null)(
  skipReason === null ? 'migrate' : `migrate (skipped: ${skipReason})`,
  () => {
    const opened: DatabaseSync[] = [];

    function freshDb(): DatabaseSync {
      const db = openNodeSqlite(':memory:');
      opened.push(db);
      return db;
    }

    afterEach(() => {
      for (const db of opened.splice(0)) db.close();
    });

    it('applies 1..3 in order and records applied_at', () => {
      const db = freshDb();
      expect(schemaVersion(db)).toBe(0);
      expect(hasTable(db, 'schema_version')).toBe(false); // schemaVersion only reads

      const before = Date.now();
      migrate(db, MIGRATIONS);
      const after = Date.now();

      expect(schemaVersion(db)).toBe(3);
      const rows = db
        .prepare('SELECT version, applied_at FROM schema_version ORDER BY version')
        .all();
      expect(rows.map((row) => row.version)).toEqual([1, 2, 3]);
      for (const row of rows) {
        expect(row.applied_at).toBeGreaterThanOrEqual(before);
        expect(row.applied_at).toBeLessThanOrEqual(after);
      }
      expect(hasTable(db, 'accounts')).toBe(true);
      expect(hasTable(db, 'friends')).toBe(true);
      expect(db.prepare('SELECT name, created_at FROM accounts').all()).toEqual([
        { name: 'system', created_at: null },
      ]);
    });

    it('applies only the migrations newer than the database', () => {
      const db = freshDb();
      migrate(db, MIGRATIONS.slice(0, 1));
      expect(schemaVersion(db)).toBe(1);
      const firstRow = versionRows(db);
      migrate(db, MIGRATIONS); // re-running version 1's CREATE TABLE would throw
      expect(schemaVersion(db)).toBe(3);
      expect(versionRows(db).slice(0, 1)).toEqual(firstRow);
    });

    it('a second run is a no-op', () => {
      const db = freshDb();
      migrate(db, MIGRATIONS);
      const rows = versionRows(db);
      const objects = schema(db);
      const changes = totalChanges(db);
      migrate(db, MIGRATIONS);
      expect(schemaVersion(db)).toBe(3);
      expect(versionRows(db)).toEqual(rows);
      expect(schema(db)).toEqual(objects);
      expect(totalChanges(db)).toBe(changes);
    });

    it('a database at version 3 with a 2-migration list throws db_ahead and modifies nothing', () => {
      const db = freshDb();
      migrate(db, MIGRATIONS);
      const rows = versionRows(db);
      const objects = schema(db);
      const changes = totalChanges(db);

      const err = migrationError(() => migrate(db, MIGRATIONS.slice(0, 2)), 'db_ahead');
      expect(err.version).toBe(3);

      expect(versionRows(db)).toEqual(rows);
      expect(schema(db)).toEqual(objects);
      expect(totalChanges(db)).toBe(changes);
      expect(schemaVersion(db)).toBe(3);
    });

    it("a migration whose second statement fails leaves the first statement's table absent", () => {
      const failing: Migration = {
        version: 2,
        up: ['CREATE TABLE half_done (x INTEGER)', 'INSERT INTO missing_table VALUES (1)'],
      };
      const [first] = MIGRATIONS;
      if (first === undefined) throw new Error('MIGRATIONS is empty');

      // From an empty database: version 1 commits in its own transaction, version 2 rolls back.
      const db = freshDb();
      const err = migrationError(() => migrate(db, [first, failing]), 'failed');
      expect(err.version).toBe(2);
      expect(err.cause).toBeInstanceOf(Error);
      expect(err.message).toContain('missing_table');
      expect(hasTable(db, 'accounts')).toBe(true);
      expect(hasTable(db, 'half_done')).toBe(false);
      expect(schemaVersion(db)).toBe(1);

      // From version 1: the version does not change, and the connection is not left in a transaction.
      const again = migrationError(() => migrate(db, [first, failing]), 'failed');
      expect(again.version).toBe(2);
      expect(hasTable(db, 'half_done')).toBe(false);
      expect(schemaVersion(db)).toBe(1);
      migrate(db, [first, { version: 2, up: ['CREATE TABLE half_done (x INTEGER)'] }]);
      expect(schemaVersion(db)).toBe(2);
      expect(hasTable(db, 'half_done')).toBe(true);
    });

    it('a list starting at 2, with a gap or otherwise malformed throws bad_list before touching the database', () => {
      const ok = ['SELECT 1'];
      const lists: [string, unknown][] = [
        ['starting at 2', [{ version: 2, up: ok }]],
        [
          'with a gap',
          [
            { version: 1, up: ok },
            { version: 3, up: ok },
          ],
        ],
        [
          'with a repeated version',
          [
            { version: 1, up: ok },
            { version: 1, up: ok },
          ],
        ],
        ['with version 0', [{ version: 0, up: ok }]],
        ['with a fractional version', [{ version: 1.5, up: ok }]],
        ['with a string version', [{ version: '1', up: ok }]],
        ['with an empty up', [{ version: 1, up: [] }]],
        ['with a non-string statement', [{ version: 1, up: ['SELECT 1', 42] }]],
        ['with a null entry', [null]],
        ['that is not an array', { version: 1, up: ok }],
      ];
      for (const [label, list] of lists) {
        const db = freshDb();
        const err = migrationError(() => migrate(db, list as Migration[]), 'bad_list');
        expect(err.version, label).toBeUndefined();
        expect(hasTable(db, 'schema_version'), label).toBe(false);
      }
    });

    it('does not roll back a transaction the caller left open', () => {
      const db = freshDb();
      db.exec('BEGIN');
      db.exec('CREATE TABLE callers_table (x INTEGER)');
      const err = migrationError(() => migrate(db, MIGRATIONS), 'failed');
      expect(err.version).toBe(1);
      db.exec('COMMIT'); // still open: migrate's BEGIN IMMEDIATE failed and nothing was rolled back
      expect(hasTable(db, 'callers_table')).toBe(true);
      expect(hasTable(db, 'accounts')).toBe(false);
    });

    it('runs on SqliteStore.db next to blob tables and persists across reopening', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'conduit-persist-migrate-'));
      try {
        const path = join(dir, 'host.sqlite');
        const store = new SqliteStore(path);
        migrate(store.db, MIGRATIONS);
        await store.put('session', 's1', new Uint8Array([1]));
        store.close();

        const reopened = new SqliteStore(path);
        try {
          expect(schemaVersion(reopened.db)).toBe(3);
          migrate(reopened.db, MIGRATIONS);
          expect(versionRows(reopened.db)).toHaveLength(3);
          expect(await reopened.list('session')).toEqual(['s1']);
        } finally {
          reopened.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
