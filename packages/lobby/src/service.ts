import { randomBytes } from 'node:crypto';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import {
  assertSecret,
  base64url,
  hashPassword,
  mintToken,
  needsRehash,
  tokenExpiry,
  verifyPassword,
} from '@conduit/auth';
import type {
  Account,
  CreateSessionRequest,
  CreateSessionResponse,
  FriendEntry,
  GameInfo,
  LobbyEvent,
  LoginRequest,
  MeResponse,
  MemberSummary,
  PublicAccount,
  RegisterRequest,
  SessionState,
  SessionSummary,
  Visibility,
} from './api.ts';
import { LOBBY_SESSION_TTL_MS, hashCookieToken, newCookieToken } from './cookies.ts';
import { LobbyError } from './errors.ts';
import { INVITE_RETRIES, inviteCode, normalizeInviteCode, ulid } from './ids.ts';
import { SESSION_TRANSITIONS, assertTransition } from './state.ts';
import {
  MAX_SESSIONS_PER_OWNER,
  validateCreateSession,
  validateLogin,
  validateRegister,
  type Untrusted,
} from './validate.ts';

/** What the lobby needs from the process that runs game sessions (the host's SessionManager). */
export interface SessionHostControl {
  /** Resolves when the session's worker is ready; rejects on failure. */
  start(sessionId: string, gameId: string, maxPlayers?: number): Promise<void>;
  /**
   * Flushes and stops the session, resolving when its worker exited; a no-op when it is not running.
   * `close` is the WebSocket close code and reason for the sockets still attached.
   */
  stop(sessionId: string, close?: { code: number; reason: string }): Promise<void>;
  isRunning(sessionId: string): boolean;
  /**
   * Called on every join of a session that is already running, in the same turn as the `isRunning`
   * check: restarts the session's idle timer, so a session without sockets does not idle out between
   * the join and the joiner's WebSocket connect (docs/host.md section 6).
   */
  touch?(sessionId: string): void;
  /** Closes that account's game sockets in the session. */
  disconnect?(sessionId: string, accountId: string, code: number, reason: string): void;
}

/** The games a host serves (`GET /games`, `createSession` validation). */
export interface GameRegistry {
  list(): GameInfo[];
  has(gameId: string): boolean;
}

/** Where lobby events go: the presence hub, or nothing. */
export interface EventSink {
  emit(recipients: string[], event: LobbyEvent): void;
  /** Accounts with at least one live presence connection. */
  online(): ReadonlySet<string>;
}

export interface LobbyServiceOptions {
  host: SessionHostControl;
  games: GameRegistry;
  /** HOST_SECRET, which signs SessionTokens; checked with `assertSecret`. */
  secret: string;
  /** Unix ms; default `Date.now`. */
  now?: () => number;
}

/** docs/host.md section 17 `GATEWAY_CLOSE` codes the lobby hands to the host. */
const CLOSE_LEFT = 4105;
const CLOSE_SESSION_DELETED = 4106;
const REASON_LEFT = 'left';
const REASON_SESSION_DELETED = 'session_deleted';

const EMPTY_SET: ReadonlySet<string> = new Set();
const NO_SINK: EventSink = { emit: () => {}, online: () => EMPTY_SET };

/**
 * Verified against when a login names no account, so an unknown username costs the same scrypt
 * work as a wrong password. Its input is random and discarded, so nothing verifies against it.
 */
const DUMMY_HASH: Promise<string> = hashPassword(base64url(randomBytes(32)));
DUMMY_HASH.catch(() => {}); // a failure surfaces to the login that awaits it

type Row = Record<string, unknown>;
type SqlValue = string | number | bigint | null;

interface AccountRecord extends PublicAccount {
  passwordHash: string;
  createdAt: number;
  lastLoginAt: number | null;
}

interface SessionRecord {
  id: string;
  gameId: string;
  name: string;
  ownerId: string;
  visibility: Visibility;
  maxPlayers: number;
  inviteCode: string;
  state: SessionState;
  createdAt: number;
  lastActiveAt: number;
}

