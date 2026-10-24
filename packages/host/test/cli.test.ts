import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { PASSWORD, SECRET, WORKER_EXEC_ARGV } from './fixtures/helpers.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/game.ts', import.meta.url));
const NO_GAME = fileURLToPath(new URL('./fixtures/no-game.ts', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'conduit-host-cli-'));
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill('SIGKILL');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Run {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** `node [--import tsx] src/cli.ts ...args` with a clean host environment plus `env`. */
function cli(args: string[], env: Record<string, string> = {}, nodeArgs: string[] = []): Run {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const name of [
    'HOST_SECRET',
    'PORT',
    'DB_PATH',
    'STATIC_DIR',
    'PUBLIC_WS_BASE',
    'IDLE_TIMEOUT_MS',
    'LOG_LEVEL',
    'NODE_OPTIONS',
  ]) {
    delete base[name];
  }
  const child = spawn(process.execPath, [...nodeArgs, ...WORKER_EXEC_ARGV, CLI, ...args], {
    env: { ...base, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    err += chunk.toString('utf8');
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  return { child, stdout: () => out, stderr: () => err, exited };
}

async function listeningPort(run: Run, timeoutMs = 15_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = /listening on http:\/\/0\.0\.0\.0:(\d+)/.exec(run.stdout());
    if (match !== null) return Number(match[1]);
    if (run.child.exitCode !== null || Date.now() > deadline) {
      throw new Error(`no listening line; stdout: ${run.stdout()} stderr: ${run.stderr()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('conduit-host CLI', () => {
  it('serves a game module, answers /healthz, runs a session and exits 0 on SIGTERM', async () => {
    const run = cli([FIXTURE, '--port', '0', '--log-level', 'warn'], {
      HOST_SECRET: SECRET,
      DB_PATH: join(dir, 'cli.sqlite'),
    });
    const port = await listeningPort(run);
    const base = `http://127.0.0.1:${port}`;
    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, list: [] });
    expect(await (await fetch(`${base}/games`)).json()).toEqual([
      { gameId: 'host-fixture', name: 'Host fixture', version: 1 },
    ]);

    // A session through the lobby: the CLI's worker imports the module by file URL.
    const post = (path: string, body: unknown, cookie = '') =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(body),
      });
    expect((await post('/auth/register', { username: 'cli', password: PASSWORD })).status).toBe(
      201,
    );
    const login = await post('/auth/login', { username: 'cli', password: PASSWORD });
    const cookie = (login.headers.getSetCookie()[0] ?? '').split(';')[0] ?? '';
    const created = await post(
      '/sessions',
      { gameId: 'host-fixture', name: 'cli', visibility: 'private', maxPlayers: 2 },
      cookie,
    );
    const { session } = (await created.json()) as { session: { id: string } };
    expect((await post(`/sessions/${session.id}/join`, {}, cookie)).status).toBe(200);
    expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({
      sessions: { running: 1 },
    });

    const started = Date.now();
    run.child.kill('SIGTERM');
    const { code } = await run.exited;
    expect(code).toBe(0);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);

  it('exits 2 naming HOST_SECRET when it is missing', async () => {
    const run = cli([FIXTURE, '--port', '0'], { DB_PATH: join(dir, 'missing.sqlite') });
    expect((await run.exited).code).toBe(2);
    expect(run.stderr()).toContain('HOST_SECRET');
  });

  it('exits 2 for usage errors: no module, an unknown flag, a bad flag value', async () => {
    const env = { HOST_SECRET: SECRET, DB_PATH: ':memory:' };
    const none = cli([], env);
    expect((await none.exited).code).toBe(2);
    expect(none.stderr()).toContain('usage: conduit-host');
    const unknown = cli([FIXTURE, '--bogus'], env);
    expect((await unknown.exited).code).toBe(2);
    const badPort = cli([FIXTURE, '--port', 'eighty'], env);
    expect((await badPort.exited).code).toBe(2);
    expect(badPort.stderr()).toContain('PORT');
  });

  it('exits 1 for a module without game', async () => {
    const run = cli([NO_GAME, '--port', '0'], { HOST_SECRET: SECRET, DB_PATH: ':memory:' });
    expect((await run.exited).code).toBe(1);
    expect(run.stderr()).toContain('must export game and sessionFactory');
  });

  it('exits 3 when node:sqlite is unavailable', async () => {
    const run = cli([FIXTURE, '--port', '0'], { HOST_SECRET: SECRET, DB_PATH: ':memory:' }, [
      '--no-experimental-sqlite',
    ]);
    expect((await run.exited).code).toBe(3);
    expect(run.stderr()).toContain('node:sqlite is not available');
  });
});
