import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BlobStoreError,
  SqliteStore,
  compareKeys,
  openNodeSqlite,
  type BlobStoreErrorCode,
  type SqliteDriver,
  type SqliteStoreOptions,
} from '../src/index.ts';
import { storeContract } from '../src/testing.ts';
import { nodeSqliteSkipReason } from './node-sqlite.ts';

const skipReason = nodeSqliteSkipReason();

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function expectBytes(actual: Uint8Array | null, expected: number[]): void {
  expect(actual).toBeInstanceOf(Uint8Array);
  expect(Array.from(actual ?? [])).toEqual(expected);
}

async function expectCode(
  promise: Promise<unknown>,
  code: BlobStoreErrorCode,
): Promise<BlobStoreError> {
  const err = await promise.then(
    () => new Error(`expected a rejection with code ${code}`),
    (reason: unknown) => reason,
  );
  expect(err).toBeInstanceOf(BlobStoreError);
  expect(err).toMatchObject({ code });
  return err as BlobStoreError;
}

/** The single column of a one-row query. */
function scalar(db: DatabaseSync, sql: string): unknown {
  const row = db.prepare(sql).get();
  return row === undefined ? undefined : Object.values(row)[0];
}

function blobTables(db: DatabaseSync): string[] {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'blob_*' ORDER BY name",
    )
    .all()
    .map((row) => String(row.name));
}

