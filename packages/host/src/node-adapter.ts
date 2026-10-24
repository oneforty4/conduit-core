import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';

/** What the adapter passes as Hono's `c.env` (the lobby's `LobbyEnv['Bindings']`, docs/host.md 10). */
export interface AdapterBindings {
  remoteAddress?: string;
  encrypted?: boolean;
}

/** Anything with a Fetch-style handler, such as a `Hono` app. */
export interface FetchHandler {
  fetch(request: Request, env: AdapterBindings): Response | Promise<Response>;
}

/** The client went away mid-response: nothing to report. */
function isPrematureClose(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ERR_STREAM_PREMATURE_CLOSE';
}

function isEncrypted(req: IncomingMessage): boolean {
  return (req.socket as { encrypted?: unknown }).encrypted === true;
}

/**
 * The Fetch `Request` for a Node request (docs/host.md 22): URL from the `Host` header and
 * `req.url`, every header (repeated ones appended), and for methods other than GET and HEAD the
 * body as a stream (`duplex: 'half'`). Throws `TypeError` for a request whose URL does not parse.
 */
export function toRequest(req: IncomingMessage): Request {
  const origin = `${isEncrypted(req) ? 'https' : 'http'}://${req.headers.host ?? 'localhost'}`;
  const target = req.url ?? '/';
  // A path is appended as is, so `//x` stays a path instead of becoming a protocol-relative URL.
  const url = target.startsWith('/') ? new URL(origin + target) : new URL(target, origin);
  const headers = new Headers();
  const raw = req.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    try {
      headers.append(raw[i] as string, raw[i + 1] as string);
    } catch {
      // A header name or value the Fetch API rejects is dropped.
    }
  }
  const method = req.method ?? 'GET';
  // `duplex` is in undici's RequestInit, not in the DOM lib's.
  const init: RequestInit & { duplex?: 'half' } = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

/**
 * Writes a Fetch `Response` to a Node response: status, headers (every `Set-Cookie` as its own
 * header line, via `getSetCookie()`), then the body streamed. Resolves once the body is written.
 */
export async function writeResponse(res: Response, out: ServerResponse): Promise<void> {
  out.statusCode = res.status;
  if (res.statusText !== '') out.statusMessage = res.statusText;
  res.headers.forEach((value, name) => {
    if (name !== 'set-cookie') out.setHeader(name, value);
  });
  const cookies = res.headers.getSetCookie();
  if (cookies.length > 0) out.setHeader('set-cookie', cookies);
  if (res.body === null) {
    out.end();
    return;
  }
  await pipeline(Readable.fromWeb(res.body as unknown as NodeReadableStream<Uint8Array>), out);
}

/**
 * Serves one Node request with `app` (docs/host.md 22): `app.fetch(toRequest(req), { remoteAddress,
 * encrypted })`, then `writeResponse`. A URL that does not parse is answered `400`; a throwing app
 * or a failed write `500` when the headers are not sent yet (else the response is destroyed), and
 * the error goes to `onError`.
 */
export async function handle(
  app: FetchHandler,
  req: IncomingMessage,
  res: ServerResponse,
  onError: (err: unknown) => void = () => {},
): Promise<void> {
  let request: Request;
  try {
    request = toRequest(req);
  } catch {
    res.statusCode = 400;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('bad request');
    return;
  }
  try {
    const env: AdapterBindings = { encrypted: isEncrypted(req) };
    const remoteAddress = req.socket.remoteAddress;
    if (remoteAddress !== undefined) env.remoteAddress = remoteAddress;
    const response = await app.fetch(request, env);
    await writeResponse(response, res);
  } catch (err) {
    if (!isPrematureClose(err)) onError(err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('internal error');
    } else {
      res.destroy();
    }
  }
}
