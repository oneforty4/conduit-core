// The lobby's wire types (docs/host.md section 4). This file has no runtime imports:
// @conduit/lobby-client imports it with `import type`.

export type Visibility = 'private' | 'friends' | 'public';
export type SessionState = 'created' | 'running' | 'idle' | 'archived';
/** `pending_in`: they asked me; `pending_out`: I asked them. */
export type FriendStatus = 'accepted' | 'pending_in' | 'pending_out';

export interface PublicAccount {
  id: string;
  username: string;
  displayName: string;
}
export interface Account extends PublicAccount {
  createdAt: number;
  lastLoginAt: number | null;
}
export interface MemberSummary extends PublicAccount {
  joinedAt: number;
}
export interface SessionSummary {
  id: string;
  gameId: string;
  name: string;
  ownerId: string;
  visibility: Visibility;
  maxPlayers: number;
  state: SessionState;
  memberCount: number;
  members: MemberSummary[];
  createdAt: number;
  lastActiveAt: number;
  /** Present only for the owner and members. */
  inviteCode?: string;
}
/** `version` is the game definition's `protocolVersion`. */
export interface GameInfo {
  gameId: string;
  name: string;
  version: number;
}
export interface FriendEntry {
  account: PublicAccount;
  status: FriendStatus;
  since: number;
}

export interface RegisterRequest {
  username: string;
  password: string;
  displayName?: string;
}
export interface RegisterResponse {
  account: Account;
}
export interface LoginRequest {
  username: string;
  password: string;
}
export interface LoginResponse {
  account: Account;
}
export interface MeResponse {
  account: Account;
  friends: FriendEntry[];
  invites: SessionSummary[];
}
export type GamesResponse = GameInfo[];
export type ListSessionsResponse = SessionSummary[];
export interface CreateSessionRequest {
  gameId: string;
  name: string;
  visibility: Visibility;
  maxPlayers: number;
}
export interface CreateSessionResponse {
  session: SessionSummary;
  inviteCode: string;
}
export interface JoinRequest {
  inviteCode?: string;
}
export interface JoinResponse {
  token: string;
  wsUrl: string;
}
export interface FriendResponse {
  friend: FriendEntry;
}

export type LobbyErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'session_full'
  | 'bad_invite'
  | 'rate_limited'
  | 'internal';
export interface ErrorResponse {
  error: LobbyErrorCode;
  message: string;
  field?: string;
}
/** HTTP status per error code. `internal` is the catch-all for unexpected exceptions. */
export const ERROR_STATUS: Record<LobbyErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation: 400,
  session_full: 409,
  bad_invite: 403,
  rate_limited: 429,
  internal: 500,
};

/** Server → client messages on the `/lobby` presence socket (docs/host.md section 7). */
export type LobbyEvent =
  | { t: 'friends'; online: string[] }
  | { t: 'session'; session: SessionSummary }
  | { t: 'invite'; session: SessionSummary; from: PublicAccount }
  | { t: 'pong' };
/** Client → server messages on the `/lobby` presence socket. */
export type PresenceClientMessage = { t: 'hello' } | { t: 'ping' };
