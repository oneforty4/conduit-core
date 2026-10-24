import type { DatabaseSync } from 'node:sqlite';
import { SqliteStore, migrate, schemaVersion } from '@conduit/persist';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lobbyMigrations } from '../src/index.ts';
import { nodeSqliteSkipReason } from './helpers.ts';

const skipReason = nodeSqliteSkipReason();
const A = '01J0000000000000000000000A';
const B = '01J0000000000000000000000B';
const C = '01J0000000000000000000000C';
const S = '01J00000000000000000000005';

describe.skipIf(skipReason !== null)('lobbyMigrations', () => {
  let store: SqliteStore;
  let db: DatabaseSync;

  beforeEach(() => {
    store = new SqliteStore(':memory:');
    db = store.db;
    migrate(db, lobbyMigrations);
  });

  afterEach(() => {
    store.close();
  });

  function insertAccount(id: string, username: string): void {
    db.prepare(
      'INSERT INTO accounts (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, 1)',
    ).run(id, username, username, 'scrypt$hash');
  }

  function insertSession(
    fields: {
      id?: string;
      maxPlayers?: number;
      visibility?: string;
      state?: string;
      code?: string;
    } = {},
  ): void {
    db.prepare(
      `INSERT INTO sessions (id, game_id, name, owner_id, visibility, max_players, invite_code, state,
         created_at, last_active_at) VALUES (?, 'sandbox', 'Name', ?, ?, ?, ?, ?, 1, 1)`,
    ).run(
      fields.id ?? S,
      A,
      fields.visibility ?? 'public',
      fields.maxPlayers ?? 4,
      fields.code ?? 'BBBBBBBB',
      fields.state ?? 'created',
    );
  }

  function insertFriend(accountId: string, friendId: string, requestedBy: string): void {
    db.prepare(
      "INSERT INTO friends (account_id, friend_id, status, requested_by, created_at) VALUES (?, ?, 'pending', ?, 1)",
    ).run(accountId, friendId, requestedBy);
  }

  function count(table: string): number {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    return Number(row?.['n']);
  }

  it('is one version whose entries are single statements', () => {
    expect(lobbyMigrations.map((m) => m.version)).toEqual([1]);
    const up = lobbyMigrations[0]?.up ?? [];
    expect(up).toHaveLength(12);
    for (const sql of up) expect(sql.trim().endsWith(';')).toBe(false);
  });

  it('creates every table and index, and migrating twice is a no-op', () => {
    expect(schemaVersion(db)).toBe(1);
    const names = (type: string) =>
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all(type)
        .map((row) => row['name']);
    const tables = names('table');
    const indexes = names('index');
    expect(tables).toEqual([
      'accounts',
      'friends',
      'lobby_sessions',
      'schema_version',
      'session_members',
      'sessions',
    ]);
    expect(indexes).toEqual([
      'friends_friend',
      'lobby_sessions_account',
      'lobby_sessions_expires',
      'session_members_account',
      'sessions_game_state',
      'sessions_owner',
      'sessions_visibility',
    ]);
    insertAccount(A, 'alice');
    migrate(db, lobbyMigrations);
    expect(schemaVersion(db)).toBe(1);
    expect(names('table')).toEqual(tables);
    expect(names('index')).toEqual(indexes);
    expect(count('accounts')).toBe(1);
    expect(count('schema_version')).toBe(1);
  });

  it('makes accounts.username UNIQUE case-insensitively', () => {
    insertAccount(A, 'alice');
    expect(() => insertAccount(B, 'ALICE')).toThrow(/UNIQUE constraint failed: accounts.username/);
    expect(() => insertAccount(B, 'Alice')).toThrow(/UNIQUE/);
    insertAccount(B, 'bob');
    expect(count('accounts')).toBe(2);
  });

  it('constrains sessions: max_players 1..8, visibility, state, unique invite codes, owner', () => {
    insertAccount(A, 'alice');
    expect(() => insertSession({ maxPlayers: 0 })).toThrow(/CHECK constraint failed/);
    expect(() => insertSession({ maxPlayers: 9 })).toThrow(/CHECK constraint failed/);
    expect(() => insertSession({ visibility: 'secret' })).toThrow(/CHECK constraint failed/);
    expect(() => insertSession({ state: 'paused' })).toThrow(/CHECK constraint failed/);
    insertSession({ maxPlayers: 1 });
    insertSession({
      id: C,
      maxPlayers: 8,
      visibility: 'friends',
      state: 'archived',
      code: 'CCCCCCCC',
    });
    expect(() => insertSession({ id: B, code: 'BBBBBBBB' })).toThrow(
      /UNIQUE constraint failed: sessions.invite_code/,
    );
    expect(() =>
      db.prepare("UPDATE sessions SET owner_id = 'missing' WHERE id = ?").run(C),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(count('sessions')).toBe(2);
  });

  it('rejects a sessions row whose owner does not exist', () => {
    expect(() => insertSession()).toThrow(/FOREIGN KEY constraint failed/);
  });

  it('constrains friends: account_id < friend_id and requested_by within the pair', () => {
    for (const [id, name] of [
      [A, 'alice'],
      [B, 'bob'],
      [C, 'carol'],
    ] as const) {
      insertAccount(id, name);
    }
    expect(() => insertFriend(B, A, A)).toThrow(/CHECK constraint failed/);
    expect(() => insertFriend(A, A, A)).toThrow(/CHECK constraint failed/);
    expect(() => insertFriend(A, B, C)).toThrow(/CHECK constraint failed/);
    insertFriend(A, B, B);
    expect(() => insertFriend(A, B, A)).toThrow(/UNIQUE|PRIMARY KEY/);
    expect(() =>
      db
        .prepare(
          "INSERT INTO friends (account_id, friend_id, status, requested_by, created_at) VALUES (?, ?, 'blocked', ?, 1)",
        )
        .run(A, C, A),
    ).toThrow(/CHECK constraint failed/);
    expect(count('friends')).toBe(1);
  });

  it('cascades an account deletion to sessions, members, friends and lobby sessions', () => {
    insertAccount(A, 'alice');
    insertAccount(B, 'bob');
    insertAccount(C, 'carol');
    insertSession(); // owned by A
    db.prepare(
      `INSERT INTO sessions (id, game_id, name, owner_id, visibility, max_players, invite_code, state,
         created_at, last_active_at) VALUES (?, 'sandbox', 'B session', ?, 'public', 4, 'DDDDDDDD', 'created', 1, 1)`,
    ).run(C, B);
    const member = db.prepare(
      'INSERT INTO session_members (session_id, account_id, joined_at) VALUES (?, ?, 1)',
    );
    member.run(S, A);
    member.run(S, B);
    member.run(C, A);
    member.run(C, B);
    insertFriend(A, B, A);
    insertFriend(B, C, C);
    const login = db.prepare(
      'INSERT INTO lobby_sessions (token, account_id, created_at, expires_at) VALUES (?, ?, 1, 2)',
    );
    login.run('token-a', A);
    login.run('token-b', B);

    db.prepare('DELETE FROM accounts WHERE id = ?').run(A);

    expect(
      db
        .prepare('SELECT id FROM sessions')
        .all()
        .map((r) => r['id']),
    ).toEqual([C]);
    expect(
      db
        .prepare('SELECT session_id, account_id FROM session_members')
        .all()
        .map((r) => [r['session_id'], r['account_id']]),
    ).toEqual([[C, B]]);
    expect(
      db
        .prepare('SELECT account_id, friend_id FROM friends')
        .all()
        .map((r) => [r['account_id'], r['friend_id']]),
    ).toEqual([[B, C]]);
    expect(
      db
        .prepare('SELECT token FROM lobby_sessions')
        .all()
        .map((r) => r['token']),
    ).toEqual(['token-b']);
  });

  it('cascades a session deletion to its members', () => {
    insertAccount(A, 'alice');
    insertSession();
    db.prepare(
      'INSERT INTO session_members (session_id, account_id, joined_at) VALUES (?, ?, 1)',
    ).run(S, A);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(S);
    expect(count('session_members')).toBe(0);
    expect(count('accounts')).toBe(1);
  });
});