describe.skipIf(skipReason !== null)(
  skipReason === null ? 'SqliteStore' : `SqliteStore (skipped: ${skipReason})`,
  () => {
    // Each case gets a database file in a fresh temporary directory.
    storeContract('BlobStore contract on a scratch file', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'conduit-persist-contract-'));
      const store = new SqliteStore(join(dir, 'store.sqlite'));
      return {
        store,
        close: async () => {
          store.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    });

    describe('SQLite specifics', () => {
      let dir = '';
      const opened: SqliteStore[] = [];

      beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'conduit-persist-sqlite-'));
      });

      afterEach(() => {
        for (const store of opened.splice(0)) store.close();
        vi.restoreAllMocks();
        rmSync(dir, { recursive: true, force: true });
      });

      function openStore(name = 'store.sqlite', opts?: SqliteStoreOptions): SqliteStore {
        const store = new SqliteStore(name === ':memory:' ? name : join(dir, name), opts);
        opened.push(store);
        return store;
      }

      it('journal_mode is wal for a file, memory for :memory:, delete with wal: false; other pragmas set', () => {
        const file = openStore('wal.sqlite');
        expect(scalar(file.db, 'PRAGMA journal_mode')).toBe('wal');
        expect(scalar(openStore(':memory:').db, 'PRAGMA journal_mode')).toBe('memory');
        expect(scalar(openStore('rollback.sqlite', { wal: false }).db, 'PRAGMA journal_mode')).toBe(
          'delete',
        );
        expect(scalar(file.db, 'PRAGMA synchronous')).toBe(1); // NORMAL
        expect(scalar(file.db, 'PRAGMA busy_timeout')).toBe(5000);
        expect(scalar(file.db, 'PRAGMA foreign_keys')).toBe(1);
        expect(file.path).toBe(join(dir, 'wal.sqlite'));
      });

      it('creates blob_region only on the first region operation, including get and list', async () => {
        const store = openStore();
        expect(blobTables(store.db)).toEqual([]);
        await store.put('player', 'p1', bytes(1));
        expect(blobTables(store.db)).toEqual(['blob_player']);
        await expectCode(store.get('region', ''), 'bad_key'); // rejected before touching the schema
        expect(blobTables(store.db)).toEqual(['blob_player']);
        expect(await store.get('region', 'cell/0_0')).toBeNull();
        expect(blobTables(store.db)).toEqual(['blob_player', 'blob_region']);
        expect(await store.list('session')).toEqual([]);
        expect(blobTables(store.db)).toEqual(['blob_player', 'blob_region', 'blob_session']);
      });

      it('stores values as BLOBs with updated_at = Date.now()', async () => {
        const store = openStore();
        const before = Date.now();
        await store.put('region', 'full', bytes(1, 2));
        await store.put('region', 'empty', new Uint8Array(0));
        const after = Date.now();
        const rows = store.db
          .prepare('SELECT key, typeof(value) AS type, updated_at FROM blob_region ORDER BY key')
          .all();
        expect(rows.map((row) => [row.key, row.type])).toEqual([
          ['empty', 'blob'],
          ['full', 'blob'],
        ]);
        for (const row of rows) {
          expect(row.updated_at).toBeGreaterThanOrEqual(before);
          expect(row.updated_at).toBeLessThanOrEqual(after);
        }
      });

      it('the statement cache holds one entry per SQL text after 100 gets', async () => {
        const store = openStore();
        await store.put('region', 'k', bytes(1));
        const prepare = vi.spyOn(store.db, 'prepare');
        for (let i = 0; i < 100; i++) {
          expectBytes(await store.get('region', 'k'), [1]);
          expect(await store.get('region', `absent/${i}`)).toBeNull();
        }
        const getSql = 'SELECT value FROM blob_region WHERE key = ?';
        expect(prepare.mock.calls).toEqual([[getSql]]);
        const cache = store['stmts'];
        expect(cache.size).toBe(2); // the put and the get
        expect(cache.has(getSql)).toBe(true);
      });

      it('values survive close() and reopening the same path; existing tables are not re-created', async () => {
        const path = join(dir, 'reopen.sqlite');
        const first = new SqliteStore(path);
        await first.put('region', 'cell/1_2', bytes(1, 2, 3));
        await first.put('player', 'p1', bytes(4));
        first.close();

        const second = openStore('reopen.sqlite');
        const exec = vi.spyOn(second.db, 'exec');
        expectBytes(await second.get('region', 'cell/1_2'), [1, 2, 3]);
        expect(await second.list('player')).toEqual(['p1']);
        expect(exec).not.toHaveBeenCalled();
      });

      it("list with prefix 'a' over 'a\u{10FFFF}z' and 'b' returns only the former", async () => {
        const store = openStore();
        await store.put('ns', 'b', bytes(2));
        await store.put('ns', 'a\u{10FFFF}z', bytes(1));
        expect(await store.list('ns', 'a')).toEqual(['a\u{10FFFF}z']);
        expect(await store.list('ns', 'a\u{10FFFF}')).toEqual(['a\u{10FFFF}z']); // bound carries to 'b'
        expect(await store.list('ns', '\u{10FFFF}')).toEqual([]); // no upper bound
      });

      it('lists keys containing U+0000 or starting with U+FEFF intact', async () => {
        // Node 22's node:sqlite truncates TEXT results at U+0000 (Spike 6), so keys are read as bytes.
        const store = openStore();
        const keys = ['nul\u{0}key', '\u{FEFF}bom', 'plain', 'nul'];
        for (const key of keys) await store.put('ns', key, bytes(1));
        expect(await store.list('ns')).toEqual([...keys].sort(compareKeys));
        expect(await store.list('ns', 'nul\u{0}')).toEqual(['nul\u{0}key']);
        expect(await store.list('ns', '\u{FEFF}')).toEqual(['\u{FEFF}bom']);
        expectBytes(await store.get('ns', 'nul\u{0}key'), [1]);
      });

      it('the re-entrancy counter returns to 0 after a nested throw', async () => {
        const store = openStore();
        const depth = (): number => store['depth'];
        const err = new Error('inner');
        const seen: number[] = [];
        await expect(
          store.transaction(async (tx) => {
            seen.push(depth());
            const caught = await tx
              .transaction(async (tx2) => {
                seen.push(depth());
                await tx2.transaction(() => {
                  seen.push(depth());
                });
                throw err;
              })
              .catch((e: unknown) => e);
            expect(caught).toBe(err);
            seen.push(depth());
            await tx.transaction(() => {
              throw err;
            });
          }),
        ).rejects.toBe(err);
        expect(seen).toEqual([1, 2, 3, 1]);
        expect(depth()).toBe(0);
        await expectCode(
          store.nested(() => 1),
          'tx_closed',
        );
        await store.transaction((tx) => tx.put('ns', 'after', bytes(1))); // BEGIN works again
        expectBytes(await store.get('ns', 'after'), [1]);

        // An inner transaction left running past its outer one does not unbalance the counter.
        let finishInner = (): void => {};
        const innerGate = new Promise<void>((resolve) => {
          finishInner = resolve;
        });
        let inner: Promise<unknown> = Promise.resolve();
        await store.transaction((tx) => {
          inner = tx.transaction(() => innerGate);
        });
        expect(depth()).toBe(0);
        finishInner();
        await inner;
        expect(depth()).toBe(0);
      });

      it('a namespace first created inside a rolled-back transaction works afterwards', async () => {
        const store = openStore();
        const err = new Error('rollback');
        await expect(
          store.transaction(async (tx) => {
            await tx.put('fresh', 'k', bytes(1));
            expect(blobTables(store.db)).toEqual(['blob_fresh']);
            throw err;
          }),
        ).rejects.toBe(err);
        expect(blobTables(store.db)).toEqual([]); // the DDL rolled back with the rest
        await store.put('fresh', 'k', bytes(2));
        expectBytes(await store.get('fresh', 'k'), [2]);
        expect(await store.list('fresh')).toEqual(['k']);
      });

      it('every method after close() rejects closed; close() is idempotent', async () => {
        const store = openStore();
        await store.put('ns', 'k', bytes(1));
        expect(store.closed).toBe(false);
        store.close();
        expect(store.closed).toBe(true);
        expect(() => store.close()).not.toThrow();
        await expectCode(store.get('ns', 'k'), 'closed');
        await expectCode(store.put('ns', 'k', bytes(2)), 'closed');
        await expectCode(store.delete('ns', 'k'), 'closed');
        await expectCode(store.list('ns'), 'closed');
        await expectCode(
          store.transaction(() => 1),
          'closed',
        );
        await expectCode(
          store.nested(() => 1),
          'closed',
        );
      });

      it('close() during a transaction rolls it back and rejects it and the queued ones with closed', async () => {
        const path = join(dir, 'close.sqlite');
        const store = new SqliteStore(path);
        let release = (): void => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let wrote = (): void => {};
        const written = new Promise<void>((resolve) => {
          wrote = resolve;
        });
        const first = store.transaction(async (tx) => {
          await tx.put('ns', 'uncommitted', bytes(1));
          wrote();
          await gate;
          await tx.put('ns', 'after_close', bytes(2));
        });
        const queued = store.transaction(() => 'never runs');
        await written;
        store.close();
        release();
        await expectCode(first, 'closed');
        await expectCode(queued, 'closed');
        const reopened = openStore('close.sqlite');
        expect(await reopened.list('ns')).toEqual([]);
      });

      it('wraps driver failures as io with the driver error as cause', async () => {
        const store = openStore();
        await store.put('ns', 'k', bytes(1));
        store.db.exec('DROP TABLE blob_ns'); // behind the store's back
        const err = await expectCode(store.get('ns', 'k'), 'io');
        expect(err.cause).toBeInstanceOf(Error);
        expect(err.message).toContain('no such table: blob_ns');

        const notADatabase = join(dir, 'garbage.sqlite');
        writeFileSync(notADatabase, 'this is not a database file, just some text'.repeat(100));
        let openErr: unknown;
        try {
          openStore('garbage.sqlite');
        } catch (e) {
          openErr = e;
        }
        expect(openErr).toBeInstanceOf(BlobStoreError);
        expect(openErr).toMatchObject({ code: 'io' });
        expect((openErr as BlobStoreError).message).toContain(notADatabase);
        expect((openErr as BlobStoreError).cause).toBeInstanceOf(Error);
      });

      it('DatabaseSync satisfies SqliteDriver', () => {
        const driver: SqliteDriver = openStore(':memory:').db; // checked by the typecheck
        expect(driver.prepare('SELECT 1 AS one').get()).toEqual({ one: 1 });
      });
    });
  },
);

