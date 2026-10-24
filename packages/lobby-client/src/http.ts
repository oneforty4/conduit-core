import type { LobbyErrorCode } from '@conduit/lobby';
import { LobbyError } from './errors.ts';

export type HttpMethod = 'GET' | 'POST' | 'DELETE';

/** One lobby call made by `request` (docs/host.md §12). */
export interface RequestOptions {
  /** Called as a plain function (never as a method), so an unbound `globalThis.fetch` works. */
  fetch: typeof fetch;
  /** Absolute, or relative to the page in a browser. */
  url: string;
  /** Default `'GET'`. */
  method?: HttpMethod;
  /** Sent as JSON with `Content-Type: application/json` unless `undefined`. */
  body?: unknown;
  /** Extra request headers, e.g. `Cookie` in manual cookie mode. */
  headers?: Readonly<Record<string, string>>;
  /** Sees every response, whatever its status, before the body is read. */
  onResponse?: (res: Response) => void;
}

/** Every `LobbyErrorCode`, to tell a lobby `ErrorResponse` from any other JSON body. */
const ERROR_CODES: Readonly<Record<LobbyErrorCode, true>> = {
  unauthorized: true,
  forbidden: true,
  not_found: true,
  conflict: true,
  validation: true,
  session_full: true,
  bad_invite: true,
  rate_limited: true,
  internal: true,
};

const SCHEMES: readonly (readonly [from: string, to: string])[] = [
  ['https://', 'wss://'],
  ['http://', 'ws://'],
  ['wss://', 'wss://'],
  ['ws://', 'ws://'],
];

/**
 * `fetch` with the lobby's conventions (docs/host.md §12): `credentials: 'include'`,
 * `Accept: application/json`, and a JSON body when `body` is given. A 2xx response resolves with
 * its parsed JSON body, or `undefined` when the body is empty (204). Otherwise it rejects with a
 * `LobbyError`: the `ErrorResponse` of a failure status with that status (`'internal'` when the
 * body is not an `ErrorResponse`), `'internal'` for a 2xx body that is not JSON, and `'network'`
 * with status 0 when `fetch` or reading the body rejects.
 */
export async function request<T>(opts: RequestOptions): Promise<T> {
  const method = opts.method ?? 'GET';
  const what = `${method} ${opts.url}`;
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers };
  const init: RequestInit = { method, headers, credentials: 'include' };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const fetchFn = opts.fetch;
  let res: Response;
  let text: string;
  try {
    res = await fetchFn(opts.url, init);
  } catch (cause) {
    throw new LobbyError('network', 0, `${what}: ${messageOf(cause)}`, { cause });
  }
  opts.onResponse?.(res);
  try {
    text = await res.text();
  } catch (cause) {
    const message = `${what}: reading the response failed: ${messageOf(cause)}`;
    throw new LobbyError('network', 0, message, { cause });
  }
  if (!res.ok) throw failure(res.status, text, what);
  if (text === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new LobbyError('internal', res.status, `${what}: the response body is not JSON`, {
      cause,
    });
  }
}

/** The error for a non-2xx response: its `ErrorResponse`, or `'internal'` with the status. */
function failure(status: number, text: string, what: string): LobbyError {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (typeof body === 'object' && body !== null) {
    const { error, message, field } = body as Record<string, unknown>;
    if (typeof error === 'string' && Object.hasOwn(ERROR_CODES, error)) {
      return new LobbyError(
        error as LobbyErrorCode,
        status,
        typeof message === 'string' ? message : `${what}: HTTP ${status} ${error}`,
        typeof field === 'string' ? { field } : {},
      );
    }
  }
  return new LobbyError('internal', status, `${what}: HTTP ${status}`);
}

/**
 * The WebSocket URL of `path` on the lobby at `baseUrl` (docs/host.md §13): `http://` becomes
 * `ws://` and `https://` becomes `wss://` (`ws://` and `wss://` are kept), trailing slashes of
 * `baseUrl` are dropped and `path` is appended. A same-origin `baseUrl` (`''` or a path such as
 * `'/api'`) is resolved against `location.origin`, so it needs a browser page. Anything else
 * throws a `TypeError`.
 */
export function wsUrlFor(baseUrl: string, path: string): string {
  let base = baseUrl.replace(/\/+$/, '');
  if (base === '' || (base.startsWith('/') && !base.startsWith('//'))) {
    const origin = (globalThis as { location?: { origin?: unknown } }).location?.origin;
    if (typeof origin !== 'string' || !/^https?:\/\//i.test(origin)) {
      throw new TypeError(
        `wsUrlFor: the same-origin baseUrl '${baseUrl}' needs an http(s) location.origin`,
      );
    }
    base = origin + base;
  }
  const suffix = path.startsWith('/') ? path : `/${path}`;
  const lower = base.toLowerCase();
  for (const [from, to] of SCHEMES) {
    if (lower.startsWith(from)) return to + base.slice(from.length) + suffix;
  }
  throw new TypeError(`wsUrlFor: baseUrl must be an http(s) or ws(s) URL, got '${baseUrl}'`);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
