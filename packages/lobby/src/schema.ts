import type { Migration } from '@conduit/persist';

/**
 * The lobby's relational schema for `migrate(store.db, lobbyMigrations)` (docs/host.md section 1).
 * Version 1 holds the whole schema, one statement per `up` entry; later changes append versions.
 * `SqliteStore` sets `PRAGMA foreign_keys=ON`, so the cascades apply.
 */
export const lobbyMigrations: Migration[] = [
  {
    version: 1,
    up: [
      `CREATE TABLE accounts (
        id            TEXT    PRIMARY KEY,
        username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
        display_name  TEXT    NOT NULL,
        password_hash TEXT    NOT NULL,
        created_at    INTEGER NOT NULL,
        last_login_at INTEGER
      )`,
      `CREATE TABLE sessions (
        id             TEXT    PRIMARY KEY,
        game_id        TEXT    NOT NULL,
        name           TEXT    NOT NULL,
        owner_id       TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        visibility     TEXT    NOT NULL CHECK (visibility IN ('private','friends','public')),
        max_players    INTEGER NOT NULL CHECK (max_players BETWEEN 1 AND 8),
        invite_code    TEXT    NOT NULL UNIQUE,
        state          TEXT    NOT NULL CHECK (state IN ('created','running','idle','archived')),
        created_at     INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL
      )`,
      'CREATE INDEX sessions_game_state ON sessions (game_id, state)',
      'CREATE INDEX sessions_owner      ON sessions (owner_id)',
      'CREATE INDEX sessions_visibility ON sessions (visibility, state)',
      `CREATE TABLE session_members (
        session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        account_id TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        joined_at  INTEGER NOT NULL,
        PRIMARY KEY (session_id, account_id)
      ) WITHOUT ROWID`,
      'CREATE INDEX session_members_account ON session_members (account_id)',
      `CREATE TABLE friends (
        account_id   TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        friend_id    TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        status       TEXT    NOT NULL CHECK (status IN ('pending','accepted')),
        requested_by TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at   INTEGER NOT NULL,
        PRIMARY KEY (account_id, friend_id),
        CHECK (account_id < friend_id),
        CHECK (requested_by IN (account_id, friend_id))
      ) WITHOUT ROWID`,
      'CREATE INDEX friends_friend ON friends (friend_id)',
      `CREATE TABLE lobby_sessions (
        token      TEXT    PRIMARY KEY,
        account_id TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) WITHOUT ROWID`,
      'CREATE INDEX lobby_sessions_account ON lobby_sessions (account_id)',
      'CREATE INDEX lobby_sessions_expires ON lobby_sessions (expires_at)',
    ],
  },
];