describe('openNodeSqlite when node:sqlite is unavailable', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws an actionable ERR_UNKNOWN_BUILTIN_MODULE error, which SqliteStore does not wrap', () => {
    vi.spyOn(process, 'getBuiltinModule').mockReturnValue(undefined);
    for (const open of [() => openNodeSqlite(':memory:'), () => new SqliteStore(':memory:')]) {
      let err: unknown;
      try {
        open();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(BlobStoreError);
      expect(err).toMatchObject({ code: 'ERR_UNKNOWN_BUILTIN_MODULE' });
      const message = (err as Error).message;
      expect(message).toContain(process.version);
      expect(message).toContain('Node 24+');
      expect(message).toContain('--experimental-sqlite');
    }
  });

  it.skipIf(!process.features.typescript)(
    'reports it in a real Node process started with --no-experimental-sqlite',
    () => {
      const driverUrl = new URL('../src/sqlite-driver.ts', import.meta.url).href;
      const script = [
        `const { openNodeSqlite } = await import(${JSON.stringify(driverUrl)});`,
        'try { openNodeSqlite(":memory:"); console.log("opened"); }',
        'catch (err) { console.log(JSON.stringify({ code: err.code, message: err.message })); }',
      ].join('\n');
      const out = execFileSync(
        process.execPath,
        ['--no-experimental-sqlite', '--input-type=module', '--eval', script],
        { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' },
      );
      const reported: unknown = JSON.parse(out.trim());
      expect(reported).toMatchObject({ code: 'ERR_UNKNOWN_BUILTIN_MODULE' });
      expect(reported).toMatchObject({ message: expect.stringContaining('--experimental-sqlite') });
    },
  );
});
