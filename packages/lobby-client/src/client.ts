import type {
  Account,
  CreateSessionRequest,
  CreateSessionResponse,
  FriendEntry,
  FriendResponse,
  GameInfo,
  GamesResponse,
  JoinRequest,
  JoinResponse,
  ListSessionsResponse,
  LobbyEvent,
  LoginRequest,
  LoginResponse,
  MeResponse,
  RegisterRequest,
  RegisterResponse,
  SessionSummary,
} from '@conduit/lobby';
import { type HttpMethod, request, type RequestOptions, wsUrlFor } from './http.ts';
import { PresenceConnection, type PresenceConnectionOptions } from './presence.ts';

export interface LobbyClientOptions {
  /** `'https://play.example.com'`, or `''` for same-origin. */
  baseUrl: string;
  /** Default `globalThis.fetch`, looked up per request. */
  fetch?: typeof fetch;
  /** Default `globalThis.WebSocket`, looked up by `connectPresence()`. */
  WebSocket?: typeof WebSocket;
  /**
   * `'browser'`: the browser keeps the login cookie. `'manual'` (Node): the client keeps it, see
   * `cookie`. Default `'manual'` when `typeof document === 'undefined'`, else `'browser'`.
   */
  cookieMode?: 'browser' | 'manual';
}

/** The lobby's login cookie (docs/host.md §3). */
const COOKIE_NAME = 'conduit_sid';
const LOGIN_PATH = '/auth/login';

/**
 * Typed client for the lobby HTTP API (docs/host.md §10, §12) and its presence socket (§13).
 * Failed calls reject with `LobbyError`.
 */