const ACCOUNT_COLUMNS = 'id, username, display_name, password_hash, created_at, last_login_at';
const SESSION_COLUMNS =
  's.id, s.game_id, s.name, s.owner_id, s.visibility, s.max_players, s.invite_code, s.state, ' +
  's.created_at, s.last_active_at';
/** The visibility predicate of docs/host.md section 6 over `sessions s`; `?1` is the viewer. */
const VISIBLE_TO_VIEWER = `(
  s.owner_id = ?1
  OR EXISTS (SELECT 1 FROM session_members m WHERE m.session_id = s.id AND m.account_id = ?1)
  OR s.visibility = 'public'
  OR (s.visibility = 'friends' AND EXISTS (SELECT 1 FROM friends f WHERE f.status = 'accepted'
        AND f.account_id = MIN(?1, s.owner_id) AND f.friend_id = MAX(?1, s.owner_id)))
)`;
const SESSION_ORDER = 'ORDER BY s.last_active_at DESC, s.id DESC';

/** The friends row key for two accounts: `[min, max]` (the table stores `account_id < friend_id`). */
export function pairKey(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * The lobby's logic over the host's SQLite connection (docs/host.md section 6): accounts and login
 * cookies, game sessions and their lifecycle, friends. No HTTP and no sockets; events go to the
 * attached `EventSink`. Methods are synchronous except those that hash passwords or wait for the
 * host. Writes that must be atomic run between `BEGIN IMMEDIATE` and `COMMIT` without an `await`
 * in between, so they never interleave with other users of the connection.
 */
export class LobbyService {
  private readonly db: DatabaseSync;
  private readonly host: SessionHostControl;
  private readonly registry: GameRegistry;
  private readonly secret: string;
  private readonly now: () => number;
  private readonly stmts = new Map<string, StatementSync>();
  private sink: EventSink = NO_SINK;

  constructor(db: DatabaseSync, opts: LobbyServiceOptions) {
    assertSecret(opts.secret);
    this.db = db;
    this.host = opts.host;
    this.registry = opts.games;
    this.secret = opts.secret;
    this.now = opts.now ?? Date.now;
  }

  /** Routes events to `sink` (the host attaches its PresenceHub). */
  attachSink(sink: EventSink): void {
    this.sink = sink;
  }

  // ---- accounts ----

  /** Creates an account (does not log in). `conflict` when the username is taken. */
  async register(input: Untrusted<RegisterRequest>): Promise<Account> {
    const { username, password, displayName } = validateRegister(input);
    if (this.get('SELECT 1 FROM accounts WHERE username = ?', username) !== undefined) {
      throw usernameTaken();
    }
    const passwordHash = await hashPassword(password);
    const now = this.now();
    const id = ulid(now);
    try {
      this.run(
        'INSERT INTO accounts (id, username, display_name, password_hash, created_at, last_login_at) ' +
          'VALUES (?, ?, ?, ?, ?, NULL)',
        id,
        username,
        displayName,
        passwordHash,
        now,
      );
    } catch (err) {
      // A concurrent registration took the name while the password was hashing.
      if (isUniqueViolation(err, 'accounts.username')) throw usernameTaken();
      throw err;
    }
    return { id, username, displayName, createdAt: now, lastLoginAt: null };
  }

  /**
   * Checks the credentials and opens a login. Every failure is the same `unauthorized`, with the
   * same scrypt cost. Re-hashes the password when `needsRehash` says its parameters are old.
   * Returns the raw cookie token; only its hash is stored.
   */
  async login(input: Untrusted<LoginRequest>): Promise<{ account: Account; cookieToken: string }> {
    const { username, password } = validateLogin(input);
    const record = this.accountByName(username.toLowerCase());
    if (record === undefined) {
      await verifyPassword(password, await DUMMY_HASH);
      throw invalidCredentials();
    }
    if (!(await verifyPassword(password, record.passwordHash))) throw invalidCredentials();
    const rehashed = needsRehash(record.passwordHash) ? await hashPassword(password) : null;
    const now = this.now();
    const cookieToken = newCookieToken();
    this.transaction(() => {
      if (rehashed !== null) {
        this.run('UPDATE accounts SET password_hash = ? WHERE id = ?', rehashed, record.id);
      }
      this.run('UPDATE accounts SET last_login_at = ? WHERE id = ?', now, record.id);
      this.run(
        'INSERT INTO lobby_sessions (token, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
        hashCookieToken(cookieToken),
        record.id,
        now,
        now + LOBBY_SESSION_TTL_MS,
      );
    });
    return { account: { ...toAccount(record), lastLoginAt: now }, cookieToken };
  }

  /** Ends the login for a raw cookie token, if there is one. Never throws for bad input. */
  logout(cookieToken: string | undefined): void {
    if (typeof cookieToken !== 'string' || cookieToken === '') return;
    this.run('DELETE FROM lobby_sessions WHERE token = ?', hashCookieToken(cookieToken));
  }

  /** The account behind a raw cookie token, or `null`. An expired login is deleted. */
  authenticate(cookieToken: string | undefined): Account | null {
    if (typeof cookieToken !== 'string' || cookieToken === '') return null;
    const token = hashCookieToken(cookieToken);
    const login = this.get(
      'SELECT account_id, expires_at FROM lobby_sessions WHERE token = ?',
      token,
    );
    if (login === undefined) return null;
    if (integer(login, 'expires_at') <= this.now()) {
      this.run('DELETE FROM lobby_sessions WHERE token = ?', token);
      return null;
    }
    const record = this.accountById(text(login, 'account_id'));
    return record === undefined ? null : toAccount(record);
  }

  /** The caller's account, every friends row involving it, and friends-only sessions to join. */
  me(accountId: string): MeResponse {
    const account = toAccount(this.requireAccount(accountId));
    const friends = this.all(
      `SELECT f.status, f.requested_by, f.created_at, a.id, a.username, a.display_name
       FROM friends f
       JOIN accounts a ON a.id = CASE WHEN f.account_id = ?1 THEN f.friend_id ELSE f.account_id END
       WHERE f.account_id = ?1 OR f.friend_id = ?1
       ORDER BY a.username`,
      accountId,
    ).map((row) => friendEntry(row, accountId));
    const invites = this.all(
      `SELECT ${SESSION_COLUMNS} FROM sessions s
       WHERE s.state != 'archived' AND s.visibility = 'friends' AND s.owner_id != ?1
         AND EXISTS (SELECT 1 FROM friends f WHERE f.status = 'accepted'
               AND f.account_id = MIN(?1, s.owner_id) AND f.friend_id = MAX(?1, s.owner_id))
         AND NOT EXISTS (SELECT 1 FROM session_members m
               WHERE m.session_id = s.id AND m.account_id = ?1)
       ${SESSION_ORDER}`,
      accountId,
    ).map((row) => this.toSummary(sessionRecord(row), accountId));
    return { account, friends, invites };
  }

  /** The public view of an account, looked up case-insensitively. */
  accountByUsername(username: string): PublicAccount | null {
    if (typeof username !== 'string') return null;
    const record = this.accountByName(username.toLowerCase());
    return record === undefined ? null : toPublic(record);
  }

  // ---- sessions ----

  games(): GameInfo[] {
    return this.registry.list();
  }

  /** Non-archived sessions the caller can see, most recently active first. */
  listSessions(accountId: string, gameId?: string): SessionSummary[] {
    const rows =
      gameId === undefined
        ? this.all(
            `SELECT ${SESSION_COLUMNS} FROM sessions s
             WHERE s.state != 'archived' AND ${VISIBLE_TO_VIEWER} ${SESSION_ORDER}`,
            accountId,
          )
        : this.all(
            `SELECT ${SESSION_COLUMNS} FROM sessions s
             WHERE s.state != 'archived' AND s.game_id = ?2 AND ${VISIBLE_TO_VIEWER} ${SESSION_ORDER}`,
            accountId,
            gameId,
          );
    return rows.map((row) => this.toSummary(sessionRecord(row), accountId));
  }

  /** One session the caller can see; `not_found` when archived or not visible. */
  getSession(accountId: string, sessionId: string): SessionSummary {
    const row = this.get(
      `SELECT ${SESSION_COLUMNS} FROM sessions s
       WHERE s.id = ?2 AND s.state != 'archived' AND ${VISIBLE_TO_VIEWER}`,
      accountId,
      sessionId,
    );
    if (row === undefined) throw sessionNotFound();
    return this.toSummary(sessionRecord(row), accountId);
  }

  /** Creates a session in state `created` with the owner as its first member. */
  createSession(accountId: string, input: Untrusted<CreateSessionRequest>): CreateSessionResponse {
    const { gameId, name, visibility, maxPlayers } = validateCreateSession(input, this.registry);
    const owner = toPublic(this.requireAccount(accountId));
    const now = this.now();
    const id = ulid(now);
    const code = this.transaction(() => {
      const owned = this.get(
        "SELECT COUNT(*) AS n FROM sessions WHERE owner_id = ? AND state != 'archived'",
        accountId,
      );
      if (owned !== undefined && integer(owned, 'n') >= MAX_SESSIONS_PER_OWNER) {
        throw new LobbyError(
          'conflict',
          `an account can own at most ${MAX_SESSIONS_PER_OWNER} open sessions`,
        );
      }
      const allocated = this.insertSession(
        id,
        gameId,
        name,
        accountId,
        visibility,
        maxPlayers,
        now,
      );
      this.run(
        'INSERT INTO session_members (session_id, account_id, joined_at) VALUES (?, ?, ?)',
        id,
        accountId,
        now,
      );
      return allocated;
    });
    const record = this.requireSession(id);
    const session = this.toSummary(record, accountId);
    this.emit([accountId], { t: 'session', session });
    if (visibility === 'friends') {
      // Friends are not members: their copy carries no invite code (they need none to join).
      this.emit(this.friendIds(accountId), {
        t: 'invite',
        session: this.toSummary(record, null),
        from: owner,
      });
    }
    return { session, inviteCode: code };
  }

  /**
   * Admits the caller (members rejoin freely; others need visibility or the invite code, and a free
   * slot), starts the worker when the session is not running, and mints a SessionToken for it.
   */
  async joinSession(
    accountId: string,
    sessionId: string,
    inviteCode?: string,
  ): Promise<{ token: string; session: SessionSummary }> {
    const joiner = this.requireAccount(accountId);
    let record = this.requireOpenSession(sessionId);
    this.admit(record, accountId, inviteCode);
    if (record.state !== 'running' || !this.host.isRunning(sessionId)) {
      try {
        await this.host.start(sessionId, record.gameId, record.maxPlayers);
      } catch (cause) {
        throw new LobbyError('internal', 'the session failed to start', { cause });
      }
      // The world moved on while the worker started: re-check before admitting.
      const current = this.sessionById(sessionId);
      if (current === undefined || current.state === 'archived') {
        // Deleted meanwhile; do not leave a worker running for an archived session.
        await this.stopQuietly(sessionId, CLOSE_SESSION_DELETED, REASON_SESSION_DELETED);
        throw sessionNotFound();
      }
      record = current;
      this.admit(record, accountId, inviteCode);
    } else {
      // Running, maybe without sockets and with its idle timer about to fire: restart that timer
      // now, so the worker is still there when this joiner's socket arrives.
      this.host.touch?.(sessionId);
    }
    const now = this.now();
    const from = record.state;
    this.transaction(() => {
      if (from !== 'running') {
        assertTransition(from, 'running');
        this.run("UPDATE sessions SET state = 'running' WHERE id = ?", sessionId);
      }
      this.run(
        'INSERT INTO session_members (session_id, account_id, joined_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT (session_id, account_id) DO NOTHING',
        sessionId,
        accountId,
        now,
      );
      this.run('UPDATE sessions SET last_active_at = ? WHERE id = ?', now, sessionId);
    });
    const token = mintToken(
      {
        accountId,
        displayName: joiner.displayName,
        sessionId,
        exp: tokenExpiry(Math.floor(now / 1000)),
      },
      this.secret,
    );
    const updated = this.requireSession(sessionId);
    this.emitSession(this.toSummary(updated, updated.ownerId));
    return { token, session: this.toSummary(updated, accountId) };
  }

  /** Removes the caller from the session and closes their game sockets (4105 `left`). */
  leaveSession(accountId: string, sessionId: string): void {
    this.requireOpenSession(sessionId);
    const now = this.now();
    const left = this.transaction(() => {
      const removed = this.run(
        'DELETE FROM session_members WHERE session_id = ? AND account_id = ?',
        sessionId,
        accountId,
      );
      if (removed > 0) {
        this.run('UPDATE sessions SET last_active_at = ? WHERE id = ?', now, sessionId);
      }
      return removed > 0;
    });
    if (!left) throw new LobbyError('not_found', 'not a member of this session');
    this.host.disconnect?.(sessionId, accountId, CLOSE_LEFT, REASON_LEFT);
    const updated = this.requireSession(sessionId);
    const summary = this.toSummary(updated, updated.ownerId);
    const recipients = this.emitSession(summary);
    if (!recipients.includes(accountId)) {
      // The leaver is no longer a member, so their copy has no invite code.
      this.emit([accountId], { t: 'session', session: this.toSummary(updated, accountId) });
    }
  }

  /**
   * Owner only: stops the worker (flushing it; attached sockets close with 4106), then archives the
   * session. Member rows are kept.
   */
  async deleteSession(accountId: string, sessionId: string): Promise<void> {
    const record = this.requireOpenSession(sessionId);
    if (record.ownerId !== accountId) {
      throw new LobbyError('forbidden', 'only the owner can delete a session');
    }
    try {
      await this.host.stop(sessionId, {
        code: CLOSE_SESSION_DELETED,
        reason: REASON_SESSION_DELETED,
      });
    } catch (cause) {
      if (!isNotRunning(cause)) {
        throw new LobbyError('internal', 'the session failed to stop', { cause });
      }
    }
    const current = this.sessionById(sessionId);
    if (current === undefined || current.state === 'archived') return; // a concurrent delete won
    assertTransition(current.state, 'archived');
    this.run(
      "UPDATE sessions SET state = 'archived', last_active_at = ? WHERE id = ?",
      this.now(),
      sessionId,
    );
    const archived = this.requireSession(sessionId);
    this.emitSession(this.toSummary(archived, archived.ownerId));
  }

  isMember(sessionId: string, accountId: string): boolean {
    return (
      this.get(
        'SELECT 1 FROM session_members WHERE session_id = ? AND account_id = ?',
        sessionId,
        accountId,
      ) !== undefined
    );
  }

  /** Host callback after it stopped an idle or crashed worker: `running → idle`. */
  markIdle(sessionId: string): void {
    this.hostTransition(sessionId, 'idle');
  }

  /** Host callback after it started a worker on its own: `created | idle → running`. */
  markRunning(sessionId: string): void {
    this.hostTransition(sessionId, 'running');
  }

  // ---- friends ----

  /**
   * Sends a friend request to `username`, or accepts theirs when they already asked (a mutual
   * request). `conflict` when already friends or already requested.
   */
  requestFriend(accountId: string, username: string): FriendEntry {
    const target = this.accountByUsername(username);
    if (target === null) throw new LobbyError('not_found', 'no account has that username');
    if (target.id === accountId) {
      throw new LobbyError('validation', 'you cannot befriend yourself', { field: 'username' });
    }
    const [low, high] = pairKey(accountId, target.id);
    const now = this.now();
    const entry = this.transaction((): FriendEntry => {
      const row = this.friendRow(low, high);
      if (row === undefined) {
        this.run(
          "INSERT INTO friends (account_id, friend_id, status, requested_by, created_at) VALUES (?, ?, 'pending', ?, ?)",
          low,
          high,
          accountId,
          now,
        );
        return { account: target, status: 'pending_out', since: now };
      }
      if (text(row, 'status') === 'accepted') {
        throw new LobbyError('conflict', 'already friends');
      }
      if (text(row, 'requested_by') === accountId) {
        throw new LobbyError('conflict', 'friend request already sent');
      }
      this.run(
        "UPDATE friends SET status = 'accepted' WHERE account_id = ? AND friend_id = ?",
        low,
        high,
      );
      return { account: target, status: 'accepted', since: integer(row, 'created_at') };
    });
    this.emitFriends(accountId);
    this.emitFriends(target.id);
    return entry;
  }

  /** Accepts the pending request `requesterId` sent to the caller. */
  acceptFriend(accountId: string, requesterId: string): FriendEntry {
    const [low, high] = pairKey(accountId, requesterId);
    const row = requesterId === accountId ? undefined : this.friendRow(low, high);
    const requester = this.accountById(requesterId);
    if (
      row === undefined ||
      requester === undefined ||
      text(row, 'status') !== 'pending' ||
      text(row, 'requested_by') !== requesterId
    ) {
      throw new LobbyError('not_found', 'no pending friend request from that account');
    }
    this.run(
      "UPDATE friends SET status = 'accepted' WHERE account_id = ? AND friend_id = ?",
      low,
      high,
    );
    this.emitFriends(accountId);
    this.emitFriends(requesterId);
    return { account: toPublic(requester), status: 'accepted', since: integer(row, 'created_at') };
  }

  /** Deletes the pair's row in any status: declines, cancels or unfriends. */
  removeFriend(accountId: string, otherId: string): void {
    const [low, high] = pairKey(accountId, otherId);
    const removed = this.run(
      'DELETE FROM friends WHERE account_id = ? AND friend_id = ?',
      low,
      high,
    );
    if (removed === 0)
      throw new LobbyError('not_found', 'no friendship or request with that account');
    this.emitFriends(accountId);
    this.emitFriends(otherId);
  }

  /** Accepted friends of `accountId`, sorted. */
  friendIds(accountId: string): string[] {
    return this.all(
      `SELECT CASE WHEN account_id = ?1 THEN friend_id ELSE account_id END AS id
       FROM friends WHERE status = 'accepted' AND (account_id = ?1 OR friend_id = ?1)
       ORDER BY id`,
      accountId,
    ).map((row) => text(row, 'id'));
  }

  /** Deletes expired logins; returns how many. The host calls it every PURGE_INTERVAL_MS. */
  purgeExpired(): number {
    return this.run('DELETE FROM lobby_sessions WHERE expires_at <= ?', this.now());
  }

  // ---- internals ----

  /** Membership, visibility, invite code and capacity checks for a join. */
  private admit(session: SessionRecord, accountId: string, code: string | undefined): void {
    if (this.isMember(session.id, accountId)) return;
    const visible =
      session.visibility === 'public' ||
      session.ownerId === accountId ||
      (session.visibility === 'friends' && this.areFriends(accountId, session.ownerId));
    if (!visible) {
      const normalized = typeof code === 'string' ? normalizeInviteCode(code) : null;
      if (normalized === null || normalized !== session.inviteCode) {
        throw new LobbyError('bad_invite', 'a valid invite code is required to join this session');
      }
    }
    const members = this.get(
      'SELECT COUNT(*) AS n FROM session_members WHERE session_id = ?',
      session.id,
    );
    if (members !== undefined && integer(members, 'n') >= session.maxPlayers) {
      throw new LobbyError('session_full', 'the session is full');
    }
  }

  /** Inserts a session row with a fresh invite code, retrying on a code collision. */
  private insertSession(
    id: string,
    gameId: string,
    name: string,
    ownerId: string,
    visibility: Visibility,
    maxPlayers: number,
    now: number,
  ): string {
    for (let attempt = 1; ; attempt++) {
      const code = inviteCode();
      try {
        this.run(
          'INSERT INTO sessions (id, game_id, name, owner_id, visibility, max_players, invite_code, ' +
            "state, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?, ?)",
          id,
          gameId,
          name,
          ownerId,
          visibility,
          maxPlayers,
          code,
          now,
          now,
        );
        return code;
      } catch (err) {
        if (!isUniqueViolation(err, 'sessions.invite_code')) throw err;
        if (attempt >= INVITE_RETRIES) {
          throw new LobbyError('internal', 'could not allocate an invite code', { cause: err });
        }
      }
    }
  }

  private hostTransition(sessionId: string, to: 'idle' | 'running'): void {
    const record = this.sessionById(sessionId);
    if (record === undefined || !SESSION_TRANSITIONS[record.state].includes(to)) return;
    assertTransition(record.state, to);
    const changed = this.run(
      'UPDATE sessions SET state = ? WHERE id = ? AND state = ?',
      to,
      sessionId,
      record.state,
    );
    if (changed > 0) {
      const updated = this.requireSession(sessionId);
      this.emitSession(this.toSummary(updated, updated.ownerId));
    }
  }

  private async stopQuietly(sessionId: string, code: number, reason: string): Promise<void> {
    try {
      await this.host.stop(sessionId, { code, reason });
    } catch (err) {
      if (!isNotRunning(err)) console.error(`[conduit/lobby] stopping session ${sessionId}:`, err);
    }
  }

  private areFriends(a: string, b: string): boolean {
    const [low, high] = pairKey(a, b);
    const row = this.friendRow(low, high);
    return row !== undefined && text(row, 'status') === 'accepted';
  }

  private friendRow(low: string, high: string): Row | undefined {
    return this.get(
      'SELECT status, requested_by, created_at FROM friends WHERE account_id = ? AND friend_id = ?',
      low,
      high,
    );
  }

  /** A summary with members; `inviteCode` only when `viewerId` is the owner or a member. */
  private toSummary(session: SessionRecord, viewerId: string | null): SessionSummary {
    const members = this.all(
      `SELECT a.id, a.username, a.display_name, m.joined_at
       FROM session_members m JOIN accounts a ON a.id = m.account_id
       WHERE m.session_id = ? ORDER BY m.joined_at, a.id`,
      session.id,
    ).map(memberSummary);
    const summary: SessionSummary = {
      id: session.id,
      gameId: session.gameId,
      name: session.name,
      ownerId: session.ownerId,
      visibility: session.visibility,
      maxPlayers: session.maxPlayers,
      state: session.state,
      memberCount: members.length,
      members,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
    };
    if (
      viewerId !== null &&
      (viewerId === session.ownerId || members.some((member) => member.id === viewerId))
    ) {
      summary.inviteCode = session.inviteCode;
    }
    return summary;
  }

  /** Emits `session` (an owner's view) to the owner and members; returns those recipients. */
  private emitSession(summary: SessionSummary): string[] {
    const recipients = [...new Set([summary.ownerId, ...summary.members.map((m) => m.id)])];
    this.emit(recipients, { t: 'session', session: summary });
    return recipients;
  }

  /** Sends `accountId` its friends snapshot, if it is online. */
  private emitFriends(accountId: string): void {
    const online = this.sink.online();
    if (!online.has(accountId)) return;
    this.emit([accountId], {
      t: 'friends',
      online: this.friendIds(accountId).filter((id) => online.has(id)),
    });
  }

  private emit(recipients: string[], event: LobbyEvent): void {
    if (recipients.length === 0) return;
    try {
      this.sink.emit(recipients, event);
    } catch (err) {
      // The state change is committed; a failing sink must not turn it into an error response.
      console.error('[conduit/lobby] event sink failed:', err);
    }
  }

  private accountById(id: string): AccountRecord | undefined {
    const row = this.get(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`, id);
    return row === undefined ? undefined : accountRecord(row);
  }

  private accountByName(username: string): AccountRecord | undefined {
    const row = this.get(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE username = ?`, username);
    return row === undefined ? undefined : accountRecord(row);
  }

  /** The caller's own account; `unauthorized` when it no longer exists. */
  private requireAccount(accountId: string): AccountRecord {
    const record = this.accountById(accountId);
    if (record === undefined) throw new LobbyError('unauthorized', 'account not found');
    return record;
  }

  private sessionById(sessionId: string): SessionRecord | undefined {
    const row = this.get(`SELECT ${SESSION_COLUMNS} FROM sessions s WHERE s.id = ?`, sessionId);
    return row === undefined ? undefined : sessionRecord(row);
  }

  private requireSession(sessionId: string): SessionRecord {
    const record = this.sessionById(sessionId);
    if (record === undefined) throw sessionNotFound();
    return record;
  }

  /** A session that exists and is not archived; `not_found` otherwise. */
  private requireOpenSession(sessionId: string): SessionRecord {
    const record = this.sessionById(sessionId);
    if (record === undefined || record.state === 'archived') throw sessionNotFound();
    return record;
  }

  /** Runs `fn` synchronously inside one IMMEDIATE transaction. `fn` must not return a promise. */
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // SQLite already rolled the transaction back.
      }
      throw err;
    }
  }

  private stmt(sql: string): StatementSync {
    let statement = this.stmts.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.stmts.set(sql, statement);
    }
    return statement;
  }

  private get(sql: string, ...params: SqlValue[]): Row | undefined {
    return this.stmt(sql).get(...params);
  }

  private all(sql: string, ...params: SqlValue[]): Row[] {
    return this.stmt(sql).all(...params);
  }

  /** Runs a write; returns the number of changed rows. */
  private run(sql: string, ...params: SqlValue[]): number {
    return Number(this.stmt(sql).run(...params).changes);
  }
}

