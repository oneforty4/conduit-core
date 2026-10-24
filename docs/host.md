# @conduit/lobby, @conduit/lobby-client and @conduit/host

Hosted save inspection uses `openApplicationSave(host.store, { scope: sessionId })`. Factories may return `saveSchema`, `saveLimits` and `saveCompatibilityAdapter`; callbacks stay inside workers. The bridge publishes each generation as one atomic batch. See [generation saves](generation-saves.md).

Packages `packages/lobby` (node), `packages/lobby-client` (iso) and `packages/host` (node). Together they are the production path of CONCEPT.md: one process runs the lobby HTTP API, a presence WebSocket, a WebSocket gateway and one `worker_threads` Worker per running game session.

Dependency graph (CONCEPT.md): `lobby -> persist, auth`; `host -> lobby, net-server, persist, auth`; `lobby-client -> nothing` (type-only import of lobby's API types). `@conduit/game/host`'s `createHost` (docs/game.md) is a thin wrapper over the `Host` class in section 22; the `conduit-host` CLI uses `Host` directly so the package graph stays acyclic.

Cross-references: docs/persist.md (BlobStore, SqliteStore, migrate, Autosaver, hashPassword, mintToken/verifyToken), docs/protocol.md (frame envelope, `Hello`, `Rejected`, `RejectReason`, `CoreKind`), docs/net.md (`Session`, `ClientLink`, `SessionHooks`, `TickStats`, reconnect), docs/sim.md (`FixedLoop`), docs/world.md (`RegionLoader`), docs/game.md (`createHost`, `createServer`, `GameDef`).

Time values in this document are unix milliseconds unless a name ends in `S` or `_s`. All JSON APIs use `Content-Type: application/json; charset=utf-8`.

---

Wire version 2 carries bounded simulation compatibility declarations through gateway Hello and
worker Welcome. The worker checks the session's pinned declaration before allocating a player
or rebinding a reconnect, including clients admitted with a valid lobby token. Deploy gateway,
worker and browser bundles together; wire version 1 frames fail predictably at the envelope.
Declared games reject schema-only callers. See docs/protocol.md 9.1 and docs/game.md for build-time
digests and migration mode; authentication alone does not establish simulation compatibility.

## Part A: @conduit/lobby

### 1. Schema

`src/schema.ts` exports `lobbyMigrations: Migration[]` for docs/persist.md's `migrate`. Version 1 contains the whole schema; later changes append versions. The host runs `migrate(store.db, lobbyMigrations)` at startup.

```sql
-- version 1
CREATE TABLE accounts (
  id            TEXT    PRIMARY KEY,                       -- ulid
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,    -- stored lowercase
  display_name  TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,                          -- docs/persist.md 2.2 format
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE sessions (
  id             TEXT    PRIMARY KEY,                      -- ulid
  game_id        TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  owner_id       TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  visibility     TEXT    NOT NULL CHECK (visibility IN ('private','friends','public')),
  max_players    INTEGER NOT NULL CHECK (max_players BETWEEN 1 AND 8),
  invite_code    TEXT    NOT NULL UNIQUE,                  -- 8 chars, INVITE_ALPHABET
  state          TEXT    NOT NULL CHECK (state IN ('created','running','idle','archived')),
  created_at     INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);
CREATE INDEX sessions_game_state ON sessions (game_id, state);
CREATE INDEX sessions_owner      ON sessions (owner_id);
CREATE INDEX sessions_visibility ON sessions (visibility, state);

CREATE TABLE session_members (
  session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  account_id TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, account_id)
) WITHOUT ROWID;
CREATE INDEX session_members_account ON session_members (account_id);

CREATE TABLE friends (
  account_id   TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  friend_id    TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status       TEXT    NOT NULL CHECK (status IN ('pending','accepted')),
  requested_by TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (account_id, friend_id),
  CHECK (account_id < friend_id),
  CHECK (requested_by IN (account_id, friend_id))
) WITHOUT ROWID;
CREATE INDEX friends_friend ON friends (friend_id);

CREATE TABLE lobby_sessions (
  token      TEXT    PRIMARY KEY,                          -- sha256 hex of the cookie value
  account_id TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX lobby_sessions_account ON lobby_sessions (account_id);
CREATE INDEX lobby_sessions_expires ON lobby_sessions (expires_at);
```

Each statement above is one entry of `up`. Rules:

- **friends** stores one row per pair with `account_id < friend_id` (string comparison of ulids). `pairKey(a, b)` returns `[min, max]`. `requested_by` is the account that sent the request. `status = 'pending'` is an open request; `'accepted'` is a friendship.
- **sessions.state** follows the state machine in section 8. Archived sessions are never listed or joinable and are kept for their blob namespaces; purging them is out of scope.
- **lobby_sessions** holds login cookies (section 2). `sessions` (game sessions) and `lobby_sessions` (logins) are unrelated tables.
- `PRAGMA foreign_keys=ON` is set by `SqliteStore` (docs/persist.md 1.6) so cascades apply.

### 2. Identifiers (`src/ids.ts`)

| Name | Value |
| --- | --- |
| `ULID_ALPHABET` | `'0123456789ABCDEFGHJKMNPQRSTVWXYZ'` (Crockford) |
| `ULID_RE` | `/^[0-9A-HJKMNP-TV-Z]{26}$/` |
| `INVITE_ALPHABET` | `'0123456789BCDFGHJKMNPQRSTVWXZ'` (29 chars: Crockford minus I L O U, minus vowels A E and Y) |
| `INVITE_CODE_LENGTH` | `8` |
| `INVITE_CODE_RE` | `/^[0-9BCDFGHJKMNPQRSTVWXZ]{8}$/` |
| `INVITE_RETRIES` | `5` |

```ts
export function ulid(now?: number): string;              // 10 time chars (ms, base32) + 16 chars from randomBytes(10)
export function inviteCode(): string;                    // 8 chars, each crypto.randomInt(29)
export function normalizeInviteCode(s: string): string | null;   // trim, uppercase, O→0, I→1, L→1; null unless INVITE_CODE_RE
```

`accounts.id` and `sessions.id` are ulids. Route parameters named `:id` must match `ULID_RE`; otherwise the route responds `404 not_found` without touching the database (the check runs before `auth`).

### 3. Cookie login (`src/cookies.ts`)

| Name | Value |
| --- | --- |
| `COOKIE_NAME` | `'conduit_sid'` |
| `LOBBY_SESSION_TTL_MS` | `2_592_000_000` (30 days) |
| `COOKIE_TOKEN_BYTES` | `32` |
| `PURGE_INTERVAL_MS` | `3_600_000` |

```ts
export function newCookieToken(): string;                       // base64url(randomBytes(32)), 43 chars
export function hashCookieToken(raw: string): string;            // sha256 hex
export function serializeSessionCookie(raw: string, opts: { secure: boolean; maxAgeS?: number }): string;
export function clearSessionCookie(opts: { secure: boolean }): string;
export function parseCookies(header: string | undefined): Map<string, string>;
export function isLocalhost(host: string | undefined): boolean;  // 'localhost', '127.0.0.1', '[::1]', with optional :port
```

- Login (and only login) inserts `lobby_sessions(token = hashCookieToken(raw), account_id, created_at = now, expires_at = now + LOBBY_SESSION_TTL_MS)` and sets the cookie with the **raw** token. The raw value is never stored.
- `Set-Cookie: conduit_sid=<raw>; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000` plus `; Secure` when `secure`. `secure = opts.secureCookies ?? !isLocalhost(Host header)`.
- `clearSessionCookie`: same attributes with an empty value and `Max-Age=0`.
- Authentication of a request: read `conduit_sid`, `SELECT account_id, expires_at FROM lobby_sessions WHERE token = ?` with the hashed value; missing → unauthenticated; `expires_at <= now` → delete the row, unauthenticated. No sliding expiry.
- Logout deletes the row for the presented cookie (if any) and clears the cookie.
- `LobbyService.purgeExpired()` deletes rows with `expires_at <= now`; the host calls it every `PURGE_INTERVAL_MS`.
- CSRF: the cookie is `SameSite=Lax`, and every state-changing route (`POST`, `DELETE`) with a non-empty body requires `Content-Type: application/json` (else `400 validation`; an empty body counts as none, since the Node adapter always passes a body stream). Cross-site form posts cannot satisfy both.

### 4. API types (`src/api.ts`)

This file has no runtime imports and is what `@conduit/lobby-client` imports with `import type`.

```ts
export type Visibility = 'private' | 'friends' | 'public';
export type SessionState = 'created' | 'running' | 'idle' | 'archived';
export type FriendStatus = 'accepted' | 'pending_in' | 'pending_out';   // pending_in: they asked me; pending_out: I asked them

export interface PublicAccount { id: string; username: string; displayName: string }
export interface Account extends PublicAccount { createdAt: number; lastLoginAt: number | null }
export interface MemberSummary extends PublicAccount { joinedAt: number }
export interface SessionSummary {
  id: string; gameId: string; name: string; ownerId: string; visibility: Visibility; maxPlayers: number;
  state: SessionState; memberCount: number; members: MemberSummary[]; createdAt: number; lastActiveAt: number;
  inviteCode?: string;                       // present only for the owner and members
}
export interface GameInfo { gameId: string; name: string; version: number }   // version = gameDef.protocolVersion
export interface FriendEntry { account: PublicAccount; status: FriendStatus; since: number }

export interface RegisterRequest { username: string; password: string; displayName?: string }
export interface RegisterResponse { account: Account }
export interface LoginRequest { username: string; password: string }
export interface LoginResponse { account: Account }
export interface MeResponse { account: Account; friends: FriendEntry[]; invites: SessionSummary[] }
export type GamesResponse = GameInfo[];
export type ListSessionsResponse = SessionSummary[];
export interface CreateSessionRequest { gameId: string; name: string; visibility: Visibility; maxPlayers: number }
export interface CreateSessionResponse { session: SessionSummary; inviteCode: string }
export interface JoinRequest { inviteCode?: string }
export interface JoinResponse { token: string; wsUrl: string }
export interface FriendResponse { friend: FriendEntry }

export type LobbyErrorCode =
  | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'validation'
  | 'session_full' | 'bad_invite' | 'rate_limited' | 'internal';
export interface ErrorResponse { error: LobbyErrorCode; message: string; field?: string }
export const ERROR_STATUS: Record<LobbyErrorCode, number> = {
  unauthorized: 401, forbidden: 403, not_found: 404, conflict: 409, validation: 400,
  session_full: 409, bad_invite: 403, rate_limited: 429, internal: 500,
};

export type LobbyEvent =
  | { t: 'friends'; online: string[] }
  | { t: 'session'; session: SessionSummary }
  | { t: 'invite'; session: SessionSummary; from: PublicAccount }
  | { t: 'pong' };
export type PresenceClientMessage = { t: 'hello' } | { t: 'ping' };
```

`internal` is the catch-all for unexpected exceptions (500); the other eight are the codes routes return deliberately.

### 5. Validation (`src/validate.ts`)

| Field | Rule | Error |
| --- | --- | --- |
| `username` | after `toLowerCase()`: `/^[a-z0-9_]{3,24}$/` | `validation`, `field: 'username'` |
| `password` | `validatePasswordLength` (docs/persist.md 2.2): 8..256 UTF-8 bytes | `validation`, `field: 'password'` |
| `displayName` | optional (absent means the default; present must be a string); trimmed; 1..32 chars; no code points < 0x20 or 0x7F and no lone surrogates; default = username as typed by the user (before lowercasing) | `validation`, `field: 'displayName'` |
| session `name` | trimmed; 1..48 chars; same character rule | `validation`, `field: 'name'` |
| `visibility` | one of `Visibility` | `validation`, `field: 'visibility'` |
| `maxPlayers` | integer 1..8 | `validation`, `field: 'maxPlayers'` |
| `gameId` | `games.has(gameId)` | `validation`, `field: 'gameId'` |
| `inviteCode` | `normalizeInviteCode` non-null, checked only when the caller needs a code (a non-string counts as absent) | `bad_invite` |
| JSON body | parses to a plain object | `validation`, message `'invalid JSON body'` |

`MAX_SESSIONS_PER_OWNER = 16`: non-archived sessions owned by one account; exceeding it is `409 conflict`.

`validate.ts` also exports `type Untrusted<T> = { readonly [K in keyof T]?: unknown }`. The validators and the service methods that take a request (`register`, `login`, `createSession`) accept `Untrusted<...Request>`, so routes pass the parsed JSON object through and the rules above run in one place; typed requests are assignable to it.

### 6. LobbyService (`src/service.ts`)

Pure logic over `DatabaseSync` and an `EventSink`. No HTTP, no sockets. All SQL lives here. Methods are synchronous except those that hash passwords or call the host. Writes that must be atomic run synchronously between `BEGIN IMMEDIATE` and `COMMIT`, never across an `await`, so they cannot interleave with a `SqliteStore.transaction` on the shared connection whose `fn` only awaits store calls (StoreBridge batches).

```ts
export interface SessionHostControl {
  start(sessionId: string, gameId: string): Promise<void>;     // resolves when the worker is ready; rejects on failure
  stop(sessionId: string, close?: { code: number; reason: string }): Promise<void>;   // flushes, stops, resolves when the worker exited; no-op if not running; close: for sockets still attached (SessionManager default 4111)
  isRunning(sessionId: string): boolean;
  touch?(sessionId: string): void;                              // a join of a running session: restart its idle timer (joinSession below)
  disconnect?(sessionId: string, accountId: string, code: number, reason: string): void;   // close that account's game sockets
}
export interface GameRegistry { list(): GameInfo[]; has(gameId: string): boolean }
export interface EventSink { emit(recipients: string[], event: LobbyEvent): void; online(): ReadonlySet<string> }
export interface LobbyServiceOptions {
  host: SessionHostControl; games: GameRegistry; secret: string;   // secret: HOST_SECRET, asserted with assertSecret
  now?: () => number;                                              // default Date.now
}
export class LobbyError extends Error {
  readonly code: LobbyErrorCode; readonly status: number; readonly field?: string;   // status = ERROR_STATUS[code]
  constructor(code: LobbyErrorCode, message: string, options?: { field?: string; cause?: unknown });
}

export class LobbyService {
  constructor(db: DatabaseSync, opts: LobbyServiceOptions);
  attachSink(sink: EventSink): void;                                  // default sink: emit no-op, online() empty

  // accounts
  register(input: Untrusted<RegisterRequest>): Promise<Account>;
  login(input: Untrusted<LoginRequest>): Promise<{ account: Account; cookieToken: string }>;   // raw cookie token
  logout(cookieToken: string | undefined): void;
  authenticate(cookieToken: string | undefined): Account | null;
  me(accountId: string): MeResponse;
  accountByUsername(username: string): PublicAccount | null;

  // sessions
  games(): GameInfo[];
  listSessions(accountId: string, gameId?: string): SessionSummary[];
  getSession(accountId: string, sessionId: string): SessionSummary;   // not_found if archived or invisible
  createSession(accountId: string, input: Untrusted<CreateSessionRequest>): CreateSessionResponse;
  joinSession(accountId: string, sessionId: string, inviteCode?: string): Promise<{ token: string; session: SessionSummary }>;
  leaveSession(accountId: string, sessionId: string): void;
  deleteSession(accountId: string, sessionId: string): Promise<void>;
  isMember(sessionId: string, accountId: string): boolean;
  markIdle(sessionId: string): void;                                  // host callback: running → idle
  markRunning(sessionId: string): void;                               // host callback (after a restart it did on its own)

  // friends
  requestFriend(accountId: string, username: string): FriendEntry;
  acceptFriend(accountId: string, requesterId: string): FriendEntry;
  removeFriend(accountId: string, otherId: string): void;
  friendIds(accountId: string): string[];                             // accepted only
  purgeExpired(): number;
}
```

Behaviour per method (errors are `LobbyError`; `status` from `ERROR_STATUS`):

- **register**: validate; `username = username.toLowerCase()`; `SELECT 1 FROM accounts WHERE username = ?` (NOCASE) → `conflict` ("username taken", `field: 'username'`; also when a concurrent registration wins the insert); `password_hash = await hashPassword(password)`; insert with `id = ulid()`, `created_at = now`, `last_login_at = NULL`; return `Account`. Does not log in.
- **login**: validate shape only (no length error leak: an out-of-range password yields `unauthorized`); lookup by lowercase username; if absent, run `verifyPassword(password, DUMMY_HASH)` (a constant hash of an unguessable string, generated once at module load) so timing is uniform, then `unauthorized` ("invalid credentials"); if `verifyPassword` is false → same error; if `needsRehash(hash)` → rehash and update; update `last_login_at`; create `lobby_sessions` row; return `{ account, cookieToken }`.
- **logout**: delete `lobby_sessions` row for `hashCookieToken(raw)`; never errors.
- **authenticate**: section 3.
- **me**: `friends` = every `friends` row involving the account, mapped to `FriendEntry` (`status` from the row: `accepted` → `'accepted'`; `pending` with `requested_by === me` → `'pending_out'`, else `'pending_in'`; `since = created_at`), sorted by `username`. `invites` = non-archived sessions with `visibility = 'friends'` whose `owner_id` is an accepted friend and where the caller is not a member, newest `last_active_at` first.
- **listSessions**: `state != 'archived'`, optional `game_id = ?`, and the visibility predicate:
  ```sql
  s.owner_id = :me
  OR EXISTS (SELECT 1 FROM session_members m WHERE m.session_id = s.id AND m.account_id = :me)
  OR s.visibility = 'public'
  OR (s.visibility = 'friends' AND EXISTS (SELECT 1 FROM friends f WHERE f.status = 'accepted'
        AND f.account_id = MIN(:me, s.owner_id) AND f.friend_id = MAX(:me, s.owner_id)))
  ```
  ordered by `last_active_at DESC` (then `id DESC`; `invites` too). `inviteCode` is included when the caller is owner or member.
- **createSession**: validate; owner session count < `MAX_SESSIONS_PER_OWNER` else `conflict`; in one SQL transaction: insert session (`id = ulid()`, `state = 'created'`, `invite_code = inviteCode()`, drawn again on a UNIQUE violation for up to `INVITE_RETRIES` attempts in all, then `internal`; `created_at = last_active_at = now`) and insert the owner into `session_members`. Emit `session` to the owner. If `visibility === 'friends'`, emit `invite { session, from: owner }` to `friendIds(owner)`, with the non-member view of the session (no `inviteCode`). Returns `{ session, inviteCode }`.
- **joinSession**: session exists and not archived else `not_found`. If already a member: skip capacity and invite checks (rejoin). Else: `visible = visibility === 'public' || owner_id === me || (visibility === 'friends' && isAcceptedFriend(me, owner))`; if not visible: `inviteCode` required and `normalizeInviteCode(inviteCode) === session.invite_code` else `bad_invite`; then `memberCount >= max_players` → `session_full`. If `state` is `created` or `idle`, or `!host.isRunning(id)`: `await host.start(id, game_id)` (rejection → `internal`, nothing else changes), then re-read the session, because it may have changed during the await: archived → `await host.stop(id, { code: 4106, reason: 'session_deleted' })` (no worker outlives the delete) and `not_found`; otherwise repeat the membership, invite and capacity checks (a concurrent join may have taken the last slot); then `state = 'running'`. Otherwise (the session is running) call `host.touch?.(id)` in the same turn as the `isRunning` check: a running session without sockets has its idle timer armed (section 19), and without the touch that timer could stop the worker between this join and the joiner's WebSocket connect, which the gateway would then refuse with `4104`; the touch restarts it, so the joiner has a full `IDLE_TIMEOUT_MS` to connect. Insert member if new; `last_active_at = now`. Mint `token = mintToken({ accountId, displayName, sessionId, exp: tokenExpiry(Math.floor(now / 1000)) }, secret)` (`now` from `opts.now`, like every other timestamp). Emit `session` to owner ∪ members. Return `{ token, session }`.
- **leaveSession**: not a member → `not_found`. Delete the member row; `last_active_at = now`; `host.disconnect?.(id, me, 4105, 'left')`; emit `session` to owner ∪ remaining members ∪ leaver (a leaver who is not the owner gets the non-member view, without `inviteCode`). The owner may leave; ownership does not change and the session remains visible to them.
- **deleteSession**: not found or archived → `not_found`; `owner_id !== me` → `forbidden`. `await host.stop(id, { code: 4106, reason: 'session_deleted' })` (flushes then stops, closing attached game sockets with `SESSION_DELETED`; a rejection whose `code` is `'not_running'` is ignored, any other is `internal` and the session stays open); if a concurrent delete archived it meanwhile, return; `state = 'archived'`; `last_active_at = now`; emit `session` (state archived) to owner ∪ members. Member rows are kept.
- **markIdle**: `UPDATE sessions SET state='idle' WHERE id=? AND state='running'`; if changed, emit `session`. **markRunning**: symmetric for `idle|created → running`.
- **requestFriend**: target by username else `not_found`; self → `validation`; row lookup by `pairKey`: none → insert `pending` with `requested_by = me`, return `pending_out`; `accepted` → `conflict`; `pending` requested by me → `conflict`; `pending` requested by them → update to `accepted` and return `accepted` (mutual request auto-accepts). Emit `friends` to both accounts (section 7).
- **acceptFriend(me, requesterId)**: row must exist with `status = 'pending'` and `requested_by = requesterId !== me` else `not_found`; update to `accepted`; emit `friends` to both.
- **removeFriend(me, otherId)**: delete the pair row in any status (decline, cancel or unfriend) else `not_found`; emit `friends` to both.
- **friendIds**: accepted rows in either column.

`toSummary(row, viewerId)` builds `SessionSummary` with a members join; every emitted `session` event carries the summary as seen by an owner (with `inviteCode`) only to owner/members, which is the whole recipient set, so one summary object per emission suffices. The exceptions are recipients who are not members: the leaver's copy in `leaveSession` and `invite` events use the non-member view. A failing `EventSink.emit` is logged, not thrown: the change it reports is already committed.

### 7. Presence (`src/presence.ts`)

The presence hub implements `EventSink` and owns the `/lobby` WebSocket connections. The host performs the upgrade (section 17) and hands over an authenticated socket.

```ts
export interface PresenceSocket {                         // structural subset of ws.WebSocket
  send(data: string): void; close(code?: number, reason?: string): void; terminate(): void; ping?(): void;
  on(event: 'message', cb: (data: unknown, isBinary: boolean) => void): void;
  on(event: 'close', cb: (code: number) => void): void;
  on(event: 'pong' | 'error', cb: () => void): void;
}
export const HELLO_TIMEOUT_MS = 5_000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_TIMEOUT_MS = 60_000;
export const MAX_PRESENCE_MESSAGE_BYTES = 4_096;

export interface PresenceHubOptions {                     // default the globals
  now?: () => number;
  setTimeout?(callback: () => void, ms: number): unknown; clearTimeout?(handle: unknown): void;
  setInterval?(callback: () => void, ms: number): unknown; clearInterval?(handle: unknown): void;
}
export class PresenceHub implements EventSink {
  constructor(service: LobbyService, opts?: PresenceHubOptions);
  attach(socket: PresenceSocket, account: PublicAccount): void;
  emit(recipients: string[], event: LobbyEvent): void;
  online(): ReadonlySet<string>;
  connections(accountId?: string): number;
  closeAll(code: number, reason: string): void;
}
```

Connection lifecycle:

1. `attach`: create `conn = { socket, accountId, helloed: false, lastSeen: now }`; add to `conns: Map<accountId, Set<Conn>>`; arm `helloTimer = setTimeout(HELLO_TIMEOUT_MS)` → on fire, `socket.close(4107, 'hello_timeout')`.
2. On `message`: binary or > `MAX_PRESENCE_MESSAGE_BYTES` or not JSON or not an object with string `t` → `socket.close(4108, 'bad_message')`. `lastSeen = now`. `t === 'hello'`: clear `helloTimer`; `helloed = true`; send the friends snapshot (below) to this connection; if this is the account's first helloed connection, send a friends snapshot to each online accepted friend (they see this account come online). `t === 'ping'`: send `{ t: 'pong' }`. Any other `t`: ignore. A second `hello` just resends the snapshot.
3. Heartbeat: one `setInterval(HEARTBEAT_INTERVAL_MS)` for the hub, armed by the first `attach` and cleared when the last connection is removed (unref'd with the default timers); for each connection, `socket.ping?.()` and, if `now - lastSeen > HEARTBEAT_TIMEOUT_MS`, `socket.terminate()`. `pong` and any message update `lastSeen`.
4. On `close`/`error`: remove the connection; if it was helloed and the account has no helloed connection left, send friends snapshots to each online accepted friend. When the hub itself closes a connection (4107, 4108, heartbeat `terminate`) it removes it the same way at once rather than waiting for the socket's `close`; `closeAll` closes and forgets every connection without snapshots. Exceptions inside socket callbacks and timers are logged, never thrown into `ws`.
5. `emit(recipients, event)`: for each recipient's helloed connections, `socket.send(JSON.stringify(event))`; errors from `send` are swallowed (the `close` handler cleans up).
6. `online()`: accounts with >= 1 helloed connection.
7. Friends snapshot for account `a`: `{ t: 'friends', online: service.friendIds(a).filter(id => online().has(id)) }`.

`LobbyEvent` emission table (when each fires, and to whom):

| Event | Fires | Recipients |
| --- | --- | --- |
| `friends` | after `hello`; a friend's first connection comes online or last connection goes offline; `requestFriend`, `acceptFriend`, `removeFriend` (the client re-fetches `/me` for details) | the account itself (after hello) / online accepted friends / both parties of the friendship change |
| `session` | `createSession`; `joinSession`; `leaveSession`; `deleteSession` (state `archived`); `markIdle`; `markRunning` | owner ∪ members (∪ the leaver for leave) |
| `invite` | `createSession` with `visibility = 'friends'` | accepted friends of the owner |
| `pong` | reply to `ping` | the sending connection only |

### 8. Session lifecycle

States: `created` → `running` → `idle` → `running` … and any non-archived state → `archived`. `archived` is terminal.

| From | Trigger | Actions (in order) | To |
| --- | --- | --- | --- |
| `created` | `joinSession` | `host.start(id, gameId)`; insert member; `last_active_at`; mint token; emit `session` | `running` |
| `idle` | `joinSession` | same as above | `running` |
| `running` | `joinSession` | (`host.isRunning` false, e.g. after a crash the host already reported) `host.start`; else `host.touch?` (restarts the idle timer); insert member if new; `last_active_at`; mint token; emit `session` | `running` |
| `running` | host idle timer (no attached game sockets for `IDLE_TIMEOUT_MS`) | host: `stop` (flush + shutdown) then `service.markIdle(id)`; emit `session` | `idle` |
| `running` | worker crash | host: close sockets 4110, `service.markIdle(id)`; emit `session` | `idle` |
| `created` \| `running` \| `idle` | `deleteSession` by owner | `host.stop(id, { code: 4106, reason: 'session_deleted' })` (a no-op if not running); `state = 'archived'`; emit `session` | `archived` |
| any | `leaveSession` | delete member; `last_active_at`; `host.disconnect?`; emit `session` | unchanged |
| `archived` | `joinSession` / `leaveSession` / `deleteSession` | `not_found` | — |

`src/state.ts` exports `SESSION_TRANSITIONS: Record<SessionState, SessionState[]>` = `{ created: ['running','archived'], running: ['idle','archived'], idle: ['running','archived'], archived: [] }` and `assertTransition(from, to)` (throws `LobbyError('conflict')`), which every state update goes through.

### 9. Rate limiting (`src/rate-limit.ts`)

```ts
export class RateLimiter {
  constructor(opts?: { limit?: number; windowMs?: number; now?: () => number });   // default limit 10, windowMs 60_000
  take(key: string): boolean;        // true = allowed
  reset(): void;
}
```

Token bucket per key: `Map<key, { tokens: number; updatedAt: number }>`; on `take`: refill `tokens = min(limit, tokens + (now - updatedAt) * limit / windowMs)`; if `tokens >= 1` subtract 1 and allow, else deny. Every 1000 calls, delete entries idle > 10 × `windowMs`. Applied to `POST /auth/register` and `POST /auth/login` (one bucket per IP for both, checked before the body is read) keyed by client IP: `c.env.remoteAddress`, or the first entry of `X-Forwarded-For` when `opts.trustProxy` (falling back to `remoteAddress` without the header). Missing IP → key `'unknown'`. Denied → `429 rate_limited` with header `Retry-After: 60`.

### 10. Routes (`src/routes.ts`)

```ts
export interface LobbyEnv { Bindings: { remoteAddress?: string; encrypted?: boolean }; Variables: { account?: Account } }
export interface LobbyRouteOptions {
  publicWsBase?: string;          // e.g. 'wss://play.example.com'; default derived per request
  secureCookies?: boolean;        // default !isLocalhost(Host)
  trustProxy?: boolean;           // default false
  rateLimiter?: RateLimiter;      // default new RateLimiter()
}
export function lobbyRoutes(service: LobbyService, opts?: LobbyRouteOptions): Hono<LobbyEnv>;
export function deriveWsBase(c: Context<LobbyEnv>, opts: LobbyRouteOptions): string;
```

`deriveWsBase`: `opts.publicWsBase` if set (trailing slash stripped); else `proto = (trustProxy && X-Forwarded-Proto === 'https') || c.env.encrypted ? 'wss' : 'ws'`, `host = (trustProxy && X-Forwarded-Host) || Host header || the request URL's host` (`app.request` sends no `Host`), result `${proto}://${host}`. `X-Forwarded-*` headers count by their first comma-separated entry.

Middleware is attached per route, never with `use('*')`, so mounting the app with `route('/', …)` leaves the host's other routes alone (its `onError` still applies to its own routes). `auth` reads the cookie, calls `service.authenticate`, sets `c.var.account` or responds `401 unauthorized`. `json` parses the body (`400 validation` on failure; enforces `Content-Type` per section 3); a body over `MAX_JSON_BODY_BYTES = 65_536` (exported) is refused with `400 validation` without being buffered. `onError` maps `LobbyError` to `{ error, message, field? }` with its status; any other error → `500 { error: 'internal', message: 'internal error' }` and logs the stack. `notFound` → `404 not_found`.

| Method, path | Auth | Request | Success | Errors |
| --- | --- | --- | --- | --- |
| `POST /auth/register` | no; rate limited | `RegisterRequest` | `201 RegisterResponse` | `validation`, `conflict`, `rate_limited` |
| `POST /auth/login` | no; rate limited | `LoginRequest` | `200 LoginResponse` + `Set-Cookie` | `validation` (shape only), `unauthorized`, `rate_limited` |
| `POST /auth/logout` | no | — | `204` + clearing `Set-Cookie` | — |
| `GET /me` | yes | — | `200 MeResponse` | `unauthorized` |
| `GET /games` | no | — | `200 GamesResponse` | — |
| `GET /sessions?gameId=` | yes | query `gameId` optional | `200 ListSessionsResponse` | `unauthorized` |
| `POST /sessions` | yes | `CreateSessionRequest` | `201 CreateSessionResponse` | `validation`, `conflict` |
| `GET /sessions/:id` | yes | — | `200 SessionSummary` | `not_found` |
| `POST /sessions/:id/join` | yes | `JoinRequest` (body optional) | `200 JoinResponse` with `wsUrl = ${deriveWsBase()}/session/${id}` | `not_found`, `bad_invite`, `session_full`, `internal` |
| `POST /sessions/:id/leave` | yes | — | `204` | `not_found` |
| `DELETE /sessions/:id` | yes | — | `204` | `not_found`, `forbidden` |
| `POST /friends/:username` | yes | — | `201 FriendResponse` (`200` when auto-accepted) | `not_found`, `validation`, `conflict` |
| `POST /friends/:id/accept` | yes | — | `200 FriendResponse` | `not_found` |
| `DELETE /friends/:id` | yes | — | `204` | `not_found` |

`GET /sessions/:id` is an addition for menus that deep-link by id; it applies the visibility predicate. `:id` params are validated against `ULID_RE`; `:username` is lowercased. Responses to `HEAD`/`OPTIONS` are Hono defaults. No CORS headers are emitted: the client is served from the same origin (static files, section 22); a game that hosts its client elsewhere adds Hono's `cors()` itself.

### 11. Files: packages/lobby

Dependencies: `hono`, `@conduit/persist`, `@conduit/auth`. `ws` is not imported (`PresenceSocket` is structural).

`src/`

| File | Exports |
| --- | --- |
| `index.ts` | re-exports everything below |
| `api.ts` | every type in section 4, `ERROR_STATUS` |
| `errors.ts` | `LobbyError` |
| `schema.ts` | `lobbyMigrations` |
| `ids.ts` | `ULID_ALPHABET`, `ULID_RE`, `INVITE_ALPHABET`, `INVITE_CODE_LENGTH`, `INVITE_CODE_RE`, `INVITE_RETRIES`, `ulid`, `inviteCode`, `normalizeInviteCode` |
| `validate.ts` | `USERNAME_RE`, `MAX_DISPLAY_NAME_CHARS`, `MAX_SESSION_NAME_CHARS`, `MAX_SESSIONS_PER_OWNER`, `Untrusted`, `validateRegister`, `validateLogin`, `validateCreateSession`, `validateDisplayName`, `validateSessionName` |
| `cookies.ts` | section 3 constants and functions |
| `rate-limit.ts` | `RateLimiter` |
| `state.ts` | `SESSION_TRANSITIONS`, `assertTransition` |
| `service.ts` | `LobbyService`, `LobbyServiceOptions`, `SessionHostControl`, `GameRegistry`, `EventSink`, `pairKey` |
| `presence.ts` | `PresenceHub`, `PresenceHubOptions`, `PresenceSocket`, `HELLO_TIMEOUT_MS`, `HEARTBEAT_INTERVAL_MS`, `HEARTBEAT_TIMEOUT_MS`, `MAX_PRESENCE_MESSAGE_BYTES` |
| `routes.ts` | `lobbyRoutes`, `LobbyRouteOptions`, `LobbyEnv`, `deriveWsBase`, `MAX_JSON_BODY_BYTES` |

`test/` (each test builds `new SqliteStore(':memory:')`, runs `migrate`, a `FakeHostControl` recording calls with controllable `start` outcomes, a `StaticGameRegistry([{ gameId: 'sandbox', name: 'Sandbox', version: 1 }])`, a `RecordingSink`, and calls routes through `app.request(path, init, { remoteAddress })`; these fakes, a manual clock and a fake presence socket live in `test/helpers.ts`, and the node:sqlite tests skip like persist's where it is unavailable)

| File | Proves |
| --- | --- |
| `schema.test.ts` | `migrate` twice is idempotent; `friends` rejects `account_id >= friend_id` and `requested_by` outside the pair; `sessions` rejects `max_players` 0 and 9, bad `visibility`/`state`; `accounts.username` UNIQUE is case-insensitive; deleting an account cascades members, friends and lobby sessions |
| `ids.test.ts` | `ulid` is 26 chars matching `ULID_RE`, time-ordered across ms; `inviteCode` matches `INVITE_CODE_RE` over 10 000 draws with every alphabet char observed; `normalizeInviteCode(' abcd-efgh ')` is `null`, `'bcdfghjk'` → `'BCDFGHJK'`, `'0O1IL2'`-style mapping |
| `cookies.test.ts` | serialize/clear attribute strings exact; `Secure` present iff `secure`; `parseCookies` handles multiple cookies and quotes; `isLocalhost` cases with ports and IPv6 |
| `rate-limit.test.ts` | 10 allowed then denied within the window; refills over time with injected `now`; keys isolated |
| `auth-routes.test.ts` | register returns 201 and `Account` without `passwordHash`; duplicate username differing in case → 409; bad username/password → 400 with `field`; login sets `conduit_sid` cookie with `HttpOnly; SameSite=Lax; Max-Age=2592000` and no `Secure` for Host `localhost:8080`, `Secure` for `play.example.com`; `/me` with the cookie → 200, without → 401, with a tampered cookie → 401; logout clears the cookie and the old cookie is then rejected; expired `lobby_sessions` row is rejected and deleted; 11th login attempt from one IP in a minute → 429 with `Retry-After`; password rehash when `needsRehash` |
| `sessions.test.ts` | create → 201, owner is a member, `inviteCode` 8 chars; 17th session → 409; visibility: public listed for strangers, private not, friends-visible listed only for accepted friends of the owner, own and member sessions always; join private without code → 403 `bad_invite`, wrong code → 403, right code (lowercase, with `O` for `0`) → 200 with `token` verifiable by `verifyToken` (`sessionId` = id, `displayName` = joiner's) and `wsUrl` `ws://localhost/session/<id>` (and `wss://` with `X-Forwarded-Proto` when `trustProxy`); `maxPlayers = 2` third join → 409 `session_full`; rejoin by a member bypasses code and capacity; first join calls `host.start` once and state becomes `running`; second join does not call `start`; every join of a running session (a new member or a rejoin) calls `touch` and a refused one does not, while a join that starts the worker (idle, or its worker gone) never touches; `start` rejection → 500 and no member row; `markIdle` → `idle`, join → `start` again → `running`; delete by non-owner → 403; delete by owner calls `host.stop` and archives, later join → 404; leave removes the member, calls `disconnect(4105)`, updates `last_active_at`; `assertTransition` rejects `archived → running` |
| `friends.test.ts` | request → `pending_out` for A, `/me` shows `pending_in` for B; mutual request auto-accepts; accept by the wrong party → 404; duplicate request → 409; remove in each status; `friendIds` symmetric; friends-visible session appears in B's `/me.invites` only while accepted and not a member |
| `presence.test.ts` | with fake sockets and injected timers: no `hello` in 5 s → close 4107; binary message → 4108; `hello` yields `friends` with only online accepted friends; friend connecting/disconnecting sends updated `friends` to the other; `ping` → `pong`; `createSession` emits `session` to the owner and `invite` to online friends when `visibility = 'friends'`; join/leave/delete emit `session` to the right recipient sets; heartbeat terminates a silent connection after 60 s; `closeAll` closes every socket with the given code |

---

## Part B: @conduit/lobby-client

### 12. LobbyClient (`src/client.ts`)

Isomorphic: browser and Node >= 22 (global `fetch` and `WebSocket`). Runtime dependencies: none. `devDependencies: @conduit/lobby` for `import type { ... } from '@conduit/lobby'`; eslint `consistent-type-imports` keeps it type-only.

```ts
export interface LobbyClientOptions {
  baseUrl: string;                          // 'https://play.example.com', or '' (or a path such as '/api') for same-origin
  fetch?: typeof fetch;                     // default globalThis.fetch
  WebSocket?: typeof WebSocket;             // default globalThis.WebSocket
  cookieMode?: 'browser' | 'manual';        // default 'manual' when typeof document === 'undefined', else 'browser'
}
export class LobbyClient {
  constructor(opts: LobbyClientOptions);
  register(username: string, password: string, displayName?: string): Promise<Account>;
  login(username: string, password: string): Promise<Account>;
  logout(): Promise<void>;
  me(): Promise<MeResponse>;
  games(): Promise<GameInfo[]>;
  listSessions(gameId?: string): Promise<SessionSummary[]>;
  getSession(id: string): Promise<SessionSummary>;
  createSession(input: CreateSessionRequest): Promise<CreateSessionResponse>;
  join(id: string, inviteCode?: string): Promise<JoinResponse>;     // { token, wsUrl }
  leave(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  requestFriend(username: string): Promise<FriendEntry>;
  acceptFriend(accountId: string): Promise<FriendEntry>;
  removeFriend(accountId: string): Promise<void>;
  connectPresence(): PresenceConnection;                              // one shared connection; repeat calls return it until it is closed, then a new one
  onPresence(cb: (ev: LobbyEvent) => void): () => void;              // connectPresence() + on('event', cb); returns unsubscribe
  readonly cookie: string | null;                                     // manual mode only
}
export class LobbyError extends Error {
  constructor(code: LobbyErrorCode | 'network', status: number, message: string, options?: { field?: string; cause?: unknown });
  readonly code: LobbyErrorCode | 'network';
  readonly status: number;                                            // 0 for network
  readonly field?: string;
}
```

- Every request: `credentials: 'include'`, `Accept: application/json`, JSON body with `Content-Type: application/json` when present (`join` without a code sends `{}`). In `manual` mode, the client captures `Set-Cookie` from `login` (Node's `fetch` exposes it via `headers.getSetCookie()`; a `conduit_sid` on any response is taken, and one with an empty value or `Max-Age` <= 0 clears it), stores the `conduit_sid` value in `cookie`, sends `Cookie: conduit_sid=<v>` on later requests and presence connection attempts, and clears it on `logout()` (even when that request fails) or a `401` from any route except `POST /auth/login`, whose `401` means bad credentials and leaves the cookie alone.
- `logout()` and such a `401` also close the presence connection (§13): the lobby does not close presence sockets on logout, and a refused `/lobby` upgrade looks like a network failure to the socket, so this is what ends its reconnect attempts.
- Response handling: `2xx` with a body → `JSON.parse` (not JSON → `internal` with the status); an empty body (`204`) → `undefined`; non-2xx → throw `LobbyError` from the `ErrorResponse` body with the response status (or `{ code: 'internal', status }` when the body is not an `ErrorResponse`, e.g. a proxy's HTML 502); `fetch` rejection or an unreadable body → `LobbyError('network', 0)`.
- `register` and `login` return `response.account`; `requestFriend` and `acceptFriend` return `response.friend`.

### 13. PresenceConnection (`src/presence.ts`)

```ts
export type PresenceState = 'connecting' | 'open' | 'closed';
export interface PresenceEvents {
  event: (ev: LobbyEvent) => void;          // every server message except pong
  friends: (online: string[]) => void; session: (s: SessionSummary) => void; invite: (s: SessionSummary, from: PublicAccount) => void;
  open: () => void; close: (code: number, willRetry: boolean) => void; error: (err: unknown) => void;
}
export const PRESENCE_PING_INTERVAL_MS = 25_000;
export const PRESENCE_BACKOFF_MIN_MS = 1_000;
export const PRESENCE_BACKOFF_MAX_MS = 30_000;
export interface PresenceConnectionOptions {
  url: string;                              // wsUrlFor(baseUrl, '/lobby')
  WebSocket: typeof WebSocket;
  cookie?: () => string | null;             // manual mode: 'conduit_sid=<v>' for each attempt, null for none
}
export class PresenceConnection {
  constructor(opts: PresenceConnectionOptions);   // built by LobbyClient.connectPresence(); connects at once, throws what the first `new WebSocket` throws
  on<K extends keyof PresenceEvents>(event: K, cb: PresenceEvents[K]): () => void;
  close(): void;                            // stops reconnecting; state 'closed'
  readonly state: PresenceState;            // 'connecting' also while waiting to retry
}
```

- URL: `baseUrl` with `http` → `ws`, `https` → `wss` (`''` or a path-only `baseUrl` → `location.origin` mapped the same way) plus `/lobby`. In `manual` mode the socket is created with `new WebSocket(url, { headers: { Cookie } })` (undici option), the cookie read afresh for every attempt; in `browser` mode, and in `manual` mode without a cookie, with `new WebSocket(url)` (a browser attaches its cookies automatically).
- On `open`: send `{ t: 'hello' }`, start a `ping` timer every `PRESENCE_PING_INTERVAL_MS`, emit `open`, reset backoff.
- On `message`: parse JSON; dispatch `event` plus the typed event; `pong` is swallowed. A message that is not JSON text, not an object with a string `t`, or a known `t` with a malformed payload emits `error`; an unknown `t` (a newer lobby) is ignored.
- On `close`: emit `close(code, willRetry)`; if not closed by the user and the code is not `4101` (unauthorized: the lobby cookie is no longer valid), reconnect after `backoff = min(max, prev * 2)` starting at `min`, with ±20% jitter: each wait is `round(backoff × (0.8 + 0.4 × Math.random()))`. A `1000`/`1001` from the server (shutdown) also retries. The host refuses an upgrade without a valid cookie with HTTP 401 (§17), which a WebSocket reports as `1006` like any network failure, so that retries too until `LobbyClient` closes the connection (§12). A `WebSocket` constructor that throws on a reconnect attempt emits `error` and schedules the next attempt.
- `close()`: clear timers, `socket.close(1000)`, no retry. The socket's close event still emits `close(code, false)`; nothing else is dispatched afterwards.
- Listeners run in registration order; one that throws does not stop the others, and its error is rethrown in a microtask.

### 14. Files: packages/lobby-client

`src/`

| File | Exports |
| --- | --- |
| `index.ts` | re-exports below, re-exports the API types from `@conduit/lobby` with `export type` |
| `client.ts` | `LobbyClient`, `LobbyClientOptions` |
| `errors.ts` | `LobbyError` |
| `presence.ts` | `PresenceConnection`, `PresenceConnectionOptions`, `PresenceEvents`, `PresenceState`, `PRESENCE_PING_INTERVAL_MS`, `PRESENCE_BACKOFF_MIN_MS`, `PRESENCE_BACKOFF_MAX_MS` |
| `http.ts` | `request<T>(opts: RequestOptions): Promise<T>` (fetch wrapper; `RequestOptions` = `{ fetch, url, method?, body?, headers?, onResponse? }`), `HttpMethod`, `wsUrlFor(baseUrl, path)` |

`test/`

| File | Proves |
| --- | --- |
| `client.test.ts` | with `fetch` stubs: every method's route, method and body, with `credentials: 'include'` and JSON headers on every call; path and query encoding; empty `2xx` → `undefined`; `400` with `field`; non-JSON 502 body, non-`ErrorResponse` JSON and non-JSON `2xx` → `internal`; `fetch` throwing or an unreadable body → `network` with status 0; `manual` mode captures, replays and clears `conduit_sid` (`Max-Age=0`, `logout` even offline, a `401` but not a failed login); `browser` mode (the default with a `document`) neither stores nor sends it; `wsUrlFor` cases. Against a real lobby (skipped without `node:sqlite`): `lobbyRoutes` served over `node:http` with an in-memory `SqliteStore` (imported from `packages/persist/src`, which is not a dependency) migrated with `lobbyMigrations`, a fake `SessionHostControl`, and a minimal RFC 6455 upgrade that hands cookie-authenticated `/lobby` sockets to a `PresenceHub`; clients use Node's `fetch` and `WebSocket` in `manual` mode: register/login/me/games/create/list/get/join/leave/delete/friends round-trips are typed and correct (`wsUrl`, the token's `sessionId`, the fake host's `start`/`stop`/`disconnect` calls); `Set-Cookie` captured and replayed; `401` → `LobbyError('unauthorized')` with `status 401` and clears the cookie; `409`, `400` with `field`; the presence socket authenticates with the cookie and receives `friends`/`invite`/`session` events in order; without a cookie it closes `1006` and retries |
| `presence.test.ts` | with a fake `WebSocket` class and fake timers: `hello` sent on open; `ping` every 25 s; `friends`/`session`/`invite` dispatched to both `event` and typed listeners; `pong` not dispatched; malformed messages → `error`, unknown `t` ignored; unexpected close → reconnect at 1 s, 2 s, 4 s … capped at 30 s, an open resets it, jitter within ±20%; `4101` does not retry; `close()` stops retries (open, connecting or waiting); a constructor throwing on a retry keeps retrying; a throwing listener does not starve the others; `connectPresence` shares one connection until it is closed; `onPresence` returns an unsubscribe that stops delivery; `manual` mode passes `{ headers: { Cookie } }` read per attempt; `logout` and a `401` close the connection |
| `errors.test.ts` | `LobbyError` fields (`field`, `cause`) and `instanceof` across `code` values, through throw and rejection; `request()` rejects with each `ErrorResponse` code and the HTTP status |

---

## Part C: @conduit/host

### 15. Process model

One Node process. The **main thread** runs:

- one `http.Server` on `PORT` handling, in order: `/healthz`, the lobby routes (section 10), static files when `STATIC_DIR` is set;
- the WebSocket gateway (`ws` `WebSocketServer({ noServer: true })`) handling upgrades for `/lobby` (presence) and `/session/:id` (game sockets);
- the `SqliteStore` (`DB_PATH`) that owns the only database connection, `lobbyMigrations`, `LobbyService`, `PresenceHub`, `SessionManager`, the `StoreBridge` that serves worker store requests, the hourly `purgeExpired` timer, and signal handling.

Each running game session is a **`worker_threads` Worker** running `src/worker.ts` (section 21) with its own `Session` (docs/net.md). Sockets never leave the main thread: frames cross the `MessagePort` as transferred `ArrayBuffer`s (section 18). A crashed worker cannot take the HTTP server down; a slow worker cannot stall another session's sockets.

Constants (`src/constants.ts`):

| Name | Value |
| --- | --- |
| `DEFAULT_PORT` | `8080` |
| `DEFAULT_DB_PATH` | `'./conduit.sqlite'` |
| `IDLE_TIMEOUT_MS` | `300_000` |
| `WORKER_READY_TIMEOUT_MS` | `10_000` |
| `SHUTDOWN_GRACE_MS` | `5_000` |
| `FLUSH_TIMEOUT_MS` | `10_000` |
| `SHUTDOWN_DEADLINE_MS` | `15_000` |
| `STATS_INTERVAL_MS` | `100` |
| `TICK_STATS_INTERVAL_MS` | `1_000` |
| `HELLO_TIMEOUT_MS` | `5_000` |
| `MAX_CLIENT_FRAME_BYTES` | `65_536` (`ws` `maxPayload` for `/session`) |
| `MAX_SOCKET_BUFFERED_BYTES` | `1_048_576` (main-thread safety net; the Session's 64 KB skip rule in docs/net.md is the primary control) |
| `MAX_PRESENCE_MESSAGE_BYTES` | `4_096` (`ws` `maxPayload` for `/lobby`) |

### 16. Configuration (`src/config.ts`)

```ts
export interface HostConfig {
  port: number; secret: string; dbPath: string; staticDir?: string; publicWsBase?: string;
  idleTimeoutMs: number; trustProxy: boolean; logLevel: LogLevel;
}
export type HostConfigOverrides = { [K in keyof HostConfig]?: HostConfig[K] | undefined };   // undefined counts as absent
export class ConfigError extends Error { readonly variable: string }
export function loadConfig(env?: NodeJS.ProcessEnv, overrides?: HostConfigOverrides): HostConfig;
```

| Variable | Default | Rule |
| --- | --- | --- |
| `PORT` | `8080` | integer 0..65535 |
| `HOST_SECRET` | required | `assertSecret` (>= 32 UTF-8 bytes); missing/short → `ConfigError` |
| `DB_PATH` | `./conduit.sqlite` | any path; `:memory:` allowed |
| `STATIC_DIR` | unset | must be an existing directory when set; stored as an absolute path |
| `PUBLIC_WS_BASE` | unset (derived from the request `Host`, section 10) | `ws://` or `wss://` prefix, no trailing slash |
| `IDLE_TIMEOUT_MS` | `300000` | integer >= 1000 |
| `TRUST_PROXY` | `false` | `'1'`/`'true'` (`'0'`/`'false'` are false; anything else → `ConfigError`) |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

`overrides` (`HostOptions`; the CLI passes its flags as the variables they override) win over `env`, and are validated the same way; an empty variable counts as unset.

### 17. Gateway (`src/gateway.ts`)

```ts
export const GATEWAY_CLOSE = {                         // defined in constants.ts, re-exported here
  BAD_TOKEN: 4101, TOKEN_EXPIRED: 4102, SESSION_MISMATCH: 4103, SESSION_NOT_RUNNING: 4104,
  LEFT: 4105, SESSION_DELETED: 4106, HELLO_TIMEOUT: 4107, BAD_FRAME: 4108, NOT_MEMBER: 4109,
  WORKER_CRASHED: 4110, SHUTTING_DOWN: 4111, SLOW_CLIENT: 4112,
} as const;
export interface GatewayOptions {
  secret: string; service: Pick<LobbyService, 'authenticate' | 'isMember'>; presence: Pick<PresenceHub, 'attach'>;
  sessions: Pick<SessionManager, 'isRunning' | 'attach'>; logger: Logger;
  now?: () => number;                                   // unix ms, for token expiry; default Date.now
  setTimeout?; clearTimeout?;                           // the Hello timer, injectable for tests
}
export class Gateway {
  constructor(opts: GatewayOptions);
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;   // bound to server.on('upgrade')
  closeAll(code: number, reason: string): void;
  readonly accepting: boolean;                                              // false after stopAccepting()
  stopAccepting(): void;
}
```

Upgrade handling:

1. `!accepting` → respond `HTTP/1.1 503 Service Unavailable` on the raw socket and destroy.
2. Path `/lobby`: `account = service.authenticate(cookie)`; `null` → `401 Unauthorized` on the raw socket, destroy. Else `wssPresence.handleUpgrade(...)` then `presence.attach(ws, account)`.
3. Path `/session/:id` with `:id` matching `ULID_RE`: `wssSession.handleUpgrade(...)` and proceed to the Hello check below. The upgrade is always accepted for a well-formed path so the client receives a decodable `Rejected` message rather than an opaque HTTP failure.
4. Any other path → `404 Not Found` on the raw socket, destroy.

Hello check (the token travels inside `Hello`, docs/protocol.md 9.1, not in the URL):

1. Arm `HELLO_TIMEOUT_MS`; on expiry → `reject(HELLO_TIMEOUT, RejectReason.BadToken, 'hello timeout')`.
2. On the first `message`: text frame, or binary frame that fails `readFrame` (`DecodeError`), or `messageCount !== 1`, or the message kind is not `CoreKind.Hello`, or the Hello payload fails `decodeWith(HelloSchema)` → `reject(BAD_FRAME, RejectReason.ProtocolVersion, 'expected Hello')`. The gateway decodes **only** the Hello payload; `protocolVersion`/`registryHash` are the worker's business (docs/net.md).
3. `identity = verifyToken(hello.sessionToken, secret, now, { allowExpired: true })` (docs/persist.md 2.3). `null` (malformed or forged) → `reject(BAD_TOKEN, RejectReason.BadToken, 'bad token')`. `tokenExpired = isTokenExpired(identity, now)`; an expired token passes only when `hello.reconnectToken !== ''`, otherwise → `reject(TOKEN_EXPIRED, RejectReason.BadToken, 'token expired')`. Session tokens live `TOKEN_TTL_S` (10 minutes) while a player may reconnect long after joining: the expired token still proves the account and the session, and the gateway hands the identity to the worker marked `tokenExpired`, where the Session lets it resume only the player its reconnect token names; anything else is `Rejected{BadToken}` and close 4008 (docs/net.md A.6). A fresh join always needs an unexpired token.
4. `identity.sessionId !== :id` → `reject(SESSION_MISMATCH, RejectReason.BadToken, 'token is for another session')`.
5. `!service.isMember(:id, identity.accountId)` → `reject(NOT_MEMBER, RejectReason.BadToken, 'not a member')`.
6. `!sessions.isRunning(:id)` → `reject(SESSION_NOT_RUNNING, RejectReason.SessionNotRunning, 'session not running')`.
7. Otherwise `sessions.attach(:id, { ws, clientId: nextClientId++, identity, helloFrame, tokenExpired })` (section 19). `clientId` is a process-wide `u32` counter starting at 1, never reused. Steps 2-7 run synchronously in the first `message` handler, so frames the client sent right after its Hello reach the listener `attach` installs.

`reject(code, reason, detail)`: encode one frame with a single `Rejected` message (`tick 0`, `seq 0`, payload `{ reason, detail }`) via `FrameWriter`, `ws.send(frame)`, then `ws.close(code, detail)`. The close reason string equals `detail`, <= 123 bytes.

Close codes are also used by the SessionManager (`LEFT`, `SESSION_DELETED`, `WORKER_CRASHED`, `SHUTTING_DOWN`, `SLOW_CLIENT`) and the PresenceHub (`4107`, `4108`, `4111`). Codes 1000–1015 are `ws`'s; the Session's own codes (docs/net.md A.3) are 4000–4099, so this table (4100–4199) never collides with them, and net-client's `isReconnectableClose` treats `4110`/`4111` as reconnectable and the rest of this table as final.

### 18. Port protocol (`src/port-protocol.ts`)

```ts
export interface WorkerData {
  sessionId: string; gameId: string; gameModule: string;        // gameModule: file URL importable in the worker
  logLevel: LogLevel; extra?: Record<string, unknown>;            // extra: HostOptions.workerExtra, opaque to core
}

export type StoreOp =
  | { op: 'get'; ns: string; key: string }
  | { op: 'put'; ns: string; key: string; value: ArrayBuffer }
  | { op: 'delete'; ns: string; key: string }
  | { op: 'list'; ns: string; prefix: string }
  | { op: 'batch'; ops: BatchOp[] };
export type BatchOp = { op: 'put'; ns: string; key: string; value: ArrayBuffer } | { op: 'delete'; ns: string; key: string };
export type StoreValue = ArrayBuffer | string[] | null | undefined;   // get → ArrayBuffer|null, list → string[], others → undefined

export type MainToWorker =
  | { t: 'attach'; clientId: number; identity: SessionToken; tokenExpired: boolean; helloFrame: ArrayBuffer }   // transfer: helloFrame
  | { t: 'frame'; clientId: number; buf: ArrayBuffer }                                    // transfer: buf
  | { t: 'closed'; clientId: number; code: number; reason: string }
  | { t: 'stats'; entries: [clientId: number, bufferedAmount: number][] }                 // every STATS_INTERVAL_MS
  | { t: 'flush'; reqId: number }
  | { t: 'shutdown'; graceMs: number; code: number; reason: string }
  | { t: 'storeResult'; reqId: number; ok: true; value?: StoreValue }                     // transfer: value when ArrayBuffer
  | { t: 'storeResult'; reqId: number; ok: false; error: { code: string; message: string } };

export type WorkerToMain =
  | { t: 'ready' }
  | { t: 'send'; clientId: number; buf: ArrayBuffer }                                     // transfer: buf; net-server's PortLinkSend
  | { t: 'close'; clientId: number; code: number; reason: string }                        // net-server's PortLinkClose
  | { t: 'flushed'; reqId: number; ok: boolean; error?: string }
  | { t: 'tickStats'; stats: TickStats }                                                  // every TICK_STATS_INTERVAL_MS; TickStats from docs/net.md
  | ({ t: 'store'; reqId: number } & StoreOp)                                             // transfer: every ArrayBuffer value
  | { t: 'log'; level: LogLevel; msg: string; data?: unknown }
  | { t: 'fatal'; error: { message: string; stack?: string } };
```

Field rules:

- `attach.helloFrame` is the complete first frame the gateway received, so the worker's `Session` handshake (docs/net.md A.5, A.6: `attach(link, identity?, opts?)`) runs unchanged: the worker creates a `PortLink`, calls `session.attach(link, identity, { tokenExpired })`, then delivers `helloFrame` through `link` as its first message. The Session re-checks `protocolVersion`/`registryHash` and replies `Welcome` or `Rejected` itself. Because an identity is passed, the Session does not consult a `TokenVerifier` (it has no secret); `identity` is authoritative, and so is `tokenExpired`, the gateway's verdict (section 17), which the Session uses instead of reading the clock again.
- `frame.buf`: a standalone `ArrayBuffer` (the main thread copies `ws`'s pooled `Buffer` slice with `buf.buffer.slice(byteOffset, byteOffset + byteLength)`; risk 7 of CONCEPT.md is measured here. Spike 7 prototyped batching frames per tick in both directions and measured no main-thread gain at 2 and 6 clients, since socket I/O dominates, so every frame stays one message).
- `closed`: sent for every socket the worker was told about, exactly once, including sockets the worker itself asked to close (`close` → main closes → `closed` echoes back with the same code).
- `stats.entries` covers every attached client of that worker, in any order; a client missing from an entry list keeps its last value.
- `shutdown`: the worker closes every client with the given `code`/`reason` (each `link.close` posts `close`), then `session.stop()` stops the loop and makes the only shutdown save (the Autosaver hookup, section 21), then the worker exits with code 0 (1 when that save failed). `graceMs` is informational (the main thread enforces it).
- `storeResult.value` for `get` is an `ArrayBuffer` transferred back (or `null`); for `list` a `string[]`; absent for `put`/`delete`/`batch`.
- `store` requests: `reqId` is a per-worker counter starting at 1; the main thread answers each exactly once. Requests are independent; the worker may pipeline.
- `tickStats.stats` is `session.tickStats()` (docs/net.md) verbatim.
- `log` and `fatal`: the main thread prefixes `[session <id>]`. `fatal` is sent before the worker exits with a non-zero code on an unrecoverable error (game module import failure, `sessionFactory` throw, load failure, uncaught exception).

### 19. SessionManager (`src/session-manager.ts`)

```ts
export interface RegisteredGame { def: RegisteredGameDef; module: string | undefined }
export interface RegisteredGameDef { id: string; name: string; protocolVersion: number; tickRate: number; snapshotEvery: number }   // any GameDef (docs/game.md) satisfies this
export interface SessionFactoryOptions { log: SessionLog }                // the worker's log (section 21), the same one its Session gets
export type SessionFactory = (sessionId: string, opts?: SessionFactoryOptions) => Pick<SessionOptions, 'regionLoader' | 'hooks'>;   // SessionOptions from docs/net.md; the shape a game module's `sessionFactory` export must have (games build it with `defineSessionFactory`, docs/game.md §3, which gives `opts.log` to every ServerContext)
export interface GatewaySocket { readonly bufferedAmount: number; send(data: ArrayBuffer): void; close(code?, reason?): void; terminate(): void; on('message' | 'close' | 'error', ...): unknown }   // the members of ws's WebSocket the host uses
export interface GatewayClient { ws: GatewaySocket; clientId: number; identity: SessionToken; helloFrame: ArrayBuffer; tokenExpired?: boolean }   // tokenExpired: section 17; default false
export interface SessionManagerOptions {
  store: BlobStore; games: Map<string, RegisteredGame>; logger: Logger;
  idleTimeoutMs?: number; workerEntry?: string | URL; execArgv?: string[]; workerExtra?: Record<string, unknown>; logLevel?: LogLevel;
  onCrash(sessionId: string, err: Error): void; onIdle(sessionId: string): void; onTickStats?(sessionId: string, stats: TickStats): void;
  now?: () => number; setTimeout?; clearTimeout?; setInterval?; clearInterval?;
}
export type WorkerState = 'starting' | 'running' | 'stopping';
export interface SessionHealth { sessionId: string; gameId: string; state: WorkerState; clients: number; startedAt: number; tick: TickStats | null }
export class SessionManager implements SessionHostControl {
  constructor(opts: SessionManagerOptions);
  start(sessionId: string, gameId: string): Promise<void>;
  stop(sessionId: string, close?: { code: number; reason: string }): Promise<void>;
  isRunning(sessionId: string): boolean;                                    // state === 'running'
  has(sessionId: string): boolean;                                          // any state
  touch(sessionId: string): void;                                           // a lobby join of a running session: re-arm the idle timer when no socket is attached
  attach(sessionId: string, client: GatewayClient): void;
  disconnect(sessionId: string, accountId: string, code: number, reason: string): void;
  flushAll(): Promise<void>;
  health(): SessionHealth[];
  shutdown(close?: { code: number; reason: string }): Promise<void>;
}
```

Per-session record: `{ worker, state, gameId, clients: Map<clientId, GatewayClient>, idleTimer, statsTimer, startedAt, lastTickStats, startPromise, stopPromise, pendingFlushes: Map<reqId, resolver>, bridge: StoreBridge }`.

**start(sessionId, gameId)**:

- `has(id)`: `starting` → return `startPromise`; `running` → resolve; `stopping` → `await stopPromise` then start.
- `game = games.get(gameId)` else reject `HostError('unknown_game')`. `game.module` unset → `HostError('no_game_module')`.
- `worker = new Worker(workerEntry ?? new URL('./worker.ts', import.meta.url), { workerData: { sessionId, gameId, gameModule: game.module, logLevel, extra: workerExtra }, execArgv: opts.execArgv ?? process.execArgv, stdout: false, stderr: false })`. Inheriting `execArgv` keeps `tsx`'s `--import` (dev) and `--experimental-sqlite` (only needed on Node 22.5 to 22.12, docs/persist.md 1.1) in the worker; a flag a worker rejects (`--max-old-space-size`: `ERR_WORKER_INVALID_EXEC_ARGV`, a failed spawn) needs `HostOptions.workerExecArgv`. A bundle inlines this file, so the default names `worker.ts` next to the bundle's output (a join answers 500 after `worker_start_failed: Cannot find module '<dist>/worker.ts'`): the bundle builds `@conduit/host/worker` (the package's `./worker` export, section 23) as an entry of its own and sets `HostOptions.workerEntry` to that output. The game module the worker imports is an entry of the same esbuild build with code splitting (docs/consuming.md 4), so the two share one instance of each core module; a worker bundled apart from the module keeps its own `@conduit/sim`, whose core components the game's registry does not hold (`component Region is not in this World's registry`).
- `state = 'starting'`; wire `message`, `error`, `exit` handlers; `bridge = new StoreBridge(store, worker, sessionId)` (section 20: the session's keys are scoped by its id).
- Resolve on `ready`; reject with `HostError('worker_start_timeout')` after `WORKER_READY_TIMEOUT_MS` (then `worker.terminate()`), or `HostError('worker_start_failed', cause)` on `error`/`exit`/`fatal` before `ready`. On success: `state = 'running'`, `startedAt = now`, start `statsTimer` (`STATS_INTERVAL_MS` → post `stats`), arm the idle timer (a session nobody connects to also idles out).

**attach(sessionId, client)**: record not `running` → close `ws` with `SESSION_NOT_RUNNING` (race with a stop). Else: `clients.set(clientId, client)`; clear the idle timer; post `attach` with `tokenExpired ?? false` (transfer `helloFrame`); wire `ws.on('message')` → binary: post `frame` (transferred copy); text: `ws.close(BAD_FRAME, 'binary only')`; `ws.on('close', (code, reason))` → post `closed`, `clients.delete`, arm the idle timer when `clients.size === 0`; `ws.on('error')` → `ws.terminate()` (the `close` event follows). The stats tick also closes any client with `ws.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES` using `SLOW_CLIENT`.

**Worker messages**: `send` → `clients.get(clientId)?.ws.send(buf)` (missing client: drop); `close` → `ws.close(code, reason)`; `flushed` → resolve `pendingFlushes.get(reqId)`; `tickStats` → `lastTickStats = stats`, `onTickStats?`; `store` → `bridge.handle(msg)`; `log` → `logger[level]('[session ' + id + '] ' + msg, data)`; `fatal` → logged at `error`, and the subsequent `exit` is handled as a crash.

**Idle timer**: armed with `idleTimeoutMs` whenever `clients.size` becomes 0 (and at `ready`); cleared on `attach`; re-armed by `touch(id)` (a `running` record with no clients; otherwise a no-op), which `LobbyService.joinSession` calls on every join of a running session (section 6), so a join just before the deadline cannot be followed by an idle stop that refuses the joiner's socket with `SESSION_NOT_RUNNING`. On fire: `await stop(id)` (shutdown includes a flush) then `onIdle(id)` (the host calls `service.markIdle`). A `start` that arrives while stopping waits for the stop and then spawns a fresh worker, which loads from the state just flushed.

**stop(sessionId, close = { code: SHUTTING_DOWN, reason: 'shutting_down' })**: not present → resolve. `stopping` → return `stopPromise`. `starting` → await `startPromise` (ignore rejection) then continue. `state = 'stopping'`; clear timers; post `shutdown { graceMs: SHUTDOWN_GRACE_MS, ...close }`; await `exit` with a `SHUTDOWN_GRACE_MS` timeout, then `worker.terminate()`; close any still-attached sockets with `close.code`; delete the record; resolve. A non-zero exit during a requested stop is logged but not treated as a crash.

**Crash handling**: `error` event, or `exit` (with any code: a worker never exits on its own) while `state === 'running'` (before `ready` the same events fail the start instead): log at `error`; close every attached socket with `WORKER_CRASHED` `'worker crashed'`; reject pending flushes; delete the record; `onCrash(id, err)` → the host calls `service.markIdle(id)`. The next join calls `start` again and the worker resumes from the last Autosaver/flush state (at most `AUTOSAVE_INTERVAL_MS` of play lost; docs/persist.md 1.8).

**disconnect(sessionId, accountId, code, reason)**: close every attached socket whose `identity.accountId` matches.

**flushAll()**: for each `running` record post `flush { reqId }` and await `flushed` with `FLUSH_TIMEOUT_MS`; failures are logged, never thrown.

**shutdown(close)**: `await flushAll()`, then `Promise.all(stop(id, close))` for every record.

`HostError` (`src/errors.ts`): `code: 'unknown_game' | 'no_game_module' | 'worker_start_timeout' | 'worker_start_failed' | 'not_running'`.

### 20. Store bridge and ProxyBlobStore

**StoreBridge** (`src/store-bridge.ts`, main thread): `constructor(store: BlobStore, port: { postMessage(msg, transfer?) }, scope?: string)`; `handle(msg: WorkerToMain & { t: 'store' })`. Per op: `get` → `value = await store.get(ns, key)`; reply `value ? toArrayBuffer(value) : null` (transferred). `put` → `store.put(ns, key, new Uint8Array(value))`. `delete`, `list` → direct. `batch` → `store.transaction(async tx => { for (op of ops) op.op === 'put' ? await tx.put(...) : await tx.delete(...) })`. Any `BlobStoreError` → `{ ok: false, error: { code, message } }`; any other error → `{ code: 'io', message }`. Requests from one worker are handled concurrently (each awaits the store independently); the store's own mutex serializes batches. With a `scope` every key is stored as `<scope>/<key>`: `get`/`put`/`delete` and batch ops prefix the key, `list` prefixes the prefix and strips it from the keys it answers. `SessionManager` passes the session id: every session shares the host's one store while the Session writes fixed keys (`session`/`state`, `region`/`<regionId>`, docs/net.md, docs/world.md), so without the scope two sessions of one game would overwrite each other's blobs. A game key therefore has `MAX_KEY_BYTES` minus the 27-byte prefix; a longer one is rejected `bad_key` by the main thread.

**ProxyBlobStore** (`src/proxy-blob-store.ts`, worker side):

```ts
export class ProxyBlobStore implements BlobStore {
  constructor(port: { postMessage(msg, transfer?) } /* parentPort */, opts?: { timeoutMs?: number });   // timeout default STORE_REQUEST_TIMEOUT_MS = 30_000; answers arrive through handleResult
  get; put; delete; list; transaction;
  handleResult(msg: MainToWorker & { t: 'storeResult' }): void;      // the worker's message router calls this
  readonly pending: number;
}
```

- Validation (docs/persist.md 1.2) runs locally before any message is sent, so rejections for bad names are immediate and identical to the other stores.
- `put` copies the value into a standalone `ArrayBuffer` and transfers it. `get` wraps the returned `ArrayBuffer` in a `Uint8Array`.
- Each request registers `{ resolve, reject, timer }` under `reqId`; `handleResult` settles it; a missing reply after `timeoutMs` rejects with `BlobStoreError('io', 'store request timed out')`.
- **Transactions are executed on the main thread as one batched op list; there are no interactive transactions across the port.** `transaction(fn)`: a root call always waits for the local `Mutex` (docs/persist.md 1.4: a root `transaction` never joins an open one, even when made from inside `fn`), then creates `overlay: Map<"ns\0key", Uint8Array | null>` (null = deleted) and a `BoundStore` whose operations are: `put`/`delete` → write the overlay only; `get` → overlay hit returns the overlay value (copy) or `null` for a tombstone, otherwise forward to main; `list` → forward to main, then add overlay keys with a value that match the prefix, remove tombstoned keys, sort with `compareKeys`. After `fn` resolves: if the overlay is non-empty, send one `batch` with the overlay entries in insertion order (last write per key wins because the map holds one entry per key) and await the result; then resolve with `fn`'s value. If `fn` throws: discard the overlay, nothing is sent, rethrow. Only `tx.transaction` nests: it reuses the overlay (the `BoundStore` owner's `nested`, no savepoints). Isolation: reads see committed state plus the transaction's own writes; concurrent writers are not excluded until the batch runs. This is enough for the Session's flush (one writer per session namespace).
- `ProxyBlobStore` passes `storeContract` from `@conduit/persist/testing` (section 23 test).

### 21. Worker entry (`src/worker.ts`)

Runs only inside a `Worker`. Steps:

1. `const data = workerData as WorkerData`; `const port = parentPort` (throws outside a Worker). Install `process.on('uncaughtException' | 'unhandledRejection', err => { post fatal; process.exit(1) })`. Create `store` and `logger` (step 3) and install the message router (step 7) before importing anything: loading the session already needs `storeResult` answers.
2. `const mod = await import(data.gameModule)`; `game = mod.game ?? mod.default?.game`, `sessionFactory = mod.sessionFactory ?? mod.default?.sessionFactory`. Missing either, or `game.id !== data.gameId` → `fatal` + `process.exit(1)`. The module path is used instead of structured-cloning the game definition because definitions hold functions (systems, hooks, loaders), which `postMessage` cannot clone.
3. `store = new ProxyBlobStore(port)`; `logger = portLogger(port, data.logLevel)` (log data is posted as plain values).
4. `log = (level, msg, d) => logger[level](msg, d)`; `const { regionLoader, hooks } = sessionFactory(data.sessionId, { log })`, so the game's hook logs (`ServerContext.log`, docs/game.md §2) reach the host's logger prefixed `[session <id>]` like the Session's own, rather than the worker's console; `session = new Session(game, { sessionId: data.sessionId, store, regionLoader, hooks, log, autosaver: save => new Autosaver(save, AUTOSAVE_INTERVAL_MS, { onError: err => logger.error('autosave failed', err) }) })` (docs/net.md A.5; no `verifier`, identities come from the gateway). The Session owns its `FixedLoop` (docs/sim.md 2.10); `await session.start()` loads persisted state (`onLoad`, session/region blobs), starts the loop, then the Autosaver. The worker never starts or stops the Autosaver itself: `session.stop()` calls its `stop()`, whose final save is the only save on shutdown.
5. `setInterval(() => post({ t: 'tickStats', stats: session.tickStats() }), TICK_STATS_INTERVAL_MS)`.
6. `post({ t: 'ready' })`.
7. Message router (`links: Map<clientId, PortLink>`): `attach` → before `ready` or while shutting down, post `close` with `4104`; if `clientId` already exists, log `warn` and ignore; else `link = new PortLink(clientId, port)`, `links.set`, `session.attach(link, identity, { tokenExpired })`, `link.deliver(new Uint8Array(helloFrame))`. `frame` → `links.get(clientId)?.deliver(new Uint8Array(buf))` (unknown: drop; a throw while handling it is logged and closes that client with 4003, not the session). `closed` → `link.handleClosed(code, reason)`, `links.delete`. `stats` → for each entry `links.get(id)?.reportBuffered(n)`. `flush` → `session.flushAll()` then `flushed { reqId, ok, error? }`. `storeResult` → `store.handleResult`. `shutdown` → for each link `link.close(code, reason)` (posts `close`), then `await session.stop()` (stops the loop; its `Kicked{ServerShutdown}` goes nowhere since the links are closed; then the Autosaver's final save), then `process.exit(0)` (1 when the save failed).

**PortLink** (source lives in `packages/net-server/src/port-link.ts` per CONCEPT.md's layout, since it implements docs/net.md's `ClientLink` and net-server cannot import host; this section is normative for its behaviour and the host tests exercise it):

```ts
export class PortLink implements ClientLink {
  constructor(id: number, port: PortLinkPort);   // PortLinkPort = { postMessage(msg: unknown, transfer?: readonly TransferListItem[]): void }
  readonly id: number;
  send(buf: Uint8Array): void;              // post { t:'send', clientId, buf } with buf transferred; bytesSinceReport += length; dropped if closed
  bufferedAmount(): number;                 // lastReported + bytesSinceReport
  close(code = 1000, reason = ''): void;    // post { t:'close', ... }; closed = true; further sends dropped
  onMessage(cb: (buf: Uint8Array) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
  deliver(buf: Uint8Array): void;           // worker router → onMessage callback
  handleClosed(code: number, reason: string): void;   // worker router → onClose callback once; closed = true
  reportBuffered(n: number): void;          // lastReported = n; bytesSinceReport = 0
  readonly closed: boolean;
}
```

`send` transfers `buf.buffer` when `buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength`, otherwise transfers a copy (`new Uint8Array(buf).buffer`; a `Buffer` view's `slice()` would not copy). A transfer leaves `buf` empty, so a sender must read `buf.byteLength` before `send` (the Session does: `ClientLink.send` takes ownership of `buf`, docs/net.md A.2). `FrameWriter.finish()` (docs/protocol.md) returns a copy, so Session sends normally transfer without copying. `bufferedAmount()` adds bytes sent since the last report to the last reported value so the Session's backpressure rule reacts within the 100 ms reporting gap rather than after it.

### 22. Host, HTTP server, static files, health, CLI

**Node → Hono adapter** (`src/node-adapter.ts`): `toRequest(req: IncomingMessage): Request` (URL from `Host` + `req.url`, headers copied, body `Readable.toWeb(req)` for methods other than GET/HEAD with `duplex: 'half'`), `writeResponse(res: Response, out: ServerResponse): Promise<void>` (status, headers including multiple `Set-Cookie` via `getSetCookie()`, streamed body). `handle(app, req, res, onError?)` calls `app.fetch(toRequest(req), { remoteAddress: req.socket.remoteAddress, encrypted: !!(req.socket as TLSSocket).encrypted })`; a request URL that does not parse is answered `400`, a throw `500` (the response is destroyed once headers went out) and reported to `onError`. No `@hono/node-server` dependency (CONCEPT.md limits runtime deps to `ws` and `hono`).

**Static files** (`src/static.ts`): `staticFiles(dir, opts?: { spa?: boolean /* default true */ })` returns a Hono handler: GET/HEAD only; decode and normalize the path, reject any segment `..` with 404; resolve under `dir` and verify the resolved path still starts with `dir`; directory → `index.html`; missing file and `spa` and `Accept` includes `text/html` → `dir/index.html`; else 404. `Content-Type` from `MIME_TYPES` (`html js mjs css json map png jpg jpeg gif svg webp ico glb gltf bin wasm woff woff2 txt xml`; unknown → `application/octet-stream`). `Cache-Control: public, max-age=31536000, immutable` for paths under `/assets/` (content-hashed by `conduit-assets`, docs/assets.md), else `no-cache`. `ETag` from size+mtime; `304` on `If-None-Match`.

**Health** (`src/health.ts`): `healthRoute(sessions, startedAt, now = Date.now)` returns a Hono app with `GET /healthz` → `200 { ok: true, startedAt, uptimeS, sessions: { running, starting, stopping }, list: SessionHealth[] }` and `Cache-Control: no-store`. No auth. Mounted before the lobby routes. Each entry's `tick` is that worker's latest `TickStats` (section 19; `null` until the first `tickStats` message, at most `TICK_STATS_INTERVAL_MS` old), so per-worker loop health reads from it: `tick.dropped` (ticks the FixedLoop dropped) and `tick.wakeLateness` (`{ wakes, p50Ms, p99Ms, maxMs, bucketMs, histogram }`, the cumulative wake-lateness histogram since the Session started; docs/net.md A.5). Spike 2b (PLAN.md M5) polls these.

**Host** (`src/host.ts`):

```ts
export interface HostOptions extends HostConfigOverrides {
  secret: string;                                   // required
  gameModules?: Record<string, string | URL>;       // gameId → module path/URL, used when registerGame omits module
  workerEntry?: string | URL; workerExecArgv?: string[]; workerExtra?: Record<string, unknown>;   // section 19: a bundle sets workerEntry to its @conduit/host/worker output
  secureCookies?: boolean; logger?: Logger;
  handleSignals?: boolean;                          // listen() installs SIGTERM/SIGINT handlers; default true
}
export class Host {
  constructor(opts: HostOptions);
  readonly config: HostConfig; readonly app: Hono<LobbyEnv>; readonly store: SqliteStore; readonly service: LobbyService;
  readonly presence: PresenceHub; readonly sessions: SessionManager; readonly gateway: Gateway; readonly games: Map<string, RegisteredGame>;
  registerGame(gameDef: RegisteredGameDef, opts?: { module?: string | URL }): void;
  listen(): Promise<{ port: number; url: string }>;          // port 0 allowed (tests)
  close(): Promise<void>;
}
```

- Constructor: `loadConfig(process.env, opts)`; `store = new SqliteStore(config.dbPath)`; `migrate(store.db, lobbyMigrations)`; `sessions = new SessionManager({ store, games, onCrash: id => service.markIdle(id), onIdle: id => service.markIdle(id), ... })`; `service = new LobbyService(store.db, { host: sessions, games: registry over games, secret })`; `presence = new PresenceHub(service)`; `service.attachSink(presence)`; `gateway = new Gateway(...)`; `app` = `new Hono()` mounting `/healthz`, `lobbyRoutes(service, { publicWsBase, secureCookies, trustProxy })`, then `staticFiles(staticDir)` when set.
- `registerGame`: `games.set(gameDef.id, { def, module })` where `module` is `opts?.module ?? gameModules[gameDef.id]` as an importable URL (a `URL` as its `href`; an absolute path, or one starting with `./` or `../` resolved against the working directory, as a `file:` URL; anything else as given) and stays `undefined` when neither names one. Duplicate id → throws. The main thread never sees a `sessionFactory`: the worker imports `game` and `sessionFactory` from `module` (section 21), so the registration only needs the def (for `GET /games`: `{ gameId: def.id, name: def.name, version: def.protocolVersion }`) and the module location. A missing `module` is an error at the first `start`, not at registration (tests register modules lazily).
- `listen`: `http.createServer((req, res) => handle(app, req, res))`, `server.on('upgrade', gateway.handleUpgrade)`, `server.keepAliveTimeout = 65_000`, `listen(config.port)`; resolves `{ port, url: 'http://127.0.0.1:<port>' }`; starts the `purgeExpired` interval; with `handleSignals`, installs `SIGTERM`/`SIGINT` handlers once: the first signal runs `close()` then `process.exit(0)` (1 when `close()` rejects) and arms a `SHUTDOWN_DEADLINE_MS` timer that forces `process.exit(1)`; a second signal exits immediately with 1.
- `close` (graceful shutdown, idempotent): `gateway.stopAccepting()`; `server.close()` (stop accepting HTTP; idle keep-alive connections close, in-flight requests finish); `presence.closeAll(4111, 'shutting_down')`; `await sessions.shutdown({ code: 4111, reason: 'shutting_down' })` (flush every worker, stop all); `gateway.closeAll(4111)` (sockets still before their Hello); clear the timers and signal handlers; `server.closeAllConnections()` and await the server's close; `store.close()`. Rejects with the first failure after running every step; the deadline belongs to the signal handler above.

**Logger** (`src/logger.ts`): `type LogLevel = 'debug' | 'info' | 'warn' | 'error'`; `interface Logger { debug; info; warn; error }` each `(msg: string, data?: unknown) => void`; `consoleLogger(level)` filters below `level` and prints `ISO time level msg JSON(data)` (debug and info to stdout, warn and error to stderr); `portLogger(port, level)` posts `log` messages.

**CLI** (`src/cli.ts`, `package.json` `"bin": { "conduit-host": "./src/cli.ts" }`, shebang `#!/usr/bin/env node`; run through `tsx` or Node >= 22.18 / 24 type stripping in dev, exactly as docs/consuming.md describes for `.ts` entry points; the root `dev:host` script (docs/consuming.md §1) delegates to the sandbox, whose own `dev:host` is `tsx ../../packages/host/src/cli.ts ./src/server/game.ts`):

```
conduit-host <game-module> [<game-module> ...] [--port N] [--db PATH] [--static DIR] [--ws-base URL] [--idle-ms N] [--log-level L]
```

Flags override env (`PORT`, `DB_PATH`, `STATIC_DIR`, `PUBLIC_WS_BASE`, `IDLE_TIMEOUT_MS`, `LOG_LEVEL`); `HOST_SECRET` is env only. For each module argument: resolve to an absolute path, `import(pathToFileURL(path).href)`, require `game` and `sessionFactory` exports (or a default export holding both), `host.registerGame(game, { module: pathToFileURL(path).href })`. Then `await host.listen()` and print `listening on http://0.0.0.0:<port>` to stdout (a module that fails closes the host before exiting). Exit codes: `2` for usage or `ConfigError` (message names the variable), `3` when `node:sqlite` is unavailable (it prints `openNodeSqlite`'s message, docs/persist.md 1.6.1: run Node 24+, or Node 22 with `--experimental-sqlite`, which only 22.5 to 22.12 need), `1` for other startup failures. This is functionally what `createHost` (docs/game.md) does in-process; the CLI uses `Host` directly so `@conduit/host` never imports `@conduit/game`.

### 23. Files: packages/host

Dependencies: `ws`, `hono`, `@conduit/lobby`, `@conduit/net-server`, `@conduit/persist`, `@conduit/auth`, `@conduit/protocol` (frame decoding in the gateway). Dev-only: `@conduit/game` and `@conduit/sim` for the test fixture game (the CI module-graph test inspects `dependencies` and `src/` imports, not `test/`), `tsx`.

`exports`: `.` → `src/index.ts`, and `./worker` → `src/worker.ts`, the session worker entry a production bundle builds as an entry of its own (section 19, docs/consuming.md 4).

`src/`

| File | Exports |
| --- | --- |
| `index.ts` | re-exports everything below except `worker.ts` and `cli.ts` |
| `constants.ts` | every constant in section 15, `GATEWAY_CLOSE`, `GatewayCloseCode` |
| `errors.ts` | `HostError`, `HostErrorCode` |
| `logger.ts` | `LogLevel`, `LOG_LEVELS`, `isLogLevel`, `logs`, `Logger`, `consoleLogger`, `portLogger`, `plainData` |
| `config.ts` | `HostConfig`, `HostConfigOverrides`, `ConfigError`, `loadConfig` |
| `node-adapter.ts` | `toRequest`, `writeResponse`, `handle`, `AdapterBindings`, `FetchHandler` |
| `static.ts` | `staticFiles`, `StaticFilesOptions`, `MIME_TYPES` |
| `health.ts` | `healthRoute(sessions, startedAt, now?)`, `HealthResponse` |
| `gateway.ts` | `Gateway`, `GatewayOptions`, `GATEWAY_CLOSE` (re-export), `readHello(buf): HelloPayload` |
| `port-protocol.ts` | `WorkerData`, `MainToWorker`, `WorkerToMain`, `StoreOp`, `BatchOp`, `StoreValue`, `StoreRequest`, `StoreResult`, `toArrayBuffer(u8): ArrayBuffer` |
| `store-bridge.ts` | `StoreBridge`, `StoreBridgePort` |
| `proxy-blob-store.ts` | `ProxyBlobStore`, `ProxyBlobStorePort`, `ProxyBlobStoreOptions`, `STORE_REQUEST_TIMEOUT_MS` |
| `session-manager.ts` | `SessionManager`, `SessionManagerOptions`, `RegisteredGame`, `RegisteredGameDef`, `SessionFactory`, `SessionFactoryOptions`, `GatewaySocket`, `GatewayClient`, `SessionHealth`, `WorkerState`, `closeSocket` |
| `host.ts` | `Host`, `HostOptions` |
| `worker.ts` | (entry; no exports; the package's `./worker` export) |
| `cli.ts` | (entry; no exports) |

`test/fixtures/`: `game.ts` exports `game` (a minimal `defineGame` with one `Transform`-bearing player entity that throttle input moves, a `Chat` message broadcast as `'<name>: <text>'`, `tickRate 60`) and `sessionFactory` (built with `defineSessionFactory`) whose hooks read `workerData.extra`: `crashAtTick` (at the first tick >= it with `crashWithPlayers` players in, in a session that started fresh: save, then throw outside the Session so the worker exits non-zero; the worker started afterwards loads the save and runs on), `slowLoad` (block `onInit`/`onLoad` for N ms), `ignoreShutdown` (`process.exit` does nothing in that worker), `onSave` returns `{ saves }`, a counter of saves carried in the session blob, and `onPlayerJoin` logs `fixture: <displayName> joined` through `ctx.log`. `bot.ts`: a `NetClient` in a worker thread driving throttle input (Spike 7). `no-game.ts`: a module without `game`. `helpers.ts`: `startHost(overrides)` → `Host` on port 0 with `dbPath ':memory:'`, `secret` of 48 bytes, `workerExecArgv` `['--import', 'tsx']` unless `process.features.typescript`, fixture registered with `module = fileURL of game.ts`, a recording logger and `handleSignals: false`; `lobbyLogin(host, username)` → cookie; `createSession`, `joinSession`; `joinAndConnect(host, cookie, sessionId)` → `ws` client that sent a valid `Hello`; `helloFrame(token, displayName, reconnectToken?)` built with `FrameWriter`; `decodeFrames`; `FakeSocket` (the `GatewaySocket` members); `ManualTimers` (injected virtual timers).

`test/`

| File | Proves |
| --- | --- |
| `config.test.ts` | defaults; every variable parsed; `HOST_SECRET` missing or 31 bytes → `ConfigError` naming `HOST_SECRET`; `STATIC_DIR` non-directory → `ConfigError`; overrides win |
| `node-adapter.test.ts` | GET/POST with JSON body reach a Hono app with correct URL, headers, `remoteAddress`; multiple `Set-Cookie` headers written separately; streamed response body |
| `static.test.ts` | serves `index.html` for `/`, correct MIME for `.glb`/`.wasm`, `immutable` cache for `/assets/x.abc123.js`, `../` → 404, SPA fallback only with `Accept: text/html`, `304` on matching `ETag`, POST → 404 |
| `healthz.test.ts` | shape with zero and one running session; `tick` populated after a `tickStats` message, with a `wakeLateness` histogram whose counts sum to its `wakes` |
| `gateway.test.ts` | with a running fixture session: text first frame → `Rejected` then close `4108`; a frame whose single message is `Ping` → `4108`; garbage token → `4101`; token signed with another secret → `4101`; token with `exp = now - 1` → `4102`; token for another session id → `4103`; valid token for a session that is not running → `4104`; valid token for a non-member → `4109`; no Hello within 5 s (injected timers) → `4107`; `/other` path → HTTP 404; `/lobby` without cookie → HTTP 401 (with one → presence); after `stopAccepting()` → HTTP 503; the `Rejected` payload's `reason` matches the table in section 17. Expired tokens: an expired token of another session with a reconnect token → `4103`; an expired token with a reconnect token passes the gateway marked `tokenExpired: true` (a valid one `false`); through the worker, with an unknown reconnect token it is `Rejected{BadToken}` + `4008`, and with the reconnect token of the account's player that dropped it resumes that player (same `playerId` and token) |
| `session-manager.test.ts` | `start` resolves after `ready` and `isRunning` is true; a fixture with `slowLoad = 20_000` → `worker_start_timeout` and the worker is terminated; concurrent `start` calls share one worker; `stop` posts `shutdown` and resolves on exit; a worker that ignores `shutdown` (fixture flag `ignoreShutdown`) is terminated after `SHUTDOWN_GRACE_MS` (fake timers); `start` during `stopping` waits then spawns a new worker that loads the save; `stop` saves exactly once (the Autosaver's final save); a module that fails to load → `worker_start_failed`; `flushAll` resolves on `flushed`, and two sessions keep their blobs apart (`<sessionId>/state`); `health()` counts and carries `tickStats`; with a `FakeSocket`: Hello → `Welcome`, frames both ways, the fixture's `onPlayerJoin` `ctx.log` line reaches the host logger as `[session <id>] fixture: <name> joined`, a text frame closes `4108`, `closed` relayed, the idle timer; `SESSION_NOT_RUNNING`, `SLOW_CLIENT` and `disconnect` closes |
| `two-clients.test.ts` | full host on port 0: two accounts register through `LobbyClient`, A creates a session, B joins with the invite code, both connect `NetClient`s with their tokens; both receive `Welcome` and play; A's `Chat` message is echoed to B (so both sockets reached the same worker); `health()` shows one worker with 2 clients; A's input moves A's entity in B's replica; A leaving destroys it on B while B keeps playing and the worker runs. Spike 7 (PLAN.md): two `NetClient`s in worker threads (`fixtures/bot.ts`) at 20 snapshots/s each; prints the main thread's relay time per relayed frame (the relay handlers, `ws.send` included) and its event-loop activity as a share of the 16.7 ms tick budget; `CONDUIT_SLOW=1` measures 30 s and asserts < 0.1 ms and < 5 % |
| `crash-isolation.test.ts` | fixture `crashAtTick = 30`, `crashWithPlayers = 2`; two clients connected; the worker exits non-zero; both sockets close with `4110`; `GET /healthz` and `GET /me` still respond 200; the session row reads `idle`; `POST /sessions/:id/join` starts a new worker and the new worker's first `saves` counter continues from the persisted value (state survived) |
| `idle-stop.test.ts` | a `SessionManager` with injected timers and a `LobbyService` over `SqliteStore(':memory:')`: one client connects then disconnects; after `IDLE_TIMEOUT_MS - 1` the worker is still running; at `IDLE_TIMEOUT_MS` the worker receives `shutdown`, `session.flushAll` ran (the `saves` counter in the store incremented, and the `session` namespace holds the session blob), the worker exited, `onIdle` fired and the lobby row reads `idle`; a client attaching at `IDLE_TIMEOUT_MS - 1` cancels the timer; a lobby join of the running session at `IDLE_TIMEOUT_MS - 1` (no start) restarts the timer, so the worker still runs at the old deadline and the joiner's socket gets `Welcome`, a `touch` with a socket attached arms nothing, and the restarted timer still idles the session out `IDLE_TIMEOUT_MS` after the join; a session started but never attached idles out too |
| `port-link.test.ts` | with a `MessageChannel`: `send` posts `send` with the buffer transferred (source `byteLength` becomes 0) and copies when the view is offset; `bufferedAmount()` is 0 initially, equals bytes sent before any report, equals the reported value right after `reportBuffered`, and `reported + sent-since` afterwards; `close` posts `close` and later `send` is dropped; `handleClosed` fires `onClose` exactly once; `deliver` reaches `onMessage` |
| `proxy-blob-store.test.ts` | runs `storeContract('ProxyBlobStore', ...)` with a `MessageChannel` between a `ProxyBlobStore` and a `StoreBridge` over a `MemoryStore`; a transaction with 3 puts and 1 delete sends exactly one `batch` message with 4 ops in order, and a put then delete of the same key sends one delete op; a throwing transaction sends no message; `get` inside a transaction returns the overlay value and `list` merges overlay keys in `compareKeys` order; a bridge that never replies makes the request reject `io` after `timeoutMs`; a `BlobStoreError` on the main side arrives with the same `code` |
| `store-bridge.test.ts` | each op maps to the store; `batch` runs inside `store.transaction` (a failing op rolls back the earlier ones); `get` result is transferred (bridge-side buffer detached), a view copied; error codes; a `scope` stores `<scope>/<key>` and lists without it; requests run concurrently |
| `host.test.ts` | `registerGame` duplicate throws, paths become file URLs and `gameModules` fills in; `start` for a game registered without a module rejects `no_game_module` (a join answers 500); `@conduit/host/worker` resolves to `src/worker.ts`; with `workerEntry` set to an `.mjs` entry in a temp directory (it posts a `log` line, then imports `src/worker.ts`), a lobby join starts the worker from it (the line reaches the logger as `[session <id>] ...`) and a game socket gets `Welcome`, while a `workerEntry` that does not exist rejects `start` with `worker_start_failed` naming the path; `STATIC_DIR` is served after the lobby routes; `GET /games` lists `{ gameId, name, version }` from registrations; `listen` on port 0 returns the bound port and `url`; `close()` closes presence sockets with `4111`, stops workers after flushing, closes the store (subsequent `store.get` rejects `closed`), and the port is released |
| `cli.test.ts` | spawns `cli.ts` (Node's type stripping, or `tsx` without it) with the fixture module on port 0 with a temp `DB_PATH`: prints `listening on`, `/healthz` and `/games` answer, a session joined through the lobby runs, `SIGTERM` exits 0 within 15 s; missing `HOST_SECRET` exits 2 with the variable named; no module, an unknown flag or a bad `--port` exits 2; a module without `game` exits 1; `--no-experimental-sqlite` exits 3 |

### 24. Standalone lobby mode (not implemented)

Design only. No code, configuration, CLI flag or test exists for it, and sections 15-23 describe the only supported deployment (CONCEPT.md Decisions, Hosting: one host process runs the lobby, the gateway and the session workers). This section records how the lobby moves into a process of its own that serves several game host processes (CONCEPT.md M6), so that work done before then does not have to be undone.

#### 24.1 When to build it

Only after a second host process exists (CONCEPT.md M6, PLAN.md M6): a real deployment runs, or has to run, game sessions in more than one host process, because one host no longer carries them or because hosts must run on more than one machine. Until then the one-process `Host` covers every flow and nothing here is implemented. The mode does not need Postgres, because the lobby stays the only process that opens the SQLite file (24.5); Postgres keeps its own trigger, a second machine (PLAN.md M6).

#### 24.2 Roles

`HOST_ROLE` selects what a process runs; the default `all` is sections 15-22, unchanged.

| | `all` (today) | `lobby` | `game` |
| --- | --- | --- | --- |
| HTTP | `/healthz`, lobby routes, static files | `/healthz` (24.8), lobby routes, static files | `/healthz` (24.8) |
| Upgrades | `/lobby`, `/session/:id` | `/lobby`, `/hosts` (24.3); `/session/:id` → `404` | `/session/:id`; `/lobby` → `404` |
| Database | `SqliteStore`: lobby tables and game blobs | the same, and the only process that opens it | none |
| Sessions | `SessionManager` | none; `HostDirectory` implements `SessionHostControl` (24.4) | `SessionManager`, commanded by the lobby |
| `LobbyService`, `PresenceHub` | yes | yes | no |

A lobby process has no `SessionManager`, no workers and no game sockets. A game host has no lobby tables, cookies or presence; it keeps one outbound WebSocket, the **host link**, open to `LOBBY_URL` + `/hosts`. Files when built (`packages/host/src`): `host-link-protocol.ts` (the types and constants of 24.3), `host-directory.ts` (lobby side), `host-link.ts` (game side: connect, register, heartbeat, lease, commands, store proxy), `member-cache.ts`.

#### 24.3 Host registration

Control messages are JSON text messages. Store requests and results (24.5) are binary messages: `u32 headerLength | JSON header | value bytes`, where the header is the section 18 `store`/`storeResult` message with each `ArrayBuffer` replaced by its byte length and the values follow in op order.

```ts
export const HOST_LINK_VERSION = 1;
export const HOST_HELLO_TIMEOUT_MS = 5_000;
export const HOST_HEARTBEAT_INTERVAL_MS = 5_000;
export const HOST_LEASE_MS = 20_000;           // lobby: a host silent this long is lost (24.7)
export const HOST_LEASE_MARGIN_MS = 2_000;     // host: gives its sessions up HOST_LEASE_MS − margin after its last acknowledged heartbeat
export const HOST_COMMAND_TIMEOUT_MS = 15_000; // > WORKER_READY_TIMEOUT_MS
export const HOST_RECONNECT_MAX_MS = 5_000;    // host link backoff: 1 s doubling up to this, well under the lease

export type LobbyToHost =
  | { t: 'challenge'; nonce: string; version: number }        // first message; nonce = base64url(randomBytes(32)), fresh per connection
  | { t: 'registered' }
  | { t: 'heartbeatAck'; seq: number }
  | { t: 'start'; reqId: number; sessionId: string; gameId: string; members: string[] }   // members: account ids from session_members
  | { t: 'stop'; reqId: number; sessionId: string; code: number; reason: string; discard: boolean }
  | { t: 'admit'; reqId: number; sessionId: string; accountId: string }
  | { t: 'touch'; sessionId: string }
  | { t: 'disconnect'; sessionId: string; accountId: string; code: number; reason: string };

export type HostToLobby =
  | { t: 'register'; hostId: string; proof: string; version: number; name: string; wsBase: string;
      games: GameInfo[]; maxSessions: number; running: { sessionId: string; gameId: string }[] }
  | { t: 'heartbeat'; seq: number; draining: boolean; sessions: { sessionId: string; state: WorkerState; clients: number }[] }
  | { t: 'result'; reqId: number; ok: true }
  | { t: 'result'; reqId: number; ok: false; error: { code: string; message: string } }
  | { t: 'idle'; sessionId: string }
  | { t: 'crashed'; sessionId: string; message: string };
```

- **Shared-secret authentication.** The lobby and every game host are configured with the same `HOST_SECRET`, which never crosses the link. On upgrade the lobby sends `challenge`; the host answers `register` with `proof = base64url(HMAC-SHA256(HOST_SECRET, 'conduit-host-register\n' + nonce + '\n' + hostId))`, and the lobby recomputes it and compares with `timingSafeEqual`. A wrong proof closes the link `4120`, a `version` other than `HOST_LINK_VERSION` `4121`, and a first message that is not `register`, or none within `HOST_HELLO_TIMEOUT_MS`, `4122` (link close codes; game sockets never see them). The per-connection nonce makes a captured proof useless on another connection. Outside localhost `LOBBY_URL` is `wss://`, since the link carries game state. The same secret lets hosts verify the lobby's session tokens (24.6).
- **Identity.** `hostId` is a ulid drawn when the host process starts, so a restarted host is a new host; a host that reconnects after a dropped link sends the same `hostId` and is treated as the same host (24.7). `name` (`HOST_NAME`) is for logs and `/healthz` only.
- **Game list.** `games` holds `{ gameId, name, version }` (`version = protocolVersion`, section 4) for every `registerGame` of the host. The lobby's `GET /games` lists the union over live hosts, one entry per `gameId` at its highest `version`; during a rolling upgrade both versions run, and running sessions stay where they are.
- **Capacity.** `maxSessions` (`HOST_MAX_SESSIONS`) bounds the sessions a host holds in any `WorkerState`. The lobby counts a host's load as the sessions in its last heartbeat plus the `start`s it sent that are still unanswered.
- **Heartbeat.** Every `HOST_HEARTBEAT_INTERVAL_MS` the host sends `heartbeat` listing every session its `SessionManager` holds; the lobby answers `heartbeatAck`. The link is ordered, so the lobby reconciles each heartbeat against placement: a session placed on the host whose `start` the host has answered, but missing from the list, was lost there (placement removed, `markIdle`); a session in the list that is not placed on the host gets `stop { discard: true }`. `draining: true` (the host is shutting down) takes the host out of placement.
- **`register.running`** lists the sessions the host still runs, so placement is rebuilt from the hosts after a lobby restart or a dropped link (24.4) and never needs a table.

#### 24.4 Placement

`HostDirectory` (lobby process) implements `SessionHostControl` (section 6), so `LobbyService` and the routes are unchanged apart from `admit` (24.6) and the `unavailable` error below. It holds `hosts: Map<hostId, HostRecord>` and `placement: Map<sessionId, hostId>` in memory only.

- **`start(sessionId, gameId)`**: a session placed on a live host is started there again (`SessionManager.start` is idempotent). Otherwise choose a host that is live and not draining, lists `gameId` at the highest registered `version`, and has load below `maxSessions`: lowest `load / maxSessions` first, ties to the earliest registration. No such host → reject with `LobbyError('unavailable')`, a new `LobbyErrorCode` (`503`, `Retry-After: 5`) that `joinSession` passes through instead of mapping the rejection to `internal`. Otherwise record the placement, send `start` with the session's current members, and resolve on `result ok`; an error result, the link closing or `HOST_COMMAND_TIMEOUT_MS` removes the placement and rejects (`internal`, like a failed start today).
- **`isRunning(id)`**: placed on a live host that reported the session `running` in a `start` result or a later heartbeat.
- **`touch`**, **`disconnect`**: forwarded to the owning host; nothing when the session is not placed.
- **`stop(id, close)`**: forwarded as `stop { discard: false }` (the host's `SessionManager.stop` flushes first); resolves on its result and removes the placement. Not placed → resolves at once.
- **Host events**: `idle` and `crashed` remove the placement and call `service.markIdle(id)`, which is what `onIdle` and `onCrash` do in section 19.
- **Lobby restart.** Placement is rebuilt from `register.running` as hosts reconnect. For `HOST_LEASE_MS` after the lobby starts, `start` of a session that is not placed rejects `unavailable`, because a host that has not reconnected yet may still run it; by the end of that window every live host has reconnected (its backoff is capped at `HOST_RECONNECT_MAX_MS`) or has given its sessions up (24.7). Sessions whose rows still read `running` with no host reporting them are then marked `idle`. If two hosts report the same session, the first registration keeps it and the other gets `stop { discard: true }`.

#### 24.5 Game state stays with the lobby

Game hosts open no database. A game host's `SessionManager` gets `store = new ProxyBlobStore(link)`; the lobby serves those requests with a `StoreBridge` over its `SqliteStore`. The section 20 hop from a worker to its main thread is followed by a second hop, from the host to the lobby, with the same messages and the same batch-only transactions (a worker's `batch` becomes one `batch` on the link). Keys are those a one-process host writes (`<sessionId>/<key>`, section 20), so a database moves between the `all` and `lobby` deployments unchanged, and a session can run on any host because every host reads the same blobs.

- **Fencing.** The lobby serves a host's store request only for keys of sessions placed on that host; any other request fails `BlobStoreError('io', 'session not placed on this host')`. A host that lost a session can never overwrite state another host now owns.
- **Cost.** Region loads and autosaves cross the network. They are asynchronous and batched already. While the link is down, requests wait for it to return and fail `io` at their own timeout (`STORE_REQUEST_TIMEOUT_MS`) or when the lease expires.
- **Rejected alternative.** A SQLite file per game host with sessions pinned to the host that holds their state: a host that never comes back would strand its sessions, and moving one would need a blob export. When a second machine needs a store that is not the lobby's file, `PgStore` behind `BlobStore` (PLAN.md M6, deferred) takes this role with the same keys.

#### 24.6 Joining: `wsUrl` and token verification

- **`wsUrl` points at the owning host.** `POST /sessions/:id/join` answers `wsUrl = <owning host's wsBase>/session/<id>`, where `wsBase` is the host's registered `PUBLIC_WS_BASE` (required in the `game` role: the lobby cannot derive another process's public address from a request, so `deriveWsBase` is not used for it). The game socket goes straight to that host and the lobby never relays frames. A client served from the lobby's origin connects cross-origin, which WebSocket allows, and needs no cookie because the token travels in `Hello`. `JoinResponse`, `LobbyClient.join` and `createClient`'s join flow do not change (docs/game.md: a later `connect()` joins again and `setTarget`s the new `wsUrl`).
- **Minting** does not change: the lobby mints the `SessionToken` with `HOST_SECRET` (section 6).
- **Admission.** `SessionHostControl` gains `admit?(sessionId: string, accountId: string): Promise<void>`. `joinSession` awaits it after inserting the member row (or finding it) and before minting, so the owning host knows the account before the joiner's `Hello` can arrive; a rejection deletes a member row this join inserted and answers `internal`. `HostDirectory.admit` sends `admit` and resolves on the result. `SessionManager` does not implement it: the one-process gateway reads membership from the database.
- **Verification on the host.** A game host's `Gateway` runs the section 17 Hello check with one change. Steps 1-4 are unchanged: `verifyToken(hello.sessionToken, HOST_SECRET, now, { allowExpired: true })` with the shared secret, the expired-token rule and the session id check. Step 5 reads the host's `MemberCache` (`Map<sessionId, Set<accountId>>`) instead of `service.isMember`: a session the host does not hold → `reject(SESSION_NOT_RUNNING, RejectReason.SessionNotRunning, ...)`, an account that is not admitted → `reject(NOT_MEMBER, ...)`. Steps 6-7 are unchanged. The cache is filled by `start.members`, gains an account on `admit`, loses it on `disconnect` (`leaveSession`), and drops a session when its worker stops, crashes or is discarded. Token expiry is checked on the host's clock against an `exp` from the lobby's clock, so their clocks must agree to within a few seconds (NTP).

#### 24.7 When a host disappears

- **Lease.** The lobby counts `HOST_LEASE_MS` from the last heartbeat it received from a host; the host counts `HOST_LEASE_MS − HOST_LEASE_MARGIN_MS` from sending the last heartbeat the lobby acknowledged. A heartbeat is received after it is sent, so a partitioned host always gives up before the lobby moves its sessions, measuring durations only (no clock agreement needed).
- **Link closed, host alive.** The lobby marks the host `disconnected`: no new placements, and commands to it fail. A `register` with the same `hostId` before the lobby's lease expires restores the host with its placements, reconciled against `register.running` (24.3), and players notice nothing. Meanwhile the host keeps its sessions running, its store requests wait (24.5), and it reconnects with backoff.
- **Lost.** When the lobby's lease expires (the host crashed, was killed or stayed partitioned), the host record is deleted; for each session placed on it the placement is removed and `service.markIdle(id)` emits `session` with state `idle` to its members. A join of such a session before this point answers `unavailable`. The session's state is whatever reached the lobby's store (the last autosave or flush, the same bound as a worker crash, docs/persist.md 1.8), and the next `joinSession` starts it on another host, which loads that state, and returns that host's `wsUrl`.
- **Host side at lease expiry.** The host discards every session: it closes their game sockets with `SHUTTING_DOWN` (4111), terminates the workers without the final save (the store is unreachable, and fencing would refuse it), clears the `MemberCache`, and keeps trying to reconnect as a host with no sessions. `stop { discard: true }` does the same for one session; `SessionManager` needs a `discard(sessionId, close)` for it.
- **Players.** Clients on a dead host see their sockets drop (`1006`) and those on a host that gave up see `4111`; both reconnect to the same `wsUrl`, fail or get `SESSION_NOT_RUNNING` (4104, final), and the game's next `connect()` joins through the lobby again (docs/game.md), which places the session elsewhere once the lease has expired. Play since the last save is lost, as after a worker crash.
- **Lobby down.** Hosts keep their sessions for the lease without being able to save; joins, lobby routes and presence are down. A lobby restart that completes well within the lease keeps every session, because hosts re-register with `register.running` (24.4); a longer outage makes every host give its sessions up, and the next joins start them again from their saved state.

#### 24.8 Configuration, CLI and health

| Variable | Role | Default | Rule |
| --- | --- | --- | --- |
| `HOST_ROLE` | any | `all` | `all`, `lobby` or `game` |
| `HOST_SECRET` | any | required | `assertSecret`; the same value on the lobby and every game host |
| `LOBBY_URL` | `game` | required | `ws://` or `wss://` base of the lobby, no trailing slash |
| `PUBLIC_WS_BASE` | `game` | required | section 16 rule; unused in the `lobby` role |
| `HOST_MAX_SESSIONS` | `game` | `max(1, os.availableParallelism() − 1)` | integer ≥ 1 |
| `HOST_NAME` | `game` | `os.hostname()` | 1..64 characters |

`DB_PATH`, `STATIC_DIR` and `TRUST_PROXY` apply to the `lobby` role as in section 16 and are ignored by the `game` role. CLI: `conduit-host --role lobby [--port N] [--db PATH] [--static DIR]` takes no game modules (the game list comes from hosts), and `conduit-host <game-module> [...] --role game --lobby URL --ws-base URL [--max-sessions N]`; `--role all`, the default, is section 22.

`GET /healthz` in the `lobby` role answers `{ ok, startedAt, uptimeS, hosts: [{ hostId, name, state: 'live' | 'disconnected' | 'draining', games, maxSessions, sessions, lastHeartbeatAt }] }`; in the `game` role, section 22's response plus `lobby: 'connected' | 'disconnected'`. Graceful shutdown of a game host: a heartbeat with `draining: true`, then `sessions.shutdown` (flushing through the link, each stop reported as `idle`), then close the link. Of a lobby: `presence.closeAll(4111)` and close every host link with `1001`; hosts keep their sessions for the lease and re-register with the restarted lobby.

#### 24.9 What stays the same, and tests when it is built

Unchanged: `Session`, the port protocol (section 18), `PortLink`, `ProxyBlobStore` and `StoreBridge` (reused on the link), the Hello check apart from membership, `LobbyService` apart from `admit` and `unavailable`, the lobby API and `@conduit/lobby-client`, the lobby schema (section 1), and the store keys.

Tests to write with it: a `register` with a proof over another secret, or a proof replayed on a new connection, closes `4120`; placement honours game, version and capacity and answers `unavailable` when nothing fits; `join` returns the owning host's `wsUrl`, and that host accepts the lobby's token for an admitted member and refuses a non-member (`4109`) and a session it does not hold (`4104`); a host that stops heartbeating is lost after `HOST_LEASE_MS`, its sessions read `idle`, the next join starts the session on another host from its last saved state, and the old host's late store writes are refused; a host whose link drops and returns within the lease keeps its sessions and their sockets; a host that stays cut off discards its sessions before the lobby re-places them; a lobby restart places nothing for `HOST_LEASE_MS` and rebuilds placement from `register.running`.

A worker reporting an authoritative session failure enters `faulted` health state immediately and
stops admission while prior valid writes finish. Its clients receive terminal 4012; other workers
continue running. The faulted worker exits unsuccessfully after safe shutdown without a final capture.


Worker health includes status live/stale/faulted/starting/stopping and statsAgeMs. A running
worker with no telemetry newer than staleAfterMs (default 5000 ms) is reported stale; this does not
restart it or change admission policy. Faulted lifecycle remains explicit. No raw fault message
is added to unauthenticated health output. Monitoring onTickStats callback failures are caught
and reported with a bounded static warning so a broken observer cannot stop the host.

Configured lobby capacity flows through `SessionManager.start(sessionId, gameId, maxPlayers)`
and worker data into the session factory options and the worker-owned Session. The worker
rejects an explicit conflicting factory capacity before becoming ready and checks the
constructed `Session.capacity`. Defaults and public supported limits remain eight; smaller
configured sessions enforce their own limit. The wire ceiling of sixteen does not expand
the lobby SQL constraint or public supported capacity.