export class LobbyClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly WebSocketImpl: typeof WebSocket | undefined;
  private readonly manual: boolean;
  private sid: string | null = null;
  private presence: PresenceConnection | null = null;

  constructor(opts: LobbyClientOptions) {
    if (typeof opts.baseUrl !== 'string') {
      throw new TypeError('LobbyClient: baseUrl must be a string');
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.fetchFn = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.WebSocketImpl = opts.WebSocket;
    const mode = opts.cookieMode ?? (typeof document === 'undefined' ? 'manual' : 'browser');
    this.manual = mode === 'manual';
  }

  /**
   * Manual cookie mode: the `conduit_sid` value from the last login, sent as `Cookie` on every
   * request and presence connection; `null` before login, after `logout()` or a `401`, and always
   * in browser mode.
   */
  get cookie(): string | null {
    return this.sid;
  }

  /** `POST /auth/register`. Does not log in. */
  async register(username: string, password: string, displayName?: string): Promise<Account> {
    const body: RegisterRequest =
      displayName === undefined ? { username, password } : { username, password, displayName };
    return (await this.call<RegisterResponse>('POST', '/auth/register', body)).account;
  }

  /** `POST /auth/login`; the response sets the login cookie. */
  async login(username: string, password: string): Promise<Account> {
    const body: LoginRequest = { username, password };
    return (await this.call<LoginResponse>('POST', LOGIN_PATH, body)).account;
  }

  /**
   * `POST /auth/logout`. Closes the presence connection first; the manual cookie is cleared even
   * when the request fails.
   */
  async logout(): Promise<void> {
    this.closePresence();
    try {
      await this.call<undefined>('POST', '/auth/logout');
    } finally {
      this.sid = null;
    }
  }

  me(): Promise<MeResponse> {
    return this.call<MeResponse>('GET', '/me');
  }

  games(): Promise<GameInfo[]> {
    return this.call<GamesResponse>('GET', '/games');
  }

  listSessions(gameId?: string): Promise<SessionSummary[]> {
    const query = gameId === undefined ? '' : `?gameId=${encodeURIComponent(gameId)}`;
    return this.call<ListSessionsResponse>('GET', `/sessions${query}`);
  }

  getSession(id: string): Promise<SessionSummary> {
    return this.call<SessionSummary>('GET', `/sessions/${encodeURIComponent(id)}`);
  }

  createSession(input: CreateSessionRequest): Promise<CreateSessionResponse> {
    return this.call<CreateSessionResponse>('POST', '/sessions', input);
  }

  /** `POST /sessions/:id/join`: the `SessionToken` for the game socket's `Hello` and its URL. */
  join(id: string, inviteCode?: string): Promise<JoinResponse> {
    const body: JoinRequest = inviteCode === undefined ? {} : { inviteCode };
    return this.call<JoinResponse>('POST', `/sessions/${encodeURIComponent(id)}/join`, body);
  }

  async leave(id: string): Promise<void> {
    await this.call<undefined>('POST', `/sessions/${encodeURIComponent(id)}/leave`);
  }

  async deleteSession(id: string): Promise<void> {
    await this.call<undefined>('DELETE', `/sessions/${encodeURIComponent(id)}`);
  }

  /** `POST /friends/:username`: `pending_out`, or `accepted` when they had asked first. */
  async requestFriend(username: string): Promise<FriendEntry> {
    const path = `/friends/${encodeURIComponent(username)}`;
    return (await this.call<FriendResponse>('POST', path)).friend;
  }

  async acceptFriend(accountId: string): Promise<FriendEntry> {
    const path = `/friends/${encodeURIComponent(accountId)}/accept`;
    return (await this.call<FriendResponse>('POST', path)).friend;
  }

  /** `DELETE /friends/:id`: declines, cancels or ends a friendship. */
  async removeFriend(accountId: string): Promise<void> {
    await this.call<undefined>('DELETE', `/friends/${encodeURIComponent(accountId)}`);
  }

  /**
   * The shared presence connection: created on the first call (and again once the previous one is
   * closed), otherwise the same object. Throws a `TypeError` when there is no `WebSocket`.
   */
  connectPresence(): PresenceConnection {
    if (this.presence !== null && this.presence.state !== 'closed') return this.presence;
    const WebSocketImpl =
      this.WebSocketImpl ?? (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (typeof WebSocketImpl !== 'function') {
      throw new TypeError('LobbyClient: no WebSocket implementation; pass options.WebSocket');
    }
    const opts: PresenceConnectionOptions = {
      url: wsUrlFor(this.baseUrl, '/lobby'),
      WebSocket: WebSocketImpl,
    };
    if (this.manual) opts.cookie = () => this.cookieHeader();
    this.presence = new PresenceConnection(opts);
    return this.presence;
  }

  /** `connectPresence().on('event', cb)`; returns the unsubscribe function. */
  onPresence(cb: (ev: LobbyEvent) => void): () => void {
    return this.connectPresence().on('event', cb);
  }

  private call<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
    const opts: RequestOptions = {
      fetch: this.fetchFn,
      url: this.baseUrl + path,
      method,
      body,
      onResponse: (res) => this.observe(res, path),
    };
    const cookie = this.cookieHeader();
    if (cookie !== null) opts.headers = { Cookie: cookie };
    return request<T>(opts);
  }

  /**
   * Manual mode keeps `conduit_sid` from `Set-Cookie`. A `401` from any route but login (whose
   * 401 means bad credentials, not a bad cookie) ends the login: the manual cookie is cleared and
   * the presence connection closed, which also ends its reconnect attempts.
   */
  private observe(res: Response, path: string): void {
    if (this.manual) this.captureCookie(res.headers);
    if (res.status === 401 && path !== LOGIN_PATH) {
      this.sid = null;
      this.closePresence();
    }
  }

  private captureCookie(headers: Headers): void {
    const lines =
      typeof headers.getSetCookie === 'function'
        ? headers.getSetCookie()
        : [headers.get('set-cookie') ?? ''];
    for (const line of lines) {
      const [pair = '', ...attributes] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq < 0 || pair.slice(0, eq).trim() !== COOKIE_NAME) continue;
      const value = pair.slice(eq + 1).trim();
      const expired = attributes.some((attr) => {
        const [name = '', maxAge = ''] = attr.split('=').map((part) => part.trim());
        return name.toLowerCase() === 'max-age' && /^-?\d+$/.test(maxAge) && Number(maxAge) <= 0;
      });
      this.sid = value === '' || expired ? null : value;
    }
  }

  private cookieHeader(): string | null {
    return this.manual && this.sid !== null ? `${COOKIE_NAME}=${this.sid}` : null;
  }

  private closePresence(): void {
    const presence = this.presence;
    this.presence = null;
    presence?.close();
  }
}