function usernameTaken(): LobbyError {
  return new LobbyError('conflict', 'username taken', { field: 'username' });
}

function invalidCredentials(): LobbyError {
  return new LobbyError('unauthorized', 'invalid credentials');
}

function sessionNotFound(): LobbyError {
  return new LobbyError('not_found', 'session not found');
}

function isUniqueViolation(err: unknown, column: string): boolean {
  return err instanceof Error && err.message.includes(`UNIQUE constraint failed: ${column}`);
}

/** A host error saying the session was not running (docs/host.md `HostError('not_running')`). */
function isNotRunning(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'not_running';
}

function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`lobby column ${column} is not text`);
  return value;
}

function integer(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`lobby column ${column} is not an integer`);
}

function accountRecord(row: Row): AccountRecord {
  return {
    id: text(row, 'id'),
    username: text(row, 'username'),
    displayName: text(row, 'display_name'),
    passwordHash: text(row, 'password_hash'),
    createdAt: integer(row, 'created_at'),
    lastLoginAt: row['last_login_at'] === null ? null : integer(row, 'last_login_at'),
  };
}

function toPublic(record: PublicAccount): PublicAccount {
  return { id: record.id, username: record.username, displayName: record.displayName };
}

function toAccount(record: AccountRecord): Account {
  return { ...toPublic(record), createdAt: record.createdAt, lastLoginAt: record.lastLoginAt };
}

