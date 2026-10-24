import { createReadStream, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

/** `Content-Type` by file extension (docs/host.md 22); anything else is `application/octet-stream`. */
export const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  ico: 'image/x-icon',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  bin: 'application/octet-stream',
  wasm: 'application/wasm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
});

const DEFAULT_MIME = 'application/octet-stream';
/** Files under `/assets/` are content-hashed by `conduit-assets` (docs/assets.md). */
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';

export interface StaticFilesOptions {
  /** Answer HTML requests (`Accept` includes `text/html`) for missing files with `index.html`. Default true. */
  spa?: boolean | undefined;
}

/** The request parts `staticFiles` reads; a Hono `Context` has them. */
export interface StaticRequestContext {
  req: { readonly method: string; readonly url: string; header(name: string): string | undefined };
}

function mimeOf(file: string): string {
  const ext = extname(file).slice(1).toLowerCase();
  return Object.hasOwn(MIME_TYPES, ext) ? (MIME_TYPES[ext] as string) : DEFAULT_MIME;
}

async function fileStats(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

function etagOf(st: Stats): string {
  return `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
}

/** `If-None-Match` lists `etag` (weak comparison) or is `*`. */
function matches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (ifNoneMatch === undefined) return false;
  return ifNoneMatch
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .some((tag) => tag === '*' || tag === etag);
}

function notFound(): Response {
  return new Response('not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}

/**
 * A Hono handler serving the files under `dir` (docs/host.md 22): GET and HEAD only (anything else
 * 404); the decoded path may not contain a `..` segment and must resolve inside `dir`; a directory
 * serves its `index.html`; a missing file serves `dir/index.html` to HTML requests when `spa`, else
 * 404. `Content-Type` from `MIME_TYPES`, `Cache-Control` immutable under `/assets/` and `no-cache`
 * elsewhere, an `ETag` from size and mtime, and `304` for a matching `If-None-Match`.
 */
export function staticFiles(
  dir: string,
  opts: StaticFilesOptions = {},
): (c: StaticRequestContext) => Promise<Response> {
  const root = resolve(dir);
  const spa = opts.spa ?? true;
  return async (c) => {
    const method = c.req.method;
    if (method !== 'GET' && method !== 'HEAD') return notFound();
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return notFound();
    }
    if (pathname.includes('\0') || pathname.split(/[/\\]/).includes('..')) return notFound();
    let file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + sep)) return notFound();

    let st = await fileStats(file);
    if (st?.isDirectory() === true) {
      file = join(file, 'index.html');
      st = await fileStats(file);
    }
    let fallback = false;
    if (st === null || !st.isFile()) {
      if (!spa || !(c.req.header('accept') ?? '').includes('text/html')) return notFound();
      file = join(root, 'index.html');
      st = await fileStats(file);
      if (st === null || !st.isFile()) return notFound();
      fallback = true;
    }

    const etag = etagOf(st);
    const cacheControl = !fallback && pathname.startsWith('/assets/') ? IMMUTABLE : REVALIDATE;
    if (matches(c.req.header('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers: { etag, 'cache-control': cacheControl } });
    }
    const headers = {
      'content-type': mimeOf(file),
      'content-length': String(st.size),
      'cache-control': cacheControl,
      etag,
    };
    if (method === 'HEAD') return new Response(null, { status: 200, headers });
    const body = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>;
    return new Response(body, { status: 200, headers });
  };
}
