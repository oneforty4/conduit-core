import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
import { MIME_TYPES, staticFiles } from '../src/static.ts';

const base = mkdtempSync(join(tmpdir(), 'conduit-host-static-'));
const root = join(base, 'public');
mkdirSync(join(root, 'assets'), { recursive: true });
mkdirSync(join(root, 'docs'), { recursive: true });
mkdirSync(join(root, 'empty'), { recursive: true });
writeFileSync(join(root, 'index.html'), '<!doctype html><title>root</title>');
writeFileSync(join(root, 'docs', 'index.html'), '<title>docs</title>');
writeFileSync(join(root, 'assets', 'app.abc123.js'), 'console.log(1)');
writeFileSync(join(root, 'ship.glb'), Buffer.from([0x67, 0x6c, 0x54, 0x46]));
writeFileSync(join(root, 'physics.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]));
writeFileSync(join(root, 'data.unknownext'), 'x');
writeFileSync(join(base, 'secret.txt'), 'top secret');

afterAll(() => rmSync(base, { recursive: true, force: true }));

function appFor(spa?: boolean): Hono {
  const app = new Hono();
  app.all('*', staticFiles(root, spa === undefined ? {} : { spa }));
  return app;
}

const app = appFor();

describe('staticFiles', () => {
  it('serves index.html for / and a directory', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(await res.text()).toBe('<!doctype html><title>root</title>');
    expect(await (await app.request('/docs/')).text()).toBe('<title>docs</title>');
    expect(await (await app.request('/docs')).text()).toBe('<title>docs</title>');
    expect((await app.request('/empty/')).status).toBe(404);
  });

  it('sends the MIME type by extension', async () => {
    const glb = await app.request('/ship.glb');
    expect(glb.status).toBe(200);
    expect(glb.headers.get('content-type')).toBe('model/gltf-binary');
    expect(glb.headers.get('content-length')).toBe('4');
    expect([...new Uint8Array(await glb.arrayBuffer())]).toEqual([0x67, 0x6c, 0x54, 0x46]);
    expect((await app.request('/physics.wasm')).headers.get('content-type')).toBe(
      'application/wasm',
    );
    expect((await app.request('/data.unknownext')).headers.get('content-type')).toBe(
      'application/octet-stream',
    );
    for (const ext of [
      'html',
      'js',
      'mjs',
      'css',
      'json',
      'map',
      'png',
      'jpg',
      'jpeg',
      'gif',
      'svg',
      'webp',
      'ico',
      'glb',
      'gltf',
      'bin',
      'wasm',
      'woff',
      'woff2',
      'txt',
      'xml',
    ]) {
      expect(MIME_TYPES[ext], ext).toBeTypeOf('string');
    }
  });

  it('caches /assets/ files as immutable', async () => {
    const res = await app.request('/assets/app.abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect((await app.request('/ship.glb')).headers.get('cache-control')).toBe('no-cache');
  });

  it('never leaves the directory: .. segments are 404', async () => {
    for (const path of [
      '/..%2Fsecret.txt',
      '/assets/..%2F..%2Fsecret.txt',
      '/%2e%2e%2fsecret.txt',
      '/..%5csecret.txt',
    ]) {
      const res = await app.request(path, { headers: { accept: 'text/html' } });
      expect(res.status, path).toBe(404);
    }
    const normalised = await app.request('/../secret.txt'); // the URL parser drops the ..
    expect(normalised.status).toBe(404);
    expect(await normalised.text()).not.toContain('top secret');
    expect((await app.request('/%E0%A4%A')).status).toBe(404); // malformed escape
  });

  it('falls back to index.html for missing files only with Accept: text/html', async () => {
    const page = await app.request('/sessions/01ABC', {
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe('<!doctype html><title>root</title>');
    expect(page.headers.get('cache-control')).toBe('no-cache');
    expect(
      (await app.request('/sessions/01ABC', { headers: { accept: 'application/json' } })).status,
    ).toBe(404);
    expect((await app.request('/assets/missing.js')).status).toBe(404);
    const noSpa = appFor(false);
    expect(
      (await noSpa.request('/sessions/01ABC', { headers: { accept: 'text/html' } })).status,
    ).toBe(404);
  });

  it('answers 304 for a matching If-None-Match', async () => {
    const first = await app.request('/ship.glb');
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    const again = await app.request('/ship.glb', { headers: { 'if-none-match': etag ?? '' } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    const weak = await app.request('/ship.glb', {
      headers: { 'if-none-match': `"other", W/${etag}` },
    });
    expect(weak.status).toBe(304);
    const stale = await app.request('/ship.glb', { headers: { 'if-none-match': '"stale"' } });
    expect(stale.status).toBe(200);
  });

  it('answers HEAD with headers and no body, and 404 for other methods', async () => {
    const head = await app.request('/ship.glb', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('4');
    expect(await head.text()).toBe('');
    for (const method of ['POST', 'PUT', 'DELETE']) {
      expect((await app.request('/ship.glb', { method })).status, method).toBe(404);
    }
  });
});