function memberSummary(row: Row): MemberSummary {
  return {
    id: text(row, 'id'),
    username: text(row, 'username'),
    displayName: text(row, 'display_name'),
    joinedAt: integer(row, 'joined_at'),
  };
}

function friendEntry(row: Row, viewerId: string): FriendEntry {
  const status =
    text(row, 'status') === 'accepted'
      ? 'accepted'
      : text(row, 'requested_by') === viewerId
        ? 'pending_out'
        : 'pending_in';
  return {
    account: {
      id: text(row, 'id'),
      username: text(row, 'username'),
      displayName: text(row, 'display_name'),
    },
    status,
    since: integer(row, 'created_at'),
  };
}

function sessionRecord(row: Row): SessionRecord {
  const visibility = text(row, 'visibility');
  const state = text(row, 'state');
  if (!isVisibility(visibility) || !isSessionState(state)) {
    throw new Error(`session ${text(row, 'id')} has an unknown visibility or state`);
  }
  return {
    id: text(row, 'id'),
    gameId: text(row, 'game_id'),
    name: text(row, 'name'),
    ownerId: text(row, 'owner_id'),
    visibility,
    maxPlayers: integer(row, 'max_players'),
    inviteCode: text(row, 'invite_code'),
    state,
    createdAt: integer(row, 'created_at'),
    lastActiveAt: integer(row, 'last_active_at'),
  };
}

function isVisibility(value: string): value is Visibility {
  return value === 'private' || value === 'friends' || value === 'public';
}

function isSessionState(value: string): value is SessionState {
  return Object.hasOwn(SESSION_TRANSITIONS, value);
}
