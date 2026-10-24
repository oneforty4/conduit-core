import { createServer, get, type IncomingMessage, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AdapterBindings, handle } from '../src/node-adapter.ts';

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  remoteAddress: string | undefined;
  encrypted: boolean | undefined;
  body?: unknown;
}

const seen: Seen[] = [];
const errors: unknown[] = [];
const app = new Hono<{ Bindings: AdapterBindings }>();

function record(c: {
  req: { url: string; method: string; header(): Record<string, string> };
  env: AdapterBindings;
}): Seen {
  return {
    url: c.req.url,
    method: c.req.method,
    headers: c.req.header(),
    remoteAddress: c.env.remoteAddress,
    encrypted: c.env.encrypted,
  };
}

app.get('/hello', (c) => {
  seen.push(record(c));
  return c.json({ ok: true });
});
app.post('/echo', async (c) => {
  const entry = record(c);
  entry.body = await c.req.json();
  seen.push(entry);
  return c.json({ got: entry.body }, 201);
});
app.get('/cookies', (c) => {
  c.header('Set-Cookie', 'a=1; Path=/', { append: true });
  c.header('Set-Cookie', 'b=2; Path=/; HttpOnly', { append: true });
  return c.text('two cookies');
});
app.get('/stream', () => {
  const encoder = new TextEncoder();
  let n = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (n === 3) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(`chunk${n++};`));
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/plain' } });
});
app.get('/throws', () => {
  throw new Error('boom');
});

let server: Server;
let port: number;

beforeAll(async () => {
  app.onError((err) => {
    throw err; // let the adapter see it
  });
  server = createServer((req, res) => void handle(app, req, res, (err) => errors.push(err)));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function raw(path: string): Promise<{ res: IncomingMessage; body: string; chunks: number }> {
  return new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      let chunks = 0;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        chunks++;
        body += chunk;
      });
      res.on('end', () => resolve({ res, body, chunks }));
    }).on('error', reject);
  });
}

describe('node-adapter', () => {
  it('passes a GET with its URL, headers and remote address', async () => {
    seen.length = 0;
    const res = await fetch(`http://127.0.0.1:${port}/hello?x=1&y=two`, {
      headers: { 'X-Custom': 'value', Cookie: 'conduit_sid=abc' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    const entry = seen[0] as Seen;
    expect(entry.url).toBe(`http://127.0.0.1:${port}/hello?x=1&y=two`);
    expect(entry.method).toBe('GET');
    expect(entry.headers['x-custom']).toBe('value');
    expect(entry.headers.cookie).toBe('conduit_sid=abc');
    expect(entry.headers.host).toBe(`127.0.0.1:${port}`);
    expect(entry.remoteAddress).toBe('127.0.0.1');
    expect(entry.encrypted).toBe(false);
  });

  it('streams a POST JSON body to the app', async () => {
    seen.length = 0;
    const payload = { name: 'session', list: [1, 2, 3], text: 'x'.repeat(100_000) };
    const res = await fetch(`http://127.0.0.1:${port}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ got: payload });
    expect(seen[0]).toMatchObject({ method: 'POST', body: payload });
    expect(seen[0]?.headers['content-type']).toBe('application/json');
  });

  it('writes multiple Set-Cookie headers separately', async () => {
    const { res, body } = await raw('/cookies');
    expect(body).toBe('two cookies');
    expect(res.headers['set-cookie']).toEqual(['a=1; Path=/', 'b=2; Path=/; HttpOnly']);
    const lines = res.rawHeaders.filter(
      (_, i) => i % 2 === 0 && /^set-cookie$/i.test(res.rawHeaders[i] ?? ''),
    );
    expect(lines).toHaveLength(2);
    const viaFetch = await fetch(`http://127.0.0.1:${port}/cookies`);
    expect(viaFetch.headers.getSetCookie()).toEqual(['a=1; Path=/', 'b=2; Path=/; HttpOnly']);
  });

  it('streams a response body', async () => {
    const { res, body, chunks } = await raw('/stream');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain');
    expect(res.headers['transfer-encoding']).toBe('chunked');
    expect(body).toBe('chunk0;chunk1;chunk2;');
    expect(chunks).toBeGreaterThanOrEqual(2);
  });

  it('answers 500 for a throwing app and 400 for a request URL that does not parse', async () => {
    errors.length = 0;
    const { res, body } = await raw('/throws');
    expect(res.statusCode).toBe(500);
    expect(body).toBe('internal error');
    expect(errors).toHaveLength(1);
    const bad = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: '/hello', headers: { host: 'bad host' } },
        (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(bad).toBe(400);
  });
});
